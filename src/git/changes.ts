import { produce } from 'immer'
import { isField, type FieldType, type ResolvedDef } from '../model/schema'
import { emptyValue, makeInstance, type AnnotationValueTree, type FieldValue, type InstanceNode } from '../model/annotations'
import { deepEqualJson, type Paper, type Project } from '../model/project'
import { formatPath, displayPath, resolvePath, type RawSeg } from '../llm/paths'
import { conflictId, type MergeTree } from './merge'
import { parseYear } from '../model/year'

/**
 * Field-level review of what changed **locally**, for the commit panel —
 * unlike `merge.ts`'s three-way reconciliation of two divergent copies, only
 * one side here ever changes (working vs HEAD), so every difference is a
 * reviewer decision, not something that might resolve itself. Borrows
 * `merge.ts`'s shape (canonical paths, per-tree identity) but not its
 * `merge3` rule.
 */

export type Disposition = 'use' | 'ignore' | 'discard'

/** One field whose value differs between HEAD and the working tree. */
export interface FieldChange {
  /** Decision-map key and React row key. Uses `merge.ts`'s `conflictId`
   *  shape so the two are recognisably siblings but never comparable. */
  id: string
  paperId: string
  paperTitle: string
  tree: MergeTree
  /** "Findings[1]/Claim" for an annotation field; the bare key ("title",
   *  "abstract") for a paper-level one. */
  canonical: string
  /** What the row shows: "Findings #2 › Claim", "Title", "Abstract". */
  label: string
  type: FieldType
  options?: string[]
  headValue: FieldValue
  workingValue: FieldValue
  /** Other canonical paths, same paper and tree, that follow this row's
   *  disposition instead of getting a row of their own — see
   *  `PAPER_META_BUNDLES`. Empty for every ordinary field. */
  bundled: string[]
}

export type PaperChangeKind = 'added' | 'removed'

/** A whole paper present on only one side, reviewed as one unit since
 *  there's nothing on the other side to line it up field by field against. */
export interface PaperChange {
  id: string
  paperId: string
  paperTitle: string
  kind: PaperChangeKind
}

export interface DetectedChanges {
  fields: FieldChange[]
  papers: PaperChange[]
}

/**
 * Paper-level fields whose *meaning* is owned by another field, so they never
 * get a row of their own: `abstractFromPdf` is a disclosure about `abstract`,
 * not an independent fact a reviewer picks. Its value just follows whatever
 * disposition the primary field gets. Keyed by the primary's canonical.
 *
 * If the primary hasn't changed but a bundled field has (only possible via a
 * hand-edited file), `detectFieldChanges` gives the bundled field its own row
 * instead of dropping it — see the fallback there.
 */
const PAPER_META_BUNDLES: Record<string, string[]> = {
  abstract: ['abstractFromPdf'],
}

function abstractFromPdfLabel(value: FieldValue): FieldValue {
  return value ? 'Extracted from the PDF' : 'Not extracted from the PDF'
}

/** Paper-level fields eligible for field-level review, in display order.
 *  `id`, `annotations`/`reviews`, and bookkeeping fields (`aiUsage`, `equal`,
 *  `finished`, `reviewsFinished`, `extra`) are excluded — they carry over with
 *  whichever disposition the whole paper ends up with, via the bookkeeping
 *  loop in `composeContents`. */
const PAPER_META_FIELDS: {
  canonical: string
  label: string
  type: FieldType
  get: (p: Paper) => FieldValue
}[] = [
  { canonical: 'title', label: 'Title', type: 'string', get: (p) => p.title },
  { canonical: 'authors', label: 'Authors', type: 'string', get: (p) => p.authors.join(', ') },
  { canonical: 'year', label: 'Year', type: 'year', get: (p) => p.year ?? null },
  { canonical: 'venue', label: 'Venue', type: 'string', get: (p) => p.venue ?? null },
  { canonical: 'doi', label: 'DOI', type: 'string', get: (p) => p.doi ?? null },
  { canonical: 'abstract', label: 'Abstract', type: 'string', get: (p) => p.abstract ?? null },
  {
    canonical: 'abstractFromPdf',
    label: 'Abstract source',
    type: 'string', // rendered as text (formatValue below), not a checkbox — this is a disclosure sentence, not a toggle a reviewer sets
    get: (p) => abstractFromPdfLabel(p.abstractFromPdf ?? false),
  },
  { canonical: 'pdf', label: 'PDF path', type: 'string', get: (p) => p.pdf },
]

/** One rendered value at one revision, `emptyValue`-normalized (same rule as
 *  `merge.ts`'s `valueAt`): a missing instance must compare equal to one
 *  holding the schema's empty value, or an untouched field would look changed
 *  against HEAD's explicit empty write. */
function valueAt(def: ResolvedDef, inst: InstanceNode | undefined): FieldValue {
  return inst && 'value' in inst ? (inst.value ?? emptyValue(def.type)) : emptyValue(def.type)
}

function arrOf(tree: AnnotationValueTree | undefined, name: string): InstanceNode[] {
  const raw = tree?.[name]
  return Array.isArray(raw) ? raw : []
}

/** Walks one annotation tree in parallel across HEAD and the working copy,
 *  pushing a `FieldChange` for every leaf whose value differs. */
function diffTree(
  defs: ResolvedDef[],
  paperId: string,
  paperTitle: string,
  tree: MergeTree,
  headTree: AnnotationValueTree | undefined,
  workingTree: AnnotationValueTree | undefined,
  prefix: RawSeg[],
  out: FieldChange[],
): void {
  for (const def of defs) {
    const hArr = arrOf(headTree, def.name)
    const wArr = arrOf(workingTree, def.name)
    // Take whichever side has more instances, so a trailing one pruned only on
    // the working side still gets compared (same as merge.ts's three-way walk).
    const count = Math.max(hArr.length, wArr.length, Math.max(def.min, 1))
    for (let i = 0; i < count; i++) {
      const segs: RawSeg[] = [...prefix, { name: def.name, index: i }]
      const hInst = hArr[i]
      const wInst = wArr[i]

      if (isField(def)) {
        const hv = valueAt(def, hInst)
        const wv = valueAt(def, wInst)
        if (hv !== wv) {
          const canonical = formatPath(segs)
          out.push({
            id: conflictId(paperId, tree, canonical),
            paperId,
            paperTitle,
            tree,
            canonical,
            label: displayPath(segs),
            type: def.type!,
            options: def.options,
            headValue: hv,
            workingValue: wv,
            bundled: [],
          })
        }
      }
      if (def.children.length > 0) {
        diffTree(def.children, paperId, paperTitle, tree, hInst?.children, wInst?.children, segs, out)
      }
    }
  }
}

/** Paper-metadata differences, with `PAPER_META_BUNDLES` folded in. */
function diffPaperMeta(head: Paper, working: Paper, out: FieldChange[]): void {
  const byCanonical = new Map<string, FieldChange>()
  for (const f of PAPER_META_FIELDS) {
    const hv = f.get(head)
    const wv = f.get(working)
    if (hv === wv) continue
    const change: FieldChange = {
      id: conflictId(working.id, { kind: 'paper' }, f.canonical),
      paperId: working.id,
      paperTitle: working.title,
      tree: { kind: 'paper' },
      canonical: f.canonical,
      label: f.label,
      type: f.type,
      headValue: hv,
      workingValue: wv,
      bundled: [],
    }
    byCanonical.set(f.canonical, change)
  }

  for (const [primary, hidden] of Object.entries(PAPER_META_BUNDLES)) {
    const primaryChange = byCanonical.get(primary)
    for (const h of hidden) {
      const hiddenChange = byCanonical.get(h)
      if (!hiddenChange) continue // that field didn't change — nothing to fold in
      if (primaryChange) {
        // Fold the hidden field into the primary's row, dropping its own row.
        primaryChange.bundled.push(h)
        byCanonical.delete(h)
      }
      // else: no primary row to fold into — leave the hidden field's own row
      // (see PAPER_META_BUNDLES doc comment).
    }
  }

  out.push(...byCanonical.values())
}

/**
 * What changed locally, field by field — the data source for the commit
 * panel's review UI. Returns `null` when `head` and `working` disagree on
 * anything that reshapes the file (`config.schema`, `config.reviewers`,
 * `config.ai`, `config.screening`, `version`, `title`, `schemaInfo`,
 * `provenance`, `protocol`, or root `extra`): once the schema differs,
 * "which fields changed" has no field-level answer, same as `merge.ts`'s
 * three-way merge refusing for the same reason. `provenance`/`protocol` are
 * excluded for a different reason — each is a nested record no
 * `FieldConflict` shape can express. The caller falls back to a plain
 * file-level commit in that state.
 */
export function detectFieldChanges(head: Project, working: Project): DetectedChanges | null {
  const structural =
    !deepEqualJson(head.schema, working.schema) ||
    head.reviewers !== working.reviewers ||
    head.aiEnabled !== working.aiEnabled ||
    head.finishCheckbox !== working.finishCheckbox ||
    !deepEqualJson(head.screening, working.screening) ||
    head.version !== working.version ||
    !deepEqualJson(head.extra, working.extra) ||
    !deepEqualJson(head.provenance, working.provenance) ||
    !deepEqualJson(head.protocol, working.protocol) ||
    (head.title ?? '') !== (working.title ?? '') ||
    head.schemaInfo !== working.schemaInfo
  if (structural) return null

  const fields: FieldChange[] = []
  const papers: PaperChange[] = []

  const headById = new Map(head.papers.map((p) => [p.id, p]))
  const workingById = new Map(working.papers.map((p) => [p.id, p]))

  for (const p of working.papers) {
    if (!headById.has(p.id)) {
      papers.push({
        id: conflictId(p.id, { kind: 'paper' }, '__added__'),
        paperId: p.id,
        paperTitle: p.title,
        kind: 'added',
      })
    }
  }
  for (const p of head.papers) {
    if (!workingById.has(p.id)) {
      papers.push({
        id: conflictId(p.id, { kind: 'paper' }, '__removed__'),
        paperId: p.id,
        paperTitle: p.title,
        kind: 'removed',
      })
    }
  }

  // Only papers present on both sides get field-level diffing; one-sided
  // papers are already covered by the paper-level rows above.
  for (const p of working.papers) {
    const h = headById.get(p.id)
    if (!h) continue

    diffPaperMeta(h, p, fields)

    const tree = { kind: 'annotations' as const }
    diffTree(working.schema, p.id, p.title, tree, h.annotations, p.annotations, [], fields)

    if (working.reviewers > 1) {
      for (let i = 1; i <= working.reviewers; i++) {
        const reviewer = String(i)
        diffTree(
          working.schema,
          p.id,
          p.title,
          { kind: 'review', reviewer },
          h.reviews[reviewer],
          p.reviews[reviewer],
          [],
          fields,
        )
      }
    }
  }

  return { fields, papers }
}

// ---------------------------------------------------------------------------
// Composing the two outputs
// ---------------------------------------------------------------------------

function containerAt(root: AnnotationValueTree, path: RawSeg[]): AnnotationValueTree | null {
  let tree: AnnotationValueTree | undefined = root
  for (const seg of path) {
    const inst: InstanceNode | undefined = tree?.[seg.name]?.[seg.index]
    if (!inst?.children) return null
    tree = inst.children
  }
  return tree ?? null
}

/**
 * Grow `target` so every repeatable node has at least as many instances as
 * `source`, padding with empty `makeInstance` skeletons. `committed` starts
 * from HEAD (sized to schema minimum), so a reviewer-added instance has no
 * slot to write "use" into without this — `writeAnnotationValue` would
 * silently no-op and the value would be dropped and permanently
 * uncommittable. Padding never fabricates a value: an unused padded slot that
 * ends up interior (e.g. using Findings[2] but ignoring [1]) is left as a
 * deliberate blank rather than sliding later entries up and re-pointing an
 * answer — see `pruneTree`. `max` is respected so an over-`max` working tree
 * can't grow the committed one past the bound.
 */
function growTreeToSource(
  defs: ResolvedDef[],
  target: AnnotationValueTree,
  source: AnnotationValueTree | undefined,
): void {
  for (const def of defs) {
    if (!isField(def) && def.children.length === 0) continue
    const srcList = source?.[def.name]
    const tgtList = target[def.name]
    if (!Array.isArray(tgtList)) continue
    if (Array.isArray(srcList)) {
      const limit = def.max === null ? srcList.length : Math.min(srcList.length, def.max)
      while (tgtList.length < limit) tgtList.push(makeInstance(def))
    }
    if (def.children.length > 0) {
      for (let i = 0; i < tgtList.length; i++) {
        const child = tgtList[i]?.children
        if (child) growTreeToSource(def.children, child, srcList?.[i]?.children)
      }
    }
  }
}

function writeAnnotationValue(draft: Project, fc: FieldChange, value: FieldValue): void {
  const paper = draft.papers.find((p) => p.id === fc.paperId)
  if (!paper) return
  const root = fc.tree.kind === 'review' ? paper.reviews[fc.tree.reviewer] : paper.annotations
  if (!root) return
  const resolved = resolvePath(draft.schema, fc.canonical)
  if (!resolved) return // the schema no longer has this field — nothing safe to write
  const container = containerAt(root, resolved.path)
  if (!container) return
  const inst = container[resolved.name]?.[resolved.index]
  if (!inst) return
  inst.value = value
}

function writePaperMeta(draft: Project, paperId: string, canonical: string, value: FieldValue): void {
  const paper = draft.papers.find((p) => p.id === paperId)
  if (!paper) return
  switch (canonical) {
    case 'title':
      paper.title = value === null ? '' : String(value)
      break
    case 'authors':
      paper.authors = (value === null ? '' : String(value))
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      break
    case 'year':
      // `parseYear` handles a value already shaped as a number (the ordinary
      // case) and a stringified one (a hand-built decision) identically.
      paper.year = parseYear(value)
      break
    case 'venue': {
      const s = (value === null ? '' : String(value)).trim()
      paper.venue = s || undefined
      break
    }
    case 'doi': {
      const s = (value === null ? '' : String(value)).trim()
      paper.doi = s || undefined
      break
    }
    case 'abstract': {
      const s = (value === null ? '' : String(value)).trim()
      paper.abstract = s || undefined
      break
    }
    case 'abstractFromPdf':
      // Never written directly — rides along with `abstract`'s disposition
      // (PAPER_META_BUNDLES); the row's display string isn't round-tripped.
      break
    case 'pdf':
      paper.pdf = value === null ? '' : String(value)
      break
  }
}

/** Writes `fc`'s own value from `source` into `draft` — not its bundled
 *  fields, which need the source `Project` itself and are handled by the
 *  caller, `applyFieldWithBundle`. */
function applyField(draft: Project, fc: FieldChange, source: 'head' | 'working'): void {
  const value = source === 'head' ? fc.headValue : fc.workingValue
  if (fc.tree.kind === 'paper') {
    writePaperMeta(draft, fc.paperId, fc.canonical, value)
    return
  }
  writeAnnotationValue(draft, fc, value)
}

/**
 * The two outputs the commit panel needs: the committed content, and what the
 * working-tree file holds afterward. Built from `head`/`working` directly
 * (not from a half-built draft) because the `abstract` bundle needs the raw
 * `abstractFromPdf` boolean, which only the source `Project`s have.
 *
 * Disposition rules, applied uniformly to a field value or an added/removed
 * paper:
 *  - **use**: committed gets the new value/paper; working is unaffected.
 *  - **ignore**: committed keeps HEAD's value/paper; working is unaffected
 *    (change stays there, offered again next time).
 *  - **discard**: committed keeps HEAD's value/paper, and working is
 *    rewritten to match (local edit erased). Only performed when the
 *    reviewer presses Commit, not as a side effect of picking it in the list
 *    (see GitDialog.tsx).
 */
export function composeContents(
  head: Project,
  working: Project,
  changes: DetectedChanges,
  decisions: Record<string, Disposition>,
): { committed: Project; workingOut: Project } {
  const disposition = (id: string): Disposition => decisions[id] ?? 'use'

  const committed = produce(head, (draft) => {
    for (const pc of changes.papers) {
      if (pc.kind !== 'added') continue
      if (disposition(pc.id) === 'use') {
        const p = working.papers.find((x) => x.id === pc.paperId)
        if (p) draft.papers.push(p as Paper)
      }
    }
    const removeIds = new Set(
      changes.papers.filter((pc) => pc.kind === 'removed' && disposition(pc.id) === 'use').map((pc) => pc.paperId),
    )
    if (removeIds.size > 0) draft.papers = draft.papers.filter((p) => !removeIds.has(p.id))

    // Bookkeeping fields have no field-review row (see PAPER_META_FIELDS), so
    // they never go through `applyField` — for a paper on both sides they
    // just take working's copy, since `committed` otherwise stays HEAD's.
    const workingById = new Map(working.papers.map((p) => [p.id, p]))
    for (const draftPaper of draft.papers) {
      const w = workingById.get(draftPaper.id)
      if (!w) continue
      draftPaper.finished = w.finished
      draftPaper.reviewsFinished = w.reviewsFinished
      draftPaper.marks = w.marks
      draftPaper.reviewMarks = w.reviewMarks
      draftPaper.equal = w.equal
      draftPaper.alignment = w.alignment
      draftPaper.aiUsage = w.aiUsage
      draftPaper.extra = w.extra
    }

    // Grow each committed tree to the working shape before writing any "use"
    // value (see `growTreeToSource`). Only annotation trees need this — paper
    // meta is scalar. Done once per (paper, tree) touched.
    const grown = new Set<string>()
    for (const fc of changes.fields) {
      if (disposition(fc.id) !== 'use' || fc.tree.kind === 'paper') continue
      const treeKey = fc.tree.kind === 'review' ? `review/${fc.tree.reviewer}` : 'annotations'
      const grownKey = `${fc.paperId}|${treeKey}`
      if (grown.has(grownKey)) continue
      grown.add(grownKey)
      const draftPaper = draft.papers.find((p) => p.id === fc.paperId)
      const workingPaper = working.papers.find((p) => p.id === fc.paperId)
      if (!draftPaper || !workingPaper) continue
      const target =
        fc.tree.kind === 'review' ? draftPaper.reviews[fc.tree.reviewer] : draftPaper.annotations
      const source =
        fc.tree.kind === 'review' ? workingPaper.reviews[fc.tree.reviewer] : workingPaper.annotations
      if (target) growTreeToSource(draft.schema, target, source)
    }

    for (const fc of changes.fields) {
      if (disposition(fc.id) !== 'use') continue
      applyFieldWithBundle(draft as Project, fc, 'working', working)
    }
  }) as Project

  const workingOut = produce(working, (draft) => {
    for (const pc of changes.papers) {
      if (pc.kind === 'added' && disposition(pc.id) === 'discard') {
        draft.papers = draft.papers.filter((p) => p.id !== pc.paperId)
      }
    }
    for (const pc of changes.papers) {
      if (pc.kind === 'removed' && disposition(pc.id) === 'discard') {
        const p = head.papers.find((x) => x.id === pc.paperId)
        if (p) draft.papers.push(p as Paper)
      }
    }
    for (const fc of changes.fields) {
      if (disposition(fc.id) !== 'discard') continue
      applyFieldWithBundle(draft as Project, fc, 'head', head)
    }
  }) as Project

  return { committed, workingOut }
}

/** `applyField` plus writing `abstractFromPdf`'s real boolean (not its
 *  display string) alongside `abstract`, read from the source `Project`. */
function applyFieldWithBundle(draft: Project, fc: FieldChange, source: 'head' | 'working', sourceProject: Project): void {
  applyField(draft, fc, source)
  if (fc.tree.kind === 'paper' && fc.canonical === 'abstract' && fc.bundled.includes('abstractFromPdf')) {
    const sourcePaper = sourceProject.papers.find((p) => p.id === fc.paperId)
    const draftPaper = draft.papers.find((p) => p.id === fc.paperId)
    if (draftPaper) draftPaper.abstractFromPdf = sourcePaper?.abstractFromPdf ?? undefined
  }
}
