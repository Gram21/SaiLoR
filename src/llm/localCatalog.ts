/**
 * Models the app can download and run itself. Shared by the main process
 * (which resolves a catalog id to a download URL and a file) and the renderer
 * (which lists them). Only these ids are ever downloaded: the renderer names an
 * id, never a URL.
 */

export interface LocalModelEntry {
  id: string
  label: string
  kind: 'systemone' | 'chat'
  hfRepo: string
  hfFile: string
  /** Pinned Hugging Face revision; absent means `main`. */
  revision?: string
  approxBytes: number
  /** Context window the server is started with. */
  contextTokens: number
  /** Tokens of that window the model's questions + answer options may use. */
  optionsBudgetTokens?: number
  /** Most questions per request the model accepts. */
  maxQuestions?: number
  license: string
  minRamBytes: number
  note: string
  status: 'available' | 'planned'
  plannedReason?: string
}

const MB = 1024 * 1024

const COMMUNITY_REASON =
  "Community GGUF uses the 'ggmlc' architecture, which llama.cpp cannot load (tested on master 4ebdf2c); needs a ggml-org conversion."

// ponytail: Clef needs a llama.cpp build with its decision head; flip to
// 'available' once llama.cpp serves it on /v1/systemone.
const CLEF_REASON = 'Needs a llama.cpp build with Clef support (not merged yet).'

export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = [
  {
    id: 'laya-en-q8',
    label: 'Laya (English, Q8_0)',
    kind: 'systemone',
    hfRepo: 'ggml-org/Laya-GGUF',
    hfFile: 'Laya-Q8_0.gguf',
    approxBytes: 449_397_600,
    // Verified on llama.cpp master: the GGUF carries decision.max_head_tokens = 192 (questions + options are
    // truncated to that) and n_ctx_train = 8192. The state is NOT truncated by the server; a prompt longer
    // than the micro-batch is a 500, so the server is started with -c = -b = -ub = contextTokens. 2048 keeps
    // memory tiny; quality beyond the ~512 tokens the model was tuned on is unmeasured, so budget the state conservatively.
    contextTokens: 2048,
    optionsBudgetTokens: 192,
    license: 'Apache-2.0',
    minRamBytes: 1024 * MB,
    note: 'Small English decision model (about 450 MB). Runs on the CPU or GPU; needs a llama.cpp build with the /v1/systemone route. At most 255 options per choice question.',
    status: 'available',
  },
  {
    id: 'laya-multilingual-q8',
    label: 'Laya multilingual (Q8_0)',
    kind: 'systemone',
    hfRepo: 'mys/laya-multilingual-GGUF',
    hfFile: 'laya_multilingual_q8_0.gguf',
    approxBytes: 361_712_736,
    contextTokens: 2048,
    optionsBudgetTokens: 192,
    license: 'Apache-2.0',
    minRamBytes: 1024 * MB,
    note: 'Community conversion (mys), not by the model authors.',
    status: 'planned',
    plannedReason: COMMUNITY_REASON,
  },
  {
    id: 'laya-typed-decisions-q8',
    label: 'Laya typed decisions (Q8_0)',
    kind: 'systemone',
    hfRepo: 'mys/laya-typed-decisions-GGUF',
    hfFile: 'laya_typed_decisions_q8_0.gguf',
    approxBytes: 455_179_648,
    contextTokens: 2048,
    optionsBudgetTokens: 192,
    license: 'Apache-2.0',
    minRamBytes: 1024 * MB,
    note: 'Community conversion (mys), not by the model authors.',
    status: 'planned',
    plannedReason: COMMUNITY_REASON,
  },
  {
    id: 'clef-flash',
    label: 'Clef Flash',
    kind: 'systemone',
    hfRepo: 'bartowski/Cloudflare_clef-flash-GGUF',
    hfFile: '',
    approxBytes: 0,
    contextTokens: 0,
    license: 'Apache-2.0',
    minRamBytes: 0,
    note: 'Cloudflare Clef Flash decision model.',
    status: 'planned',
    plannedReason: CLEF_REASON,
  },
  {
    id: 'clef',
    label: 'Clef',
    kind: 'systemone',
    hfRepo: 'bartowski/Cloudflare_clef-GGUF',
    hfFile: '',
    approxBytes: 0,
    contextTokens: 0,
    license: 'Apache-2.0',
    minRamBytes: 0,
    note: 'Cloudflare Clef decision model.',
    status: 'planned',
    plannedReason: CLEF_REASON,
  },
]

export const LICENSE_NOTE = (e: LocalModelEntry) =>
  `${e.label} is licensed under ${e.license}; it is downloaded from huggingface.co/${e.hfRepo}.`

export const RUNTIME_LICENSE_NOTE =
  'llama.cpp (llama-server) is MIT-licensed, downloaded from github.com/ggml-org/llama.cpp.'

export function findCatalogEntry(id: unknown): LocalModelEntry | undefined {
  return typeof id === 'string' ? LOCAL_MODEL_CATALOG.find((e) => e.id === id) : undefined
}

/** The entry for `id` if it can be downloaded and run; throws otherwise. */
export function requireAvailableEntry(id: unknown): LocalModelEntry {
  const e = findCatalogEntry(id)
  if (!e) throw new Error('Unknown local model.')
  if (e.status !== 'available') throw new Error(e.plannedReason ?? 'This model is not available yet.')
  return e
}
