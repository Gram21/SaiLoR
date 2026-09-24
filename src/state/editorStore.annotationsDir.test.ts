import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/** The project editor's annotations folder: a plain folder name next to the
 *  file, used by no other project, and moved along when renamed. */
let calls: string[] = []
let users: Record<string, string[]> = {}
const PROJECT = JSON.stringify({ version: 1, config: { schema: [{ name: 'N', type: 'string' }] }, papers: [] })
const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  openProject: async () => ({ text: PROJECT, handle: { kind: 'electron' as const, path: '/r/review.json' }, name: 'review.json' }),
  openRecent: async () => null,
  saveProject: async (t: string, h: SaveHandle) => {
    calls.push(`save ${JSON.parse(t).annotationsDir ?? '-'}`)
    return h
  },
  annotationsDirUsers: async (_p: string, folder: string) => users[folder] ?? [],
  moveAnnotationsDir: async (_p: string, folder: string) => {
    calls.push(`move ${folder}`)
  },
  pickProjectLocation: async () => null,
  rebasePdfPaths: async (paths: string[]) => paths,
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))
const { useEditorStore } = await import('./editorStore')
const es = () => useEditorStore.getState()

beforeEach(async () => {
  calls = []
  users = {}
  await es().startEdit()
})

describe('the annotations folder in the project editor', () => {
  it.each(['../x', 'a/b', '..', 'C:x'])('refuses %j, which would lead out of the project directory', async (name) => {
    es().setAnnotationsDir(name)
    expect(await es().save()).toBe(false)
    expect(es().issues.join(' ')).toMatch(/Annotations folder/)
    expect(calls).toEqual([])
  })

  it('refuses a folder another project file next to it already uses', async () => {
    users = { shared: ['other.json'] }
    es().setAnnotationsDir('shared')
    expect(await es().save()).toBe(false)
    expect(es().issues.join(' ')).toMatch(/other\.json/)
  })

  it('moves the folder of an existing project before saving the new name', async () => {
    es().setAnnotationsDir('review-annotations')
    expect(await es().save()).toBe(true)
    expect(calls).toEqual(['move review-annotations', 'save review-annotations'])
    // Saved: saving again moves nothing.
    await es().save()
    expect(calls.slice(2)).toEqual(['save review-annotations'])
  })
})
