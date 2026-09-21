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
import { mergeMarksList, type PdfMark } from '../model/pdfMarks'
import type { StoredAlignment } from '../model/alignment'

/**
 * Field-level three-way merge for git support. Takes a parsed `Project` at the
 * merge base (`null` if added independently on both branches) plus the two
 * divergent copies, and returns a merged project with conflicts for the
 * resolution dialog, or a refusal naming what couldn't be reconciled.
 *
 * The one rule, at every granularity down to a single field: a side that did
 * not change a value away from the base does not get a vote on it. See `merge3`.
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
  | 'repeatable-additions-kept'

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
 * The whole merge rule in four lines: fields you changed can't be overwritten
 * by a remote that didn't touch them, and vice versa. Returns `null` only
 * when both sides changed the value to different things — the one case a
 * person has to resolve.
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
 * joined string, since a paper id or field path could contain the separator
 * and collide.
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
 * Required for correctness: `pruneTree` drops trailing empty instances on
 * save, so "exists but empty" and "not there" are the same state on disk and
 * must merge the same way, or an unopposed fill-in wrongly conflicts and a
 * remote deletion comes back.
 */
function valueAt(def: ResolvedDef, inst: InstanceNode | undefined): FieldValue {
  return inst && 'value' in inst ? (inst.value ?? emptyValue(def.type)) : emptyValue(def.type)
}

function arrOf(tree: AnnotationValueTree | undefined, name: string): InstanceNode[] {
  const raw = tree?.[name]
  return Array.isArray(raw) ? raw : []
}

/**
 * A JSON-comparable snapshot of one repeatable instance's whole subtree, used
 * only to ask "did this instance change", never written to `merged`. Needed
 * because positional matching (`bArr[i]` vs `oArr[i]`) must look past the top
 * field to see whether anything nested differs.
 */
function snapshotInstance(def: ResolvedDef, inst: InstanceNode | undefined): unknown {
  return {
    value: isField(def) ? valueAt(def, inst) : undefined,
    children: def.children.length > 0 ? snapshotTree(def.children, inst?.children) : undefined,
  }
}

function snapshotTree(defs: ResolvedDef[], tree: AnnotationValueTree | undefined): unknown {
  const out: Record<string, unknown> = {}
  for (const d of defs) out[d.name] = arrOf(tree, d.name).map((inst) => snapshotInstance(d, inst))
  return out
}

/**
 * Bug 2: a deletion on one side shifts every later index, so positional
 * matching can strand an edit the other side made on what's now a phantom
 * slot. Not resolvable by guessing which surviving entry the edit "really"
 * belongs to, so it's detected instead: one side's count dropped below
 * base's while the other side changed an instance at or beyond that drop.
 */
function shrunkAndEdited(
  def: ResolvedDef,
  bArr: InstanceNode[],
  oArr: InstanceNode[],
  tArr: InstanceNode[],
): boolean {
  const bLen = bArr.length
  let shrunkLen: number
  let otherArr: InstanceNode[]
  if (oArr.length < bLen && tArr.length >= bLen) {
    shrunkLen = oArr.length
    otherArr = tArr
  } else if (tArr.length < bLen && oArr.length >= bLen) {
    shrunkLen = tArr.length
    otherArr = oArr
  } else {
    return false
  }
  for (let i = shrunkLen; i < bLen; i++) {
    if (!deepEqualJson(snapshotInstance(def, bArr[i]), snapshotInstance(def, otherArr[i]))) return true
  }
  return false
}

/** Builds a `mergeTree` closure bound to one paper/tree's conflict sink, so the
 *  recursion doesn't re-thread `paperId`/`paperTitle` through every level. */
function makeTreeMerger(
  paperId: string,
  paperTitle: string,
  conflicts: FieldConflict[],
  notes: MergeNote[],
  refusals: string[],
) {
  /**
   * Walks the merged schema. Instance count is the union of all three sides
   * (clamped to `def.max`); arrays are never compacted because position
   * carries meaning (consolidation lines up reviewer entries by index — see
   * `src/consolidate/apply.ts`), so closing a gap would re-point that
   * alignment. A field both sides changed differently becomes a conflict row,
   * and `merged` holds *our* value until resolved — the safe side if
   * resolution is skipped.
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
      // Bugs 1 and 2 only apply to *repeatable* nodes, where "base doesn't
      // have one there" is a meaningful absence. A `max: 1` field's array is
      // always length 1 once resolved, so an empty `bArr` there just means
      // the paper didn't exist at base — fall through to ordinary merge3.
      const repeatable = def.max === null || def.max > 1

      // Bug 2: refuse rather than strand an edit on a phantom slot.
      if (repeatable && shrunkAndEdited(def, bArr, oArr, tArr)) {
        refusals.push(
          `verbatim:${def.name} on "${paperTitle}" was shortened on one side and edited on the other; ` +
            `SaiLoR can't tell which entry your edit belongs to. Reconcile that paper by hand.`,
        )
        out[def.name] = oArr
        continue
      }

      // Bug 1: when both sides grew this node past base's length, the surplus
      // instances are additions, not competing values for the same slot —
      // overlaying them index-by-index would silently drop one side's
      // addition or recombine fields from two different new entries into one
      // nobody wrote. Only the new tail is appended raw; indices base already
      // had still go through the ordinary per-field merge below.
      const bothGrew = repeatable && oArr.length > bArr.length && tArr.length > bArr.length
      const mergeCount = bothGrew
        ? bArr.length
        : Math.max(bArr.length, oArr.length, tArr.length, Math.max(def.min, 1))

      const instances: InstanceNode[] = []
      for (let i = 0; i < mergeCount; i++) {
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

      if (bothGrew) {
        instances.push(...oArr.slice(bArr.length), ...tArr.slice(bArr.length))
        notes.push({
          kind: 'repeatable-additions-kept',
          message: `Both sides added new "${def.name}" entries for "${paperTitle}"; they were all kept and may need de-duplicating.`,
        })
      }

      out[def.name] = def.max !== null ? instances.slice(0, def.max) : instances
    }
    return out
  }
  return mergeTree
}

// ---------------------------------------------------------------------------
// Paper merge
// ---------------------------------------------------------------------------

/** Matches `editorStore.ts`'s existing authors round-trip exactly, so a
 *  resolved conflict reads back through the same rule the editor uses. */
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
 * `Paper.equal` is a set spelled as an array. A boolean has only two values, so
 * `merge3` always takes its `eq(ours, theirs)` branch — a field marked equal
 * here can never conflict.
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
  notes: MergeNote[],
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

  // `year`/`venue` need the same three spots `abstract`/`abstractFromPdf` do
  // (merge3 call, `canonicalPaper` slot, `applyOne` case) — omitting one is
  // the abstract-dropping regression this file was fixed for once already.
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
      // Forces the merge dialog's MiddleControl to render a bounded numeric
      // control here rather than free text.
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

  // Merged independently of `abstract`: a known gap is the reviewer picking
  // one side's abstract text with the other side's abstractFromPdf flag,
  // since the per-field conflict UI can't bundle two rows into one decision
  // (`changes.ts` does that for the commit flow). Not losing the abstract at
  // all matters more, which is what this field fixes.
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

  const mergeTree = makeTreeMerger(ours.id, title, conflicts, notes, refusals)
  const annotations = mergeTree(
    schema,
    { kind: 'annotations' },
    base?.annotations,
    ours.annotations,
    theirs.annotations,
    [],
  )

  // A reviewer's tree is only deleted when both sides dropped it. Lowering
  // `config.reviewers` on one side just hides it (same rule `normalizeReviews`
  // applies on load), it must not delete it.
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
    alignment: mergeAlignment(base?.alignment, ours.alignment, theirs.alignment),
    // Not merged: it records what *this* checkout's Consolidation seat last
    // ran against. Keeping ours means a merge that brought in reviewer edits
    // reads as stale and prompts, which is the right outcome; taking theirs
    // could mark work this side never saw as already consolidated.
    consolidationSync: ours.consolidationSync,
    marks: mergeMarksList(ours.marks, theirs.marks),
    reviewMarks: mergeReviewMarks(ours.reviewMarks, theirs.reviewMarks),
    // Plain 3-way merge, falling back to `true` on genuine divergence (same
    // keep-over-drop asymmetry as `mergePapers`). Not a `FieldConflict`: this
    // isn't in a tree or addressable by a canonical path.
    finished:
      merge3<boolean>(base?.finished ?? false, ours.finished, theirs.finished, (a, b) => a === b)
        ?.value ?? true,
    reviewsFinished: mergeReviewsFinished(base?.reviewsFinished, ours.reviewsFinished, theirs.reviewsFinished),
    extra,
  }
}

/**
 * Merge the recorded entry matching, one node at a time — merging the whole
 * map as one value would make two consolidators who touched different nodes
 * look like they'd disagreed.
 *
 * A node matched differently on both sides silently keeps *ours*, no
 * `FieldConflict`: this is a derived claim, not something a reviewer said, the
 * losing side is recoverable by reopening Consolidation, and there's no
 * canonical path to raise a conflict on it by.
 *
 * Any resulting mismatch (mapping no longer describing what the merged array
 * holds) is the same staleness `alignedReviews` already tolerates: unmapped
 * entries are appended, not dropped.
 */
function mergeAlignment(
  base: StoredAlignment | undefined,
  ours: StoredAlignment,
  theirs: StoredAlignment,
): StoredAlignment {
  const out: StoredAlignment = {}
  for (const name of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const merged = merge3(base?.[name], ours[name], theirs[name], deepEqualJson)
    const value = merged ? merged.value : ours[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** `mergeEqual`'s set-union shape, per reviewer key: same
 *  keep-the-declaration tiebreak as `finished` above, applied to each seat. */
function mergeReviewsFinished(
  base: Record<string, boolean> | undefined,
  ours: Record<string, boolean>,
  theirs: Record<string, boolean>,
): Record<string, boolean> {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(ours), ...Object.keys(theirs)])
  const out: Record<string, boolean> = {}
  for (const k of keys) {
    const m = merge3<boolean>(base?.[k] === true, ours[k] === true, theirs[k] === true, (a, b) => a === b)
    if (m?.value ?? true) out[k] = true
  }
  return out
}

/** Same union-by-reviewer-key shape as the `reviews` loop above, then a
 *  per-reviewer `mergeMarksList`. */
function mergeReviewMarks(
  ours: Record<string, PdfMark[]>,
  theirs: Record<string, PdfMark[]>,
): Record<string, PdfMark[]> {
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)])
  const out: Record<string, PdfMark[]> = {}
  for (const k of keys) {
    const merged = mergeMarksList(ours[k] ?? [], theirs[k] ?? [])
    if (merged.length > 0) out[k] = merged
  }
  return out
}

/**
 * Whether a paper is unchanged for merge purposes, compared in the shape
 * `serializeProject` would write so an in-memory-only difference (a padded
 * instance, key order) isn't mistaken for an edit.
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
    alignment: p.alignment,
    // Sorted by id: this is an equality check, not the merge itself, and mark
    // order carries no meaning worth a false "changed".
    marks: [...p.marks].sort((a, b) => a.id.localeCompare(b.id)),
    reviewMarks: Object.fromEntries(
      Object.entries(p.reviewMarks).map(([k, v]) => [k, [...v].sort((a, b) => a.id.localeCompare(b.id))]),
    ),
    finished: p.finished,
    // Only the `true` keys, matching `serializeProject`: an explicit `false`
    // and an absent key are the same state (see `parseReviewsFinished`).
    reviewsFinished: Object.fromEntries(
      Object.keys(p.reviewsFinished)
        .filter((k) => p.reviewsFinished[k])
        .sort()
        .map((k) => [k, true]),
    ),
    extra: p.extra,
  }
}

function paperUnchanged(schema: ResolvedDef[], a: Paper, b: Paper): boolean {
  return deepEqualJson(canonicalPaper(schema, a), canonicalPaper(schema, b))
}

/**
 * Papers by id: ours' own order, then the papers only theirs has, in theirs' order.
 *
 * Removal asymmetry: a paper deleted on one side but changed on the other is
 * kept, with a note, never deleted — a kept paper nobody wanted is one click
 * from gone, but annotated work a merge deleted is gone for good. Deletion
 * only goes through when both sides agree (untouched on the side that kept it).
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

    if (o && t) out.push(mergePaper(schema, b, o, t, conflicts, notes, refusals))
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
  // A few refusals (a stranded repeatable-node edit, a schema removal
  // discarding answers) name specifics the generic message below would
  // garble, so they push their finished sentence here instead of a key.
  if (key.startsWith('verbatim:')) return key.slice('verbatim:'.length)
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
 * Schema nodes in `baseDefs` but missing from `mergedDefs`, at any depth,
 * paired with the ancestor path needed to find that node's data in an actual
 * paper tree (see `countAtPath`).
 */
function collectRemovedDefs(
  baseDefs: ResolvedDef[],
  mergedDefs: ResolvedDef[],
  path: string[] = [],
): { path: string[]; def: ResolvedDef }[] {
  const mergedByName = new Map(mergedDefs.map((d) => [d.name, d]))
  const out: { path: string[]; def: ResolvedDef }[] = []
  for (const def of baseDefs) {
    const merged = mergedByName.get(def.name)
    if (!merged) {
      out.push({ path, def })
    } else if (def.children.length > 0) {
      out.push(...collectRemovedDefs(def.children, merged.children, [...path, def.name]))
    }
  }
  return out
}

/** Sum of non-empty answers under `def`'s subtree in `tree` — what a removal
 *  here would discard. "Non-empty" uses the same absent-vs-empty rule as
 *  `valueAt`: an untouched boolean or unset string is not an answer. */
function countAnswers(defs: ResolvedDef[], tree: AnnotationValueTree | undefined): number {
  let n = 0
  for (const def of defs) {
    for (const inst of arrOf(tree, def.name)) {
      if (isField(def) && valueAt(def, inst) !== emptyValue(def.type)) n++
      if (def.children.length > 0) n += countAnswers(def.children, inst.children)
    }
  }
  return n
}

/** Descends `tree` through `path` (every instance at every level, since a
 *  removed node under a repeatable ancestor can have answers in more than one
 *  row) and sums `countAnswers` for `def` at the bottom. The side that
 *  dropped this node has no array there, so it contributes 0 — no double-count. */
function countAtPath(path: string[], def: ResolvedDef, tree: AnnotationValueTree | undefined): number {
  if (path.length === 0) return countAnswers([def], tree)
  const [head, ...rest] = path
  let n = 0
  for (const inst of arrOf(tree, head)) n += countAtPath(rest, def, inst.children)
  return n
}

/**
 * Bug 3: every tree is walked against only the winning schema, so a field the
 * losing side removed is never visited, silently extending that schema vote
 * to answers nobody agreed to discard. Refuses (naming the field and answer
 * count) only when there's something real to lose.
 */
function schemaRemovalRefusal(
  base: Project | null,
  mergedSchema: ResolvedDef[],
  ours: Project,
  theirs: Project,
): string | null {
  if (!base) return null // nothing existed at the base to have answers removed from.
  const removed = collectRemovedDefs(base.schema, mergedSchema)
  if (removed.length === 0) return null

  const trees = [
    ...ours.papers.map((p) => p.annotations),
    ...theirs.papers.map((p) => p.annotations),
    ...ours.papers.flatMap((p) => Object.values(p.reviews)),
    ...theirs.papers.flatMap((p) => Object.values(p.reviews)),
  ]

  let total = 0
  const names: string[] = []
  for (const { path, def } of removed) {
    const count = trees.reduce((sum, t) => sum + countAtPath(path, def, t), 0)
    if (count > 0) {
      total += count
      names.push(def.name)
    }
  }
  if (total === 0) return null

  return (
    `verbatim:The schema change removes ${names.map((n) => `"${n}"`).join(', ')}, which ` +
    `${total === 1 ? 'holds 1 answer' : `holds ${total} answers`} across your reviewers. ` +
    `Export or push what you have before retrying, then reconcile the schema so it doesn't drop them.`
  )
}

/**
 * The whole merge. `base === null` means the project file didn't exist at the
 * merge base (added on both branches independently); every base value then
 * reads as absent/empty.
 */
export function mergeProjects(base: Project | null, ours: Project, theirs: Project): MergeOutcome {
  const eqNum = (a: number | undefined, b: number | undefined) => a === b
  const eqBool = (a: boolean | undefined, b: boolean | undefined) => a === b
  const rootRefusals: string[] = []

  // Re-shaping decisions: a difference here changes the shape of every tree
  // in the file, so there's no field-level answer — refuse rather than guess.
  const versionM = merge3<number | undefined>(base?.version, ours.version, theirs.version, eqNum)
  if (!versionM) rootRefusals.push('version')

  const schemaM = merge3<ResolvedDef[] | undefined>(base?.schema, ours.schema, theirs.schema, deepEqualJson)
  if (!schemaM) rootRefusals.push('config.schema')

  const aiM = merge3<boolean | undefined>(base?.aiEnabled, ours.aiEnabled, theirs.aiEnabled, eqBool)
  if (!aiM) rootRefusals.push('config.ai')

  // Refused on two-sided disagreement: this decides what every green dot in
  // the file means (see `Project.finishCheckbox`), so guessing would silently
  // redefine both reviewers' progress reports.
  const finishM = merge3<boolean | undefined>(
    base?.finishCheckbox,
    ours.finishCheckbox,
    theirs.finishCheckbox,
    eqBool,
  )
  if (!finishM) rootRefusals.push('config.finishCheckbox')

  const reviewersM = merge3<number | undefined>(base?.reviewers, ours.reviewers, theirs.reviewers, eqNum)
  if (!reviewersM) rootRefusals.push('config.reviewers')

  // Reshaping like `schema`: whether a project screens, and its reasons,
  // decides `config.schema` via `screeningSchemaDefs` (see data-model.md's
  // "Screening" section) — too much for one conflict row to express.
  const screeningM = merge3<ScreeningConfig | null | undefined>(
    base?.screening,
    ours.screening,
    theirs.screening,
    deepEqualJson,
  )
  if (!screeningM) rootRefusals.push('config.screening')

  // Doesn't reshape any tree, but is a nested record `FieldConflict.type`
  // can't express as a conflict row, so genuine two-sided disagreement must
  // refuse; the common one-side-sets-it case merges cleanly via `merge3`.
  const provenanceM = merge3<ProjectProvenance | null | undefined>(
    base?.provenance,
    ours.provenance,
    theirs.provenance,
    deepEqualJson,
  )
  if (!provenanceM) rootRefusals.push('provenance')

  // Same reasoning as `provenance` above: two-sided disagreement refuses so a
  // reviewer's authored protocol is never silently half-dropped.
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

  // Every tree below is walked against the winning schema, so a field it
  // removed is simply never visited — same as `normalizeTree` would drop it
  // on the next ordinary load. Safe because `schemaRemovalRefusal` already
  // refused if that would discard an answer.
  const mergedSchema = schemaM!.value!

  const schemaRemoval = schemaRemovalRefusal(base, mergedSchema, ours, theirs)
  if (schemaRemoval) return refused([schemaRemoval])

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

  // Not in the refusal list above: one string, a conflict row expresses it
  // fine — refusing the whole merge over a renamed review would be absurd.
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

  // Same as `title` above: one string, so a conflict row works here, unlike
  // `provenance`/`protocol`'s nested-record refusal.
  const schemaInfoM = merge3<string | null>(
    base?.schemaInfo ?? null,
    ours.schemaInfo,
    theirs.schemaInfo,
    (a, b) => a === b,
  )
  const schemaInfo = schemaInfoM ? schemaInfoM.value : ours.schemaInfo
  if (!schemaInfoM) {
    conflicts.push({
      id: conflictId('', { kind: 'project' }, 'schemaInfo'),
      paperId: '',
      paperTitle: '',
      tree: { kind: 'project' },
      canonical: 'schemaInfo',
      label: 'Schema info',
      type: 'string',
      base: sOrNull(base?.schemaInfo ?? undefined),
      ours: sOrNull(ours.schemaInfo ?? undefined),
      theirs: sOrNull(theirs.schemaInfo ?? undefined),
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
      finishCheckbox: finishM!.value!,
      reviewers: reviewersM!.value!,
      screening: screeningM!.value ?? null,
      provenance: provenanceM!.value ?? null,
      protocol: protocolM!.value ?? null,
      schemaInfo,
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
 * counterpart to `containerAt` in `src/state/store.ts`, reimplemented (not
 * imported) so a conflict id resolved against a since-changed schema is
 * skipped, never thrown.
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
    if (conflict.canonical === 'schemaInfo') {
      const s = valueToString(value).trim()
      draft.schemaInfo = s || null
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
        // `parseYear` also covers a stale/hand-built resolution handing back
        // a string instead of a number — this must never write anything but
        // a number, same as `writePaperMeta` in changes.ts.
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
 * resolution keeps `mergeProjects`'s value; a resolution for an id not in
 * `conflicts` is ignored (stale merge).
 *
 * Uses immer's `produce` (already a dependency, handles a frozen input like a
 * Zustand store hands over) rather than `structuredClone` or
 * `JSON.parse(JSON.stringify(...))`, which drops `undefined`-valued keys that
 * `deepEqualJson` cares about.
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
