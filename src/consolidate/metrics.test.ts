import { describe, it, expect } from 'vitest'
import {
  cohenKappa,
  cohenKappaApplicable,
  fleissKappa,
  fleissKappaApplicable,
  krippendorffAlpha,
  krippendorffAlphaApplicable,
  type MetricInput,
  type Ratings,
} from './metrics'

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

describe('cohenKappaApplicable', () => {
  it('accepts exactly two raters', () => {
    expect(cohenKappaApplicable({ raters: ['1', '2'], units: [] }).usable).toBe(true)
  })

  it('rejects one rater, by name', () => {
    const result = cohenKappaApplicable({ raters: ['1'], units: [] })
    expect(result.usable).toBe(false)
    expect(result.reason).toBe("Cohen's κ compares exactly two reviewers; this project has 1.")
  })

  it('rejects three raters, by name', () => {
    const result = cohenKappaApplicable({ raters: ['1', '2', '3'], units: [] })
    expect(result.usable).toBe(false)
    expect(result.reason).toBe("Cohen's κ compares exactly two reviewers; this project has 3.")
  })
})

describe('cohenKappa', () => {
  // Wikipedia, "Cohen's kappa" — worked example: two readers rate 50 items
  // yes/no for whether further study is needed.
  //   Reader B: Yes  No
  //   Reader A Yes:   20   5
  //   Reader A No:    10  15
  // po = (20+15)/50 = 0.7, pe = 0.5*0.6 + 0.5*0.4 = 0.5, kappa = 0.4.
  // https://en.wikipedia.org/wiki/Cohen%27s_kappa
  it('matches the Wikipedia worked example (kappa = 0.4)', () => {
    const units: Ratings[] = [
      ...Array(20).fill({ A: 'Yes', B: 'Yes' }),
      ...Array(5).fill({ A: 'Yes', B: 'No' }),
      ...Array(10).fill({ A: 'No', B: 'Yes' }),
      ...Array(15).fill({ A: 'No', B: 'No' }),
    ]
    const result = cohenKappa({ raters: ['A', 'B'], units })
    expect(result.value).toBeCloseTo(0.4, 5)
    expect(result.note).toBeUndefined()
  })

  it('is not applicable with other than two raters, and says so', () => {
    const result = cohenKappa({ raters: ['1', '2', '3'], units: [] })
    expect(result.value).toBeNull()
    expect(result.note).toBe("Cohen's κ compares exactly two reviewers; this project has 3.")
  })

  it('scores perfect agreement across more than two categories as exactly 1', () => {
    const units: Ratings[] = [
      { A: 'RCT', B: 'RCT' },
      { A: 'Survey', B: 'Survey' },
      { A: 'Case study', B: 'Case study' },
      { A: 'RCT', B: 'RCT' },
    ]
    expect(cohenKappa({ raters: ['A', 'B'], units }).value).toBeCloseTo(1, 10)
  })

  it('scores systematic disagreement as negative', () => {
    // Both raters use both categories equally often (so pe = 0.5) but never
    // agree with each other on the same unit (so po = 0): kappa = -1.
    const units: Ratings[] = [
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'X' },
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'X' },
    ]
    expect(cohenKappa({ raters: ['A', 'B'], units }).value).toBeCloseTo(-1, 10)
  })

  it('scores agreement no better than chance as approximately 0', () => {
    // Independent-looking split: both raters use X and Y half the time, and
    // agreement lands right at what the marginals alone predict.
    const units: Ratings[] = [
      { A: 'X', B: 'X' },
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'X' },
      { A: 'Y', B: 'Y' },
    ]
    expect(cohenKappa({ raters: ['A', 'B'], units }).value).toBeCloseTo(0, 10)
  })

  it('is undefined, not 0, when both raters used one shared category throughout', () => {
    const units: Ratings[] = [
      { A: 'RCT', B: 'RCT' },
      { A: 'RCT', B: 'RCT' },
      { A: 'RCT', B: 'RCT' },
    ]
    const result = cohenKappa({ raters: ['A', 'B'], units })
    expect(result.value).toBeNull()
    expect(result.note).toMatch(/undefined/)
  })

  it('ignores units either rater left blank', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'X' },
      { A: 'X', B: 'Y' },
      { A: null, B: 'X' }, // A never got to this one
      { A: 'Y', B: null }, // B never got to this one
    ]
    const withGaps = cohenKappa({ raters: ['A', 'B'], units })
    const withoutGaps = cohenKappa({
      raters: ['A', 'B'],
      units: [
        { A: 'X', B: 'X' },
        { A: 'X', B: 'Y' },
      ],
    })
    expect(withGaps.value).toBeCloseTo(withoutGaps.value as number, 10)
  })

  it('treats a missing key the same as an explicit null', () => {
    const units: Ratings[] = [{ A: 'X', B: 'X' }, { A: 'X' }, { A: 'Y', B: 'Y' }]
    // Second unit: B never rated it at all (no key), same as B: null.
    const result = cohenKappa({ raters: ['A', 'B'], units })
    expect(result.value).toBeCloseTo(1, 10)
  })

  it('is null with zero units', () => {
    const result = cohenKappa({ raters: ['A', 'B'], units: [] })
    expect(result.value).toBeNull()
    expect(result.note).toMatch(/at least two/)
  })

  it('is null with only one usable (both-rated) unit', () => {
    const units: Ratings[] = [{ A: 'X', B: 'X' }, { A: null, B: 'Y' }]
    const result = cohenKappa({ raters: ['A', 'B'], units })
    expect(result.value).toBeNull()
    expect(result.note).toBe("Cohen's κ needs at least two fields both reviewers rated; this project has 1.")
  })

  it('is null when nobody rated anything', () => {
    const units: Ratings[] = [{ A: null, B: null }, { A: null, B: null }]
    const result = cohenKappa({ raters: ['A', 'B'], units })
    expect(result.value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fleiss' kappa
// ---------------------------------------------------------------------------

describe('fleissKappaApplicable', () => {
  it('accepts a fully-rated set', () => {
    const units: Ratings[] = [
      { '1': 'X', '2': 'X', '3': 'Y' },
      { '1': 'Y', '2': 'Y', '3': 'Y' },
    ]
    expect(fleissKappaApplicable({ raters: ['1', '2', '3'], units }).usable).toBe(true)
  })

  it('rejects fewer than two raters, by name', () => {
    const result = fleissKappaApplicable({ raters: ['1'], units: [] })
    expect(result.usable).toBe(false)
    expect(result.reason).toBe("Fleiss' κ needs at least two reviewers; this project has 1.")
  })

  it('rejects a set with some partially-rated units, and counts them', () => {
    const units: Ratings[] = [
      { '1': 'X', '2': 'X', '3': 'Y' },
      { '1': 'Y', '2': 'Y', '3': null }, // reviewer 3 skipped this one
      { '1': 'X', '2': 'X', '3': 'X' },
      { '1': null, '2': 'X', '3': 'X' }, // reviewer 1 skipped this one
    ]
    const result = fleissKappaApplicable({ raters: ['1', '2', '3'], units })
    expect(result.usable).toBe(false)
    expect(result.reason).toBe("Fleiss' κ needs every reviewer to have rated every field; 2 of 4 were rated by only some.")
  })

  it('treats an absent key the same as an explicit null when counting completeness', () => {
    const units: Ratings[] = [{ '1': 'X', '2': 'X' }] // '2' has no '3' key at all
    const result = fleissKappaApplicable({ raters: ['1', '2', '3'], units })
    expect(result.usable).toBe(false)
    expect(result.reason).toMatch(/1 of 1/)
  })
})

describe('fleissKappa', () => {
  // Fleiss (1971), "Measuring nominal scale agreement among many raters" —
  // the canonical worked example: 10 subjects, each diagnosed by 14
  // psychiatrists into one of 5 categories. Table 1 gives these per-subject
  // counts; the paper reports P-bar = 0.378, P-bar-e = 0.213, kappa = 0.210.
  // Reproduced at https://en.wikipedia.org/wiki/Fleiss%27_kappa
  it('matches the Fleiss (1971) worked example (kappa = 0.210)', () => {
    const table: number[][] = [
      [0, 0, 0, 0, 14],
      [0, 2, 6, 4, 2],
      [0, 0, 3, 5, 6],
      [0, 3, 9, 2, 0],
      [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0],
      [3, 2, 6, 3, 0],
      [2, 5, 3, 2, 2],
      [6, 5, 2, 1, 0],
      [0, 2, 2, 3, 7],
    ]
    const categories = ['Depression', 'Personality disorder', 'Schizophrenia', 'Neurosis', 'Other']
    // Expand each subject's category counts into 14 individual raters. Which
    // rater id gets which slot does not matter to Fleiss' kappa (it is
    // deliberately anonymous, see the doc comment in metrics.ts), so the same
    // 14 synthetic ids are reused, in a fixed order, for every subject.
    const raters = Array.from({ length: 14 }, (_, i) => `r${i}`)
    const units: Ratings[] = table.map((counts) => {
      const slots: string[] = []
      counts.forEach((count, catIndex) => {
        for (let i = 0; i < count; i++) slots.push(categories[catIndex])
      })
      const unit: Ratings = {}
      raters.forEach((r, i) => {
        unit[r] = slots[i]
      })
      return unit
    })

    const result = fleissKappa({ raters, units })
    expect(result.value).toBeCloseTo(0.21, 2)
    expect(result.note).toBeUndefined()
  })

  it('is not applicable, and says so, when ratings are incomplete', () => {
    const units: Ratings[] = [{ '1': 'X', '2': 'X', '3': null }]
    const result = fleissKappa({ raters: ['1', '2', '3'], units })
    expect(result.value).toBeNull()
    expect(result.note).toMatch(/every reviewer/)
  })

  it('scores perfect agreement across several categories as exactly 1', () => {
    const units: Ratings[] = [
      { '1': 'X', '2': 'X', '3': 'X' },
      { '1': 'Y', '2': 'Y', '3': 'Y' },
      { '1': 'Z', '2': 'Z', '3': 'Z' },
    ]
    expect(fleissKappa({ raters: ['1', '2', '3'], units }).value).toBeCloseTo(1, 10)
  })

  it('is undefined, not 0, when every rater used one shared category throughout', () => {
    const units: Ratings[] = [
      { '1': 'X', '2': 'X', '3': 'X' },
      { '1': 'X', '2': 'X', '3': 'X' },
    ]
    const result = fleissKappa({ raters: ['1', '2', '3'], units })
    expect(result.value).toBeNull()
    expect(result.note).toMatch(/undefined/)
  })

  it('is null with zero units', () => {
    const result = fleissKappa({ raters: ['1', '2'], units: [] })
    expect(result.value).toBeNull()
  })

  it('is null with only one rated field', () => {
    const units: Ratings[] = [{ '1': 'X', '2': 'Y' }]
    const result = fleissKappa({ raters: ['1', '2'], units })
    expect(result.value).toBeNull()
    expect(result.note).toBe("Fleiss' κ needs at least two rated fields to compare; this project has 1.")
  })
})

// ---------------------------------------------------------------------------
// Krippendorff's alpha
// ---------------------------------------------------------------------------

describe('krippendorffAlphaApplicable', () => {
  it('accepts two or more raters regardless of missing data', () => {
    expect(krippendorffAlphaApplicable({ raters: ['1', '2'], units: [] }).usable).toBe(true)
    expect(krippendorffAlphaApplicable({ raters: ['1', '2', '3', '4'], units: [] }).usable).toBe(true)
  })

  it('rejects fewer than two raters, by name', () => {
    const result = krippendorffAlphaApplicable({ raters: ['1'], units: [] })
    expect(result.usable).toBe(false)
    expect(result.reason).toBe("Krippendorff's α needs at least two reviewers; this project has 1.")
  })
})

describe('krippendorffAlpha', () => {
  // Krippendorff, "Computing Krippendorff's Alpha-Reliability" (2011),
  // https://www.asc.upenn.edu/sites/default/files/2021-03/Computing%20Krippendorff's%20Alpha-Reliability.pdf
  // — the standard worked example reused throughout the literature (e.g. the
  // `kalpha` SPSS/SAS macro's own test data, and the `krippendorff` PyPI
  // package's test suite): 3 coders (A, B, C), 15 units, values 1-4, '*' =
  // not rated.
  //   Unit:      1  2  3  4  5  6  7  8  9  10 11 12 13 14 15
  //   Coder A:   *  *  *  *  *  3  4  1  2  1  1  3  3  *  3
  //   Coder B:   1  *  2  1  3  3  4  3  *  *  *  *  *  *  *
  //   Coder C:   *  *  2  1  3  4  4  *  2  1  1  3  3  *  4
  // The paper reports alpha (nominal) = 0.691. Hand-rederiving it from the
  // coincidence matrix the paper shows (n = 26 pairable values, Do = 6/26,
  // De = 486/650) gives the exact fraction alpha = 56/81 = 0.691358...,
  // which is the number asserted below to full precision rather than just
  // the paper's rounded 0.691.
  it("matches Krippendorff's own worked example (alpha = 56/81)", () => {
    const A = [null, null, null, null, null, '3', '4', '1', '2', '1', '1', '3', '3', null, '3']
    const B = ['1', null, '2', '1', '3', '3', '4', '3', null, null, null, null, null, null, null]
    const C = [null, null, '2', '1', '3', '4', '4', null, '2', '1', '1', '3', '3', null, '4']

    const units: Ratings[] = A.map((_, i) => ({ A: A[i], B: B[i], C: C[i] }))
    const result = krippendorffAlpha({ raters: ['A', 'B', 'C'], units })
    expect(result.value).toBeCloseTo(56 / 81, 10)
    expect(result.value).toBeCloseTo(0.691, 3)
    expect(result.note).toBeUndefined()
  })

  // Deliberately does *not* assert alpha equals Cohen's kappa here, even
  // though both apply to two complete raters: they are genuinely different
  // numbers, not two derivations of the same one. Kappa's chance term
  // multiplies each rater's *own* marginal distribution; alpha's (like
  // Scott's pi, which it generalises) pools both raters into one shared
  // distribution before squaring it. Hand-derived below, with the working
  // shown, since the two raters here have different marginals on purpose —
  // that is exactly the condition under which the two coefficients part ways.
  //
  //   units: (X,X) (X,Y) (Y,Y), raters A, B, m=2 throughout.
  //   Coincidences: n_XX=2 (unit 1), n_XY=1, n_YX=1 (unit 2), n_YY=2 (unit 3).
  //   n = 3 units * 2 raters = 6. marginal X = 2+1 = 3, marginal Y = 1+2 = 3.
  //   Do = (n_XY + n_YX)/n = 2/6 = 1/3.
  //   De = (n^2 - (3^2+3^2)) / (n(n-1)) = (36-18)/30 = 3/5.
  //   alpha = 1 - (1/3)/(3/5) = 1 - 5/9 = 4/9.
  //   (Cohen's kappa on the same data is 2/5 = 0.4 — a different number,
  //   confirming this is a real divergence and not a typo.)
  it('is a genuinely different number from Cohen kappa on the same two-rater data', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'X' },
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'Y' },
    ]
    const alpha = krippendorffAlpha({ raters: ['A', 'B'], units }).value
    const kappa = cohenKappa({ raters: ['A', 'B'], units }).value
    expect(alpha).toBeCloseTo(4 / 9, 10)
    expect(kappa).toBeCloseTo(2 / 5, 10)
  })

  it('tolerates a unit only one rater reached, by excluding it', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'X', C: 'X' },
      { A: 'Y', B: 'Y', C: 'Y' },
      { A: 'X', B: null, C: null }, // only A rated this one
    ]
    const withStray = krippendorffAlpha({ raters: ['A', 'B', 'C'], units })
    const withoutStray = krippendorffAlpha({ raters: ['A', 'B', 'C'], units: units.slice(0, 2) })
    expect(withStray.value).toBeCloseTo(withoutStray.value as number, 10)
  })

  it('scores perfect agreement across several categories as exactly 1', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'X', C: 'X' },
      { A: 'Y', B: 'Y', C: 'Y' },
      { A: 'Z', B: 'Z', C: 'Z' },
    ]
    expect(krippendorffAlpha({ raters: ['A', 'B', 'C'], units }).value).toBeCloseTo(1, 10)
  })

  // Unlike Cohen's kappa, alpha is not bounded at exactly -1 for total
  // disagreement at small sample sizes — its expected-disagreement term
  // carries the n/(n-1) finite-sample correction, which pulls De down from
  // what it would be at the infinite-sample limit and so pulls alpha above
  // -1. It still must land clearly negative, which is the property this
  // pins down; the exact value is hand-derived and shown so the -0.75 is not
  // mistaken for an arbitrary tolerance.
  //
  //   units: (X,Y) (Y,X) (X,Y) (Y,X), raters A, B, m=2 throughout.
  //   Coincidences: every unit contributes one X-Y and one Y-X pairing, so
  //   n_XY = n_YX = 4 (one per unit), n_XX = n_YY = 0.
  //   n = 4 units * 2 raters = 8. marginal X = 4, marginal Y = 4.
  //   Do = (n_XY + n_YX)/n = 8/8 = 1.
  //   De = (n^2 - (4^2+4^2)) / (n(n-1)) = (64-32)/56 = 4/7.
  //   alpha = 1 - 1/(4/7) = 1 - 7/4 = -3/4.
  it('scores systematic disagreement as clearly negative', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'X' },
      { A: 'X', B: 'Y' },
      { A: 'Y', B: 'X' },
    ]
    const result = krippendorffAlpha({ raters: ['A', 'B'], units })
    expect(result.value).toBeCloseTo(-3 / 4, 10)
    expect(result.value as number).toBeLessThan(0)
  })

  it('is undefined, not 1, when every pairable rating was the same shared category', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'X', C: 'X' },
      { A: 'X', B: 'X', C: 'X' },
    ]
    const result = krippendorffAlpha({ raters: ['A', 'B', 'C'], units })
    expect(result.value).toBeNull()
    expect(result.note).toMatch(/undefined/)
  })

  it('is null with zero units', () => {
    const result = krippendorffAlpha({ raters: ['A', 'B'], units: [] })
    expect(result.value).toBeNull()
  })

  it('is null when only one unit is pairable (rated by two or more)', () => {
    const units: Ratings[] = [
      { A: 'X', B: 'Y' },
      { A: 'X', B: null }, // not pairable: only one rater
    ]
    const result = krippendorffAlpha({ raters: ['A', 'B'], units })
    expect(result.value).toBeNull()
    expect(result.note).toBe(
      "Krippendorff's α needs at least two fields rated by two or more reviewers; this project has 1.",
    )
  })

  it('is null when a unit nobody rated is the only unit present', () => {
    const units: Ratings[] = [{ A: null, B: null }]
    const result = krippendorffAlpha({ raters: ['A', 'B'], units })
    expect(result.value).toBeNull()
  })
})
