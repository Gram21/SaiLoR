import { describe, it, expect } from 'vitest'
import type { AnnotationDef } from './schema'
import {
  loadProject,
  splitProjectFiles,
  isLegacyProjectShape,
  assembleLegacyProjectJson,
} from './project'

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
          },
        ],
      }),
    )
    const project = loadProject(raw)
    const { meta, files } = splitProjectFiles(project)

    const paperFiles = new Map<string, { consolidated?: unknown; reviewers: Map<string, unknown> }>()
    paperFiles.set('p1', { reviewers: new Map() })
    for (const f of files) {
      if (f.text === null) continue
      const [paperId, name] = f.relPath.split('/')
      const entry = paperFiles.get(paperId)!
      if (name === 'consolidated.json') entry.consolidated = JSON.parse(f.text)
      else entry.reviewers.set(name.replace(/^reviewer-(\d+)\.json$/, '$1'), JSON.parse(f.text))
    }

    const reassembled = assembleLegacyProjectJson(meta, paperFiles)
    const roundTripped = loadProject(reassembled)

    expect(roundTripped.papers[0].annotations).toEqual(project.papers[0].annotations)
    expect(roundTripped.papers[0].reviews['1']).toEqual(project.papers[0].reviews['1'])
    expect(roundTripped.papers[0].aiUsage).toEqual(project.papers[0].aiUsage)
    expect(roundTripped.papers[0].equal).toEqual(project.papers[0].equal)
  })

  it('gives an empty tree for a paper with no files on disk yet', () => {
    const project = loadProject(legacyJson())
    const { meta } = splitProjectFiles(project)
    const reassembled = assembleLegacyProjectJson(meta, new Map())
    const roundTripped = loadProject(reassembled)
    expect(roundTripped.papers[0].annotations.Relevant[0].value).toBe(false)
    expect(roundTripped.papers[1].annotations.Relevant[0].value).toBe(false)
  })
})
