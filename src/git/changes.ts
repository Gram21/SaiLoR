import { produce } from 'immer'
import { isField, type FieldType, type ResolvedDef } from '../model/schema'
import { emptyValue, type AnnotationValueTree, type FieldValue, type InstanceNode } from '../model/annotations'
import { deepEqualJson, type Paper, type Project } from '../model/project'
import { formatPath, displayPath, resolvePath, type RawSeg } from '../llm/paths'
import { conflictId, type MergeTree } from './merge'

/**
 * Field-level review of what changed **locally**, for the commit panel — a
 * genuinely different question from `merge.ts`'s three-way reconciliation of
 * two *divergent* copies. Here there is one side that changed (the working
 * tree) and one side that did not (HEAD), so every difference is something
 * the reviewer decides about, not something that might already resolve
 * itself. `merge.ts` is still the right model to borrow the *shape* of
 * (canonical paths, per-tree identity, a paper-metadata field list) — just
 * not its `merge3` rule, which has no "which side changed" question to
 * answer when only one side ever does.
 */

export type Disposition = 'use' | 'ignore' | 'discard'

/** One field whose value differs between HEAD and the working tree. */
export interface FieldChange {
  /** Stable identity — the decision map's key and the row's React key. Same
   *  `conflictId` shape `merge.ts` uses, so the two are never accidentally
   *  comparable but are recognisably siblings. */
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
  /** Other canonical paths, under the same paper and tree, whose value
   *  follows this row's disposition instead of getting a row of its own —
   *  see `PAPER_META_BUNDLES`. Empty for every ordinary field. */
  bundled: string[]
}

export type PaperChangeKind = 'added' | 'removed'

/** A whole paper present on only one side — reviewed as one unit, the same
 *  way `merge.ts` treats a paper `mergePapers` cannot line up field by field
 *  because the other side has nothing to compare it against. */
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
 * A paper-level field whose *meaning* is entirely owned by another field, so
 * it never gets a row of its own: `abstractFromPdf` is a disclosure about
 * `abstract` ("this text is a guess"), not an independent fact a reviewer
 * chooses among. Its own value simply follows whatever disposition the
 * primary field gets. Keyed by the primary's canonical.
 *
 * If the primary's value happens not to have changed while a bundled one
 * did (in practice, only `abstractFromPdf` flipping on its own — an edit path
 * this codebase doesn't have, but a hand-edited file could still produce),
 * `detectFieldChanges` gives the bundled field a row of its own instead of
 * silently dropping it — see the fallback there.
 */
const PAPER_META_BUNDLES: Record<string, string[]> = {
  abstract: ['abstractFromPdf'],
}

function abstractFromPdfLabel(value: FieldValue): FieldValue {
  return value ? 'Extracted from the PDF' : 'Not extracted from the PDF'
}

/** Paper-level fields eligible for field-level review, in display order.
 *  `id` is identity, not a field; `annotations`/`reviews`/`aiUsage`/`equal`/
 *  `extra` are handled separately below (`aiUsage` and `equal` are system
 *  bookkeeping, not something a reviewer picks a value for, so they are
 *  never split out as their own rows — they simply carry over with whichever
 *  disposition the paper they belong to ends up with as a whole). */
const PAPER_META_FIELDS: {
  canonical: string
  label: string
  type: FieldType
  get: (p: Paper) => FieldValue
}[] = [
  { canonical: 'title', label: 'Title', type: 'string', get: (p) => p.title },
  { canonical: 'authors', label: 'Authors', type: 'string', get: (p) => p.authors.join(', ') },
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

/** One rendered value at one revision, `emptyValue`-normalized — the same
 *  "absent reads as empty" rule `merge.ts`'s `valueAt` applies, for the same
 *  reason: an instance that is not there and one that is there holding the
 *  schema's own empty value must compare equal, or a field the working tree
 *  never reached would look like a change against one HEAD explicitly wrote
 *  as empty. */
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
    // The working tree's own instance count drives the walk — an instance
    // only HEAD has (the working tree pruned a trailing one away) still needs
    // a comparison, so this takes whichever side has more, the same way
    // `merge.ts`'s three-way walk does.
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
        // The common case: fold the hidden field into the primary's row and
        // drop the hidden field's own row from the output entirely.
        primaryChange.bundled.push(h)
        byCanonical.delete(h)
      }
      // No primary row to fold into (the primary's value happens not to have
      // changed) — leave the hidden field's own row in place. See
      // PAPER_META_BUNDLES's doc comment: this path exists for a hand-edited
      // file, not anything the app's own code produces.
    }
  }

  out.push(...byCanonical.values())
}

/**
 * What changed locally, field by field — the data source for the commit
 * panel's review UI. Returns `null` when `head` and `working` disagree on
 * anything that reshapes the file (`config.schema`, `config.reviewers`,
 * `config.ai`, `config.screening`, `config.reviewerIdentities`, `version`,
 * `provenance`, or a root `extra` key): once the schema itself is different,
 * "which fields changed" is not a question with a field-level answer any more
 * than it is for `merge.ts`'s three-way merge, which refuses the same
 * differences for the same reason. `provenance` is here for a different
 * reason than the rest — it is a nested record no `FieldConflict` shape can
 * express, not something that reshapes the file. The caller falls back to the
 * plain file-level commit for a project file in that state.
 *
 * `reviewerIdentities` belongs here, not in the field walk below: claiming a
 * seat is not an annotation with a "which value do I want" answer — it is the
 * same kind of config change `config.reviewers` already is, and the panel
 * never offers a reviewer a per-field choice for either. The cost is bounded
 * and self-healing: only the one commit where a seat is first claimed falls
 * back to the whole-file checkbox (which does commit it — see `runCommit` in
 * `gitStore.ts`); every commit after that, `head.reviewerIdentities` already
 * matches, and field-level review resumes.
 */
export function detectFieldChanges(head: Project, working: Project): DetectedChanges | null {
  const structural =
    !deepEqualJson(head.schema, working.schema) ||
    head.reviewers !== working.reviewers ||
    head.aiEnabled !== working.aiEnabled ||
    !deepEqualJson(head.screening, working.screening) ||
    !deepEqualJson(head.reviewerIdentities, working.reviewerIdentities) ||
    head.version !== working.version ||
    !deepEqualJson(head.extra, working.extra) ||
    !deepEqualJson(head.provenance, working.provenance)
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

  // Field-level diffing only makes sense for a paper present on both sides —
  // one only one side has is already fully covered by the paper-level rows
  // above, and paper-level `extra` is intentionally not field-diffed (the
  // same scope line PAPER_META_FIELDS draws: it rides along with the paper).
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
      // Never written directly — always riding along with `abstract`'s own
      // disposition (PAPER_META_BUNDLES), so `applyField` below writes it via
      // the *paper's* raw boolean, not this row's own display string value
      // (`abstractFromPdfLabel`'s prose is for showing, not round-tripping).
      break
    case 'pdf':
      paper.pdf = value === null ? '' : String(value)
      break
  }
}

/** Writes `fc`'s own value from `source` ('head' or 'working') into `draft` —
 *  not its bundled fields, which need the *source* `Project` itself
 *  (`abstractFromPdf`'s real boolean is never on `FieldChange`, only its
 *  display string is) and are handled by the caller, `applyFieldWithBundle`. */
function applyField(draft: Project, fc: FieldChange, source: 'head' | 'working'): void {
  const value = source === 'head' ? fc.headValue : fc.workingValue
  if (fc.tree.kind === 'paper') {
    writePaperMeta(draft, fc.paperId, fc.canonical, value)
    return
  }
  writeAnnotationValue(draft, fc, value)
}

/**
 * The two outputs the commit panel needs: the content that gets committed,
 * and the content the working-tree file ends up holding afterward. Built
 * from `head` and `working` (never from `applyField` writing into a half-built
 * draft alone), because the paper-level bundle for `abstract` needs the raw
 * `abstractFromPdf` boolean, which only the source `Project`s actually have.
 *
 * The rule per disposition, applied uniformly across a field's value, a
 * paper added locally, or a paper removed locally:
 *  - **use**: the committed content gets the new value/paper; the working
 *    file is unaffected (it already has it).
 *  - **ignore**: the committed content keeps HEAD's value/paper (an added
 *    paper is left out, a removed paper's deletion is not committed); the
 *    working file is unaffected — the change stays there, uncommitted, to be
 *    offered again next time.
 *  - **discard**: the committed content keeps HEAD's value/paper, *and* the
 *    working file is rewritten to match — an added paper is deleted from it,
 *    a removed paper is restored to it, a changed field's local edit is
 *    erased. This is why discarding is a real write to the file on disk, not
 *    merely "leave it out of this commit" — the caller only performs it once
 *    the reviewer presses Commit, never as a side effect of picking it in the
 *    list (see GitDialog.tsx).
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

/** `applyField` plus the one thing it cannot do on its own: write
 *  `abstractFromPdf`'s real boolean (not its display string) alongside
 *  `abstract`, read directly from whichever source `Project` actually has it. */
function applyFieldWithBundle(draft: Project, fc: FieldChange, source: 'head' | 'working', sourceProject: Project): void {
  applyField(draft, fc, source)
  if (fc.tree.kind === 'paper' && fc.canonical === 'abstract' && fc.bundled.includes('abstractFromPdf')) {
    const sourcePaper = sourceProject.papers.find((p) => p.id === fc.paperId)
    const draftPaper = draft.papers.find((p) => p.id === fc.paperId)
    if (draftPaper) draftPaper.abstractFromPdf = sourcePaper?.abstractFromPdf ?? undefined
  }
}
