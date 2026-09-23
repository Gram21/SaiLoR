import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FETCH_COMMAND_KEYS, backgroundFetchAllowed } from '../../git/fetchPolicy'

/**
 * The background fetch is refused for a repository whose own config names a
 * command a fetch would run — the line between "opening a folder" and "running
 * whatever that folder's .git/config says". Tested against real git, because
 * the pattern is only as good as its agreement with what `git config
 * --get-regexp` actually reports (git lower-cases section and key names, and
 * keeps subsection case).
 */

let repo: string

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  } catch (err) {
    // Exit 1 from --get-regexp just means "no match".
    return ((err as { stdout?: string }).stdout ?? '').toString()
  }
}

/** The exact query `git:backgroundFetch` makes. */
const localCommandKeys = () => git('config', '--local', '--name-only', '--get-regexp', FETCH_COMMAND_KEYS)

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sailor-fetchpolicy-'))
  git('init', '-q')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('background fetch policy against real git config', () => {
  it('allows an ordinary repository', () => {
    git('config', 'user.name', 'Anna')
    git('config', 'remote.origin.url', 'https://example.org/review.git')
    git('config', 'core.autocrlf', 'false')
    git('config', 'credential.useHttpPath', 'true') // a credential setting, not a command
    expect(backgroundFetchAllowed(localCommandKeys())).toBe(true)
  })

  it.each([
    ['core.sshCommand', 'sh -c "touch pwned"'],
    ['core.gitProxy', 'evil-proxy'],
    ['core.askPass', 'evil-askpass'],
    ['credential.helper', '!evil'],
    ['credential.https://example.org.helper', '!evil'],
    ['remote.origin.uploadpack', 'sh -c evil'],
    ['remote.Origin.receivepack', 'sh -c evil'],
    ['include.path', '/tmp/more-config'],
    ['includeIf.gitdir:/tmp/.path', '/tmp/more-config'],
  ])('refuses a repository whose own config sets %s', (key, value) => {
    git('config', key, value)
    expect(backgroundFetchAllowed(localCommandKeys())).toBe(false)
  })

  it('looks only at the repository\'s own config, not the user\'s', () => {
    // A credential helper in the user's global config is the ordinary setup,
    // and must not stop the fetch — `--local` is what keeps it out.
    const out = execFileSync('git', ['config', '--local', '--list'], { cwd: repo, encoding: 'utf8' })
    expect(out).not.toMatch(/credential\.helper/)
    expect(backgroundFetchAllowed(localCommandKeys())).toBe(true)
  })
})
