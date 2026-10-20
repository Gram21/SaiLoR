import type { LocalServerInfo, OllamaModel, OllamaRunning, PullProgress } from '../llm/ollama'

/** Added to results that name a server URL. */
export interface OllamaTarget {
  /** True for loopback/private hosts; false means papers would leave the local network. */
  isLocal: boolean
}

export interface OllamaShowInfo {
  capabilities: string[]
  /** The model's own maximum context, tokens. */
  contextTokens: number | null
  thinking: { values: string[]; default?: string } | null
  /** KV-cache bytes at the requested `numCtx`, or null when unknown. */
  kvBytes: number | null
}

export type OllamaResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Desktop-only control of a user-run Ollama server. Every call takes the server's base URL. */
export interface OllamaApi {
  version(baseUrl: string): Promise<OllamaResult<{ version: string } & OllamaTarget>>
  list(baseUrl: string): Promise<OllamaResult<{ models: OllamaModel[] } & OllamaTarget>>
  show(baseUrl: string, model: string, numCtx?: number): Promise<OllamaResult<{ info: OllamaShowInfo }>>
  ps(baseUrl: string): Promise<OllamaResult<{ running: OllamaRunning[] }>>
  /**
   * Streams progress to `onProgress`; resolves when the pull ends. Aborting
   * `signal` closes the connection, but the server may keep downloading —
   * pulling the same tag again resumes.
   */
  pull(baseUrl: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<OllamaResult<object>>
  delete(baseUrl: string, model: string): Promise<OllamaResult<object>>
  /** Download size from the public registry manifest; `bytes` null if the registry has no such tag. */
  manifestSize(model: string): Promise<OllamaResult<{ bytes: number | null }>>
}

export type LocalServerResult = OllamaResult<LocalServerInfo & OllamaTarget>
