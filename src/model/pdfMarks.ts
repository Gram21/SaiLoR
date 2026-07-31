/**
 * A reviewer's highlights and comments on a paper's PDF — the standard
 * "select text, highlight it, optionally attach a note" most PDF viewers
 * offer, reimplemented as an overlay SaiLoR renders on top of react-pdf's
 * canvas rather than written into the PDF file itself. Keeping the PDF
 * binary untouched is what lets it stay a plain relative-path reference,
 * shared and diffed by git like everything else in a project — writing real
 * PDF annotation objects into the file would make every reviewer's mark a
 * binary edit to a file every reviewer references, with no way to tell whose
 * mark is whose. See `Paper.marks`/`Paper.reviewMarks` (`project.ts`) for
 * where these live per reviewer, and `splitProjectFiles` for the on-disk
 * `marks-<n>.json` / `marks-consolidated.json` files.
 */

/**
 * One highlighted region, as a **fraction of the page's own rendered
 * size** (0..1, from the top-left) — not a pixel or PDF-point coordinate.
 * A page's aspect ratio is fixed regardless of zoom or window width, so a
 * fraction stays correct at any zoom level or container width without any
 * pdf.js viewport math; the renderer just multiplies by the page element's
 * current bounding box. A highlighted selection spanning a line wrap
 * produces one `MarkRect` per line (the same shape `Range.getClientRects()`
 * already returns), not one bounding box, so the highlight follows the
 * text's actual shape instead of covering the whole line width.
 */
export interface MarkRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfMark {
  id: string
  /** 1-indexed, matching react-pdf/pdf.js page numbering. */
  page: number
  /** A text highlight's rects trace the selection (one per wrapped line). A
   *  sticky note has exactly one rect, its `x`/`y` the pinned point — its
   *  `width`/`height` are unused (icon size is fixed in CSS) but kept
   *  non-zero so `isMarkRect` and every existing rect-consumer stay
   *  unchanged. */
  rects: MarkRect[]
  /** A CSS color (this app only ever writes one of `MARK_COLORS`, but a
   *  hand-edited file's value is passed through rather than rejected). */
  color: string
  /** Empty string means "just a highlight, no note attached yet" — never
   *  empty in practice for a `note`, but not enforced, same as everything
   *  else in a hand-editable file. */
  comment: string
  /** The raw text selected at the moment a `'highlight'` mark was created —
   *  captured once, never edited afterward. Always `undefined` for a
   *  `'note'` (no selection is involved in making one) and for any mark
   *  predating this field. Used only as a fallback display label — e.g. the
   *  field-link popover shows this when `comment` is empty — the same "user
   *  note first, else something to tell marks apart by" role `comment`
   *  plays elsewhere. */
  text?: string
  createdAt: string
  updatedAt: string
  /** `'highlight'` (default, and every mark before this field existed) traces
   *  selected text. `'note'` pins a sticky note at a point — no text is
   *  selected to make one. */
  kind: 'highlight' | 'note'
  /** Fields this mark has been linked to as supporting evidence ("why I
   *  picked this value"). Undefined on every mark before this feature
   *  existed, and rewritten back to undefined (never `[]`) once the last
   *  link is removed — same legacy-default precedent `kind` set. */
  linkedFields?: LinkedField[]
}

/**
 * One field a mark is linked to. `path` is `fieldPath`'s canonical form at
 * link time (e.g. `Findings[1]/Metric`) — the source of truth for lookups.
 * `label` is `displayPath`'s human-readable form at link time, denormalized
 * so a mark's popover still shows something meaningful if the field is later
 * renamed or removed out from under the link — canonical paths are name/path
 * derived (see `src/llm/paths.ts`) and are NOT stable across a schema rename,
 * move, or an earlier repeatable instance being added/removed (which shifts
 * every later index with no reconciliation — the same known limitation
 * `aiMarks`/`deferredConsolidations` in `store.ts` already have).
 */
export interface LinkedField {
  path: string
  label: string
}

/** The palette offered when creating or recoloring a highlight — the same
 *  handful of colors most PDF viewers default to. */
export const MARK_COLORS = ['#ffe066', '#a5f3a5', '#a5d8ff', '#ffb3c1', '#d0bfff']

function isMarkRect(v: unknown): v is MarkRect {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
}

function isLinkedField(v: unknown): v is LinkedField {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.path === 'string' && !!r.path && typeof r.label === 'string'
}

/** Defensive parse, same "drop the malformed entry, never throw" rule as
 *  everything else here. `undefined` (not `[]`) for "no links" so a mark
 *  with none round-trips byte-identical to one from before this field
 *  existed, and `marks-*.json` doesn't grow a `"linkedFields": []` on every
 *  mark that has never been linked to anything. */
function parseLinkedFields(raw: unknown): LinkedField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter(isLinkedField)
  return out.length > 0 ? out : undefined
}

/**
 * Parse a `PdfMark[]` defensively, the same rule every other hand-editable
 * array in this file format follows (see `parseAiUsage` in `project.ts`): a
 * malformed entry is dropped, never thrown over.
 */
export function parseMarks(raw: unknown): PdfMark[] {
  if (!Array.isArray(raw)) return []
  const out: PdfMark[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id) continue
    if (typeof e.page !== 'number' || !Number.isInteger(e.page) || e.page < 1) continue
    if (!Array.isArray(e.rects) || e.rects.length === 0 || !e.rects.every(isMarkRect)) continue
    if (typeof e.color !== 'string' || !e.color) continue
    out.push({
      id: e.id,
      page: e.page,
      rects: e.rects as MarkRect[],
      color: e.color,
      comment: typeof e.comment === 'string' ? e.comment : '',
      text: typeof e.text === 'string' && e.text ? e.text : undefined,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      kind: e.kind === 'note' ? 'note' : 'highlight',
      linkedFields: parseLinkedFields(e.linkedFields),
    })
  }
  return out
}

/**
 * Union two sides' marks by id — every mark either side has survives; a
 * mark both sides have (same id) but edited differently keeps whichever was
 * touched more recently (`updatedAt`, falling back to "ours" on a tie or
 * missing timestamp). Deliberately not a field-level conflict the reviewer
 * is asked about, unlike an annotation answer: a highlight is a personal
 * reading note, not the record a review reports, so never losing one matters
 * more than which exact wording of an edited comment wins. Used for both a
 * pull merge and carrying marks across a branch switch — the same "reconcile
 * two sides that may have each changed things independently" shape either
 * way.
 */
export function mergeMarksList(ours: PdfMark[], theirs: PdfMark[]): PdfMark[] {
  const byId = new Map<string, PdfMark>()
  for (const m of ours) byId.set(m.id, m)
  for (const t of theirs) {
    const o = byId.get(t.id)
    if (!o) {
      byId.set(t.id, t)
      continue
    }
    if (t.updatedAt && (!o.updatedAt || t.updatedAt > o.updatedAt)) byId.set(t.id, t)
  }
  return [...byId.values()]
}

/** Stable reading order for cycling through every mark on a PDF (the "next/
 *  previous annotation" toolbar in `PdfViewer`): top-to-bottom by page, then
 *  top-to-bottom within a page by the first rect's `y`. */
export function sortMarksForCycling(marks: PdfMark[]): PdfMark[] {
  return [...marks].sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y)
}

/**
 * Parse `paper.reviewMarks` defensively — same rule `parseReviews` follows
 * in `project.ts` (only a key that looks like a reviewer number survives).
 */
export function parseReviewMarks(raw: unknown): Record<string, PdfMark[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PdfMark[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(key)) continue
    const marks = parseMarks(value)
    if (marks.length > 0) out[key] = marks
  }
  return out
}
