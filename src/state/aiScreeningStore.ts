import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getPlatform } from '../platform'
import { useStore, currentTree } from './store'
import {
  useAiStore,
  describeFit,
  ensureLocalModel,
  fitForChat,
  startBlocker,
  LOCAL_TRUNCATED_MESSAGE,
} from './aiStore'
import { withRetry, runPool, type CallLlm } from '../llm/retry'
import { buildRequest, extractText, extractError, wasTruncated } from '../llm/providers'
import { parseChatResponse } from '../llm/chat'
import { costOf } from '../llm/cost'
import {
  MAX_SCREENING_TEXT_CHARS,
  buildScreeningSystemOneRequest,
  buildScreeningSystemPrompt,
  buildScreeningUserText,
  parseScreeningAnswer,
  parseScreeningSystemOne,
  type ScreeningOutcome,
  type ScreeningProposal,
  type ScreeningText,
} from '../llm/screeningAi'
import type { LlmConfig } from '../llm/types'
import { isUsable } from '../llm/types'
import { aiSeatId } from '../model/project'
import type { Paper, Project } from '../model/project'
import { extractPdfText } from '../model/pdfText'
import { DECISION_INCLUDE } from '../screening/schema'
import { screeningStatus } from '../screening/status'

/**
 * State for the AI-assisted screening flow: one Include/Exclude proposal per
 * paper, reviewed by a human before anything is written. Separate from the
 * annotation `aiStore` (which it borrows only the model library from).
 *
 * ponytail: no resume, spend cap, or agent mode as in annotation runs. Add them
 * when screening batches get large enough for a lost run to hurt.
 */

const SELECTED_KEY = 'slr.llm.screening.selected'
const ENGINE_KEY = 'slr.llm.screening.engine'
const CONCURRENCY_KEY = 'slr.llm.screening.concurrency'
const THRESHOLD_KEY = 'slr.llm.screening.threshold'
const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 4
const DEFAULT_THRESHOLD = 0.8
/** A PDF-only paper is judged from its first pages, not the whole text. */
const EXCERPT_PAGES = 3

export type ScreeningEngine = 'prompt' | 'classify'
export type ScreeningPhase = 'setup' | 'running' | 'review' | 'applied'

export interface ScreeningRow {
  paperId: string
  paperTitle: string
  /** The seat this proposal is for, fixed when the run started. */
  reviewer: string | null
  proposal: ScreeningProposal
  engine: ScreeningEngine
  checked: boolean
  /** Position in the run's paper list, so the review keeps project order. */
  order: number
}

export interface ScreeningNote {
  paperId: string
  paperTitle: string
  message: string
}

interface ScreeningAiState {
  open: boolean
  phase: ScreeningPhase
  engine: ScreeningEngine
  selectedId: string | null
  allPapers: boolean
  /** The seat proposals are written into: the AI seat if any, else the human's. */
  targetSeat: string | null
  /** Every paper still undecided in `targetSeat` and titled. */
  candidates: { id: string; title: string }[]
  currentUndecided: boolean
  concurrency: number
  threshold: number
  rows: ScreeningRow[]
  errors: ScreeningNote[]
  skipped: ScreeningNote[]
  /** Per-paper remarks that are neither failures nor skips (trimmed text, a dropped reason question). */
  infos: ScreeningNote[]
  /** Set while an app-managed local model is starting. */
  startNotice: string | null
  done: number
  total: number
  usage: { calls: number; inputTokens: number; outputTokens: number }
  retryNotice: string | null
  /** Provider/model of the run, for the disclosure record. */
  runModel: { provider: string; model: string } | null
  cost: number | null
  applied: { written: number; skipped: number } | null

  openDialog: () => Promise<void>
  closeDialog: () => void
  setEngine: (engine: ScreeningEngine) => void
  selectConfig: (id: string) => void
  setAllPapers: (on: boolean) => void
  setConcurrency: (n: number) => void
  setThreshold: (n: number) => void
  run: () => Promise<void>
  cancel: () => void
  toggleRow: (paperId: string) => void
  setAllChecked: (checked: boolean) => void
  apply: () => void
}

/** Papers with a title and no decision in `seat` yet. */
export function screeningCandidates(project: Project, seat: string | null): { id: string; title: string }[] {
  return project.papers
    .filter((p) => p.title.trim() !== '' && screeningStatus(currentTree(project, seat, p)) === 'undecided')
    .map((p) => ({ id: p.id, title: p.title }))
}

/**
 * Conservative pre-ticking (REQ-LLM-640): a wrongly excluded paper is silently
 * lost from the review, so Exclude never starts ticked and Include only when
 * the engine was confident enough.
 */
export function defaultChecked(p: ScreeningProposal, threshold: number): boolean {
  return p.decision === DECISION_INCLUDE && p.confidence !== null && p.confidence >= threshold
}

/** System One models serve Classify only, chat models Prompt only. */
export function modelsFor(configs: LlmConfig[], engine: ScreeningEngine): LlmConfig[] {
  return configs.filter((c) => (c.provider === 'systemone') === (engine === 'classify'))
}

/** The model in play: the remembered pick if it fits the engine, else the first that does. */
export function effectiveConfig(configs: LlmConfig[], engine: ScreeningEngine, selectedId: string | null): LlmConfig | null {
  const pool = modelsFor(configs, engine)
  return pool.find((c) => c.id === selectedId) ?? pool[0] ?? null
}

let abortCtrl: AbortController | null = null
/** Bumped when the dialog closes; a run whose token no longer matches is discarded. */
let runToken = 0

export const useAiScreeningStore = create<ScreeningAiState>()(
  immer((set, get) => ({
    open: false,
    phase: 'setup',
    engine: readEngine(),
    selectedId: readStr(SELECTED_KEY) ?? useAiStore.getState().selectedId,
    allPapers: false,
    targetSeat: null,
    candidates: [],
    currentUndecided: false,
    concurrency: readNum(CONCURRENCY_KEY, DEFAULT_CONCURRENCY, (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY),
    threshold: readNum(THRESHOLD_KEY, DEFAULT_THRESHOLD, (n) => n >= 0 && n <= 1),
    rows: [],
    errors: [],
    skipped: [],
    infos: [],
    startNotice: null,
    done: 0,
    total: 0,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    retryNotice: null,
    runModel: null,
    cost: null,
    applied: null,

    openDialog: async () => {
      const app = useStore.getState()
      const project = app.project
      if (!project?.screening) return
      const seat = aiSeatId(project) ?? app.currentReviewer
      // Nobody picked, or Consolidation without an AI seat: nothing to write into.
      if (project.reviewers > 1 && (seat === null || seat === 'consolidation')) return
      const current = project.papers.find((p) => p.id === app.currentPaperId)
      const candidates = screeningCandidates(project, seat)
      set((s) => {
        s.open = true
        s.phase = 'setup'
        s.allPapers = false
        s.targetSeat = seat
        s.candidates = candidates
        s.currentUndecided = !!current && candidates.some((c) => c.id === current.id)
        s.rows = []
        s.errors = []
        s.skipped = []
        s.infos = []
        s.applied = null
        s.done = 0
        s.total = 0
        s.usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
        s.retryNotice = null
        s.startNotice = null
        s.runModel = null
        s.cost = null
      })
      await useAiStore.getState().refreshConfigs()
    },

    closeDialog: () => {
      runToken++
      abortCtrl?.abort()
      abortCtrl = null
      set((s) => {
        s.open = false
        s.phase = 'setup'
        s.rows = []
      })
    },

    setEngine: (engine) => {
      writeStr(ENGINE_KEY, engine)
      set((s) => {
        s.engine = engine
      })
    },

    selectConfig: (id) => {
      writeStr(SELECTED_KEY, id)
      set((s) => {
        s.selectedId = id
      })
    },

    setAllPapers: (on) => set((s) => { s.allPapers = on }),

    setConcurrency: (n) => {
      writeStr(CONCURRENCY_KEY, String(n))
      set((s) => { s.concurrency = n })
    },

    setThreshold: (n) => {
      writeStr(THRESHOLD_KEY, String(n))
      set((s) => { s.threshold = n })
    },

    run: async () => {
      const app = useStore.getState()
      const project = app.project
      const st = get()
      if (!project?.screening || st.phase !== 'setup') return
      const config = effectiveConfig(useAiStore.getState().configs, st.engine, st.selectedId)
      if (!config || !isUsable(config) || startBlocker('prompt', config)) return
      const wanted = st.allPapers
        ? new Set(st.candidates.map((c) => c.id))
        : new Set(st.currentUndecided && app.currentPaperId ? [app.currentPaperId] : [])
      const papers = project.papers.filter((p) => wanted.has(p.id))
      if (papers.length === 0) return

      const { reasons } = project.screening
      const protocol = project.protocol
      const seat = st.targetSeat
      const engine = st.engine
      const threshold = st.threshold
      const generation = app.projectGeneration
      const token = ++runToken
      const ctrl = new AbortController()
      abortCtrl = ctrl
      // A run is void once the dialog closed or the project was replaced.
      const stale = () => token !== runToken || useStore.getState().projectGeneration !== generation
      const callLlm: CallLlm = withRetry(getPlatform().callLlm, {
        onRetry: (info) =>
          set((s) => {
            s.retryNotice = `Rate-limited, retrying in ${Math.ceil(info.delayMs / 1000)}s…`
          }),
      })
      const note = (p: Paper, message: string): ScreeningNote => ({ paperId: p.id, paperTitle: p.title, message })

      set((s) => {
        s.phase = 'running'
        s.rows = []
        s.errors = []
        s.skipped = []
        s.infos = []
        s.done = 0
        s.total = papers.length
        s.usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
        s.retryNotice = null
        s.runModel = { provider: config.provider, model: config.model }
        s.cost = null
        s.applied = null
      })

      await runPool(
        papers,
        st.concurrency,
        async (paper, order) => {
          try {
            const text = await screeningText(paper)
            if (stale() || ctrl.signal.aborted) return
            if (!text) {
              set((s) => { s.skipped.push(note(paper, 'no abstract')) })
              return
            }
            const onStarting = () => set((s) => { s.startNotice = 'Starting local model…' })
            const { outcome, usage, notes } =
              engine === 'classify'
                ? await classifyOne(config, paper, text, reasons, protocol, callLlm, ctrl.signal, onStarting)
                : await promptOne(config, paper, text, reasons, protocol, callLlm, ctrl.signal, onStarting)
            if (stale() || ctrl.signal.aborted) return
            set((s) => {
              s.startNotice = null
              for (const message of notes) s.infos.push(note(paper, message))
              s.usage.calls++
              s.usage.inputTokens += usage.inputTokens
              s.usage.outputTokens += usage.outputTokens
              if (!outcome.ok) s.errors.push(note(paper, `Proposal rejected: ${outcome.reason}`))
              else {
                s.rows.push({
                  paperId: paper.id,
                  paperTitle: paper.title,
                  reviewer: seat,
                  proposal: outcome.proposal,
                  engine,
                  checked: defaultChecked(outcome.proposal, threshold),
                  order,
                })
              }
            })
          } catch (e) {
            if (stale() || ctrl.signal.aborted) return
            set((s) => {
              s.startNotice = null
              s.errors.push(note(paper, e instanceof Error ? e.message : String(e)))
            })
          } finally {
            if (!stale()) set((s) => { s.done++ })
          }
        },
        ctrl.signal,
      )
      if (stale()) return
      set((s) => {
        s.rows.sort((a, b) => a.order - b.order)
        s.cost = costOf(s.usage, config)
        s.retryNotice = null
        s.startNotice = null
        s.phase = 'review'
      })
    },

    // Finished rows are kept: the run loop above finishes into the review step.
    cancel: () => abortCtrl?.abort(),

    toggleRow: (paperId) =>
      set((s) => {
        const r = s.rows.find((x) => x.paperId === paperId)
        if (r) r.checked = !r.checked
      }),

    setAllChecked: (checked) =>
      set((s) => {
        for (const r of s.rows) r.checked = checked
      }),

    apply: () => {
      const { rows, runModel } = get()
      if (!runModel || get().phase !== 'review') return
      const applied = useStore.getState().applyAiScreeningBatch(
        rows
          .filter((r) => r.checked)
          .map((r) => ({
            paperId: r.paperId,
            reviewer: r.reviewer,
            decision: r.proposal.decision,
            reason: r.proposal.reason,
            usage: { provider: runModel.provider, model: runModel.model, mode: 'screening' as const },
          })),
      )
      set((s) => {
        s.applied = applied
        s.phase = 'applied'
      })
    },
  })),
)

/** The abstract, else the first pages of the PDF; null when neither yields text. */
async function screeningText(paper: Paper): Promise<ScreeningText | null> {
  if (paper.abstract?.trim()) return { kind: 'abstract', text: paper.abstract.trim() }
  if (!paper.pdf) return null
  const src = await getPlatform().getPdfSource(paper.pdf, useStore.getState().saveHandle ?? { kind: 'download' })
  let bytes: ArrayBuffer
  try {
    bytes = await (await fetch(src.url)).arrayBuffer()
  } finally {
    src.revoke?.()
  }
  const extracted = await extractPdfText(bytes, { maxPages: EXCERPT_PAGES })
  if (extracted.empty) return null
  return { kind: 'excerpt', text: extracted.text.slice(0, MAX_SCREENING_TEXT_CHARS) }
}

type Answer = { outcome: ScreeningOutcome; usage: { inputTokens: number; outputTokens: number }; notes: string[] }

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

async function promptOne(
  config: LlmConfig,
  paper: Paper,
  text: ScreeningText,
  reasons: string[],
  protocol: Project['protocol'],
  callLlm: CallLlm,
  signal: AbortSignal,
  onStarting: () => void,
): Promise<Answer> {
  const system = buildScreeningSystemPrompt(reasons, protocol)
  const fitted = fitForChat(config, system + buildScreeningUserText(paper, { ...text, text: '' }), text.text)
  await ensureLocalModel(config, onStarting)
  const req = buildRequest(config, system, {
    kind: 'text',
    text: buildScreeningUserText(paper, { ...text, text: fitted.text }),
  })
  const res = await callLlm(req, signal)
  if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
  const json = safeJson(res.body)
  const reply = extractText(config.provider, json)
  if (!reply.trim()) {
    throw new Error(wasTruncated(config.provider, json) ? 'The model ran out of reply budget before answering.' : 'The model sent an empty reply.')
  }
  const parsed = parseChatResponse(config.provider, json, req)
  // Never use an answer given to a prompt the server cut the front off.
  if (parsed.inputTruncated) throw new Error(LOCAL_TRUNCATED_MESSAGE)
  return {
    outcome: parseScreeningAnswer(reply, reasons),
    usage: parsed.usage,
    notes: fitted.fit ? [describeFit(config.model, fitted.fit)] : [],
  }
}

async function classifyOne(
  config: LlmConfig,
  paper: Paper,
  text: ScreeningText,
  reasons: string[],
  protocol: Project['protocol'],
  callLlm: CallLlm,
  signal: AbortSignal,
  onStarting: () => void,
): Promise<Answer> {
  const { request, asked, notes } = buildScreeningSystemOneRequest(config, paper, text, reasons, protocol)
  await ensureLocalModel(config, onStarting)
  const res = await callLlm(request, signal)
  if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
  return { ...parseScreeningSystemOne(asked, safeJson(res.body)), notes: notes.map((n) => `left to you: ${n.replace(': ', ' — ')}`) }
}

function readStr(key: string): string | null {
  try {
    return localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStr(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value)
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

function readEngine(): ScreeningEngine {
  return readStr(ENGINE_KEY) === 'classify' ? 'classify' : 'prompt'
}

function readNum(key: string, fallback: number, valid: (n: number) => boolean): number {
  const raw = readStr(key)
  const n = raw === null ? NaN : Number(raw)
  return valid(n) ? n : fallback
}

// A run belongs to the project it started in: replacing or closing that
// project closes the dialog, so a run never writes into whatever opens next.
useStore.subscribe((s, prev) => {
  if (s.projectGeneration !== prev.projectGeneration && useAiScreeningStore.getState().open) {
    useAiScreeningStore.getState().closeDialog()
  }
})
