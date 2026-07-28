import { describe, it, expect } from 'vitest'
import { countPapersUsingField, countLinksUsingField, type AnswerBearingPaper } from './fieldUsage'
import type { PdfMark } from './pdfMarks'

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
    expect(countPapersUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('ignores a field nobody answered', () => {
    const papers = [paper({ 'Study Type': [{ value: null }] })]
    expect(countPapersUsingField(papers, ['Study Type'])).toBe(0)
  })

  it('does not count an unticked boolean or a blank string as an answer', () => {
    const papers = [paper({ Relevant: [{ value: false }], Note: [{ value: '   ' }] })]
    expect(countPapersUsingField(papers, ['Relevant'])).toBe(0)
    expect(countPapersUsingField(papers, ['Note'])).toBe(0)
  })

  it('counts a ticked boolean and a zero number', () => {
    const papers = [paper({ Relevant: [{ value: true }], Count: [{ value: 0 }] })]
    expect(countPapersUsingField(papers, ['Relevant'])).toBe(1)
    expect(countPapersUsingField(papers, ['Count'])).toBe(1)
  })

  it('finds an answer nested inside a repeatable group', () => {
    const papers = [
      paper({ Findings: [{ children: { Claim: [{ value: 'alpha' }] } }] }),
    ]
    expect(countPapersUsingField(papers, ['Findings', 'Claim'])).toBe(1)
  })

  it('counts a group whose descendants hold answers (removing it takes them too)', () => {
    const papers = [
      paper({ Findings: [{ children: { Claim: [{ value: 'alpha' }] } }] }),
    ]
    expect(countPapersUsingField(papers, ['Findings'])).toBe(1)
  })

  it("counts an answer recorded only in a reviewer's own tree", () => {
    const papers = [
      paper({ 'Study Type': [{ value: null }] }, { '1': { 'Study Type': [{ value: 'RCT' }] } }),
    ]
    expect(countPapersUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('counts each paper once, not once per tree', () => {
    const papers = [
      paper({ 'Study Type': [{ value: 'RCT' }] }, {
        '1': { 'Study Type': [{ value: 'RCT' }] },
        '2': { 'Study Type': [{ value: 'Survey' }] },
      }),
    ]
    expect(countPapersUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('a blank name matches nothing', () => {
    expect(countPapersUsingField([paper({ '': [{ value: 'x' }] })], [''])).toBe(0)
    expect(countPapersUsingField([paper({ A: [{ value: 'x' }] })], ['   '])).toBe(0)
    expect(countPapersUsingField([paper({ A: [{ value: 'x' }] })], [])).toBe(0)
  })

  it('survives a malformed hand-edited tree without throwing', () => {
    const papers: AnswerBearingPaper[] = [
      paper({ A: 'not-an-array' }),
      paper(null),
      paper({ A: ['primitive-instance'] }),
      { },
    ]
    expect(() => countPapersUsingField(papers, ['A'])).not.toThrow()
  })

  it('does not match a same-named field at a different place in the tree', () => {
    // The single most common editor sequence there is: add a field, give it a
    // name another field already uses, change your mind, delete it. Warning
    // there is a lie — this new node holds nothing — and a guard that lies is
    // one reviewers learn to click straight through.
    const papers = [paper({ Findings: [{ children: { Notes: [{ value: 'alpha' }] } }] })]
    expect(countPapersUsingField(papers, ['Notes'])).toBe(0)
    expect(countPapersUsingField(papers, ['Findings', 'Notes'])).toBe(1)
  })

  it('does not match a path that stops short of the answer-bearing depth', () => {
    const papers = [paper({ A: [{ children: { B: [{ children: { C: [{ value: 'x' }] } }] } }] })]
    expect(countPapersUsingField(papers, ['A', 'C'])).toBe(0)
    expect(countPapersUsingField(papers, ['B', 'C'])).toBe(0)
    expect(countPapersUsingField(papers, ['A', 'B', 'C'])).toBe(1)
  })
})

function mark(overrides: Partial<PdfMark> = {}): PdfMark {
  return {
    id: 'm1',
    page: 1,
    rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.05 }],
    color: '#ffe066',
    comment: '',
    createdAt: '',
    updatedAt: '',
    kind: 'highlight',
    ...overrides,
  }
}

const paperWithMarks = (marks: PdfMark[], reviewMarks?: Record<string, PdfMark[]>): AnswerBearingPaper => ({
  extra: { marks, ...(reviewMarks ? { reviewMarks } : {}) },
})

describe('countLinksUsingField', () => {
  it('counts a paper with a link at the exact path', () => {
    const papers = [paperWithMarks([mark({ linkedFields: [{ path: 'Study Type', label: 'Study Type' }] })])]
    expect(countLinksUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('ignores a link at a different path', () => {
    const papers = [paperWithMarks([mark({ linkedFields: [{ path: 'Relevant', label: 'Relevant' }] })])]
    expect(countLinksUsingField(papers, ['Study Type'])).toBe(0)
  })

  it('ignores a mark with no links', () => {
    const papers = [paperWithMarks([mark()])]
    expect(countLinksUsingField(papers, ['Study Type'])).toBe(0)
  })

  it("counts a link recorded only in a reviewer's own marks", () => {
    const papers = [
      paperWithMarks([], { '1': [mark({ linkedFields: [{ path: 'Study Type', label: 'Study Type' }] })] }),
    ]
    expect(countLinksUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('counts each paper once, not once per reviewer', () => {
    const linked = mark({ linkedFields: [{ path: 'Study Type', label: 'Study Type' }] })
    const papers = [paperWithMarks([linked], { '1': [linked], '2': [linked] })]
    expect(countLinksUsingField(papers, ['Study Type'])).toBe(1)
  })

  it('matches a nested path exactly, by segment names', () => {
    const papers = [
      paperWithMarks([mark({ linkedFields: [{ path: 'Findings[1]/Claim', label: 'Findings #2 › Claim' }] })]),
    ]
    expect(countLinksUsingField(papers, ['Findings', 'Claim'])).toBe(1)
    expect(countLinksUsingField(papers, ['Findings'])).toBe(0)
  })

  it('a blank or empty path matches nothing', () => {
    const papers = [paperWithMarks([mark({ linkedFields: [{ path: 'Study Type', label: 'Study Type' }] })])]
    expect(countLinksUsingField(papers, [''])).toBe(0)
    expect(countLinksUsingField(papers, [])).toBe(0)
  })

  it('survives a paper with no marks/reviewMarks at all', () => {
    expect(() => countLinksUsingField([{}], ['Study Type'])).not.toThrow()
    expect(countLinksUsingField([{}], ['Study Type'])).toBe(0)
  })
})
