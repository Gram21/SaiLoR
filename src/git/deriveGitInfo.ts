import type { GitRun } from './types'

export interface GitInfoInputs {
  top: GitRun
  prefix: GitRun
  head: GitRun
  branch: GitRun
  upstream: GitRun
}

export interface GitInfoResult {
  root: string
  relPath: string
  branch: string | null
  upstream: string | null
  hasHead: boolean
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
  return { root, relPath, branch, upstream, hasHead }
}
