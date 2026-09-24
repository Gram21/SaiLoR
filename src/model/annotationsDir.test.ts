import { describe, it, expect } from 'vitest'
import { annotationsDirOf, annotationsDirProblem, defaultSplitDirName, DEFAULT_ANNOTATIONS_DIR } from './annotationsDir'
import { annotationsRelDir } from '../git/relpath'
import { loadProject, serializeProject, splitProjectFiles } from './project'

describe('annotations folder names', () => {
  it.each(['annotations', 'review-annotations', 'Screening 2026'])('allows the plain folder name %s', (name) => {
    expect(annotationsDirProblem(name)).toBeNull()
    expect(annotationsDirOf({ annotationsDir: name })).toBe(name)
  })

  // A project file can arrive from anyone: nothing it names may lead out of
  // the project's own directory.
  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', '/abs', 'C:x', 'C:\\x', '\\\\server\\x', 'x.', 'x ', ' x', 'NUL', '.git', '.hidden', 'a\nb'])(
    'refuses %j and falls back to the default',
    (name) => {
      expect(annotationsDirProblem(name)).not.toBeNull()
      expect(annotationsDirOf({ annotationsDir: name })).toBe(DEFAULT_ANNOTATIONS_DIR)
    },
  )

  it('falls back to the default when the key is absent or not a string', () => {
    expect(annotationsDirOf({})).toBe('annotations')
    expect(annotationsDirOf({ annotationsDir: 7 })).toBe('annotations')
    expect(annotationsDirOf(null)).toBe('annotations')
  })

  it('suggests a folder named after the project file', () => {
    expect(defaultSplitDirName('review.json')).toBe('review-annotations')
    expect(defaultSplitDirName('a:b.json')).toBe('project-annotations')
  })
})

describe('annotationsRelDir', () => {
  it('is always one folder next to the project file, repo-relative', () => {
    expect(annotationsRelDir('review.json')).toBe('annotations')
    expect(annotationsRelDir('sub/review.json', 'review-annotations')).toBe('sub/review-annotations')
    expect(annotationsRelDir('sub/review.json', '../escape')).toBe('sub/annotations')
  })
})

describe('the annotationsDir key in a project file', () => {
  const text = (extra: Record<string, unknown>) =>
    JSON.stringify({ version: 1, ...extra, config: { schema: [{ name: 'N', type: 'string' }] }, papers: [] })

  it('round-trips, in the whole-project text and in project.json', () => {
    const p = loadProject(text({ annotationsDir: 'review-annotations' }))
    expect(p.annotationsDir).toBe('review-annotations')
    expect(loadProject(serializeProject(p)).annotationsDir).toBe('review-annotations')
    expect((splitProjectFiles(p).meta as { annotationsDir?: string }).annotationsDir).toBe('review-annotations')
    expect(p.extra).toEqual({})
  })

  it('ignores a refused name, remembers it for Validate, and does not write it back', () => {
    const p = loadProject(text({ annotationsDir: '../other' }))
    expect(p.annotationsDir).toBeNull()
    expect(p.refusedAnnotationsDir).toBe('../other')
    expect(JSON.parse(serializeProject(p)).annotationsDir).toBeUndefined()
  })
})
