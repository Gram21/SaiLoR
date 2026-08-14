import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitPlatform, GitRun, GitStatus } from '../../git/types'
import type { SaveHandle } from '../../platform/adapter'

/**
 * A sixth integration test, same real-components-real-git style as the
 * others — covers the one GitDialog action none of the merge/pull/branch-
 * switch tests exercise: discarding an uncommitted field-level change back
 * to its last-committed value, via the real field review's "Discard"
 * disposition + "Discard all" button. Unlike a commit, this never touches
 * git history at all — `runDiscard` calls `writeWorking`, not `commit` — so
 * this is also the first test where `headContent`/`workingContent` are
 * implemented for real rather than stubbed to `null` (which is what forces
 * the *other* tests onto the simpler whole-file commit path instead of
 * field review).
 */

let repoDir: string
let projectJsonPath: string

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
}

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: git(['--version']).trim(), error: '' }),
  pickCloneDir: async () => null,
  clone: async () => ({ ok: false, error: 'not supported in this test' }),
  pickProjectIn: async () => null,
  info: async () => ({
    root: repoDir,
    relPath: 'project.json',
    branch: git(['branch', '--show-current']).trim() || null,
    upstream: null,
    hasHead: true,
  }),
  status: async (root): Promise<GitStatus> => {
    const { parsePorcelain, capDiff } = await import('../../git/output')
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8' })
    const diffRaw = execFileSync('git', ['diff', 'HEAD', '--'], { cwd: root, encoding: 'utf8' })
    const { text, truncated } = capDiff(diffRaw)
    return { changes: parsePorcelain(porcelain), diff: text, diffTruncated: truncated }
  },
  commit: async (root, paths, message, amend): Promise<GitRun> => {
    try {
      execFileSync('git', ['add', ...(paths.length > 0 ? paths : ['-A'])], { cwd: root })
      const stdout = execFileSync('git', ['commit', ...(amend ? ['--amend'] : []), '-m', message], {
        cwd: root,
        encoding: 'utf8',
      })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message: string }
      return { ok: false, code: e.status ?? null, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? e.message }
    }
  },
  lastCommitMessage: async () => null,
  push: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  beginPull: async () => ({ kind: 'no-upstream', branch: null }),
  beginMerge: async () => ({ kind: 'up-to-date' }),
  logBegin: async () => ({ commits: [], truncated: false, error: null }),
  logDiff: async () => ({ kind: 'initial' }),
  finishPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  abortPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  // Real, this time — the project stays in the legacy single-file shape
  // throughout this test (annotations inline in project.json, no split
  // annotations/ files), so a plain `git show`/disk read is the whole of
  // what the real `headContent`/`workingContent` would reassemble anyway.
  headContent: async (root, relPath) => {
    try {
      return execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: root, encoding: 'utf8' })
    } catch {
      return null
    }
  },
  workingContent: async (root, relPath) => {
    try {
      return readFileSync(join(root, relPath), 'utf-8')
    } catch {
      return null
    }
  },
  commitPartial: async () => ({ ok: false, code: null, stdout: '', stderr: 'not exercised — see writeWorking' }),
  // The one method this test actually needs for real: reverts the working
  // file to the composed (discarded) content, without staging or committing.
  // `working` arrives as the split-file shape (meta-only `metaText` plus one
  // file per paper's actual answers) — reassembled back into this test's
  // legacy single-file convention via the same `assembleLegacyProjectJson`
  // the real app uses for exactly this, so the written project.json stays
  // byte-comparable with what's already committed (a real save always
  // writes the split shape on disk; a test that mixed the two would see a
  // spurious diff on every field that was never actually touched).
  writeWorking: async (root, relPath, working): Promise<GitRun> => {
    try {
      const { assembleLegacyProjectJson } = await import('../../model/project')
      const meta = JSON.parse(working.metaText) as unknown
      const paperFiles = new Map<string, { consolidated?: unknown; reviewers: Map<string, unknown>; reviewMarks: Map<string, unknown> }>()
      for (const f of working.files) {
        const [paperId, fileName] = f.relPath.split('/')
        if (fileName !== 'consolidated.json' || f.text === null) continue
        paperFiles.set(paperId, { consolidated: JSON.parse(f.text), reviewers: new Map(), reviewMarks: new Map() })
      }
      const legacy = assembleLegacyProjectJson(meta, paperFiles)
      writeFileSync(join(root, relPath), JSON.stringify(legacy, null, 2))
      return { ok: true, code: 0, stdout: '', stderr: '' }
    } catch (err) {
      return { ok: false, code: null, stdout: '', stderr: String(err) }
    }
  },
  branches: async () => [],
  createBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  deleteBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  checkoutBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  beginBranchSwitch: async () => ({ kind: 'error', message: 'not supported in this test' }),
  finishBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  abortBranchSwitch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  discardFile: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
}

const fakePlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (entries: unknown) => entries,
  openProject: async () => null,
  // `resyncProjectFromDisk` (store.ts) reads through `openRecent(handle.path)`
  // after a discard rewrites the working file — real here, for the same
  // reason `saveProject` is real elsewhere: the resync has to see what was
  // actually just written to disk, not a stub's idea of it.
  openRecent: async (id: string) => ({
    text: readFileSync(id, 'utf-8'),
    handle: { kind: 'electron' as const, path: id },
    name: 'project.json',
  }),
  saveProject: async (text: string, handle: SaveHandle) => {
    writeFileSync(handle.path!, text)
    return handle
  },
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: 'blob:fake-pdf-source' }),
  needsPdfFolderGrant: () => false,
  grantPdfFolderAccess: async () => {},
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  getGit: () => fakeGit,
}

vi.mock('../../platform', () => ({ getPlatform: () => fakePlatform }))

const { useStore } = await import('../../state/store')
const { useGitStore } = await import('../../state/gitStore')
const { AnnotationPanel } = await import('../../components/AnnotationPanel')
const { GitDialog } = await import('../../components/GitDialog')

const SCHEMA = [{ name: 'Study Type', type: 'string' as const }]

function projectJson(studyType: string) {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [{ id: 'p1', title: 'Fixture Paper', authors: [], pdf: 'p1.pdf', annotations: { 'Study Type': [{ value: studyType }] } }],
  })
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-discard-'))
  projectJsonPath = join(repoDir, 'project.json')
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'SaiLoR Integration Test'])
  writeFileSync(projectJsonPath, projectJson('RCT'))
  git(['add', '-A'])
  git(['commit', '-m', 'Initial: RCT'])
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('discarding a field-level change reverts it without committing', () => {
  it('discards through the real field review, writing the reverted content but no commit', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    useStore.getState().loadFromText(readFileSync(projectJsonPath, 'utf-8'), { kind: 'electron', path: projectJsonPath }, 'project.json')
    useStore.getState().selectPaper('p1')

    render(<AnnotationPanel />)
    const input = screen.getByRole('textbox', { name: 'Study Type' })
    await user.clear(input)
    await user.type(input, 'RCT-updated')
    cleanup()
    await useStore.getState().save()
    expect(readFileSync(projectJsonPath, 'utf-8')).toContain('RCT-updated')

    await useGitStore.getState().refreshRepo({ kind: 'electron', path: projectJsonPath })
    await useGitStore.getState().openPanel()
    // Real `headContent`/`workingContent` (unlike the other integration
    // tests) let `refreshFieldReview` actually detect the change and
    // populate field review — proving the fake wiring, not assuming it.
    expect(useGitStore.getState().panel?.fieldReview?.changes.fields).toHaveLength(1)
    expect(useGitStore.getState().panel?.fieldReview?.changes.fields[0]).toMatchObject({
      headValue: 'RCT',
      workingValue: 'RCT-updated',
    })

    render(<GitDialog />)
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    // Two buttons share this text: the bulk-disposition "Discard all" (sets
    // every row to Discard) and the primary action button, which adopts
    // this same label once every row already is (`discardOnlyMode`) — the
    // primary one is the one with `.danger`, and the one this test means.
    const discardAllBtn = screen.getAllByRole('button', { name: 'Discard all' }).find((b) => b.className.includes('danger'))!
    expect(discardAllBtn).toBeInTheDocument()
    await user.click(discardAllBtn)

    await screen.findByText('Reverted the discarded changes. Nothing was committed.')

    // Verify independently: the working file reverted to "RCT" and nothing
    // was committed. Parsed, not a raw string match — `writeWorking`
    // reassembles the split shape `composeContents` produced back into this
    // test's single-file convention, which need not be byte-identical to
    // the original save's formatting to be the same *value*.
    const onDisk = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
      papers: Array<{ annotations: Record<string, Array<{ value: string }>> }>
    }
    expect(onDisk.papers[0].annotations['Study Type'][0].value).toBe('RCT')
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('Initial: RCT') // no new commit

    // The in-memory project resynced from disk too, not just the file.
    const paper = useStore.getState().project?.papers.find((p) => p.id === 'p1')
    expect(paper?.annotations['Study Type']?.[0]?.value).toBe('RCT')
  })
})
