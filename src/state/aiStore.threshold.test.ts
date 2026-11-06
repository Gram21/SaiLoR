import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../platform', () => ({ getPlatform: () => ({
    kind: 'browser',
    getOsInfo: () => null,
    getRecents: () => [],
    listLlmConfigs: async () => [],
  }) }))

async function thresholdWith(stored: string | null): Promise<number> {
  const data = new Map<string, string>()
  if (stored !== null) data.set('slr.llm.threshold', stored)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  })
  vi.resetModules()
  const { useAiStore } = await import('./aiStore')
  return useAiStore.getState().confidenceThreshold
}

beforeEach(() => vi.unstubAllGlobals())

describe('stored confidence threshold', () => {
  it('uses the default when nothing is stored, not 0', async () => {
    expect(await thresholdWith(null)).toBe(0.8)
  })
  it('uses the default for a blank or out-of-range value', async () => {
    expect(await thresholdWith('')).toBe(0.8)
    expect(await thresholdWith('7')).toBe(0.8)
  })
  it('keeps a valid stored value, including 0', async () => {
    expect(await thresholdWith('0.5')).toBe(0.5)
    expect(await thresholdWith('0')).toBe(0)
  })
})
