import { describe, it, expect } from 'vitest'
import { loadProject } from './project'
import { screeningMarksByPaper } from './screeningMarks'

const mark = (id: string) => ({
  id,
  page: 1,
  kind: 'highlight',
  rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.05 }],
  color: '#ffe066',
  comment: '',
  createdAt: '',
  updatedAt: '',
})

const screening = loadProject({
  version: 1,
  config: { reviewers: 2, screening: { reasons: ['Off topic'] } },
  papers: [
    { id: 'p1', title: 'First paper', authors: ['Ann'], pdf: 'p1.pdf', annotations: {}, reviewMarks: { 2: [mark('s2')], 1: [mark('s1')] }, marks: [mark('c')] },
    { id: 'p2', title: 'Second paper', authors: ['Bo'], doi: '10.1/two', pdf: 'p2.pdf', annotations: {}, reviewMarks: { 1: [mark('d')] } },
    { id: 'p3', title: 'Third paper', authors: [], pdf: 'p3.pdf', annotations: {} },
  ],
})

const annotation = (papers: object[]) =>
  loadProject({ version: 1, config: { schema: [{ name: 'N', type: 'string' }] }, papers })

describe('screeningMarksByPaper', () => {
  it('finds a paper by id, or by the id the import gave it', () => {
    const marks = screeningMarksByPaper(
      annotation([
        { id: 'p1', title: 'x', authors: [], pdf: 'p1.pdf', annotations: {} },
        { id: 'p2-2', title: 'y', authors: [], pdf: 'p2.pdf', annotations: {} },
      ]),
      screening,
    )
    expect(marks.p1.map((m) => `${m.seat}:${m.mark.id}`)).toEqual(['consolidated:c', '1:s1', '2:s2'])
    expect(marks['p2-2'].map((m) => m.mark.id)).toEqual(['d'])
  })

  it('finds a renamed paper by its DOI', () => {
    const marks = screeningMarksByPaper(
      annotation([{ id: 'renamed', title: 'Other title', authors: [], doi: '10.1/two', pdf: 'p2.pdf', annotations: {} }]),
      screening,
    )
    expect(marks.renamed.map((m) => m.mark.id)).toEqual(['d'])
  })

  it('leaves out papers with no screening highlights, or no counterpart', () => {
    const marks = screeningMarksByPaper(
      annotation([
        { id: 'p3', title: 'Third paper', authors: [], pdf: 'p3.pdf', annotations: {} },
        { id: 'new', title: 'Unrelated', authors: [], pdf: 'n.pdf', annotations: {} },
      ]),
      screening,
    )
    expect(marks).toEqual({})
  })
})
