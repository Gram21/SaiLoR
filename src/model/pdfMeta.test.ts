import { describe, it, expect } from 'vitest'
import {
  parseAuthorList,
  isPlausibleTitle,
  cleanTitle,
  titleAndAuthorsFromLines,
  abstractFromLines,
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
  /** A single-column line: one segment, the whole text. `segments` is what a
   *  column gap would have split — see the two-column case below. */
  const line = (y: number, size: number, text: string) => ({ y, size, text, segments: [text] })
  /** A line whose runs sat in separate columns, as a two-column author block does. */
  const columns = (y: number, size: number, segments: string[]) => ({
    y,
    size,
    text: segments.join(' '),
    segments,
  })

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

  // The regression this splitting exists for: a two-column author block puts
  // both names on one baseline with nothing but a gutter between them, so the
  // line reads "Jan KeimAngelika Kaplan" if the columns are joined before
  // parsing. There is no punctuation to recover them by afterwards.
  it('reads a two-column author block as separate people, not one glued name', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'From Scattered to Structured'),
        columns(670, 11, ['Jan Keim', 'Angelika Kaplan']),
        columns(650, 10, ['jan.keim@kit.edu', 'angelika.kaplan@kit.edu']),
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jan Keim', 'Angelika Kaplan'])
  })

  it('still reads a comma-separated single-column author line', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(670, 11, 'Jane Doe, John Smith')],
      page,
    )
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

describe('abstractFromLines', () => {
  const line = (y: number, size: number, text: string) => ({ y, size, text, segments: [text] })
  const columns = (y: number, size: number, segments: string[]) => ({
    y,
    size,
    text: segments.join(' '),
    segments,
  })

  // Font size 18 is the title's — the single largest text on the page, which
  // is exactly what the "Abstract" heading (size 10, well below it) must not
  // be mistaken for. Placed high on the page, same as a real front matter
  // block, since the guard is about size, not position (see the function's
  // own doc comment for why a position-only guard was wrong).
  const FRONT_MATTER = [
    line(700, 18, 'Deep Learning for Code Search'),
    line(670, 11, 'Jane Doe, John Smith'),
  ]
  const SENTENCE_1 =
    'We evaluate deep learning approaches for code search on a large benchmark of query-code pairs.'
  const SENTENCE_2 =
    'Our model improves mean reciprocal rank by 12% over prior retrieval baselines on this benchmark.'

  it('captures the text between an Abstract heading and Introduction', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      line(585, 10, SENTENCE_1),
      line(570, 10, SENTENCE_2),
      line(555, 10, '1 Introduction'),
      line(540, 10, 'Code search is a longstanding problem in software engineering.'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
    expect(abstract).not.toContain('Introduction')
    expect(abstract).not.toContain('longstanding')
  })

  it('reads an IEEE-style same-line lead-in ("Abstract—...")', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, `Abstract—${SENTENCE_1}`),
      line(585, 10, SENTENCE_2),
      line(570, 10, 'Index Terms'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
  })

  it('is case-insensitive and tolerates a colon lead-in', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, `ABSTRACT: ${SENTENCE_1}`),
      line(585, 10, SENTENCE_2),
      line(570, 10, 'Keywords'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
  })

  it('stops at Keywords as readily as at Introduction', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      line(585, 10, SENTENCE_1),
      line(570, 10, SENTENCE_2),
      line(555, 10, 'Keywords: code search, deep learning'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
  })

  it('returns nothing when no Abstract heading is found', () => {
    expect(abstractFromLines(FRONT_MATTER)).toBeUndefined()
  })

  it('does not mistake a title that starts with the word "Abstract" for the heading', () => {
    // "Abstract Interpretation..." is a real, if uncommon, title pattern. It
    // is set in the page's largest font (size 18, same as any other title),
    // which is what the size guard uses to tell it apart from a genuine
    // "Abstract" heading — those are never the single biggest text on a page.
    const abstract = abstractFromLines([
      line(700, 18, 'Abstract Interpretation of Concurrent Programs'),
      line(670, 11, 'Jane Doe'),
    ])
    expect(abstract).toBeUndefined()
  })

  it('finds the heading even when it sits in the upper half of the page', () => {
    // A short title/author block leaves the abstract starting well above the
    // page's vertical midpoint — the exact case a now-removed position-based
    // guard used to reject. Page is 792pt tall; y=600 is above the midpoint.
    const abstract = abstractFromLines([
      line(760, 18, 'A Short Title'),
      line(735, 11, 'Jane Doe'),
      line(710, 10, 'Abstract'),
      line(695, 10, SENTENCE_1),
      line(680, 10, SENTENCE_2),
      line(665, 10, 'Introduction'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
  })

  it('stops at a two-column body it cannot safely read in order', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      line(585, 10, SENTENCE_1),
      line(570, 10, SENTENCE_2),
      // A baseline split into two columns — the two-column body has begun.
      columns(400, 10, ['Left column text.', 'Right column text.']),
      line(385, 10, 'More right-column text that must never be reached.'),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
    expect(abstract).not.toContain('must never be reached')
  })

  it('rejects a match that is implausibly short', () => {
    expect(abstractFromLines([...FRONT_MATTER, line(600, 10, 'Abstract'), line(585, 10, 'Too short.')])).toBeUndefined()
  })
})
