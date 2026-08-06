import type { GitFileChange, GitRun } from './types'

/**
 * Turning what git printed into data the UI can render — kept separate from
 * the plumbing that runs git (electron/main.ts) so it can be unit-tested
 * without spawning a process. The raw porcelain/diff text crosses IPC on
 * purpose, precisely so it lands here.
 */

/** A diff longer than this is cut: the panel is for seeing what changed, not
 *  for rendering a megabyte of it, and the DOM node is what would actually hurt. */
export const MAX_DIFF_CHARS = 200_000

export function capDiff(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_DIFF_CHARS), truncated: true }
}

export interface DiffLine {
  text: string
  kind: 'add' | 'remove' | 'context'
}

/**
 * Classify each line of a unified diff (`git diff --no-color`) for coloured
 * rendering. Not a bare `line.startsWith('+')` — that misreads an *added*
 * line whose own content starts with a literal `+` or `-` (`++counter;`,
 * `--verbose`) as removed/added the wrong way, and worse, misreads the
 * `+++ b/path`/`--- a/path` file-header pair as a content line the moment a
 * file's first change happens to start with the same three characters.
 *
 * The header pair only ever appears once per file, immediately before that
 * file's first `@@` hunk — so this tracks whether a hunk has started for the
 * *current* file (reset on every `diff --git`) and only reads `+`/`-` as
 * add/remove once inside one. Everything before the first hunk of a file
 * (`diff --git`, `index …`, the header pair) is `context`, and so is a
 * hunk's own ` `-prefixed lines and a trailing `\ No newline at end of file`.
 */
export function diffLines(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (inHunk && line.startsWith('+')) {
      out.push({ text: line, kind: 'add' })
      continue
    } else if (inHunk && line.startsWith('-')) {
      out.push({ text: line, kind: 'remove' })
      continue
    }
    out.push({ text: line, kind: 'context' })
  }
  return out
}

/** `X`/`Y` pair that `git status --porcelain` calls an unresolved merge conflict:
 *  either side is 'U', or both sides added/deleted the same path independently. */
function isUnmergedCode(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Defensive like every parser here: the input is whatever a git of unknown
 * version printed, so a short or malformed record is skipped rather than thrown
 * over. Records are NUL-terminated `XY<space><path>`; a rename or copy is two
 * records — the new path, then the original — which is why the loop consumes the
 * next record itself instead of iterating blindly.
 */
export function parsePorcelain(raw: string): GitFileChange[] {
  if (!raw) return []
  const records = raw.split('\0').filter((r) => r.length > 0)
  const out: GitFileChange[] = []

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue // too short to hold "XY<space><path>"
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue

    const isRename = code[0] === 'R' || code[0] === 'C'
    let from: string | undefined
    if (isRename) {
      // The original path is the *next* record, consumed here so it never
      // becomes a spurious row of its own.
      from = records[i + 1]
      i++
    }

    out.push({ path, code, unmerged: isUnmergedCode(code[0], code[1]), from })
  }
  return out
}

/** One entry from `git log`, for the history panel. */
export interface CommitRecord {
  hash: string
  /** ISO 8601 (`--date=iso-strict`) — the caller formats it for display. */
  date: string
  subject: string
}

/**
 * Parse `git log --format=%x00%H%x09%aI%x09%s`. Same shape as `parsePorcelain`
 * above: NUL-terminated records, defensive against a short or malformed one
 * (a subject that itself contains a tab or newline would otherwise desync the
 * fields, so this splits on only the first two tabs and takes everything
 * after as the subject verbatim, rather than a blind `.split('\t')`).
 */
export function parseGitLog(raw: string): CommitRecord[] {
  if (!raw) return []
  const records = raw.split('\0').filter((r) => r.length > 0)
  const out: CommitRecord[] = []

  for (const record of records) {
    const firstTab = record.indexOf('\t')
    if (firstTab === -1) continue
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue

    const hash = record.slice(0, firstTab)
    const date = record.slice(firstTab + 1, secondTab)
    const subject = record.slice(secondTab + 1)
    if (!hash) continue

    out.push({ hash, date, subject })
  }
  return out
}

/** What to show when a git command failed. stderr first, because that is where
 *  git puts the reason; stdout only when it said nothing else. */
export function gitErrorText(run: GitRun): string {
  const stderr = run.stderr.trim()
  const stdout = run.stdout.trim()
  if (stderr) return stdout ? `${stderr}\n${stdout}` : stderr
  if (stdout) return stdout
  return run.code === null ? 'git could not be started.' : `git exited with code ${run.code}.`
}
