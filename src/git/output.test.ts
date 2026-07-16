import { describe, it, expect } from 'vitest'
import { parsePorcelain, capDiff, gitErrorText, MAX_DIFF_CHARS } from './output'
import type { GitRun } from './types'

describe('parsePorcelain', () => {
  it('parses a modified file', () => {
    const out = parsePorcelain(' M review.json\0')
    expect(out).toEqual([{ path: 'review.json', code: ' M', unmerged: false, from: undefined }])
  })

  it('parses an untracked file', () => {
    const out = parsePorcelain('?? pdfs/new.pdf\0')
    expect(out).toEqual([{ path: 'pdfs/new.pdf', code: '??', unmerged: false, from: undefined }])
  })

  it('parses a rename as two records, keeping the new path and the "from"', () => {
    const out = parsePorcelain('R  new.json\0old.json\0')
    expect(out).toEqual([{ path: 'new.json', code: 'R ', unmerged: false, from: 'old.json' }])
  })

  it('does not emit the rename source as its own row', () => {
    const out = parsePorcelain('R  new.json\0old.json\0?? extra.pdf\0')
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.path)).toEqual(['new.json', 'extra.pdf'])
  })

  it.each(['UU', 'AA', 'DD'])('marks %s as unmerged', (code) => {
    const out = parsePorcelain(`${code} conflict.json\0`)
    expect(out[0].unmerged).toBe(true)
  })

  it('does not mark a normal modification as unmerged', () => {
    const out = parsePorcelain(' M review.json\0')
    expect(out[0].unmerged).toBe(false)
  })

  it('returns an empty array for empty input', () => {
    expect(parsePorcelain('')).toEqual([])
  })

  it('skips a truncated final record rather than throwing', () => {
    expect(() => parsePorcelain(' M\0')).not.toThrow()
    expect(parsePorcelain(' M\0')).toEqual([])
  })

  it('parses a path containing a space', () => {
    const out = parsePorcelain(' M my review.json\0')
    expect(out[0].path).toBe('my review.json')
  })
})

describe('capDiff', () => {
  it('leaves a short diff untouched', () => {
    const text = 'diff --git a/x b/x\n+hello\n'
    expect(capDiff(text)).toEqual({ text, truncated: false })
  })

  it('cuts a diff over the cap, exactly at MAX_DIFF_CHARS', () => {
    const text = 'a'.repeat(MAX_DIFF_CHARS + 100)
    const { text: cut, truncated } = capDiff(text)
    expect(truncated).toBe(true)
    expect(cut.length).toBe(MAX_DIFF_CHARS)
  })
})

describe('gitErrorText', () => {
  const run = (partial: Partial<GitRun>): GitRun => ({
    ok: false,
    code: 1,
    stdout: '',
    stderr: '',
    ...partial,
  })

  it('prefers stderr', () => {
    expect(gitErrorText(run({ stderr: 'fatal: not a repository', stdout: 'noise' }))).toMatch(
      /fatal: not a repository/,
    )
  })

  it('falls back to stdout when stderr is blank', () => {
    expect(gitErrorText(run({ stdout: 'nothing to commit' }))).toBe('nothing to commit')
  })

  it('falls back to the exit-code sentence when both are blank', () => {
    expect(gitErrorText(run({ code: 128 }))).toBe('git exited with code 128.')
  })

  it('reports "could not be started" when code is null', () => {
    expect(gitErrorText(run({ code: null }))).toBe('git could not be started.')
  })
})
