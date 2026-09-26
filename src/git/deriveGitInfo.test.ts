import { describe, it, expect } from 'vitest'
import { deriveGitInfo } from './deriveGitInfo'
import type { GitRun } from './types'

const ok = (stdout: string): GitRun => ({ ok: true, code: 0, stdout, stderr: '' })
const fail: GitRun = { ok: false, code: 1, stdout: '', stderr: 'error' }

describe('deriveGitInfo', () => {
  it('assigns each of the five independent results to its own field, not a neighbor\'s', () => {
    // Each input carries a distinct, recognizable value — if the git:info
    // handler's Promise.all destructure ever swapped two positions (its own
    // "five same-shaped calls resolved as one array" is exactly where a
    // reordering bug hides with no type error to catch it), this test fails
    // by showing the wrong field holding another one's value.
    const result = deriveGitInfo('review.json', {
      top: ok('/repo/root'),
      prefix: ok('sub/dir/'),
      head: ok(''),
      branch: ok('feature-x'),
      upstream: ok('origin/feature-x'),
      behind: fail,
    })
    expect(result).toEqual({
      root: '/repo/root',
      relPath: 'sub/dir/review.json',
      branch: 'feature-x',
      upstream: 'origin/feature-x',
      hasHead: true,
      behind: null,
    })
  })

  it('relPath is prefix + the project\'s own basename, not the full path', () => {
    const result = deriveGitInfo('review.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main'),
      upstream: fail,
      behind: fail,
    })
    expect(result.relPath).toBe('review.json')
  })

  it('a detached HEAD (branch lookup fails) reports branch: null, matching the old sequential code', () => {
    const result = deriveGitInfo('p.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: fail,
      upstream: fail,
      behind: fail,
    })
    expect(result.branch).toBeNull()
    expect(result.upstream).toBeNull()
  })

  it('no upstream configured reports upstream: null without affecting branch', () => {
    const result = deriveGitInfo('p.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main'),
      upstream: fail,
      behind: fail,
    })
    expect(result.branch).toBe('main')
    expect(result.upstream).toBeNull()
  })

  it('no HEAD yet (a fresh, commit-less repo) reports hasHead: false', () => {
    const result = deriveGitInfo('p.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: fail,
      branch: fail,
      upstream: fail,
      behind: fail,
    })
    expect(result.hasHead).toBe(false)
  })

  it('trims trailing newlines the same way the original gitOut helper did', () => {
    const result = deriveGitInfo('p.json', {
      top: ok('/repo\n'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main\n'),
      upstream: ok('origin/main\n'),
      behind: fail,
    })
    expect(result.root).toBe('/repo')
    expect(result.branch).toBe('main')
    expect(result.upstream).toBe('origin/main')
  })
})

describe('deriveGitInfo: behind', () => {
  it('reports what the last fetch knows the upstream is ahead by', () => {
    const result = deriveGitInfo('review.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main'),
      upstream: ok('origin/main'),
      behind: ok('3'),
    })
    expect(result.behind).toBe(3)
  })

  it('is null without an upstream, whatever rev-list printed', () => {
    // `HEAD..@{u}` cannot mean anything there, so a count would be noise.
    const result = deriveGitInfo('review.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main'),
      upstream: fail,
      behind: ok('3'),
    })
    expect(result.behind).toBeNull()
  })

  it('is null rather than 0 when the count could not be read', () => {
    // "Nothing known" and "nothing there" must not look the same.
    const result = deriveGitInfo('review.json', {
      top: ok('/repo'),
      prefix: ok(''),
      head: ok(''),
      branch: ok('main'),
      upstream: ok('origin/main'),
      behind: fail,
    })
    expect(result.behind).toBeNull()
  })
})
