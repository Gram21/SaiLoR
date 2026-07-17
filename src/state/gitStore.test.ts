import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { GitPlatform, GitRun, PullStart, GitFileChange } from '../git/types'
import { conflictId } from '../git/merge'

/**
 * `runPull`'s orchestration is the one place all the pieces of this feature
 * meet: the dirty guard, the pull classification, the parse boundary, the
 * merge, and the resolution dialog. The platform is stubbed (same shape as
 * `store.saveas.test.ts`), and `beginPullResult`/`finishPullResult` let each
 * test drive the fake git through exactly the branch it means to exercise.
 */

const SCHEMA = [{ name: 'Study Type', type: 'string' as const }]

function projectText(studyType: string | null): string {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [
      {
        id: 'a',
        title: 'Paper A',
        authors: [],
        pdf: 'a.pdf',
        annotations: { 'Study Type': [{ value: studyType }] },
      },
    ],
  })
}

function projectTextWithSchema(schema: unknown[]): string {
  return JSON.stringify({ version: 1, config: { schema }, papers: [] })
}

/** A project with one paper whose title (a paper-meta field, not bundled)
 *  is the only thing set — the minimal shape `detectFieldChanges` needs to
 *  report a genuine field-level change. */
function paperMetaText(title: string): string {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [{ id: 'a', title, authors: [], pdf: 'a.pdf', annotations: {} }],
  })
}

/** Varies both a paper-meta field (title) and an annotation field (Study
 *  Type) at once — the minimal shape for a partial-discard test, where one
 *  row is marked discard and the other is left at the default 'use'. */
function twoChangeText(title: string, studyType: string | null): string {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [
      {
        id: 'a',
        title,
        authors: [],
        pdf: 'a.pdf',
        annotations: { 'Study Type': [{ value: studyType }] },
      },
    ],
  })
}

const ok = (stdout = ''): GitRun => ({ ok: true, code: 0, stdout, stderr: '' })

let openedPaths: string[] = []
let abortCalls = 0
let finishCalls: { root: string; relPath: string; text: string }[] = []
let beginPullResult: PullStart = { kind: 'up-to-date' }
let finishPullResult: GitRun = ok()

let statusChanges: GitFileChange[] = []
let headContentResult: string | null = null
let workingContentResult: string | null = null
let commitPartialResult: GitRun = ok()
let commitPartialCalls: { root: string; relPath: string; committedText: string; workingText: string; otherPaths: string[]; message: string }[] = []
let commitCalls: { root: string; paths: string[]; message: string }[] = []
let writeWorkingResult: GitRun = ok()
let writeWorkingCalls: { root: string; relPath: string; text: string }[] = []

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: 'git 2.43.0', error: '' }),
  pickCloneDir: async () => null,
  clone: async () => ({ ok: false, error: 'not used here' }),
  pickProjectIn: async () => null,
  info: async () => null,
  status: async () => ({ changes: statusChanges, diff: '', diffTruncated: false }),
  commit: async (root, paths, message) => {
    commitCalls.push({ root, paths, message })
    return ok()
  },
  push: async () => ok(),
  beginPull: async () => beginPullResult,
  finishPull: async (root, relPath, text) => {
    finishCalls.push({ root, relPath, text })
    return finishPullResult
  },
  abortPull: async () => {
    abortCalls++
    return ok()
  },
  headContent: async () => headContentResult,
  workingContent: async () => workingContentResult,
  commitPartial: async (root, relPath, committedText, workingText, otherPaths, message) => {
    commitPartialCalls.push({ root, relPath, committedText, workingText, otherPaths, message })
    return commitPartialResult
  },
  writeWorking: async (root, relPath, text) => {
    writeWorkingCalls.push({ root, relPath, text })
    return writeWorkingResult
  },
}

const REPO = { root: '/repo', relPath: 'review.json', branch: 'main', upstream: 'origin/main', hasHead: true }

const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async (id: string) => {
    openedPaths.push(id)
    return { text: projectText('reloaded'), handle: { kind: 'electron' as const, path: id }, name: 'x.json' }
  },
  saveProject: async (_text: string, handle: SaveHandle) => handle,
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  pickPdfFolder: async () => [],
  pickReferenceFile: async () => null,
  relativePdfPaths: async () => [],
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => fakeGit,
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore } = await import('./store')
const { useGitStore } = await import('./gitStore')

beforeEach(async () => {
  openedPaths = []
  abortCalls = 0
  finishCalls = []
  finishPullResult = ok()
  statusChanges = []
  headContentResult = null
  workingContentResult = null
  commitPartialResult = ok()
  commitPartialCalls = []
  commitCalls = []
  writeWorkingResult = ok()
  writeWorkingCalls = []
  useStore.getState().loadFromText(projectText('mine'), { kind: 'electron', path: '/repo/review.json' }, 'review.json')
  useStore.setState({ dirty: false })
  useGitStore.setState({ probe: null, repo: { ...REPO }, clone: null, panel: null })
  await useGitStore.getState().openPanel()
})

describe('runPull', () => {
  it('up to date: a notice, no reload, no abort', async () => {
    beginPullResult = { kind: 'up-to-date' }
    await useGitStore.getState().runPull()
    expect(useGitStore.getState().panel?.notice).toMatch(/up to date/i)
    expect(openedPaths).toEqual([])
    expect(abortCalls).toBe(0)
  })

  it('dirty on disk: an error naming the paths, no abort', async () => {
    beginPullResult = { kind: 'dirty', paths: ['pdfs/a.pdf'] }
    await useGitStore.getState().runPull()
    expect(useGitStore.getState().panel?.error).toMatch(/pdfs\/a\.pdf/)
    expect(abortCalls).toBe(0)
  })

  it('no upstream: an error, no merge state', async () => {
    beginPullResult = { kind: 'no-upstream', branch: 'main' }
    await useGitStore.getState().runPull()
    const panel = useGitStore.getState().panel
    expect(panel?.error).toMatch(/no upstream/i)
    expect(panel?.merge).toBeNull()
  })

  it('fast-forward: the open project is re-opened', async () => {
    beginPullResult = { kind: 'fast-forwarded' }
    await useGitStore.getState().runPull()
    expect(openedPaths).toEqual(['/repo/review.json'])
    expect(useStore.getState().project?.papers[0].annotations['Study Type'][0].value).toBe('reloaded')
  })

  it('a conflict-free merge finishes on its own — finishPull is called, no dialog opens', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: projectText(null), // unchanged on theirs' side — no conflict
    }
    await useGitStore.getState().runPull()
    expect(finishCalls).toHaveLength(1)
    const written = JSON.parse(finishCalls[0].text) as { papers: { annotations: Record<string, { value: unknown }[]> }[] }
    expect(written.papers[0].annotations['Study Type'][0].value).toBe('mine')
    expect(useGitStore.getState().panel?.merge).toBeNull()
  })

  it('a real conflict opens the resolution dialog — finishPull is not yet called', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: projectText('theirs'),
    }
    await useGitStore.getState().runPull()
    const merge = useGitStore.getState().panel?.merge
    expect(merge).not.toBeNull()
    expect(merge?.conflicts).toHaveLength(1)
    expect(finishCalls).toHaveLength(0)
  })

  it('mergeProjects refusing a re-shaping change aborts the merge and names it', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectTextWithSchema(SCHEMA),
      ours: projectTextWithSchema([...SCHEMA, { name: 'Extra X', type: 'string' }]),
      theirs: projectTextWithSchema([...SCHEMA, { name: 'Extra Y', type: 'string' }]),
    }
    await useGitStore.getState().runPull()
    expect(abortCalls).toBe(1)
    expect(useGitStore.getState().panel?.error).toMatch(/schema/i)
    expect(finishCalls).toHaveLength(0)
  })

  it('an unparseable revision aborts the merge and writes nothing', async () => {
    beginPullResult = {
      kind: 'merge',
      ref: 'origin/main',
      base: projectText(null),
      ours: projectText('mine'),
      theirs: 'not valid json at all',
    }
    await useGitStore.getState().runPull()
    expect(abortCalls).toBe(1)
    expect(finishCalls).toHaveLength(0)
    expect(useGitStore.getState().panel?.error).toMatch(/origin\/main/)
  })

  it('refuses to run at all while the project has unsaved changes', async () => {
    useStore.setState({ dirty: true })
    let called = false
    beginPullResult = { kind: 'up-to-date' } // would flip `called` if reached
    const originalBeginPull = fakeGit.beginPull
    fakeGit.beginPull = async (...args) => {
      called = true
      return originalBeginPull(...args)
    }
    await useGitStore.getState().runPull()
    fakeGit.beginPull = originalBeginPull
    expect(called).toBe(false)
    expect(useGitStore.getState().panel?.error).toMatch(/save the project/i)
  })
})

/**
 * `refreshFieldReview`'s branches — whether the open project's own file ends
 * up reviewed field by field, or falls back to the plain file-level
 * checkbox `panel.selected` already handles for every other changed file.
 */
describe('refreshFieldReview (via refreshStatus)', () => {
  it('the project file is untracked (no HEAD revision) — fieldReview stays null', async () => {
    statusChanges = [{ path: 'review.json', code: '??', unmerged: false }]
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
  })

  it('a revision fails to read — fieldReview stays null, no error surfaced', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = null
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
    expect(useGitStore.getState().panel?.error).toBeNull()
  })

  it('an unparseable revision — fieldReview stays null, no error surfaced', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = 'not valid json at all'
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
    expect(useGitStore.getState().panel?.error).toBeNull()
  })

  it('a structural difference — fieldReview stays null, falls back to the file checkbox', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = projectTextWithSchema(SCHEMA)
    workingContentResult = projectTextWithSchema([...SCHEMA, { name: 'Extra X', type: 'string' }])
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
  })

  it('both revisions parse identically — fieldReview stays null', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Same Title')
    workingContentResult = paperMetaText('Same Title')
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
  })

  it('a genuine field-level change is detected, defaults to "use", and clears the file checkbox', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
    const review = useGitStore.getState().panel?.fieldReview
    expect(review).toBeTruthy()
    expect(review?.changes.fields).toHaveLength(1)
    const fc = review!.changes.fields[0]
    expect(fc.canonical).toBe('title')
    expect(fc.headValue).toBe('Old Title')
    expect(fc.workingValue).toBe('New Title')
    // Absent from `decisions` means 'use' — no entry is written until the
    // reviewer actually touches the row.
    expect(review?.decisions[fc.id]).toBeUndefined()
    expect(useGitStore.getState().panel?.selected['review.json']).toBeUndefined()
  })

  it('a decision survives a refresh that leaves the same field changed', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
    const id = useGitStore.getState().panel!.fieldReview!.changes.fields[0].id
    useGitStore.getState().setFieldDisposition(id, 'ignore')

    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview?.decisions[id]).toBe('ignore')
  })

  it('a decision for a field no longer changed is dropped on refresh', async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
    const id = useGitStore.getState().panel!.fieldReview!.changes.fields[0].id
    useGitStore.getState().setFieldDisposition(id, 'discard')

    // The working copy now matches HEAD again — the field is no longer changed.
    workingContentResult = paperMetaText('Old Title')
    await useGitStore.getState().refreshStatus()
    expect(useGitStore.getState().panel?.fieldReview).toBeNull()
  })
})

describe('setFieldDisposition / setAllFieldDispositions', () => {
  beforeEach(async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
  })

  it('setFieldDisposition sets one row without touching others', () => {
    const id = conflictId('a', { kind: 'paper' }, 'title')
    useGitStore.getState().setFieldDisposition(id, 'discard')
    expect(useGitStore.getState().panel?.fieldReview?.decisions[id]).toBe('discard')
  })

  it('setAllFieldDispositions sets every field and paper row at once', () => {
    useGitStore.getState().setAllFieldDispositions('ignore')
    const review = useGitStore.getState().panel!.fieldReview!
    for (const f of review.changes.fields) expect(review.decisions[f.id]).toBe('ignore')
    for (const p of review.changes.papers) expect(review.decisions[p.id]).toBe('ignore')
  })
})

describe('runCommit — field review (commitPartial)', () => {
  beforeEach(async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
    useGitStore.getState().setCommitMessage('Update title')
  })

  it('composes committed/working content and calls commitPartial, not the whole-file commit', async () => {
    await useGitStore.getState().runCommit()
    expect(commitCalls).toHaveLength(0)
    expect(commitPartialCalls).toHaveLength(1)
    const call = commitPartialCalls[0]
    expect(call.root).toBe('/repo')
    expect(call.relPath).toBe('review.json')
    expect(call.message).toBe('Update title')
    const committed = JSON.parse(call.committedText) as { papers: { title: string }[] }
    // The default disposition is 'use', so the committed content picks up
    // the working tree's new title.
    expect(committed.papers[0].title).toBe('New Title')
  })

  it('reloads the open project on success, since a "discard" may have rewritten the working file', async () => {
    await useGitStore.getState().runCommit()
    expect(openedPaths).toEqual(['/repo/review.json'])
    expect(useGitStore.getState().panel?.notice).toBe('Committed.')
  })

  it('a failed commitPartial surfaces the error and does not reload', async () => {
    commitPartialResult = { ok: false, code: 1, stdout: '', stderr: 'commit failed' }
    await useGitStore.getState().runCommit()
    expect(openedPaths).toEqual([])
    expect(useGitStore.getState().panel?.error).toMatch(/commit failed/)
    expect(useGitStore.getState().panel?.phase).toBe('idle')
  })

  it('a "discard" decision writes HEAD\'s value back into the working-tree output', async () => {
    const id = conflictId('a', { kind: 'paper' }, 'title')
    useGitStore.getState().setFieldDisposition(id, 'discard')
    await useGitStore.getState().runCommit()
    const call = commitPartialCalls[0]
    const committed = JSON.parse(call.committedText) as { papers: { title: string }[] }
    const workingOut = JSON.parse(call.workingText) as { papers: { title: string }[] }
    // Discarded: the commit still keeps HEAD's value, and the working file is
    // rewritten to match it too — the local edit is erased.
    expect(committed.papers[0].title).toBe('Old Title')
    expect(workingOut.papers[0].title).toBe('Old Title')
  })
})

describe('runDiscard — field review (writeWorking)', () => {
  beforeEach(async () => {
    statusChanges = [{ path: 'review.json', code: ' M', unmerged: false }]
    headContentResult = paperMetaText('Old Title')
    workingContentResult = paperMetaText('New Title')
    await useGitStore.getState().refreshStatus()
  })

  it('composes workingOut and writes it via writeWorking, without committing', async () => {
    const id = conflictId('a', { kind: 'paper' }, 'title')
    useGitStore.getState().setFieldDisposition(id, 'discard')
    await useGitStore.getState().runDiscard()

    expect(commitCalls).toHaveLength(0)
    expect(commitPartialCalls).toHaveLength(0)
    expect(writeWorkingCalls).toHaveLength(1)
    const call = writeWorkingCalls[0]
    expect(call.root).toBe('/repo')
    expect(call.relPath).toBe('review.json')
    const written = JSON.parse(call.text) as { papers: { title: string }[] }
    // Discarded: the working file is rewritten back to HEAD's value.
    expect(written.papers[0].title).toBe('Old Title')
  })

  it('reloads the open project on success', async () => {
    const id = conflictId('a', { kind: 'paper' }, 'title')
    useGitStore.getState().setFieldDisposition(id, 'discard')
    await useGitStore.getState().runDiscard()

    expect(openedPaths).toEqual(['/repo/review.json'])
    expect(useGitStore.getState().panel?.notice).toBe('Reverted the discarded changes. Nothing was committed.')
  })

  it('a failed writeWorking surfaces the error and does not reload', async () => {
    writeWorkingResult = { ok: false, code: null, stdout: '', stderr: 'disk full' }
    const id = conflictId('a', { kind: 'paper' }, 'title')
    useGitStore.getState().setFieldDisposition(id, 'discard')
    await useGitStore.getState().runDiscard()

    expect(openedPaths).toEqual([])
    expect(useGitStore.getState().panel?.error).toMatch(/disk full/)
    expect(useGitStore.getState().panel?.phase).toBe('idle')
  })

  it('a partial discard reverts only the marked rows, leaving the rest at the working value', async () => {
    headContentResult = twoChangeText('Old Title', 'A')
    workingContentResult = twoChangeText('New Title', 'B')
    await useGitStore.getState().refreshStatus()

    const review = useGitStore.getState().panel!.fieldReview!
    const titleField = review.changes.fields.find((f) => f.canonical === 'title')!
    // Only the title row is marked discard; the Study Type row is left at
    // its default 'use'.
    useGitStore.getState().setFieldDisposition(titleField.id, 'discard')
    await useGitStore.getState().runDiscard()

    const call = writeWorkingCalls[0]
    const written = JSON.parse(call.text) as {
      papers: { title: string; annotations: { 'Study Type': { value: string }[] } }[]
    }
    expect(written.papers[0].title).toBe('Old Title') // reverted
    expect(written.papers[0].annotations['Study Type'][0].value).toBe('B') // kept
  })

  it('is a no-op when nothing is marked discard', async () => {
    await useGitStore.getState().runDiscard()

    expect(writeWorkingCalls).toHaveLength(0)
    expect(openedPaths).toEqual([])
    expect(useGitStore.getState().panel?.notice).toBeNull()
  })
})
