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
} from './pdfMeta'
import { pdfjs } from '../platform/pdfjs'

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

  // A known shortfall, pinned here so it stays visible rather than becoming
  // folklore. This paper's author list wraps onto a second line ("… Niklas
  // Ewald, Tobias" / "Thirolf, and Anne Koziolek") and
  // `titleAndAuthorsFromLines` stops at the first line that yields any names —
  // so it finds five of the seven, and drops the "Tobias" stranded at the break
  // (strict mode rejects a lone token as a name, which is exactly what stops a
  // body sentence from becoming an author list). This is a *pre-fill* the
  // reviewer corrects in the editor, and it is unrelated to the abstract, which
  // this same file extracts in full. If someone teaches the heuristic to
  // continue across a wrapped list, this test is where that shows up.
  it('finds only the first line of a wrapped author list (known shortfall)', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/A1-37.pdf'))
    expect(meta.authors).toEqual([
      'Dominik Fuchß',
      'Tobias Hey',
      'Jan Keim',
      'Haoyu Liu',
      'Niklas Ewald',
    ])
  })

  it('returns no abstract for a PDF that has none, rather than guessing', async () => {
    const meta = await extractPdfMeta(loadPdf('samples/pdfs/multipage.pdf'))
    expect(meta.abstract).toBeUndefined()
  })
})
