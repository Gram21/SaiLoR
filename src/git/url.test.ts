import { describe, it, expect } from 'vitest'
import { validateGitUrl, validateClonePath, repoNameFromUrl } from './url'

describe('validateGitUrl', () => {
  const accepted = [
    'https://github.com/Gram21/SaiLoR.git',
    'http://example.com/repo.git',
    'ssh://git@host:2222/a/b.git',
    'git://example.com/repo.git',
    'file:///abs/repo',
    'git@github.com:Gram21/SaiLoR.git',
    '/abs/local/repo',
    'C:\\repos\\x',
  ]
  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(validateGitUrl(url)).toBeNull()
    })
  }

  it('tolerates surrounding whitespace', () => {
    expect(validateGitUrl('  https://github.com/Gram21/SaiLoR.git  ')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(validateGitUrl('')).toBe('Enter the repository URL.')
  })

  it('rejects a whitespace-only string', () => {
    expect(validateGitUrl('   ')).toBe('Enter the repository URL.')
  })

  it('rejects a URL starting with "-"', () => {
    expect(validateGitUrl('-x')).toMatch(/would read it as an option/)
  })

  it('rejects an option-injection attempt', () => {
    expect(validateGitUrl('--upload-pack=/bin/sh')).toMatch(/would read it as an option/)
  })

  it('rejects the ext:: remote helper', () => {
    expect(validateGitUrl('ext::sh -c whoami')).toMatch(/[Rr]emote-helper/)
  })

  it('rejects the remote helper regardless of case', () => {
    expect(validateGitUrl('EXT::sh -c whoami')).toMatch(/[Rr]emote-helper/)
  })

  it('rejects any scheme::transport form', () => {
    expect(validateGitUrl('transport::addr')).toMatch(/[Rr]emote-helper/)
  })

  it('rejects a URL with an embedded line break', () => {
    expect(validateGitUrl('https://host/a\nb')).toMatch(/line break/)
  })

  it('rejects a URL with a null byte', () => {
    expect(validateGitUrl('https://host/a\0b')).toMatch(/line break|null byte/)
  })

  it('rejects text that is not a recognized URL or path form', () => {
    expect(validateGitUrl('notaurl')).toMatch(/Use an https/)
  })

  it('never mistakes a scheme for a remote helper', () => {
    // The "::" remote-helper check requires two consecutive colons; an ordinary
    // "scheme://" has none between the scheme and its slashes, so it must never
    // be rejected as a remote helper.
    expect(validateGitUrl('https://github.com/a/b.git')).toBeNull()
    expect(validateGitUrl('ssh://git@host/a/b.git')).toBeNull()
  })
})

describe('validateClonePath', () => {
  it('accepts an absolute POSIX path', () => {
    expect(validateClonePath('/Users/me/repos/x')).toBeNull()
  })

  it('accepts an absolute Windows path', () => {
    expect(validateClonePath('C:\\Users\\me\\repos\\x')).toBeNull()
  })

  it('rejects a relative path', () => {
    expect(validateClonePath('repos/x')).toMatch(/absolute/)
  })

  it('rejects an empty path', () => {
    expect(validateClonePath('')).toMatch(/Choose where/)
  })

  it('rejects a path starting with "-"', () => {
    expect(validateClonePath('-x')).toMatch(/would read it as an option/)
  })

  it('rejects a path with an embedded newline', () => {
    expect(validateClonePath('/tmp/a\nb')).toMatch(/line break/)
  })
})

describe('repoNameFromUrl', () => {
  it.each([
    ['https://github.com/Gram21/SaiLoR.git', 'SaiLoR'],
    ['http://example.com/repo.git', 'repo'],
    ['ssh://git@host:2222/a/b.git', 'b'],
    ['git://example.com/repo.git', 'repo'],
    ['file:///abs/repo', 'repo'],
    ['git@github.com:Gram21/SaiLoR.git', 'SaiLoR'],
    ['/abs/local/repo', 'repo'],
    ['C:\\repos\\x', 'x'],
    ['https://host/a/b.git?x=1#y', 'b'],
  ])('derives %s -> %s', (url, expected) => {
    expect(repoNameFromUrl(url)).toBe(expected)
  })

  it('returns null for a URL with no path segment', () => {
    expect(repoNameFromUrl('https://host/')).toBeNull()
  })

  it('returns null when the last segment is ".."', () => {
    expect(repoNameFromUrl('https://host/..')).toBeNull()
  })

  it('returns null when the last segment is "."', () => {
    expect(repoNameFromUrl('https://host/a/.')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(repoNameFromUrl('')).toBeNull()
  })
})
