// [utest->req~dat-440~1]
// [utest->req~dat-450~1]
// [utest->req~ann-180~1]
// [utest->req~con-530~1]
import { describe, it, expect } from 'vitest'
import { useStore } from './store'
import { serializeProject } from '../model/project'
import { consolidationPending } from '../model/metadata'

const st = () => useStore.getState()
const paper = () => st().project!.papers[0]

function open(config: Record<string, unknown>) {
  st().loadFromText(
    JSON.stringify({
      version: 1,
      config: { schema: [{ name: 'A', type: 'string' }], ...config },
      papers: [
        { id: 'p1', title: 'Orignal Title', authors: ['Ada Lovelace'], year: 2020, pdf: 'p1.pdf', annotations: {} },
        { id: 'p2', title: 'Second', authors: [], pdf: 'p2.pdf', annotations: {} },
      ],
    }),
    null,
    'test.json',
  )
}

describe('applyMetadataEdits', () => {
  it('changes nothing while the mode is off', () => {
    open({})
    expect(st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'New' } }])).toBe(false)
    expect(paper().title).toBe('Orignal Title')
    expect(st().dirty).toBe(false)
  })

  it('writes a project correction in one undo step and keeps the paper id', () => {
    open({ metadataEdit: 'project' })
    const applied = st().applyMetadataEdits([
      { paperId: 'p1', values: { title: 'Original Title' } },
      { paperId: 'p2', values: { doi: '10.1/x' } },
    ])
    expect(applied).toBe(true)
    expect(st().project!.papers.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(paper().title).toBe('Original Title')
    expect(st().project!.papers[1].doi).toBe('10.1/x')
    expect(st().dirty).toBe(true)
    st().undo()
    expect(paper().title).toBe('Orignal Title')
    expect(st().project!.papers[1].doi).toBeUndefined()
  })

  it('returns false and adds no undo step when nothing changes', () => {
    open({ metadataEdit: 'project' })
    const before = st().past.length
    expect(st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Orignal Title' } }])).toBe(false)
    expect(st().past.length).toBe(before)
  })

  it('writes an annotator correction into that seat only', () => {
    open({ metadataEdit: 'annotation', reviewers: 2 })
    expect(st().applyMetadataEdits([{ paperId: 'p1', values: { year: 2021 } }])).toBe(false)
    st().selectReviewer('1')
    expect(st().applyMetadataEdits([{ paperId: 'p1', values: { year: 2021 } }])).toBe(true)
    expect(paper().year).toBe(2020)
    expect(paper().reviewMetadata).toEqual({ '1': { overrides: { year: 2021 } } })
  })

  it('remembers an ignored proposal', () => {
    open({ metadataEdit: 'project' })
    st().applyMetadataEdits([{ paperId: 'p1', ignore: { title: 'Junk' } }])
    expect(paper().title).toBe('Orignal Title')
    expect(JSON.parse(serializeProject(st().project!)).papers[0].metadataIgnored).toEqual({ title: 'Junk' })
  })
})

describe('metadata consolidation', () => {
  it('writes agreed values into the project file and settles the entry', () => {
    open({ metadataEdit: 'annotation', reviewers: 2 })
    st().selectReviewer('1')
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Original Title' } }])
    st().selectReviewer('2')
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Original Title' } }])
    st().selectReviewer('consolidation')
    st().applyMetadataEdits([{ paperId: 'p1', values: { title: 'Original Title' }, settle: true }])
    expect(paper().title).toBe('Original Title')
    expect(paper().extra.metadataOriginal).toEqual({ title: 'Orignal Title' })
    expect(consolidationPending(paper(), ['1', '2'])).toBe(false)
  })

  it('keeps the project value on Ignore', () => {
    open({ metadataEdit: 'annotation', reviewers: 2 })
    st().selectReviewer('1')
    st().applyMetadataEdits([{ paperId: 'p1', values: { doi: '10.1/x' } }])
    st().selectReviewer('consolidation')
    expect(st().applyMetadataEdits([{ paperId: 'p1', settle: true }])).toBe(true)
    expect(paper().doi).toBeUndefined()
    expect(paper().reviewMetadata?.['1']?.overrides).toEqual({ doi: '10.1/x' })
    expect(consolidationPending(paper(), ['1', '2'])).toBe(false)
    st().selectReviewer('2')
    st().applyMetadataEdits([{ paperId: 'p1', values: { doi: '10.1/y' } }])
    expect(consolidationPending(paper(), ['1', '2'])).toBe(true)
  })
})
