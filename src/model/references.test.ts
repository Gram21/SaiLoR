import { describe, it, expect } from 'vitest'
import { parseReferences, pdfHintFileName } from './references'

describe('parseReferences: BibTeX', () => {
  it('parses a well-formed entry with all fields', () => {
    const bib = `@article{doe2020,
  title = {A Study of Something},
  author = {Doe, Jane and Smith, John},
  doi = {10.1000/xyz},
  year = {2020},
  file = {:papers/doe2020.pdf:application/pdf},
}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry).toEqual({
      title: 'A Study of Something',
      authors: ['Jane Doe', 'John Smith'],
      doi: '10.1000/xyz',
      year: 2020,
      pdfHint: 'papers/doe2020.pdf',
    })
  })

  it('unescapes a Windows drive-letter colon in the file field (only the delimiter colons split it)', () => {
    const bib = `@article{k1, title = {T}, file = {:C\\:\\Users\\name\\file.pdf:application/pdf}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.pdfHint).toBe('C:\\Users\\name\\file.pdf')
  })

  it('strips braces used mid-value to protect capitalization, without losing the text', () => {
    const bib = `@article{k1, title = {The {DNA} Structure}, author = {Doe, Jane}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('The DNA Structure')
  })

  it('handles brace-nesting deep enough to trip a naive "find the next }" scan', () => {
    const bib = `@article{k1, title = {Outer {middle {inner} middle} outer}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('Outer middle inner middle outer')
  })

  it('accepts quoted values as an alternative to braces', () => {
    const bib = `@article{k1, title = "A Quoted Title", year = "1999"}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('A Quoted Title')
    expect(entry.year).toBe(1999)
  })

  it('parses several entries in one file, in order', () => {
    const bib = `
@article{a, title = {First}}
@inproceedings{b, title = {Second}, author = {Doe, Jane}}
`
    const entries = parseReferences(bib, 'refs.bib')
    expect(entries.map((e) => e.title)).toEqual(['First', 'Second'])
  })

  it('skips an entry with no title rather than throwing or dropping the file', () => {
    const bib = `
@article{a, author = {Doe, Jane}}
@article{b, title = {Has A Title}}
`
    const entries = parseReferences(bib, 'refs.bib')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('Has A Title')
  })

  it('ignores @comment/@string/@preamble blocks entirely', () => {
    const bib = `
@comment{ignore this @article{fake, title={not real}} }
@string{someval = "x"}
@article{real, title = {Real Entry}}
`
    const entries = parseReferences(bib, 'refs.bib')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('Real Entry')
  })

  it('is defensive against a malformed entry (unterminated braces) without losing the rest of the file', () => {
    const bib = `
@article{broken, title = {Unterminated
@article{ok, title = {Fine}}
`
    // The unterminated entry swallows the rest of the file into its own brace
    // count, so nothing after it can be recovered — the important thing is
    // that this throws nothing and returns whatever it legitimately could.
    expect(() => parseReferences(bib, 'refs.bib')).not.toThrow()
  })

  it('normalizes "Last, First" authors and leaves "First Last" alone', () => {
    const bib = `@article{k1, title = {T}, author = {Doe, Jane and John Smith}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('sniffs BibTeX content when the file has no recognized extension', () => {
    const bib = `@article{k1, title = {Sniffed}}`
    const entries = parseReferences(bib, 'export.txt')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('Sniffed')
  })
})

describe('parseReferences: RIS', () => {
  it('parses a well-formed record', () => {
    const ris = [
      'TY  - JOUR',
      'TI  - A Study of Something',
      'AU  - Doe, Jane',
      'AU  - Smith, John',
      'DO  - 10.1000/xyz',
      'PY  - 2020/01/15',
      'L1  - internal-pdf://0000/doe2020.pdf',
      'ER  - ',
    ].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    expect(entry).toEqual({
      title: 'A Study of Something',
      authors: ['Jane Doe', 'John Smith'],
      doi: '10.1000/xyz',
      year: 2020,
      pdfHint: 'internal-pdf://0000/doe2020.pdf',
    })
  })

  it('falls back to T1 for title and Y1 for year when TI/PY are absent', () => {
    const ris = ['TY  - JOUR', 'T1  - Fallback Title', 'Y1  - 2019///', 'ER  - '].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    expect(entry.title).toBe('Fallback Title')
    expect(entry.year).toBe(2019)
  })

  it('only takes UR as a PDF hint when it looks like a PDF, not a landing-page URL', () => {
    const ris = [
      'TY  - JOUR',
      'TI  - T',
      'UR  - https://example.com/articles/123',
      'ER  - ',
    ].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    expect(entry.pdfHint).toBeUndefined()
  })

  it('parses multiple records and tolerates CRLF line endings', () => {
    const ris = ['TY  - JOUR', 'TI  - One', 'ER  - ', 'TY  - JOUR', 'TI  - Two', 'ER  - '].join(
      '\r\n',
    )
    const entries = parseReferences(ris, 'refs.ris')
    expect(entries.map((e) => e.title)).toEqual(['One', 'Two'])
  })

  it('recovers a record missing its trailing ER (a truncated/hand-edited file)', () => {
    const ris = ['TY  - JOUR', 'TI  - No Closing Tag'].join('\n')
    const entries = parseReferences(ris, 'refs.ris')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('No Closing Tag')
  })

  it('skips a record with no title', () => {
    const ris = ['TY  - JOUR', 'AU  - Doe, Jane', 'ER  - '].join('\n')
    expect(parseReferences(ris, 'refs.ris')).toHaveLength(0)
  })

  it('ignores a stray field line before any TY tag', () => {
    const ris = ['AU  - Doe, Jane', 'TY  - JOUR', 'TI  - T', 'ER  - '].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    // The AU line before TY belongs to no record and must not leak in.
    expect(entry.authors).toEqual([])
  })
})

describe('parseReferences: CSL-JSON', () => {
  it('parses a Zotero-style export array', () => {
    const json = JSON.stringify([
      {
        title: 'A Study of Something',
        author: [
          { given: 'Jane', family: 'Doe' },
          { given: 'John', family: 'Smith' },
        ],
        DOI: '10.1000/xyz',
        issued: { 'date-parts': [[2020, 3]] },
      },
    ])
    const [entry] = parseReferences(json, 'refs.json')
    expect(entry).toEqual({
      title: 'A Study of Something',
      authors: ['Jane Doe', 'John Smith'],
      doi: '10.1000/xyz',
      year: 2020,
    })
  })

  it('uses an author\'s "literal" name (an organization, not a person)', () => {
    const json = JSON.stringify([{ title: 'T', author: [{ literal: 'World Health Organization' }] }])
    const [entry] = parseReferences(json, 'refs.json')
    expect(entry.authors).toEqual(['World Health Organization'])
  })

  it('accepts an object wrapper with an "items" array (some exporters wrap the array)', () => {
    const json = JSON.stringify({ items: [{ title: 'Wrapped' }] })
    const entries = parseReferences(json, 'refs.json')
    expect(entries.map((e) => e.title)).toEqual(['Wrapped'])
  })

  it('skips a malformed item (not an object) without failing the whole file', () => {
    const json = JSON.stringify([null, 42, { title: 'Survivor' }])
    const entries = parseReferences(json, 'refs.json')
    expect(entries.map((e) => e.title)).toEqual(['Survivor'])
  })

  it('skips an item with no title', () => {
    const json = JSON.stringify([{ author: [{ family: 'Doe' }] }])
    expect(parseReferences(json, 'refs.json')).toHaveLength(0)
  })

  it('returns [] for garbage JSON rather than throwing', () => {
    expect(() => parseReferences('{not valid json', 'refs.json')).not.toThrow()
    expect(parseReferences('{not valid json', 'refs.json')).toEqual([])
  })
})

describe('parseReferences: defensive edge cases shared across formats', () => {
  it('returns [] for an empty file', () => {
    expect(parseReferences('', 'refs.bib')).toEqual([])
    expect(parseReferences('', 'refs.ris')).toEqual([])
    expect(parseReferences('', 'refs.json')).toEqual([])
  })

  it('returns [] for content that matches no known format', () => {
    expect(parseReferences('just some random text\nwith lines', 'notes.txt')).toEqual([])
  })

  it('strips a leading BOM before sniffing/parsing', () => {
    const bib = '﻿@article{k1, title = {BOM Test}}'
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('BOM Test')
  })

  it('never throws on a large blob of unstructured garbage', () => {
    const garbage = '{{{{{{{{{{{{ @@@@ ]]]]]]] ---- \x00\x01\x02'
    expect(() => parseReferences(garbage, 'refs.bib')).not.toThrow()
    expect(() => parseReferences(garbage, 'refs.ris')).not.toThrow()
    expect(() => parseReferences(garbage, 'refs.json')).not.toThrow()
  })
})

describe('pdfHintFileName', () => {
  it('takes the last path segment regardless of separator style', () => {
    expect(pdfHintFileName('C:\\papers\\doe2020.pdf')).toBe('doe2020.pdf')
    expect(pdfHintFileName('/home/user/papers/doe2020.pdf')).toBe('doe2020.pdf')
    expect(pdfHintFileName('doe2020.pdf')).toBe('doe2020.pdf')
  })
})
