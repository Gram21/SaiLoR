import { describe, it, expect } from 'vitest'
import { countPapersUsingField, type AnswerBearingPaper } from './fieldUsage'

/**
 * The guard behind the schema editor's rename/remove confirmation: renaming or
 * removing a field silently orphans every answer stored under its name.
 */
const paper = (annotations: unknown, reviews?: unknown): AnswerBearingPaper => ({
  annotations,
  ...(reviews ? { extra: { reviews } } : {}),
})

describe('countPapersUsingField', () => {
  it('counts a paper with a plain recorded answer', () => {
    const papers = [paper({ 'Study Type': [{ value: 'RCT' }] })]
    expect(countPapersUsingField(papers, 'Study Type')).toBe(1)
  })

  it('ignores a field nobody answered', () => {
    const papers = [paper({ 'Study Type': [{ value: null }] })]
    expect(countPapersUsingField(papers, 'Study Type')).toBe(0)
  })

  it('does not count an unticked boolean or a blank string as an answer', () => {
    const papers = [paper({ Relevant: [{ value: false }], Note: [{ value: '   ' }] })]
    expect(countPapersUsingField(papers, 'Relevant')).toBe(0)
    expect(countPapersUsingField(papers, 'Note')).toBe(0)
  })

  it('counts a ticked boolean and a zero number', () => {
    const papers = [paper({ Relevant: [{ value: true }], Count: [{ value: 0 }] })]
    expect(countPapersUsingField(papers, 'Relevant')).toBe(1)
    expect(countPapersUsingField(papers, 'Count')).toBe(1)
  })

  it('finds an answer nested inside a repeatable group', () => {
    const papers = [
      paper({ Findings: [{ children: { Claim: [{ value: 'alpha' }] } }] }),
    ]
    expect(countPapersUsingField(papers, 'Claim')).toBe(1)
  })

  it('counts a group whose descendants hold answers (removing it takes them too)', () => {
    const papers = [
      paper({ Findings: [{ children: { Claim: [{ value: 'alpha' }] } }] }),
    ]
    expect(countPapersUsingField(papers, 'Findings')).toBe(1)
  })

  it("counts an answer recorded only in a reviewer's own tree", () => {
    const papers = [
      paper({ 'Study Type': [{ value: null }] }, { '1': { 'Study Type': [{ value: 'RCT' }] } }),
    ]
    expect(countPapersUsingField(papers, 'Study Type')).toBe(1)
  })

  it('counts each paper once, not once per tree', () => {
    const papers = [
      paper({ 'Study Type': [{ value: 'RCT' }] }, {
        '1': { 'Study Type': [{ value: 'RCT' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
      }),
    ]
    expect(countPapersUsingField(papers, 'Study Type')).toBe(1)
  })

  it('a blank name matches nothing', () => {
    expect(countPapersUsingField([paper({ '': [{ value: 'x' }] })], '')).toBe(0)
    expect(countPapersUsingField([paper({ A: [{ value: 'x' }] })], '   ')).toBe(0)
  })

  it('survives a malformed hand-edited tree without throwing', () => {
    const papers: AnswerBearingPaper[] = [
      paper({ A: 'not-an-array' }),
      paper(null),
      paper({ A: ['primitive-instance'] }),
      { },
    ]
    expect(() => countPapersUsingField(papers, 'A')).not.toThrow()
  })
})
