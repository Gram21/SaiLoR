import type { Paper } from '../model/project'
import { displayPath } from '../llm/paths'
import { formatValue, type FieldVerdict } from './disagreements'

/**
 * Render one paper's block of the disagreement export: its metadata, then
 * every disagreement in it — the exact field location, then each reviewer
 * who answered and what they said. `verdicts` must already be filtered down
 * to disagreements (the same rule `consolidationFieldStatus(...) ===
 * 'disagree'` applies in `DisagreementOverview`/`ConsolidationOverview`) —
 * this function only formats, it does not decide what counts as one.
 */
export function paperDisagreementsText(paper: Paper, verdicts: FieldVerdict[]): string {
  const lines = [
    `ID: ${paper.id}`,
    `Authors: ${paper.authors.length > 0 ? paper.authors.join(', ') : '(none recorded)'}`,
    `Title: ${paper.title}`,
    '',
  ]

  if (verdicts.length === 0) {
    lines.push('No disagreements.')
    return lines.join('\n')
  }

  for (const v of verdicts) {
    lines.push(displayPath([...v.path, { name: v.name, index: v.index }]))
    for (const r of v.answeredBy) lines.push(`  R${r}: ${formatValue(v.def, v.values[r])}`)
    lines.push('')
  }
  lines.pop() // no trailing blank line after the last entry

  return lines.join('\n')
}

/** Separates one paper's block from the next in a project-wide export. */
const PAPER_SEPARATOR = `\n\n${'─'.repeat(40)}\n\n`

/**
 * Every paper that has at least one disagreement, in `papers` order, each
 * rendered by `paperDisagreementsText` and joined by a divider — a paper
 * with none is skipped outright, matching what `ConsolidationOverview`'s own
 * list shows (it never lists a paper with a zero count either).
 */
export function projectDisagreementsText(papers: Paper[], verdictsByPaper: Map<string, FieldVerdict[]>): string {
  return papers
    .map((paper) => ({ paper, verdicts: verdictsByPaper.get(paper.id) ?? [] }))
    .filter(({ verdicts }) => verdicts.length > 0)
    .map(({ paper, verdicts }) => paperDisagreementsText(paper, verdicts))
    .join(PAPER_SEPARATOR)
}
