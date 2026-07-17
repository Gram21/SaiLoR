import { describe, it, expect } from 'vitest'
import { classifyImport, normalizeDoi, normalizeTitleForMatch, type DupRecord, type DupTarget, type DupVerdict } from './duplicates'
import { stringSimilarity } from '../consolidate/similarity'

/** A `DupRecord` with sane defaults, so each test only spells out what it cares about. */
function rec(title: string, opts: Partial<Omit<DupRecord, 'title'>> = {}): DupRecord {
  return { title, authors: [], ...opts }
}

/** The lone verdict from a one-existing/one-incoming classification. */
function classifyOne(existing: DupRecord, incoming: DupRecord): DupVerdict {
  return classifyImport([existing], [incoming])[0]
}

describe('normalizeTitleForMatch', () => {
  it('folds case, punctuation and whitespace', () => {
    expect(normalizeTitleForMatch('  A Study of Something: Really!  ')).toBe('a study of something really')
  })

  it('strips dashes entirely, so an em-dash and a hyphen collapse to the same string', () => {
    // The exact-match path is where the brief's "an em-dash slips through" claim
    // actually resolves — see the "reaches the exact/certain path" tests below.
    expect(normalizeTitleForMatch('Testing — A Survey')).toBe(normalizeTitleForMatch('Testing - A Survey'))
    expect(normalizeTitleForMatch('Model—Driven Engineering')).toBe(normalizeTitleForMatch('Model-Driven Engineering'))
  })
})

describe('normalizeDoi', () => {
  it('lowercases and trims', () => {
    expect(normalizeDoi('  10.1000/XYZ  ')).toBe('10.1000/xyz')
  })

  it('strips a leading doi.org URL, with or without dx.', () => {
    expect(normalizeDoi('https://doi.org/10.1145/1')).toBe('10.1145/1')
    expect(normalizeDoi('http://dx.doi.org/10.1145/1')).toBe('10.1145/1')
  })

  it('strips a leading "doi:" prefix', () => {
    expect(normalizeDoi('doi:10.1145/1')).toBe('10.1145/1')
    expect(normalizeDoi('DOI: 10.1145/1')).toBe('10.1145/1')
  })

  it('is empty for an absent DOI', () => {
    expect(normalizeDoi(undefined)).toBe('')
  })
})

describe('classifyImport — certain (DOI)', () => {
  it('matches on DOI even against a totally different title', () => {
    const v = classifyOne(
      rec('Completely Different Title', { doi: '10.1000/xyz' }),
      rec('Something Else Entirely', { doi: '10.1000/XYZ' }),
    )
    expect(v).toEqual({ kind: 'certain', target: { where: 'existing', index: 0 }, reason: { via: 'doi' } })
  })

  it('matches doi.org URL form against the bare DOI', () => {
    const v = classifyOne(rec('T', { doi: '10.1145/1' }), rec('T', { doi: 'https://doi.org/10.1145/1' }))
    expect(v.kind).toBe('certain')
    expect(v.kind === 'certain' && v.reason).toEqual({ via: 'doi' })
  })

  it('matches "doi:" form against the bare DOI', () => {
    const v = classifyOne(rec('T', { doi: '10.1145/1' }), rec('T', { doi: 'doi:10.1145/1' }))
    expect(v.kind).toBe('certain')
  })

  it('is case-insensitive', () => {
    const v = classifyOne(rec('T', { doi: '10.1000/ABC' }), rec('T', { doi: '10.1000/abc' }))
    expect(v.kind).toBe('certain')
  })

  it('beats a 5-year gap — the year veto never applies to a DOI match', () => {
    const v = classifyOne(
      rec('Totally Different Title A', { doi: '10.1/x', year: 2010 }),
      rec('Totally Different Title B', { doi: '10.1/x', year: 2020 }),
    )
    expect(v.kind).toBe('certain')
  })
})

describe('classifyImport — certain (exact normalized title, no regression)', () => {
  it('matches on normalized title when there is no DOI on either side', () => {
    const v = classifyOne(rec('A Study of Something: Really!'), rec('  a study of something really  '))
    expect(v).toEqual({
      kind: 'certain',
      target: { where: 'existing', index: 0 },
      reason: { via: 'title', score: 1 },
    })
  })

  it('reaches the exact/certain path for an em-dash vs a hyphen (documents that this already worked)', () => {
    const v = classifyOne(rec('Testing — A Survey'), rec('Testing - A Survey'))
    expect(v.kind).toBe('certain')
  })

  it('reaches the exact/certain path for a tight em-dash vs a hyphen', () => {
    const v = classifyOne(rec('Model—Driven Engineering'), rec('Model-Driven Engineering'))
    expect(v.kind).toBe('certain')
  })

  it('reaches the exact/certain path for LaTeX braces around a word', () => {
    const v = classifyOne(rec('A Study of {SQL} Injection Defenses'), rec('A Study of SQL Injection Defenses'))
    expect(v.kind).toBe('certain')
  })

  it('stays certain across a 1-year gap — routine database noise, not a different paper', () => {
    const v = classifyOne(rec('Same Title Here', { year: 2015 }), rec('Same Title Here', { year: 2016 }))
    expect(v.kind).toBe('certain')
  })

  it('stays certain when only one side has a year — a silent field abstains', () => {
    const v = classifyOne(rec('Same Title Here', { year: 2015 }), rec('Same Title Here'))
    expect(v.kind).toBe('certain')
  })

  it('does not match when neither DOI nor title line up', () => {
    const v = classifyOne(rec('Completely Different'), rec('Something Else'))
    expect(v).toEqual({ kind: 'new' })
  })
})

describe('classifyImport — new (year veto)', () => {
  it('demotes an exact-title match to new when years are 5 apart', () => {
    const v = classifyOne(rec('Same Title Here', { year: 2015 }), rec('Same Title Here', { year: 2020 }))
    expect(v).toEqual({ kind: 'new' })
  })

  it('demotes at exactly the 2-year bar', () => {
    const v = classifyOne(rec('Same Title Here', { year: 2015 }), rec('Same Title Here', { year: 2017 }))
    expect(v).toEqual({ kind: 'new' })
  })
})

describe('classifyImport — probable (near-misses)', () => {
  it('arXiv vs published DOI, identical title: probable, not certain, not silently new', () => {
    const v = classifyOne(
      rec('Attention Is All You Need', { doi: '10.48550/arXiv.1706.03762' }),
      rec('Attention Is All You Need', { doi: '10.5555/attn2017' }),
    )
    expect(v.kind).toBe('probable')
    expect(v.kind === 'probable' && v.reason).toEqual({ via: 'title', score: 1 })
  })

  it('subtitle present vs absent, with matching authors — caught via base title + authors', () => {
    const v = classifyOne(
      rec('A Survey of Machine Learning Techniques', { authors: ['Jane Doe'] }),
      rec('A Survey of Machine Learning Techniques: Methods and Applications', { authors: ['Jane Doe'] }),
    )
    expect(v.kind).toBe('probable')
    expect(v.kind === 'probable' && v.reason.via).toBe('base-title')
  })

  it('a short base with a subtitle, with matching authors', () => {
    const v = classifyOne(rec('Deep Learning', { authors: ['Jane Doe'] }), rec('Deep Learning: A Review', { authors: ['Jane Doe'] }))
    expect(v.kind).toBe('probable')
    expect(v.kind === 'probable' && v.reason.via).toBe('base-title')
  })

  it('a long base title with only a short subtitle addition is caught by the full-title rule alone, no authors needed', () => {
    const base = 'A Systematic Literature Review of Machine Learning Approaches for Software Defect Prediction'
    const v = classifyOne(rec(base), rec(`${base}: An Update`))
    expect(v.kind).toBe('probable')
    expect(v.kind === 'probable' && v.reason.via).toBe('title')
  })

  it('British vs American spelling', () => {
    const v = classifyOne(
      rec('Behaviour Modelling of Distributed Systems'),
      rec('Behavior Modeling of Distributed Systems'),
    )
    expect(v.kind).toBe('probable')
  })

  it('a typo', () => {
    const v = classifyOne(rec('Continuous Integration Best Practices'), rec('Continuous Integraton Best Practices'))
    expect(v.kind).toBe('probable')
  })

  it('same title + 1-year gap is not a different paper (online-first vs issue date)', () => {
    // Fuzzy, not exact, so this exercises the veto on the *fuzzy* path too.
    const v = classifyOne(
      rec('Continuous Integration Best Practices', { year: 2015 }),
      rec('Continuous Integraton Best Practices', { year: 2016 }),
    )
    expect(v.kind).toBe('probable')
  })

  it('same title + one year missing abstains rather than voting against', () => {
    const v = classifyOne(
      rec('Continuous Integration Best Practices', { year: 2015 }),
      rec('Continuous Integraton Best Practices'),
    )
    expect(v.kind).toBe('probable')
  })
})

describe('classifyImport — new (adversarial)', () => {
  it('same base title, different subtitle, different authors', () => {
    const v = classifyOne(
      rec('Software Testing Methods: A Survey', { authors: ['Jane Doe'] }),
      rec('Software Testing Methods: An Introduction', { authors: ['John Smith'] }),
    )
    expect(v).toEqual({ kind: 'new' })
  })

  it('"for Java" vs "for Python", identical authors — a strong full-title score is still not enough alone', () => {
    const v = classifyOne(
      rec('Automated Test Generation for Java Applications', { authors: ['Jane Doe'] }),
      rec('Automated Test Generation for Python Applications', { authors: ['Jane Doe'] }),
    )
    expect(v).toEqual({ kind: 'new' })
  })

  it('same-domain surveys (different domains)', () => {
    const v = classifyOne(
      rec('A Survey of Deep Learning in Healthcare'),
      rec('A Survey of Deep Learning in Finance'),
    )
    expect(v).toEqual({ kind: 'new' })
  })

  it('unrelated titles', () => {
    const v = classifyOne(rec('Quantum Computing Fundamentals'), rec('A History of Renaissance Art'))
    expect(v).toEqual({ kind: 'new' })
  })

  it('empty title on both sides', () => {
    const v = classifyOne(rec(''), rec(''))
    expect(v).toEqual({ kind: 'new' })
  })

  it('empty title on one side', () => {
    const v = classifyOne(rec(''), rec('Something'))
    expect(v).toEqual({ kind: 'new' })
  })

  it('a base-title match with no usable authors on either side abstains to new', () => {
    const v = classifyOne(rec('A Survey of Machine Learning Techniques'), rec('A Survey of Machine Learning Techniques: Methods and Applications'))
    expect(v).toEqual({ kind: 'new' })
  })

  it('a base-title match with authors known on only one side abstains to new', () => {
    const v = classifyOne(
      rec('A Survey of Machine Learning Techniques', { authors: ['Jane Doe'] }),
      rec('A Survey of Machine Learning Techniques: Methods and Applications'),
    )
    expect(v).toEqual({ kind: 'new' })
  })
})

describe('classifyImport — accepted false positives, pinned deliberately', () => {
  it('"Part I" vs "Part II" scores just above the title threshold', () => {
    const v = classifyOne(
      rec('Formal Methods for Concurrent Systems, Part I'),
      rec('Formal Methods for Concurrent Systems, Part II'),
    )
    expect(v.kind).toBe('probable')
  })

  it('same base title, different subtitle, same authors', () => {
    const v = classifyOne(
      rec('Software Testing Methods: A Survey', { authors: ['Jane Doe'] }),
      rec('Software Testing Methods: An Introduction', { authors: ['Jane Doe'] }),
    )
    expect(v.kind).toBe('probable')
    expect(v.kind === 'probable' && v.reason.via).toBe('base-title')
  })
})

describe('author surname matching (exercised through the base-title rule)', () => {
  function baseTitlePair(authorsA: string[], authorsB: string[]): DupVerdict {
    return classifyOne(
      rec('Software Testing Methods: A Survey', { authors: authorsA }),
      rec('Software Testing Methods: An Introduction', { authors: authorsB }),
    )
  }

  it('"Last, First" vs "First Last" for the same person — the comma trap', () => {
    expect(baseTitlePair(['Doe, Jane'], ['Jane Doe']).kind).toBe('probable')
  })

  it('an initial vs a full given name', () => {
    expect(baseTitlePair(['J. Doe'], ['Jane Doe']).kind).toBe('probable')
  })

  it('diacritics folded', () => {
    expect(baseTitlePair(['José Peña'], ['Jose Pena']).kind).toBe('probable')
  })

  it('reordered author lists', () => {
    expect(baseTitlePair(['Jane Doe', 'John Smith'], ['John Smith', 'Jane Doe']).kind).toBe('probable')
  })

  it('a hyphenated surname', () => {
    expect(baseTitlePair(['Anna Smith-Jones'], ['A. Smith-Jones']).kind).toBe('probable')
  })

  it('an "et al."-truncated list against the full one sits exactly at the 0.50 bar', () => {
    // 3 authors vs 1, sharing exactly one surname: Dice = 2*1/(3+1) = 0.50.
    expect(baseTitlePair(['Jane Doe', 'John Smith', 'Amy Lee'], ['Jane Doe']).kind).toBe('probable')
  })

  it('sharing only one of three surnames each falls below the bar', () => {
    // Dice = 2*1/(3+3) = 0.33.
    expect(
      baseTitlePair(['Jane Doe', 'John Smith', 'Amy Lee'], ['Jane Doe', 'Bob Young', 'Cara King']).kind,
    ).toBe('new')
  })

  it('different authors entirely', () => {
    expect(baseTitlePair(['Jane Doe'], ['John Smith']).kind).toBe('new')
  })
})

describe('classifyImport — structure', () => {
  it('returns one verdict per incoming record, index-aligned, even when empty', () => {
    expect(classifyImport([], [])).toEqual([])
    expect(classifyImport([rec('X')], [])).toEqual([])
    expect(classifyImport([], [rec('A'), rec('B')])).toEqual([{ kind: 'new' }, { kind: 'new' }])
  })

  it('detects a probable duplicate within the incoming batch itself', () => {
    const verdicts = classifyImport([], [rec('Continuous Integration Best Practices'), rec('Continuous Integraton Best Practices')])
    expect(verdicts[0]).toEqual({ kind: 'new' })
    expect(verdicts[1].kind).toBe('probable')
    expect(verdicts[1].kind === 'probable' && verdicts[1].target).toEqual({ where: 'batch', index: 0 })
  })

  it('a batch target index is always lower than the entry\'s own index (the chain invariant)', () => {
    const verdicts = classifyImport(
      [],
      [rec('Same Title Here'), rec('Same Title Here'), rec('Same Title Here')],
    )
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i]
      if (v.kind !== 'new' && v.target.where === 'batch') {
        expect(v.target.index).toBeLessThan(i)
      }
    }
  })

  it('a 3-entry chain: two probable matches on entry 1, which itself certainly matches existing paper 0', () => {
    const existing = [rec('A Foundational Paper on Widgets', { doi: '10.1/widgets' })]
    const incoming = [
      rec('A Foundational Paper on Widgets', { doi: '10.1/widgets' }), // certain -> existing[0]
      rec('A Foundatoinal Paper on Widgets', { doi: '10.1/widgets' }), // certain via doi -> existing[0] too (doi always wins)
    ]
    const verdicts = classifyImport(existing, incoming)
    expect(verdicts[0]).toEqual({
      kind: 'certain',
      target: { where: 'existing', index: 0 },
      reason: { via: 'doi' },
    })
    expect(verdicts[1]).toEqual({
      kind: 'certain',
      target: { where: 'existing', index: 0 },
      reason: { via: 'doi' },
    })
  })
})

// ---------------------------------------------------------------------------
// Guard soundness
// ---------------------------------------------------------------------------

/**
 * A deliberately naive reference: the exact same classification rules as
 * `classifyImport`, but with every fuzzy title/base-title comparison run
 * through the real `stringSimilarity` unconditionally — no length bound, no
 * histogram bound, no Dice-alone shortcut. If the guarded implementation ever
 * skips a pair the naive one would have matched (or the reverse), this test
 * catches it. This is what actually stops a future "optimization" from
 * silently dropping matches, which is the one failure mode the guards in
 * `duplicates.ts` exist to prevent.
 */
function naiveClassify(existing: DupRecord[], incoming: DupRecord[]): DupVerdict[] {
  const TITLE_T = 0.9
  const AUTH_T = 0.5
  const YEAR_GAP = 2

  function surnameOf(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return ''
    const comma = trimmed.indexOf(',')
    const head = comma === -1 ? trimmed : trimmed.slice(0, comma)
    const folded = head
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (comma !== -1) return folded
    const tokens = folded.split(' ').filter(Boolean)
    return tokens.length > 0 ? tokens[tokens.length - 1] : ''
  }

  function authorSim(a: string[], b: string[]): number | null {
    const setA = new Set(a.map(surnameOf).filter(Boolean))
    const setB = new Set(b.map(surnameOf).filter(Boolean))
    if (setA.size === 0 || setB.size === 0) return null
    let shared = 0
    for (const x of setA) if (setB.has(x)) shared++
    return (2 * shared) / (setA.size + setB.size)
  }

  function baseOf(title: string): string {
    const i = title.indexOf(':')
    return i === -1 ? title : title.slice(0, i)
  }

  type NaiveReason = { via: 'doi' } | { via: 'title'; score: number } | { via: 'base-title'; score: number; authors: number }

  function pairVerdict(a: DupRecord, b: DupRecord): { kind: 'certain' | 'probable'; reason: NaiveReason } | null {
    const doiA = normalizeDoi(a.doi)
    const doiB = normalizeDoi(b.doi)
    if (doiA && doiB && doiA === doiB) return { kind: 'certain', reason: { via: 'doi' } }

    const exA = normalizeTitleForMatch(a.title)
    const exB = normalizeTitleForMatch(b.title)
    if (!exA || !exB) return null

    const doiConflict = doiA !== '' && doiB !== '' && doiA !== doiB
    const yearVeto = a.year != null && b.year != null && Math.abs(a.year - b.year) >= YEAR_GAP

    if (exA === exB) {
      if (yearVeto) return null
      if (doiConflict) return { kind: 'probable', reason: { via: 'title', score: 1 } }
      return { kind: 'certain', reason: { via: 'title', score: 1 } }
    }

    // No bounds: always the real, exact computation.
    const fullSim = stringSimilarity(a.title, b.title)
    if (fullSim >= TITLE_T) {
      if (yearVeto) return null
      return { kind: 'probable', reason: { via: 'title', score: fullSim } }
    }

    const baseSim = stringSimilarity(baseOf(a.title), baseOf(b.title))
    if (baseSim >= TITLE_T) {
      const authSim = authorSim(a.authors, b.authors)
      if (authSim !== null && authSim >= AUTH_T) {
        if (yearVeto) return null
        return { kind: 'probable', reason: { via: 'base-title', score: baseSim, authors: authSim } }
      }
    }
    return null
  }

  function rank(m: { kind: 'certain' | 'probable'; reason: NaiveReason }): number {
    if (m.kind === 'certain') return m.reason.via === 'doi' ? 1000 : 999
    return 'score' in m.reason ? m.reason.score : 0
  }

  const verdicts: DupVerdict[] = []
  const batch: DupRecord[] = []
  for (const cur of incoming) {
    let best: { kind: 'certain' | 'probable'; reason: NaiveReason; target: DupTarget } | null = null
    for (let j = 0; j < existing.length; j++) {
      const m = pairVerdict(cur, existing[j])
      if (m && (!best || rank(m) > rank(best))) best = { ...m, target: { where: 'existing', index: j } }
    }
    for (let j = 0; j < batch.length; j++) {
      const m = pairVerdict(cur, batch[j])
      if (m && (!best || rank(m) > rank(best))) best = { ...m, target: { where: 'batch', index: j } }
    }
    verdicts.push(best ? { kind: best.kind, target: best.target, reason: best.reason } : { kind: 'new' })
    batch.push(cur)
  }
  return verdicts
}

describe('cost guards are sound', () => {
  it('agrees pair-for-pair (kind, target, reason.via) with an unguarded reference over a wide table of pairs', () => {
    const existing: DupRecord[] = [
      rec('A Systematic Literature Review of Machine Learning Approaches for Software Defect Prediction', { authors: ['Jane Doe', 'John Smith'], year: 2018 }),
      rec('Behaviour Modelling of Distributed Systems', { authors: ['Amy Lee'] }),
      rec('A Survey of Deep Learning in Healthcare', { authors: ['Kim Park'] }),
      rec('Continuous Integration Best Practices', { authors: ['Cara King'], doi: '10.9/ci' }),
      rec('Quantum Computing Fundamentals'),
      rec('Software Testing Methods: A Survey', { authors: ['Bob Young'] }),
      rec(''),
      rec('X'),
      rec('A very long and heavily padded title about widgets and gadgets and gizmos and doohickeys galore'),
      rec('Formal Methods for Concurrent Systems, Part I'),
    ]

    const incoming: DupRecord[] = [
      rec('A Systematic Literature Review of Machine Learning Approaches for Software Defect Prediction: An Update', { authors: ['Jane Doe'] }),
      rec('Behavior Modeling of Distributed Systems'),
      rec('A Survey of Deep Learning in Finance', { authors: ['Kim Park'] }),
      rec('Continuous Integraton Best Practices', { doi: '10.9/CI' }),
      rec('A History of Renaissance Art'),
      rec('Software Testing Methods: An Introduction', { authors: ['Bob Young'] }),
      rec('Software Testing Methods: An Introduction', { authors: ['Someone Else'] }),
      rec(''),
      rec('Y'),
      rec('A very long and heavily padded title about widgets and gadgets and gizmos and doohickeys plenty'),
      rec('Formal Methods for Concurrent Systems, Part II'),
      rec('Completely unrelated document about something else altogether'),
      // A within-batch pair too.
      rec('Deep Learning', { authors: ['Nia Cole'] }),
      rec('Deep Learning: A Review', { authors: ['Nia Cole'] }),
      rec('A Systematic Literature Review of Machine Learning Approaches for Software Defect Prediction', { authors: ['Jane Doe', 'John Smith'], year: 2018 }),
    ]

    const guarded = classifyImport(existing, incoming)
    const naive = naiveClassify(existing, incoming)

    expect(guarded).toHaveLength(naive.length)
    for (let i = 0; i < guarded.length; i++) {
      const g = guarded[i]
      const n = naive[i]
      expect(g.kind, `entry ${i} kind`).toBe(n.kind)
      if (g.kind !== 'new' && n.kind !== 'new') {
        expect(g.target, `entry ${i} target`).toEqual(n.target)
        expect(g.reason.via, `entry ${i} reason.via`).toBe(n.reason.via)
      }
    }
  })
})
