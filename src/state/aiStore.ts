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
 * State for the AI-assisted annotation flow.
 *
 * It is kept out of the main store for the same reason the project editor is:
 * this is a self-contained mode with its own lifecycle, and nothing in the
 * annotation path should have to know it exists. The one place the two meet is
 * `apply()`, which hands the reviewer-approved values to `applyAiSuggestions` —
 * the main store's single-undo-step batch write.
 */

const SELECTED_KEY = 'slr.llm.selected'

/**
 * The output-length budget for "Verify setup"'s one-word test request. Well
 * above what a trivial prompt should need even with reasoning overhead (a
 * reported real-world failure spent ~100 tokens reasoning before running out),
 * comfortably below `DEFAULT_MAX_TOKENS` (the real run's budget) since this is
 * only a connectivity smoke test. See the comment on `verifyConfig` below.
 */
const VERIFY_MAX_TOKENS = 2048

/**
 * How long a fetched model list is trusted before `fetchModels` goes back to
 * the provider on its own. A provider's catalog changes on the order of
 * weeks, not minutes, so this exists only to make reopening the settings
 * dialog instant, not to track new releases promptly — an explicit refresh
 * (`opts.force`) always bypasses it.
 */
const MODELS_TTL_MS = 60 * 60 * 1000

/** How many list-models pages `fetchModels` will walk before giving up. Every
 * provider's real catalog fits well within this; it exists only as a backstop
 * against a provider that never sets `nextCursor` to undefined. */
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
  /**
   * "Ask the API yourself which models are available": saves `config` (like
   * `verifyConfig`, a key has to be stored before anything can use it), then
   * walks every page of the provider's list-models endpoint. Cached per
   * config id for `MODELS_TTL_MS`; pass `force: true` to bypass that.
   */
  fetchModels: (config: LlmConfig, apiKey?: string, opts?: { force?: boolean }) => Promise<void>
  /**
   * Drop a target's cached model list. A target's id is stable across edits
   * to its provider or base URL, but the list a previous fetch found is not —
   * it belongs to whichever endpoint was configured *then*.
   */
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
      // The AI button is already disabled unless this holds; re-checking here
      // is a second line of defense, not the primary gate — see `aiUnlocked` in
      // store.ts and the hidden gesture in Toolbar.tsx.
      if (!app.aiUnlocked || !app.project.aiEnabled) return
      // Multi-reviewer, nobody picked yet: there is no active tree to propose
      // values into (the button is disabled in this state too, see AnnotationPanel).
      if (app.project.reviewers > 1 && app.currentReviewer === null) return
      // Whichever reviewer is active is who the AI proposes values *for* —
      // their own empty fields, not the consolidated result's, unless they
      // are Consolidation (see `currentTree`).
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
     * Send the smallest request that still reliably gets an answer, so the user
     * finds out the key, model name or URL is wrong *here* rather than after
     * waiting on a full paper. Returns the model's reply; throws with the
     * provider's own message.
     *
     * "Smallest" is not `max_tokens: 1` or similar: on a reasoning-capable model
     * the budget covers hidden reasoning tokens too, and a very tight cap can be
     * spent entirely on reasoning before the model ever writes "OK" — the model
     * comes back with no usable text and a truncation flag, not an error. See
     * `DEFAULT_MAX_TOKENS` in providers.ts. `VERIFY_MAX_TOKENS` only needs to
     * clear that bar, not match the real run's budget, so it stays well below it.
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
        // Same requirement as verifyConfig: the key has to be stored before
        // the platform will use it for anything.
        await get().saveConfig(config, apiKey)
        const saved = get().configs.find((c) => c.id === id) ?? config

        const models: ModelInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < MAX_MODEL_PAGES; page++) {
          const req = buildModelsRequest(saved, cursor)
          // Null means the provider handed back a pagination cursor pointing
          // off its own origin; keep the pages already fetched rather than
          // follow it with the API key attached.
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

      controller = new AbortController()
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

        // The paper's bytes come from the same URL the viewer renders, so this
        // works unchanged in both runtimes (slr-file:// in Electron, blob:/http
        // in the browser).
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

        // The system prompt differs by delivery: with extracted text the model must
        // be warned the extraction is lossy, or it will confidently reconstruct a
        // mangled table.
        const system = buildSystemPrompt(app.project.schema, get().targets, delivery)
        const req =
          delivery === 'text'
            ? buildRequest(config, system, { kind: 'text', text: buildUserText(paper, paperText) })
            : buildRequest(config, `${system}\n\n${buildUserPdfCaption(paper)}`, {
                kind: 'pdf',
                base64: toBase64(bytes),
                filename: paper.pdf.split('/').pop() ?? 'paper.pdf',
              })

        set((s) => { s.phase = 'calling' })
        const res = await getPlatform().callLlm(req, controller.signal)
        if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))

        set((s) => { s.phase = 'parsing' })
        const json = safeJson(res.body)
        const text = extractText(config.provider, json)
        // A truncated, empty answer would otherwise read as "the model proposed
        // nothing" (a legitimate outcome parseAnswer also produces) rather than
        // "the model ran out of budget before answering" — a very different
        // problem with a very different fix. See DEFAULT_MAX_TOKENS in providers.ts.
        if (!text.trim() && wasTruncated(config.provider, json)) {
          throw new Error(
            `${PROVIDERS[config.provider].label} used its whole reply budget on internal ` +
              'reasoning and never got to an answer for this paper. If this keeps happening, try ' +
              'a lower reasoning-effort setting for this model, if the provider offers one.',
          )
        }
        const answer = parseAnswer(app.project.schema, text)

        stopTicker()
        set((s) => {
          s.answer = answer
          // Everything is pre-ticked: the reviewer's job is to *remove* what is
          // wrong, which is the direction that makes a careless click safe-ish —
          // and nothing is written until they press Apply.
          s.rows = answer.fields.map((suggestion) => ({ suggestion, checked: true }))
          s.phase = 'review'
        })
      } catch (err) {
        stopTicker()
        const aborted = controller?.signal.aborted
        set((s) => {
          s.phase = aborted ? 'setup' : 'error'
          s.error = aborted ? null : err instanceof Error ? err.message : String(err)
        })
      } finally {
        controller = null
      }
    },

    cancel: () => {
      controller?.abort()
      controller = null
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
      const config = get().configs.find((c) => c.id === get().selectedId)
      // The dialog cannot reach the review screen without a config that was
      // valid at `run()` time; this is a defensive fallback, not an expected path.
      const usage = { provider: config?.provider ?? 'unknown', model: config?.model ?? 'unknown' }
      const result = useStore.getState().applyAiSuggestions(chosen, usage)
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
