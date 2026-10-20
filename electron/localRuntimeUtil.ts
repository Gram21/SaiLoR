// Pure helpers for the managed local runtime (asset choice, hashes, resume math,
// server flags, log parsing). No I/O here so every rule is unit-testable.

import type { Backend } from '../src/platform/localRuntime'

/** llama.cpp commit that added `POST /v1/systemone` (PR #29818). A release includes the route iff it contains this commit. */
export const SYSTEMONE_COMMIT = 'a4cb4c61fd9d9c2066c7c1747821d3d65b8943bd'

export interface GhAsset {
  name: string
  size: number
  digest?: string | null
  browser_download_url: string
}

/** Release tags are `b<build number>`; anything else must never reach a path or URL. */
export const isReleaseTag = (t: unknown): t is string => typeof t === 'string' && /^b\d{1,7}$/.test(t)

/** GitHub's `digest` field is `sha256:<hex>`; anything else is treated as missing. */
export function parseDigest(d: unknown): string | undefined {
  const m = typeof d === 'string' ? d.match(/^sha256:([0-9a-f]{64})$/i) : null
  return m ? m[1].toLowerCase() : undefined
}

/** The `lfs.oid` of a Hugging Face tree entry is the file's SHA-256. */
export function parseHfFile(
  tree: unknown,
  file: string,
): { size: number; sha256: string } | undefined {
  if (!Array.isArray(tree)) return undefined
  const e = tree.find((x) => x && x.type === 'file' && x.path === file)
  const sha = e?.lfs?.oid
  const size = e?.lfs?.size ?? e?.size
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha) || !Number.isFinite(size)) return undefined
  return { size, sha256: sha.toLowerCase() }
}

/**
 * Pick the release asset for this machine. Windows prefers Vulkan over CUDA
 * (CUDA builds need a separate cudart bundle). Falls back to the CPU build.
 */
export function selectAsset(
  assets: GhAsset[],
  tag: string,
  platform: string,
  arch: string,
  backend: Backend,
): { asset: GhAsset; backend: Backend } | undefined {
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (!a) return undefined
  // [asset key, backend label] in order of preference
  let keys: [string, Backend][]
  if (platform === 'darwin') keys = [[`macos-${a}.tar.gz`, 'metal']]
  else if (platform === 'win32') {
    keys = [
      ...(backend === 'vulkan' || backend === 'cuda' ? ([[`win-vulkan-${a}.zip`, 'vulkan']] as [string, Backend][]) : []),
      [`win-cpu-${a}.zip`, 'cpu'],
    ]
  } else if (platform === 'linux') {
    keys = [
      ...(backend === 'vulkan' || backend === 'cuda' ? ([[`ubuntu-vulkan-${a}.tar.gz`, 'vulkan']] as [string, Backend][]) : []),
      [`ubuntu-${a}.tar.gz`, 'cpu'],
    ]
  } else return undefined
  for (const [key, b] of keys) {
    const asset = assets.find((x) => x.name === `llama-${tag}-bin-${key}`)
    if (asset) return { asset, backend: b }
  }
  return undefined
}

/** Where a download restarts, given the bytes already on disk. `0` = start over. */
export function resumeOffset(partialBytes: number, totalBytes: number): number {
  return partialBytes > 0 && partialBytes <= totalBytes ? partialBytes : 0
}

/** True if a `Content-Range` header confirms the response begins at `start`. */
export function contentRangeStartsAt(header: string | null, start: number): boolean {
  const m = header?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/)
  return Boolean(m) && Number(m![1]) === start
}

export type HostKind = 'github' | 'huggingface'

/** Every hop of a download (first request and each redirect) must pass this. https only. */
export function allowedDownloadUrl(kind: HostKind, raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const h = u.hostname.toLowerCase()
  const under = (d: string) => h === d || h.endsWith('.' + d)
  return kind === 'github'
    ? h === 'github.com' || h === 'api.github.com' || under('githubusercontent.com')
    : under('huggingface.co') || under('hf.co')
}

/** `llama-server --version` prints e.g. `version: 0.5.0-dev (build 11349, commit fb4b2737a)`. */
export function parseVersion(out: string): string | undefined {
  const m = out.match(/\(build (\d+)/)
  if (m && m[1] !== '0') return `b${m[1]}`
  return out.match(/version:\s*(\S+)/)?.[1]
}

export interface ServerFlags {
  modelPath: string
  port: number
  contextTokens: number
  gpu: boolean
  apiKey: string
}

/**
 * `llama-server` arguments for a decision model. Batch sizes equal the context:
 * a request's prompt must fit one micro-batch, else the server answers 500
 * ("input is too large to process"). One slot — we send one request at a time.
 * `-lv 4` makes it log the offload summary that `parseServerLog` reads.
 */
export function buildServerArgs(f: ServerFlags): string[] {
  const c = String(f.contextTokens)
  return [
    '-m', f.modelPath,
    '--host', '127.0.0.1',
    '--port', String(f.port),
    '-c', c, '-b', c, '-ub', c,
    '-np', '1',
    ...(f.gpu ? ['-ngl', '99'] : ['-dev', 'none', '-ngl', '0']),
    '--no-webui',
    '--api-key', f.apiKey,
    '-lv', '4',
  ]
}

export interface LogBackend {
  backend: Backend
  usingGpu: boolean
  layersOffloaded?: number
}

/** The real backend, read from the startup log — never from what we asked for. */
export function parseServerLog(lines: string[]): LogBackend {
  const text = lines.join('\n')
  const off = text.match(/offloaded (\d+)\/(\d+) layers to GPU/)
  const layersOffloaded = off ? Number(off[1]) : undefined
  const dev = text.match(/using device (MTL|CUDA|Vulkan|ROCm|HIP|SYCL|OpenCL)\d*/i)?.[1]?.toLowerCase()
  const backend: Backend | undefined =
    dev === 'mtl' ? 'metal' : dev === 'cuda' ? 'cuda' : dev === 'vulkan' ? 'vulkan' : undefined
  // "using device X" is logged even with 0 layers offloaded, so the layer count decides.
  if (!backend || !layersOffloaded) return { backend: 'cpu', usingGpu: false, layersOffloaded }
  return { backend, usingGpu: true, layersOffloaded }
}

/** Turn a failed start's log into a sentence the user can act on. */
export function explainStartFailure(lines: string[]): string | undefined {
  const text = lines.join('\n')
  if (/unknown model architecture|wrong shape/.test(text)) {
    return 'This llama.cpp build cannot load the model (too old, or an incompatible conversion). Update the runtime.'
  }
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory/i.test(text)) return 'Not enough memory to load the model.'
  return undefined
}

export class RingLog {
  private lines: string[] = []
  private partial = ''
  constructor(private max = 200) {}
  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    for (const l of parts) if (l) this.lines.push(l)
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max)
  }
  all(): string[] {
    return this.partial ? [...this.lines, this.partial] : [...this.lines]
  }
}
