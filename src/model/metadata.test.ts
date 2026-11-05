// [utest->req~dat-430~1]
// [utest->req~dat-450~1]
// [utest->req~dat-460~1]
// [utest->req~dat-470~1]
// [utest->req~lst-80~1]
// [utest->req~con-530~1]
import { describe, it, expect } from 'vitest'
import { loadProject, projectFromFiles, serializeProject, splitProjectFiles, type Project } from './project'
import {
  applyProjectEdit,
  applySeatEdit,
  canUpdateProject,
  editedFields,
  effectiveMetadata,
  mergeSeatMetadata,
  metadataFingerprint,
  metadataSeatKey,
  parseMetadataEditMode,
  proposeFromPdf,
  recordIgnored,
} from './metadata'

function project(config: Record<string, unknown> = {}): Project {
  return loadProject(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'Relevant', type: 'boolean' }], ...config },
      papers: [{ id: 'p1', title: 'Orignal Title', authors: ['Ada Lovelace'], year: 2020, pdf: 'p1.pdf', annotations: {} }],
    }),
  )
}

function reopen(p: Project): Project {
  const { meta, files } = splitProjectFiles(p)
  return projectFromFiles(
    meta,
    files.filter((f) => f.text !== null).map((f) => [f.relPath, f.text!] as [string, string]),
  )
}

describe('metadata edit mode', () => {
  it('defaults to off and keeps an old project file unchanged', () => {
    const p = project()
    expect(p.metadataEdit).toBeUndefined()
    expect(parseMetadataEditMode('bogus')).toBe('off')
    expect(JSON.parse(serializeProject(p)).config).not.toHaveProperty('metadataEdit')
    expect(JSON.parse(serializeProject(project({ metadataEdit: 'off' }))).config).not.toHaveProperty('metadataEdit')
  })

  it('reads and writes annotation, and reads the old project mode as annotation', () => {
    for (const mode of ['project', 'annotation']) {
      const p = project({ metadataEdit: mode })
      expect(p.metadataEdit).toBe('annotation')
      expect(JSON.parse(serializeProject(p)).config.metadataEdit).toBe('annotation')
      expect(reopen(p).metadataEdit).toBe('annotation')
    }
  })

  it('routes each seat to its annotation file and only Consolidation or the only reviewer to the project', () => {
    expect(metadataSeatKey(project(), null)).toBeNull()
    expect(canUpdateProject(project(), null)).toBe(false)
    const single = project({ metadataEdit: 'annotation' })
    expect(metadataSeatKey(single, null)).toBe('1')
    expect(canUpdateProject(single, null)).toBe(true)
    const multi = project({ metadataEdit: 'annotation', reviewers: 3, ai: true, aiSeat: true })
    expect(metadataSeatKey(multi, null)).toBeNull()
    expect(metadataSeatKey(multi, '1')).toBe('1')
    expect(metadataSeatKey(multi, '3')).toBeNull()
    expect(metadataSeatKey(multi, 'consolidation')).toBeNull()
    expect(canUpdateProject(multi, '1')).toBe(false)
    expect(canUpdateProject(multi, 'consolidation')).toBe(true)
  })
})

describe('applyProjectEdit', () => {
  it('records the first value and drops it when the value returns', () => {
    const p = project({ metadataEdit: 'annotation' })
    const paper = p.papers[0]
    applyProjectEdit(paper, { title: 'Original Title', doi: '10.1/x' })
    applyProjectEdit(paper, { title: 'Original Title 2' })
    expect(paper.id).toBe('p1')
    expect(paper.title).toBe('Original Title 2')
    expect(paper.extra.metadataOriginal).toEqual({ title: 'Orignal Title', doi: null })
    expect(editedFields(paper, null)).toEqual(['title', 'doi'])
    applyProjectEdit(paper, { title: 'Orignal Title', doi: undefined })
    expect(paper.doi).toBeUndefined()
    expect(paper.extra).not.toHaveProperty('metadataOriginal')
  })

  it('never sets an empty title', () => {
    const paper = project().papers[0]
    applyProjectEdit(paper, { title: '  ' })
    expect(paper.title).toBe('Orignal Title')
  })
})

describe('applySeatEdit', () => {
  it('stores only the changed fields and leaves the project values alone', () => {
    const paper = project({ metadataEdit: 'annotation', reviewers: 2 }).papers[0]
    applySeatEdit(paper, '1', { title: 'Original Title', authors: ['Ada Lovelace'], year: 2021 })
    expect(paper.reviewMetadata).toEqual({ '1': { overrides: { title: 'Original Title', year: 2021 } } })
    expect(paper.title).toBe('Orignal Title')
    expect(effectiveMetadata(paper, '1')).toMatchObject({ title: 'Original Title', year: 2021 })
    expect(effectiveMetadata(paper, '2').title).toBe('Orignal Title')
    applySeatEdit(paper, '1', { title: 'Orignal Title', year: undefined })
    expect(paper.reviewMetadata).toBeUndefined()
  })
})

describe('metadata storage round trip', () => {
  it('keeps seat overrides in the reviewer file and the paper id stable', () => {
    const p = project({ metadataEdit: 'annotation', reviewers: 2 })
    applySeatEdit(p.papers[0], '2', { doi: '10.18420/se2026-21' })
    recordIgnored(p.papers[0], '2', { title: 'Junk' })
    const { meta, files } = splitProjectFiles(p)
    const metaPaper = (meta as { papers: Record<string, unknown>[] }).papers[0]
    expect(metaPaper).not.toHaveProperty('reviewMetadata')
    const seatFile = JSON.parse(files.find((f) => f.relPath === 'p1/reviewer-2.json')!.text!)
    expect(seatFile).toEqual({ metadataOverrides: { doi: '10.18420/se2026-21' }, metadataIgnored: { title: 'Junk' } })
    const back = reopen(p).papers[0]
    expect(back.id).toBe('p1')
    expect(back.reviewMetadata).toEqual(p.papers[0].reviewMetadata)
    expect(loadProject(serializeProject(p)).papers[0].reviewMetadata).toEqual(p.papers[0].reviewMetadata)
  })

  it('keeps single-reviewer corrections in the seat 1 file', () => {
    const p = project({ metadataEdit: 'annotation' })
    applySeatEdit(p.papers[0], '1', { title: 'Original Title' })
    const { meta, files } = splitProjectFiles(p)
    expect((meta as { papers: Record<string, unknown>[] }).papers[0].title).toBe('Orignal Title')
    expect(JSON.parse(files.find((f) => f.relPath === 'p1/reviewer-1.json')!.text!)).toEqual({
      metadataOverrides: { title: 'Original Title' },
    })
    const back = reopen(p).papers[0]
    expect(back.title).toBe('Orignal Title')
    expect(back.reviewMetadata).toEqual({ '1': { overrides: { title: 'Original Title' } } })
    expect(loadProject(serializeProject(p)).papers[0].reviewMetadata).toEqual(back.reviewMetadata)
  })

  it('keeps updated project values and their original values', () => {
    const p = project({ metadataEdit: 'annotation' })
    applyProjectEdit(p.papers[0], { title: 'Original Title' })
    const back = reopen(p).papers[0]
    expect(back.title).toBe('Original Title')
    expect(back.extra.metadataOriginal).toEqual({ title: 'Orignal Title' })
  })
})

describe('proposeFromPdf', () => {
  it('proposes only differing values that were not ignored, and never a year', () => {
    const current = { title: 'Orignal Title', authors: ['Ada Lovelace'], year: 2020 }
    const pdf = { title: 'Original Title', authors: ['lovelace, ada'], doi: '10.1/x', abstract: 'a' }
    expect(proposeFromPdf(current, pdf)).toEqual({ title: 'Original Title', doi: '10.1/x' })
    expect(proposeFromPdf(current, pdf, { title: 'ORIGINAL title' })).toEqual({ doi: '10.1/x' })
    expect(proposeFromPdf({ ...current, doi: 'https://doi.org/10.1/X' }, { doi: '10.1/x' })).toEqual({})
  })
})

describe('mergeSeatMetadata', () => {
  it('merges two annotators: unchanged fields keep the original, equal changes agree', () => {
    const p = project({ metadataEdit: 'annotation', reviewers: 2 })
    const paper = p.papers[0]
    applySeatEdit(paper, '1', { title: 'Original Title', year: 2021 })
    applySeatEdit(paper, '2', { title: 'Original Title', year: 2022 })
    const merged = mergeSeatMetadata(paper, ['1', '2'])
    expect(merged.map((m) => m.field)).toEqual(['title', 'year'])
    expect(merged[0]).toMatchObject({ agreed: true, seats: { '1': 'Original Title', '2': 'Original Title' } })
    expect(merged[1]).toMatchObject({ agreed: false, original: 2020, seats: { '1': 2021, '2': 2022 } })
  })

  it('treats a field only one seat changed as a disagreement', () => {
    const paper = project({ metadataEdit: 'annotation', reviewers: 2 }).papers[0]
    applySeatEdit(paper, '1', { doi: '10.1/x' })
    expect(mergeSeatMetadata(paper, ['1', '2'])).toEqual([
      { field: 'doi', original: null, seats: { '1': '10.1/x', '2': null }, agreed: false },
    ])
  })

  it('changes the fingerprint when a seat changes its overrides', () => {
    const paper = project({ metadataEdit: 'annotation', reviewers: 2 }).papers[0]
    applySeatEdit(paper, '1', { doi: '10.1/x' })
    const before = metadataFingerprint(paper, ['1', '2'])
    applySeatEdit(paper, '2', { doi: '10.1/x' })
    expect(metadataFingerprint(paper, ['1', '2'])).not.toBe(before)
  })
})

describe('editedFields', () => {
  it('names the fields the active seat sees as corrected', () => {
    const paper = project({ metadataEdit: 'annotation', reviewers: 2 }).papers[0]
    applySeatEdit(paper, '1', { authors: ['Ada King'] })
    expect(editedFields(paper, '1')).toEqual(['authors'])
    expect(editedFields(paper, '2')).toEqual([])
    expect(editedFields(paper, null)).toEqual([])
  })
})
