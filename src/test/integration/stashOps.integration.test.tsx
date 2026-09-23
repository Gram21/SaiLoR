import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { GitRun } from '../../git/types'
import {
  pushStash,
  restoreStash,
  dropStash,
  branchFromStash,
  listStashes,
  popCarryOverStash,
  dropCarryOverStash,
  type RunGit,
} from '../../git/stashOps'
import { BRANCH_SWITCH_STASH_MESSAGE } from '../../git/stash'

/**
 * The stash operations exactly as the app runs them — `src/git/stashOps.ts`,
 * which `electron/main.ts` only binds to a repository root — against a real
 * scratch repository rather than a fake.
 *
 * Worth the real thing because the dangerous path is git's own behaviour: a
 * stash that no longer fits leaves a half-applied, conflict-marked tree, and
 * the whole point of `restoreStash` is that the reviewer never sees one. That
 * can only be believed by watching real git produce it and the rollback undo it.
 */

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

/** The same shape `runGit` in electron/main.ts returns: a non-zero exit is data. */
const run: RunGit = (args) =>
  new Promise<GitRun>((resolve) => {
    execFile('git', args, { cwd: repo, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0
      resolve({ ok: !err, code: typeof code === 'number' ? code : 1, stdout, stderr })
    })
  })

function write(rel: string, text: string) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true })
  writeFileSync(join(repo, rel), text)
}
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8')

const PROJECT = { config: {}, papers: [{ id: 'p1' }, { id: 'p2' }] }
const answer = (v: string) => JSON.stringify({ annotations: { Claim: [{ value: v }] } }, null, 2)

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sailor-stash-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'anna@example.org')
  git('config', 'user.name', 'Anna')
  git('config', 'commit.gpgsign', 'false')
  write('project.json', JSON.stringify(PROJECT))
  write('annotations/p1/reviewer-1.json', answer('original'))
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('pushStash', () => {
  it("parks this project's changes, including a paper's first reading, and nothing else", async () => {
    write('annotations/p1/reviewer-1.json', answer('edited'))
    write('annotations/p2/reviewer-1.json', answer('first reading')) // brand-new folder
    write('annotations/q9/consolidated.json', answer('a sibling project')) // not ours
    write('notes.md', 'scratch') // not ours either

    const r = await pushStash(run, 'project.json', PROJECT, 'half done')
    expect(r.ok).toBe(true)

    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('original'))
    expect(existsSync(join(repo, 'annotations/p2/reviewer-1.json'))).toBe(false)
    // Somebody else's work stays exactly where it was.
    expect(read('annotations/q9/consolidated.json')).toBe(answer('a sibling project'))
    expect(read('notes.md')).toBe('scratch')

    const [entry] = await listStashes(run)
    expect(entry.origin).toBe('sailor')
  })

  it('says so when there is nothing of this project to stash', async () => {
    write('notes.md', 'scratch')
    const r = await pushStash(run, 'project.json', PROJECT, '')
    expect(r.ok).toBe(false)
    expect(r.stderr).toMatch(/no uncommitted changes/)
  })
})

describe('restoreStash', () => {
  async function stashAnEdit() {
    write('annotations/p1/reviewer-1.json', answer('edited'))
    write('annotations/p2/reviewer-1.json', answer('first reading'))
    await pushStash(run, 'project.json', PROJECT, 'wip')
    return (await listStashes(run))[0].sha
  }

  it('puts the changes back and removes the stash', async () => {
    const sha = await stashAnEdit()
    expect(await restoreStash(run, 'project.json', sha)).toEqual({ kind: 'restored' })
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('edited'))
    expect(read('annotations/p2/reviewer-1.json')).toBe(answer('first reading'))
    expect(await listStashes(run)).toEqual([])
  })

  it('refuses onto uncommitted work, and changes nothing', async () => {
    const sha = await stashAnEdit()
    write('annotations/p1/reviewer-1.json', answer('something else meanwhile'))

    const r = await restoreStash(run, 'project.json', sha)
    expect(r.kind).toBe('dirty')
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('something else meanwhile'))
    expect(await listStashes(run)).toHaveLength(1)
  })

  it('rolls a conflicting restore all the way back, keeping the stash', async () => {
    const sha = await stashAnEdit()
    // Meanwhile the same file changed and was committed — the stash no
    // longer fits, and plain `git stash apply` would leave conflict markers.
    write('annotations/p1/reviewer-1.json', answer('committed by a teammate'))
    git('commit', '-q', '-am', 'teammate')

    expect(await restoreStash(run, 'project.json', sha)).toEqual({ kind: 'conflict' })

    // Exactly as before the attempt: HEAD's content, no markers, no stray
    // untracked file the half-apply restored, nothing staged or unmerged.
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('committed by a teammate'))
    expect(existsSync(join(repo, 'annotations/p2/reviewer-1.json'))).toBe(false)
    expect(git('status', '--porcelain=v1', '-uall')).toBe('')
    // And nothing was lost: the parked work is still there to try again.
    expect((await listStashes(run)).map((e) => e.sha)).toEqual([sha])
  })

  it('finds the right stash by sha after others have been pushed on top', async () => {
    // stash@{n} shifts; a sha does not.
    const sha = await stashAnEdit()
    write('project.json', JSON.stringify({ ...PROJECT, title: 'later' }))
    await pushStash(run, 'project.json', PROJECT, 'a later one')

    // The later one is on top; put it back first so the tree is clean again.
    const [later] = await listStashes(run)
    expect(await restoreStash(run, 'project.json', later.sha)).toEqual({ kind: 'restored' })
    git('checkout', '-q', '--', 'project.json')

    expect(await restoreStash(run, 'project.json', sha)).toEqual({ kind: 'restored' })
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('edited'))
  })

  it('reports a stash that no longer exists', async () => {
    expect(await restoreStash(run, 'project.json', '0'.repeat(40))).toEqual({ kind: 'gone' })
  })
})

describe('branchFromStash', () => {
  it('restores a stash that no longer fits onto a branch where it cannot conflict', async () => {
    write('annotations/p1/reviewer-1.json', answer('edited'))
    await pushStash(run, 'project.json', PROJECT, 'wip')
    const [{ sha }] = await listStashes(run)
    write('annotations/p1/reviewer-1.json', answer('committed by a teammate'))
    git('commit', '-q', '-am', 'teammate')

    const r = await branchFromStash(run, 'project.json', sha, 'restored-stash')
    expect(r.ok).toBe(true)
    expect(git('branch', '--show-current').trim()).toBe('restored-stash')
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('edited'))
    expect(await listStashes(run)).toEqual([])
  })
})

describe('dropStash', () => {
  it('deletes the stash it names and only that one', async () => {
    write('annotations/p1/reviewer-1.json', answer('one'))
    await pushStash(run, 'project.json', PROJECT, 'one')
    write('annotations/p1/reviewer-1.json', answer('two'))
    await pushStash(run, 'project.json', PROJECT, 'two')
    const [two, one] = await listStashes(run)

    expect((await dropStash(run, one.sha)).ok).toBe(true)
    expect((await listStashes(run)).map((e) => e.sha)).toEqual([two.sha])
  })
})

describe('the branch-switch carry-over is found by name, not by position', () => {
  /** What git:branchSwitchBegin pushes. */
  function pushCarryOver(content: string) {
    write('annotations/p1/reviewer-1.json', answer(content))
    git('stash', 'push', '-u', '-m', BRANCH_SWITCH_STASH_MESSAGE, '--', 'project.json', 'annotations')
  }

  it('pops the carry-over even with somebody\'s own stash on top of it', async () => {
    // stash@{0} used to be assumed. With a panel that makes stashes, the top
    // entry may be the reviewer's own parked work, and popping that instead
    // would restore the wrong changes.
    pushCarryOver('carried over')
    write('annotations/p1/reviewer-1.json', answer('parked by hand'))
    await pushStash(run, 'project.json', PROJECT, 'mine')

    expect((await popCarryOverStash(run)).ok).toBe(true)
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('carried over'))
    const left = await listStashes(run)
    expect(left.map((e) => e.origin)).toEqual(['sailor'])
  })

  it('takes the newest carry-over when an older stranded one sits below', async () => {
    pushCarryOver('stranded long ago')
    pushCarryOver('just now')

    expect((await dropCarryOverStash(run)).ok).toBe(true)
    // The stranded one is still there to be found and restored.
    const [left] = await listStashes(run)
    expect(left.origin).toBe('branch-switch')
    expect(await restoreStash(run, 'project.json', left.sha)).toEqual({ kind: 'restored' })
    expect(read('annotations/p1/reviewer-1.json')).toBe(answer('stranded long ago'))
  })

  it('treats nothing to drop as done, not as a failure', async () => {
    expect((await dropCarryOverStash(run)).ok).toBe(true)
  })
})
