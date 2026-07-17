/**
 * A publication year, parsed and bounds-checked once, shared by every layer
 * that reads or writes `Paper.year` or a `type: "year"` annotation field —
 * `project.ts`'s loader, `validate.ts`'s type check, `references.ts`'s three
 * import formats, `git/merge.ts`, `git/changes.ts`, `Field.tsx`'s PDF-grab,
 * and `editorStore.ts`'s string<->number boundary. One function here instead
 * of several hand-rolled `/\d{4}/` matches is the same rule `deepEqualJson`
 * exists for in `project.ts`: a second implementation is a bug waiting.
 */

/**
 * Static, not `currentYear + N`: a bound that moves with the clock makes
 * tests (and any cached validation result) time-dependent for no real
 * benefit. This range rejects the actual errors a hand-edited file produces
 * (`55`, `20221`) while admitting everything real, including a paper dated
 * next year.
 */
export const YEAR_MIN = 1000
export const YEAR_MAX = 2100

/** A plausible publication year: a whole number inside `[YEAR_MIN, YEAR_MAX]`. */
export function isPlausibleYear(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= YEAR_MIN && v <= YEAR_MAX
}

/**
 * Parse a year out of whatever a hand-edited file, a reference manager
 * export, or an editor text input hands us. A number is range-checked as-is;
 * a string is scanned for its first four-digit run (`"1985--1986"` → 1985,
 * matching how `references.ts` has always read a BibTeX/RIS year range —
 * changing that behaviour here as a side effect of this refactor would be its
 * own regression). Anything else, or a number/token outside the plausible
 * range, is not a year — `undefined`, never thrown over.
 *
 * Deliberately no `\b` word boundary on the digit match: `"12345"` must still
 * read as `1234` (today's references.ts behaviour), not `undefined` — the
 * range check below is what rejects a genuine typo like a bare `20221`.
 */
export function parseYear(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return isPlausibleYear(raw) ? raw : undefined
  }
  if (typeof raw === 'string') {
    const m = raw.match(/\d{4}/)
    if (!m) return undefined
    const n = Number(m[0])
    return isPlausibleYear(n) ? n : undefined
  }
  return undefined
}
