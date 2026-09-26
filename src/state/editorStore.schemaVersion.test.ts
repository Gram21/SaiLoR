import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SaveHandle } from '../platform/adapter'
import { loadProject } from '../model/project'

/**
 * A saved schema change is a new schema version, recording the renames and
 * moves whose answers should follow — and while that version has not left
 * this machine, further edits fold into it instead of piling up versions.
 */
let saved: string[] = []
let headText: string | null | undefined = undefined // undefined: not a repository
const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  openProject: async () => ({
    text: PROJECT,
    handle: { kind: 'electron' as const, path: '/r/review.json' },
    name: 'review.json',
  }),
  openRecent: async () => null,
  saveProject: async (t: string, h: SaveHandle) => {
    saved.push(t)
    return h
  },
  pickProjectLocation: async () => null,
  rebasePdfPaths: async (paths: string[]) => paths,
  getGit: () =>
    headText === undefined
      ? null
      : {
          info: async () => ({ root: '/r', relPath: 'review.json' }),
          headContent: async () => headText,
        },
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore, pendingSchemaMoves } = await import('./editorStore')
const es = () => useEditorStore.getState()

const PROJECT = JSON.stringify({
  version: 1,
  config: {
    reviewers: 2,
    schema: [
      { name: 'Kind', type: 'string' },
      { name: 'Group', children: [{ name: 'Inner', type: 'string' }] },
      { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
    ],
  },
  papers: [{ id: 'a', title: 'A', authors: [], pdf: 'a.pdf', annotations: {}, reviews: { 1: { Kind: [{ value: 'RCT' }] } } }],
})

const uidOf = (name: string) => {
  const walk = (nodes: ReturnType<typeof es>['nodes']): string | undefined => {
    for (const n of nodes) {
      if (n.name === name) return n.uid
      const inner = walk(n.children)
      if (inner) return inner
    }
  }
  return walk(es().nodes)!
}
const lastSaved = () => JSON.parse(saved[saved.length - 1])

beforeEach(async () => {
  saved = []
  headText = undefined
  await es().startEdit()
})

describe('pendingSchemaMoves', () => {
  it('sees a rename and a move into a single group, parents first', () => {
    es().updateNode(uidOf('Group'), { name: 'Section' })
    es().moveNode(uidOf('Kind'), uidOf('Section'), 'inside')
    const moves = pendingSchemaMoves(es().savedNodes, es().nodes, es().keepHidden)
    expect(moves.map(({ from, to, carried }) => ({ from, to, carried }))).toEqual([
      { from: ['Kind'], to: ['Section', 'Kind'], carried: true },
      { from: ['Group'], to: ['Section'], carried: true },
    ])
  })

  it('cannot carry answers out of a repeated group', () => {
    es().moveNode(uidOf('Claim'), uidOf('Kind'), 'after')
    const [move] = pendingSchemaMoves(es().savedNodes, es().nodes, es().keepHidden)
    expect(move).toMatchObject({ from: ['Findings', 'Claim'], to: ['Claim'], carried: false })
  })
})

describe('saving a changed schema', () => {
  it('records a new version with the rename, and the answers follow on load', async () => {
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    expect(await es().save()).toBe(true)
    const json = lastSaved()
    expect(json.schemaHistory).toHaveLength(1)
    expect(json.schemaHistory[0].moves).toEqual([{ from: ['Kind'], to: ['Design'] }])
    expect(loadProject(json).papers[0].reviews['1'].Design).toEqual([{ value: 'RCT' }])
  })

  it('records no move when the reviewer chose to keep the answers hidden', async () => {
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    es().setKeepHidden(uidOf('Design'), true)
    await es().save()
    expect(lastSaved().schemaHistory[0].moves).toEqual([])
    expect(loadProject(lastSaved()).papers[0].reviews['1'].Design).toEqual([{ value: null }])
  })

  it('does not change the version for a save that leaves the schema alone', async () => {
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    await es().save()
    const first = lastSaved().schemaVersion
    await es().save()
    expect(lastSaved().schemaVersion).toBe(first)
  })

  it('without git, folds an edit made within minutes into the same version', async () => {
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    await es().save()
    es().updateNode(uidOf('Design'), { name: 'Study design' })
    await es().save()
    const json = lastSaved()
    expect(json.schemaHistory).toHaveLength(1)
    expect(json.schemaHistory[0].moves).toEqual([
      { from: ['Kind'], to: ['Design'] },
      { from: ['Design'], to: ['Study design'] },
    ])
    expect(loadProject(json).papers[0].reviews['1']['Study design']).toEqual([{ value: 'RCT' }])
  })

  it('without git, starts a new version once the last one is older than six minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      es().updateNode(uidOf('Kind'), { name: 'Design' })
      await es().save()
      vi.setSystemTime(Date.now() + 7 * 60_000)
      es().updateNode(uidOf('Design'), { name: 'Study design' })
      await es().save()
      expect(lastSaved().schemaHistory).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('in a repository, folds edits into a version HEAD does not have yet', async () => {
    headText = null // the project was never committed
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    await es().save()
    es().updateNode(uidOf('Design'), { name: 'Study design' })
    await es().save()
    expect(lastSaved().schemaHistory).toHaveLength(1)
  })

  it('in a repository, starts a new version once the current one is committed', async () => {
    headText = null
    es().updateNode(uidOf('Kind'), { name: 'Design' })
    await es().save()
    headText = saved[saved.length - 1] // committed
    es().updateNode(uidOf('Design'), { name: 'Study design' })
    await es().save()
    const json = lastSaved()
    expect(json.schemaHistory).toHaveLength(2)
    expect(json.schemaHistory[1].parents).toEqual([json.schemaHistory[0].id])
  })
})
