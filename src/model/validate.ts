import type { FieldType, ResolvedDef } from './schema'
import { isField } from './schema'
import { hasAnnotations, type AnnotationValueTree, type InstanceNode } from './annotations'
import type { Paper, Project } from './project'

/**
 * Validation walks the resolved schema against a paper's annotation tree and
 * reports what a reviewer still has to fix. It is deliberately defensive: the
 * project JSON is hand-editable, so anything can be anywhere. A broken tree
 * must surface as an issue, never as a thrown exception.
 */

export type IssueKind = 'required' | 'type' | 'enum' | 'cardinality'

export interface ValidationIssue {
  paperId: string
  paperTitle: string
  /** Human-readable field path, e.g. "Findings #2 › Evidence › Metric" */
  path: string
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

type Emit = (kind: IssueKind, path: string, message: string) => void

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
  }
}

function validateField(def: ResolvedDef, value: unknown, path: string, emit: Emit): void {
  const type = def.type as FieldType

  if (typeMismatch(type, value)) {
    const actual =
      typeof value === 'number' && Number.isNaN(value) ? 'NaN' : describeActual(value)
    emit('type', path, `"${def.name}" should be a ${type} but holds ${actual}.`)
    // A mistyped value tells us nothing about requiredness or enum membership.
    return
  }

  const empty = isEmptyValue(type, value)

  if (def.required && empty) {
    emit('required', path, `"${def.name}" is required but empty.`)
  }

  if (def.options && def.options.length > 0 && !empty && typeof value === 'string') {
    if (!def.options.includes(value)) {
      emit(
        'enum',
        path,
        `"${def.name}" holds ${preview(value)}, which is not one of: ${listOptions(def.options)}.`,
      )
    }
  }
}

function validateTree(
  defs: ResolvedDef[],
  tree: unknown,
  ancestors: string[],
  emit: Emit,
): void {
  const map = isPlainObject(tree) ? tree : {}

  for (const def of defs) {
    const raw = map[def.name]
    const nodePath = [...ancestors, def.name].join(PATH_SEP)

    if (raw !== undefined && !Array.isArray(raw)) {
      emit(
        'type',
        nodePath,
        `"${def.name}" should hold a list of entries but holds ${describeActual(raw)}.`,
      )
      continue
    }

    // A missing key is simply zero instances, which the cardinality check catches.
    const instances: unknown[] = Array.isArray(raw) ? raw : []

    if (instances.length < def.min) {
      emit(
        'cardinality',
        nodePath,
        `"${def.name}" needs at least ${def.min} ${entries(def.min)} but has ${instances.length}.`,
      )
    }
    if (def.max !== null && instances.length > def.max) {
      emit(
        'cardinality',
        nodePath,
        `"${def.name}" allows at most ${def.max} ${entries(def.max)} but has ${instances.length}.`,
      )
    }

    instances.forEach((rawInstance, index) => {
      // Only number an instance when there is more than one, so simple
      // non-repeating fields read as "Relevant", not "Relevant #1".
      const segment = instances.length > 1 ? `${def.name} #${index + 1}` : def.name
      const path = [...ancestors, segment]
      const joined = path.join(PATH_SEP)

      if (!isPlainObject(rawInstance)) {
        emit(
          'type',
          joined,
          `"${def.name}" entry should be an object but is ${describeActual(rawInstance)}.`,
        )
        return
      }

      const instance = rawInstance as InstanceNode
      if (isField(def)) validateField(def, instance.value, joined, emit)
      // A node may carry both a value and a sub-tree.
      if (def.children.length > 0) validateTree(def.children, instance.children, path, emit)
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Problems with one paper's annotations. Empty when it is valid. */
export function validatePaper(schema: ResolvedDef[], paper: Paper): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const emit: Emit = (kind, path, message) => {
    issues.push({
      paperId: paper?.id ?? '',
      paperTitle: paper?.title ?? '',
      path,
      kind,
      message,
    })
  }

  const tree: AnnotationValueTree | undefined = paper?.annotations
  validateTree(Array.isArray(schema) ? schema : [], tree, [], emit)
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
        kind: 'type',
        message: `Could not validate this paper's annotations: ${String(err)}`,
      })
    }
  }
  return { issues, unannotated }
}
