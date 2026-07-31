import type { FieldType, ResolvedDef } from './schema'
import { isField } from './schema'
import {
  hasAnnotations,
  isFieldVisible,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from './annotations'
import type { Paper, Project } from './project'
import { YEAR_MIN, YEAR_MAX, isPlausibleYear } from './year'
import { formatPath, type RawSeg } from '../llm/paths'

/**
 * Validation walks the resolved schema against a paper's annotation tree and
 * reports what a reviewer still has to fix. It is deliberately defensive: the
 * project JSON is hand-editable, so anything can be anywhere. A broken tree
 * must surface as an issue, never as a thrown exception.
 */

// 'screening' is never emitted by this module's own walk — it is emitted by
// `src/screening/validate.ts` for the two cross-field rules a plain schema
// walk cannot express. It lives in this union because `ValidationIssue` (and
// everything that renders one, like `ValidationDialog.tsx`) is shared.
export type IssueKind = 'required' | 'type' | 'enum' | 'cardinality' | 'screening'

export interface ValidationIssue {
  paperId: string
  paperTitle: string
  /** Human-readable field path, e.g. "Findings #2 › Evidence › Metric" */
  path: string
  /** Canonical machine path (`llm/paths.ts`'s `formatPath` form, e.g.
   *  "Findings[1]/Evidence/Metric") naming the same field — empty string for
   *  a paper-level issue that names no specific field (a caught structural
   *  error). Lets a consumer (`ValidationDialog`) jump straight to the
   *  field itself, not just the paper it's on. */
  canonicalPath: string
  kind: IssueKind
  message: string
}

/** A paper `validateProject` skipped because it has no annotations at all. */
export interface UnannotatedPaper {
  paperId: string
  paperTitle: string
}

export interface ProjectValidation {
  /** Problems found in papers that have at least one annotation. */
  issues: ValidationIssue[]
  /** Papers with zero annotations, skipped rather than validated — see `validateProject`. */
  unannotated: UnannotatedPaper[]
}

const PATH_SEP = ' › '
/** Long enum lists would drown the message; show a head and count the rest. */
const MAX_LISTED_OPTIONS = 8
const MAX_PREVIEW_CHARS = 40

// ---------------------------------------------------------------------------
// Emptiness
// ---------------------------------------------------------------------------

/**
 * A value is "empty" when the reviewer has not answered.
 *
 * Booleans are NEVER empty: an unchecked box is a legitimate answer (`false`),
 * and a missing/`null` boolean is read as `false` — not as "not answered". So a
 * required boolean can never be reported as missing. This is intentional
 * product behaviour, not an oversight.
 *
 * For numbers, `0` is a real answer; only `null`/`undefined` is empty. For
 * strings, whitespace-only counts as empty because it is invisible in the UI.
 */
export function isEmptyValue(type: FieldType | undefined, value: unknown): boolean {
  if (type === 'boolean') return false
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function preview(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text
}

/** Names what is actually stored, e.g. `a string ("2021")`, `a list`, `NaN`. */
function describeActual(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value} (${preview(value)})`
}

function entries(n: number): string {
  return n === 1 ? 'entry' : 'entries'
}

function listOptions(options: string[]): string {
  const shown = options.slice(0, MAX_LISTED_OPTIONS).join(', ')
  const rest = options.length - MAX_LISTED_OPTIONS
  return rest > 0 ? `${shown}, … (+${rest} more)` : shown
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/**
 * Where an issue is, in the two shapes this module and its consumers each
 * need: `segs` is the canonical (`llm/paths.ts`) form, always index-0-implicit
 * — a stable machine path, for jumping straight to the field. `displayParts`
 * is this module's own, older human-readable convention — deliberately NOT
 * `displayPath`, whose "number only past index 0" rule differs from the one
 * already shipped here: a segment is numbered as soon as its node repeats
 * *anywhere* in the list, so even its first instance reads "Findings #1",
 * not bare "Findings" — changing that would be a silent, untested-for
 * behaviour change to every issue message, not just a plumbing detail.
 */
interface PathAcc {
  segs: RawSeg[]
  displayParts: string[]
}

const ROOT: PathAcc = { segs: [], displayParts: [] }

type Emit = (kind: IssueKind, loc: PathAcc, message: string) => void

/** `null`/`undefined` is "not answered", which is the `required` check's job, not the type check's. */
function typeMismatch(type: FieldType, value: unknown): boolean {
  if (value === null || value === undefined) return false
  switch (type) {
    case 'string':
      return typeof value !== 'string'
    case 'number':
      return typeof value !== 'number' || Number.isNaN(value)
    case 'boolean':
      return typeof value !== 'boolean'
    case 'year':
      return !isPlausibleYear(value)
  }
}

function validateField(def: ResolvedDef, value: unknown, loc: PathAcc, emit: Emit): void {
  const type = def.type as FieldType

  if (typeMismatch(type, value)) {
    const actual =
      typeof value === 'number' && Number.isNaN(value) ? 'NaN' : describeActual(value)
    // A year out of range is still reported as `IssueKind: 'type'` — it is
    // the same category of mistake as a string in a number field, not a
    // reason for a whole new kind — but "should be a year" alone gives no
    // hint of the actual bound, so the expected clause spells it out.
    const expected = type === 'year' ? `a year between ${YEAR_MIN} and ${YEAR_MAX}` : `a ${type}`
    emit('type', loc, `"${def.name}" should be ${expected} but holds ${actual}.`)
    // A mistyped value tells us nothing about requiredness or enum membership.
    return
  }

  const empty = isEmptyValue(type, value)

  if (def.required && empty) {
    emit('required', loc, `"${def.name}" is required but empty.`)
  }

  if (def.options && def.options.length > 0 && !empty && typeof value === 'string') {
    if (!def.options.includes(value)) {
      emit(
        'enum',
        loc,
        `"${def.name}" holds ${preview(value)}, which is not one of: ${listOptions(def.options)}.`,
      )
    }
  }
}

function validateTree(
  defs: ResolvedDef[],
  tree: unknown,
  ancestors: PathAcc,
  emit: Emit,
  // Answers of every field along this call's direct ancestor chain, keyed by
  // name — how a `visibleIf` referencing an ancestor (not just a same-level
  // sibling) gets resolved here, mirroring `AnnotationNode`'s
  // `ancestorValues`. Unrelated to `ancestors` above, which is path
  // segments, not gate values.
  gateAncestors: Record<string, unknown> = {},
): void {
  const map = isPlainObject(tree) ? tree : {}

  for (const def of defs) {
    if (!isFieldVisible(def, map as AnnotationValueTree, gateAncestors as Record<string, FieldValue>))
      continue

    const raw = map[def.name]
    // Points at instance 0 — right for a whole-node issue (cardinality, or
    // "should hold a list") that isn't about any one instance in particular.
    const nodeLoc: PathAcc = {
      segs: [...ancestors.segs, { name: def.name, index: 0 }],
      displayParts: [...ancestors.displayParts, def.name],
    }

    if (raw !== undefined && !Array.isArray(raw)) {
      emit(
        'type',
        nodeLoc,
        `"${def.name}" should hold a list of entries but holds ${describeActual(raw)}.`,
      )
      continue
    }

    // A missing key is simply zero instances, which the cardinality check catches.
    const instances: unknown[] = Array.isArray(raw) ? raw : []

    if (instances.length < def.min) {
      emit(
        'cardinality',
        nodeLoc,
        `"${def.name}" needs at least ${def.min} ${entries(def.min)} but has ${instances.length}.`,
      )
    }
    if (def.max !== null && instances.length > def.max) {
      emit(
        'cardinality',
        nodeLoc,
        `"${def.name}" allows at most ${def.max} ${entries(def.max)} but has ${instances.length}.`,
      )
    }

    instances.forEach((rawInstance, index) => {
      // Only number the display segment when the node actually repeats, so
      // simple non-repeating fields read as "Relevant", not "Relevant #1" —
      // the canonical segment always carries the real index regardless.
      const segment = instances.length > 1 ? `${def.name} #${index + 1}` : def.name
      const loc: PathAcc = {
        segs: [...ancestors.segs, { name: def.name, index }],
        displayParts: [...ancestors.displayParts, segment],
      }

      if (!isPlainObject(rawInstance)) {
        emit(
          'type',
          loc,
          `"${def.name}" entry should be an object but is ${describeActual(rawInstance)}.`,
        )
        return
      }

      const instance = rawInstance as InstanceNode
      if (isField(def)) validateField(def, instance.value, loc, emit)
      // A node may carry both a value and a sub-tree.
      if (def.children.length > 0) {
        const nextGateAncestors = isField(def)
          ? { ...gateAncestors, [def.name]: instance.value }
          : gateAncestors
        validateTree(def.children, instance.children, loc, emit, nextGateAncestors)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Problems with one paper's annotations. Empty when it is valid. */
export function validatePaper(schema: ResolvedDef[], paper: Paper): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const emit: Emit = (kind, loc, message) => {
    issues.push({
      paperId: paper?.id ?? '',
      paperTitle: paper?.title ?? '',
      path: loc.displayParts.join(PATH_SEP),
      canonicalPath: formatPath(loc.segs),
      kind,
      message,
    })
  }

  const tree: AnnotationValueTree | undefined = paper?.annotations
  validateTree(Array.isArray(schema) ? schema : [], tree, ROOT, emit)
  return issues
}

/**
 * Problems across every *annotated* paper, in paper order, plus the papers
 * skipped for having no annotations at all.
 *
 * A paper nobody has touched yet fails every required field for the same
 * reason it fails all of them — it hasn't been started — so validating it
 * produces a wall of "missing" issues that says nothing a reviewer doesn't
 * already know from the paper list's own "not annotated yet" dot. Skipping it
 * here keeps the results about papers someone is partway through, and
 * `unannotated` still says which papers those are, so "not started" is never
 * silently indistinguishable from "actually valid".
 */
export function validateProject(project: Project): ProjectValidation {
  const papers = Array.isArray(project?.papers) ? project.papers : []
  const schema = Array.isArray(project?.schema) ? project.schema : []

  const issues: ValidationIssue[] = []
  const unannotated: UnannotatedPaper[] = []
  for (const paper of papers) {
    try {
      const tree = isPlainObject(paper?.annotations) ? (paper.annotations as AnnotationValueTree) : {}
      if (!hasAnnotations(schema, tree)) {
        unannotated.push({ paperId: paper?.id ?? '', paperTitle: paper?.title ?? '' })
        continue
      }
      issues.push(...validatePaper(schema, paper))
    } catch (err) {
      // The walker is written to be total, but a validation run must never take
      // the app down over a surprise in a hand-edited file.
      issues.push({
        paperId: paper?.id ?? '',
        paperTitle: paper?.title ?? '',
        path: '',
        canonicalPath: '',
        kind: 'type',
        message: `Could not validate this paper's annotations: ${String(err)}`,
      })
    }
  }
  return { issues, unannotated }
}
