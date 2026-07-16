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

/** What to show when a git command failed. stderr first, because that is where
 *  git puts the reason; stdout only when it said nothing else. */
export function gitErrorText(run: GitRun): string {
  const stderr = run.stderr.trim()
  const stdout = run.stdout.trim()
  if (stderr) return stdout ? `${stderr}\n${stdout}` : stderr
  if (stdout) return stdout
  return run.code === null ? 'git could not be started.' : `git exited with code ${run.code}.`
}
