import type { ResolvedDef } from '../model/schema'
import { dehydrateSchema } from '../model/project'
import type { FieldTarget } from './fields'
import type { Delivery } from './prompt'
import { SCHEMA_FORMAT_DOC, PATHS_DOC, fieldLines, oneLine } from './prompt'
import type { JudgeVerdict } from './types'

/**
 * The judge: a second, separate LLM call that critiques the agent's proposed
 * values against the paper and the schema, rather than trusting the agent's
 * own confidence. It never calls tools — it only reads what the agent already
 * gathered (the proposal plus, for web-sourced values, the excerpt the agent
 * fetched) and rules on each one.
 */

export interface JudgeProposal {
  path: string
  value: unknown
  evidence: string
  source?: string
  /** For a web-sourced value: the fetched page excerpt the agent quoted from. */
  webExcerpt?: string
}

export interface JudgeReply {
  verdicts: { path: string; verdict: JudgeVerdict['verdict']; feedback: string }[]
  /** Target fields the agent left empty that the judge believes the paper does answer. */
  missed: { path: string; feedback: string }[]
}

const RUBRIC = `## Your task
For each proposed value, decide:
- "accept"  - the value is clearly supported by its quoted evidence and matches the field's
              type, description and options.
- "revise"  - plausible, but the evidence is weak, ambiguous, doesn't actually say this, or the
              value doesn't quite match the field's description/options. Say specifically what
              is wrong and what to check.
- "reject"  - the evidence does not support the value at all, or the quote is not a real quote.

Be skeptical: an evidence quote must actually say what the value claims, not merely be nearby or
about the same topic. A web-sourced value additionally needs its quoted excerpt to actually
support the value, and to come from the URL given as "source".

Also list, in "missed", any of the target fields with NO proposal below that the paper does
plainly answer — these are gaps the agent should have filled but didn't.

Return exactly this JSON object, one entry per proposed field, no commentary:
{
  "verdicts": [ { "path": "Study Type", "verdict": "accept", "feedback": "" } ],
  "missed": [ { "path": "Year", "feedback": "The abstract states the publication year." } ]
}
"feedback" must be specific and actionable; it may be empty only for "accept".`

export function buildJudgeSystemPrompt(
  schema: ResolvedDef[],
  targets: FieldTarget[],
  delivery: Delivery,
): string {
  const schemaJson = JSON.stringify(dehydrateSchema(schema), null, 2)
  const extractionNote =
    delivery === 'text'
      ? '\nThe paper is given to you as extracted text; tables, figures and layout may be garbled.'
      : ''
  return `You are reviewing another AI's proposed annotations for a Systematic Literature Review,
checking each one against the paper before a human reviewer sees it.

${SCHEMA_FORMAT_DOC}

## The schema for this review
\`\`\`json
${schemaJson}
\`\`\`

${PATHS_DOC}

## Target fields for this run
${fieldLines(targets)}
${extractionNote}

${RUBRIC}`
}

/** The user message listing the proposals to judge (the paper itself goes in
 *  as a separate part/attachment, same as the rest of this module's callers). */
export function buildJudgeUserMessage(proposals: JudgeProposal[]): string {
  if (proposals.length === 0) {
    return 'No new or changed proposals this round. Only check "missed": target fields the paper answers that have no proposal at all.'
  }
  const lines = proposals.map((p) => {
    const bits = [
      `- ${oneLine(p.path)}`,
      `  value: ${JSON.stringify(p.value)}`,
      `  source: ${p.source ?? 'paper'}`,
      `  evidence: ${JSON.stringify(oneLine(p.evidence))}`,
    ]
    if (p.webExcerpt) bits.push(`  fetched excerpt: ${JSON.stringify(oneLine(p.webExcerpt).slice(0, 1000))}`)
    return bits.join('\n')
  })
  return `## Proposals to review\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Reply parsing — tolerant JSON extraction, mirroring parse.ts's approach.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const FENCE = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/
const MAX_BRACE_CANDIDATES = 8

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function matchBraces(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

function scanForObject(text: string): Record<string, unknown> | null {
  let tried = 0
  for (let i = 0; i < text.length && tried < MAX_BRACE_CANDIDATES; i++) {
    if (text[i] !== '{') continue
    const span = matchBraces(text, i)
    if (!span) continue
    tried++
    const obj = tryParseObject(span)
    if (obj) return obj
  }
  return null
}

function extractObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null
  const direct = tryParseObject(text)
  if (direct) return direct
  const fenced = FENCE.exec(text)?.[1]?.trim()
  if (fenced) {
    const obj = tryParseObject(fenced) ?? scanForObject(fenced)
    if (obj) return obj
  }
  return scanForObject(text)
}

const VALID_VERDICTS = new Set(['accept', 'revise', 'reject'])

/** Never throws: an unparseable or malformed reply yields empty lists, which
 *  the agent loop treats as "the judge said nothing new" rather than crashing. */
export function parseJudgeReply(raw: string): JudgeReply {
  const empty: JudgeReply = { verdicts: [], missed: [] }
  const root = extractObject(raw)
  if (!root) return empty

  const verdicts = Array.isArray(root.verdicts)
    ? root.verdicts
        .filter(isPlainObject)
        .filter((v) => typeof v.path === 'string' && VALID_VERDICTS.has(String(v.verdict)))
        .map((v) => ({
          path: String(v.path).trim(),
          verdict: v.verdict as JudgeVerdict['verdict'],
          feedback: typeof v.feedback === 'string' ? v.feedback.trim() : '',
        }))
    : []

  const missed = Array.isArray(root.missed)
    ? root.missed
        .filter(isPlainObject)
        .filter((m) => typeof m.path === 'string')
        .map((m) => ({
          path: String(m.path).trim(),
          feedback: typeof m.feedback === 'string' ? m.feedback.trim() : '',
        }))
    : []

  return { verdicts, missed }
}
