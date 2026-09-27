import type { ResolvedDef } from '../model/schema'
import { isField } from '../model/schema'
import type { AnnotationValueTree, FieldValue } from '../model/annotations'
import { isRecordedAnswer } from '../model/annotations'
import { formatPath, type RawSeg } from './paths'
import { oneLine } from './prompt'

/**
 * Few-shot examples: a reviewer's already-finished papers, shown to the model
 * as worked examples of the team's conventions (granularity, wording, enum
 * choices) — not as evidence, and never to be copied into the current paper.
 *
 * Which papers count as "finished" is the caller's (the store's) call; this
 * module only turns a chosen list into a prompt section and picks among them.
 */

export interface FewShotExample {
  title: string
  abstract?: string
  tree: AnnotationValueTree
}

const DEFAULT_MAX_CHARS = 6000
const ABSTRACT_CHARS = 800

function formatValue(value: FieldValue): string {
  return typeof value === 'string' ? oneLine(value) : JSON.stringify(value)
}

/** Every recorded answer in `tree`, as "path: value" lines — same path syntax
 *  the prompt teaches (paths.ts's `formatPath`), same walk shape as
 *  `fields.ts`'s `unansweredFields`, just answered instead of unanswered. */
function answeredLines(defs: ResolvedDef[], tree: AnnotationValueTree | undefined, prefix: RawSeg[]): string[] {
  const out: string[] = []
  for (const def of defs) {
    const raw = tree?.[def.name]
    const instances = Array.isArray(raw) ? raw : []
    instances.forEach((inst, index) => {
      const segs = [...prefix, { name: def.name, index }]
      if (isField(def) && isRecordedAnswer(inst?.value)) {
        out.push(`- ${formatPath(segs)}: ${formatValue(inst.value as FieldValue)}`)
      }
      if (def.children.length > 0) out.push(...answeredLines(def.children, inst?.children, segs))
    })
  }
  return out
}

/** How many fields `tree` has answered — used to order few-shot candidates
 *  "most complete first" (see the store's `fewShotCandidates`). */
export function countAnsweredFields(schema: ResolvedDef[], tree: AnnotationValueTree | undefined): number {
  return answeredLines(schema, tree, []).length
}

/** One example's lines: title, optional abstract, then its answered fields.
 *  Kept as an array (not a joined string) so truncation can drop trailing
 *  lines without ever cutting one in half. */
function exampleLines(schema: ResolvedDef[], example: FewShotExample): string[] {
  const lines = [`### ${oneLine(example.title)}`]
  if (example.abstract) lines.push(`Abstract: ${oneLine(example.abstract).slice(0, ABSTRACT_CHARS)}`)
  lines.push(...answeredLines(schema, example.tree, []))
  return lines
}

const HEADER = `## Worked examples from this review
These are the reviewer's own finished annotations for other papers in this review. They
illustrate the team's conventions - granularity, wording, enum choices - nothing more. They are
NOT evidence and must NOT be copied into the current paper: every value you record must still
come from the current paper's own text.`

function assemble(blocks: string[][]): string {
  const body = blocks.map((lines) => lines.join('\n')).join('\n\n')
  return body ? `${HEADER}\n\n${body}` : HEADER
}

/**
 * Builds the "## Worked examples from this review" prompt section. Truncates
 * to `maxChars` (default ~6000) by dropping whole trailing lines — a field
 * line, then an abstract, then a title — never mid-line, starting from the
 * last example.
 */
export function buildFewShotBlock(
  schema: ResolvedDef[],
  examples: FewShotExample[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const blocks = examples.map((ex) => exampleLines(schema, ex))

  while (blocks.length > 0 && assemble(blocks).length > maxChars) {
    const last = blocks[blocks.length - 1]
    last.pop()
    if (last.length === 0) blocks.pop()
  }
  return blocks.length > 0 ? assemble(blocks) : ''
}

/**
 * Picks up to `k` example candidates, excluding the paper currently being
 * annotated. Deterministic: takes candidates in the order given (the caller
 * is expected to have already ordered them, e.g. most-completely-annotated
 * first — deciding "finished" is the store's job, not this module's).
 */
export function pickFewShotExamples<P>(
  candidates: P[],
  k: number,
  currentPaperId: string,
  getId: (p: P) => string,
): P[] {
  return candidates.filter((p) => getId(p) !== currentPaperId).slice(0, k)
}
