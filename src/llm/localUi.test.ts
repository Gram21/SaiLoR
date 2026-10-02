import { describe, it, expect } from 'vitest'
import type { HardwareInfo } from '../platform/localRuntime'
import { formatBytes, hardwareSentence, isCloudflareAccountId, memoryCheck, suggestContext, windowSentence } from './localUi'

const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({
  platform: 'darwin', arch: 'arm64', totalRamBytes: 16e9, freeRamBytes: 8e9, gpus: [], diskFreeBytes: 1e11,
  recommendedBackend: 'cpu', ...over,
})

describe('localUi', () => {
  it('formats bytes', () => {
    expect(formatBytes(449_397_600)).toBe('449 MB')
    expect(formatBytes(6.6e9)).toBe('6.6 GB')
  })
  it('describes the backend honestly', () => {
    expect(hardwareSentence(hw({ recommendedBackend: 'metal' }))).toBe('Will run on GPU (Metal).')
    expect(hardwareSentence(hw())).toMatch(/run on CPU/)
  })
  it('suggests 32k with 16 GB, 16k below, capped by the model', () => {
    expect(suggestContext(16e9)).toBe(32_768)
    expect(suggestContext(8e9)).toBe(16_384)
    expect(suggestContext(32e9, 8192)).toBe(8192)
  })
  it('flags models that exceed free RAM or known VRAM', () => {
    expect(memoryCheck(6e9, 1e9, hw()).tooBig).toBe(false)
    expect(memoryCheck(9e9, 1e9, hw()).tooBig).toBe(true)
    expect(memoryCheck(6e9, null, hw({ gpus: [{ vendor: 'nvidia', name: 'x', vramBytes: 4e9 }] })).tooBig).toBe(true)
  })
  it('validates Cloudflare account ids', () => {
    expect(isCloudflareAccountId('a'.repeat(32))).toBe(true)
    expect(isCloudflareAccountId('A'.repeat(32))).toBe(false)
    expect(isCloudflareAccountId('abc')).toBe(false)
  })
  it('explains the label budget', () => {
    expect(windowSentence(2048, 192)).toMatch(/2,048 tokens.*192/)
  })
})
