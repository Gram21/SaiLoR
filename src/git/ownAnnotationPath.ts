/**
 * Does a path under a project's `annotations/` folder belong to *this*
 * project, or to a sibling one sharing the same directory?
 *
 * `annotationsRelDir` (`src/git/relpath.ts`) derives the folder purely from
 * the project file's own directory — it says nothing about whether that
 * directory holds only this project's files. It routinely doesn't: SaiLoR's
 * own "Start full-text screening" flow deliberately saves a derived project
 * as a sibling JSON file next to the screening project it came from, and an
 * ad hoc "Save As" into an already-populated folder creates the same
 * situation by hand. Every git flow that treats "anything under
 * `annotations/`" as this project's own territory (a branch-switch stash, a
 * merge's conflict waiver) is a place a sibling's file gets silently
 * stashed, merged over, or deleted — see the callers of this module for the
 * specific bugs that were.
 *
 * Lives here rather than in `electron/main.ts` for the same reason
 * `relpath.ts`/`ref.ts`/`url.ts` do: `electron/` is outside vitest's
 * include, and a correctness-load-bearing check with no test coverage is one
 * nobody can change safely.
 *
 * `readProjectAtRevision` (`electron/main.ts`) already builds this exact
 * membership check inline, for a different purpose (reassembling a
 * revision's own annotation files off `git ls-tree` output) — this factors
 * it out for reuse rather than a third copy of the same regex.
 */

/**
 * Builds a predicate for "does this path, relative to the `annotations/`
 * folder (i.e. already stripped of the `<dir>/` prefix), belong to the
 * project described by `raw`?" — a raw, not-yet-validated parse of a
 * `project.json` (or the meta half of a split one; both put `papers` and
 * `config.screening` at the top level the same way). Matches
 * `splitProjectFiles`' own naming convention: `<paperId>/<name>.json`, where
 * `paperId` is one of `raw.papers[].id` and `name` is the consolidated file,
 * a numbered reviewer file, or a marks file for either — using the
 * `screening`/`reviewer` name family `raw.config.screening` selects, exactly
 * as `splitProjectFiles` writes them.
 *
 * Duck-typed rather than schema-validated on purpose: this only ever needs
 * to answer "does this filename shape, for one of these ids, belong to me",
 * and a project file that fails full `loadProject` validation for an
 * unrelated reason should not make every annotation path it might own
 * unrecognizable — the caller decides what to do when `raw` itself couldn't
 * be parsed at all (that is not this function's problem).
 */
export function ownAnnotationPathMatcher(raw: unknown): (relUnderDir: string) => boolean {
  const papers = (raw as { papers?: unknown[] } | null)?.papers
  const paperIds = new Set<string>()
  for (const p of Array.isArray(papers) ? papers : []) {
    const id = (p as { id?: unknown } | null)?.id
    if (typeof id === 'string') paperIds.add(id)
  }
  const screening = Boolean((raw as { config?: { screening?: unknown } } | null)?.config?.screening)
  const consolidatedName = screening ? 'screening-consolidated' : 'consolidated'
  const reviewerPrefix = screening ? 'screening' : 'reviewer'
  const re = new RegExp(
    `^([^/]+)\\/(?:${consolidatedName}|${reviewerPrefix}-\\d+|marks-consolidated|marks-\\d+)\\.json$`,
  )
  return (relUnderDir: string) => {
    const m = re.exec(relUnderDir)
    return !!m && paperIds.has(m[1])
  }
}
