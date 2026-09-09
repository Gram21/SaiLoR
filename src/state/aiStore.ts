import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getPlatform } from '../platform'
import { useStore, currentTree, type AiApplyResult } from './store'
import { unansweredFields, type FieldTarget } from '../llm/fields'
import { buildSystemPrompt, buildUserText, buildUserPdfCaption } from '../llm/prompt'
import { buildRequest, extractText, extractError, wasTruncated, PROVIDERS } from '../llm/providers'
import { buildModelsRequest, parseModelsResponse } from '../llm/models'
import { parseAnswer } from '../llm/parse'
import type { LlmAnswer, LlmConfig, ModelInfo, Suggestion } from '../llm/types'
import { extractPdfText } from '../model/pdfText'

/**
 * State for the AI-assisted annotation flow, kept out of the main store as
 * its own self-contained mode. `apply()` is the one bridge: it hands
 * reviewer-approved values to `applyAiSuggestions`, the main store's
 * single-undo-step batch write.
 */

const SELECTED_KEY = 'slr.llm.selected'

/** Output budget for the "Verify setup" smoke test — high enough to survive
 * reasoning-model overhead, still well below `DEFAULT_MAX_TOKENS`. */
const VERIFY_MAX_TOKENS = 2048

/** How long a fetched model list is trusted before `fetchModels` refetches.
 * Just to make reopening settings instant, not to catch new releases quickly
 * — `opts.force` bypasses it. */
const MODELS_TTL_MS = 60 * 60 * 1000

/** Backstop page limit for `fetchModels`, in case a provider never clears `nextCursor`. */
const MAX_MODEL_PAGES = 10

export type AiPhase =
  | 'setup' // choosing a target, nothing sent yet
  | 'reading' // extracting the PDF's text
  | 'calling' // waiting for the model
  | 'parsing'
  | 'review' // suggestions on screen, awaiting the reviewer
  | 'applied'
  | 'error'

/** A suggestion plus the reviewer's decision about it. */
export interface ReviewRow {
  suggestion: Suggestion
  checked: boolean
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

  phase: AiPhase
  /**
   * What the in-flight (or just-finished) run was *for*. Recorded at run
   * start because the paper/reviewer/target pickers stay usable while a run
   * is in flight — applying must read this, not "whatever is selected now".
   */
  runFor: { paperId: string; reviewer: string | null; provider: string; model: string } | null
  error: string | null
  /** Seconds the current call has been running, for the progress line. */
  elapsed: number

  /** The fields the AI is being asked about — computed when the dialog opens. */
  targets: FieldTarget[]
  answer: LlmAnswer | null
  rows: ReviewRow[]
  applied: AiApplyResult | null
  /** True when the PDF yielded no usable text (a scanned paper). */
  scanned: boolean

  openDialog: () => Promise<void>
  closeDialog: () => void
  setSettingsOpen: (open: boolean) => void
  selectConfig: (id: string) => void

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
    phase: 'setup',
    runFor: null,
    error: null,
    elapsed: 0,
    targets: [],
    answer: null,
    rows: [],
    applied: null,
    scanned: false,

    openDialog: async () => {
      const app = useStore.getState()
      const paper = app.project?.papers.find((p) => p.id === app.currentPaperId)
      if (!app.project || !paper) return
      // Second line of defense; the AI button is already disabled unless this holds (see `aiUnlocked` in store.ts).
      if (!app.aiUnlocked || !app.project.aiEnabled) return
      // Multi-reviewer with nobody picked: no active tree to propose values into.
      if (app.project.reviewers > 1 && app.currentReviewer === null) return
      const tree = currentTree(app.project, app.currentReviewer, paper)
      if (!tree) return

      set((s) => {
        s.open = true
        s.phase = 'setup'
        s.error = null
        s.answer = null
        s.rows = []
        s.applied = null
        s.scanned = false
        s.elapsed = 0
        s.targets = unansweredFields(app.project!.schema, tree)
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
      const paper = app.project?.papers.find((p) => p.id === app.currentPaperId)
      const config = get().configs.find((c) => c.id === get().selectedId)
      if (!app.project || !paper || !config) return
      if (!config.hasKey) {
        set((s) => {
          s.phase = 'error'
          s.error = 'This target has no API key. Add one in the settings (gear icon).'
        })
        return
      }

      set((s) => {
        s.runFor = {
          paperId: paper.id,
          reviewer: app.currentReviewer,
          provider: config.provider,
          model: config.model,
        }
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

      try {
        set((s) => {
          s.phase = 'reading'
          s.error = null
          s.elapsed = 0
        })

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
            // Nothing to send. Sending it anyway would invite the model to invent
            // a paper from its title alone.
            stopTicker()
            set((s) => {
              s.phase = 'error'
              s.scanned = true
              s.error =
                'No text could be extracted from this PDF — it looks like a scan of a printed ' +
                'paper. Switch this target to "Send the PDF itself" in the settings, if your ' +
                'provider supports it.'
            })
            return
          }
        } else if (!PROVIDERS[config.provider].supportsPdf) {
          delivery = 'text'
          paperText = (await extractPdfText(bytes)).text
        }

        // With extracted text the model must be warned extraction is lossy, or
        // it will confidently reconstruct a mangled table.
        const system = buildSystemPrompt(app.project.schema, get().targets, delivery)
        const req =
          delivery === 'text'
            ? buildRequest(config, system, { kind: 'text', text: buildUserText(paper, paperText) })
            : buildRequest(config, `${system}\n\n${buildUserPdfCaption(paper)}`, {
                kind: 'pdf',
                base64: toBase64(bytes),
                filename: paper.pdf.split('/').pop() ?? 'paper.pdf',
              })

        // A superseded run still completes (for clean discard) but must not move
        // `phase` backwards over the newer run's, nor touch its ticker.
        if (controller === myController) set((s) => { s.phase = 'calling' })
        const res = await getPlatform().callLlm(req, myController.signal)
        if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))

        if (controller === myController) set((s) => { s.phase = 'parsing' })
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
        const answer = parseAnswer(app.project.schema, text)

        if (controller === myController) stopTicker()
        // A superseded run must not publish: `runFor` already points at the
        // newer run, so these rows would apply to the wrong paper. Discard silently.
        if (controller !== myController) return
        set((s) => {
          s.answer = answer
          // Pre-ticked: reviewer removes what's wrong rather than adding what's
          // right, and nothing is written until Apply.
          s.rows = answer.fields.map((suggestion) => ({ suggestion, checked: true }))
          s.phase = 'review'
        })
      } catch (err) {
        stopTicker()
        const aborted = myController.signal.aborted
        // A superseded run must not narrate over the one that replaced it.
        if (controller !== myController && !aborted) {
          return
        }
        set((s) => {
          s.phase = aborted ? 'setup' : 'error'
          s.error = aborted ? null : err instanceof Error ? err.message : String(err)
        })
      } finally {
        if (controller === myController) controller = null
      }
    },

    cancel: () => {
      // Abort only — clearing the slot here would stop the run's own catch
      // from telling an abort from a failure. The run clears it itself.
      controller?.abort()
      stopTicker()
      set((s) => {
        if (s.phase === 'reading' || s.phase === 'calling' || s.phase === 'parsing') {
          s.phase = 'setup'
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
      const chosen = get().rows.filter((r) => r.checked).map((r) => r.suggestion)
      const runFor = get().runFor
      if (!runFor) return
      // Target that actually answered, not whichever is selected now — this
      // feeds `aiUsage`, the paper's disclosure of how it was annotated.
      const usage = { provider: runFor.provider, model: runFor.model }
      const result = useStore.getState().applyAiSuggestions(chosen, usage, {
        paperId: runFor.paperId,
        reviewer: runFor.reviewer,
      })
      set((s) => {
        s.applied = result
        s.phase = 'applied'
      })
    },
  })),
)

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
