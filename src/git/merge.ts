import { produce } from 'immer'
import { isField, type FieldType, type ResolvedDef } from '../model/schema'
import {
  emptyValue,
  pruneTree,
  type AnnotationValueTree,
  type FieldValue,
  type InstanceNode,
} from '../model/annotations'
import {
  deepEqualJson,
  type AiUsageRecord,
  type Paper,
  type Project,
  type ProjectProvenance,
  type ProjectProtocol,
} from '../model/project'
import type { ScreeningConfig } from '../model/schema'
import { formatPath, displayPath, resolvePath, type RawSeg } from '../llm/paths'
import { parseYear } from '../model/year'

/**
 * The field-level three-way merge at the heart of git support. This module
 * knows nothing about git and nothing about the DOM — it takes a parsed
 * `Project` at the merge base (or `null`, when the file was added on both
 * branches independently) plus the two divergent copies, and returns either a
 * merged project (with any real conflicts listed for the resolution dialog)
 * or a refusal naming what could not be reconciled this way. `src/consolidate/`
 * is the pattern this follows: small, pure, hammered by unit tests.
 *
 * The one rule, applied at every granularity from a project's title down to a
 * single annotation field: **a side that did not change a value away from the
 * base does not get a vote on it.** See `merge3`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which tree inside the project a conflicted value lives in. */
export type MergeTree =
  | { kind: 'project' } // the project's own top-level fields
  | { kind: 'paper' } // one paper's metadata (title, pdf, doi, authors, year, venue, abstract, abstractFromPdf)
  | { kind: 'annotations' } // the single / consolidated tree
  | { kind: 'review'; reviewer: string } // one numbered reviewer's own tree

export interface FieldConflict {
  /** Stable identity — the resolution map's key and the row's React key. */
  id: string
  /** '' for a `{kind:'project'}` conflict, which belongs to no paper. */
  paperId: string
  paperTitle: string
  tree: MergeTree
  /** "Findings[1]/Claim" for an annotation field; the bare key ("title",
   *  "authors") for a paper/project-level one. */
  canonical: string
  /** What the row shows: "Findings #2 › Claim", "Title", "Authors". */
  label: string
  /** How the middle control renders. Everything outside an annotation tree
   *  (title, pdf, doi, authors) is rendered as a plain string. */
  type: FieldType
  options?: string[]
  /** The value at the merge base. */
  base: FieldValue
  /** The local value. Also what `merged` holds until the conflict is resolved. */
  ours: FieldValue
  theirs: FieldValue
}

export type MergeNoteKind =
  | 'paper-added-local'
  | 'paper-added-remote'
  | 'paper-removed-local'
  | 'paper-removed-remote'
  | 'paper-kept'
  | 'schema-remote'
  | 'reviewers-remote'
  | 'screening-remote'

export interface MergeNote {
  kind: MergeNoteKind
  message: string
}

export type MergeOutcome =
  | { kind: 'merged'; merged: Project; conflicts: FieldConflict[]; notes: MergeNote[] }
  | { kind: 'refused'; reason: string; details: string[] }

/** conflict id -> the reviewer's chosen final value. */
export type Resolutions = Record<string, FieldValue>

// ---------------------------------------------------------------------------
// merge3: the one rule
// ---------------------------------------------------------------------------

/**
 * The whole merge, in four lines, applied at every granularity: a side that
 * did not change a value away from the base does not get a vote on it. That
 * is precisely the guarantee this feature exists for — the fields you changed
 * cannot be overwritten by a remote that did not touch them, and vice versa —
 * and it is not a special case bolted on afterwards; it is the rule.
 *
 * Returns `null` only when both sides changed the value, to different things.
 * That is the one case no algorithm can settle and a person has to look at.
 */
export function merge3<T>(
  base: T,
  ours: T,
  theirs: T,
  eq: (a: T, b: T) => boolean,
): { value: T } | null {
  if (eq(ours, theirs)) return { value: ours }
  if (eq(base, ours)) return { value: theirs }
  if (eq(base, theirs)) return { value: ours }
  return null
}

// ---------------------------------------------------------------------------
// Identity, labels
// ---------------------------------------------------------------------------

function treeKey(t: MergeTree): string {
  return t.kind === 'review' ? `reviews/${t.reviewer}` : t.kind
}

/**
 * One conflict's identity. `JSON.stringify` of the three parts rather than a
 * joined string: a paper id and a field path can both contain anything, and an
 * ambiguous key here would silently apply one field's resolution to another.
 */
export function conflictId(paperId: string, tree: MergeTree, canonical: string): string {
  return JSON.stringify([paperId, treeKey(tree), canonical])
}

/** What a row says about where the field lives. Blank for a single-reviewer
 *  project's one tree — there is nothing to disambiguate. */
export function treeLabel(tree: MergeTree, reviewers: number): string {
  switch (tree.kind) {
    case 'project':
      return 'Project'
    case 'paper':
      return 'Paper details'
    case 'annotations':
      return reviewers > 1 ? 'Consolidation' : ''
    case 'review':
      return `Reviewer ${tree.reviewer}`
  }
}

// ---------------------------------------------------------------------------
// Annotation-tree merge
// ---------------------------------------------------------------------------

/**
 * One field's value at one revision, with an absent slot read as `emptyValue`.
 *
 * This is not a convenience — it is required for correctness. `pruneTree`
 * drops the *trailing* empty instances on save, so an instance that
 * exists-but-is-empty and one that is simply not there are the same thing on
 * disk and must merge the same way. Read them differently and two things
 * break at once: a field one side filled in from nothing would conflict
 * against an "absent" base instead of an unopposed change, and an entry the
 * remote deleted would come back.
 */
function valueAt(def: ResolvedDef, inst: InstanceNode | undefined): FieldValue {
  return inst && 'value' in inst ? (inst.value ?? emptyValue(def.type)) : emptyValue(def.type)
}

function arrOf(tree: AnnotationValueTree | undefined, name: string): InstanceNode[] {
  const raw = tree?.[name]
  return Array.isArray(raw) ? raw : []
}

/**
 * Builds a `mergeTree` closure bound to one paper/tree's conflict sink, so the
 * recursion doesn't have to keep re-threading `paperId`/`paperTitle` through
 * every level.
 */
function makeTreeMerger(paperId: string, paperTitle: string, conflicts: FieldConflict[]) {
  /**
   * Walks the merged schema. `count` is a union of all three sides' instance
   * counts (clamped to `def.max`), and the arrays are never compacted —
   * position carries meaning (consolidation lines up each reviewer's entries
   * by index; see `src/consolidate/apply.ts`), so closing a gap here would
   * silently re-point that alignment. A field only one side changed away from
   * the base takes that side automatically (`merge3`'s job); a field both
   * changed, differently, becomes a conflict row and `merged` holds *our*
   * value until it is resolved — the safe side if resolution is ever skipped.
   */
  function mergeTree(
    defs: ResolvedDef[],
    treeId: MergeTree,
    base: AnnotationValueTree | undefined,
    ours: AnnotationValueTree | undefined,
    theirs: AnnotationValueTree | undefined,
    prefix: RawSeg[],
  ): AnnotationValueTree {
    const out: AnnotationValueTree = {}
    for (const def of defs) {
      const bArr = arrOf(base, def.name)
      const oArr = arrOf(ours, def.name)
      const tArr = arrOf(theirs, def.name)
      let count = Math.max(bArr.length, oArr.length, tArr.length, Math.max(def.min, 1))
      if (def.max !== null) count = Math.min(count, def.max)

      const instances: InstanceNode[] = []
      for (let i = 0; i < count; i++) {
        const segs: RawSeg[] = [...prefix, { name: def.name, index: i }]
        const inst: InstanceNode = {}

        if (isField(def)) {
          const bv = valueAt(def, bArr[i])
          const ov = valueAt(def, oArr[i])
          const tv = valueAt(def, tArr[i])
          const m = merge3<FieldValue>(bv, ov, tv, (a, b) => a === b)
          if (m) {
            inst.value = m.value
          } else {
            inst.value = ov
            conflicts.push({
              id: conflictId(paperId, treeId, formatPath(segs)),
              paperId,
              paperTitle,
              tree: treeId,
              canonical: formatPath(segs),
              label: displayPath(segs),
              // isField(def) guarantees def.type is set.
              type: def.type!,
              options: def.options,
              base: bv,
              ours: ov,
              theirs: tv,
            })
          }
        }

        if (def.children.length > 0) {
          inst.children = mergeTree(
            def.children,
            treeId,
            bArr[i]?.children,
            oArr[i]?.children,
            tArr[i]?.children,
            segs,
          )
        }

        instances.push(inst)
      }
      out[def.name] = instances
    }
    return out
  }
  return mergeTree
}

// ---------------------------------------------------------------------------
// Paper merge
// ---------------------------------------------------------------------------

/** Matches `editorStore.ts`'s existing authors round-trip exactly (its
 *  `join(', ')` / `split(',').map(trim).filter(Boolean)`), so a resolved
 *  conflict reads back through the same rule the project editor already uses
 *  rather than a second one invented here. */
function joinAuthors(authors: string[] | undefined): string {
  return (authors ?? []).join(', ')
}
function splitAuthors(text: string): string[] {
  return text
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

function sOrNull(v: string | undefined): FieldValue {
  return v === undefined ? null : v
}

function mergeAiUsage(ours: AiUsageRecord[], theirs: AiUsageRecord[]): AiUsageRecord[] {
  const key = (r: AiUsageRecord) => `${r.provider}\0${r.model}\0${r.appliedAt}`
  const byKey = new Map<string, AiUsageRecord>()
  for (const r of [...ours, ...theirs]) byKey.set(key(r), r)
  return [...byKey.values()].sort((a, b) => {
    if (a.appliedAt !== b.appliedAt) return a.appliedAt < b.appliedAt ? -1 : 1
    const ka = key(a)
    const kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

/**
 * `Paper.equal` is a set spelled as an array. A boolean has only two values,
 * so "both sides changed it, differently" is impossible — `merge3`'s first
 * branch (`eq(ours, theirs)`) always takes it. A field marked equal here can
 * never conflict.
 */
function mergeEqual(base: string[] | undefined, ours: string[], theirs: string[]): string[] {
  const bSet = new Set(base ?? [])
  const oSet = new Set(ours)
  const tSet = new Set(theirs)
  const all = new Set([...(base ?? []), ...ours, ...theirs])
  const out: string[] = []
  for (const p of all) {
    const m = merge3<boolean>(bSet.has(p), oSet.has(p), tSet.has(p), (a, b) => a === b)
    if (m?.value) out.push(p)
  }
  return out
}

function mergePaper(
  schema: ResolvedDef[],
  base: Paper | undefined,
  ours: Paper,
  theirs: Paper,
  conflicts: FieldConflict[],
  refusals: string[],
): Paper {
  const eqStr = (a: string, b: string) => a === b
  const eqStrU = (a: string | undefined, b: string | undefined) => a === b

  const pushPaperConflict = (
    canonical: string,
    label: string,
    base: FieldValue,
    oursV: FieldValue,
    theirsV: FieldValue,
  ) => {
    conflicts.push({
      id: conflictId(ours.id, { kind: 'paper' }, canonical),
      paperId: ours.id,
      paperTitle: ours.title,
      tree: { kind: 'paper' },
      canonical,
      label,
      type: 'string',
      base,
      ours: oursV,
      theirs: theirsV,
    })
  }

  const titleM = merge3<string>(base?.title ?? '', ours.title, theirs.title, eqStr)
  const title = titleM ? titleM.value : ours.title
  if (!titleM) pushPaperConflict('title', 'Title', base?.title ?? '', ours.title, theirs.title)

  const pdfM = merge3<string>(base?.pdf ?? '', ours.pdf, theirs.pdf, eqStr)
  const pdf = pdfM ? pdfM.value : ours.pdf
  if (!pdfM) pushPaperConflict('pdf', 'PDF path', base?.pdf ?? '', ours.pdf, theirs.pdf)

  const doiM = merge3<string | undefined>(base?.doi, ours.doi, theirs.doi, eqStrU)
  const doi = doiM ? doiM.value : ours.doi
  if (!doiM) pushPaperConflict('doi', 'DOI', sOrNull(base?.doi), sOrNull(ours.doi), sOrNull(theirs.doi))

  const authorsM = merge3<string[] | undefined>(base?.authors, ours.authors, theirs.authors, deepEqualJson)
  const authors = authorsM ? (authorsM.value ?? []) : ours.authors
  if (!authorsM) {
    pushPaperConflict(
      'authors',
      'Authors',
      joinAuthors(base?.authors),
      joinAuthors(ours.authors),
      joinAuthors(theirs.authors),
    )
  }

  // `year`/`venue` get the identical treatment `abstract`/`abstractFromPdf`
  // already do: a merge3 call, a conflict on genuine disagreement, and (below)
  // a slot in `canonicalPaper` and a case in `applyOne`. Omitting either from
  // any one of those three spots is exactly the abstract-dropping regression
  // this file was fixed for once already — see `canonicalPaper`'s doc comment.
  const eqNumU = (a: number | undefined, b: number | undefined) => a === b
  const nOrNull = (v: number | undefined): FieldValue => (v === undefined ? null : v)
  const yearM = merge3<number | undefined>(base?.year, ours.year, theirs.year, eqNumU)
  const year = yearM ? yearM.value : ours.year
  if (!yearM) {
    conflicts.push({
      id: conflictId(ours.id, { kind: 'paper' }, 'year'),
      paperId: ours.id,
      paperTitle: ours.title,
      tree: { kind: 'paper' },
      canonical: 'year',
      label: 'Year',
      // The honest type — and it is what forces the merge dialog's
      // `MiddleControl` to render a bounded numeric control here rather than
      // free text, exactly as it must for a `type: 'year'` annotation field.
      type: 'year',
      base: nOrNull(base?.year),
      ours: nOrNull(ours.year),
      theirs: nOrNull(theirs.year),
    })
  }

  const venueM = merge3<string | undefined>(base?.venue, ours.venue, theirs.venue, eqStrU)
  const venue = venueM ? venueM.value : ours.venue
  if (!venueM) {
    pushPaperConflict('venue', 'Venue', sOrNull(base?.venue), sOrNull(ours.venue), sOrNull(theirs.venue))
  }

  const abstractM = merge3<string | undefined>(base?.abstract, ours.abstract, theirs.abstract, eqStrU)
  const abstract = abstractM ? abstractM.value : ours.abstract
  if (!abstractM) {
    pushPaperConflict('abstract', 'Abstract', sOrNull(base?.abstract), sOrNull(ours.abstract), sOrNull(theirs.abstract))
  }

  // Independent of `abstract` itself — a real (if rare) gap this leaves: the
  // reviewer could pick one side's abstract text and the other side's
  // abstractFromPdf flag, producing a text/flag combination neither side
  // actually had. `applyOne`'s screening review is a per-field UI with no
  // concept of "these two rows must be resolved together"; bundling the two
  // into one decision (the way `changes.ts` does for the *commit* flow) would
  // need the same treatment here, and is left for that to potentially extend
  // to rather than duplicating now. What matters more is not losing the
  // abstract at all, which mergePaper did before this field existed here.
  const eqBoolU = (a: boolean | undefined, b: boolean | undefined) => a === b
  const abstractFromPdfM = merge3<boolean | undefined>(
    base?.abstractFromPdf,
    ours.abstractFromPdf,
    theirs.abstractFromPdf,
    eqBoolU,
  )
  const abstractFromPdf = abstractFromPdfM ? abstractFromPdfM.value : ours.abstractFromPdf
  if (!abstractFromPdfM) {
    conflicts.push({
      id: conflictId(ours.id, { kind: 'paper' }, 'abstractFromPdf'),
      paperId: ours.id,
      paperTitle: ours.title,
      tree: { kind: 'paper' },
      canonical: 'abstractFromPdf',
      label: 'Abstract extracted from PDF',
      type: 'boolean',
      base: base?.abstractFromPdf ?? false,
      ours: ours.abstractFromPdf ?? false,
      theirs: theirs.abstractFromPdf ?? false,
    })
  }

  const extraKeys = new Set([
    ...Object.keys(base?.extra ?? {}),
    ...Object.keys(ours.extra),
    ...Object.keys(theirs.extra),
  ])
  const extra: Record<string, unknown> = {}
  for (const k of extraKeys) {
    const m = merge3<unknown>(base?.extra[k], ours.extra[k], theirs.extra[k], deepEqualJson)
    if (!m) {
      refusals.push(`papers[${ours.id}].${k}`)
      continue
    }
    if (m.value !== undefined) extra[k] = m.value
  }

  const mergeTree = makeTreeMerger(ours.id, title, conflicts)
  const annotations = mergeTree(
    schema,
    { kind: 'annotations' },
    base?.annotations,
    ours.annotations,
    theirs.annotations,
    [],
  )

  // A reviewer's tree is never deleted by a merge — only by both sides having
  // already dropped it. Lowering `config.reviewers` on one side hides a
  // reviewer's tree; it must not be what deletes it (the same rule
  // `normalizeReviews` already applies on load).
  const reviewKeys = new Set([
    ...Object.keys(base?.reviews ?? {}),
    ...Object.keys(ours.reviews),
    ...Object.keys(theirs.reviews),
  ])
  const reviews: Record<string, AnnotationValueTree> = {}
  for (const k of reviewKeys) {
    const bT = base?.reviews[k]
    const oT = ours.reviews[k]
    const tT = theirs.reviews[k]
    if (!oT && !tT) continue
    if (!oT) {
      reviews[k] = tT!
      continue
    }
    if (!tT) {
      reviews[k] = oT
      continue
    }
    reviews[k] = mergeTree(schema, { kind: 'review', reviewer: k }, bT, oT, tT, [])
  }

  return {
    id: ours.id,
    title,
    authors,
    doi,
    year,
    venue,
    abstract,
    abstractFromPdf,
    pdf,
    annotations,
    reviews,
    aiUsage: mergeAiUsage(ours.aiUsage, theirs.aiUsage),
    equal: mergeEqual(base?.equal, ours.equal, theirs.equal),
    extra,
  }
}

/**
 * Whether a paper is unchanged for merge purposes: structurally identical once
 * both are read through the merged schema. Compared in the shape
 * `serializeProject` would write, so a difference that only exists in memory —
 * a padded instance, a key order — is not mistaken for an edit.
 */
function canonicalPaper(schema: ResolvedDef[], p: Paper) {
  return {
    id: p.id,
    title: p.title,
    authors: p.authors,
    doi: p.doi,
    year: p.year,
    venue: p.venue,
    abstract: p.abstract,
    abstractFromPdf: p.abstractFromPdf,
    pdf: p.pdf,
    annotations: pruneTree(schema, p.annotations),
    reviews: Object.fromEntries(Object.entries(p.reviews).map(([k, v]) => [k, pruneTree(schema, v)])),
    aiUsage: p.aiUsage,
    // A set; JSON just has no way to say so.
    equal: [...p.equal].sort(),
    extra: p.extra,
  }
}

function paperUnchanged(schema: ResolvedDef[], a: Paper, b: Paper): boolean {
  return deepEqualJson(canonicalPaper(schema, a), canonicalPaper(schema, b))
}

/**
 * Papers by id: ours' own order, then the papers only theirs has, appended in
 * theirs' order. Deterministic, and it puts the person doing the pull's own
 * file back the way they left it.
 *
 * **The removal asymmetry**: a paper one side deleted and the other side
 * *changed* is kept, with a note, never deleted. A field-level UI cannot ask
 * "keep or delete this paper", and the two outcomes are not symmetric — a
 * kept paper nobody wanted is one click from gone; annotated work a merge
 * deleted is gone. Only when both sides agree (the paper is untouched on the
 * side that kept it) does the deletion actually happen.
 */
function mergePapers(
  schema: ResolvedDef[],
  base: Project | null,
  ours: Project,
  theirs: Project,
  conflicts: FieldConflict[],
  notes: MergeNote[],
  refusals: string[],
): Paper[] {
  const baseById = new Map((base?.papers ?? []).map((p) => [p.id, p]))
  const oursById = new Map(ours.papers.map((p) => [p.id, p]))
  const theirsById = new Map(theirs.papers.map((p) => [p.id, p]))

  const order = [
    ...ours.papers.map((p) => p.id),
    ...theirs.papers.filter((p) => !oursById.has(p.id)).map((p) => p.id),
  ]

  const out: Paper[] = []
  for (const id of order) {
    const b = baseById.get(id)
    const o = oursById.get(id)
    const t = theirsById.get(id)

    if (o && !t) {
      if (!b) {
        out.push(o)
        notes.push({ kind: 'paper-added-local', message: `"${o.title}" was added locally.` })
      } else if (paperUnchanged(schema, b, o)) {
        notes.push({
          kind: 'paper-removed-remote',
          message: `"${o.title}" was removed on the remote and is not in the merged project.`,
        })
      } else {
        out.push(o)
        notes.push({
          kind: 'paper-kept',
          message: `"${o.title}" was removed on the remote, but you have annotated it, so it was kept.`,
        })
      }
      continue
    }

    if (t && !o) {
      if (!b) {
        out.push(t)
        notes.push({ kind: 'paper-added-remote', message: `"${t.title}" was added on the remote.` })
      } else if (paperUnchanged(schema, b, t)) {
        notes.push({
          kind: 'paper-removed-local',
          message: `"${t.title}" was removed locally and is not in the merged project.`,
        })
      } else {
        out.push(t)
        notes.push({
          kind: 'paper-kept',
          message: `"${t.title}" was removed locally, but the remote has annotated it, so it was kept.`,
        })
      }
      continue
    }

    if (o && t) out.push(mergePaper(schema, b, o, t, conflicts, refusals))
  }
  return out
}

// ---------------------------------------------------------------------------
// Project merge
// ---------------------------------------------------------------------------

function refused(refusals: string[]): MergeOutcome {
  return {
    kind: 'refused',
    reason: 'These two versions of the project cannot be merged field by field.',
    details: refusals.map(refusalDetail),
  }
}

function refusalDetail(key: string): string {
  switch (key) {
    case 'version':
      return 'The file format version was changed on both sides.'
    case 'config.schema':
      return (
        'The annotation schema was changed on both sides. The schema decides the shape of every ' +
        'annotation tree, so there is no field-level answer here — reconcile the schema first ' +
        '(pull into a copy, or agree on one side), then merge the annotations.'
      )
    case 'config.ai':
      return 'Whether AI-assisted annotation is enabled was changed on both sides.'
    case 'config.reviewers':
      return 'The number of reviewers was changed on both sides.'
    case 'config.screening':
      return (
        'The screening configuration was changed on both sides — whether this project screens at ' +
        'all, or its exclusion reasons, decides the shape of every annotation tree the same way ' +
        'the schema does. Reconcile it first, then merge.'
      )
    case 'provenance':
      return 'Where this project was imported from was recorded differently on both sides.'
    case 'protocol':
      return 'The review protocol (research questions, search, criteria) was edited on both sides.'
    default:
      return `"${key}" was changed on both sides and is not an annotation field, so it cannot be merged automatically.`
  }
}

/** True when `side` differs from `base` — used only to decide whether a note
 *  is worth showing ("the remote changed X"), never to decide a value. */
function changedFromBase(base: unknown, side: unknown): boolean {
  return !deepEqualJson(base, side)
}

/**
 * The whole merge. `base === null` means the project file did not exist at the
 * merge base — added on both branches independently — and collapses cleanly:
 * no base papers, and every base field value reads as absent/empty.
 */
export function mergeProjects(base: Project | null, ours: Project, theirs: Project): MergeOutcome {
  const eqNum = (a: number | undefined, b: number | undefined) => a === b
  const eqBool = (a: boolean | undefined, b: boolean | undefined) => a === b
  const rootRefusals: string[] = []

  // Re-shaping decisions: a difference here changes the shape of every tree
  // in the file, so there is no field-level answer — refuse and name it,
  // rather than guess. See `refusalDetail` for why each one specifically.
  const versionM = merge3<number | undefined>(base?.version, ours.version, theirs.version, eqNum)
  if (!versionM) rootRefusals.push('version')

  const schemaM = merge3<ResolvedDef[] | undefined>(base?.schema, ours.schema, theirs.schema, deepEqualJson)
  if (!schemaM) rootRefusals.push('config.schema')

  const aiM = merge3<boolean | undefined>(base?.aiEnabled, ours.aiEnabled, theirs.aiEnabled, eqBool)
  if (!aiM) rootRefusals.push('config.ai')

  const reviewersM = merge3<number | undefined>(base?.reviewers, ours.reviewers, theirs.reviewers, eqNum)
  if (!reviewersM) rootRefusals.push('config.reviewers')

  // Reshaping for the same reason `schema` is: whether a project screens at
  // all, and its reason list, decides `config.schema` via `screeningSchemaDefs`
  // — see data-model.md's "Screening" section. A field-level answer here would
  // be answering a question ("what schema does this file even have") that a
  // single conflict row cannot express.
  const screeningM = merge3<ScreeningConfig | null | undefined>(
    base?.screening,
    ours.screening,
    theirs.screening,
    deepEqualJson,
  )
  if (!screeningM) rootRefusals.push('config.screening')

  // Not a reshaping field like the others above — it decides nothing about
  // the shape of any tree — but it is a nested record, not a string/number/
  // boolean, so `FieldConflict.type` cannot express a conflict row for it
  // (see the doc comment on `title` below for the field that *can*). Refusal
  // is the only honest option when both sides actually disagree; the common
  // case (only one side ever sets it) resolves cleanly through `merge3` with
  // no refusal and no note — see the `screening-remote`-style notes below for
  // why this deliberately doesn't add one: nothing here reshapes anything.
  const provenanceM = merge3<ProjectProvenance | null | undefined>(
    base?.provenance,
    ours.provenance,
    theirs.provenance,
    deepEqualJson,
  )
  if (!provenanceM) rootRefusals.push('provenance')

  // Same shape and same reasoning as `provenance` just above: a nested record
  // `FieldConflict` cannot express, so two-sided disagreement refuses (a
  // reviewer's authored protocol must never be silently half-dropped), while
  // the ordinary case — one side edits it, or nobody does — merges cleanly.
  const protocolM = merge3<ProjectProtocol | null | undefined>(
    base?.protocol,
    ours.protocol,
    theirs.protocol,
    deepEqualJson,
  )
  if (!protocolM) rootRefusals.push('protocol')

  const rootExtraKeys = new Set([
    ...Object.keys(base?.extra ?? {}),
    ...Object.keys(ours.extra),
    ...Object.keys(theirs.extra),
  ])
  const mergedRootExtra: Record<string, unknown> = {}
  for (const k of rootExtraKeys) {
    const m = merge3<unknown>(base?.extra[k], ours.extra[k], theirs.extra[k], deepEqualJson)
    if (!m) {
      rootRefusals.push(k)
      continue
    }
    if (m.value !== undefined) mergedRootExtra[k] = m.value
  }

  if (rootRefusals.length > 0) return refused(rootRefusals)

  // Every tree below is walked against the winning schema, so a field the
  // winning side removed is simply never visited — exactly as `normalizeTree`
  // would drop it on the next ordinary load.
  const mergedSchema = schemaM!.value!

  const notes: MergeNote[] = []
  if (!changedFromBase(base?.schema, ours.schema) && changedFromBase(base?.schema, theirs.schema)) {
    notes.push({
      kind: 'schema-remote',
      message: "The remote changed the annotation schema; that schema was used.",
    })
  }
  if (!changedFromBase(base?.reviewers, ours.reviewers) && changedFromBase(base?.reviewers, theirs.reviewers)) {
    notes.push({
      kind: 'reviewers-remote',
      message: 'The remote changed the number of reviewers; that value was used.',
    })
  }
  if (!changedFromBase(base?.screening, ours.screening) && changedFromBase(base?.screening, theirs.screening)) {
    notes.push({
      kind: 'screening-remote',
      message: 'The remote changed the screening configuration; that value was used.',
    })
  }

  const conflicts: FieldConflict[] = []

  // Project.title is deliberately not in the refusal list above: it is one
  // string, a conflict row expresses it perfectly, and refusing an entire
  // merge because two people renamed the review would be absurd.
  const titleM = merge3<string | undefined>(base?.title, ours.title, theirs.title, (a, b) => a === b)
  const title = titleM ? titleM.value : ours.title
  if (!titleM) {
    conflicts.push({
      id: conflictId('', { kind: 'project' }, 'title'),
      paperId: '',
      paperTitle: '',
      tree: { kind: 'project' },
      canonical: 'title',
      label: 'Project title',
      type: 'string',
      base: sOrNull(base?.title),
      ours: sOrNull(ours.title),
      theirs: sOrNull(theirs.title),
    })
  }

  const paperRefusals: string[] = []
  const papers = mergePapers(mergedSchema, base, ours, theirs, conflicts, notes, paperRefusals)
  if (paperRefusals.length > 0) return refused(paperRefusals)

  return {
    kind: 'merged',
    merged: {
      version: versionM!.value!,
      title,
      schema: mergedSchema,
      aiEnabled: aiM!.value!,
      reviewers: reviewersM!.value!,
      screening: screeningM!.value ?? null,
      provenance: provenanceM!.value ?? null,
      protocol: protocolM!.value ?? null,
      papers,
      extra: mergedRootExtra,
    },
    conflicts,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Applying resolutions
// ---------------------------------------------------------------------------

function valueToString(v: FieldValue): string {
  return v === null || v === undefined ? '' : String(v)
}

/**
 * Defensive, non-throwing walk to the container tree addressed by `path` —
 * the counterpart to `containerAt` in `src/state/store.ts`, reimplemented
 * here (rather than imported) because this module must not pull in a runtime
 * symbol from the store, and because a conflict id resolved against a schema
 * that has since changed must be skipped, never throw.
 */
function containerAt(
  root: AnnotationValueTree,
  path: { name: string; index: number }[],
): AnnotationValueTree | null {
  let tree: AnnotationValueTree | undefined = root
  for (const seg of path) {
    const inst: InstanceNode | undefined = tree?.[seg.name]?.[seg.index]
    if (!inst?.children) return null
    tree = inst.children
  }
  return tree ?? null
}

function applyOne(draft: Project, conflict: FieldConflict, value: FieldValue): void {
  if (conflict.tree.kind === 'project') {
    if (conflict.canonical === 'title') {
      const s = valueToString(value).trim()
      draft.title = s || undefined
    }
    return
  }

  const paper = draft.papers.find((p) => p.id === conflict.paperId)
  if (!paper) return

  if (conflict.tree.kind === 'paper') {
    switch (conflict.canonical) {
      case 'title':
        paper.title = valueToString(value)
        break
      case 'pdf':
        paper.pdf = valueToString(value)
        break
      case 'doi': {
        const s = valueToString(value).trim()
        paper.doi = s || undefined
        break
      }
      case 'authors':
        paper.authors = splitAuthors(valueToString(value))
        break
      case 'year':
        // `parseYear` also covers a stale/hand-built resolution that hands
        // back a string (`'2021'`) instead of the number the conflict itself
        // carries — the model layer must never write anything but a number
        // here, the same way `writePaperMeta` in changes.ts cannot either.
        paper.year = parseYear(value)
        break
      case 'venue': {
        const s = valueToString(value).trim()
        paper.venue = s || undefined
        break
      }
      case 'abstract': {
        const s = valueToString(value).trim()
        paper.abstract = s || undefined
        break
      }
      case 'abstractFromPdf':
        paper.abstractFromPdf = value === true ? true : undefined
        break
    }
    return
  }

  const root = conflict.tree.kind === 'review' ? paper.reviews[conflict.tree.reviewer] : paper.annotations
  if (!root) return
  const resolved = resolvePath(draft.schema, conflict.canonical)
  if (!resolved) return // the schema no longer has this field — nothing safe to write
  const container = containerAt(root, resolved.path)
  if (!container) return
  const inst = container[resolved.name]?.[resolved.index]
  if (!inst) return
  inst.value = value
}

/**
 * Write the reviewer's choices into the merged project. An id with no
 * resolution keeps what `mergeProjects` left there (our value); a resolution
 * for an id that is not in `conflicts` is ignored — it belongs to a merge
 * that is no longer the one being finalized.
 *
 * Built with immer's `produce` (already a direct dependency, and it handles a
 * frozen input the way a Zustand store hands one over) rather than
 * `structuredClone` (not something to bet on under every test runtime) or
 * `JSON.parse(JSON.stringify(...))` (which drops `undefined`-valued keys that
 * `deepEqualJson` and the round-trip both care about).
 */
export function applyResolutions(
  merged: Project,
  conflicts: FieldConflict[],
  resolutions: Resolutions,
): Project {
  const byId = new Map(conflicts.map((c) => [c.id, c]))
  return produce(merged, (draft) => {
    for (const [id, value] of Object.entries(resolutions)) {
      const conflict = byId.get(id)
      if (conflict) applyOne(draft as Project, conflict, value)
    }
  })
}
