import { describe, it, expect } from 'vitest'
import { buildRunFeedback, feedbackFileName, hasFeedbackWorthSaving, type RunFeedbackInput, type FeedbackRow } from './feedback'

const base: RunFeedbackInput = {
  createdAt: '2026-09-30T12:00:00.000Z',
  mode: 'prompt',
  annotator: { provider: 'openai', model: 'm' },
  seat: 'ai',
  schemaVersion: '1',
  papers: ['p1', 'p2'],
  rows: [],
  remarks: [],
}
const row = (path: string, outcome: FeedbackRow['outcome'], over: Partial<FeedbackRow> = {}): FeedbackRow => ({
  paperId: 'p1', path, outcome, ...over,
})

describe('buildRunFeedback', () => {
  it('counts outcomes, sorts troublesome fields first, truncates edits, dedupes remarks', () => {
    const fb = buildRunFeedback({
      ...base,
      rows: [
        row('Clean', 'applied'),
        row('Clean', 'applied', { paperId: 'p2', judge: 'accept' }),
        row('Bad', 'edited', { aiValue: 'a'.repeat(300), finalValue: 'b' }),
        row('Bad', 'left-empty', { crossCheck: 'disagree', judge: 'reject' }),
        row('Bad', 'applied'),
      ],
      remarks: [
        { paperId: 'p1', path: 'Bad', issue: 'vague', suggestion: 's' },
        { paperId: 'p2', path: 'Bad', issue: 'vague' },
        { paperId: 'p2', path: 'Other', issue: 'x' },
      ],
    })
    expect(fb.papers).toBe(2)
    expect(fb.fields.map((f) => f.path)).toEqual(['Bad', 'Clean', 'Other'])
    const bad = fb.fields[0]
    expect(bad).toMatchObject({ asked: 3, applied: 1, edited: 1, leftEmpty: 1, crossCheckDisagreements: 1 })
    expect(bad.judge.reject).toBe(1)
    expect(bad.edits[0].ai).toHaveLength(200)
    expect(bad.remarks).toEqual([{ issue: 'vague', suggestion: 's', count: 2 }])
    expect(JSON.stringify(fb)).not.toContain('evidence')
  })

  it('caps edits at 10', () => {
    const rows = Array.from({ length: 15 }, () => row('F', 'edited', { aiValue: 1, finalValue: 2 }))
    expect(buildRunFeedback({ ...base, rows }).fields[0].edits).toHaveLength(10)
  })
})

describe('hasFeedbackWorthSaving', () => {
  it('is false for clean applies only', () => {
    expect(hasFeedbackWorthSaving(buildRunFeedback({ ...base, rows: [row('A', 'applied')] }))).toBe(false)
    expect(hasFeedbackWorthSaving(buildRunFeedback({ ...base, rows: [row('A', 'unticked')] }))).toBe(true)
    expect(hasFeedbackWorthSaving(buildRunFeedback({ ...base, rows: [row('A', 'applied')], remarks: [{ paperId: 'p', path: 'A', issue: 'i' }] }))).toBe(true)
  })
})

describe('feedbackFileName', () => {
  it('is filesystem-safe', () => {
    expect(feedbackFileName('2026-09-30T12:00:00.000Z', 'Ab/c-9XYZ12345')).toBe('run-2026-09-30T12-00-00Z-abc9xyz1.json')
    expect(feedbackFileName('2026-09-30T12:00:00Z', '!!')).toBe('run-2026-09-30T12-00-00Z-0.json')
  })
})
