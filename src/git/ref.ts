/**
 * Is this string safe to hand to git as a ref (a branch name, local or
 * remote-tracking)?
 *
 * Lives here rather than in `electron/main.ts` for the same reason `url.ts` and
 * `relpath.ts` do: it is a security gate on input that reaches a spawned
 * process, so it is written once, imported by the main process, and — unlike
 * anything inside `electron/` — reachable by the test suite.
 *
 * The refs the merge picker offers are names `git for-each-ref` itself
 * produced, so in practice this only ever rejects a value that did not come
 * from there. That is exactly why it is cheap to keep: it is the check that
 * makes "the renderer never chooses argv" true even if it one day does.
 *
 * This is a check on the string alone. Whether the ref actually *exists* is
 * `git rev-parse --verify`'s job in the main process, and the other half of
 * the guard.
 */

/** Reasons a ref is refused, for the caller's error message. */
export type RefProblem = 'empty' | 'option-like' | 'control-char' | 'bad-syntax'

/** Control characters and DEL — never legitimate in a ref, and a newline would
 *  additionally corrupt any line-delimited git output the name is spliced into.
 *  Written as a code-point test rather than a character class so the literal
 *  characters never have to appear in this file. */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * `null` when `ref` is acceptable, otherwise why it is not. The syntax rules
 * are the subset of git's own `check-ref-format` that is cheap to state; what
 * is omitted is rejected anyway by the "no component starts with a dot" and
 * revision-syntax checks below, or by git itself.
 */
export function refProblem(ref: string): RefProblem | null {
  if (!ref) return 'empty'
  // A ref starting with "-" would be read as an option — `execFile`'s argument
  // array stops shell interpretation, not git's own argument parsing.
  if (ref.startsWith('-')) return 'option-like'
  if (hasControlChar(ref)) return 'control-char'

  // Revision syntax, plus the characters `check-ref-format` forbids outright.
  // `..`, `~`, `^`, `:` and `@{` are the dangerous ones: they turn a name into
  // a *different* commit ("main^", "main..other", "main:path", "main@{1}").
  if (/[\s~^:?*[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) return 'bad-syntax'
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) return 'bad-syntax'
  if (ref.endsWith('.')) return 'bad-syntax'
  // No path component may begin with a dot or end in ".lock" — git rejects
  // both at every level, not only in the last one.
  if (ref.split('/').some((seg) => seg === '' || seg.startsWith('.') || seg.endsWith('.lock'))) {
    return 'bad-syntax'
  }
  return null
}

/** True when `ref` is safe to pass to git as a branch name. */
export function isSafeRef(ref: string): boolean {
  return refProblem(ref) === null
}
