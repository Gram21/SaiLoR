import { describe, it, expect } from 'vitest'
import { annotationsDirOf, annotationsDirProblem, defaultSplitDirName, DEFAULT_ANNOTATIONS_DIR, filesCollide, sharesPaper } from './annotationsDir'
import { annotationsRelDir } from '../git/relpath'
import { loadProject, marksFileName, parseMarksFileName, projectFromFiles, serializeProject, splitProjectFiles } from './project'

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
    expect(defaultSplitDirName('screening-annotation.json')).toBe('screening-annotations')
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

describe('sharesPaper', () => {
  const raw = { papers: [{ id: 'p1' }, { id: 'Smith2021' }] }
  it('is true only for a paper both list, compared as a case-insensitive disk would', () => {
    expect(sharesPaper(['p1-2', 'p3-2'], raw)).toBe(false)
    expect(sharesPaper(['smith2021'], raw)).toBe(true)
    expect(sharesPaper(['p1'], { papers: 'nope' })).toBe(false)
  })
})

describe('filesCollide', () => {
  const screening = { config: { screening: { reasons: ['x'] } }, papers: [{ id: 'p1' }] }
  const review = { config: { schema: [] }, papers: [{ id: 'p1' }] }
  it('is true only for a project of the same kind listing the same paper', () => {
    expect(filesCollide(['p1'], true, screening)).toBe(true)
    expect(filesCollide(['p1'], false, screening)).toBe(false)
    expect(filesCollide(['p1'], true, review)).toBe(false)
    expect(filesCollide(['p2'], false, review)).toBe(false)
  })
})

describe('highlight file names', () => {
  it('are the kind\'s own, with a screening project\'s old ones recognised as such', () => {
    expect(marksFileName(true, '1')).toBe('screening-marks-1.json')
    expect(marksFileName(false, 'consolidated')).toBe('marks-consolidated.json')
    expect(parseMarksFileName('screening-marks-2.json', true)).toEqual({ seat: '2', legacy: false })
    expect(parseMarksFileName('marks-2.json', true)).toEqual({ seat: '2', legacy: true })
    expect(parseMarksFileName('marks-2.json', false)).toEqual({ seat: '2', legacy: false })
    expect(parseMarksFileName('screening-marks-2.json', false)).toBeNull()
  })

  it('prefer a screening project\'s own-named file over an old one for the same seat', () => {
    const meta = { version: 1, config: { reviewers: 2, screening: { reasons: ['x'] } }, papers: [{ id: 'p', title: 'p', authors: [], pdf: 'p.pdf' }] }
    const mark = (id: string) => JSON.stringify({ marks: [{ id, page: 1, kind: 'highlight', rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.05 }], color: '#ffe066', comment: '', createdAt: '', updatedAt: '' }] })
    const p = projectFromFiles(meta, [
      ['p/screening-marks-1.json', mark('new')],
      ['p/marks-1.json', mark('old')],
      ['p/marks-2.json', mark('only-old')],
    ])
    expect(p.papers[0].reviewMarks['1']?.map((m) => m.id)).toEqual(['new'])
    expect(p.papers[0].reviewMarks['2']?.map((m) => m.id)).toEqual(['only-old'])
  })
})
