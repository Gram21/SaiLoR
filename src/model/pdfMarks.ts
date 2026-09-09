/**
 * A reviewer's highlights/notes on a paper's PDF, rendered as an overlay
 * rather than written into the PDF file — keeps the PDF binary untouched so
 * it stays a plain, git-diffable reference shared by all reviewers. See
 * `Paper.marks`/`Paper.reviewMarks` (`project.ts`) and `splitProjectFiles`
 * for the on-disk `marks-<n>.json` / `marks-consolidated.json` files.
 */

/**
 * One highlighted region, as a **fraction of the page's own rendered size**
 * (0..1, top-left origin), not a pixel/PDF-point coordinate, so it stays
 * correct at any zoom/container width. A selection spanning a line wrap
 * produces one `MarkRect` per line (matching `Range.getClientRects()`)
 * rather than one bounding box, so the highlight follows the text's shape.
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
  /** A note has exactly one rect (its pinned point); `width`/`height` are
   *  unused but kept non-zero so `isMarkRect` stays happy. */
  rects: MarkRect[]
  /** A CSS color; only ever one of `MARK_COLORS` in practice, but a
   *  hand-edited file's value is passed through rather than rejected. */
  color: string
  /** Empty string means "no note attached yet"; not enforced otherwise. */
  comment: string
  /** Text selected when a `'highlight'` mark was created, captured once.
   *  `undefined` for a `'note'` or any mark predating this field. Fallback
   *  display label (e.g. field-link popover) when `comment` is empty. */
  text?: string
  createdAt: string
  updatedAt: string
  /** `'highlight'` is the default (and every pre-existing mark); `'note'`
   *  pins a sticky note at a point with no text selection. */
  kind: 'highlight' | 'note'
  /** Fields linked to this mark as supporting evidence. `undefined` (never
   *  `[]`) when there are none, including for marks predating this field. */
  linkedFields?: LinkedField[]
  /** Set only when a highlight spans a page boundary: every fragment
   *  sharing a `groupId` is one logical highlight split across pages. Store
   *  actions keep all fragments sharing a `groupId` in sync so they behave
   *  as one highlight to the reviewer. */
  groupId?: string
}

/**
 * One field a mark is linked to. `path` is the canonical `fieldPath` at link
 * time, used for lookups. `label` is the human-readable `displayPath` at
 * link time, denormalized so the popover still shows something meaningful if
 * the field is later renamed/removed — canonical paths aren't stable across
 * a schema rename/move or a repeatable-instance index shift (same known
 * limitation as `aiMarks`/`deferredConsolidations` in `store.ts`).
 */
export interface LinkedField {
  path: string
  label: string
}

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

/** Drops malformed entries rather than throwing. Returns `undefined` (not
 *  `[]`) for "no links" so an unlinked mark round-trips byte-identical and
 *  `marks-*.json` doesn't grow a `"linkedFields": []` on every mark. */
function parseLinkedFields(raw: unknown): LinkedField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter(isLinkedField)
  return out.length > 0 ? out : undefined
}

/** Parse a `PdfMark[]` defensively (see `parseAiUsage` in `project.ts`): a
 *  malformed entry is dropped, never thrown over. */
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
      groupId: typeof e.groupId === 'string' && e.groupId ? e.groupId : undefined,
    })
  }
  return out
}

/**
 * Union two sides' marks by id — every mark from either side survives; a
 * mark both sides have keeps whichever was edited more recently
 * (`updatedAt`, falling back to "ours" on a tie/missing timestamp). No
 * field-level conflict prompt: a highlight is a personal reading note, not a
 * review record, so never losing one matters more than which edit wins.
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

/** Midpoint splitting a two-column layout's left/right halves — good enough
 *  since body text rarely starts past the page's own midpoint. */
const COLUMN_SPLIT_X = 0.5

/** Which half of the page a rect's left edge falls in: 0 left, 1 right. */
function columnOf(rect: MarkRect): number {
  return rect.x < COLUMN_SPLIT_X ? 0 : 1
}

/**
 * Stable reading order for cycling through marks: by page, then column
 * (`columnOf`, left before right), then the first rect's `y` within that
 * column. Plain `y` would interleave a two-column paper's columns by
 * absolute vertical position; plain `x`-then-`y` would reorder highlights
 * within the same column due to indentation jitter. Bucketing by column
 * first avoids both. Cross-page highlight fragments are deduped to one
 * (earliest page) so cycling lands on each once, not per page touched.
 */
export function sortMarksForCycling(marks: PdfMark[]): PdfMark[] {
  const sorted = [...marks].sort(
    (a, b) =>
      a.page - b.page ||
      columnOf(a.rects[0]) - columnOf(b.rects[0]) ||
      a.rects[0].y - b.rects[0].y,
  )
  return dedupeMarkGroups(sorted)
}

/**
 * Collapse a mark list to one representative per logical mark: fragments
 * sharing a `groupId` become one entry (first in input order survives). The
 * single place every "list/count marks" consumer routes through, so they
 * agree on what counts as "one mark".
 */
export function dedupeMarkGroups(marks: PdfMark[]): PdfMark[] {
  const seen = new Set<string>()
  const out: PdfMark[] = []
  for (const m of marks) {
    const key = m.groupId ?? m.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/** How many of this session's own marks pin to the top of the field-link
 *  popover, ahead of the page-ordered rest. */
const RECENT_LINK_CANDIDATES = 3

/**
 * Order marks for the field-link popover: up to `RECENT_LINK_CANDIDATES` of
 * *this session's own* marks (most recent first), then the rest in
 * `sortMarksForCycling` order. Scoped to `sessionMarkIds` (marks created
 * since the app opened, tracked by `addHighlight` in store.ts) rather than
 * `createdAt`, so reopening a paper with old highlights doesn't pin random
 * ones — nothing from a previous sitting counts as "recent". Each mark
 * appears exactly once (pinned ones are filtered out of the tail).
 */
export function orderMarksForLinking(marks: PdfMark[], sessionMarkIds: ReadonlySet<string>): PdfMark[] {
  const sessionMarks = marks.filter((m) => sessionMarkIds.has(m.id))
  const recent = [...sessionMarks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_LINK_CANDIDATES)
  const recentIds = new Set(recent.map((m) => m.id))
  const rest = sortMarksForCycling(marks).filter((m) => !recentIds.has(m.id))
  return [...recent, ...rest]
}

/** Parse `paper.reviewMarks` defensively (see `parseReviews` in
 *  `project.ts`): only a key that looks like a reviewer number survives. */
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
