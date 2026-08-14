import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { GitPlatform, GitRun, GitStatus, BranchSwitchStart, GitBranch } from '../../git/types'
import type { SaveHandle } from '../../platform/adapter'

/**
 * A third integration test in the same real-components-real-git style as
 * annotationWorkflow/consolidationAndMerge, covering the one flow those
 * don't: switching branches with uncommitted changes that the target branch
 * also touched — a real stash-carry-over that lands as a real field-level
 * conflict, resolved through the same `GitMergeDialog` the explicit-merge
 * flow uses (see `MergeSource.kind: 'branch-switch'` in src/git/types.ts).
 */

let repoDir: string
let projectJsonPath: string
let mainBranch: string

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
  finishPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not exercised — see beginBranchSwitch' }),
  abortPull: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  headContent: async () => null,
  workingContent: async () => null,
  commitPartial: async () => ({ ok: false, code: null, stdout: '', stderr: 'not exercised — see headContent' }),
  writeWorking: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  branches: async (root): Promise<GitBranch[]> => {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)|%(HEAD)', 'refs/heads'], {
      cwd: root,
      encoding: 'utf8',
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, head] = line.split('|')
        return { name, current: head === '*', remote: false }
      })
  },
  createBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  deleteBranch: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  checkoutBranch: async (root, branch): Promise<GitRun> => {
    try {
      const stdout = execFileSync('git', ['checkout', branch, '--'], { cwd: root, encoding: 'utf8' })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; message: string }
      return { ok: false, code: e.status ?? null, stdout: '', stderr: e.message }
    }
  },
  // Mirrors electron/main.ts's real `git:branchSwitchBegin` handler: any
  // dirty path outside the project's own file is refused; otherwise reads
  // base/ours/theirs and stashes+checks out for real.
  beginBranchSwitch: async (root, relPath, branch): Promise<BranchSwitchStart> => {
    const st = await fakeGit.status(root)
    const outOfScope = st.changes.filter((c) => c.path !== relPath)
    if (outOfScope.length > 0) return { kind: 'other-files-dirty', paths: outOfScope.map((c) => c.path) }
    if (st.changes.length === 0) return { kind: 'no-changes' }
    const sourceBranch = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    if (!sourceBranch) return { kind: 'error', message: 'detached HEAD' }
    const oldHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const show = (rev: string) => {
      try {
        return execFileSync('git', ['show', `${rev}:${relPath}`], { cwd: root, encoding: 'utf8' })
      } catch {
        return null
      }
    }
    const base = show(oldHead)
    const ours = readFileSync(join(root, relPath), 'utf-8')
    const theirs = show(branch)
    if (theirs === null) return { kind: 'error', message: `"${relPath}" does not exist on branch "${branch}"` }
    try {
      execFileSync('git', ['stash', 'push', '-u', '-m', 'sailor: switching branch', '--', relPath], { cwd: root })
    } catch (err) {
      return { kind: 'error', message: String(err) }
    }
    try {
      execFileSync('git', ['checkout', branch, '--'], { cwd: root })
    } catch (err) {
      execFileSync('git', ['stash', 'pop'], { cwd: root })
      return { kind: 'error', message: String(err) }
    }
    return { kind: 'merge', sourceBranch, base, ours, theirs }
  },
  finishBranchSwitch: async (root, relPath, resolved): Promise<GitRun> => {
    writeFileSync(join(root, relPath), resolved.metaText)
    for (const f of resolved.files) {
      const target = join(root, 'annotations', f.relPath)
      if (f.text === null) {
        try {
          unlinkSync(target)
        } catch {
          // Nothing to delete — fine.
        }
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.text)
    }
    try {
      const stdout = execFileSync('git', ['stash', 'drop'], { cwd: root, encoding: 'utf8' })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; message: string }
      return { ok: false, code: e.status ?? null, stdout: '', stderr: e.message }
    }
  },
  abortBranchSwitch: async (root, sourceBranch): Promise<GitRun> => {
    try {
      execFileSync('git', ['checkout', sourceBranch, '--'], { cwd: root })
      const stdout = execFileSync('git', ['stash', 'pop'], { cwd: root, encoding: 'utf8' })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; message: string }
      return { ok: false, code: e.status ?? null, stdout: '', stderr: e.message }
    }
  },
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
  openRecent: async () => null,
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
const { BranchSwitchPrompt } = await import('../../components/BranchSwitchPrompt')
const { GitMergeDialog } = await import('../../components/GitMergeDialog')

const SCHEMA = [{ name: 'Study Type', type: 'string' as const }]

function baseProjectJson() {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA },
    papers: [{ id: 'p1', title: 'Fixture Paper', authors: [], pdf: 'p1.pdf', annotations: {} }],
  })
}

function loadFromDisk() {
  useStore.getState().loadFromText(readFileSync(projectJsonPath, 'utf-8'), { kind: 'electron', path: projectJsonPath }, 'project.json')
  useStore.getState().selectPaper('p1')
}

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-branchswitch-'))
  projectJsonPath = join(repoDir, 'project.json')
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'SaiLoR Integration Test'])
  writeFileSync(projectJsonPath, baseProjectJson())
  git(['add', '-A'])
  git(['commit', '-m', 'Initial commit'])
  mainBranch = git(['branch', '--show-current']).trim()

  // A second branch that committed a different answer to the same field —
  // the "theirs" side of the carry-over merge. Goes through the real
  // `save()` action (→ `serializeProject` → the mocked `saveProject`) rather
  // than hand-rolling JSON, so the on-disk shape matches what `loadProject`
  // actually expects.
  git(['checkout', '-b', 'other-branch'])
  loadFromDisk()
  useStore.getState().setFieldValue([], 'Study Type', 0, 'Cohort (on other-branch)')
  await useStore.getState().save()
  git(['add', '-A'])
  git(['commit', '-m', 'other-branch: Cohort'])
  git(['checkout', mainBranch])
  writeFileSync(projectJsonPath, baseProjectJson()) // restore main's committed content
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('branch switch carries uncommitted changes through a real conflict', () => {
  it('stashes, checks out, resolves the conflict, and lands the resolved content uncommitted on the target branch', async () => {
    const user = userEvent.setup()
    loadFromDisk()

    // An uncommitted edit on main, to the same field the other branch
    // committed differently — real, on-disk, unstashed dirty state.
    render(<AnnotationPanel />)
    const input = screen.getByRole('textbox', { name: 'Study Type' })
    await user.type(input, 'RCT (uncommitted on main)')
    cleanup()
    await useStore.getState().save()
    expect(git(['status', '--porcelain']).trim()).not.toBe('')

    await useGitStore.getState().refreshRepo({ kind: 'electron', path: projectJsonPath })
    await useGitStore.getState().openPanel()

    render(
      <>
        <GitDialog />
        <BranchSwitchPrompt />
        <GitMergeDialog />
      </>,
    )

    await user.selectOptions(screen.getByLabelText('Switch branch'), 'other-branch')
    await screen.findByText('Switch to "other-branch"?')
    await user.click(screen.getByRole('button', { name: 'Carry changes over' }))

    await screen.findByText('Resolve merge conflicts')
    await user.click(screen.getByTitle('Use your value')) // keep "RCT (uncommitted on main)"
    const finishBtn = screen.getByRole('button', { name: 'Finish merge' })
    expect(finishBtn).toBeEnabled()
    await user.click(finishBtn)

    await screen.findByText(/Switched to other-branch, carrying your changes over/)

    // Verify independently: really checked out, really stashed-then-dropped,
    // and the resolved content is on disk *uncommitted* (a branch switch
    // never commits — it hands the carried change to the new branch as an
    // ordinary working-tree edit).
    expect(git(['branch', '--show-current']).trim()).toBe('other-branch')
    expect(git(['stash', 'list']).trim()).toBe('')
    const committedFiles = git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n')
    const committedText = committedFiles.map((f) => git(['show', `HEAD:${f}`])).join('\n')
    expect(committedText).not.toContain('RCT (uncommitted on main)')
    // The resolved answer landed in a real working-tree file (project.json
    // and/or a per-paper annotations/ file finishBranchSwitch just wrote) —
    // read every real change/untracked path `git status` reports, not just
    // what's already committed.
    const changedPaths = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repoDir,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
      .map((line) => line.slice(3))
      .filter((p) => !p.endsWith('/'))
    const workingText = changedPaths.map((f) => readFileSync(join(repoDir, f), 'utf-8')).join('\n')
    expect(workingText).toContain('RCT (uncommitted on main)')
    expect(workingText).not.toContain('Cohort (on other-branch)')
  })
})
