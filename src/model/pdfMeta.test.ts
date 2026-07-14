import { describe, it, expect } from 'vitest'
import {
  parseAuthorList,
  isPlausibleTitle,
  cleanTitle,
  titleAndAuthorsFromLines,
} from './pdfMeta'

describe('parseAuthorList', () => {
  it('splits the usual separators', () => {
    expect(parseAuthorList('Jane Doe, John Smith and Ada Lovelace')).toEqual([
      'Jane Doe',
      'John Smith',
      'Ada Lovelace',
    ])
    expect(parseAuthorList('Jane Doe; John Smith')).toEqual(['Jane Doe', 'John Smith'])
    expect(parseAuthorList('Jane Doe & John Smith')).toEqual(['Jane Doe', 'John Smith'])
  })

  it('strips the affiliation markers that cling to names in a PDF text layer', () => {
    expect(parseAuthorList('Jane Doe¹, John Smith²*')).toEqual(['Jane Doe', 'John Smith'])
    expect(parseAuthorList('Jane Doe 1, John Smith 2')).toEqual(['Jane Doe', 'John Smith'])
    expect(parseAuthorList('Jane Doe†, John Smith‡')).toEqual(['Jane Doe', 'John Smith'])
  })

  it('drops affiliations and emails that are not people', () => {
    expect(parseAuthorList('Jane Doe, Karlsruhe Institute of Technology')).toEqual(['Jane Doe'])
    expect(parseAuthorList('Jane Doe, jane@example.edu')).toEqual(['Jane Doe'])
    expect(parseAuthorList('Department of Computer Science')).toEqual([])
  })

  it('strips a leading "Authors:" label', () => {
    expect(parseAuthorList('Authors: A. Author, B. Writer')).toEqual(['A. Author', 'B. Writer'])
    expect(parseAuthorList('By Jane Doe')).toEqual(['Jane Doe'])
  })

  it('in strict mode, rejects prose that is not a list of names', () => {
    // The layout heuristic can land on a body line; it must not become "authors".
    expect(parseAuthorList('Multi-page test PDF with an internal link.', true)).toEqual([])
    expect(parseAuthorList('We evaluate deep learning approaches for code search.', true)).toEqual([])
    // Real names still pass, including lower-case particles.
    expect(parseAuthorList('Jane van der Berg, A. Author', true)).toEqual([
      'Jane van der Berg',
      'A. Author',
    ])
  })

  it('is lenient by default so metadata forms like "Doe, Jane" survive', () => {
    expect(parseAuthorList('Doe, Jane')).toEqual(['Doe', 'Jane'])
  })
})

describe('isPlausibleTitle', () => {
  it('accepts a real title', () => {
    expect(isPlausibleTitle('Deep Learning for Code Search: A Study')).toBe(true)
  })

  it('rejects the junk that publisher toolchains leave in the metadata', () => {
    expect(isPlausibleTitle('Microsoft Word - paper_final_v3.doc')).toBe(false)
    expect(isPlausibleTitle('untitled')).toBe(false)
    expect(isPlausibleTitle('smith2024.pdf')).toBe(false)
    expect(isPlausibleTitle('Paper')).toBe(false)
    expect(isPlausibleTitle('12345')).toBe(false)
    expect(isPlausibleTitle('short')).toBe(false)
  })
})

describe('cleanTitle', () => {
  it('collapses the whitespace a wrapped title picks up', () => {
    expect(cleanTitle('  Deep   Learning\n for  Code Search ')).toBe('Deep Learning for Code Search')
  })
})

describe('titleAndAuthorsFromLines', () => {
  // A page is 792pt tall; y counts up from the bottom, so the title sits high.
  const page = 792
  const line = (y: number, size: number, text: string) => ({ y, size, text })

  it('takes the largest text at the top as the title and the line below as authors', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'Deep Learning for Code Search'),
        line(670, 11, 'Jane Doe, John Smith'),
        line(650, 10, 'Karlsruhe Institute of Technology'),
        line(600, 10, 'Abstract'),
        line(580, 10, 'We evaluate deep learning approaches.'),
      ],
      page,
    )
    expect(meta.title).toBe('Deep Learning for Code Search')
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('joins a title that wraps across lines of the same size', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'Deep Learning for Code Search:'),
        line(680, 18, 'An Empirical Study'),
        line(650, 11, 'Jane Doe'),
      ],
      page,
    )
    expect(meta.title).toBe('Deep Learning for Code Search: An Empirical Study')
    expect(meta.authors).toEqual(['Jane Doe'])
  })

  it('stops at the abstract rather than swallowing body text as authors', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(660, 10, 'Abstract')],
      page,
    )
    expect(meta.title).toBe('A Title That Is Long Enough')
    expect(meta.authors).toBeUndefined()
  })

  it('ignores lines in the lower half of the page', () => {
    expect(titleAndAuthorsFromLines([line(100, 20, 'Footer Text Here')], page)).toEqual({})
  })

  it('does not mistake a body sentence under the title for authors', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'Multi-page Test Document'),
        line(670, 11, 'Multi-page test PDF with an internal link.'),
      ],
      page,
    )
    expect(meta.title).toBe('Multi-page Test Document')
    expect(meta.authors).toBeUndefined()
  })

  it('strips an "Authors:" label from the author line', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'Deep Learning for Code Search'),
        line(670, 11, 'Authors: A. Author, B. Writer'),
      ],
      page,
    )
    expect(meta.authors).toEqual(['A. Author', 'B. Writer'])
  })

  it('returns nothing rather than a bad guess when the title is implausible', () => {
    const meta = titleAndAuthorsFromLines([line(700, 18, 'Fig'), line(670, 11, 'Jane Doe')], page)
    expect(meta.title).toBeUndefined()
  })
})
