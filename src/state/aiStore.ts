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
import type { LlmAnswer, LlmConfig, ModelInfo, Suggestion } from '../llm/types'
import type { Paper, Project } from '../model/project'
import { extractPdfText } from '../model/pdfText'

/**
 * State for the AI-assisted annotation flow, kept out of the main store as
 * its own self-contained mode. `apply()` is the one bridge: it hands
 * reviewer-approved values to `applyAiSuggestionsBatch`, the main store's
 * single-undo-step batch write.
 */

const SELECTED_KEY = 'slr.llm.selected'
const MODE_KEY = 'slr.llm.mode'

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

export type AiMode = 'prompt' | 'agent'

/** A suggestion plus the reviewer's decision about it and which paper it belongs to. */
export interface ReviewRow {
  paperId: string
  paperTitle: string
  reviewer: string | null
  suggestion: Suggestion
  checked: boolean
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

  phase: AiPhase
  error: string | null
  /** Seconds the current call has been running, for the progress line. */
  elapsed: number

  /** The fields the AI is being asked about for the current paper — computed
   *  when the dialog opens, used as the disclosure example in all-papers mode too. */
  targets: FieldTarget[]
  /** False when the current paper has no PDF — single-paper mode has nothing to send. */
  currentPaperHasPdf: boolean
  /** Batch candidates, recomputed whenever `allPapers` is toggled on or the dialog opens. */
  candidates: AiCandidate[]

  /** 1-based index of the paper currently being processed, and how many total. */
  batchIndex: number
  batchTotal: number
  batchTitle: string
  /** Agent mode only: the last few progress messages for the paper in flight. */
  agentEvents: string[]
  /** Per-paper failures a batch run continues past. */
  errors: PaperRunError[]
  /** Token/call accounting, summed across every paper and every model call of the run. */
  usage: { calls: number; inputTokens: number; outputTokens: number }
  /** The target the finished run actually used — what `apply()` discloses as `aiUsage`. */
  runUsage: { provider: string; model: string } | null

  rows: ReviewRow[]
  /** Per-paper "left empty"/"rejected" lists, same content the old single-paper
   *  `answer.skipped`/`answer.rejected` carried. */
  notes: PaperNotes[]
  applied: AiBatchApplyResult | null
  /** True when the (single) paper's PDF yielded no usable text (a scanned paper). */
  scanned: boolean

  openDialog: () => Promise<void>
  closeDialog: () => void
  setSettingsOpen: (open: boolean) => void
  selectConfig: (id: string) => void
  setMode: (mode: AiMode) => void
  /** No confirmation gating here — the dialog shows/owns the consequences
   *  warning and only calls this once the reviewer confirms turning it on. */
  setAllPapers: (on: boolean) => void

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
  cancel: () => void
  toggleRow: (index: number, checked: boolean) => void
  setAllRows: (checked: boolean) => void
  apply: () => void
}

// Not in the store: it is not serializable and nothing renders from it.
let controller: AbortController | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function stopTicker() {
  if (ticker) clearInterval(ticker)
  ticker = null
}

/** Papers eligible for "annotate all papers": have a PDF, aren't finished for
 *  this seat, and have at least one unanswered field. */
export function batchCandidates(project: Project, currentReviewer: string | null): AiCandidate[] {
  const out: AiCandidate[] = []
  // Same seats `applyAiSuggestionsBatch` refuses — don't pay for a batch that can't be applied.
  if (currentReviewer === 'consolidation' || project.screening) return out
  for (const paper of project.papers) {
    if (!paper.pdf) continue
    if (currentFinished(project, currentReviewer, paper) === true) continue
    const tree = currentTree(project, currentReviewer, paper)
    if (!tree) continue
    if (unansweredFields(project.schema, tree).length === 0) continue
    out.push({ id: paper.id, title: paper.title })
  }
  return out
}

export const useAiStore = create<AiState>()(
  immer((set, get) => ({
    open: false,
    settingsOpen: false,
    configs: [],
    selectedId: readSelected(),
    models: {},
    modelsLoading: {},
    modelsError: {},
    modelsFetchedAt: {},
    mode: readMode(),
    allPapers: false,
    phase: 'setup',
    error: null,
    elapsed: 0,
    targets: [],
    currentPaperHasPdf: true,
    candidates: [],
    batchIndex: 0,
    batchTotal: 0,
    batchTitle: '',
    agentEvents: [],
    errors: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    runUsage: null,
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
      // Multi-reviewer with nobody picked: no active tree to propose values into.
      if (app.project.reviewers > 1 && app.currentReviewer === null) return
      const tree = currentTree(app.project, app.currentReviewer, paper)
      if (!tree) return

      set((s) => {
        s.open = true
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
        s.targets = unansweredFields(app.project!.schema, tree)
        s.currentPaperHasPdf = !!paper.pdf
        s.candidates = batchCandidates(app.project!, app.currentReviewer)
      })
      await get().refreshConfigs()
    },

    closeDialog: () => {
      get().cancel()
      set((s) => {
        s.open = false
        s.settingsOpen = false
      })
    },

    setSettingsOpen: (open) => set((s) => { s.settingsOpen = open }),

    selectConfig: (id) => {
      writeSelected(id)
      set((s) => { s.selectedId = id })
    },

    setMode: (mode) => {
      writeMode(mode)
      set((s) => { s.mode = mode })
    },

    setAllPapers: (on) => {
      const app = useStore.getState()
      set((s) => {
        s.allPapers = on
        if (on && app.project) s.candidates = batchCandidates(app.project, app.currentReviewer)
      })
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
      if (!config.hasKey) {
        set((s) => {
          s.phase = 'error'
          s.error = 'This target has no API key. Add one in the settings (gear icon).'
        })
        return
      }

      const mode = get().mode
      const papers: Paper[] = get().allPapers
        ? get()
            .candidates.map((c) => app.project!.papers.find((p) => p.id === c.id))
            .filter((p): p is Paper => !!p)
        : app.project.papers.filter((p) => p.id === app.currentPaperId && !!p.pdf)
      if (papers.length === 0) return

      set((s) => {
        s.runUsage = { provider: config.provider, model: config.model }
        s.rows = []
        s.notes = []
        s.errors = []
        s.usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
        s.batchTotal = papers.length
        s.batchIndex = 0
        s.batchTitle = ''
        s.agentEvents = []
        s.applied = null
        s.error = null
        s.elapsed = 0
      })

      // Kept in a local too: reading only the module slot broke both the abort
      // check (cancel nulls it before rejection arrives) and cleanup (finally
      // could clear a newer run's controller instead of this one's).
      const myController = new AbortController()
      controller = myController
      const started = Date.now()
      stopTicker()
      ticker = setInterval(() => {
        set((s) => { s.elapsed = Math.round((Date.now() - started) / 1000) })
      }, 1000)

      // A superseded run must not narrate over the one that replaced it — every
      // phase/event write below is guarded the same way the single-paper flow was.
      const setPhase = (p: AiPhase) => { if (controller === myController) set((s) => { s.phase = p }) }

      try {
        for (let i = 0; i < papers.length; i++) {
          if (controller !== myController) return // superseded — discard silently
          const paper = papers[i]
          set((s) => {
            s.batchIndex = i + 1
            s.batchTitle = paper.title
            s.agentEvents = []
          })

          // Single-paper mode always sends `targets` as computed when the dialog
          // opened, even if by now it's empty (Start would already be disabled —
          // this mirrors that rather than adding a second source of truth).
          // Batch mode recomputes per paper and skips one that turned out to
          // have nothing left unanswered since the candidate list was built.
          const tree = currentTree(app.project!, app.currentReviewer, paper)
          const targets = get().allPapers
            ? unansweredFields(app.project!.schema, tree ?? undefined)
            : get().targets
          if (get().allPapers && targets.length === 0) continue

          try {
            if (mode === 'agent') {
              const result = await runOnePaperAgent(
                app.project!,
                paper,
                targets,
                config,
                myController.signal,
                (msg) => {
                  if (controller !== myController) return
                  set((s) => {
                    s.agentEvents.push(msg)
                    if (s.agentEvents.length > MAX_AGENT_EVENTS) s.agentEvents.shift()
                  })
                },
                setPhase,
              )
              if (controller !== myController) return
              set((s) => {
                for (const sug of result.answer.fields) {
                  s.rows.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    reviewer: app.currentReviewer,
                    suggestion: sug,
                    checked: sug.judge?.verdict === 'accept',
                  })
                }
                s.usage.calls += result.usage.calls
                s.usage.inputTokens += result.usage.inputTokens
                s.usage.outputTokens += result.usage.outputTokens
                if (result.answer.skipped.length > 0 || result.answer.rejected.length > 0) {
                  s.notes.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    skipped: result.answer.skipped,
                    rejected: result.answer.rejected,
                  })
                }
              })
            } else {
              const result = await runOnePaperPrompt(app.project!, paper, targets, config, myController.signal, setPhase)
              if (controller !== myController) return
              set((s) => {
                for (const sug of result.answer.fields) {
                  s.rows.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    reviewer: app.currentReviewer,
                    suggestion: sug,
                    checked: true,
                  })
                }
                s.usage.calls += 1
                s.usage.inputTokens += result.usage.inputTokens
                s.usage.outputTokens += result.usage.outputTokens
                if (result.answer.skipped.length > 0 || result.answer.rejected.length > 0) {
                  s.notes.push({
                    paperId: paper.id,
                    paperTitle: paper.title,
                    skipped: result.answer.skipped,
                    rejected: result.answer.rejected,
                  })
                }
              })
            }
          } catch (err) {
            if (controller !== myController) return // superseded mid-call — discard silently
            if (myController.signal.aborted) break // cancelled — stop the batch, keep what finished
            set((s) => {
              s.errors.push({
                paperId: paper.id,
                paperTitle: paper.title,
                message: err instanceof Error ? err.message : String(err),
              })
              if (err instanceof Error && (err as Error & { scanned?: boolean }).scanned) s.scanned = true
            })
          }
        }
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
      const usage = get().runUsage
      if (!usage) return
      const checked = get().rows.filter((r) => r.checked)

      // One item per (paper, reviewer) pair — batch apply writes every paper in
      // a single undo step, however many papers this run touched.
      const byPaper = new Map<string, { paperId: string; reviewer: string | null; suggestions: Suggestion[] }>()
      for (const row of checked) {
        const key = `${row.paperId}\u0000${row.reviewer ?? ''}`
        const entry = byPaper.get(key) ?? { paperId: row.paperId, reviewer: row.reviewer, suggestions: [] }
        entry.suggestions.push(row.suggestion)
        byPaper.set(key, entry)
      }
      const items = [...byPaper.values()].map((entry) => ({ ...entry, usage }))
      const result = useStore.getState().applyAiSuggestionsBatch(items)
      // Unchecked rows are never applied, so they count as skipped alongside
      // whatever the store itself refused (already-answered fields, dead paths).
      const uncheckedCount = get().rows.length - checked.length
      set((s) => {
        s.applied = { filled: result.filled, skipped: result.skipped + uncheckedCount, papers: result.papers }
        s.phase = 'applied'
      })
    },
  })),
)

// ---------------------------------------------------------------------------
// Per-paper run helpers — one call for prompt mode, one loop for agent mode.
// ---------------------------------------------------------------------------

async function runOnePaperPrompt(
  project: Project,
  paper: Paper,
  targets: FieldTarget[],
  config: LlmConfig,
  signal: AbortSignal,
  setPhase: (p: AiPhase) => void,
): Promise<{ answer: LlmAnswer; usage: { inputTokens: number; outputTokens: number } }> {
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
  const system = buildSystemPrompt(project.schema, targets, delivery)
  const req =
    delivery === 'text'
      ? buildRequest(config, system, { kind: 'text', text: buildUserText(paper, paperText) })
      : buildRequest(config, `${system}\n\n${buildUserPdfCaption(paper)}`, {
          kind: 'pdf',
          base64: toBase64(bytes),
          filename: paper.pdf.split('/').pop() ?? 'paper.pdf',
        })

  setPhase('calling')
  const res = await getPlatform().callLlm(req, signal)
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
  return { answer, usage }
}

async function runOnePaperAgent(
  project: Project,
  paper: Paper,
  targets: FieldTarget[],
  config: LlmConfig,
  signal: AbortSignal,
  onEvent: (message: string) => void,
  setPhase: (p: AiPhase) => void,
): Promise<{ answer: LlmAnswer; usage: { inputTokens: number; outputTokens: number; calls: number } }> {
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
      schema: project.schema,
      targets,
      paper,
      paperText: extracted.text,
      delivery,
      pdfBase64: delivery === 'pdf' ? toBase64(bytes) : undefined,
      pdfFilename: delivery === 'pdf' ? (paper.pdf.split('/').pop() ?? 'paper.pdf') : undefined,
      signal,
      onEvent: (e) => onEvent(e.message),
    },
    {
      callLlm: (req, sig) => getPlatform().callLlm(req, sig),
      fetchWeb: (url, sig) => getPlatform().fetchWeb(url, sig),
    },
  )
  return { answer: result.answer, usage: result.usage }
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
