import { describe, it, expect } from 'vitest'
import { parsePorcelain, capDiff, gitErrorText, diffLines, parseGitLog, MAX_DIFF_CHARS, mergePreviewText } from './output'
import type { GitRun, MergePreview } from './types'

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

describe('diffLines', () => {
  it('classifies a simple one-file diff', () => {
    const text = [
      'diff --git a/x b/x',
      'index abc123..def456 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-removed',
      '+added',
    ].join('\n')
    const kinds = diffLines(text).map((l) => l.kind)
    expect(kinds).toEqual([
      'context', // diff --git
      'context', // index
      'context', // --- a/x
      'context', // +++ b/x
      'context', // @@ ... @@
      'context', // unchanged
      'remove',
      'add',
    ])
  })

  it('does not misread the file-header pair for a content line with the same prefix', () => {
    // The regression this exists for: naively checking `+++`/`---` prefixes
    // anywhere in the diff would misclassify an *added* line whose own text
    // starts with those same three characters as the file header instead.
    const text = [
      'diff --git a/x b/x',
      'index abc123..def456 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+++counter; // an added line, not a file header',
      '---divider // a removed line, not a file header',
    ].join('\n')
    const lines = diffLines(text)
    const added = lines.find((l) => l.text.includes('counter'))
    const removed = lines.find((l) => l.text.includes('divider'))
    expect(added?.kind).toBe('add')
    expect(removed?.kind).toBe('remove')
  })

  it('resets per file, so the second file\'s header pair is not read as content', () => {
    const text = [
      'diff --git a/x b/x',
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/y b/y',
      'index 3..4 100644',
      '--- a/y',
      '+++ b/y',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n')
    const kinds = diffLines(text).map((l) => l.kind)
    // Both files' --- /+++ pairs are context, both files' hunks are colored.
    expect(kinds).toEqual([
      'context',
      'context',
      'context',
      'context',
      'context',
      'remove',
      'add',
      'context',
      'context',
      'context',
      'context',
      'context',
      'remove',
      'add',
    ])
  })

  it('treats a "no newline at end of file" marker as context, not content', () => {
    const text = ['diff --git a/x b/x', '@@ -1 +1 @@', '+added', '\\ No newline at end of file'].join(
      '\n',
    )
    const lines = diffLines(text)
    expect(lines[lines.length - 1]).toEqual({ text: '\\ No newline at end of file', kind: 'context' })
  })

  it('round-trips: joining every line\'s text reproduces the input', () => {
    const text = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new'
    expect(diffLines(text).map((l) => l.text).join('\n')).toBe(text)
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

describe('mergePreviewText', () => {
  const preview = (partial: Partial<Extract<MergePreview, { kind: 'preview' }>>) => ({
    kind: 'preview' as const,
    ref: 'origin/main',
    fastForward: false,
    files: [],
    papers: [],
    conflicts: [],
    conflictsElsewhere: [],
    ...partial,
  })

  it('names the fast-forward, the project file, and the annotation file count', () => {
    const text = mergePreviewText(
      preview({ fastForward: true, files: ['p/review.json', 'p/annotations/a/x.json'], papers: ['a'] }),
      'p/review.json',
      'Pull from origin/main',
    )
    expect(text).toMatch(/^Pull from origin\/main\?/)
    expect(text).toMatch(/No merge commit is made/)
    expect(text).toMatch(/The project file changes\./)
    expect(text).toMatch(/1 annotation file\(s\) change\./)
    expect(text).toMatch(/Papers with changes: a\./)
    expect(text).toMatch(/Git expects no conflicts\./)
    expect(text).toMatch(/Undo last merge/)
  })

  it('caps the paper list and prefers the stopping conflicts', () => {
    const papers = Array.from({ length: 12 }, (_, i) => `p${i}`)
    const text = mergePreviewText(
      preview({ papers, conflicts: ['review.json'], conflictsElsewhere: ['README.md'] }),
      'review.json',
      'Merge x into main',
    )
    expect(text).toMatch(/p9 and 2 more\./)
    expect(text).toMatch(/SaiLoR cannot merge: README\.md\. The merge will stop and change nothing\./)
    expect(text).not.toMatch(/merge dialog/)
  })

  it('says the merge dialog resolves project conflicts', () => {
    const text = mergePreviewText(preview({ conflicts: ['review.json'] }), 'review.json', 'Merge x into main')
    expect(text).toMatch(/Git expects conflicts in review\.json\. You resolve them in the merge dialog/)
    expect(text).toMatch(/No project or annotation file changes\./)
  })
})

describe('parseGitLog', () => {
  it('parses no commits', () => {
    expect(parseGitLog('')).toEqual([])
  })

  it('parses one commit', () => {
    const raw = '\0abc123\t2024-01-02T03:04:05+00:00\tFix the thing'
    expect(parseGitLog(raw)).toEqual([
      { hash: 'abc123', date: '2024-01-02T03:04:05+00:00', subject: 'Fix the thing' },
    ])
  })

  it('parses several commits, in order', () => {
    const raw = '\0aaa\t2024-01-01T00:00:00+00:00\tFirst\0bbb\t2024-01-02T00:00:00+00:00\tSecond'
    expect(parseGitLog(raw)).toEqual([
      { hash: 'aaa', date: '2024-01-01T00:00:00+00:00', subject: 'First' },
      { hash: 'bbb', date: '2024-01-02T00:00:00+00:00', subject: 'Second' },
    ])
  })

  it('keeps a tab inside the subject rather than desyncing the fields', () => {
    const raw = '\0abc\t2024-01-01T00:00:00+00:00\tHas\ta\ttab'
    expect(parseGitLog(raw)).toEqual([{ hash: 'abc', date: '2024-01-01T00:00:00+00:00', subject: 'Has\ta\ttab' }])
  })

  it('skips a record with fewer than two tabs', () => {
    const raw = '\0onlyonefield\0abc\t2024-01-01T00:00:00+00:00\tOk'
    expect(parseGitLog(raw)).toEqual([{ hash: 'abc', date: '2024-01-01T00:00:00+00:00', subject: 'Ok' }])
  })

  it('allows an empty subject', () => {
    const raw = '\0abc\t2024-01-01T00:00:00+00:00\t'
    expect(parseGitLog(raw)).toEqual([{ hash: 'abc', date: '2024-01-01T00:00:00+00:00', subject: '' }])
  })
})
