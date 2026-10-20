import type { Backend, HardwareInfo } from '../platform/localRuntime'
import { computeNumCtx } from './ollama'

/** Pure helpers behind the local-model setup panels. */

const GB = 1e9
const MB = 1e6

export function formatBytes(n: number): string {
  if (n < 0) return 'unknown'
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MB))} MB`
}

const BACKEND_NAME: Record<Backend, string> = { metal: 'Metal', cuda: 'CUDA', vulkan: 'Vulkan', cpu: 'CPU' }
export const backendName = (b: Backend): string => BACKEND_NAME[b]

export function hardwareSentence(hw: HardwareInfo): string {
  return hw.recommendedBackend === 'cpu'
    ? 'No supported GPU found — will run on CPU (fine for small models like Laya; slower).'
    : `Will run on GPU (${backendName(hw.recommendedBackend)}).`
}

/** Hostname of a URL, or the raw text when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Context to start from: 16k, 32k with 16 GB RAM or more, never above the
 * model's own limit. Long papers need it; the server default (often 4,096)
 * would silently cut them.
 */
export function suggestContext(totalRamBytes: number | undefined, modelMax?: number): number {
  const base = totalRamBytes !== undefined && totalRamBytes >= 16 * GB ? 32_768 : 16_384
  return computeNumCtx({ promptTokens: base, outputReserve: 0, modelMax })
}

/** Memory the model needs and whether it exceeds what the hardware offers (VRAM when known, else free RAM). */
export function memoryCheck(
  weightsBytes: number,
  kvBytes: number | null,
  hw: HardwareInfo | null,
): { needBytes: number; tooBig: boolean } {
  const needBytes = weightsBytes + (kvBytes ?? 0)
  if (!hw || needBytes <= 0) return { needBytes, tooBig: false }
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes ?? 0))
  return { needBytes, tooBig: needBytes > (vram > 0 ? vram : hw.freeRamBytes) }
}

export const isCloudflareAccountId = (s: string): boolean => /^[a-f0-9]{32}$/.test(s.trim())

/** Plain-words input limits of a System One model. */
export function windowSentence(contextTokens: number, optionsBudgetTokens?: number): string {
  const opts = optionsBudgetTokens
    ? `; up to ${optionsBudgetTokens} for questions and answer options — long questions are cut, so keep field names and options short`
    : ''
  return `Input window ${contextTokens.toLocaleString('en-US')} tokens${opts}.`
}

export function gpuText(kind: 'gpu' | 'split' | 'cpu', pct: number): string {
  return kind === 'gpu' ? '100% GPU' : kind === 'split' ? `split (${pct}% GPU) — slow` : 'CPU only — slow'
}
