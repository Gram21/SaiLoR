/**
 * Renderer-facing types and API of the app-managed local runtime (llama.cpp's
 * `llama-server` + downloaded decision-model files). Desktop only — the adapter
 * exposes `null` in the browser build. The renderer only ever names a catalog
 * id; URLs, paths and executables are decided in the main process.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
export type Backend = 'metal' | 'cuda' | 'vulkan' | 'cpu'

export interface HardwareInfo {
  platform: string
  arch: string
  totalRamBytes: number
  freeRamBytes: number
  gpus: { vendor: GpuVendor; name: string; vramBytes?: number }[]
  /** -1 when it could not be determined. */
  diskFreeBytes: number
  recommendedBackend: Backend
}

export interface RuntimeStatus {
  found: boolean
  source: 'system' | 'managed' | 'none'
  path?: string
  version?: string
  /** `'unknown'` when the build was not asked; the route is feature-probed on start. */
  supportsSystemOne: boolean | 'unknown'
}

export interface RuntimePlan {
  tag: string
  assetName: string
  url: string
  sizeBytes: number
  sha256: string
  backend: Backend
  /** Whether this release contains llama.cpp's `/v1/systemone` route. The install is refused on `false`. */
  includesSystemOne: boolean | 'unknown'
  license: 'MIT'
  source: 'github.com/ggml-org/llama.cpp'
  destination: string
  diskFreeBytes: number
}

export interface ModelPlan {
  catalogId: string
  repo: string
  file: string
  url: string
  sizeBytes: number
  sha256: string
  license: string
  destination: string
  diskFreeBytes: number
  /** Bytes of a partial download already on disk. */
  resumeFrom: number
}

export interface InstalledModel {
  catalogId: string
  file: string
  sizeBytes: number
}

export interface LocalProgress {
  id: string
  kind: 'runtime' | 'model'
  completed: number
  total: number
  phase: 'download' | 'verify' | 'extract' | 'done'
}

export interface LocalServerInfo {
  catalogId: string
  baseUrl: string
  backend: Backend
  usingGpu: boolean
  layersOffloaded?: number
  /** Set when the GPU start failed and the server fell back to the CPU. */
  note?: string
}

export interface LocalServerStatus {
  catalogId: string
  state: 'starting' | 'running' | 'stopped'
  info?: LocalServerInfo
}

export interface LocalRuntimeApi {
  probe(): Promise<HardwareInfo>
  /** The runtime currently usable (system `llama-server` or managed copy). */
  runtime(): Promise<RuntimeStatus>
  runtimePlan(): Promise<RuntimePlan>
  /** Download + verify + extract the planned runtime. Call only after the user consented to the plan. */
  runtimeInstall(): Promise<RuntimeStatus>
  modelPlan(catalogId: string): Promise<ModelPlan>
  /** Download + verify the model file. Call only after the user consented to the plan. */
  modelInstall(catalogId: string): Promise<InstalledModel>
  /** Abort a running runtime/model download (`id` = `'runtime'` or the catalog id). */
  cancel(id: string): Promise<void>
  installed(): Promise<InstalledModel[]>
  remove(catalogId: string): Promise<InstalledModel[]>
  start(catalogId: string): Promise<LocalServerInfo>
  stop(catalogId: string): Promise<void>
  status(): Promise<LocalServerStatus[]>
  logs(catalogId: string): Promise<string[]>
  onProgress(cb: (p: LocalProgress) => void): () => void
}
