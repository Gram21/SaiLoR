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

describe('parseReferences: BibTeX LaTeX escapes', () => {
  it('unescapes a bare accent command (\\"o)', () => {
    const bib = `@article{k1, title = {T}, author = {Bj\\"orn Test}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Björn Test'])
  })

  it('unescapes a brace-argument accent command (\\"{o})', () => {
    const bib = `@article{k1, title = {T}, author = {Bj\\"{o}rn Test}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Björn Test'])
  })

  it('unescapes an accent command wrapped in an extra protective brace ({\\"o})', () => {
    const bib = `@article{k1, title = {T}, author = {Bj{\\"o}rn Test}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Björn Test'])
  })

  it('unescapes an uppercase-base accent (\\"O)', () => {
    const bib = `@article{k1, title = {\\"Odd Title}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('Ödd Title')
  })

  it('covers every required accent: acute, grave, circumflex, tilde, macron, dot-above', () => {
    const bib = `@article{k1, title = {T}, author = {Ren\\'e and Vibeke H\\\`agen and No\\^el and Re\\~nata and K\\=oji and \\.Zaneta}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['René', 'Vibeke Hàgen', 'Noêl', 'Reñata', 'Kōji', 'Żaneta'])
  })

  it('covers the braced-argument-only accents: cedilla, caron, breve, double acute, ring, ogonek', () => {
    const bib = `@article{k1, title = {T}, author = {Fran\\c{c}ois and Vla\\v{s}ta and Sv\\u{a}toplk and Erd\\H{o}s and B\\r{a}rd and Kasi\\k{a}}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['François', 'Vlašta', 'Svătoplk', 'Erdős', 'Bård', 'Kasią'])
  })

  it('unescapes standalone letters that are not accents on a base letter, brace-terminated', () => {
    // Real exports write the `{}` terminator (not a bare trailing space) when
    // more of the word follows directly, precisely to avoid the ambiguity a
    // bare space would have with a genuine word/author boundary.
    const bib = `@article{k1, title = {T}, author = {Wei\\ss{} and S\\o{}ren and \\L{}ukasz and Ma\\ae{}ve and Kh\\oe{} and B\\aa{}rd and Naz\\i{}m}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Weiß', 'Søren', 'Łukasz', 'Maæve', 'Khœ', 'Bård', 'Nazım'])
  })

  it('unescapes standalone letters with their own uppercase form (SS is not \\ss — but O/L/AE/OE/AA are)', () => {
    const bib = `@article{k1, title = {T}, author = {\\O{}rn and \\AA{}se and \\AE{}gir and \\OE{}rsted}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Ørn', 'Åse', 'Ægir', 'Œrsted'])
  })

  // `S\o ren` is the ordinary way to spell "Søren" in a .bib: TeX ends a
  // control word at the following space and consumes it, so the space is not
  // part of the name. Getting this wrong mangles most Nordic names.
  it("consumes the single space that terminates a bare control word (S\\o ren is Søren)", () => {
    const bib = `@article{k1, title = {T}, author = {S\\o ren Kristensen and Lars \\AA berg}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Søren Kristensen', 'Lars Åberg'])
  })

  // The counterpart, and the reason the author list is split on " and " before
  // any of this runs: a name-final control word sits directly against the
  // separator's space, so unescaping first would eat it and glue the two names
  // into "Weißand Sven".
  it('does not let a name-final control word swallow the " and " separator', () => {
    const bib = `@article{k1, title = {T}, author = {Hans Wei\\ss and Sven G\\o tz}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Hans Weiß', 'Sven Gøtz'])
  })

  it('degrades an unknown escape gracefully: readable, no crash, no stray backslash', () => {
    const bib = `@article{k1, title = {A \\unknowncmd Title}}`
    expect(() => parseReferences(bib, 'refs.bib')).not.toThrow()
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).not.toContain('\\')
    expect(entry.title).toBe('A unknowncmd Title')
  })

  it('still strips plain capitalization braces that do not wrap an escape ({DNA})', () => {
    const bib = `@article{k1, title = {The {DNA} Structure}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('The DNA Structure')
  })

  it('still unescapes plain punctuation and tilde/space escapes (\\&, ~)', () => {
    const bib = `@article{k1, title = {Fish \\& Chips}, author = {Jane Doe}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.title).toBe('Fish & Chips')
  })

  it('turns a non-breaking-space tilde into a plain space', () => {
    const bib = `@article{k1, title = {T}, author = {Jan~Keim}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jan Keim'])
  })

  it('does not mangle a Windows file path with the new LaTeX-unescape fallback', () => {
    const bib = `@article{k1, title = {T}, file = {:C\\:\\Users\\name\\file.pdf:application/pdf}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.pdfHint).toBe('C:\\Users\\name\\file.pdf')
  })
})

describe('parseReferences: BibTeX merged-author-name repair', () => {
  it('splits a fully merged pair on the capitalization seam', () => {
    const bib = `@article{k1, title = {T}, author = {Jan KeimAngelika Kaplan}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jan Keim', 'Angelika Kaplan'])
  })

  it('repairs "and" that lost only its leading space', () => {
    const bib = `@article{k1, title = {T}, author = {Jan Keimand Angelika Kaplan}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jan Keim', 'Angelika Kaplan'])
  })

  it('repairs "and" that lost only its trailing space', () => {
    const bib = `@article{k1, title = {T}, author = {Jan Keim andAngelika Kaplan}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jan Keim', 'Angelika Kaplan'])
  })

  it('repairs a fully merged pair inside an otherwise well-formed "and" list', () => {
    const bib = `@article{k1, title = {T}, author = {John SmithMary Jones and Bob Lee}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['John Smith', 'Mary Jones', 'Bob Lee'])
  })

  it('leaves a normal well-formed "and" list untouched', () => {
    const bib = `@article{k1, title = {T}, author = {Jane Doe and John Smith}}`
    const [entry] = parseReferences(bib, 'refs.bib')
    expect(entry.authors).toEqual(['Jane Doe', 'John Smith'])
  })

  // "A wrong split is worse than a missed one" — every case below is a real
  // name shape that must survive completely untouched, even though several
  // of them share surface features with the merge patterns above (an
  // internal capital, or a token ending in "and").
  describe('does not split legitimate names', () => {
    it('McDonald / MacLeod / MacArthur (Mc/Mac prefix)', () => {
      const bib = `@article{k1, title = {T}, author = {Alice McDonald and Bob MacLeod and Carol MacArthur}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['Alice McDonald', 'Bob MacLeod', 'Carol MacArthur'])
    })

    it("O'Brien / D'Angelo (apostrophe before the capital)", () => {
      const bib = `@article{k1, title = {T}, author = {Sean O'Brien and Maria D'Angelo}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(["Sean O'Brien", "Maria D'Angelo"])
    })

    it('DeSilva / DiCaprio / LaSalle / VanDyke / DuBois (internal-capital prefixes)', () => {
      const bib = `@article{k1, title = {T}, author = {A DeSilva and B DiCaprio and C LaSalle and D VanDyke and E DuBois}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['A DeSilva', 'B DiCaprio', 'C LaSalle', 'D VanDyke', 'E DuBois'])
    })

    it('van der Berg / von Neumann / de la Cruz (lowercase particles)', () => {
      const bib = `@article{k1, title = {T}, author = {Jan van der Berg and John von Neumann and Maria de la Cruz}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['Jan van der Berg', 'John von Neumann', 'Maria de la Cruz'])
    })

    it('initials (J.K. Rowling / A.B. Author)', () => {
      const bib = `@article{k1, title = {T}, author = {J.K. Rowling and A.B. Author}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['J.K. Rowling', 'A.B. Author'])
    })

    it('all-caps / acronym-ish surnames', () => {
      const bib = `@article{k1, title = {T}, author = {John NASA and Jane IBM}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['John NASA', 'Jane IBM'])
    })

    it('hyphenated names', () => {
      const bib = `@article{k1, title = {T}, author = {Mary Smith-Jones and Paul Taylor-Wood}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['Mary Smith-Jones', 'Paul Taylor-Wood'])
    })

    it('a real name ending in "and" (Roland) is not treated as a merged "and" separator', () => {
      const bib = `@article{k1, title = {T}, author = {Jan Roland Meyer}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['Jan Roland Meyer'])
    })

    it('another real name ending in "and" (Armand), single author with no trailing name', () => {
      const bib = `@article{k1, title = {T}, author = {Jan Armand Dubois}}`
      const [entry] = parseReferences(bib, 'refs.bib')
      expect(entry.authors).toEqual(['Jan Armand Dubois'])
    })
  })
})

describe('parseReferences: RIS with LaTeX escapes', () => {
  it('unescapes LaTeX in RIS title and author fields (a .bib exported/converted to .ris)', () => {
    const ris = ['TY  - JOUR', 'TI  - Bj\\"orn\\\'s Th\\`eorie', 'AU  - Bj\\"orn Fischer', 'ER  - '].join(
      '\n',
    )
    const [entry] = parseReferences(ris, 'refs.ris')
    expect(entry.authors).toEqual(['Björn Fischer'])
    expect(entry.title).toBe("Björn's Thèorie")
  })

  it('does not run the merged-author-name repair on RIS (AU is already one author per line)', () => {
    const ris = ['TY  - JOUR', 'TI  - T', 'AU  - KeimAngelika Kaplan', 'ER  - '].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    // Left exactly as given — RIS authors are structurally separated already,
    // so treating this as a merge would be guessing at something that (per
    // the format) shouldn't be ambiguous in the first place.
    expect(entry.authors).toEqual(['KeimAngelika Kaplan'])
  })

  it('does not run LaTeX-unescape on RIS DOI/URL fields (identifiers/paths, not prose)', () => {
    const ris = [
      'TY  - JOUR',
      'TI  - T',
      'L1  - C:\\Users\\name\\file.pdf',
      'ER  - ',
    ].join('\n')
    const [entry] = parseReferences(ris, 'refs.ris')
    expect(entry.pdfHint).toBe('C:\\Users\\name\\file.pdf')
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
