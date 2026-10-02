import { describe, it, expect } from 'vitest'
import { optionsBudgetOf, systemOneProfileFor } from './modelProfiles'
import type { LlmConfig } from './types'

const cfg = (over: Partial<LlmConfig>): LlmConfig => ({
  id: 'c', name: 'c', provider: 'systemone', baseUrl: 'http://localhost:8080', model: '', attach: 'text', hasKey: true, ...over,
})

describe('systemOneProfileFor', () => {
  it('knows the Laya, Jev and Clef families', () => {
    expect(systemOneProfileFor(cfg({ model: 'laya' }))).toMatchObject({ contextTokens: 512, optionsBudgetTokens: 192 })
    expect(systemOneProfileFor(cfg({ model: 'laya-multilingual' }))).toMatchObject({ contextTokens: 1024, optionsBudgetTokens: 256 })
    expect(systemOneProfileFor(cfg({ model: 'laya-typed-decisions' })).contextTokens).toBe(1024)
    expect(systemOneProfileFor(cfg({ model: 'jev-latest' })).maxOptionsPerChoice).toBe(255)
  })

  it('tells hosted Clef from local Clef', () => {
    expect(systemOneProfileFor(cfg({ model: 'clef-flash', systemOneFlavor: 'cloudflare' }))).toMatchObject({ contextTokens: 65_536, maxQuestions: 64 })
    expect(systemOneProfileFor(cfg({ model: 'clef', baseUrl: 'https://clef.example.com' })).contextTokens).toBe(65_536)
    expect(systemOneProfileFor(cfg({ model: 'clef' })).contextTokens).toBe(16_384)
    expect(systemOneProfileFor(cfg({ managed: { catalogId: 'clef' }, baseUrl: '' })).contextTokens).toBe(16_384)
  })

  it('lets user numbers override the profile', () => {
    expect(systemOneProfileFor(cfg({ model: 'laya', contextTokens: 2048, optionsBudgetTokens: 300 }))).toMatchObject({ contextTokens: 2048, optionsBudgetTokens: 300 })
  })

  it('falls back to a conservative unknown profile', () => {
    const p = systemOneProfileFor(cfg({ model: 'mystery', contextTokens: 8000 }))
    expect(p).toMatchObject({ contextTokens: 8000, maxQuestions: 16 })
    expect(optionsBudgetOf(p)).toBe(2800)
    expect(optionsBudgetOf(systemOneProfileFor(cfg({ model: 'mystery', contextTokens: 100_000 })))).toBe(4096)
  })
})
