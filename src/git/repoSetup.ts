/**
 * The `.gitattributes` and `.gitignore` rules a shared SaiLoR project needs,
 * and how to fold them into files a repository may already have.
 *
 * A review repository is a shared artefact, and two of its defaults are wrong
 * for this data in ways nobody notices until a teammate is affected:
 *
 *  - **Line endings.** Git for Windows commonly ships with `core.autocrlf`
 *    turned on, which rewrites every checked-out file to CRLF and back on
 *    commit. SaiLoR always writes `\n`, so one reviewer on Windows turns every
 *    save into a whole-file diff and every concurrent edit into a conflict,
 *    for no change in content at all.
 *  - **Merging.** Git's own line merge will happily combine two reviewers'
 *    edits to one annotation file into something *clean and wrong* — valid
 *    JSON that neither of them wrote. SaiLoR never uses that result (it
 *    re-derives the merge from the three revisions itself), but anyone running
 *    `git merge` or `git pull` in a terminal gets it, silently.
 *
 * And one `.gitignore` entry earns its place beyond tidiness: SaiLoR refuses
 * to merge while an untracked file sits in the `annotations/` folder (see
 * `mergeBlockingPaths`), so a single `.DS_Store` dropped there by the Finder
 * blocks every pull until somebody deletes it by hand.
 *
 * Both files are written **next to the project**, not at the repository root:
 * git applies a `.gitattributes` to its own directory and below, so this
 * scopes exactly to one project's tree and cannot stomp rules a root file sets
 * for everything else.
 *
 * Pure, and in `src/git/` rather than `electron/`, for the same reason
 * `ownAnnotationPath` and `relpath` are: it decides what gets written into
 * somebody's repository, and `electron/` is outside vitest's scope.
 */

/** Fences the block SaiLoR owns. Everything between them is replaced wholesale
 *  on an update; everything outside is the user's and is never touched. */
const BEGIN = '# >>> SaiLoR (managed) >>>'
const END = '# <<< SaiLoR (managed) <<<'

/** What goes between the fences in `.gitattributes`, next to the project. */
export const ATTRIBUTES_BODY = [
  '# Annotation data is JSON that SaiLoR rewrites in full on every save.',
  '#',
  "# eol=lf: git's Windows default (core.autocrlf) would rewrite every line on",
  '# checkout and back on commit, turning one reviewer on Windows into a source',
  '# of whole-file diffs and phantom conflicts for the whole team.',
  '#',
  "# -merge: git's line merge can combine two reviewers' answers into something",
  '# clean and wrong — valid JSON neither of them wrote. SaiLoR re-derives a',
  '# merge from the committed revisions instead, so it never reads that result;',
  '# this makes git conflict honestly for anyone merging outside the app.',
  '*.json text eol=lf -merge',
].join('\n')

/** What goes between the fences in `.gitignore`, next to the project. */
export const IGNORE_BODY = [
  '# Not just tidiness: SaiLoR refuses to merge while an untracked file sits in',
  '# the annotations/ folder, so one of these dropped there by the Finder or',
  '# Explorer blocks every pull until somebody deletes it by hand.',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '*~',
  '.*.swp',
].join('\n')

export interface ManagedFileUpdate {
  /** The full new contents. */
  text: string
  /** False when the file already said exactly this — nothing to write or commit. */
  changed: boolean
  /** True when the file already existed with content of its own, so the user
   *  should be asked before it is rewritten. */
  hadExisting: boolean
}

/**
 * Fold `body` into `existing` between SaiLoR's fences, leaving everything else
 * alone. Replaces a block that is already there rather than appending a second
 * one, so running this repeatedly converges instead of accumulating.
 *
 * `existing` is `null` when the file does not exist yet.
 */
export function applyManagedBlock(existing: string | null, body: string): ManagedFileUpdate {
  const block = `${BEGIN}\n${body}\n${END}`
  const hadExisting = existing !== null && existing.trim() !== ''

  if (existing === null || existing.trim() === '') {
    return { text: `${block}\n`, changed: true, hadExisting: false }
  }

  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + END.length)
    const text = `${before}${block}${after}`
    return { text, changed: text !== existing, hadExisting }
  }

  // No block yet: append, keeping the user's own rules first and above ours so
  // a later reader sees what was already theirs before what we added.
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  const text = `${existing}${separator}${block}\n`
  return { text, changed: true, hadExisting }
}

export interface RepoSetupPlan {
  attributes: ManagedFileUpdate
  ignore: ManagedFileUpdate
  /** Nothing to do — both files already say what they should. */
  upToDate: boolean
  /** Either file already had content of its own, so this is a change to
   *  something the team may have set up deliberately: ask first. */
  needsConsent: boolean
}

/** What setting this project's repository up would do, given what is there now. */
export function planRepoSetup(existingAttributes: string | null, existingIgnore: string | null): RepoSetupPlan {
  const attributes = applyManagedBlock(existingAttributes, ATTRIBUTES_BODY)
  const ignore = applyManagedBlock(existingIgnore, IGNORE_BODY)
  const changed = attributes.changed || ignore.changed
  return {
    attributes,
    ignore,
    upToDate: !changed,
    // Only worth asking about when there is both something to change and
    // something of the user's to change it around.
    needsConsent: changed && ((attributes.changed && attributes.hadExisting) || (ignore.changed && ignore.hadExisting)),
  }
}

/** The author recorded on the commit these rules arrive in. The committer
 *  stays whoever ran it — git does not let an application forge that, and it
 *  should not: the person whose repository this is did run the command. */
export const SETUP_AUTHOR = 'SaiLoR <noreply@sailor.invalid>'

export const SETUP_COMMIT_MESSAGE =
  'chore: configure git for SaiLoR annotation data\n\n' +
  'Normalises JSON to LF so a Windows checkout does not rewrite every line,\n' +
  'and stops git line-merging annotation files, which can combine two\n' +
  "reviewers' answers into something clean and wrong. Also ignores the OS\n" +
  'and editor droppings that would otherwise block a merge from inside\n' +
  'SaiLoR by sitting untracked in the annotations folder.'
