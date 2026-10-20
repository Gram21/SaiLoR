import { describe, it, expect } from 'vitest'
import { chatInputBudget, estimateTokens, fitPaperText } from './budget'

const page = (n: number, text: string) => `[page ${n}]\n${text}`
const filler = (n: number) => 'lorem ipsum '.repeat(n).trim()

describe('fitPaperText', () => {
  it('returns text that fits untouched', () => {
    const t = page(1, 'short')
    expect(fitPaperText(t, 1000)).toEqual({ text: t, truncated: false, pagesKept: 1, pagesTotal: 1, droppedReferences: false })
  })

  it('drops the reference list before dropping pages', () => {
    const text = [page(1, filler(100)), page(2, filler(100)), page(3, `${filler(20)}\nReferences\n[1] ${filler(100)}`)].join('\n')
    const r = fitPaperText(text, estimateTokens(text) - 100)
    expect(r.droppedReferences).toBe(true)
    expect(r.text).not.toContain('[1] lorem')
    expect(r.pagesKept).toBe(3)
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(estimateTokens(text) - 100)
  })

  it('ignores a References heading in the first two thirds', () => {
    const text = [page(1, `References\n${filler(10)}`), page(2, filler(200)), page(3, filler(200))].join('\n')
    expect(fitPaperText(text, 300).droppedReferences).toBe(false)
  })

  it('drops trailing pages with an omission note, never over budget', () => {
    const text = Array.from({ length: 10 }, (_, i) => page(i + 1, filler(100))).join('\n')
    const r = fitPaperText(text, 500)
    expect(r.truncated).toBe(true)
    expect(r.pagesKept).toBeLessThan(10)
    expect(r.pagesTotal).toBe(10)
    expect(r.text).toMatch(/\[\.\.\. \d+ pages omitted to fit the model's context \.\.\.\]/)
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(500)
  })

  it('cuts inside page 1 when it alone is too big', () => {
    const r = fitPaperText(page(1, filler(2000)), 100)
    expect(r.pagesKept).toBe(1)
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(100)
  })

  it('handles unmarked text and a zero budget', () => {
    expect(estimateTokens(fitPaperText(filler(500), 50).text)).toBeLessThanOrEqual(50)
    expect(fitPaperText(filler(50), 0).text).toBe('')
  })
})

describe('chatInputBudget', () => {
  it('is null for an unknown window', () => {
    expect(chatInputBudget({}, { systemTokens: 1000 })).toBeNull()
  })

  it('subtracts the reserves and floors at 0', () => {
    expect(chatInputBudget({ contextTokens: 16384 }, { systemTokens: 1000, fewShotTokens: 500, outputReserve: 2000, thinkReserve: 1000 })).toBe(11884)
    expect(chatInputBudget({ contextTokens: 2048 }, { systemTokens: 3000 })).toBe(0)
  })
})
