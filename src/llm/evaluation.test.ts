// [utest->req~llm-820~1]
// [utest->req~llm-821~1]
// [utest->req~llm-822~1]
// [utest->req~llm-831~1]
import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { AiUsageRecord, Paper, Project } from '../model/project'
import { evaluateAi, evaluationCsv } from './evaluation'

const SCHEMA = resolveSchema([
  { name: 'Study Type', type: 'string' },
  { name: 'Venue', type: 'string' },
  { name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' }] },
])

const tree = (data: AnnotationValueTree) => normalizeTree(SCHEMA, data)

const USAGE: AiUsageRecord = { provider: 'openai', model: 'gpt-5.5', appliedAt: '2026-11-05T00:00:00Z', reviewer: '2' }

function paper(id: string, ai: AnnotationValueTree, truth: AnnotationValueTree, extra: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    authors: [],
    pdf: `${id}.pdf`,
    annotations: tree(truth),
    reviews: { '1': tree({}), '2': tree(ai) },
    aiUsage: [USAGE],
    equal: [],
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
    ...extra,
  }
}

function project(papers: Paper[], overrides: Partial<Project> = {}): Project {
  return { schema: SCHEMA, papers, reviewers: 2, aiSeat: true, aiEnabled: true, ...overrides } as Project
}

const field = (p: Project, key: string) => evaluateAi(p).fields.find((f) => f.key === key)

describe('evaluateAi', () => {
  it('counts equal values, ignoring case and spacing', () => {
    const p = project([paper('a', { 'Study Type': [{ value: ' rct ' }] }, { 'Study Type': [{ value: 'RCT' }] })])
    expect(field(p, 'Study Type')).toMatchObject({ compared: 1, equal: 1, differ: 0 })
    expect(evaluateAi(p).papers).toBe(1)
  })

  it('counts different values', () => {
    const p = project([paper('a', { 'Study Type': [{ value: 'RCT' }] }, { 'Study Type': [{ value: 'Survey' }] })])
    expect(field(p, 'Study Type')).toMatchObject({ compared: 1, equal: 0, differ: 1 })
  })

  it('counts a value marked equal by the consolidator as agreement', () => {
    const p = project([
      paper('a', { 'Study Type': [{ value: 'RCT' }] }, { 'Study Type': [{ value: 'Trial' }] }, { equal: ['Study Type'] }),
    ])
    expect(field(p, 'Study Type')).toMatchObject({ compared: 1, equal: 1 })
  })

  it('keeps missing sides out of the comparison', () => {
    const p = project([paper('a', { 'Study Type': [{ value: 'RCT' }] }, { Venue: [{ value: 'ICSE' }] })])
    expect(field(p, 'Study Type')).toMatchObject({ compared: 0, aiOnly: 1, missed: 0 })
    expect(field(p, 'Venue')).toMatchObject({ compared: 0, aiOnly: 0, missed: 1 })
    expect(evaluateAi(p).papers).toBe(0)
  })

  it('pools repeated entries and matches them through the stored alignment', () => {
    const p = project([
      paper(
        'a',
        { Findings: [{ children: { Claim: [{ value: 'B' }] } }, { children: { Claim: [{ value: 'A' }] } }] },
        { Findings: [{ children: { Claim: [{ value: 'A' }] } }, { children: { Claim: [{ value: 'B' }] } }] },
        { alignment: { Findings: [{ members: { '2': 1 } }, { members: { '2': 0 } }] } },
      ),
    ])
    expect(field(p, 'Findings/Claim')).toMatchObject({ label: 'Findings › Claim', compared: 2, equal: 2 })
  })

  it('sorts the worst field first', () => {
    const p = project([
      paper(
        'a',
        { 'Study Type': [{ value: 'RCT' }], Venue: [{ value: 'ICSE' }] },
        { 'Study Type': [{ value: 'RCT' }], Venue: [{ value: 'FSE' }] },
      ),
    ])
    expect(evaluateAi(p).fields.map((f) => f.key)).toEqual(['Venue', 'Study Type'])
  })

  it('skips papers without an AI run in the AI seat', () => {
    const p = project([
      paper('a', { 'Study Type': [{ value: 'RCT' }] }, { 'Study Type': [{ value: 'RCT' }] }, { aiUsage: [] }),
      paper('b', { 'Study Type': [{ value: 'RCT' }] }, { 'Study Type': [{ value: 'RCT' }] }, {
        aiUsage: [{ ...USAGE, reviewer: '1' }],
      }),
    ])
    expect(evaluateAi(p)).toEqual({ seat: '2', papers: 0, fields: [] })
  })

  it('returns no seat when the project has no AI seat', () => {
    const papers = [paper('a', { 'Study Type': [{ value: 'RCT' }] }, { 'Study Type': [{ value: 'RCT' }] })]
    expect(evaluateAi(project(papers, { aiSeat: false }))).toEqual({ seat: null, papers: 0, fields: [] })
    expect(evaluateAi(project(papers, { aiEnabled: false })).seat).toBeNull()
  })
})

describe('evaluationCsv', () => {
  it('writes counts per field and escapes field names that look like formulas', () => {
    const csv = evaluationCsv([
      { key: '=Risk', label: '=Risk', compared: 3, equal: 2, differ: 1, aiOnly: 0, missed: 1 },
      { key: 'Venue', label: 'Venue', compared: 0, equal: 0, differ: 0, aiOnly: 2, missed: 0 },
    ])
    expect(csv.split('\r\n')).toEqual([
      '"field","compared","equal","differ","ai_only","missed","agree_percent"',
      `"'=Risk","3","2","1","0","1","67"`,
      '"Venue","0","0","0","2","0",""',
      '',
    ])
  })
})
