import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef, type ResolvedDef } from '../model/schema'
import {
  levenshtein,
  normalizeText,
  stringSimilarity,
  valueSimilarity,
  combine,
  agreementMass,
  NO_EVIDENCE,
} from './similarity'

/** Resolve a one-node schema and hand back the resolved def. */
function def(node: AnnotationDef): ResolvedDef {
  return resolveSchema([node])[0]
}

describe('levenshtein', () => {
  it('measures edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('same', 'same')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })

  it('is symmetric', () => {
    expect(levenshtein('flaw', 'lawn')).toBe(levenshtein('lawn', 'flaw'))
  })
})

describe('normalizeText', () => {
  it('folds away case, padding and punctuation', () => {
    expect(normalizeText('  Controlled   Experiment. ')).toBe('controlled experiment')
    expect(normalizeText('RCT.')).toBe('rct')
    expect(normalizeText('“quoted”')).toBe('quoted')
  })
})

describe('stringSimilarity', () => {
  it('scores 1 for answers that differ only in how they were typed', () => {
    expect(stringSimilarity('Controlled experiment', 'controlled  experiment.')).toBe(1)
  })

  it('scores a typo as nearly the same', () => {
    expect(stringSimilarity('participants', 'participant')).toBeGreaterThan(0.9)
  })

  it('survives reordered words, which edit distance alone does not', () => {
    // Edit distance is poor here; word overlap carries it.
    expect(stringSimilarity('students and engineers', 'engineers and students')).toBeGreaterThan(0.9)
  })

  it('scores unrelated answers low', () => {
    expect(stringSimilarity('controlled experiment', 'literature survey')).toBeLessThan(0.4)
  })

  it('does not pretend to understand meaning', () => {
    // Documents the known limit rather than asserting a capability it lacks:
    // these mean the same thing and share almost no characters.
    expect(stringSimilarity('RCT', 'randomised controlled trial')).toBeLessThan(0.5)
  })

  it('scores an empty side as no match', () => {
    expect(stringSimilarity('', 'something')).toBe(0)
  })

  it('gives the same answer with and without the cache', () => {
    const cache = new Map<string, number>()
    const pairs: Array<[string, string]> = [
      ['controlled experiment', 'controlled study'],
      ['a', 'b'],
      ['same', 'same'],
      ['students and engineers', 'engineers and students'],
    ]
    for (const [a, b] of pairs) {
      expect(stringSimilarity(a, b, cache)).toBe(stringSimilarity(a, b))
    }
  })

  it('answers the same whichever way round the pair is asked', () => {
    // The cache stores one entry per unordered pair, so a key collision between
    // the two orders would surface here.
    const cache = new Map<string, number>()
    const first = stringSimilarity('alpha beta', 'beta gamma', cache)
    const second = stringSimilarity('beta gamma', 'alpha beta', cache)
    expect(second).toBe(first)
    expect(cache.size).toBe(1)
  })

  it('does not confuse two pairs whose halves join to the same text', () => {
    // ("aa bb","bb") and ("aa","bb bb") join to "aa bb bb" under any separator
    // that can occur in the text — a space would make the second pair inherit
    // the first's answer. These two genuinely differ, so a collision shows up
    // as a wrong number rather than merely a smaller cache.
    expect(stringSimilarity('aa bb', 'bb')).not.toBe(stringSimilarity('aa', 'bb bb'))

    const cache = new Map<string, number>()
    expect(stringSimilarity('aa bb', 'bb', cache)).toBe(stringSimilarity('aa bb', 'bb'))
    expect(stringSimilarity('aa', 'bb bb', cache)).toBe(stringSimilarity('aa', 'bb bb'))
    expect(cache.size).toBe(2)
  })
})

describe('valueSimilarity', () => {
  const text = def({ name: 'Claim', type: 'string' })
  const enumDef = def({ name: 'Level', type: 'string', options: ['High', 'Medium', 'Low'] })
  const num = def({ name: 'Participants', type: 'number' })
  const bool = def({ name: 'Replicated', type: 'boolean' })

  it('abstains when either side is blank', () => {
    expect(valueSimilarity(text, null, 'something')).toEqual(NO_EVIDENCE)
    expect(valueSimilarity(text, '  ', 'something')).toEqual(NO_EVIDENCE)
    expect(valueSimilarity(text, undefined, undefined)).toEqual(NO_EVIDENCE)
  })

  it('compares enum values as labels, never as text', () => {
    // "High"/"Low" would score >0 on characters alone and mean the opposite.
    expect(valueSimilarity(enumDef, 'High', 'Low')).toEqual({ score: 0, weight: 1 })
    expect(valueSimilarity(enumDef, 'High', 'high')).toEqual({ score: 1, weight: 1 })
  })

  it('scores numbers by relative closeness', () => {
    expect(valueSimilarity(num, 40, 40)).toEqual({ score: 1, weight: 1 })
    expect(valueSimilarity(num, 40, 41).score).toBeGreaterThan(0.95)
    expect(valueSimilarity(num, 40, 4000).score).toBeLessThan(0.1)
  })

  it('ignores a boolean nobody ticked', () => {
    // Every untouched boolean in the project reads false; counting those as
    // agreement would make every pair of entries look alike.
    expect(valueSimilarity(bool, false, false)).toEqual(NO_EVIDENCE)
    expect(valueSimilarity(bool, true, true)).toEqual({ score: 1, weight: 1 })
    expect(valueSimilarity(bool, true, false)).toEqual({ score: 0, weight: 1 })
  })
})

describe('combine', () => {
  it('ignores parts that carry no evidence', () => {
    expect(combine([{ score: 1, weight: 1 }, NO_EVIDENCE])).toEqual({ score: 1, weight: 1 })
  })

  it('returns no evidence when nothing was comparable', () => {
    expect(combine([NO_EVIDENCE, NO_EVIDENCE])).toEqual(NO_EVIDENCE)
    expect(combine([])).toEqual(NO_EVIDENCE)
  })

  it('carries the total weight forward, so bigger agreements outrank smaller', () => {
    const one = combine([{ score: 1, weight: 1 }])
    const three = combine([
      { score: 1, weight: 1 },
      { score: 1, weight: 1 },
      { score: 1, weight: 1 },
    ])
    // Both agree perfectly, so the scores tie...
    expect(three.score).toBe(one.score)
    // ...and only the weight tells them apart, which is what the matcher ranks on.
    expect(agreementMass(three)).toBeGreaterThan(agreementMass(one))
  })

  it('weights the mean by how much each part rests on', () => {
    expect(combine([
      { score: 1, weight: 3 },
      { score: 0, weight: 1 },
    ]).score).toBe(0.75)
  })
})
