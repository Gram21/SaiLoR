import '@testing-library/jest-dom/vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { GitPlatform, GitRun, GitStatus, MergeStart, GitBranch } from '../../git/types'
import type { SaveHandle } from '../../platform/adapter'

/**
 * A second integration test in the same style as annotationWorkflow — real
 * components, real DOM events, a real scratch git repo — covering the two
 * flows that one doesn't: (1) two independent reviewer seats disagreeing,
 * reconciled through the real Consolidation compare popup, and (2) a real
 * three-way merge that produces a genuine field-level conflict (both
 * branches changed the same reviewer's own answer, to different values),
 * resolved through the real merge dialog and landed as a real commit.
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
  // Mirrors electron/main.ts's `beginMergeInto`: read base/ours/theirs via
  // `git show <rev>:<relPath>` (from git's objects, not the conflicted
  // working file), then start a real `git merge --no-commit --no-ff`.
  beginMerge: async (root, relPath, ref): Promise<MergeStart> => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: root })
      return { kind: 'up-to-date' }
    } catch {
      // Not an ancestor — divergent, proceed to a real merge attempt.
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
  logBegin: async () => ({ commits: [], truncated: false, error: null }),
  logDiff: async () => ({ kind: 'initial' }),
  // Writes the resolved content and finishes the real, already-in-progress
  // `git merge` with a real commit — the merge counterpart to `commit` above.
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
const { ConsolidationDialog } = await import('../../components/ConsolidationDialog')
const { GitDialog } = await import('../../components/GitDialog')
const { MergeBranchPrompt } = await import('../../components/MergeBranchPrompt')
const { GitMergeDialog } = await import('../../components/GitMergeDialog')

const SCHEMA = [{ name: 'Study Type', type: 'string' as const }]

function baseProjectJson() {
  return JSON.stringify({
    version: 1,
    config: { schema: SCHEMA, reviewers: 2 },
    papers: [{ id: 'p1', title: 'Fixture Paper', authors: [], pdf: 'p1.pdf', annotations: {}, reviews: {} }],
  })
}

function loadFromDisk() {
  useStore.getState().loadFromText(readFileSync(projectJsonPath, 'utf-8'), { kind: 'electron', path: projectJsonPath }, 'project.json')
  useStore.getState().selectPaper('p1')
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'sailor-integration-merge-'))
  projectJsonPath = join(repoDir, 'project.json')
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'SaiLoR Integration Test'])
  writeFileSync(projectJsonPath, baseProjectJson())
  git(['add', '-A'])
  git(['commit', '-m', 'Initial commit'])
  mainBranch = git(['branch', '--show-current']).trim()
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('multi-reviewer consolidation and a real merge conflict', () => {
  it('reconciles disagreeing reviewers, then resolves a real git merge conflict', async () => {
    const user = userEvent.setup()
    loadFromDisk()

    // ---- Phase 1: two reviewers disagree, Consolidation reconciles --------
    useStore.getState().selectReviewer('1')
    render(<AnnotationPanel />)
    await user.type(screen.getByRole('textbox', { name: 'Study Type' }), 'RCT')
    cleanup()

    useStore.getState().selectReviewer('2')
    render(<AnnotationPanel />)
    await user.type(screen.getByRole('textbox', { name: 'Study Type' }), 'Case-control')
    cleanup()

    useStore.getState().selectReviewer('consolidation')
    render(
      <>
        <AnnotationPanel />
        <ConsolidationDialog />
      </>,
    )
    const compareBtn = screen.getByTitle("Compare every reviewer's answer for this field")
    expect(compareBtn).toBeEnabled() // both reviewers have answered — see readyToConsolidate
    await user.click(compareBtn)
    await user.click(await screen.findByTitle("Take Reviewer 1's answer into the consolidated result"))

    const paperAfterConsolidation = useStore.getState().project?.papers.find((p) => p.id === 'p1')
    expect(paperAfterConsolidation?.annotations['Study Type']?.[0]?.value).toBe('RCT')
    cleanup()

    await useStore.getState().save()
    git(['add', '-A'])
    git(['commit', '-m', 'Consolidate: adopt Reviewer 1 (RCT)'])
    git(['branch', 'feature-b'])

    // ---- Phase 2: the same reviewer's own answer diverges on two branches -
    useStore.getState().selectReviewer('1')
    render(<AnnotationPanel />)
    const mainInput = screen.getByRole('textbox', { name: 'Study Type' })
    await user.clear(mainInput)
    await user.type(mainInput, 'RCT (confirmed)')
    cleanup()
    await useStore.getState().save()
    git(['add', '-A'])
    git(['commit', '-m', `Reviewer 1: confirm on ${mainBranch}`])

    git(['checkout', 'feature-b'])
    loadFromDisk()
    useStore.getState().selectReviewer('1')
    render(<AnnotationPanel />)
    const branchInput = screen.getByRole('textbox', { name: 'Study Type' })
    await user.clear(branchInput)
    await user.type(branchInput, 'Cohort (relabeled)')
    cleanup()
    await useStore.getState().save()
    git(['add', '-A'])
    git(['commit', '-m', 'Reviewer 1: relabel on feature-b'])

    git(['checkout', mainBranch])
    loadFromDisk()

    // ---- Phase 3: merge feature-b through the real Git panel --------------
    await useGitStore.getState().refreshRepo({ kind: 'electron', path: projectJsonPath })
    await useGitStore.getState().openPanel()

    render(
      <>
        <GitDialog />
        <MergeBranchPrompt />
        <GitMergeDialog />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Merge branch…' }))
    await user.selectOptions(screen.getByLabelText('Branch to merge'), 'feature-b')
    await user.click(screen.getByRole('button', { name: 'OK' }))

    await screen.findByText('Resolve merge conflicts')
    expect(screen.getAllByText('0 of 1 decided').length).toBeGreaterThan(0)

    await user.click(screen.getByTitle('Use your value')) // ◀ — keep main's "RCT (confirmed)"
    expect(screen.getAllByText('1 of 1 decided').length).toBeGreaterThan(0)

    const finishBtn = screen.getByRole('button', { name: 'Finish merge' })
    expect(finishBtn).toBeEnabled()
    await user.click(finishBtn)

    await screen.findByText(/Merged feature-b into/)

    // Verify independently: a real merge commit landed, MERGE_HEAD is gone,
    // and the resolved content ("ours") is what's actually on disk.
    expect(existsSync(join(repoDir, '.git', 'MERGE_HEAD'))).toBe(false)
    const parents = git(['log', '-1', '--format=%P']).trim().split(' ')
    expect(parents).toHaveLength(2) // a real two-parent merge commit
    // The resolved answer lives in the split per-reviewer annotation file
    // (`finishPull` writes the split layout, same as a real Electron save),
    // not in `project.json` itself — search the whole committed tree rather
    // than assume its exact path.
    const committedFiles = git(['ls-tree', '-r', '--name-only', 'HEAD'])
      .trim()
      .split('\n')
    const committedText = committedFiles.map((f) => git(['show', `HEAD:${f}`])).join('\n')
    expect(committedText).toContain('RCT (confirmed)')
    expect(committedText).not.toContain('Cohort (relabeled)')
  })
})
