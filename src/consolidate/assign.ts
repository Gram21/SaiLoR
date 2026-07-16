/**
 * Optimal one-to-one matching between two sets — the "closest overall mapping"
 * the consolidation matcher needs.
 *
 * Matching greedily (repeatedly take the best remaining pair) is the obvious
 * approach and it is wrong: one early pairing that looks good locally can force
 * two later entries into a much worse pairing, and greedy has no way to trade
 * the first against the second. This solves for the best *total* instead, which
 * is the discrete counterpart of the earth-mover formulation — every entry is
 * moved to a partner, and the arrangement with the least total "distance" wins.
 *
 * The Hungarian algorithm (Kuhn-Munkres, O(n^3) with potentials). The sets here
 * are one node's repeated entries — single digits in practice — so the cubic
 * term is irrelevant and optimality is affordable.
 */

/**
 * Pair rows with columns to maximise total weight. Returns `rowToCol`, where
 * `rowToCol[i]` is the column matched to row i, or -1 when row i is left over
 * (which happens whenever there are more rows than columns).
 *
 * Weights may be any finite numbers; only their order matters.
 */
export function maxWeightAssignment(weights: number[][]): number[] {
  const rows = weights.length
  if (rows === 0) return []
  const cols = weights[0].length
  if (cols === 0) return new Array<number>(rows).fill(-1)

  // Pad to a square: the solver below needs at least as many columns as rows,
  // and padding both ways keeps one code path for every shape. Padded cells
  // have weight 0, and any real entry matched to one is reported as unmatched.
  const size = Math.max(rows, cols)
  let best = 0
  for (const row of weights) for (const w of row) if (w > best) best = w

  // Maximising weight is minimising (best - weight): a plain negation would
  // leave negative costs, which the potentials below are not set up for.
  const cost: number[][] = []
  for (let i = 0; i < size; i++) {
    const row = new Array<number>(size).fill(best)
    for (let j = 0; j < Math.min(cols, size); j++) {
      if (i < rows) row[j] = best - weights[i][j]
    }
    cost.push(row)
  }

  const assignment = minCostAssignment(cost)
  return assignment.slice(0, rows).map((col) => (col >= 0 && col < cols ? col : -1))
}

/**
 * Minimum-cost perfect matching on a square, non-negative cost matrix.
 *
 * The classic potentials formulation: `u`/`v` hold the row/column potentials,
 * `p[j]` the row currently matched to column j, and each outer pass grows an
 * alternating tree from one new row until it reaches a free column, then walks
 * `way` back to flip the path. Indices run 1-based here because column 0 is the
 * sentinel the tree is rooted at.
 */
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(n + 1).fill(0)
  const p = new Array<number>(n + 1).fill(0)
  const way = new Array<number>(n + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(n + 1).fill(Infinity)
    const used = new Array<boolean>(n + 1).fill(false)

    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)

    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  const rowToCol = new Array<number>(n).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j] > 0) rowToCol[p[j] - 1] = j - 1
  return rowToCol
}
