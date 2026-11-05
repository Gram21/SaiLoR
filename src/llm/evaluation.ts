import { alignedReviews } from '../model/alignment'
import { aiSeatId, type Project } from '../model/project'
import { paperVerdicts } from '../consolidate/disagreements'
import { csvCell } from '../model/graph'

export interface FieldEvaluation {
  key: string
  label: string
  compared: number
  equal: number
  differ: number
  aiOnly: number
  missed: number
}

export interface AiEvaluation {
  seat: string | null
  papers: number
  fields: FieldEvaluation[]
}

const rate = (f: FieldEvaluation): number => (f.compared === 0 ? 2 : f.equal / f.compared)

// [impl->req~llm-820~1]
// [impl->req~llm-821~1]
// [impl->req~llm-822~1]
export function evaluateAi(project: Project): AiEvaluation {
  const seat = aiSeatId(project)
  if (seat === null) return { seat, papers: 0, fields: [] }

  const byKey = new Map<string, FieldEvaluation>()
  let papers = 0
  for (const paper of project.papers) {
    if (!paper.aiUsage.some((u) => u.reviewer === seat && u.mode !== 'screening')) continue
    const ai = alignedReviews(project.schema, paper.alignment, { [seat]: paper.reviews[seat] })[seat]
    const verdicts = paperVerdicts(
      project.schema,
      { ...paper, reviews: { '1': ai, '2': paper.annotations }, alignment: {} },
      2,
    )
    let counted = false
    for (const v of verdicts) {
      const byAi = v.answeredBy.includes('1')
      const byTruth = v.answeredBy.includes('2')
      if (!byAi && !byTruth) continue
      const names = [...v.path.map((s) => s.name), v.name]
      const key = names.join('/')
      let f = byKey.get(key)
      if (!f) {
        f = { key, label: names.join(' › '), compared: 0, equal: 0, differ: 0, aiOnly: 0, missed: 0 }
        byKey.set(key, f)
      }
      if (byAi && byTruth) {
        f.compared++
        if (v.agree) f.equal++
        else f.differ++
        counted = true
      } else if (byAi) f.aiOnly++
      else f.missed++
    }
    if (counted) papers++
  }

  const fields = [...byKey.values()].sort((a, b) => rate(a) - rate(b))
  return { seat, papers, fields }
}

// [impl->req~llm-831~1]
export const agreePercent = (f: FieldEvaluation): string => (f.compared === 0 ? '' : String(Math.round((100 * f.equal) / f.compared)))

export function evaluationCsv(fields: FieldEvaluation[]): string {
  const rows = [
    ['field', 'compared', 'equal', 'differ', 'ai_only', 'missed', 'agree_percent'],
    ...fields.map((f) => [f.key, f.compared, f.equal, f.differ, f.aiOnly, f.missed, agreePercent(f)].map(String)),
  ]
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
