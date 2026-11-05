// [utest->req~dat-530~1]
// [utest->req~dat-540~1]
// [utest->req~dat-550~1]
// [utest->req~dat-560~1]
// [utest->req~dat-570~1]
// [utest->req~lst-90~1]
import { describe, it, expect } from 'vitest'
import {
  missingPaperIds,
  newPaper,
  newPdfFiles,
  parseCrossrefWork,
  pdfFolderProblem,
  proposeNewPaper,
} from './pdfFolder'
import { loadProject, serializeProject } from './project'

const base = { version: 1, config: { schema: [{ name: 'A', type: 'string' }] }, papers: [{ id: 'a', title: 'A', pdf: 'pdfs/a.pdf' }] }

describe('pdfFolderProblem', () => {
  it('allows nested relative folders and refuses escapes', () => {
    expect(pdfFolderProblem('pdfs')).toBeNull()
    expect(pdfFolderProblem('pdfs/new')).toBeNull()
    expect(pdfFolderProblem('../pdfs')).not.toBeNull()
    expect(pdfFolderProblem('/abs')).not.toBeNull()
    expect(pdfFolderProblem('a//b')).not.toBeNull()
    expect(pdfFolderProblem('.git')).not.toBeNull()
  })
})

describe('pdf folder settings round trip', () => {
  it('keeps an old project unchanged', () => {
    const p = loadProject(base)
    expect(p.pdfFolder).toBeUndefined()
    expect(p.crossrefLookup).toBeUndefined()
    const config = JSON.parse(serializeProject(p)).config
    expect(config).not.toHaveProperty('pdfFolder')
    expect(config).not.toHaveProperty('crossrefLookup')
  })

  it('reads and writes the folder, and only true turns the lookup on', () => {
    const on = loadProject({ ...base, config: { ...base.config, pdfFolder: 'pdfs', crossrefLookup: true } })
    expect(on).toMatchObject({ pdfFolder: 'pdfs', crossrefLookup: true })
    expect(JSON.parse(serializeProject(on)).config).toMatchObject({ pdfFolder: 'pdfs', crossrefLookup: true })
    const odd = loadProject({ ...base, config: { ...base.config, crossrefLookup: 'true' } })
    expect(odd.crossrefLookup).toBeUndefined()
  })

  it('keeps hash, sources and ignored files through extra', () => {
    const p = loadProject({
      ...base,
      ignoredPdfs: ['h2'],
      papers: [{ ...base.papers[0], pdfSha256: 'h1', metadataSource: { title: 'pdfinfo' } }],
    })
    const out = JSON.parse(serializeProject(p))
    expect(out.ignoredPdfs).toEqual(['h2'])
    expect(out.papers[0]).toMatchObject({ pdfSha256: 'h1', metadataSource: { title: 'pdfinfo' } })
  })
})

describe('newPdfFiles', () => {
  const scan = {
    files: [
      { path: 'pdfs/a.pdf', sha256: 'h1' },
      { path: 'pdfs/renamed.pdf', sha256: 'h2' },
      { path: 'pdfs/new.pdf', sha256: 'h3' },
      { path: 'pdfs/copy.pdf', sha256: 'h3' },
      { path: 'pdfs/ignored.pdf', sha256: 'h4' },
    ],
    known: ['h1'],
  }

  it('matches by hash, not by name, and gives one entry per hash', () => {
    const papers = [{ extra: {} }, { extra: { pdfSha256: 'h2' } }]
    expect(newPdfFiles(papers, scan, ['h4'])).toEqual([{ path: 'pdfs/new.pdf', sha256: 'h3' }])
  })

  it('offers nothing on a second scan after the file was added', () => {
    const papers = [{ extra: {} }, { extra: { pdfSha256: 'h2' } }, { extra: { pdfSha256: 'h3' } }]
    expect(newPdfFiles(papers, scan, ['h4'])).toEqual([])
  })
})

describe('missingPaperIds', () => {
  it('lists the papers whose file is missing', () => {
    expect(missingPaperIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['h', 'missing', null])).toEqual(['b'])
  })
})

describe('proposeNewPaper', () => {
  const file = { path: 'pdfs/smith_2020-deep.pdf', sha256: 'h' }

  it('takes the PDF information and records its source', () => {
    const p = proposeNewPaper(file, { title: 'Deep', authors: ['A B'], doi: '10.1/x' })
    expect(p.values).toEqual({ title: 'Deep', authors: ['A B'], doi: '10.1/x' })
    expect(p.sources).toEqual({ title: 'pdfinfo', authors: 'pdfinfo', doi: 'pdfinfo' })
  })

  it('lets Crossref replace PDF values', () => {
    const p = proposeNewPaper(file, { title: 'Deep', doi: '10.1/x' }, { title: 'Deep Learning', year: 2020 })
    expect(p.values).toMatchObject({ title: 'Deep Learning', year: 2020, doi: '10.1/x' })
    expect(p.sources).toEqual({ title: 'crossref', year: 'crossref', doi: 'pdfinfo' })
  })

  it('falls back to the file name for the title', () => {
    const p = proposeNewPaper(file, { authors: [] })
    expect(p.values).toEqual({ title: 'smith 2020 deep' })
    expect(p.sources).toEqual({ title: 'filename' })
  })
})

describe('parseCrossrefWork', () => {
  it('reads title, authors, year and DOI', () => {
    const body = JSON.stringify({
      message: {
        title: ['  Deep\n Learning '],
        author: [{ given: 'Ada', family: 'Lovelace' }, { family: 'Turing' }],
        'published-print': { 'date-parts': [[2019, 3]] },
        DOI: '10.1/X',
      },
    })
    expect(parseCrossrefWork(body)).toEqual({ title: 'Deep Learning', authors: ['Ada Lovelace', 'Turing'], year: 2019, doi: '10.1/X' })
  })

  it('returns nothing for a bad answer', () => {
    expect(parseCrossrefWork('<html>')).toEqual({})
    expect(parseCrossrefWork('{}')).toEqual({})
  })
})

describe('newPaper', () => {
  const proposal = proposeNewPaper({ path: 'pdfs/a.pdf', sha256: 'h' }, { title: 'T', doi: '10.1/x' })
  const project = { schema: [], reviewers: 2 }

  it('takes the id from the file name with a suffix when taken', () => {
    expect(newPaper(project, proposal, new Set()).id).toBe('a')
    expect(newPaper(project, proposal, new Set(['a', 'a-2'])).id).toBe('a-3')
  })

  it('stores the hash, the sources and one review per seat', () => {
    const p = newPaper(project, proposal, new Set())
    expect(p).toMatchObject({ title: 'T', doi: '10.1/x', pdf: 'pdfs/a.pdf', authors: [], finished: false })
    expect(p.extra).toEqual({ pdfSha256: 'h', metadataSource: { title: 'pdfinfo', doi: 'pdfinfo' } })
    expect(Object.keys(p.reviews)).toEqual(['1', '2'])
  })
})
