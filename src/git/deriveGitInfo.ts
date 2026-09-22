import type { GitRun } from './types'

export interface GitInfoInputs {
  top: GitRun
  prefix: GitRun
  head: GitRun
  branch: GitRun
  upstream: GitRun
  behind: GitRun
}

export interface GitInfoResult {
  root: string
  relPath: string
  branch: string | null
  upstream: string | null
  hasHead: boolean
  /**
   * Commits the upstream has that this branch does not — `rev-list --count
   * HEAD..@{u}`, so **as of the last fetch**, never a live answer. Null when
   * there is no upstream or the count could not be read.
   *
   * Enough for the one thing it is used for: warning, before a destructive
   * schema edit, that somebody else's work is already known to be waiting.
   * A truthful "are you up to date" would have to fetch, and making a network
   * call out of opening a project — or out of renaming a field — is not worth
   * it for a warning that only ever needs to say "there is known to be more".
   * A zero therefore means "nothing known", not "nothing there".
   */
  behind: number | null
}

const out = (r: GitRun): string => r.stdout.trim()

/**
 * Derives `git:info`'s result fields from the outputs of its five
 * independent `git` calls (`electron/main.ts`'s `git:info` handler runs them
 * concurrently via `Promise.all` rather than one at a time, since none of
 * `--show-toplevel`/`--show-prefix`/HEAD-verify/current-branch/upstream
 * depends on any of the others). Extracted into its own pure function purely
 * for testability — `electron/` sits outside vitest's test scope — and to
 * pin down exactly which input feeds which field: a `Promise.all` array
 * destructured into five differently-named variables is exactly the kind of
 * place a copy-paste reordering could silently swap two fields with no type
 * error to catch it.
 */
export function deriveGitInfo(projectBaseName: string, inputs: GitInfoInputs): GitInfoResult {
  const root = out(inputs.top)
  const prefix = out(inputs.prefix)
  const relPath = prefix + projectBaseName
  const hasHead = inputs.head.ok
  const branch = inputs.branch.ok ? out(inputs.branch) || null : null
  const upstream = inputs.upstream.ok ? out(inputs.upstream) || null : null
  const behindCount = inputs.behind.ok ? Number(out(inputs.behind)) : NaN
  const behind = upstream && Number.isInteger(behindCount) && behindCount >= 0 ? behindCount : null
  return { root, relPath, branch, upstream, hasHead, behind }
}
