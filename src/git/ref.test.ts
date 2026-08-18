import { describe, expect, it } from 'vitest'
import { refProblem } from './ref'

describe('refProblem', () => {
  it('accepts the branch names git itself produces', () => {
    for (const ref of ['main', 'feature/x', 'origin/main', 'origin/feature/nested/x', 'v1.6.2', 'a_b-c']) {
      expect(refProblem(ref), ref).toBeNull()
    }
  })

  it('refuses an empty ref', () => {
    expect(refProblem('')).toBe('empty')
  })

  it('refuses a ref git would read as an option', () => {
    expect(refProblem('--upload-pack=touch /tmp/pwn')).toBe('option-like')
    expect(refProblem('-x')).toBe('option-like')
  })

  it('refuses control characters', () => {
    expect(refProblem('ma\nin')).toBe('control-char')
    expect(refProblem('ma\tin')).toBe('control-char')
    expect(refProblem('main\x7f')).toBe('control-char')
  })

  it('refuses revision syntax that would name a different commit', () => {
    for (const ref of ['main^', 'main~1', 'main..other', 'main:path/to/file', 'main@{1}']) {
      expect(refProblem(ref), ref).toBe('bad-syntax')
    }
  })

  it('refuses what check-ref-format forbids', () => {
    for (const ref of ['a b', 'a?b', 'a*b', 'a[b', 'a\\b', '/main', 'main/', 'a//b', 'main.', 'main.lock']) {
      expect(refProblem(ref), ref).toBe('bad-syntax')
    }
  })

  it('refuses a dotted or .lock component at any level, not only the last', () => {
    expect(refProblem('origin/.hidden/x')).toBe('bad-syntax')
    expect(refProblem('origin/x.lock/y')).toBe('bad-syntax')
    expect(refProblem('.git')).toBe('bad-syntax')
  })
})
