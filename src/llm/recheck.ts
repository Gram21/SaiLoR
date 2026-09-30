import type { ResolvedDef } from '../model/schema'
import { dehydrateSchema } from '../model/project'
import type { AnnotationValueTree, FieldValue } from '../model/annotations'
import { fieldTargets, isUnanswered, type FieldTarget } from './fields'
import { PATHS_DOC, SCHEMA_FORMAT_DOC, SCHEMA_REMARKS_RULE, fieldLines, oneLine, type Delivery } from './prompt'
import { coerce, extractObject, parseSchemaRemarks } from './parse'
import { resolvePath, MAX_UNBOUNDED_INDEX } from './paths'
import type { RejectedSuggestion, SchemaRemark } from './types'

/**
 * Re-check mode: instead of filling empty fields, the AI double-checks values a
 * reviewer already entered. It only ever *flags*; a `disagree` is a proposal the
 * reviewer must approve. Conservative by construction: anything not clearly
 * contradicted by a quote is downgraded to `unsure`.
 */

const MAX_REASON_CHARS = 300
const MAX_EVIDENCE_CHARS = 500

export type RecheckTarget = FieldTarget & { current: FieldValue }

export interface RecheckOutcome {
  path: string
  current: FieldValue
  verdict: 'agree' | 'disagree' | 'unsure'
  proposed?: FieldValue
  reason: string
  evidence: string
  confidence: number | null
}

/** Complement of `unansweredFields`: every field that already holds a value. */
export function answeredFields(schema: ResolvedDef[], tree: AnnotationValueTree | undefined): RecheckTarget[] {
  return fieldTargets(schema, tree, (def, value) => !isUnanswered(def, value)).map((t) => ({
    ...t,
    current: t.value as FieldValue,
  }))
}

export function buildRecheckSystemPrompt(
  schema: ResolvedDef[],
  targets: RecheckTarget[],
  delivery: Delivery,
  examples?: string,
): string {
  const schemaJson = JSON.stringify(dehydrateSchema(schema), null, 2)
  const list = targets
    .map((t) => `${fieldLines([t])}\n    current value: ${oneLine(JSON.stringify(t.current))}`)
    .join('\n')
  const textNote =
    delivery === 'text'
      ? '\n4. The paper is given to you as text extracted automatically from a PDF; tables, figures and\n   formulas may be garbled or missing. If the relevant content is illegible, answer "unsure".'
      : ''

  return `You are assisting a researcher conducting a Systematic Literature Review. A reviewer has
already entered a value for each field listed below while reading one scientific paper. Your task
is to check each of those values against the paper.

${SCHEMA_FORMAT_DOC}

## The schema for this review
\`\`\`json
${schemaJson}
\`\`\`

${PATHS_DOC}

## Fields to check
${list}
${examples ? `\n${examples}\n` : ''}
## Verdicts
For every listed field give exactly one verdict:
- "agree": the paper supports the current value. Differences in wording or granularity that mean
  the same thing are agree.
- "disagree": the paper clearly says something different. You MUST include a "proposed" value
  (valid for the field's type and options) and a verbatim supporting quote in "evidence" (at
  most 200 characters).
- "unsure": the paper does not settle it, or you cannot tell. This is the safe default.

## Rules
1. Judge only by what the paper itself states. Never disagree from outside knowledge.
2. No verbatim quote, no disagree.
3. Be conservative: a false alarm wastes a human's time, and a wrong "fix" corrupts data.${textNote}
${delivery === 'text' ? 5 : 4}. ${SCHEMA_REMARKS_RULE}
${delivery === 'text' ? 6 : 5}. Output only the JSON object described below. No commentary, no markdown code fences.

## Output format
Return exactly this JSON object:

{
  "checks": [
    { "path": "Study Type", "verdict": "agree", "reason": "Paper reports a controlled experiment.", "confidence": 0.9 },
    {
      "path": "Year",
      "verdict": "disagree",
      "proposed": 2019,
      "evidence": "Published at ICSE 2019.",
      "reason": "The paper states 2019, not 2021.",
      "confidence": 0.8
    }
  ]
}

"confidence" is between 0.0 and 1.0. Optionally add "schema_remarks": [] (see the schema remarks rule).`
}

/**
 * Never throws. A `disagree` with no quote, no coercible `proposed`, or a
 * `proposed` equal to the current value is downgraded to `unsure` (reason
 * notes why) rather than rejected, so the reviewer still sees the model looked.
 * `rejected` holds only entries that cannot be attributed: unasked path,
 * duplicate, bad verdict, malformed.
 */
export function parseRecheckReply(
  schema: ResolvedDef[],
  targets: RecheckTarget[],
  raw: string,
): { outcomes: RecheckOutcome[]; rejected: RejectedSuggestion[]; schemaRemarks: SchemaRemark[] } {
  const outcomes: RecheckOutcome[] = []
  const rejected: RejectedSuggestion[] = []
  const root = extractObject(raw)
  if (!root) return { outcomes, rejected, schemaRemarks: [] }

  const asked = new Map(targets.map((t) => [t.path, t]))
  const seen = new Set<string>()
  const entries: unknown[] = Array.isArray(root.checks) ? root.checks : []

  for (const e of entries) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      rejected.push({ path: '', raw: e, reason: 'malformed entry' })
      continue
    }
    const entry = e as Record<string, unknown>
    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : ''
    const resolved = rawPath ? resolvePath(schema, rawPath, { maxUnboundedIndex: MAX_UNBOUNDED_INDEX }) : null
    const target = resolved ? asked.get(resolved.canonical) : undefined
    if (!resolved || !target) {
      rejected.push({ path: rawPath, raw: entry, reason: 'field was not asked' })
      continue
    }
    const path = resolved.canonical
    if (seen.has(path)) {
      rejected.push({ path, raw: entry, reason: 'duplicate' })
      continue
    }
    const v = entry.verdict
    if (v !== 'agree' && v !== 'disagree' && v !== 'unsure') {
      rejected.push({ path, raw: entry, reason: 'unknown verdict' })
      continue
    }
    seen.add(path)

    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim().slice(0, MAX_EVIDENCE_CHARS) : ''
    const conf = typeof entry.confidence === 'number' ? entry.confidence : NaN
    const reason = typeof entry.reason === 'string' ? oneLine(entry.reason).slice(0, MAX_REASON_CHARS) : ''
    const out: RecheckOutcome = {
      path,
      current: target.current,
      verdict: v,
      reason,
      evidence,
      confidence: conf >= 0 && conf <= 1 ? conf : null,
    }

    if (v === 'disagree') {
      const c = 'proposed' in entry ? coerce(target.def, entry.proposed) : null
      const problem = !evidence
        ? 'no supporting quote'
        : !c?.ok
          ? 'no valid proposed value'
          : c.value === target.current
            ? 'proposed value equals the current one'
            : ''
      if (problem === '' && c?.ok) out.proposed = c.value
      else {
        out.verdict = 'unsure'
        out.reason = oneLine(`Downgraded from disagree (${problem}). ${reason}`).slice(0, MAX_REASON_CHARS)
      }
    }
    outcomes.push(out)
  }

  return { outcomes, rejected, schemaRemarks: parseSchemaRemarks(schema, root.schema_remarks) }
}
