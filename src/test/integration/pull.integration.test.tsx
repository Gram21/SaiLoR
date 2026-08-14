import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { GitPlatform, GitRun, GitStatus, PullStart, GitBranch } from '../../git/types'
import type { SaveHandle } from '../../platform/adapter'

/**
 * A fifth integration test in the same real-components-real-git style,
 * covering the flow the merge/branch-switch tests don't: a real `git pull`
 * against a real remote (a bare repo standing in for "origin"), diverged by
 * a genuine push from a second clone — same conflict/resolution UI as an
 * explicit merge (`beginPull` reuses `beginMergeInto` internally in
 * electron/main.ts, against `@{u}` instead of an explicit ref), driven
 * through `GitDialog`'s real "Pull" button.
 */

let originDir: string
let repoDir: string
let peerDir: string
let projectJsonPath: string

function git(args: string[], cwd = repoDir) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

const fakeGit: GitPlatform = {
  probe: async () => ({ available: true, version: git(['--version']).trim(), error: '' }),
  pickCloneDir: async () => null,
  clone: async () => ({ ok: false, error: 'not supported in this test' }),
  pickProjectIn: async () => null,
  info: async () => {
    const upstream = (() => {
      try {
        return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim() || null
      } catch {
        return null
      }
    })()
    return {
      root: repoDir,
      relPath: 'project.json',
      branch: git(['branch', '--show-current']).trim() || null,
      upstream,
      hasHead: true,
    }
  },
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
  // Mirrors electron/main.ts's real `git:pullBegin` handler: resolve `@{u}`,
  // refuse with `no-upstream` if there is none, else a real `git fetch`
  // followed by the same base/ours/theirs read + `merge --no-commit --no-ff`
  // `beginMerge` in the other tests already uses (against `ref` instead of
  // an explicit branch name).
  beginPull: async (root, relPath): Promise<PullStart> => {
    let ref: string
    try {
      ref = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, encoding: 'utf8' }).trim()
    } catch {
      const branch = (() => {
        try {
          return execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || null
        } catch {
          return null
        }
      })()
      return { kind: 'no-upstream', branch }
    }
    execFileSync('git', ['fetch'], { cwd: root })
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: root })
      return { kind: 'up-to-date' }
    } catch {
      // Divergent — proceed.
    }
    const base = execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' }).trim()
    const show = (rev: string) => {
      try {
        return execFileSync('git', ['show', `${rev}:${relPath}`], { cwd: root, encoding: 'utf8' })
      } catch {
        return null
      }
    }
    const baseText = show(base)
    const oursText = show('HEAD')
    const theirsText = show(ref)
    try {
      execFileSync('git', ['merge', '--no-commit', '--no-ff', ref], { cwd: root })
    } catch {
      // A real conflict makes `git merge` exit non-zero — expected here.
    }
    if (!existsSync(join(root, '.git', 'MERGE_HEAD'))) return { kind: 'error', message: 'merge did not start' }
    return { kind: 'merge', ref, base: baseText, ours: oursText!, theirs: theirsText! }
  },
  beginMerge: async () => ({ kind: 'up-to-date' }),
  logBegin: async () => ({ commits: [], truncated: false, error: null }),
  logDiff: async () => ({ kind: 'initial' }),
  finishPull: async (root, relPath, working): Promise<GitRun> => {
    writeFileSync(join(root, relPath), working.metaText)
    for (const f of working.files) {
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
      execFileSync('git', ['add', '-A'], { cwd: root })
      const stdout = execFileSync('git', ['commit', '--no-edit'], { cwd: root, encoding: 'utf8' })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message: string }
      return { ok: false, code: e.status ?? null, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? e.message }
    }
  },
  abortPull: async (root): Promise<GitRun> => {
    try {
      const stdout = execFileSync('git', ['merge', '--abort'], { cwd: root, encoding: 'utf8' })
      return { ok: true, code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; message: string }
      return { ok: false, code: e.status ?? null, stdout: '', stderr: e.message }
    }
  },
  headContent: async () => null,
  workingContent: async () => null,
  commitPartial: async () => ({ ok: false, code: null, stdout: '', stderr: 'not exercised — see headContent' }),
  writeWorking: async () => ({ ok: false, code: null, stdout: '', stderr: 'not supported in this test' }),
  branches: async (root): Promise<GitBranch[]> => {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)|%(HEAD)', 'refs/heads', 'refs/remotes'], {
      cwd: root,
      encoding: 'utf8',
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, head] = line.split('|')
        return { name, current: head === '*', remote: name.startsWith('origin/') }
      })
  },
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

beforeAll(() => {
  originDir = mkdtempSync(join(tmpdir(), 'sailor-integration-pull-origin-'))
  execFileSync('git', ['init', '--bare'], { cwd: originDir })

  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-pull-local-'))
  projectJsonPath = join(repoDir, 'project.json')
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'SaiLoR Integration Test'])
  writeFileSync(projectJsonPath, baseProjectJson())
  git(['add', '-A'])
  git(['commit', '-m', 'Initial commit'])
  const mainBranch = git(['branch', '--show-current']).trim()
  git(['remote', 'add', 'origin', originDir])
  git(['push', '-u', 'origin', mainBranch])

  // A second clone that pushes a diverging answer to the same field — the
  // "theirs" side of the pull's conflict.
  peerDir = mkdtempSync(join(tmpdir(), 'sailor-integration-pull-peer-'))
  execFileSync('git', ['clone', originDir, peerDir])
  execFileSync('git', ['config', 'user.email', 'peer@example.com'], { cwd: peerDir })
  execFileSync('git', ['config', 'user.name', 'Peer Reviewer'], { cwd: peerDir })
  const peerProjectPath = join(peerDir, 'project.json')
  writeFileSync(
    peerProjectPath,
    JSON.stringify({
      version: 1,
      config: { schema: SCHEMA },
      papers: [{ id: 'p1', title: 'Fixture Paper', authors: [], pdf: 'p1.pdf', annotations: { 'Study Type': [{ value: 'Cohort (pushed by peer)' }] } }],
    }),
  )
  execFileSync('git', ['add', '-A'], { cwd: peerDir })
  execFileSync('git', ['commit', '-m', 'Peer: Cohort'], { cwd: peerDir })
  execFileSync('git', ['push', 'origin', mainBranch], { cwd: peerDir })

  // Back in the local repo (never fetched since cloning/pushing the base
  // commit), commit a different answer to the same field — real divergence
  // from what's now on origin.
  loadFromDisk()
  useStore.getState().selectReviewer(null) // single-reviewer; no-op, kept for clarity
  useStore.getState().setFieldValue([], 'Study Type', 0, 'RCT (committed locally)')
})

afterAll(() => {
  rmSync(originDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(peerDir, { recursive: true, force: true })
})

describe('pull against a real remote resolves a real conflict', () => {
  it('fetches, conflicts on the same field, resolves through the real merge dialog, and commits locally', async () => {
    const user = userEvent.setup()

    render(<AnnotationPanel />)
    // (state was seeded directly in beforeAll — this render just proves the
    // seeded value actually reads back through the real component.)
    expect(screen.getByRole('textbox', { name: 'Study Type' })).toHaveValue('RCT (committed locally)')
    cleanup()

    await useStore.getState().save()
    git(['add', '-A'])
    git(['commit', '-m', 'Local: confirm RCT'])

    await useGitStore.getState().refreshRepo({ kind: 'electron', path: projectJsonPath })
    await useGitStore.getState().openPanel()
    expect(useGitStore.getState().repo?.upstream).toBe('origin/main')

    render(
      <>
        <GitDialog />
        <GitMergeDialog />
      </>,
    )

    const pullBtn = screen.getByRole('button', { name: 'Pull' })
    expect(pullBtn).toBeEnabled()
    await user.click(pullBtn)

    await screen.findByText('Resolve merge conflicts')
    await user.click(screen.getByTitle('Use your value')) // keep "RCT (committed locally)"
    const finishBtn = screen.getByRole('button', { name: 'Finish merge' })
    expect(finishBtn).toBeEnabled()
    await user.click(finishBtn)

    await screen.findByText(/Push when you are ready/)

    // Verify independently: a real two-parent merge commit against the
    // fetched remote branch, not yet pushed back.
    const parents = git(['log', '-1', '--format=%P']).trim().split(' ')
    expect(parents).toHaveLength(2)
    const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).trim()
    expect(Number(ahead)).toBeGreaterThan(0) // local is ahead — nothing auto-pushed
    const committedFiles = git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n')
    const committedText = committedFiles.map((f) => git(['show', `HEAD:${f}`])).join('\n')
    expect(committedText).toContain('RCT (committed locally)')
    expect(committedText).not.toContain('Cohort (pushed by peer)')
  })
})
