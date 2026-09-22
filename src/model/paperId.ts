/**
 * Is this string safe to use, verbatim, as a directory name on every
 * platform the team might check the repository out on?
 *
 * `splitProjectFiles` (`src/model/project.ts`) writes a paper's annotations
 * to `annotations/<paper.id>/reviewer-N.json` — the id goes straight into a
 * path component, unmodified. An *auto-generated* id (`paperIdFromName`,
 * `src/state/editorStore.ts`) is already slugified to `[a-z0-9-]+` and always
 * safe, but a manually typed or edited id is free text the reviewer can put
 * anything into, and the mistakes only surface on a teammate's machine: a
 * colon or question mark is fine on macOS/Linux and unrepresentable on
 * Windows, and two ids differing only in case collapse into one directory on
 * any case-insensitive checkout (Windows, default macOS) — silently
 * destroying whichever reviewer's folder loses the collision.
 *
 * Lives in `src/model` rather than in `PapersEditor.tsx` for the same reason
 * `relPathProblem` lives in `src/git/relpath.ts` instead of `electron/`: it
 * is a check on a plain string, so it is testable without a DOM or a
 * filesystem, and both the editor (live, per-keystroke feedback) and
 * `validateDraft` (the save-blocking gate) need to agree on the same answer.
 */

/** Reasons a paper id is refused as a directory name, for the caller's error message. */
export type PaperIdProblem = 'empty' | 'control-char' | 'dot' | 'illegal-char' | 'trailing-dot-or-space' | 'reserved-name'

export interface PaperIdIssue {
  reason: PaperIdProblem
  /** Plain-language specifics for `reason`, e.g. which characters or which
   *  reserved name — written to slot directly after an em dash in an error message. */
  detail: string
}

// Win32's own illegal set. None of these are legal in a POSIX file name
// either except `/`, but `/` is already excluded because it would create
// subdirectories instead of one directory named after the id.
const ILLEGAL_CHARS = /[<>:"/\\|?*]/g

// Case-insensitive: Windows reserves these regardless of case, and also when
// followed by an extension (`CON.json` still opens the `CON` device, not a file).
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** `null` when `id` is acceptable, otherwise why it is not. Expects `id` already trimmed. */
export function paperIdProblem(id: string): PaperIdIssue | null {
  if (!id) return { reason: 'empty', detail: 'the id is empty' }
  // Control characters, before anything else: a newline or NUL in a folder
  // name is never legitimate and can corrupt whatever the path is spliced into.
  if (/[\x00-\x1f]/.test(id)) return { reason: 'control-char', detail: 'it contains a control character' }
  // `.` and `..` are valid path segments, just never the *paper's own*
  // directory — one means "here", the other means "the parent of annotations/".
  if (id === '.' || id === '..') return { reason: 'dot', detail: `"${id}" is not a valid folder name` }

  const illegal = [...new Set(id.match(ILLEGAL_CHARS) ?? [])]
  if (illegal.length > 0) {
    const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(illegal.map((c) => `"${c}"`))
    return { reason: 'illegal-char', detail: `${list} ${illegal.length === 1 ? 'is' : 'are'} not allowed in file names on Windows` }
  }

  // Windows silently strips a trailing dot or space when it creates the
  // directory, so `Smith. ` on disk becomes `Smith` — a mismatch the id on
  // screen never reveals until a teammate's checkout can't find the folder.
  if (/[. ]$/.test(id)) return { reason: 'trailing-dot-or-space', detail: 'a trailing dot or space is stripped by Windows, so the id would not match the folder it creates' }

  // Reserved even with an extension: `CON.json` still opens the CON device.
  const base = id.split('.')[0]
  if (RESERVED_NAMES.test(base)) {
    return { reason: 'reserved-name', detail: `"${base.toUpperCase()}" is a reserved device name on Windows` }
  }

  return null
}

/**
 * Do `a` and `b` name the same directory once the filesystem gets to decide,
 * even though they are different strings? Two hazards, both real in a shared
 * git repo: a case-insensitive checkout (Windows, default macOS) collapses
 * ids differing only in case, and macOS's HFS+/APFS normalises accented
 * characters to NFD while everywhere else keeps whatever the reviewer typed
 * (usually NFC) — so a manually typed accented id can be two directories on
 * one platform and one on another.
 */
export function paperIdsCollide(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() || a.normalize('NFC') === b.normalize('NFC')
}
