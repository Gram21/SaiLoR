// [utest->req~pdf-170~1]
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  parseAuthorList,
  isPlausibleTitle,
  cleanTitle,
  titleAndAuthorsFromLines,
  abstractFromLines,
  extractPdfMeta,
  findDoi,
  toLines,
} from './pdfMeta'
import { pdfjs } from '../platform/pdfjs'

// [utest->req~dat-470~1]
describe('findDoi', () => {
  it('finds a bare or linked DOI and trims trailing punctuation', () => {
    expect(findDoi('DOI: 10.18420/se2026-21.')).toBe('10.18420/se2026-21')
    expect(findDoi('see https://doi.org/10.1145/3593434.3593468), p. 3')).toBe('10.1145/3593434.3593468')
  })

  it('ignores text without a DOI, including a template placeholder', () => {
    expect(findDoi('https://doi.org/XXXXXXX.XXXXXXX')).toBeUndefined()
    expect(findDoi('Version 10.2 of the tool')).toBeUndefined()
  })
})

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

  it('keeps names starting with a non-ASCII capital in strict mode', () => {
    // Regression: strict `looksLikeName` tested `/^[A-Z]/`, so a name led by a
    // non-ASCII upper-case letter was dropped as if it were prose.
    expect(parseAuthorList('Łukasz Kaiser, Jane Doe', true)).toEqual(['Łukasz Kaiser', 'Jane Doe'])
    expect(parseAuthorList('Ángel Cuadra and Øystein Nordvik', true)).toEqual([
      'Ángel Cuadra',
      'Øystein Nordvik',
    ])
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

  it('strips affiliation digits only at the start or end of a name', () => {
    expect(parseAuthorList('Jane Doe, 1 John Smith')).toEqual(['Jane Doe', 'John Smith'])
    expect(parseAuthorList('12 Jane Doe')).toEqual(['Jane Doe'])
    expect(parseAuthorList('1Jane Doe')).toEqual(['Jane Doe'])
    expect(parseAuthorList('Jane Doe1')).toEqual(['Jane Doe'])
    expect(parseAuthorList('Jane Doe 12')).toEqual(['Jane Doe'])
    expect(parseAuthorList('Jane 2 Doe')).toEqual(['Jane 2 Doe'])
    expect(parseAuthorList('Jane   Doe')).toEqual(['Jane Doe'])
  })

  it('keeps names of 3 to 60 characters that contain a letter', () => {
    expect(parseAuthorList('Al, Ann')).toEqual(['Ann'])
    expect(parseAuthorList(`${'x'.repeat(56)} Doe, ${'x'.repeat(57)} Doe`)).toEqual([`${'x'.repeat(56)} Doe`])
    expect(parseAuthorList('Jane Doe, ...')).toEqual(['Jane Doe'])
  })

  it('in strict mode, takes 2 to 5 tokens that each start upper-case or are a particle', () => {
    expect(parseAuthorList('Jane Mary Ann van Berg', true)).toEqual(['Jane Mary Ann van Berg'])
    expect(parseAuthorList('Jane Mary Ann Lee Van Berg', true)).toEqual([])
    expect(parseAuthorList('Jane doe', true)).toEqual([])
    expect(parseAuthorList('Jane deVries', true)).toEqual([])
  })

  it('is lenient by default so metadata forms like "Doe, Jane" survive', () => {
    expect(parseAuthorList('Doe, Jane')).toEqual(['Doe', 'Jane'])
  })

  it('recomposes an accented letter the metadata Author field carries decomposed', () => {
    // Built from escapes, not literal glyphs, so the source can't silently
    // carry the wrong codepoint: \u0065\u0301 is "e" + COMBINING ACUTE
    // ACCENT (two codepoints), not one precomposed "\u00e9". Some PDF
    // producers write the Author metadata field this way, independently of
    // whatever the text layer does (see the identical fix in `toLines`).
    const decomposed = `Ren\u0065\u0301 Dupont`
    expect(decomposed).not.toBe(decomposed.normalize('NFC')) // sanity: genuinely decomposed
    expect(parseAuthorList(decomposed)).toEqual(['Ren\u00e9 Dupont'])
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

  it('measures 6 to 300 characters after trimming', () => {
    expect(isPlausibleTitle('ab cd')).toBe(false)
    expect(isPlausibleTitle('ab cde')).toBe(true)
    expect(isPlausibleTitle('   ab c')).toBe(false)
    expect(isPlausibleTitle(`${'a'.repeat(297)} bc`)).toBe(true)
    expect(isPlausibleTitle(`${'a'.repeat(298)} bc`)).toBe(false)
  })

  it('rejects a junk prefix, a trailing file extension and a single word on their own', () => {
    expect(isPlausibleTitle('Untitled Draft Copy')).toBe(false)
    expect(isPlausibleTitle('final paper.doc')).toBe(false)
    expect(isPlausibleTitle('Reading .pdf Files Safely')).toBe(true)
    expect(isPlausibleTitle('Introductions')).toBe(false)
    expect(isPlausibleTitle('Deep Learning')).toBe(true)
  })
})

describe('cleanTitle', () => {
  it('collapses the whitespace a wrapped title picks up', () => {
    expect(cleanTitle('  Deep   Learning\n for  Code Search ')).toBe('Deep Learning for Code Search')
  })

  it('recomposes an accented letter the metadata Title field carries decomposed', () => {
    // \u0065\u0301 is "e" + COMBINING ACUTE ACCENT (two codepoints), not
    // one precomposed "\u00e9" — built from escapes so the source can't
    // silently carry the wrong one.
    const decomposed = `Caf\u0065\u0301 Culture`
    expect(decomposed).not.toBe(decomposed.normalize('NFC')) // sanity: genuinely decomposed
    expect(cleanTitle(decomposed)).toBe('Caf\u00e9 Culture')
  })
})

describe('toLines', () => {
  it('recomposes an accented letter split across two adjacent items, in both the line and its segment text', () => {
    // Some fonts' ToUnicode maps hand pdf.js a base letter and a combining
    // mark as separate items ("e" + U+0301) rather than one precomposed
    // "\u00e9" — normalizing must happen after the items are joined into a
    // line/segment, not per-item, since the pieces to recompose straddle
    // the item boundary the join crosses.
    const items = [
      { str: 'Caf', transform: [0, 0, 0, 10, 0, 100] },
      { str: 'e', transform: [0, 0, 0, 10, 20, 100] },
      { str: '\u0301', transform: [0, 0, 0, 10, 25, 100] },
    ]
    const lines = toLines(items)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('Caf\u00e9')
    expect(lines[0].segments).toEqual([{ x: 0, text: 'Caf\u00e9' }])
  })

  const at = (str: string, x: number, width?: number, size = 10, y = 100) => ({
    str,
    transform: [0, 0, 0, size, x, y],
    width,
  })

  it('splits a line at a gap wider than 1.5 times the font size, and joins the columns with a space', () => {
    const lines = toLines([at('Jan  Keim ', 50, 40), at('Angelika Kaplan', 300, 70)])
    expect(lines).toStrictEqual([
      {
        y: 100,
        size: 10,
        text: 'Jan Keim Angelika Kaplan',
        segments: [
          { x: 50, text: 'Jan Keim' },
          { x: 300, text: 'Angelika Kaplan' },
        ],
      },
    ])
  })

  it('does not split at a gap of exactly 1.5 times the font size', () => {
    expect(toLines([at('A', 0, 10), at('B', 25, 10)])[0].segments).toEqual([{ x: 0, text: 'AB' }])
  })

  it('never splits after a run of zero width', () => {
    expect(toLines([at('Foo', 0, 0), at('Bar', 100, 0)])[0].segments).toEqual([{ x: 0, text: 'FooBar' }])
  })

  it('ignores a whitespace-only item, even for the font size', () => {
    expect(toLines([at('Title', 0, 20), at('  ', 30, 5, 30)])).toStrictEqual([
      { y: 100, size: 10, text: 'Title', segments: [{ x: 0, text: 'Title' }] },
    ])
  })
})

// Realistic left/right column x positions for a two-column letter page — the
// gutter between them (~264pt) dwarfs `abstractFromLines`'s own 12pt
// same-column tolerance, exactly as a real layout does.
const LEFT_X = 53
const RIGHT_X = 317

/** A single-column line: one segment, the whole text, at the left margin. */
const line = (y: number, size: number, text: string) => ({
  y,
  size,
  text,
  segments: [{ x: LEFT_X, text }],
})

/** A line whose runs sat in separate columns, as a two-column body line does. */
const columns = (y: number, size: number, texts: string[]) => ({
  y,
  size,
  text: texts.join(' '),
  segments: texts.map((text, i) => ({ x: i === 0 ? LEFT_X : RIGHT_X, text })),
})

describe('titleAndAuthorsFromLines', () => {
  // A page is 792pt tall; y counts up from the bottom, so the title sits high.
  const page = 792

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

  it('continues a wrapped author list onto the next line', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith, Ada'),
        line(658, 11, 'Lovelace, and Alan Turing'),
      ],
      page,
    )
    // "Ada" / "Lovelace" is the point: split across the break, it survives only
    // because the lines are joined before being parsed into names.
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace', 'Alan Turing'])
  })

  it('steps over a row of superscript affiliation keys inside a wrapped list', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith, Ada'),
        line(662, 7, '1 2'), // superscripts on their own raised baseline
        line(658, 11, 'Lovelace, and Alan Turing'),
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace', 'Alan Turing'])
  })

  // The reason growing the block is guarded rather than unconditional: the line
  // under the authors is usually an affiliation, and absorbing one does not add
  // names, it destroys them — the last author fuses with it into an entry
  // parseAuthorList then drops wholesale.
  it('does not absorb the affiliation line below the authors', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith'),
        line(658, 11, 'Karlsruhe Institute of Technology'), // same size as the authors
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('does not absorb an email row below the authors', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith'),
        line(658, 11, 'jane@example.edu, john@example.edu'),
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('continues each column of a two-column author block on its own', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        columns(670, 11, ['Jan Keim, Ada', 'Angelika Kaplan, Alan']),
        columns(658, 11, ['Lovelace', 'Turing']),
      ],
      page,
    )
    // Each column's wrap is joined to its own column, matched by x — never
    // across the gutter, which would invent "Ada Turing".
    expect(meta.authors).toEqual(['Jan Keim', 'Ada Lovelace', 'Angelika Kaplan', 'Alan Turing'])
  })

  it('still stops at the abstract when it directly follows the authors', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith'),
        line(658, 11, 'Abstract'),
        line(640, 11, 'We evaluate approaches for code search and find them wanting.'),
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('reads only lines strictly above 45% of the page height', () => {
    expect(titleAndAuthorsFromLines([line(450, 20, 'Footer Text Here')], 1000)).toEqual({})
  })

  it('takes title lines within 0.5pt of the largest size, up to the last line', () => {
    const meta = titleAndAuthorsFromLines(
      [line(720, 17.5, 'Deep Learning'), line(700, 18, 'for Code'), line(680, 17.5, 'Search Today')],
      page,
    )
    expect(meta).toStrictEqual({ title: 'Deep Learning for Code Search Today' })
  })

  it('ends the title at a title-sized Abstract heading', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(680, 18, 'Abstract')],
      page,
    )
    expect(meta).toStrictEqual({ title: 'A Title That Is Long Enough' })
  })

  it('looks for the author line only in the 4 lines below the title', () => {
    const filler = ['Institute of Testing', 'University of Examples', 'jane@example.edu']
    const lines = (extra: string[]) => [
      line(700, 18, 'A Title That Is Long Enough'),
      ...[...filler, ...extra, 'Jane Doe'].map((text, n) => line(680 - n * 12, 11, text)),
    ]
    expect(titleAndAuthorsFromLines(lines([]), page).authors).toEqual(['Jane Doe'])
    expect(titleAndAuthorsFromLines(lines(['Department of Samples']), page).authors).toBeUndefined()
  })

  it('takes no author line below a smaller Abstract heading', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(670, 11, 'Abstract'), line(650, 11, 'Jane Doe')],
      page,
    )
    expect(meta.authors).toBeUndefined()
  })

  it('looks for a wrapped list up to 3 lines below the author line', () => {
    const lines = (superscripts: number) => [
      line(700, 18, 'A Title That Is Long Enough'),
      line(670, 11, 'Jane Doe, John Smith, Ada'),
      ...Array.from({ length: superscripts }, (_, n) => line(664 - n * 2, 7, '1 2')),
      line(650, 11, 'Lovelace'),
    ]
    expect(titleAndAuthorsFromLines(lines(2), page).authors).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace'])
    expect(titleAndAuthorsFromLines(lines(3), page).authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('does not join an Abstract heading onto a wrapped list', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(670, 11, 'Jane Doe, John Smith, Ada'), line(658, 11, 'Abstract')],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('treats a line at exactly 85% of the author size as part of the list, not a superscript', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(670, 10, 'Jane Doe, John Smith, Ada'), line(660, 8.5, 'Lovelace')],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace'])
  })

  it('keeps a following line only when it adds a name', () => {
    const meta = titleAndAuthorsFromLines(
      [line(700, 18, 'A Title That Is Long Enough'), line(670, 11, 'Jane Doe, John Smith'), line(658, 11, 'Senior Member')],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  it('grows a wrapped list over several lines', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        line(670, 11, 'Jane Doe, John Smith, Ada'),
        line(658, 11, 'Lovelace, and Alan'),
        line(646, 11, 'Turing'),
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jane Doe', 'John Smith', 'Ada Lovelace', 'Alan Turing'])
  })

  it('continues a column within 12pt, and skips a line with nothing in that column', () => {
    const meta = titleAndAuthorsFromLines(
      [
        line(700, 18, 'A Title That Is Long Enough'),
        columns(670, 11, ['Jan Keim, Ada', 'Angelika Kaplan']),
        { y: 658, size: 11, text: 'Lovelace', segments: [{ x: LEFT_X + 12, text: 'Lovelace' }] },
      ],
      page,
    )
    expect(meta.authors).toEqual(['Jan Keim', 'Ada Lovelace', 'Angelika Kaplan'])
  })
})

describe('abstractFromLines', () => {
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

  // THE regression this heuristic's column-awareness exists for. On a real
  // two-column paper the "Abstract" heading shares a baseline with the right
  // column's "1 Introduction", and every body line below holds a strip of each
  // column. An earlier version read `line.text` and stopped at the first
  // multi-segment line — which is the line right after the heading — and so
  // extracted nothing at all from exactly the papers this is for. Shaped
  // directly after samples/pdfs/KeimKaplan_FromScatteredToStructured.pdf, whose
  // real output is pinned in the integration test at the bottom of this file.
  it('follows the abstract down its own column of a two-column page', () => {
    const abstract = abstractFromLines([
      line(700, 18, 'From Scattered to Structured'),
      columns(653, 12, ['Jan Keim', 'Angelika Kaplan']),
      columns(597, 10.9, ['Abstract', '1Introduction']),
      columns(583, 9, [SENTENCE_1, 'Software architecture constitutes a fundamen']),
      columns(572, 9, [SENTENCE_2, 'engineering [32], embodying the high-level str']),
      // The left column's abstract has ended; only the right column runs on.
      // A line with nothing in our column is skipped, never a stop.
      { y: 375, size: 9, text: 'right only', segments: [{ x: RIGHT_X, text: 'developers and architects, who must' }] },
      // The left column's next section heading — this is the real stop.
      columns(362, 10.9, ['CCS Concepts', 'sources on comprehension [44], particularly']),
      columns(348, 9, ['•Software and its engineering', 'where documentation may span thousands']),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
    // Nothing from the right column may leak in, at any point.
    expect(abstract).not.toContain('Introduction')
    expect(abstract).not.toContain('embodying')
    expect(abstract).not.toContain('developers and architects')
    // And it must stop at its own column's next heading.
    expect(abstract).not.toContain('CCS Concepts')
    expect(abstract).not.toContain('Software and its engineering')
  })

  it('heals a word hyphenated across a line break, keeping real compound hyphens', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      line(585, 10, 'Software architecture is inherently knowledge-centric. The archi-'),
      line(570, 10, 'tectural knowledge is distributed across many artifacts, and we use'),
      line(555, 10, 'retrieval-augmented generation to make all of it properly accessible.'),
      line(540, 10, 'Introduction'),
    ])
    expect(abstract).toContain('architectural knowledge') // archi- + tectural, healed
    expect(abstract).not.toContain('archi- tectural')
    // A hyphen that is part of the word, not a line break, is left alone.
    expect(abstract).toContain('knowledge-centric')
    expect(abstract).toContain('retrieval-augmented')
  })

  it('rejects a match that is implausibly short', () => {
    expect(abstractFromLines([...FRONT_MATTER, line(600, 10, 'Abstract'), line(585, 10, 'Too short.')])).toBeUndefined()
  })

  it('accepts 150 to 4000 characters', () => {
    const of = (length: number) => abstractFromLines([...FRONT_MATTER, line(600, 10, 'Abstract'), line(585, 10, 'x'.repeat(length))])
    expect(of(149)).toBeUndefined()
    expect(of(150)).toBe('x'.repeat(150))
    expect(of(4000)).toBe('x'.repeat(4000))
    expect(of(4001)).toBeUndefined()
  })

  it('skips an Abstract heading set within 0.5pt of the largest size, so a long body under it is not read', () => {
    const body = [line(650, 10, SENTENCE_1), line(635, 10, SENTENCE_2)]
    expect(abstractFromLines([line(700, 18, 'Abstract Interpretation of Concurrent Programs'), ...body])).toBeUndefined()
    expect(abstractFromLines([line(700, 18, 'A Title'), line(670, 17.5, 'Abstract'), ...body])).toBeUndefined()
  })

  it('reads at most 40 lines after the heading', () => {
    const body = Array.from({ length: 45 }, (_, n) => line(580 - n * 10, 10, `Line ${n + 1} of the abstract.`))
    const abstract = abstractFromLines([...FRONT_MATTER, line(600, 10, 'Abstract'), ...body])
    expect(abstract).toMatch(/^Line 1 of the abstract\..* Line 40 of the abstract\.$/)
  })

  it('follows a column segment that starts 12pt off the heading', () => {
    const shifted = (y: number, text: string) => ({ y, size: 10, text, segments: [{ x: LEFT_X + 12, text }] })
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      shifted(585, SENTENCE_1),
      shifted(570, SENTENCE_2),
    ])
    expect(abstract).toBe(`${SENTENCE_1} ${SENTENCE_2}`)
  })

  it('does not heal a hyphen when the next line starts upper-case', () => {
    const abstract = abstractFromLines([
      ...FRONT_MATTER,
      line(600, 10, 'Abstract'),
      line(585, 10, `${SENTENCE_1} Case-`),
      line(570, 10, `Based reasoning. ${SENTENCE_2}`),
    ])
    expect(abstract).toContain('Case- Based reasoning.')
  })
})

/**
 * Against real PDFs, not hand-built lines. This exists because the synthetic
 * tests above are only as good as their author's mental model of what pdf.js
 * emits — and that model was wrong: every test above passed while
 * `extractPdfMeta` returned no abstract at all for the real two-column paper
 * below, because the hand-built fixtures never reproduced a heading sharing a
 * baseline with the *next column's* heading. A real file is the only thing that
 * catches that class of mistake, so one runs here.
 *
 * The worker setup mirrors `pdfText.test.ts`'s, for the same reason documented
 * there (jsdom resolves the module URL to http:, which pdf.js's Node fallback
 * cannot import).
 */
describe('extractPdfMeta against real PDFs', () => {
  const require = createRequire(import.meta.url)
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),
  ).href

  const loadPdf = (path: string): ArrayBuffer => new Uint8Array(readFileSync(path)).buffer

  it('reads title, authors and abstract from a real two-column paper', async () => {
    const meta = await extractPdfMeta(
      loadPdf('samples/pdfs/KeimKaplan_FromScatteredToStructured.pdf'),
    )
    expect(meta.title).toBe(
      'From Scattered to Structured: A Vision for Automating Architectural Knowledge Management',
    )
    expect(meta.authors).toEqual(['Jan Keim', 'Angelika Kaplan'])

    // Starts at the abstract's first word — the "Abstract" heading itself is
    // consumed, and the right column's "1 Introduction" never appears.
    expect(meta.abstract).toMatch(/^Software architecture is inherently knowledge-centric\./)
    // Ends at the abstract's last word: the next thing in this column is the
    // "CCS Concepts" heading, which must stop it.
    expect(meta.abstract).toMatch(/conversational knowledge access\.$/)
    expect(meta.abstract).not.toMatch(/CCS Concepts|Introduction|Software and its engineering/)
    // Line-break hyphens healed; real compound hyphens intact.
    expect(meta.abstract).toContain('The architectural knowledge is distributed')
    expect(meta.abstract).toContain('knowledge-centric')
    expect(meta.abstract).toContain('retrieval-augmented')
    expect(meta.abstract).not.toMatch(/- /)
  })

  it('reads the abstract from a single-column PDF', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/paper-a.pdf'))
    expect(meta.abstract).toMatch(/^We evaluate deep learning approaches for code search\./)
  })

  // A real single-column paper, and the counterpart to the two-column one
  // above: between them they cover both layouts a submission actually uses.
  // This one also has no space after its heading's colon ("Abstract:Our paper"),
  // which is what `ABSTRACT_START`'s optional trailing `\s*` is for, and ends at
  // a "Keywords:" line rather than an "Introduction" one.
  it('reads a real single-column paper whose heading runs straight into the text', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/A1-37.pdf'))
    expect(meta.title).toBe(
      'Linking Software System Artifacts: Toward Generic Traceability Link Recovery through Retrieval-Augmented Generation',
    )
    // The heading is consumed even with nothing between it and the first word.
    expect(meta.abstract).toMatch(/^Our paper \[Fu25a\], published at the 47th IEEE/)
    expect(meta.abstract).toMatch(/Retrieval-Augmented Generation \(RAG\)\.$/)
    // Stopped at the paper's own "Keywords:" line, and never reached the body.
    expect(meta.abstract).not.toMatch(/Keywords|Introduction|development and maintenance/)
  })

  // The wrapped-author-list case, on a real file. This paper's seven authors
  // run onto a second line, and the break falls *inside a name*: the first line
  // ends "… Niklas Ewald, Tobias" and the second opens "Thirolf, and Anne
  // Koziolek". Parsing the lines separately loses two authors outright —
  // "Tobias" is a lone token strict mode rejects, and "Thirolf" never gets its
  // first name back. There is also a row of superscript affiliation keys ("1 1")
  // sitting on its own baseline *between* the two halves, which the block has
  // to step over to find the rest of the list.
  it('reads a wrapped author list, including a name broken across the line break', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/A1-37.pdf'))
    expect(meta.authors).toEqual([
      'Dominik Fuchß',
      'Tobias Hey',
      'Jan Keim',
      'Haoyu Liu',
      'Niklas Ewald',
      'Tobias Thirolf', // the name the line break ran through
      'Anne Koziolek',
    ])
  })

  it('reads the DOI printed on page 1', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/A1-37.pdf'))
    expect(meta.doi).toBe('10.18420/se2026-21')
  })

  it('returns no abstract for a PDF that has none, rather than guessing', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/multipage.pdf'))
    expect(meta.abstract).toBeUndefined()
  })

  it('returns nothing for data that is not a PDF', async () => {
    expect(await extractPdfMeta(new Uint8Array(Buffer.from('not a pdf')).buffer)).toStrictEqual({})
  })

  /** A one-page US Letter PDF: `info` is the Info dictionary, each line is Helvetica text at y. */
  const buildPdf = (info: Record<string, string>, lines: { y: number; size: number; text: string }[]): ArrayBuffer => {
    const content = lines.map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${l.text}) Tj ET`).join('\n')
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< ${Object.entries(info)
        .map(([key, value]) => `/${key} (${value})`)
        .join(' ')} >>`,
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((body, n) => {
      const offset = pdf.length
      pdf += `${n + 1} 0 obj\n${body}\nendobj\n`
      return offset
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new Uint8Array(Buffer.from(pdf, 'latin1')).buffer
  }

  const PAGE = [
    { y: 700, size: 18, text: 'Layout Title of the Paper' },
    { y: 670, size: 11, text: 'Ada Lovelace, Alan Turing' },
    { y: 650, size: 10, text: 'DOI 10.9999/page.1' },
    { y: 640, size: 10, text: 'Karlsruhe Institute of Technology' },
  ]

  it('prefers the metadata title, authors and DOI over the page', async () => {
    const meta = await extractPdfMeta(
      buildPdf(
        { Title: 'Metadata Title of the Paper', Author: 'Jane Doe; John Smith', Subject: 'doi:10.1234/meta.5', Keywords: 'code search' },
        PAGE,
      ),
    )
    expect(meta).toStrictEqual({
      title: 'Metadata Title of the Paper',
      authors: ['Jane Doe', 'John Smith'],
      doi: '10.1234/meta.5',
    })
  })

  it('falls back to the page for an implausible title and a missing author', async () => {
    const meta = await extractPdfMeta(buildPdf({ Title: 'untitled' }, PAGE))
    expect(meta).toStrictEqual({
      title: 'Layout Title of the Paper',
      authors: ['Ada Lovelace', 'Alan Turing'],
      doi: '10.9999/page.1',
    })
  })

  it('takes from the page only the field the metadata lacks', async () => {
    const authorsFromPage = await extractPdfMeta(buildPdf({ Title: 'Metadata Title of the Paper' }, PAGE))
    expect(authorsFromPage.title).toBe('Metadata Title of the Paper')
    expect(authorsFromPage.authors).toEqual(['Ada Lovelace', 'Alan Turing'])

    const titleFromPage = await extractPdfMeta(buildPdf({ Author: 'Jane Doe' }, PAGE))
    expect(titleFromPage.title).toBe('Layout Title of the Paper')
    expect(titleFromPage.authors).toEqual(['Jane Doe'])
  })

  it('reads the page authors when no metadata author is a person', async () => {
    const meta = await extractPdfMeta(buildPdf({ Author: 'Department of Computer Science' }, PAGE))
    expect(meta.authors).toEqual(['Ada Lovelace', 'Alan Turing'])
  })
})
