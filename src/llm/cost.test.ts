import { describe, it, expect } from 'vitest'
import { costOf, estimateRun, estimateCost } from './cost'
import type { LlmConfig } from './types'

function cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c1',
    name: 'test',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-5',
    attach: 'text',
    hasKey: true,
    ...over,
  }
}

describe('costOf', () => {
  it('is null when either price is unset', () => {
    expect(costOf({ inputTokens: 1000, outputTokens: 1000 }, cfg())).toBeNull()
    expect(costOf({ inputTokens: 1000, outputTokens: 1000 }, cfg({ inputPrice: 1 }))).toBeNull()
  })

  it('computes USD from per-1M prices', () => {
    const c = cfg({ inputPrice: 3, outputPrice: 15 })
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, c)).toBe(18)
    expect(costOf({ inputTokens: 500_000, outputTokens: 0 }, c)).toBe(1.5)
  })
})

describe('estimateRun', () => {
  it('prompt mode: one request per paper, tokens scale with pages and fields', () => {
    const est = estimateRun({
      papers: [{ pages: 10 }],
      fieldsPerPaper: 5,
      mode: 'prompt',
      delivery: 'text',
    })
    expect(est.requests).toEqual({ low: 1, high: 1 })
    expect(est.low.inputTokens).toBeLessThan(est.high.inputTokens)
    expect(est.low.outputTokens).toBeLessThan(est.high.outputTokens)
    expect(est.low.inputTokens).toBeGreaterThan(0)
  })

  it('pdf delivery costs more input tokens per page than text', () => {
    const base = { papers: [{ pages: 10 }], fieldsPerPaper: 5, mode: 'prompt' as const }
    const text = estimateRun({ ...base, delivery: 'text' })
    const pdf = estimateRun({ ...base, delivery: 'pdf' })
    expect(pdf.low.inputTokens).toBeGreaterThan(text.low.inputTokens)
    expect(pdf.high.inputTokens).toBeGreaterThan(text.high.inputTokens)
  })

  it('agent mode issues several requests per paper, plus judge calls', () => {
    const est = estimateRun({
      papers: [{ pages: 10 }],
      fieldsPerPaper: 5,
      mode: 'agent',
      delivery: 'text',
    })
    // 5-15 agent requests plus 2-4 judge requests.
    expect(est.requests.low).toBeGreaterThanOrEqual(5 + 2)
    expect(est.requests.high).toBeLessThanOrEqual(15 + 4)
    expect(est.requests.high).toBeGreaterThan(est.requests.low)
  })

  it('agent-mode high estimate re-bills the paper prefix per round, so it dwarfs the low (cached) estimate', () => {
    const est = estimateRun({
      papers: [{ pages: 20 }],
      fieldsPerPaper: 5,
      mode: 'agent',
      delivery: 'text',
    })
    expect(est.high.inputTokens).toBeGreaterThan(est.low.inputTokens * 2)
  })

  it('accepts one fields count applied to every paper, or one per paper', () => {
    const flat = estimateRun({
      papers: [{ pages: 5 }, { pages: 5 }],
      fieldsPerPaper: 3,
      mode: 'prompt',
      delivery: 'text',
    })
    const perPaper = estimateRun({
      papers: [{ pages: 5 }, { pages: 5 }],
      fieldsPerPaper: [3, 3],
      mode: 'prompt',
      delivery: 'text',
    })
    expect(perPaper).toEqual(flat)
  })

  it('adds fewShotTokens to input', () => {
    const base = estimateRun({ papers: [{ pages: 5 }], fieldsPerPaper: 3, mode: 'prompt', delivery: 'text' })
    const withFewShot = estimateRun({
      papers: [{ pages: 5 }],
      fieldsPerPaper: 3,
      mode: 'prompt',
      delivery: 'text',
      fewShotTokens: 1000,
    })
    expect(withFewShot.low.inputTokens).toBe(base.low.inputTokens + 1000)
    expect(withFewShot.high.inputTokens).toBe(base.high.inputTokens + 1000)
  })
})

describe('estimateCost', () => {
  it('is null without pricing, and low <= high with pricing', () => {
    const est = estimateRun({ papers: [{ pages: 10 }], fieldsPerPaper: 5, mode: 'prompt', delivery: 'text' })
    expect(estimateCost(est, cfg())).toBeNull()
    const cost = estimateCost(est, cfg({ inputPrice: 3, outputPrice: 15 }))
    expect(cost).not.toBeNull()
    expect(cost!.low).toBeLessThanOrEqual(cost!.high)
  })
})
