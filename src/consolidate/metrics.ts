/**
 * Nominal-scale inter-rater agreement coefficients: Cohen's κ, Fleiss' κ and
 * Krippendorff's α.
 *
 * Deliberately knows nothing about papers, schemas, fields or reviewers — the
 * caller reduces whatever it is measuring agreement over down to an opaque
 * "unit" (one thing that got categorised) and a "rater" (an opaque id), and
 * this module does the arithmetic. That separation is what lets the same three
 * functions be reused for any categorical field, without this file having to
 * know how a project's annotation tree is shaped or grow a dependency on it.
 *
 * All three coefficients answer the same question — "how much do these raters
 * agree, once agreement expected by pure chance is subtracted out" — but they
 * disagree on how forgiving to be about *missing* ratings, which is why a
 * caller is given three rather than one: Cohen's κ only ever looks at two
 * raters and only at what both of them rated; Fleiss' κ generalises to more
 * raters but, in its classic form, cannot make sense of a rater who skipped a
 * unit; Krippendorff's α is the one built to tolerate the gaps a real review
 * always has. `*Applicable` reports which of the three actually fit the shape
 * of the data at hand, in language a reviewer (not a statistician) can read.
 */

/** How each rater categorised one unit. `null` = that rater did not rate it. */
export type Ratings = Record<string, string | null>

export interface MetricInput {
  /** Every rater id that could rate, e.g. ["1","2","3"]. */
  raters: string[]
  /** One entry per unit of analysis (here: one annotation field on one paper). */
  units: Ratings[]
}

export interface MetricResult {
  /** The coefficient, or null when it is not defined for this input. */
  value: number | null
  /** Why it is null, or a caveat the reader must see. Absent when unremarkable. */
  note?: string
}

/** Whether a metric can honestly be computed, and if not, why — shown to the user. */
export interface Applicability {
  usable: boolean
  /** Present when `usable` is false. A complete, user-facing sentence. */
  reason?: string
}

/**
 * A rater's entry for one unit, with an absent key treated the same as an
 * explicit `null`.
 *
 * The contract only promises `Ratings` is keyed by rater id where the rater
 * actually has an opinion; nothing here requires every rater id to be present
 * with an explicit `null`. Reading `unit[rater]` for a missing key returns
 * `undefined` at runtime even though the declared type says `string | null`,
 * so every lookup goes through this rather than trusting the type.
 */
function ratingOf(unit: Ratings, rater: string): string | null {
  const value: string | null | undefined = unit[rater]
  return value ?? null
}

/**
 * The `pe = 1` / `De = 0` trap shared by all three coefficients: when every
 * rating anyone gave, across the whole computation, was the same one
 * category, there was never any variation to disagree about. Observed
 * agreement is then necessarily total too, so the coefficient's numerator and
 * denominator are both exactly zero — a true `0/0`, not a `0`. Reporting `0`
 * would say "no better than chance" about a case with no chance involved at
 * all (chance agreement is total, same as observed agreement); reporting `1`
 * would claim a certainty the data cannot support (there was nothing to tell
 * agreement apart from a shared blind spot). Undefined is the only honest
 * answer, so every metric below detects this by construction — one shared
 * category across the board — rather than by noticing the arithmetic would
 * divide by zero, which floating point can mask with a near-zero denominator
 * instead of an exact one.
 */
function degenerateNote(coefficient: string): string {
  return (
    `Every rating was the same, single category, so agreement is total — but that also makes ` +
    `chance agreement total, leaving ${coefficient} undefined (a 0/0), not the 0 or 1 it might ` +
    `look like at a glance.`
  )
}

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

/**
 * Cohen's κ is defined for exactly two raters — its `pe` comes from
 * multiplying each rater's own marginal distribution together, which is only
 * meaningful pairwise. Three raters do not have "a" pairwise chance-agreement
 * figure; that is what Fleiss' κ is for instead.
 */
export function cohenKappaApplicable(input: MetricInput): Applicability {
  if (input.raters.length !== 2) {
    return {
      usable: false,
      reason: `Cohen's κ compares exactly two reviewers; this project has ${input.raters.length}.`,
    }
  }
  return { usable: true }
}

/**
 * Cohen's κ = (po - pe) / (1 - pe) over the two named raters.
 *
 * Only units both raters actually rated count — a unit either of them left
 * blank says nothing about whether these two agree, exactly as
 * {@link ratingOf} treats a missing key. `pe` is computed from each rater's
 * own marginal distribution *restricted to those co-rated units*, matching
 * every textbook worked example (their marginals are not "everything this
 * rater ever rated", which would mix in units the other rater never saw).
 */
export function cohenKappa(input: MetricInput): MetricResult {
  const applicability = cohenKappaApplicable(input)
  if (!applicability.usable) return { value: null, note: applicability.reason }

  const [r1, r2] = input.raters
  const pairs: Array<[string, string]> = []
  for (const unit of input.units) {
    const a = ratingOf(unit, r1)
    const b = ratingOf(unit, r2)
    if (a !== null && b !== null) pairs.push([a, b])
  }

  if (pairs.length < 2) {
    return {
      value: null,
      note: `Cohen's κ needs at least two fields both reviewers rated; this project has ${pairs.length}.`,
    }
  }

  const countsA = new Map<string, number>()
  const countsB = new Map<string, number>()
  let agree = 0
  for (const [a, b] of pairs) {
    if (a === b) agree++
    countsA.set(a, (countsA.get(a) ?? 0) + 1)
    countsB.set(b, (countsB.get(b) ?? 0) + 1)
  }

  const n = pairs.length
  const po = agree / n

  // A single shared category on both sides is exactly the pe = 1 trap: see
  // degenerateNote. Detected structurally (one category, same on both sides)
  // rather than by testing `pe === 1`, which floating-point sums of products
  // should not be trusted to hit exactly.
  const soleA = countsA.size === 1 ? [...countsA.keys()][0] : undefined
  const soleB = countsB.size === 1 ? [...countsB.keys()][0] : undefined
  if (soleA !== undefined && soleA === soleB) {
    return { value: null, note: degenerateNote("Cohen's κ") }
  }

  let pe = 0
  for (const [category, countA] of countsA) {
    const countB = countsB.get(category) ?? 0
    pe += (countA / n) * (countB / n)
  }

  return { value: (po - pe) / (1 - pe) }
}

// ---------------------------------------------------------------------------
// Fleiss' kappa
// ---------------------------------------------------------------------------

/**
 * Classic Fleiss' κ counts *how many* ratings each unit got in each category,
 * never *which* rater gave which — that anonymity is what lets it generalise
 * Cohen's κ to more than two raters without needing to pair raters up. The
 * price is that it cannot tell a rater who skipped a unit from one who was
 * never asked, so it only means what it claims to mean when every unit was
 * rated by the same number of raters. This project always offers every unit
 * to every reviewer, so "the same number" is taken to mean "every reviewer" —
 * a unit any reviewer skipped is a gap Fleiss' κ cannot see past, and Fleiss'
 * κ would otherwise silently paper over the difference between "everyone
 * agreed" and "only the reviewers who bothered to answer agreed".
 */
export function fleissKappaApplicable(input: MetricInput): Applicability {
  if (input.raters.length < 2) {
    return {
      usable: false,
      reason: `Fleiss' κ needs at least two reviewers; this project has ${input.raters.length}.`,
    }
  }

  const expected = input.raters.length
  let incomplete = 0
  for (const unit of input.units) {
    const rated = input.raters.reduce((n, r) => n + (ratingOf(unit, r) !== null ? 1 : 0), 0)
    if (rated !== expected) incomplete++
  }

  if (incomplete > 0) {
    return {
      usable: false,
      reason:
        `Fleiss' κ needs every reviewer to have rated every field; ` +
        `${incomplete} of ${input.units.length} were rated by only some.`,
    }
  }

  return { usable: true }
}

/**
 * Fleiss' κ = (P̄ - P̄e) / (1 - P̄e).
 *
 * `P̄` averages, over units, how often two raters *on that unit* agree, taken
 * over every pair of raters; `P̄e` is the chance level implied by how common
 * each category is overall. Applicability has already guaranteed every unit
 * carries exactly `raters.length` ratings, so the per-unit denominator
 * `n(n-1)` below is fixed and never zero (raters.length >= 2 is enforced by
 * {@link fleissKappaApplicable}).
 */
export function fleissKappa(input: MetricInput): MetricResult {
  const applicability = fleissKappaApplicable(input)
  if (!applicability.usable) return { value: null, note: applicability.reason }

  const n = input.raters.length
  const N = input.units.length

  if (N < 2) {
    return {
      value: null,
      note: `Fleiss' κ needs at least two rated fields to compare; this project has ${N}.`,
    }
  }

  const categoryTotals = new Map<string, number>()
  const perUnitCounts: Array<Map<string, number>> = []

  for (const unit of input.units) {
    const counts = new Map<string, number>()
    for (const r of input.raters) {
      const v = ratingOf(unit, r)
      // Applicability guarantees every rater answered; a null here would mean
      // it did not, which should never happen once that check has passed.
      if (v === null) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
      categoryTotals.set(v, (categoryTotals.get(v) ?? 0) + 1)
    }
    perUnitCounts.push(counts)
  }

  // The P̄e = 1 trap: see degenerateNote. One category across every rating,
  // on every unit, is the only way P̄e can reach exactly 1.
  if (categoryTotals.size === 1) {
    return { value: null, note: degenerateNote("Fleiss' κ") }
  }

  const totalRatings = N * n
  let pBarE = 0
  for (const total of categoryTotals.values()) {
    pBarE += (total / totalRatings) ** 2
  }

  let pBarSum = 0
  for (const counts of perUnitCounts) {
    let agreementPairs = 0
    for (const c of counts.values()) agreementPairs += c * (c - 1)
    pBarSum += agreementPairs / (n * (n - 1))
  }
  const pBar = pBarSum / N

  return { value: (pBar - pBarE) / (1 - pBarE) }
}

// ---------------------------------------------------------------------------
// Krippendorff's alpha (nominal)
// ---------------------------------------------------------------------------

/**
 * Krippendorff's α is built specifically to survive the gaps the other two
 * cannot: any number of raters, and no requirement that they rated the same
 * units. Structurally it only demands there be at least two raters to
 * disagree between in the first place — a lone rater cannot generate
 * agreement data no matter how many units they cover.
 */
export function krippendorffAlphaApplicable(input: MetricInput): Applicability {
  if (input.raters.length < 2) {
    return {
      usable: false,
      reason: `Krippendorff's α needs at least two reviewers; this project has ${input.raters.length}.`,
    }
  }
  return { usable: true }
}

/**
 * The coincidence matrix behind one unit's contribution to α.
 *
 * A unit with `m` raters produces `m x (m-1)` ordered pairs of (distinct)
 * raters' values. Each is entered into the matrix at weight `1/(m-1)` rather
 * than 1, which is the detail every naive reimplementation gets wrong: it is
 * what makes a unit's total contribution to the matrix equal `m` regardless
 * of how many raters it had, so a unit six raters agreed on does not get
 * six times the influence of one two raters agreed on. A unit with fewer than
 * two ratings has no pair to contribute at all and is skipped, per
 * Krippendorff's own definition of a "pairable" unit.
 */
function accumulateCoincidences(
  input: MetricInput,
  matrix: Map<string, Map<string, number>>,
  marginals: Map<string, number>,
): { n: number; usableUnits: number } {
  let n = 0
  let usableUnits = 0

  for (const unit of input.units) {
    const values: string[] = []
    for (const r of input.raters) {
      const v = ratingOf(unit, r)
      if (v !== null) values.push(v)
    }
    const m = values.length
    if (m < 2) continue // contributes nothing — see the doc comment above.

    usableUnits++
    n += m
    for (const v of values) marginals.set(v, (marginals.get(v) ?? 0) + 1)

    const weight = 1 / (m - 1)
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue
        const row = matrix.get(values[i]) ?? new Map<string, number>()
        row.set(values[j], (row.get(values[j]) ?? 0) + weight)
        matrix.set(values[i], row)
      }
    }
  }

  return { n, usableUnits }
}

/**
 * Krippendorff's α (nominal metric) = 1 - Do/De, via the coincidence-matrix
 * formulation:
 *
 * - `Do` is observed disagreement: the off-diagonal mass of the coincidence
 *   matrix, divided by `n` (the total pairable ratings).
 * - `De` is expected disagreement: what the off-diagonal mass would be if
 *   ratings were handed out at random in proportion to each category's
 *   overall frequency, divided by `n(n-1)` rather than `n^2` — the `n-1`
 *   rather than `n` is Krippendorff's finite-population correction (without
 *   it, α would be systematically biased for small samples, understating how
 *   much agreement really is there). `n^2 - sum(marginal^2)` is an equivalent,
 *   cheaper way to write "sum over every c != k of marginal_c * marginal_k"
 *   without a nested loop over categories.
 */
export function krippendorffAlpha(input: MetricInput): MetricResult {
  const applicability = krippendorffAlphaApplicable(input)
  if (!applicability.usable) return { value: null, note: applicability.reason }

  const matrix = new Map<string, Map<string, number>>()
  const marginals = new Map<string, number>()
  const { n, usableUnits } = accumulateCoincidences(input, matrix, marginals)

  if (usableUnits < 2) {
    return {
      value: null,
      note: `Krippendorff's α needs at least two fields rated by two or more reviewers; this project has ${usableUnits}.`,
    }
  }

  // The De = 0 trap: see degenerateNote. Reached only when a single category
  // accounts for every pairable rating.
  if (marginals.size === 1) {
    return { value: null, note: degenerateNote("Krippendorff's α") }
  }

  let observedOffDiagonal = 0
  for (const [a, row] of matrix) {
    for (const [b, weight] of row) {
      if (a !== b) observedOffDiagonal += weight
    }
  }
  const Do = observedOffDiagonal / n

  let sumOfSquares = 0
  for (const total of marginals.values()) sumOfSquares += total * total
  const De = (n * n - sumOfSquares) / (n * (n - 1))

  return { value: 1 - Do / De }
}
