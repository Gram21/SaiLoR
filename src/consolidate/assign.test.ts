import { describe, it, expect } from 'vitest'
import { maxWeightAssignment } from './assign'

/** Total weight of an assignment, ignoring rows that were left over. */
function totalOf(weights: number[][], rowToCol: number[]): number {
  return rowToCol.reduce((sum, col, row) => (col < 0 ? sum : sum + weights[row][col]), 0)
}

/** The best achievable total, by trying every possibility. Only for small n. */
function bruteForceBest(weights: number[][]): number {
  const rows = weights.length
  const cols = weights[0]?.length ?? 0
  let best = 0
  const taken = new Array<boolean>(cols).fill(false)
  const walk = (row: number, sum: number) => {
    if (row === rows) {
      if (sum > best) best = sum
      return
    }
    // Leaving a row unmatched is allowed, and is the only option once the
    // columns run out.
    walk(row + 1, sum)
    for (let col = 0; col < cols; col++) {
      if (taken[col]) continue
      taken[col] = true
      walk(row + 1, sum + weights[row][col])
      taken[col] = false
    }
  }
  walk(0, 0)
  return best
}

/** Deterministic PRNG: a failing case must be reproducible from the seed alone. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function assertValid(rowToCol: number[], rows: number, cols: number): void {
  expect(rowToCol).toHaveLength(rows)
  const seen = new Set<number>()
  for (const col of rowToCol) {
    if (col === -1) continue
    expect(col).toBeGreaterThanOrEqual(0)
    expect(col).toBeLessThan(cols)
    expect(seen.has(col)).toBe(false) // no column may be used twice
    seen.add(col)
  }
  // Every row that could have been matched must have been: leaving a row and a
  // column both free can never be better when weights are non-negative.
  const matched = rowToCol.filter((c) => c >= 0).length
  expect(matched).toBe(Math.min(rows, cols))
}

describe('maxWeightAssignment', () => {
  it('takes the diagonal when the diagonal is the best mapping', () => {
    const weights = [
      [9, 1, 1],
      [1, 9, 1],
      [1, 1, 9],
    ]
    expect(maxWeightAssignment(weights)).toEqual([0, 1, 2])
  })

  it('takes the reversed mapping when the reviewers swapped the order', () => {
    // The whole point of the matcher: entry 0 here is entry 2 over there.
    const weights = [
      [0, 0, 9],
      [0, 9, 0],
      [9, 0, 0],
    ]
    expect(maxWeightAssignment(weights)).toEqual([2, 1, 0])
  })

  it('sacrifices the single best pair when doing so wins overall', () => {
    // Greedy grabs [0][0]=10 and is then forced into [1][1]=0, totalling 10.
    // The optimum gives up that pair for 9+9=18.
    const weights = [
      [10, 9],
      [9, 0],
    ]
    const result = maxWeightAssignment(weights)
    expect(totalOf(weights, result)).toBe(18)
    expect(result).toEqual([1, 0])
  })

  it('leaves rows over when there are more rows than columns', () => {
    const weights = [[5], [8], [2]]
    const result = maxWeightAssignment(weights)
    expect(result).toEqual([-1, 0, -1]) // the strongest row takes the only column
    assertValid(result, 3, 1)
  })

  it('uses only some columns when there are more columns than rows', () => {
    const weights = [[1, 7, 3]]
    expect(maxWeightAssignment(weights)).toEqual([1])
  })

  it('handles empty input', () => {
    expect(maxWeightAssignment([])).toEqual([])
    expect(maxWeightAssignment([[]])).toEqual([-1])
  })

  it('still returns a valid mapping when every weight is zero', () => {
    // No evidence anywhere: any pairing is as good as any other, but the result
    // must still be a legal one-to-one mapping rather than nonsense.
    const result = maxWeightAssignment([
      [0, 0],
      [0, 0],
    ])
    assertValid(result, 2, 2)
  })

  it('matches brute force on random matrices of every shape', () => {
    const rand = rng(20260716)
    for (let trial = 0; trial < 300; trial++) {
      const rows = 1 + Math.floor(rand() * 5)
      const cols = 1 + Math.floor(rand() * 5)
      const weights = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => Math.floor(rand() * 20)),
      )
      const result = maxWeightAssignment(weights)
      assertValid(result, rows, cols)
      expect(totalOf(weights, result)).toBe(bruteForceBest(weights))
    }
  })

  it('matches brute force when many weights tie', () => {
    // Ties are the realistic case — plenty of entry pairs share no evidence at
    // all — and they are where a potentials bug hides.
    const rand = rng(7)
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 4)
      const weights = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => Math.floor(rand() * 2)),
      )
      expect(totalOf(weights, maxWeightAssignment(weights))).toBe(bruteForceBest(weights))
    }
  })

  it('copes with fractional weights, which is what real scores are', () => {
    const weights = [
      [0.9, 0.1],
      [0.85, 0.2],
    ]
    // Row 0 is the better match for column 0, but row 1 loses less by moving.
    const result = maxWeightAssignment(weights)
    expect(totalOf(weights, result)).toBeCloseTo(1.1, 10)
  })
})
