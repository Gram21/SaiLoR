import type { FieldValue } from '../model/annotations'
import type { SchemaRemark } from './types'

/**
 * Aggregated record of what happened to the AI's proposals, so a schema author
 * can see which fields are unclear. Deliberately holds no paper text and no
 * evidence quotes: only field paths, truncated values, counts and remarks.
 */

const MAX_VALUE_CHARS = 200
const MAX_EDITS = 10

export interface FeedbackRow {
  paperId: string
  path: string
  outcome: 'applied' | 'unticked' | 'edited' | 'left-empty' | 'rejected'
  aiValue?: FieldValue
  finalValue?: FieldValue
  judge?: 'accept' | 'revise' | 'reject'
  crossCheck?: 'agree' | 'disagree'
  confidence?: number | null
}

export interface RunFeedbackInput {
  createdAt: string
  mode: 'prompt' | 'agent' | 'classify' | 'recheck'
  annotator: { provider: string; model: string }
  judge?: { provider: string; model: string }
  seat: string | null
  schemaVersion: string | null
  papers: string[]
  rows: FeedbackRow[]
  remarks: (SchemaRemark & { paperId: string })[]
}

export interface FieldFeedback {
  path: string
  asked: number
  applied: number
  unticked: number
  edited: number
  leftEmpty: number
  rejected: number
  judge: { accept: number; revise: number; reject: number }
  crossCheckDisagreements: number
  edits: { ai: string; final: string }[]
  remarks: { issue: string; suggestion?: string; count: number }[]
}

export interface RunFeedback {
  version: 1
  createdAt: string
  mode: RunFeedbackInput['mode']
  annotator: RunFeedbackInput['annotator']
  judge?: RunFeedbackInput['judge']
  seat: string | null
  schemaVersion: string | null
  papers: number
  fields: FieldFeedback[]
}

const show = (v: FieldValue | undefined): string => String(v ?? '').slice(0, MAX_VALUE_CHARS)

const trouble = (f: FieldFeedback): number =>
  f.asked === 0 ? 0 : (f.leftEmpty + f.rejected + f.edited + f.unticked) / f.asked

export function buildRunFeedback(input: RunFeedbackInput): RunFeedback {
  const byPath = new Map<string, FieldFeedback>()
  const get = (path: string): FieldFeedback => {
    let f = byPath.get(path)
    if (!f) {
      f = {
        path, asked: 0, applied: 0, unticked: 0, edited: 0, leftEmpty: 0, rejected: 0,
        judge: { accept: 0, revise: 0, reject: 0 }, crossCheckDisagreements: 0, edits: [], remarks: [],
      }
      byPath.set(path, f)
    }
    return f
  }

  for (const r of input.rows) {
    const f = get(r.path)
    f.asked++
    if (r.outcome === 'left-empty') f.leftEmpty++
    else f[r.outcome]++
    if (r.judge) f.judge[r.judge]++
    if (r.crossCheck === 'disagree') f.crossCheckDisagreements++
    if (r.outcome === 'edited' && f.edits.length < MAX_EDITS) {
      f.edits.push({ ai: show(r.aiValue), final: show(r.finalValue) })
    }
  }

  // Remarks may name a path nobody was asked about; they still get a row.
  for (const m of input.remarks) {
    const f = get(m.path)
    const hit = f.remarks.find((x) => x.issue === m.issue)
    if (hit) hit.count++
    else f.remarks.push({ issue: m.issue, ...(m.suggestion ? { suggestion: m.suggestion } : {}), count: 1 })
  }

  // Stable sort keeps first-seen order among ties.
  const fields = [...byPath.values()].sort((a, b) => trouble(b) - trouble(a))
  return {
    version: 1,
    createdAt: input.createdAt,
    mode: input.mode,
    annotator: input.annotator,
    ...(input.judge ? { judge: input.judge } : {}),
    seat: input.seat,
    schemaVersion: input.schemaVersion,
    papers: input.papers.length,
    fields,
  }
}

/** 'run-2026-09-30T12-00-00Z-<uniq>.json'; colons out, uniq reduced to [a-z0-9]{1,8}. */
export function feedbackFileName(createdAt: string, uniq: string): string {
  const stamp = createdAt.replace(/\.\d+/, '').replace(/[^0-9TZ-]/g, '-')
  const u = uniq.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || '0'
  return `run-${stamp}-${u}.json`
}

/** False when every row was a clean apply and nobody left a remark. */
export function hasFeedbackWorthSaving(fb: RunFeedback): boolean {
  return fb.fields.some((f) => f.applied !== f.asked || f.remarks.length > 0 || f.crossCheckDisagreements > 0)
}
