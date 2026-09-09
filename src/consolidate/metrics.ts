/**
 * Nominal-scale inter-rater agreement coefficients: Cohen's κ, Fleiss' κ and
 * Krippendorff's α. Deliberately agnostic to papers/schemas/fields — callers
 * reduce whatever they measure down to opaque "unit" and "rater" ids.
 *
 * Three coefficients exist because they differ in how forgiving they are of
 * missing ratings: Cohen's κ needs exactly two raters and only shared units;
 * Fleiss' κ generalises to more raters but can't handle skipped units;
 * Krippendorff's α tolerates gaps. `*Applicable` reports which fits the data.
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
 * A missing key reads as `undefined` at runtime even though the declared type
 * says `string | null` (a rater need not have an entry at all), so every
 * lookup goes through here rather than trusting the type.
 */
function ratingOf(unit: Ratings, rater: string): string | null {
  const value: string | null | undefined = unit[rater]
  return value ?? null
}

/**
 * The `pe = 1` / `De = 0` trap shared by all three coefficients: if every
 * rating was the same single category, numerator and denominator are both
 * exactly zero (a true `0/0`, neither "no better than chance" nor certainty).
 * Detected structurally (one shared category) rather than via `=== 1`, since
 * floating-point sums can mask this as a near-zero denominator instead of exact.
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
 * Cohen's κ is defined for exactly two raters — `pe` comes from multiplying
 * each rater's marginal distribution together, which only makes sense pairwise.
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
 * Only units both raters actually rated count. `pe` uses each rater's marginal
 * distribution restricted to those co-rated units (not everything they ever
 * rated), matching the standard textbook definition.
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

  // pe = 1 trap: see degenerateNote.
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
 * Classic Fleiss' κ counts *how many* ratings each unit got per category,
 * never *which* rater gave which — this anonymity is what generalises past
 * two raters, but it can't distinguish "skipped" from "never asked", so it
 * only means what it claims when every unit was rated by every reviewer.
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
 * Fleiss' κ = (P̄ - P̄e) / (1 - P̄e). `P̄` averages, over units, pairwise rater
 * agreement on that unit; `P̄e` is the chance level from overall category
 * frequency. Applicability already guarantees `n(n-1)` below is never zero.
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
      // Applicability guarantees this is never null.
      if (v === null) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
      categoryTotals.set(v, (categoryTotals.get(v) ?? 0) + 1)
    }
    perUnitCounts.push(counts)
  }

  // P̄e = 1 trap: see degenerateNote.
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
 * Krippendorff's α tolerates the gaps the other two can't: any number of
 * raters, no requirement they rated the same units. Just needs >= 2 raters.
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
 * A unit with `m` raters produces `m x (m-1)` ordered pairs, each weighted
 * `1/(m-1)` rather than 1 — this is the detail naive reimplementations miss:
 * it keeps a unit's total contribution equal to `m` regardless of rater count,
 * so a 6-rater unit doesn't outweigh a 2-rater one. Units with < 2 ratings
 * are skipped ("pairable" units only, per Krippendorff's definition).
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
 * Krippendorff's α (nominal) = 1 - Do/De via the coincidence matrix.
 *
 * `Do` is observed disagreement: off-diagonal matrix mass / `n` (pairable
 * ratings). `De` is expected disagreement under random assignment, divided by
 * `n(n-1)` — the `-1` is Krippendorff's finite-population correction (without
 * it, α is biased for small samples). `n^2 - sum(marginal^2)` cheaply computes
 * "sum over c != k of marginal_c * marginal_k" without nesting over categories.
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

  // De = 0 trap: see degenerateNote.
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
