import { describe, it, expect } from 'vitest'
import { relPathProblem, annotationsRelDir } from './relpath'

/**
 * This gate stands in front of file writes into a git repository, and the
 * repository may be one the reviewer received rather than created. Each case
 * below is something that was, or would be, accepted by a weaker rule.
 */

describe('relPathProblem', () => {
  it('accepts ordinary project-relative paths', () => {
    for (const p of ['project.json', 'papers/a.json', 'a/b/c/d.json', 'my.git/x', '..git/x', 'git/x']) {
      expect(relPathProblem(p), p).toBeNull()
    }
  })

  it('rejects traversal spelled with either separator', () => {
    expect(relPathProblem('../x')).toBe('traversal')
    expect(relPathProblem('a/../../x')).toBe('traversal')
    // The backslash form is the one that mattered: on POSIX, splitting on '/'
    // alone left this as a single opaque segment and let it through, while
    // path.win32.join honours it and walks out of the repository.
    expect(relPathProblem('..\\..\\Users\\victim\\.bashrc')).toBe('traversal')
  })

  it('rejects absolute paths in POSIX and Windows spellings', () => {
    expect(relPathProblem('/etc/passwd')).toBe('absolute')
    expect(relPathProblem('C:\\Windows\\x')).toBe('absolute')
    expect(relPathProblem('c:/Windows/x')).toBe('absolute')
    expect(relPathProblem('\\\\server\\share\\x')).toBe('absolute')
  })

  it('rejects control characters', () => {
    expect(relPathProblem('a\0b')).toBe('control-char')
    expect(relPathProblem('a\nb')).toBe('control-char')
    expect(relPathProblem('a\rb')).toBe('control-char')
  })

  it('rejects .git however it is spelled', () => {
    // Writing into .git is a code-execution primitive: config names commands
    // git runs, and hooks/ is executed outright.
    expect(relPathProblem('.git/config')).toBe('dot-git')
    expect(relPathProblem('.git/hooks/pre-commit')).toBe('dot-git')
    expect(relPathProblem('a/.git/config')).toBe('dot-git')
    // Case: HFS+/NTFS are case-insensitive, so .GIT reaches the same directory.
    expect(relPathProblem('.GIT/hooks/pre-commit')).toBe('dot-git')
    expect(relPathProblem('.Git/config')).toBe('dot-git')
    // Trailing dots and spaces: Win32 strips them from path components, so all
    // of these open .git while a literal comparison sees a different name.
    expect(relPathProblem('.git./config')).toBe('dot-git')
    expect(relPathProblem('.git /config')).toBe('dot-git')
    expect(relPathProblem(' .git/config')).toBe('dot-git')
    expect(relPathProblem('.GIT. ./config')).toBe('dot-git')
  })

  it('rejects the empty path', () => {
    expect(relPathProblem('')).toBe('empty')
  })
})

describe('annotationsRelDir', () => {
  it('sits next to the project file when it is at the repo root', () => {
    expect(annotationsRelDir('project.json')).toBe('annotations')
  })

  it('sits next to the project file inside a subdirectory', () => {
    expect(annotationsRelDir('reviews/project.json')).toBe('reviews/annotations')
    expect(annotationsRelDir('a/b/c/project.json')).toBe('a/b/c/annotations')
  })

  it('normalizes a Windows-separated relPath to git-style forward slashes', () => {
    expect(annotationsRelDir('reviews\\project.json')).toBe('reviews/annotations')
  })
})
