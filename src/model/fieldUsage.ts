import type { AnnotationValueTree, InstanceNode } from './annotations'
import { parseMarks, parseReviewMarks, type PdfMark } from './pdfMarks'
import { parsePath } from '../llm/paths'

/**
 * Answers are stored keyed by the schema field's *name*, so renaming a field in
 * the project editor — or removing one — orphans every answer recorded under
 * the old name. Nothing migrates them: `normalizeTree` builds its output by
 * iterating the schema's defs and drops any key the schema no longer has, so
 * the next load quietly prunes them and the next save makes that permanent.
 *
 * This module answers the one question the schema editor needs in order to warn
 * first: how many papers still record an answer under a given field name. It is
 * the counterpart of `screening/reasonUsage.ts`, which guards the exactly
 * analogous rename in the screening reasons editor — the two hazards are the
 * same shape, and this closes the half that had no guard.
 *
 * Matching is by the field's **path** from the root, not by its name anywhere
 * in the tree. Matching on the bare name over-warned in the most common editor
 * action there is — add a field, type a name another field already uses,
 * change your mind, delete it — and a guard that cries wolf on a node holding
 * nothing is a guard users learn to click through, which defeats it exactly
 * when it matters.
 */
export interface AnswerBearingPaper {
  annotations?: unknown
  extra?: Record<string, unknown>
}

function asTree(value: unknown): AnnotationValueTree | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnnotationValueTree)
    : null
}

/** Every annotation tree a paper carries: the consolidated one plus each
 *  reviewer's own (the editor keeps `reviews` verbatim under `extra`). */
function treesOf(paper: AnswerBearingPaper): AnnotationValueTree[] {
  const trees: AnnotationValueTree[] = []
  const consolidated = asTree(paper.annotations)
  if (consolidated) trees.push(consolidated)
  const reviews = asTree(paper.extra?.reviews)
  if (reviews) {
    for (const v of Object.values(reviews)) {
      const t = asTree(v)
      if (t) trees.push(t)
    }
  }
  return trees
}

/**
 * Is this a real recorded answer? Mirrors the rule the rest of the app uses:
 * an unticked checkbox is not evidence of anything (every boolean reads `false`
 * whether or not anyone looked), and a blank or whitespace-only string is not
 * an answer either — so neither should make a rename look destructive when it
 * is not.
 */
function isAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  return false
}

/** Does this instance, or anything nested beneath it, hold a recorded answer? */
function instanceHasAnswer(inst: unknown): boolean {
  if (!inst || typeof inst !== 'object') return false
  const node = inst as InstanceNode
  if (isAnswer(node.value)) return true
  const children = asTree(node.children)
  if (!children) return false
  for (const list of Object.values(children)) {
    if (Array.isArray(list) && list.some(instanceHasAnswer)) return true
  }
  return false
}

/** Does `tree` hold an answer at exactly `path` (names from this level down)? */
function treeUsesPath(tree: AnnotationValueTree, path: string[]): boolean {
  const [head, ...rest] = path
  const list = tree[head]
  if (!Array.isArray(list)) return false
  if (rest.length === 0) return list.some(instanceHasAnswer)
  return list.some((inst) => {
    if (!inst || typeof inst !== 'object') return false
    const children = asTree((inst as InstanceNode).children)
    return children ? treeUsesPath(children, rest) : false
  })
}

/**
 * How many of these papers record an answer at `path` — the field's names from
 * the schema root down to it — across their consolidated tree and every
 * reviewer's own. An empty path, or one with a blank segment, matches nothing:
 * a half-typed field is not one anyone has answered.
 */
export function countPapersUsingField(papers: AnswerBearingPaper[], path: string[]): number {
  if (path.length === 0 || path.some((seg) => seg.trim() === '')) return 0
  return papers.filter((p) => treesOf(p).some((t) => treeUsesPath(t, path))).length
}

/**
 * Every PDF mark (highlight/note) a paper carries, consolidated and every
 * reviewer's own — same shape `treesOf` reads `extra.reviews` with. The
 * editor's `EditorPaper` has no typed `marks`/`reviewMarks` fields, so they
 * arrive here as raw JSON under `extra`, same as `reviews` does; `parseMarks`/
 * `parseReviewMarks` (`pdfMarks.ts`) already parse that defensively.
 */
function marksOf(paper: AnswerBearingPaper): PdfMark[] {
  const consolidated = parseMarks(paper.extra?.marks)
  const perReviewer = Object.values(parseReviewMarks(paper.extra?.reviewMarks)).flat()
  return [...consolidated, ...perReviewer]
}

/** Does a mark's linked-field canonical path (`fieldPath`'s escaped form)
 *  name exactly the segments in `path`? Parsed via `parsePath` rather than
 *  string-prefix-matched, since a name containing `/` or `[` is escaped in
 *  the canonical form. */
function linkMatchesPath(linkPath: string, path: string[]): boolean {
  const segs = parsePath(linkPath)
  return !!segs && segs.length === path.length && segs.every((s, i) => s.name === path[i])
}

/**
 * How many of these papers carry a PDF-mark link ("why I picked this value")
 * pointing at `path`. The counterpart of `countPapersUsingField` for a field
 * link rather than an answer — used by the schema editor to warn before a
 * rename/remove/move orphans one. Unlike an ordinary answer (which the next
 * load silently prunes and the next save makes permanent), an orphaned link
 * leaves the *mark* still showing a label for a field that no longer
 * resolves, with no way for a reviewer to discover or clean it up short of
 * opening every mark's popover — worth warning about for that reason.
 */
export function countLinksUsingField(papers: AnswerBearingPaper[], path: string[]): number {
  if (path.length === 0 || path.some((seg) => seg.trim() === '')) return 0
  return papers.filter((p) => marksOf(p).some((m) => m.linkedFields?.some((l) => linkMatchesPath(l.path, path))))
    .length
}
