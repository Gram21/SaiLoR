import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getPlatform } from '../platform'
import { useStore, currentTree, currentFinished, type AiBatchApplyResult } from './store'
import { unansweredFields, type FieldTarget } from '../llm/fields'
import { buildSystemPrompt, buildUserText, buildUserPdfCaption, type Delivery } from '../llm/prompt'
import { buildRequest, extractText, extractError, wasTruncated, PROVIDERS } from '../llm/providers'
import { buildModelsRequest, parseModelsResponse } from '../llm/models'
import { parseAnswer } from '../llm/parse'
import { parseChatResponse } from '../llm/chat'
import { runAgent } from '../llm/agent'
import { withRetry, runPool, type CallLlm } from '../llm/retry'
import { costOf } from '../llm/cost'
import { buildFewShotBlock, countAnsweredFields, pickFewShotExamples, type FewShotExample } from '../llm/fewshot'
import type { LlmAnswer, LlmConfig, ModelInfo, Suggestion } from '../llm/types'
import { isUsable } from '../llm/types'
import {
  buildSystemOneRequest,
  buildSystemOneVerifyRequest,
  parseSystemOneResponse,
  compareWithSystemOne,
  systemOneEligible,
  SYSTEMONE_VERIFY_ASKED,
  type SystemOneComparison,
} from '../llm/systemone'
import { aiSeatId } from '../model/project'
import type { Paper, Project } from '../model/project'
import type { AnnotationValueTree } from '../model/annotations'
import { extractPdfText, countPdfPages } from '../model/pdfText'

/**
 * State for the AI-assisted annotation flow, kept out of the main store as
 * its own self-contained mode. `apply()` is the one bridge: it hands
 * reviewer-approved values to `applyAiSuggestionsBatch`, the main store's
 * single-undo-step batch write.
 */

const SELECTED_KEY = 'slr.llm.selected'
const MODE_KEY = 'slr.llm.mode'
const JUDGE_KEY = 'slr.llm.judge'
const CROSSCHECK_KEY = 'slr.llm.crosscheck'
const THRESHOLD_KEY = 'slr.llm.threshold'
const DEFAULT_THRESHOLD = 0.8
const FEW_SHOT_KEY = 'slr.llm.fewshot'
const DEFAULT_FEW_SHOT_COUNT = 2
const CONCURRENCY_KEY = 'slr.llm.concurrency'
const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 4

/** Above this serialized size, a persisted batch drops its rows/notes/errors —
 *  see `PersistedBatch.rowsOmitted`. */
const PERSIST_SIZE_CAP = 2_000_000

/** Output budget for the "Verify setup" smoke test — high enough to survive
 * reasoning-model overhead, still well below `DEFAULT_MAX_TOKENS`. */
const VERIFY_MAX_TOKENS = 2048

/** How long a fetched model list is trusted before `fetchModels` refetches.
 * Just to make reopening settings instant, not to catch new releases quickly
 * — `opts.force` bypasses it. */
const MODELS_TTL_MS = 60 * 60 * 1000

/** Backstop page limit for `fetchModels`, in case a provider never clears `nextCursor`. */
const MAX_MODEL_PAGES = 10

/** Most recent agent-mode progress messages kept on screen (per paper). */
const MAX_AGENT_EVENTS = 5

export type AiPhase =
  | 'setup' // choosing a target, nothing sent yet
  | 'reading' // extracting the PDF's text
  | 'calling' // waiting for the model
  | 'parsing'
  | 'review' // suggestions on screen, awaiting the reviewer
  | 'applied'
  | 'error'

export type AiMode = 'prompt' | 'agent' | 'classify'

/** A suggestion plus the reviewer's decision about it and which paper it belongs to. */
export interface ReviewRow {
  paperId: string
  paperTitle: string
  reviewer: string | null
  suggestion: Suggestion
  checked: boolean
  /** Cross-check role only: this row's suggestion compared against System
   *  One's own answer for the same field. Absent when no cross-check model is
   *  assigned, or the field wasn't eligible/asked. */
  crossCheck?: SystemOneComparison
}

/** A paper a batch run failed on, kept so the run can continue past it. */
export interface PaperRunError {
  paperId: string
  paperTitle: string
  message: string
}

/** Candidate for "annotate all papers": has a PDF, isn't finished for this
 *  seat, and has at least one unanswered field. */
export interface AiCandidate {
  id: string
  title: string
}

/** What the model left empty or got refused, for one paper — shown collapsed
 *  under the review table, same content `ReviewNotes` always showed, now per paper. */
export interface PaperNotes {
  paperId: string
  paperTitle: string
  skipped: LlmAnswer['skipped']
  rejected: LlmAnswer['rejected']
}

interface AiState {
  open: boolean
  /** True while the dialog is hidden ("peeking" at the PDF) but not discarded —
   *  see `requestPdfFind` in the store and the review table's evidence links.
   *  A floating "Back to AI review" button clears it. */
  minimized: boolean
  settingsOpen: boolean
  configs: LlmConfig[]
  selectedId: string | null

  /** Fetched model lists, keyed by LlmConfig id. Absent until `fetchModels` succeeds once. */
  models: Record<string, ModelInfo[]>
  modelsLoading: Record<string, boolean>
  modelsError: Record<string, string | null>
  /** `Date.now()` of the last successful fetch for a config id — drives the TTL. */
  modelsFetchedAt: Record<string, number>

  /** Prompt mode (one request per paper) or agent mode (tool-using, judged). */
  mode: AiMode
  /** Off: only the current paper is a candidate. On: every eligible paper is. */
  allPapers: boolean

  /** Agent mode's judge target — id of a config, or null for "same as agent". */
  judgeSelectedId: string | null
  /** Optional cross-check role (prompt/agent modes): a System One target whose
   *  own answer is compared against each eligible proposed value. Null means
   *  "not assigned". */
  crossCheckId: string | null
  /** Below this probability (0-1), a classify-mode row or a cross-check
   *  disagreement starts unticked rather than pre-approved. */
  confidenceThreshold: number
  /** All-papers mode only: stop starting new papers once spend exceeds this
   *  (USD), null when the reviewer hasn't set one. Reset every dialog open. */
  spendCap: number | null
  /** Running total (USD) of `costOf` across papers finished so far this run. */
  spentSoFar: number
  /** True once a run stopped early because `spendCap` was exceeded. */
  spendCapHit: boolean
  /** "Rate-limited, retrying in Ns…", cleared as soon as the retry lands. */
  retryNotice: string | null

  /** Show the reviewer's finished papers to the model as worked examples
   *  (REQ-LLM-450). Off by default, persisted like `mode`. */
  fewShot: boolean
  /** How many worked examples to offer at most (1-5). Persisted alongside `fewShot`. */
  fewShotCount: number
  /** How many finished papers are available as examples for the current
   *  paper right now — drives the setup screen's "N finished papers
   *  available" line and disables the toggle when it's zero. */
  fewShotAvailable: number

  /** Page counts for the cost estimate, keyed by paper id — fetched lazily and
   *  cached for the session; see `ensurePageCounts`. */
  pageCounts: Record<string, number>
  pageCountsLoading: Record<string, boolean>

  phase: AiPhase
  error: string | null
  /** Seconds the current call has been running, for the progress line. */
  elapsed: number

  /** The seat this run writes into — the AI's own seat (REQ-LLM-470) when the
   *  project has one, else whichever seat was selected when the dialog opened.
   *  Fixed for the run's whole lifetime, unaffected by the reviewer switching
   *  seats mid-run, same as `targets` below. */
  targetSeat: string | null
  /** The fields the AI is being asked about for the current paper — computed
   *  when the dialog opens, used as the disclosure example in all-papers mode too. */
  targets: FieldTarget[]
  /** False when the current paper has no PDF — single-paper mode has nothing to send. */
  currentPaperHasPdf: boolean
  /** Batch candidates, recomputed whenever `allPapers` is toggled on or the dialog opens. */
  candidates: AiCandidate[]

  /** How many papers this batch has settled (succeeded or failed) so far, and
   *  how many it covers in total — `batchTotal - batchDone` is how many a
   *  `resumeBatch()` would still have to do. */
  batchDone: number
  batchTotal: number
  /** Titles of the papers currently in flight — as many as `concurrency`
   *  allows at once. Empty between papers and once the batch is done. */
  inFlightTitles: string[]
  /** All-papers mode only: how many papers `runPool` works on at once (1-4),
   *  persisted like `mode`. */
  concurrency: number
  /** A saved unfinished batch for this project + seat, offered as "Resume"
   *  on the setup screen — see `openDialog` and `resumeBatch`. */
  resumeAvailable: PersistedBatch | null
  /** When the current (or resumed) batch started — carried through a resume
   *  so the persisted record's timestamp reflects the original run, not the
   *  most recent resume. */
  batchStartedAt: string | null
  /** Agent mode only: the last few progress messages, tagged with which
   *  paper they're about — several can be in flight together. */
  agentEvents: string[]
  /** Per-paper failures a batch run continues past. */
  errors: PaperRunError[]
  /** Token/call accounting, summed across every paper and every model call of the run. */
  usage: { calls: number; inputTokens: number; outputTokens: number }
  /** The target the finished run actually used — what `apply()` discloses as `aiUsage`. */
  runUsage: { provider: string; model: string } | null
  /** Agent mode only: the judge target actually used this run (falls back to
   *  the agent's own target when no separate judge was picked). */
  runJudge: { provider: string; model: string } | null
  /** Agent mode only: how many agent rounds each paper took — `apply()`'s
   *  per-paper disclosure reads this by paper id. */
  roundsByPaper: Record<string, number>
  /** How many few-shot examples were actually included for each paper — only
   *  set when at least one was, so `apply()`'s disclosure can tell "not
   *  offered" from "offered zero" the same way `roundsByPaper` does. */
  fewShotByPaper: Record<string, number>

  rows: ReviewRow[]
  /** Per-paper "left empty"/"rejected" lists, same content the old single-paper
   *  `answer.skipped`/`answer.rejected` carried. */
  notes: PaperNotes[]
  applied: AiBatchApplyResult | null
  /** True when the (single) paper's PDF yielded no usable text (a scanned paper). */
  scanned: boolean

  openDialog: () => Promise<void>
  closeDialog: () => void
  /** Set/clear the "peek at the PDF" state — see `minimized`. */
  setMinimized: (minimized: boolean) => void
  setSettingsOpen: (open: boolean) => void
  selectConfig: (id: string) => void
  setMode: (mode: AiMode) => void
  /** No confirmation gating here — the dialog shows/owns the consequences
   *  warning and only calls this once the reviewer confirms turning it on. */
  setAllPapers: (on: boolean) => void
  /** `null` means "same as agent". */
  selectJudge: (id: string | null) => void
  /** `null` means "no cross-check model assigned". */
  selectCrossCheck: (id: string | null) => void
  setConfidenceThreshold: (n: number) => void
  setSpendCap: (cap: number | null) => void
  setFewShot: (on: boolean) => void
  setFewShotCount: (count: number) => void
  /** Clamped to 1-4. */
  setConcurrency: (n: number) => void
  /** Fetch and cache each paper's page count, for the setup screen's cost
   *  estimate. Best-effort: a paper whose PDF can't be read is left uncached
   *  rather than failing the whole batch. Never awaited by the caller in a
   *  way that blocks Start — it only feeds the estimate line. */
  ensurePageCounts: (paperIds: string[]) => Promise<void>

  refreshConfigs: () => Promise<void>
  saveConfig: (config: LlmConfig, apiKey?: string) => Promise<void>
  deleteConfig: (id: string) => Promise<void>
  verifyConfig: (config: LlmConfig, apiKey?: string) => Promise<string>
  /** Saves `config` (a key must be stored before it can be used) then walks
   * the provider's list-models endpoint. Cached per config id for
   * `MODELS_TTL_MS`; pass `force: true` to bypass. */
  fetchModels: (config: LlmConfig, apiKey?: string, opts?: { force?: boolean }) => Promise<void>
  /** Drop a target's cached model list — it belongs to whichever endpoint was
   * configured when it was fetched, not the id's current provider/URL. */
  clearModels: (id: string) => void

  run: () => Promise<void>
  /** Continues a saved unfinished all-papers batch — the setup screen's
   *  banner, or the review screen's "Continue with the remaining N papers"
   *  after a cancel or a spending-cap stop. No-op if nothing is saved for
   *  this project + seat, or its target no longer exists. */
  resumeBatch: () => Promise<void>
  cancel: () => void
  toggleRow: (index: number, checked: boolean) => void
  setAllRows: (checked: boolean) => void
  apply: () => void
  /** The review screen's Discard: clears any saved batch progress, then closes. */
  discardBatch: () => void
  /** Dismisses the setup screen's resume banner and discards the saved batch
   *  it offers, without closing the dialog — the reviewer stays on setup to
   *  start a fresh run instead. */
  dismissResume: () => void
}

// Not in the store: it is not serializable and nothing renders from it.
let controller: AbortController | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function stopTicker() {
  if (ticker) clearInterval(ticker)
  ticker = null
}

/** Papers eligible for "annotate all papers": have a PDF, aren't finished for
 *  the target seat, and have at least one unanswered field. The target seat is
 *  the AI's own seat when the project has one (REQ-LLM-470), else whichever
 *  seat the human reviewer currently has selected. */
export function batchCandidates(project: Project, currentReviewer: string | null): AiCandidate[] {
  const out: AiCandidate[] = []
  if (project.screening) return out
  const targetSeat = aiSeatId(project) ?? currentReviewer
  // Same seat `applyAiSuggestionsBatch` refuses — don't pay for a batch that
  // can't be applied. Unreachable when an AI seat exists: `targetSeat` is then
  // the AI seat, never 'consolidation'.
  if (targetSeat === 'consolidation') return out
  for (const paper of project.papers) {
    if (!paper.pdf) continue
    if (currentFinished(project, targetSeat, paper) === true) continue
    const tree = currentTree(project, targetSeat, paper)
    if (!tree) continue
    if (unansweredFields(project.schema, tree).length === 0) continue
    out.push({ id: paper.id, title: paper.title })
  }
  return out
}

/** One finished paper usable as a few-shot worked example. */
export interface FewShotCandidate {
  paperId: string
  title: string
  abstract?: string
  tree: AnnotationValueTree
  answered: number
}

/**
 * The seat whose finished papers serve as worked examples (REQ-LLM-450): the
 * Consolidation seat when this is a multi-reviewer project with anything
 * finished there, else whichever seat the human reviewer currently has
 * selected — never the AI's own seat, even if that happens to be selected.
 */
function fewShotSourceSeat(project: Project, currentReviewer: string | null): string | null {
  if (project.reviewers > 1 && project.papers.some((p) => p.finished === true)) return 'consolidation'
  const aiSeat = aiSeatId(project)
  return currentReviewer === aiSeat ? null : currentReviewer
}

/** Finished papers for the few-shot source seat, most-answered-fields-first
 *  (ties keep project order — `Array.prototype.sort` is stable). */
export function fewShotCandidates(project: Project, currentReviewer: string | null): FewShotCandidate[] {
  const seat = fewShotSourceSeat(project, currentReviewer)
  const out: FewShotCandidate[] = []
  for (const paper of project.papers) {
    if (currentFinished(project, seat, paper) !== true) continue
    const tree = currentTree(project, seat, paper)
    if (!tree) continue
    out.push({
      paperId: paper.id,
      title: paper.title,
      abstract: paper.abstract,
      tree,
      answered: countAnsweredFields(project.schema, tree),
    })
  }
  out.sort((a, b) => b.answered - a.answered)
  return out
}

/** The few-shot prompt block for one paper, and how many examples it actually
 *  carries after `buildFewShotBlock`'s truncation — `''`/`0` when nothing was
 *  picked (empty candidate list, or every candidate excluded/truncated away). */
export function buildFewShotForPaper(
  schema: Project['schema'],
  candidates: FewShotCandidate[],
  count: number,
  paperId: string,
): { block: string; included: number } {
  const picked = pickFewShotExamples(candidates, count, paperId, (c) => c.paperId)
  if (picked.length === 0) return { block: '', included: 0 }
  const examples: FewShotExample[] = picked.map((c) => ({ title: c.title, abstract: c.abstract, tree: c.tree }))
  const block = buildFewShotBlock(schema, examples)
  const included = block ? (block.match(/^### /gm) ?? []).length : 0
  return { block, included }
}

// ---------------------------------------------------------------------------
// All-papers batch persistence — resuming a run stopped mid-way (REQ-LLM-510).
// ---------------------------------------------------------------------------

/** What an interrupted all-papers run needs to pick back up where it left
 *  off. Keyed by project identity + target seat (see `batchStorageKey`), one
 *  entry per project — a newer run overwrites an older one outright. */
export interface PersistedBatch {
  version: 1
  mode: AiMode
  configId: string
  judgeId: string | null
  /** Absent on a record saved before cross-check existed. */
  crossCheckId?: string | null
  allPaperIds: string[]
  doneIds: string[]
  usage: { calls: number; inputTokens: number; outputTokens: number }
  spent: number
  startedAt: string
  /** Absent when the record was too big to keep (see `PERSIST_SIZE_CAP`) —
   *  resume then re-runs every paper in `allPaperIds`, not just the ones
   *  missing from `doneIds`, since their results were never kept. */
  rows?: ReviewRow[]
  notes?: PaperNotes[]
  errors?: PaperRunError[]
  roundsByPaper?: Record<string, number>
  fewShotByPaper?: Record<string, number>
}

/** Project identity for the storage key: the save path when there is one
 *  (works across renames of the in-memory title), else the title. */
function projectIdentityKey(): string {
  const app = useStore.getState()
  return app.saveHandle?.path ?? app.project?.title ?? ''
}

function batchStorageKey(seat: string | null): string {
  return `slr.llm.batch.${projectIdentityKey()}.${seat ?? ''}`
}

function persistBatch(seat: string | null, data: PersistedBatch): void {
  // No project (closed mid-run) or no identity: a key would collide with others.
  if (!projectIdentityKey()) return
  try {
    const full = JSON.stringify(data)
    const toWrite = full.length > PERSIST_SIZE_CAP
      ? JSON.stringify({ ...data, rows: undefined, notes: undefined, errors: undefined })
      : full
    localStorage?.setItem(batchStorageKey(seat), toWrite)
  } catch {
    /* ignore (private mode / disabled storage / quota) */
  }
}

function readPersistedBatch(seat: string | null): PersistedBatch | null {
  if (!projectIdentityKey()) return null
  try {
    const raw = localStorage?.getItem(batchStorageKey(seat))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedBatch
    return parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}

function clearPersistedBatch(seat: string | null): void {
  try {
    localStorage?.removeItem(batchStorageKey(seat))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Per-project role assignment (Goal A) — which library model plays which role
// (annotator/judge/cross-check) is remembered per project, falling back to
// the last global choice (the plain `slr.llm.*` keys read/written below).
// ---------------------------------------------------------------------------

interface StoredRoles {
  annotatorId?: string
  judgeId?: string | null
  crossCheckId?: string | null
}

function rolesStorageKey(): string {
  return `slr.llm.roles.${projectIdentityKey()}`
}

function readProjectRoles(): StoredRoles {
  if (!projectIdentityKey()) return {}
  try {
    const raw = localStorage?.getItem(rolesStorageKey())
    return raw ? (JSON.parse(raw) as StoredRoles) : {}
  } catch {
    return {}
  }
}

function writeProjectRole(patch: StoredRoles): void {
  if (!projectIdentityKey()) return
  try {
    localStorage?.setItem(rolesStorageKey(), JSON.stringify({ ...readProjectRoles(), ...patch }))
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

export const useAiStore = create<AiState>()(
  immer((set, get) => {
    /**
     * Runs `papers` through `runPool` at the configured concurrency (1 outside
     * all-papers mode), shared by a fresh `run()` and a `resumeBatch()`
     * continuation alike — both just prepare state differently (reset vs.
     * restore) and hand off here. `allPaperIds`/`doneIdsSoFar` are the
     * persisted-batch bookkeeping: the full original scope and what was
     * already settled before this call, so progress and the resume record
     * stay correct across a resume of a resume.
     */
    const executeBatch = async (
      papers: Paper[],
      allPaperIds: string[],
      doneIdsSoFar: string[],
      config: LlmConfig,
      judgeCfg: LlmConfig | undefined,
      crossCheckCfg: LlmConfig | undefined,
      mode: AiMode,
      callLlm: CallLlm,
      cap: number | null,
      fewShotOn: boolean,
      fewShotCandidatesList: FewShotCandidate[],
      fewShotCount: number,
      confidenceThreshold: number,
    ): Promise<void> => {
      const app = useStore.getState()
      const targetSeat = get().targetSeat
      // Persistence/resume only makes sense for an all-papers batch — a
      // single-paper run has nothing left to "resume" once it ends. `null` is
      // a legitimate seat (single-reviewer, or nobody picked), so this can't
      // be folded into the seat value itself the way `persistBatch`'s other
      // callers do.
      const persistEnabled = get().allPapers
      const doneIds = [...doneIdsSoFar]

      set((s) => {
        s.batchTotal = allPaperIds.length
        s.batchDone = doneIdsSoFar.length
        s.inFlightTitles = []
      })

      const myController = new AbortController()
      controller = myController
      const started = Date.now()
      stopTicker()
      ticker = setInterval(() => {
        set((s) => { s.elapsed = Math.round((Date.now() - started) / 1000) })
      }, 1000)

      const setPhase = (p: AiPhase) => { if (controller === myController) set((s) => { s.phase = p }) }

      const persist = () => {
        if (!persistEnabled) return
        persistBatch(targetSeat, {
          version: 1,
          mode,
          configId: config.id,
          judgeId: judgeCfg?.id ?? null,
          crossCheckId: crossCheckCfg?.id ?? null,
          allPaperIds,
          doneIds: [...doneIds],
          usage: get().usage,
          spent: get().spentSoFar,
          startedAt: get().batchStartedAt ?? new Date().toISOString(),
          rows: get().rows,
          notes: get().notes,
          errors: get().errors,
          roundsByPaper: get().roundsByPaper,
          fewShotByPaper: get().fewShotByPaper,
        })
      }

      // ponytail: `runPool`'s cursor already claims a slot for a paper before
      // this worker gets to look at the spend cap, so a cap-triggered stop
      // still "starts" up to `concurrency - 1` extra workers that immediately
      // no-op — negligible over/spend, not worth a second scheduling layer.
      const concurrency = get().allPapers ? Math.min(Math.max(1, get().concurrency), MAX_CONCURRENCY) : 1

      try {
        await runPool(
          papers,
          concurrency,
          async (paper) => {
            if (controller !== myController) return // superseded — discard silently
            try {
              if (cap !== null && get().spentSoFar > cap) {
                set((s) => { s.spendCapHit = true })
                return // stop starting new papers; this one stays a resume candidate
              }

              set((s) => { s.inFlightTitles.push(paper.title) })

              const tree = currentTree(app.project!, targetSeat, paper)
              const targets = get().allPapers
                ? unansweredFields(app.project!.schema, tree ?? undefined)
                : get().targets
              if (get().allPapers && targets.length === 0) return

              const fewShotForPaper = fewShotOn
                ? buildFewShotForPaper(app.project!.schema, fewShotCandidatesList, fewShotCount, paper.id)
                : { block: '', included: 0 }

              // Each mode does its own model call(s), then rows/usage/cost
              // are recorded uniformly below — cross-check (prompt/agent
              // only) piggybacks on the same shared block.
              let answer: LlmAnswer
              let paperText = ''
              let calls: number
              let baseUsage: { inputTokens: number; outputTokens: number }
              let paperCost: number
              let roundsForPaper: number | undefined
              let rowChecked: (sug: Suggestion) => boolean

              if (mode === 'agent') {
                const result = await runOnePaperAgent(
                  app.project!,
                  paper,
                  targets,
                  config,
                  judgeCfg,
                  callLlm,
                  myController.signal,
                  (msg) => {
                    if (controller !== myController) return
                    set((s) => {
                      // Tagged with the paper's title: several papers can be
                      // in flight together, so a bare message no longer says
                      // which one it's about.
                      s.agentEvents.push(`${paper.title}: ${msg}`)
                      if (s.agentEvents.length > MAX_AGENT_EVENTS) s.agentEvents.shift()
                    })
                  },
                  setPhase,
                  fewShotForPaper.block,
                )
                if (controller !== myController) return
                // Agent + judge share one combined `usage`; the judge's own
                // portion (`judgeUsage`) is priced against the judge target,
                // the remainder against the agent's — see `estimateCostSplit`'s
                // sibling logic in cost.ts for the same split, done ahead of time.
                const agentPortion = {
                  inputTokens: result.usage.inputTokens - result.judgeUsage.inputTokens,
                  outputTokens: result.usage.outputTokens - result.judgeUsage.outputTokens,
                }
                answer = result.answer
                paperText = result.paperText
                calls = result.usage.calls
                baseUsage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
                paperCost = (costOf(agentPortion, config) ?? 0) + (costOf(result.judgeUsage, judgeCfg ?? config) ?? 0)
                roundsForPaper = result.rounds
                rowChecked = (sug) => sug.judge?.verdict === 'accept'
              } else if (mode === 'classify') {
                const result = await runOnePaperClassify(paper, targets, config, callLlm, myController.signal, setPhase)
                if (controller !== myController) return
                answer = result.answer
                calls = 1
                baseUsage = result.usage
                paperCost = costOf(result.usage, config) ?? 0
                rowChecked = (sug) => (sug.confidence ?? 0) >= confidenceThreshold
              } else {
                const result = await runOnePaperPrompt(
                  app.project!,
                  paper,
                  targets,
                  config,
                  callLlm,
                  myController.signal,
                  setPhase,
                  fewShotForPaper.block,
                )
                if (controller !== myController) return
                answer = result.answer
                paperText = result.paperText
                calls = 1
                baseUsage = result.usage
                paperCost = costOf(result.usage, config) ?? 0
                rowChecked = () => true
              }

              // Cross-check (prompt/agent only, optional role): compare each
              // eligible proposed value against System One's own answer.
              // Never fails the paper — a cross-check error is just a note.
              const crossCheckResult =
                crossCheckCfg && mode !== 'classify'
                  ? await runCrossCheck(
                      paper,
                      targets,
                      answer.fields,
                      crossCheckCfg,
                      paperText,
                      callLlm,
                      myController.signal,
                    )
                  : null
              if (controller !== myController) return

              set((s) => {
                for (const sug of answer.fields) {
                  const cmp = crossCheckResult?.comparisons.get(sug.path)
                  let checked = rowChecked(sug)
                  if (cmp && !cmp.agrees && cmp.p >= confidenceThreshold) checked = false
                  s.rows.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    reviewer: get().targetSeat,
                    suggestion: sug,
                    checked,
                    crossCheck: cmp,
                  })
                }
                s.usage.calls += calls + (crossCheckResult ? 1 : 0)
                s.usage.inputTokens += baseUsage.inputTokens + (crossCheckResult?.usage.inputTokens ?? 0)
                s.usage.outputTokens += baseUsage.outputTokens + (crossCheckResult?.usage.outputTokens ?? 0)
                s.spentSoFar +=
                  paperCost + (crossCheckResult ? (costOf(crossCheckResult.usage, crossCheckCfg!) ?? 0) : 0)
                if (roundsForPaper !== undefined) s.roundsByPaper[paper.id] = roundsForPaper
                if (fewShotForPaper.included > 0) s.fewShotByPaper[paper.id] = fewShotForPaper.included
                const skipped = [
                  ...answer.skipped,
                  ...(crossCheckResult?.error ? [{ path: '(cross-check)', reason: crossCheckResult.error }] : []),
                ]
                if (skipped.length > 0 || answer.rejected.length > 0) {
                  s.notes.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    skipped,
                    rejected: answer.rejected,
                  })
                }
              })
              if (controller === myController) {
                doneIds.push(paper.id)
                set((s) => { s.batchDone++ })
              }
            } catch (err) {
              if (controller !== myController) return // superseded mid-call — discard silently
              if (myController.signal.aborted) return // cancelled — stays a resume candidate, not an error
              set((s) => {
                s.errors.push({
                  paperId: paper.id,
                  paperTitle: paper.title,
                  message: err instanceof Error ? err.message : String(err),
                })
                if (err instanceof Error && (err as Error & { scanned?: boolean }).scanned) s.scanned = true
              })
              // A paper that failed this run isn't retried by resuming the
              // same batch — it stays recorded in `errors` instead. Starting a
              // fresh "annotate all papers" run picks it up again if it's
              // still a candidate.
              doneIds.push(paper.id)
              set((s) => { s.batchDone++ })
            } finally {
              if (controller === myController) {
                set((s) => { s.inFlightTitles = s.inFlightTitles.filter((t) => t !== paper.title) })
                persist()
              }
            }
          },
          myController.signal,
        )
      } finally {
        if (controller === myController) {
          stopTicker()
          controller = null
        }
      }

      // Reached only by the run that owns this attempt (every supersede/abort
      // branch above returns before this point).
      const rows = get().rows
      const errors = get().errors
      const aborted = myController.signal.aborted
      if (aborted && rows.length === 0) {
        set((s) => { s.phase = 'setup'; s.error = null })
        return
      }
      if (rows.length === 0 && errors.length > 0 && !get().allPapers) {
        // Single-paper mode: keep the classic one-error screen rather than a
        // review screen with nothing to review.
        set((s) => {
          s.phase = 'error'
          s.error = errors[0].message
        })
        return
      }
      set((s) => { s.phase = 'review' })
    }

    return {
    open: false,
    minimized: false,
    settingsOpen: false,
    configs: [],
    selectedId: readSelected(),
    models: {},
    modelsLoading: {},
    modelsError: {},
    modelsFetchedAt: {},
    mode: readMode(),
    allPapers: false,
    judgeSelectedId: readJudge(),
    crossCheckId: readCrossCheck(),
    confidenceThreshold: readThreshold(),
    spendCap: null,
    spentSoFar: 0,
    spendCapHit: false,
    retryNotice: null,
    fewShot: readFewShot(),
    fewShotCount: readFewShotCount(),
    fewShotAvailable: 0,
    pageCounts: {},
    pageCountsLoading: {},
    phase: 'setup',
    error: null,
    elapsed: 0,
    targetSeat: null,
    targets: [],
    currentPaperHasPdf: true,
    candidates: [],
    batchDone: 0,
    batchTotal: 0,
    inFlightTitles: [],
    concurrency: readConcurrency(),
    resumeAvailable: null,
    batchStartedAt: null,
    agentEvents: [],
    errors: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
    runJudge: null,
    roundsByPaper: {},
    fewShotByPaper: {},
    rows: [],
    notes: [],
    applied: null,
    scanned: false,

    openDialog: async () => {
      const app = useStore.getState()
      const paper = app.project?.papers.find((p) => p.id === app.currentPaperId)
      if (!app.project || !paper) return
      // Second line of defense; the toolbar AI button is already disabled for an opted-out project.
      if (!app.project.aiEnabled) return
      // The AI's own seat (REQ-LLM-470) is always the target when the project
      // has one, whichever human seat is currently selected — an AI run never
      // writes into the reviewer's own seat by accident.
      const targetSeat = aiSeatId(app.project) ?? app.currentReviewer
      // Multi-reviewer with nobody picked and no AI seat: no active tree to propose values into.
      if (app.project.reviewers > 1 && targetSeat === null) return
      const tree = currentTree(app.project, targetSeat, paper)
      if (!tree) return

      set((s) => {
        s.open = true
        s.minimized = false
        s.phase = 'setup'
        s.error = null
        s.rows = []
        s.notes = []
        s.applied = null
        s.scanned = false
        s.elapsed = 0
        s.allPapers = false
        s.errors = []
        s.usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
        s.runUsage = null
        s.runJudge = null
        s.roundsByPaper = {}
        s.fewShotByPaper = {}
        s.spendCap = null
        s.spentSoFar = 0
        s.spendCapHit = false
        s.retryNotice = null
        s.batchDone = 0
        s.batchTotal = 0
        s.inFlightTitles = []
        s.batchStartedAt = null
        s.targetSeat = targetSeat
        s.targets = unansweredFields(app.project!.schema, tree)
        s.currentPaperHasPdf = !!paper.pdf
        s.candidates = batchCandidates(app.project!, app.currentReviewer)
        s.fewShotAvailable = fewShotCandidates(app.project!, app.currentReviewer).filter(
          (c) => c.paperId !== paper.id,
        ).length
        // A saved batch is only offered once its target still exists —
        // otherwise there is nothing to resume with.
        const saved = readPersistedBatch(targetSeat)
        s.resumeAvailable = saved && s.configs.some((c) => c.id === saved.configId) ? saved : null
      })
      await get().refreshConfigs()
      // `configs` may have just been (re)loaded — re-check now that it's current.
      set((s) => {
        const saved = readPersistedBatch(targetSeat)
        s.resumeAvailable = saved && s.configs.some((c) => c.id === saved.configId) ? saved : null
      })
      // This project's own remembered role assignment wins over the global
      // fallback already in `selectedId`/`judgeSelectedId`/`crossCheckId` —
      // but only for a role whose target still exists.
      const roles = readProjectRoles()
      set((s) => {
        if (roles.annotatorId && s.configs.some((c) => c.id === roles.annotatorId)) {
          s.selectedId = roles.annotatorId
        }
        if (roles.judgeId !== undefined && (roles.judgeId === null || s.configs.some((c) => c.id === roles.judgeId))) {
          s.judgeSelectedId = roles.judgeId
        }
        if (
          roles.crossCheckId !== undefined &&
          (roles.crossCheckId === null || s.configs.some((c) => c.id === roles.crossCheckId))
        ) {
          s.crossCheckId = roles.crossCheckId
        }
      })
    },

    closeDialog: () => {
      get().cancel()
      set((s) => {
        s.open = false
        s.minimized = false
        s.settingsOpen = false
      })
    },

    setMinimized: (minimized) => set((s) => { s.minimized = minimized }),

    setSettingsOpen: (open) => set((s) => { s.settingsOpen = open }),

    selectConfig: (id) => {
      writeSelected(id)
      writeProjectRole({ annotatorId: id })
      set((s) => { s.selectedId = id })
    },

    setMode: (mode) => {
      writeMode(mode)
      set((s) => {
        s.mode = mode
        // A model belongs to one "family" (System One decision model, or a
        // chat/agent model) — switching between classify and the other modes
        // can leave the previous annotator invalid for the new one.
        const wantSystemOne = mode === 'classify'
        const cfg = s.configs.find((c) => c.id === s.selectedId)
        if (cfg && (cfg.provider === 'systemone') !== wantSystemOne) {
          s.selectedId = s.configs.find((c) => (c.provider === 'systemone') === wantSystemOne)?.id ?? null
        }
      })
    },

    setAllPapers: (on) => {
      const app = useStore.getState()
      set((s) => {
        s.allPapers = on
        if (on && app.project) s.candidates = batchCandidates(app.project, app.currentReviewer)
      })
    },

    selectJudge: (id) => {
      writeJudge(id)
      writeProjectRole({ judgeId: id })
      set((s) => { s.judgeSelectedId = id })
    },

    selectCrossCheck: (id) => {
      writeCrossCheck(id)
      writeProjectRole({ crossCheckId: id })
      set((s) => { s.crossCheckId = id })
    },

    setConfidenceThreshold: (n) => {
      const clamped = Math.min(Math.max(n, 0), 1)
      writeThreshold(clamped)
      set((s) => { s.confidenceThreshold = clamped })
    },

    setSpendCap: (cap) => set((s) => { s.spendCap = cap }),

    setFewShot: (on) => {
      writeFewShot(on, get().fewShotCount)
      set((s) => { s.fewShot = on })
    },

    setFewShotCount: (count) => {
      writeFewShot(get().fewShot, count)
      set((s) => { s.fewShotCount = count })
    },

    ensurePageCounts: async (paperIds) => {
      const app = useStore.getState()
      const missing = paperIds.filter(
        (id) => get().pageCounts[id] === undefined && !get().pageCountsLoading[id],
      )
      if (missing.length === 0) return
      set((s) => {
        for (const id of missing) s.pageCountsLoading[id] = true
      })
      await Promise.all(
        missing.map(async (id) => {
          const paper = app.project?.papers.find((p) => p.id === id)
          if (!paper?.pdf) {
            set((s) => { delete s.pageCountsLoading[id] })
            return
          }
          try {
            const src = await getPlatform().getPdfSource(paper.pdf, app.saveHandle ?? { kind: 'download' })
            let bytes: ArrayBuffer
            try {
              bytes = await (await fetch(src.url)).arrayBuffer()
            } finally {
              src.revoke?.()
            }
            const pages = await countPdfPages(bytes)
            set((s) => {
              s.pageCounts[id] = pages
              delete s.pageCountsLoading[id]
            })
          } catch {
            // Best-effort — leave this paper's count uncached rather than
            // failing the estimate for every other paper.
            set((s) => { delete s.pageCountsLoading[id] })
          }
        }),
      )
    },

    refreshConfigs: async () => {
      const configs = await getPlatform().listLlmConfigs()
      set((s) => {
        s.configs = configs
        // Keep the selection pointing at something that still exists.
        if (!configs.some((c) => c.id === s.selectedId)) {
          s.selectedId = configs[0]?.id ?? null
          if (s.selectedId) writeSelected(s.selectedId)
        }
        // Unlike `selectedId`, `null` here is a valid choice ("same as agent"),
        // not "nothing picked yet" — only a stale target id needs clearing.
        if (s.judgeSelectedId && !configs.some((c) => c.id === s.judgeSelectedId)) {
          s.judgeSelectedId = null
          writeJudge(null)
        }
        if (s.crossCheckId && !configs.some((c) => c.id === s.crossCheckId)) {
          s.crossCheckId = null
          writeCrossCheck(null)
        }
      })
    },

    saveConfig: async (config, apiKey) => {
      const configs = await getPlatform().saveLlmConfig(config, apiKey)
      set((s) => {
        s.configs = configs
        if (!s.selectedId) s.selectedId = config.id
      })
    },

    deleteConfig: async (id) => {
      const configs = await getPlatform().deleteLlmConfig(id)
      set((s) => {
        s.configs = configs
        if (s.selectedId === id) s.selectedId = configs[0]?.id ?? null
      })
    },

    /**
     * Send a minimal request so a bad key/model/URL surfaces here rather than
     * after a full paper run. `max_tokens` can't be tiny: on a reasoning model
     * a too-tight cap gets spent entirely on hidden reasoning before the reply
     * ("OK") is ever written, coming back truncated rather than erroring.
     */
    verifyConfig: async (config, apiKey) => {
      // The key must be stored before it can be used: the renderer never holds it.
      await get().saveConfig(config, apiKey)

      if (config.provider === 'systemone') {
        const req = buildSystemOneVerifyRequest(config)
        const res = await getPlatform().callLlm(req)
        if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
        const parsed = parseSystemOneResponse(SYSTEMONE_VERIFY_ASKED, safeJson(res.body))
        const p = parsed.probabilities.verify?.true
        if (p === undefined) throw new Error('The provider answered, but the reply had no usable answer.')
        return `P(true) = ${p.toFixed(2)}`
      }

      const req = buildRequest(
        config,
        'You are a connection test. Reply with the single word OK.',
        { kind: 'text', text: 'Reply with OK.' },
        { maxTokens: VERIFY_MAX_TOKENS },
      )
      const res = await getPlatform().callLlm(req)
      if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
      const json = safeJson(res.body)
      const text = extractText(config.provider, json).trim()
      if (!text) {
        if (wasTruncated(config.provider, json)) {
          throw new Error(
            `${PROVIDERS[config.provider].label} used its whole reply budget on internal ` +
              'reasoning and never got to an answer. This model reasons more than most before ' +
              'replying — if it keeps happening, try a lower reasoning-effort setting for this ' +
              'model, if the provider offers one.',
          )
        }
        throw new Error('The provider answered, but the reply was empty.')
      }
      return text
    },

    fetchModels: async (config, apiKey, opts) => {
      const id = config.id
      // openai-compatible: never attempted — see `supportsModelListing` in providers.ts.
      if (!PROVIDERS[config.provider].supportsModelListing) return
      const fetchedAt = get().modelsFetchedAt[id]
      if (!opts?.force && fetchedAt && Date.now() - fetchedAt < MODELS_TTL_MS) return

      set((s) => {
        s.modelsLoading[id] = true
        s.modelsError[id] = null
      })
      try {
        // Same requirement as verifyConfig: key must be stored before use.
        await get().saveConfig(config, apiKey)
        const saved = get().configs.find((c) => c.id === id) ?? config

        const models: ModelInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < MAX_MODEL_PAGES; page++) {
          const req = buildModelsRequest(saved, cursor)
          // Null: cursor points off-origin — don't follow it with the API key attached.
          if (!req) break
          const res = await getPlatform().callLlm(req)
          if (!res.ok) throw new Error(extractError(saved.provider, res.status, res.body))
          const parsed = parseModelsResponse(saved.provider, safeJson(res.body))
          models.push(...parsed.models)
          if (!parsed.nextCursor) break
          cursor = parsed.nextCursor
        }

        set((s) => {
          s.models[id] = models
          s.modelsLoading[id] = false
          s.modelsFetchedAt[id] = Date.now()
        })
      } catch (err) {
        set((s) => {
          s.modelsLoading[id] = false
          s.modelsError[id] = err instanceof Error ? err.message : String(err)
        })
      }
    },

    clearModels: (id) =>
      set((s) => {
        delete s.models[id]
        delete s.modelsLoading[id]
        delete s.modelsError[id]
        delete s.modelsFetchedAt[id]
      }),

    run: async () => {
      const app = useStore.getState()
      const config = get().configs.find((c) => c.id === get().selectedId)
      if (!app.project || !config) return
      if (!isUsable(config)) {
        set((s) => {
          s.phase = 'error'
          s.error = 'This target has no API key. Add one in the settings (gear icon).'
        })
        return
      }

      const mode = get().mode
      const judgeId = get().judgeSelectedId
      const judgeCfg = mode === 'agent' && judgeId ? get().configs.find((c) => c.id === judgeId) : undefined
      if (mode === 'agent' && judgeId && (!judgeCfg || !isUsable(judgeCfg))) {
        set((s) => {
          s.phase = 'error'
          s.error = 'The judge target has no API key. Add one in the settings (gear icon).'
        })
        return
      }
      const crossCheckId = get().crossCheckId
      const crossCheckCfg =
        mode !== 'classify' && crossCheckId ? get().configs.find((c) => c.id === crossCheckId) : undefined
      if (mode !== 'classify' && crossCheckId && (!crossCheckCfg || !isUsable(crossCheckCfg))) {
        set((s) => {
          s.phase = 'error'
          s.error = 'The cross-check model has no API key. Add one in the settings (gear icon).'
        })
        return
      }
      const papers: Paper[] = get().allPapers
        ? get()
            .candidates.map((c) => app.project!.papers.find((p) => p.id === c.id))
            .filter((p): p is Paper => !!p)
        : app.project.papers.filter((p) => p.id === app.currentPaperId && !!p.pdf)
      if (papers.length === 0) return

      // All-papers mode only — see `spendCap`'s doc comment.
      const cap = get().allPapers ? get().spendCap : null

      // Rate-limit retries are the same wrapped function for every call this
      // run makes (agent turns and judge calls alike) — Verify setup and model
      // listing intentionally call the platform directly, unwrapped.
      const callLlm: CallLlm = withRetry(getPlatform().callLlm, {
        onRetry: (info) => {
          set((s) => {
            s.retryNotice = `Rate-limited, retrying in ${Math.ceil(info.delayMs / 1000)}s…`
          })
        },
      })

      // Computed once per run, not per paper: the source seat and "most
      // answered first" ordering don't change paper to paper, only which
      // candidate gets excluded as "the current one" does — see `pickFewShotExamples`.
      const fewShotOn = get().fewShot
      const fewShotCandidatesList = fewShotOn ? fewShotCandidates(app.project, app.currentReviewer) : []
      const fewShotCount = get().fewShotCount

      // Starting fresh supersedes any earlier saved progress for this seat —
      // `executeBatch` will start re-persisting from scratch as it goes.
      if (get().allPapers) clearPersistedBatch(get().targetSeat)

      set((s) => {
        s.runUsage = { provider: config.provider, model: config.model }
        s.runJudge = mode === 'agent' ? { provider: (judgeCfg ?? config).provider, model: (judgeCfg ?? config).model } : null
        s.roundsByPaper = {}
        s.fewShotByPaper = {}
        s.rows = []
        s.notes = []
        s.errors = []
        s.usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
        s.spentSoFar = 0
        s.spendCapHit = false
        s.retryNotice = null
        s.agentEvents = []
        s.applied = null
        s.error = null
        s.elapsed = 0
        s.batchStartedAt = new Date().toISOString()
      })

      await executeBatch(
        papers,
        papers.map((p) => p.id),
        [],
        config,
        judgeCfg,
        crossCheckCfg,
        mode,
        callLlm,
        cap,
        fewShotOn,
        fewShotCandidatesList,
        fewShotCount,
        get().confidenceThreshold,
      )
    },

    resumeBatch: async () => {
      const app = useStore.getState()
      if (!app.project) return
      const persisted = readPersistedBatch(get().targetSeat)
      if (!persisted) return
      const config = get().configs.find((c) => c.id === persisted.configId)
      if (!config) return // the saved target no longer exists — nothing to resume with
      const judgeCfg = persisted.judgeId ? get().configs.find((c) => c.id === persisted.judgeId) : undefined
      const crossCheckCfg = persisted.crossCheckId
        ? get().configs.find((c) => c.id === persisted.crossCheckId)
        : undefined

      set((s) => {
        s.mode = persisted.mode
        s.selectedId = persisted.configId
        s.judgeSelectedId = persisted.judgeId
        s.crossCheckId = persisted.crossCheckId ?? null
        s.allPapers = true
        s.rows = persisted.rows ?? []
        s.notes = persisted.notes ?? []
        s.errors = persisted.errors ?? []
        s.usage = persisted.usage
        s.spentSoFar = persisted.spent
        s.spendCapHit = false
        s.retryNotice = null
        s.roundsByPaper = persisted.roundsByPaper ?? {}
        s.fewShotByPaper = persisted.fewShotByPaper ?? {}
        s.runUsage = { provider: config.provider, model: config.model }
        s.runJudge =
          persisted.mode === 'agent'
            ? { provider: (judgeCfg ?? config).provider, model: (judgeCfg ?? config).model }
            : null
        s.agentEvents = []
        s.applied = null
        s.error = null
        s.elapsed = 0
        s.batchStartedAt = persisted.startedAt
        s.resumeAvailable = null
        s.candidates = batchCandidates(app.project!, app.currentReviewer)
      })

      // Rows were dropped for size — their papers' results aren't recoverable,
      // so resume re-runs the whole original scope rather than just the tail.
      const remainingIds =
        persisted.rows === undefined
          ? persisted.allPaperIds
          : persisted.allPaperIds.filter((id) => !persisted.doneIds.includes(id))
      const stillCandidates = new Set(batchCandidates(app.project, app.currentReviewer).map((c) => c.id))
      const papers = remainingIds
        .map((id) => app.project!.papers.find((p) => p.id === id))
        .filter((p): p is Paper => !!p && stillCandidates.has(p.id))

      if (papers.length === 0) {
        set((s) => { s.phase = 'review' })
        return
      }

      const cap = get().spendCap
      const callLlm: CallLlm = withRetry(getPlatform().callLlm, {
        onRetry: (info) => {
          set((s) => {
            s.retryNotice = `Rate-limited, retrying in ${Math.ceil(info.delayMs / 1000)}s…`
          })
        },
      })
      const fewShotOn = get().fewShot
      const fewShotCandidatesList = fewShotOn ? fewShotCandidates(app.project, app.currentReviewer) : []
      const fewShotCount = get().fewShotCount

      await executeBatch(
        papers,
        persisted.allPaperIds,
        persisted.doneIds,
        config,
        judgeCfg,
        crossCheckCfg,
        persisted.mode,
        callLlm,
        cap,
        fewShotOn,
        fewShotCandidatesList,
        fewShotCount,
        get().confidenceThreshold,
      )
    },

    setConcurrency: (n) => {
      const clamped = Math.min(Math.max(1, Math.round(n)), MAX_CONCURRENCY)
      writeConcurrency(clamped)
      set((s) => { s.concurrency = clamped })
    },

    cancel: () => {
      // Abort only — clearing the slot here would stop the run's own catch
      // from telling an abort from a failure. The run clears it itself.
      controller?.abort()
      stopTicker()
      set((s) => {
        if (s.phase === 'reading' || s.phase === 'calling' || s.phase === 'parsing') {
          s.phase = s.rows.length > 0 ? 'review' : 'setup'
        }
      })
    },

    toggleRow: (index, checked) =>
      set((s) => {
        if (s.rows[index]) s.rows[index].checked = checked
      }),

    setAllRows: (checked) =>
      set((s) => {
        s.rows.forEach((r) => { r.checked = checked })
      }),

    apply: () => {
      const runUsage = get().runUsage
      if (!runUsage) return
      const mode = get().mode
      const runJudge = get().runJudge
      const roundsByPaper = get().roundsByPaper
      const fewShotByPaper = get().fewShotByPaper
      const checked = get().rows.filter((r) => r.checked)

      // One item per (paper, reviewer) pair — batch apply writes every paper in
      // a single undo step, however many papers this run touched. Verdict
      // counts are taken only from the rows actually applied (checked), per
      // REQ-LLM-240 — not every value the agent proposed.
      interface Entry {
        paperId: string
        reviewer: string | null
        suggestions: Suggestion[]
        verdicts: { accept: number; revise: number; reject: number }
      }
      const byPaper = new Map<string, Entry>()
      for (const row of checked) {
        const key = `${row.paperId}\u0000${row.reviewer ?? ''}`
        const entry = byPaper.get(key) ?? {
          paperId: row.paperId,
          reviewer: row.reviewer,
          suggestions: [],
          verdicts: { accept: 0, revise: 0, reject: 0 },
        }
        entry.suggestions.push(row.suggestion)
        const verdict = row.suggestion.judge?.verdict
        if (verdict) entry.verdicts[verdict]++
        byPaper.set(key, entry)
      }
      const items = [...byPaper.values()].map((entry) => ({
        paperId: entry.paperId,
        reviewer: entry.reviewer,
        suggestions: entry.suggestions,
        usage: {
          ...runUsage,
          mode,
          ...(mode === 'agent' && runJudge ? { judge: runJudge } : {}),
          ...(mode === 'agent' && roundsByPaper[entry.paperId] !== undefined
            ? { rounds: roundsByPaper[entry.paperId] }
            : {}),
          ...(mode === 'agent' ? { verdicts: entry.verdicts } : {}),
          ...(fewShotByPaper[entry.paperId] !== undefined ? { fewShot: fewShotByPaper[entry.paperId] } : {}),
        },
      }))
      const result = useStore.getState().applyAiSuggestionsBatch(items)
      // Unchecked rows are never applied, so they count as skipped alongside
      // whatever the store itself refused (already-answered fields, dead paths).
      const uncheckedCount = get().rows.length - checked.length
      if (get().allPapers) clearPersistedBatch(get().targetSeat)
      set((s) => {
        s.applied = { filled: result.filled, skipped: result.skipped + uncheckedCount, papers: result.papers }
        s.phase = 'applied'
      })
    },

    discardBatch: () => {
      if (get().allPapers) clearPersistedBatch(get().targetSeat)
      get().closeDialog()
    },

    dismissResume: () => {
      clearPersistedBatch(get().targetSeat)
      set((s) => { s.resumeAvailable = null })
    },
    }
  }),
)

// ---------------------------------------------------------------------------
// Per-paper run helpers — one call for prompt mode, one loop for agent mode.
// ---------------------------------------------------------------------------

async function runOnePaperPrompt(
  project: Project,
  paper: Paper,
  targets: FieldTarget[],
  config: LlmConfig,
  callLlm: CallLlm,
  signal: AbortSignal,
  setPhase: (p: AiPhase) => void,
  /** Pre-built few-shot block (see fewshot.ts), or `''` when the feature is off. */
  fewShotBlock = '',
): Promise<{ answer: LlmAnswer; usage: { inputTokens: number; outputTokens: number }; paperText: string }> {
  setPhase('reading')
  const app = useStore.getState()
  // Same URL the viewer renders, so this works unchanged in both runtimes.
  const src = await getPlatform().getPdfSource(paper.pdf, app.saveHandle ?? { kind: 'download' })
  let bytes: ArrayBuffer
  try {
    bytes = await (await fetch(src.url)).arrayBuffer()
  } finally {
    src.revoke?.()
  }

  let delivery = config.attach
  let paperText = ''
  if (delivery === 'text') {
    const extracted = await extractPdfText(bytes)
    paperText = extracted.text
    if (extracted.empty) {
      // Nothing to send. Sending it anyway would invite the model to invent a
      // paper from its title alone.
      throw scannedError()
    }
  } else if (!PROVIDERS[config.provider].supportsPdf) {
    delivery = 'text'
    paperText = (await extractPdfText(bytes)).text
  }

  // With extracted text the model must be warned extraction is lossy, or it
  // will confidently reconstruct a mangled table.
  const system = buildSystemPrompt(project.schema, targets, delivery, fewShotBlock || undefined)
  const req =
    delivery === 'text'
      ? buildRequest(config, system, { kind: 'text', text: buildUserText(paper, paperText) })
      : buildRequest(config, `${system}\n\n${buildUserPdfCaption(paper)}`, {
          kind: 'pdf',
          base64: toBase64(bytes),
          filename: paper.pdf.split('/').pop() ?? 'paper.pdf',
        })

  setPhase('calling')
  const res = await callLlm(req, signal)
  if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))

  setPhase('parsing')
  const json = safeJson(res.body)
  const text = extractText(config.provider, json)
  // Distinguish "model proposed nothing" from "ran out of budget before
  // answering" — same empty text, different problem and fix.
  if (!text.trim() && wasTruncated(config.provider, json)) {
    throw new Error(
      `${PROVIDERS[config.provider].label} used its whole reply budget on internal ` +
        'reasoning and never got to an answer for this paper. If this keeps happening, try ' +
        'a lower reasoning-effort setting for this model, if the provider offers one.',
    )
  }
  const answer = parseAnswer(project.schema, text)
  const usage = parseChatResponse(config.provider, json).usage
  return { answer, usage, paperText }
}

async function runOnePaperAgent(
  project: Project,
  paper: Paper,
  targets: FieldTarget[],
  config: LlmConfig,
  judgeConfig: LlmConfig | undefined,
  callLlm: CallLlm,
  signal: AbortSignal,
  onEvent: (message: string) => void,
  setPhase: (p: AiPhase) => void,
  /** Pre-built few-shot block (see fewshot.ts), or `''` when the feature is off. */
  fewShotBlock = '',
): Promise<{
  answer: LlmAnswer
  usage: { inputTokens: number; outputTokens: number; calls: number }
  judgeUsage: { inputTokens: number; outputTokens: number; calls: number }
  rounds: number
  paperText: string
}> {
  setPhase('reading')
  const app = useStore.getState()
  const src = await getPlatform().getPdfSource(paper.pdf, app.saveHandle ?? { kind: 'download' })
  let bytes: ArrayBuffer
  try {
    bytes = await (await fetch(src.url)).arrayBuffer()
  } finally {
    src.revoke?.()
  }

  // Agent mode always extracts text, even when the target delivers the PDF
  // itself: the search/read tools and the evidence check both work off it.
  const extracted = await extractPdfText(bytes)
  const delivery: Delivery = config.attach === 'pdf' && PROVIDERS[config.provider].supportsPdf ? 'pdf' : 'text'
  if (delivery === 'text' && extracted.empty) {
    throw scannedError()
  }

  setPhase('calling')
  const result = await runAgent(
    {
      config,
      judgeConfig,
      schema: project.schema,
      targets,
      paper,
      paperText: extracted.text,
      delivery,
      pdfBase64: delivery === 'pdf' ? toBase64(bytes) : undefined,
      pdfFilename: delivery === 'pdf' ? (paper.pdf.split('/').pop() ?? 'paper.pdf') : undefined,
      signal,
      onEvent: (e) => onEvent(e.message),
      examples: fewShotBlock || undefined,
    },
    {
      callLlm,
      fetchWeb: (url, sig) => getPlatform().fetchWeb(url, sig),
    },
  )
  return {
    answer: result.answer,
    usage: result.usage,
    judgeUsage: result.judgeUsage,
    rounds: result.rounds,
    paperText: extracted.text,
  }
}

/**
 * Classify mode's per-paper call: one `/v1/systemone` request for whichever
 * of `targets` are eligible (booleans and single-valued enums — see
 * `systemOneEligible`); everything else is reported as skipped so the
 * setup/review screens can say why, same shape prompt/agent mode's `skipped`
 * already uses.
 */
async function runOnePaperClassify(
  paper: Paper,
  targets: FieldTarget[],
  config: LlmConfig,
  callLlm: CallLlm,
  signal: AbortSignal,
  setPhase: (p: AiPhase) => void,
): Promise<{ answer: LlmAnswer; usage: { inputTokens: number; outputTokens: number } }> {
  setPhase('reading')
  const app = useStore.getState()
  const src = await getPlatform().getPdfSource(paper.pdf, app.saveHandle ?? { kind: 'download' })
  let bytes: ArrayBuffer
  try {
    bytes = await (await fetch(src.url)).arrayBuffer()
  } finally {
    src.revoke?.()
  }
  // Unlike prompt/agent mode, no text is not fatal here: for a small-context
  // model only the title/abstract may fit anyway (see systemone.ts), and a
  // boolean/choice question can still be meaningfully answered from those alone.
  const paperText = (await extractPdfText(bytes)).text

  const ineligible = targets.filter((t) => !systemOneEligible(t))
  const built = buildSystemOneRequest(config, paper, paperText, targets)
  if (!built) {
    return {
      answer: {
        fields: [],
        skipped: ineligible.map((t) => ({ path: t.path, reason: 'not handled in Classify mode' })),
        rejected: [],
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  setPhase('calling')
  const res = await callLlm(built.request, signal)
  if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))

  setPhase('parsing')
  const parsed = parseSystemOneResponse(built.asked, safeJson(res.body))
  return {
    answer: {
      fields: parsed.suggestions,
      skipped: [
        ...parsed.skipped,
        ...ineligible.map((t) => ({ path: t.path, reason: 'not handled in Classify mode' })),
      ],
      rejected: [],
    },
    usage: parsed.usage,
  }
}

/**
 * Cross-check role: after a paper's suggestions are in hand, ask System One
 * the same question for whichever of `targets` are both eligible and were
 * actually proposed, then compare. Never throws — a failure here must not
 * fail the paper (see the caller), so it comes back as `error` instead.
 */
async function runCrossCheck(
  paper: Paper,
  targets: FieldTarget[],
  suggestions: Suggestion[],
  config: LlmConfig,
  paperText: string,
  callLlm: CallLlm,
  signal: AbortSignal,
): Promise<{
  comparisons: Map<string, SystemOneComparison>
  usage: { inputTokens: number; outputTokens: number }
  error?: string
}> {
  const empty = { comparisons: new Map<string, SystemOneComparison>(), usage: { inputTokens: 0, outputTokens: 0 } }
  try {
    const eligible = targets.filter(
      (t) => systemOneEligible(t) && suggestions.some((s) => s.path === t.path),
    )
    if (eligible.length === 0) return empty
    const built = buildSystemOneRequest(config, paper, paperText, eligible)
    if (!built) return empty
    const res = await callLlm(built.request, signal)
    if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
    const parsed = parseSystemOneResponse(built.asked, safeJson(res.body))
    return { comparisons: compareWithSystemOne(suggestions, parsed), usage: parsed.usage }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}

function scannedError(): Error & { scanned: true } {
  const err = new Error(
    'No text could be extracted from this PDF — it looks like a scan of a printed ' +
      'paper. Switch this target to "Send the PDF itself" in the settings, if your ' +
      'provider supports it.',
  ) as Error & { scanned: true }
  err.scanned = true
  return err
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/** ArrayBuffer → base64, in chunks so a large PDF cannot blow the argument limit. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function readSelected(): string | null {
  try {
    return localStorage?.getItem(SELECTED_KEY) ?? null
  } catch {
    return null
  }
}

function writeSelected(id: string): void {
  try {
    localStorage?.setItem(SELECTED_KEY, id)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

function readMode(): AiMode {
  try {
    return localStorage?.getItem(MODE_KEY) === 'agent' ? 'agent' : 'prompt'
  } catch {
    return 'prompt'
  }
}

function writeMode(mode: AiMode): void {
  try {
    localStorage?.setItem(MODE_KEY, mode)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

/** `null` ("same as agent") is stored as no key at all, not an empty string. */
function readJudge(): string | null {
  try {
    return localStorage?.getItem(JUDGE_KEY) ?? null
  } catch {
    return null
  }
}

function writeJudge(id: string | null): void {
  try {
    if (id) localStorage?.setItem(JUDGE_KEY, id)
    else localStorage?.removeItem(JUDGE_KEY)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

/** `null` ("no cross-check model") is stored as no key at all, same rule as `readJudge`. */
function readCrossCheck(): string | null {
  try {
    return localStorage?.getItem(CROSSCHECK_KEY) ?? null
  } catch {
    return null
  }
}

function writeCrossCheck(id: string | null): void {
  try {
    if (id) localStorage?.setItem(CROSSCHECK_KEY, id)
    else localStorage?.removeItem(CROSSCHECK_KEY)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

function readThreshold(): number {
  try {
    const raw = Number(localStorage?.getItem(THRESHOLD_KEY))
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_THRESHOLD
  } catch {
    return DEFAULT_THRESHOLD
  }
}

function writeThreshold(n: number): void {
  try {
    localStorage?.setItem(THRESHOLD_KEY, String(n))
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

/** Both the toggle and the count live in one key — nothing else needs them separately. */
function readFewShot(): boolean {
  try {
    const raw = localStorage?.getItem(FEW_SHOT_KEY)
    return raw ? (JSON.parse(raw).on ?? false) : false
  } catch {
    return false
  }
}

function readFewShotCount(): number {
  try {
    const raw = localStorage?.getItem(FEW_SHOT_KEY)
    const count = raw ? JSON.parse(raw).count : undefined
    return typeof count === 'number' && count >= 1 && count <= 5 ? count : DEFAULT_FEW_SHOT_COUNT
  } catch {
    return DEFAULT_FEW_SHOT_COUNT
  }
}

function writeFewShot(on: boolean, count: number): void {
  try {
    localStorage?.setItem(FEW_SHOT_KEY, JSON.stringify({ on, count }))
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

function readConcurrency(): number {
  try {
    const raw = Number(localStorage?.getItem(CONCURRENCY_KEY))
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX_CONCURRENCY ? raw : DEFAULT_CONCURRENCY
  } catch {
    return DEFAULT_CONCURRENCY
  }
}

function writeConcurrency(n: number): void {
  try {
    localStorage?.setItem(CONCURRENCY_KEY, String(n))
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

// A run belongs to the project it started in: closing or replacing that
// project aborts it, so a batch never keeps spending (or later applies) into
// whatever project is open next.
useStore.subscribe((s, prev) => {
  if (s.projectGeneration !== prev.projectGeneration && useAiStore.getState().open) {
    useAiStore.getState().closeDialog()
  }
})
