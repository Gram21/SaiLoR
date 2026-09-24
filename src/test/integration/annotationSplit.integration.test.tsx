import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, readdirSync, rmdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { applySplit, planSplit, type SplitFs } from '../../model/annotationSplit'
import { ownAnnotationPathsIn } from '../../git/ownAnnotationPath'
import { parsePorcelain } from '../../git/output'

/**
 * Splitting a shared annotations folder in a real repository: git must see
 * the moved files as renames, and each project's own-file staging must then
 * see only its own files.
 */
let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true })
  writeFileSync(join(repo, rel), text)
}
const project = (ids: string[], screening = false) =>
  JSON.stringify({
    version: 1,
    config: screening ? { screening: { reasons: ['Off topic'] } } : { schema: [{ name: 'N', type: 'string' }] },
    papers: ids.map((id) => ({ id, title: id, authors: [], pdf: `${id}.pdf` })),
  })

const nodeFs: SplitFs = {
  copy: async (from, to) => write(to, readFileSync(join(repo, from), 'utf8')),
  readText: async (f) => readFileSync(join(repo, f), 'utf8'),
  writeText: async (f, t) => writeFileSync(join(repo, f), t),
  remove: async (f) => unlinkSync(join(repo, f)),
  removeDirIfEmpty: async (d) => {
    if (existsSync(join(repo, d)) && readdirSync(join(repo, d)).length === 0) rmdirSync(join(repo, d))
  },
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sailor-split-'))
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.org')
  write('review.json', project(['p', 'q']))
  write('screen.json', project(['p'], true))
  write('annotations/p/reviewer-1.json', '{"annotations":{"N":[{"value":"review answer"}]}}\n')
  write('annotations/q/reviewer-1.json', '{"annotations":{"N":[{"value":"only review"}]}}\n')
  write('annotations/p/screening-1.json', '{"annotations":{"Decision":[{"value":"include"}]}}\n')
  git('add', '-A')
  git('commit', '-qm', 'shared folder')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('splitting a shared annotations folder', () => {
  it('moves each file to its project, which git sees as renames', async () => {
    const projects = ['review.json', 'screen.json'].map((name) => ({
      path: name,
      name,
      meta: JSON.parse(readFileSync(join(repo, name), 'utf8')),
    }))
    const files = ['p/reviewer-1.json', 'q/reviewer-1.json', 'p/screening-1.json'].map((relPath) => ({
      relPath,
      text: readFileSync(join(repo, 'annotations', relPath), 'utf8'),
    }))
    const rows = planSplit(projects, files)
    await applySplit(
      {
        shared: 'annotations',
        projects: [
          { file: 'review.json', folder: 'review-annotations' },
          { file: 'screen.json', folder: 'screen-annotations' },
        ],
        rows,
      },
      nodeFs,
    )

    expect(existsSync(join(repo, 'annotations'))).toBe(false)
    git('add', '-A')
    const status = git('status', '--porcelain=v1')
    expect(status).toMatch(/^R {2}annotations\/p\/reviewer-1\.json -> review-annotations\/p\/reviewer-1\.json$/m)
    expect(status).toMatch(/^R {2}annotations\/p\/screening-1\.json -> screen-annotations\/p\/screening-1\.json$/m)
    expect(JSON.parse(readFileSync(join(repo, 'review.json'), 'utf8')).annotationsDir).toBe('review-annotations')

    git('commit', '-qm', 'split')
    write('review-annotations/p/reviewer-1.json', '{"annotations":{"N":[{"value":"edited"}]}}\n')
    write('screen-annotations/p/screening-1.json', '{"annotations":{"Decision":[{"value":"exclude"}]}}\n')
    const changes = parsePorcelain(git('status', '--porcelain=v1', '-z', '-uall'))
    const review = JSON.parse(readFileSync(join(repo, 'review.json'), 'utf8'))
    expect(ownAnnotationPathsIn(changes, 'review-annotations', review)).toEqual(['review-annotations/p/reviewer-1.json'])
  })
})
