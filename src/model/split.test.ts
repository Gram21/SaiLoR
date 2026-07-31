import { describe, it, expect } from 'vitest'
import type { AnnotationDef } from './schema'
import {
  loadProject,
  serializeProject,
  splitProjectFiles,
  isLegacyProjectShape,
  assembleLegacyProjectJson,
} from './project'
import { SCREENING_DECISION, DECISION_INCLUDE } from '../screening/schema'

const sampleSchema: AnnotationDef[] = [
  { name: 'Relevant', type: 'boolean' },
  { name: 'Study Type', type: 'string', min: 1, max: 1 },
]

function legacyJson(overrides: Partial<{ reviewers: number; papers: unknown[] }> = {}) {
  return JSON.stringify({
    version: 1,
    config: { schema: sampleSchema, ...(overrides.reviewers ? { reviewers: overrides.reviewers } : {}) },
    papers: overrides.papers ?? [
      { id: 'p1', title: 'Paper One', authors: ['A'], pdf: 'p1.pdf', annotations: { Relevant: [{ value: true }] } },
      { id: 'p2', title: 'Paper Two', authors: ['B'], pdf: 'p2.pdf', annotations: {} },
    ],
  })
}

describe('isLegacyProjectShape', () => {
  it('detects a paper with inline annotations', () => {
    expect(isLegacyProjectShape(JSON.parse(legacyJson()))).toBe(true)
  })

  it('detects a paper with inline reviews', () => {
    const raw = JSON.parse(legacyJson({ reviewers: 2 }))
    raw.papers[0].reviews = { '1': {} }
    delete raw.papers[0].annotations
    expect(isLegacyProjectShape(raw)).toBe(true)
  })

  it('is false for a meta-only papers array', () => {
    const raw = { papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf' }] }
    expect(isLegacyProjectShape(raw)).toBe(false)
  })

  it('is false when papers is missing or not an array', () => {
    expect(isLegacyProjectShape({})).toBe(false)
    expect(isLegacyProjectShape({ papers: 'nope' })).toBe(false)
  })
})

describe('splitProjectFiles', () => {
  it('strips annotations/reviews/aiUsage/equal out of the meta and writes a consolidated.json per paper with content', () => {
    const project = loadProject(legacyJson())
    const { meta, files } = splitProjectFiles(project)

    const metaPapers = (meta as { papers: Record<string, unknown>[] }).papers
    for (const p of metaPapers) {
      expect(p).not.toHaveProperty('annotations')
      expect(p).not.toHaveProperty('reviews')
      expect(p).not.toHaveProperty('aiUsage')
      expect(p).not.toHaveProperty('equal')
    }

    const p1Consolidated = files.find((f) => f.relPath === 'p1/consolidated.json')
    expect(p1Consolidated?.text).toContain('Relevant')

    // p2 has no annotations at all, so its file should be marked for deletion.
    const p2Consolidated = files.find((f) => f.relPath === 'p2/consolidated.json')
    expect(p2Consolidated?.text).toBeNull()
  })

  it('writes one reviewer-<n>.json per non-empty reviewer tree in a multi-reviewer project, and nothing for an empty one', () => {
    const raw = JSON.parse(
      legacyJson({
        reviewers: 2,
        papers: [
          {
            id: 'p1',
            title: 'Paper One',
            authors: ['A'],
            pdf: 'p1.pdf',
            annotations: {},
            reviews: { '1': { Relevant: [{ value: true }] }, '2': {} },
          },
        ],
      }),
    )
    const project = loadProject(raw)
    const { files } = splitProjectFiles(project)

    const r1 = files.find((f) => f.relPath === 'p1/reviewer-1.json')
    const r2 = files.find((f) => f.relPath === 'p1/reviewer-2.json')
    expect(r1?.text).toContain('Relevant')
    expect(r2?.text).toBeNull()
  })

  it('never emits reviewer-*.json files for a single-reviewer project', () => {
    const project = loadProject(legacyJson())
    const { files } = splitProjectFiles(project)
    expect(files.some((f) => f.relPath.includes('reviewer-'))).toBe(false)
  })

  it('uses screening-<n>.json / screening-consolidated.json for a screening project', () => {
    const raw = {
      version: 1,
      config: { reviewers: 2, screening: { reasons: ['Not relevant'] } },
      papers: [
        {
          id: 'p1',
          title: 'Paper One',
          authors: ['A'],
          pdf: 'p1.pdf',
          annotations: { [SCREENING_DECISION]: [{ value: DECISION_INCLUDE }] },
          reviews: {
            '1': { [SCREENING_DECISION]: [{ value: DECISION_INCLUDE }] },
            '2': {},
          },
        },
      ],
    }
    const project = loadProject(raw)
    const { files } = splitProjectFiles(project)

    expect(
      files
        .map((f) => f.relPath)
        .filter((p) => !p.includes('/marks-'))
        .sort(),
    ).toEqual(['p1/screening-1.json', 'p1/screening-2.json', 'p1/screening-consolidated.json'])
    const r1 = files.find((f) => f.relPath === 'p1/screening-1.json')
    expect(r1?.text).toContain(DECISION_INCLUDE)
    const consolidated = files.find((f) => f.relPath === 'p1/screening-consolidated.json')
    expect(consolidated?.text).toContain(DECISION_INCLUDE)
    // Never the ordinary-project names for a screening project.
    expect(files.some((f) => f.relPath.endsWith('/consolidated.json'))).toBe(false)
    expect(files.some((f) => /\/reviewer-\d+\.json$/.test(f.relPath))).toBe(false)
  })
})

describe('paper ordering — plain string comparison on id', () => {
  const raw = {
    version: 1,
    config: { schema: sampleSchema },
    papers: [
      // Deliberately not id-sorted, and title order would disagree with id
      // order for the first two — title sorting must not leak back in.
      { id: 'p10', title: 'Aardvark Paper', authors: [], pdf: 'p10.pdf', annotations: {} },
      { id: 'P2', title: 'Zebra Paper', authors: [], pdf: 'p2.pdf', annotations: {} },
      { id: 'p2', title: 'Middle Paper', authors: [], pdf: 'p2b.pdf', annotations: {} },
    ],
  }

  it('serializeProject orders papers by plain (case-sensitive) string comparison on id', () => {
    const project = loadProject(raw)
    const out = JSON.parse(serializeProject(project)) as { papers: { id: string }[] }
    // Plain string compare: uppercase 'P2' sorts before lowercase 'p10'/'p2'
    // (charCode 'P' < 'p'), not the locale-aware or case-insensitive order.
    expect(out.papers.map((p) => p.id)).toEqual(['P2', 'p10', 'p2'])
  })

  it('splitProjectFiles orders metaPapers the same way', () => {
    const project = loadProject(raw)
    const { meta } = splitProjectFiles(project)
    const ids = (meta as { papers: { id: string }[] }).papers.map((p) => p.id)
    expect(ids).toEqual(['P2', 'p10', 'p2'])
  })
})

describe('assembleLegacyProjectJson + splitProjectFiles round-trip', () => {
  it('reassembles into a shape loadProject accepts, preserving annotation content', () => {
    const raw = JSON.parse(
      legacyJson({
        reviewers: 2,
        papers: [
          {
            id: 'p1',
            title: 'Paper One',
            authors: ['A'],
            pdf: 'p1.pdf',
            annotations: { Relevant: [{ value: true }] },
            reviews: { '1': { Relevant: [{ value: true }] }, '2': {} },
            aiUsage: [{ provider: 'openai', model: 'gpt-5', appliedAt: '2026-01-01T00:00:00.000Z' }],
            equal: ['Relevant'],
            alignment: { Relevant: [{ members: { '1': 0, '2': 0 } }] },
          },
        ],
      }),
    )
    const project = loadProject(raw)
    const { meta, files } = splitProjectFiles(project)

    const paperFiles = new Map<
      string,
      { consolidated?: unknown; reviewers: Map<string, unknown>; reviewMarks: Map<string, unknown> }
    >()
    paperFiles.set('p1', { reviewers: new Map(), reviewMarks: new Map() })
    for (const f of files) {
      if (f.text === null) continue
      const [paperId, name] = f.relPath.split('/')
      const entry = paperFiles.get(paperId)!
      if (name === 'consolidated.json') entry.consolidated = JSON.parse(f.text)
      else if (name.startsWith('marks-')) continue // this test carries no marks
      else entry.reviewers.set(name.replace(/^reviewer-(\d+)\.json$/, '$1'), JSON.parse(f.text))
    }

    const reassembled = assembleLegacyProjectJson(meta, paperFiles)
    const roundTripped = loadProject(reassembled)

    expect(roundTripped.papers[0].annotations).toEqual(project.papers[0].annotations)
    expect(roundTripped.papers[0].reviews['1']).toEqual(project.papers[0].reviews['1'])
    expect(roundTripped.papers[0].aiUsage).toEqual(project.papers[0].aiUsage)
    expect(roundTripped.papers[0].equal).toEqual(project.papers[0].equal)
    // Consolidation's recorded entry matching rides in the consolidated file,
    // and has to survive the split/reassemble like everything else there — a
    // lost mapping would re-point every cross-reviewer comparison on the paper.
    expect(roundTripped.papers[0].alignment).toEqual(project.papers[0].alignment)
    expect(roundTripped.papers[0].alignment).toEqual({ Relevant: [{ members: { '1': 0, '2': 0 } }] })
  })

  it('gives an empty tree for a paper with no files on disk yet', () => {
    const project = loadProject(legacyJson())
    const { meta } = splitProjectFiles(project)
    const reassembled = assembleLegacyProjectJson(meta, new Map())
    const roundTripped = loadProject(reassembled)
    expect(roundTripped.papers[0].annotations.Relevant[0].value).toBe(false)
    expect(roundTripped.papers[1].annotations.Relevant[0].value).toBe(false)
  })

  it('round-trips marks/reviewMarks through marks-consolidated.json / marks-<n>.json', () => {
    const consolidatedMark = {
      id: 'c1',
      page: 1,
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
      color: '#ffe066',
      comment: 'consolidated note',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'highlight' as const,
      linkedFields: [{ path: 'Study Type', label: 'Study Type' }],
    }
    const reviewer1Mark = { ...consolidatedMark, id: 'r1', comment: 'reviewer 1 note' }
    const raw = JSON.parse(
      legacyJson({
        reviewers: 2,
        papers: [
          {
            id: 'p1',
            title: 'Paper One',
            authors: ['A'],
            pdf: 'p1.pdf',
            annotations: {},
            reviews: { '1': {}, '2': {} },
            marks: [consolidatedMark],
            reviewMarks: { '1': [reviewer1Mark] },
          },
        ],
      }),
    )
    const project = loadProject(raw)
    const { meta, files } = splitProjectFiles(project)

    expect(files.some((f) => f.relPath === 'p1/marks-consolidated.json' && f.text !== null)).toBe(true)
    expect(files.some((f) => f.relPath === 'p1/marks-1.json' && f.text !== null)).toBe(true)
    expect(files.some((f) => f.relPath === 'p1/marks-2.json' && f.text === null)).toBe(true)

    const paperFiles = new Map<
      string,
      {
        consolidated?: unknown
        reviewers: Map<string, unknown>
        marksConsolidated?: unknown
        reviewMarks: Map<string, unknown>
      }
    >()
    paperFiles.set('p1', { reviewers: new Map(), reviewMarks: new Map() })
    for (const f of files) {
      if (f.text === null) continue
      const [paperId, name] = f.relPath.split('/')
      const entry = paperFiles.get(paperId)!
      if (name === 'marks-consolidated.json') entry.marksConsolidated = JSON.parse(f.text)
      else if (name.startsWith('marks-')) entry.reviewMarks.set(name.replace(/^marks-(\d+)\.json$/, '$1'), JSON.parse(f.text))
      else if (name === 'consolidated.json') entry.consolidated = JSON.parse(f.text)
      else entry.reviewers.set(name.replace(/^reviewer-(\d+)\.json$/, '$1'), JSON.parse(f.text))
    }

    const reassembled = assembleLegacyProjectJson(meta, paperFiles)
    const roundTripped = loadProject(reassembled)

    expect(roundTripped.papers[0].marks).toEqual([consolidatedMark])
    expect(roundTripped.papers[0].reviewMarks['1']).toEqual([reviewer1Mark])
    expect(roundTripped.papers[0].reviewMarks['2']).toBeUndefined()
  })
})
