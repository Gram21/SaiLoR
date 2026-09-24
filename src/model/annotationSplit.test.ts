import { describe, it, expect } from 'vitest'
import { applySplit, planSplit, type SplitFs, type SplitProject } from './annotationSplit'

const meta = (
  ids: string[],
  opts: { screening?: boolean; schema?: object[]; schemaVersion?: string } = {},
): unknown => ({
  version: 1,
  ...(opts.schemaVersion
    ? { schemaVersion: opts.schemaVersion, schemaHistory: [{ id: opts.schemaVersion, parents: [], at: '', moves: [] }] }
    : {}),
  config: opts.screening ? { screening: { reasons: ['Off topic'] } } : { schema: opts.schema ?? [{ name: 'Note', type: 'string' }] },
  papers: ids.map((id) => ({ id, title: id, authors: [], pdf: `${id}.pdf` })),
})
const project = (path: string, m: unknown): SplitProject => ({ path, name: path.slice(1), meta: m })
const answers = (tree: object, extra: object = {}) => JSON.stringify({ ...extra, annotations: tree })

describe('planSplit', () => {
  it('gives a paper only one project has to that project', () => {
    const [row] = planSplit([project('/a.json', meta(['p'])), project('/b.json', meta(['q']))], [
      { relPath: 'p/reviewer-1.json', text: answers({}) },
    ])
    expect(row).toMatchObject({ targets: ['/a.json'], ambiguous: false })
  })

  it('tells a screening project from an annotation project by file name', () => {
    const projects = [project('/screen.json', meta(['p'], { screening: true })), project('/review.json', meta(['p']))]
    const rows = planSplit(projects, [
      { relPath: 'p/screening-1.json', text: '{}' },
      { relPath: 'p/reviewer-1.json', text: '{}' },
    ])
    expect(rows.map((r) => r.targets)).toEqual([['/screen.json'], ['/review.json']])
  })

  it('lets the schema version a file was written under decide between two of a kind', () => {
    const projects = [project('/a.json', meta(['p'], { schemaVersion: 'va' })), project('/b.json', meta(['p'], { schemaVersion: 'vb' }))]
    const [row] = planSplit(projects, [{ relPath: 'p/reviewer-1.json', text: answers({}, { schemaVersion: 'vb' }) }])
    expect(row).toMatchObject({ targets: ['/b.json'], ambiguous: true })
  })

  it('otherwise lets the schema the answers fit decide', () => {
    const projects = [
      project('/a.json', meta(['p'], { schema: [{ name: 'Design', type: 'string' }] })),
      project('/b.json', meta(['p'], { schema: [{ name: 'Outcome', type: 'string' }] })),
    ]
    const [row] = planSplit(projects, [{ relPath: 'p/reviewer-1.json', text: answers({ Outcome: [{ value: 'x' }] }) }])
    expect(row).toMatchObject({ targets: ['/b.json'], ambiguous: true })
  })

  it('copies a file nothing tells apart to each project', () => {
    const projects = [project('/a.json', meta(['p'])), project('/b.json', meta(['p']))]
    const [row] = planSplit(projects, [{ relPath: 'p/reviewer-1.json', text: answers({ Note: [{ value: 'x' }] }) }])
    expect(row.targets).toEqual(['/a.json', '/b.json'])
  })

  it('leaves a file no project here owns where it is', () => {
    const [row] = planSplit([project('/a.json', meta(['p']))], [{ relPath: 'gone/reviewer-1.json', text: '{}' }])
    expect(row.targets).toEqual([])
  })
})

/** An in-memory project directory that records the order of what was done. */
function memoryFs(files: Record<string, string>): SplitFs & { files: Record<string, string>; log: string[] } {
  const fs = {
    files: { ...files },
    log: [] as string[],
    copy: async (from: string, to: string) => {
      fs.log.push(`copy ${from} ${to}`)
      fs.files[to] = fs.files[from]
    },
    readText: async (file: string) => fs.files[file],
    writeText: async (file: string, text: string) => {
      fs.log.push(`write ${file}`)
      fs.files[file] = text
    },
    remove: async (file: string) => {
      fs.log.push(`remove ${file}`)
      delete fs.files[file]
    },
    removeDirIfEmpty: async (dir: string) => {
      if (!Object.keys(fs.files).some((f) => f.startsWith(`${dir}/`))) fs.log.push(`rmdir ${dir}`)
    },
  }
  return fs
}

describe('applySplit', () => {
  it('copies, then points each project file at its folder, then removes the originals', async () => {
    const fs = memoryFs({
      'a.json': JSON.stringify({ version: 1, papers: [] }),
      'b.json': JSON.stringify({ version: 1, papers: [] }),
      'annotations/p/reviewer-1.json': 'A',
      'annotations/q/reviewer-1.json': 'both',
      'annotations/x/reviewer-1.json': 'nobody',
    })
    await applySplit(
      {
        shared: 'annotations',
        projects: [
          { file: 'a.json', folder: 'a-annotations' },
          { file: 'b.json', folder: 'b-annotations' },
        ],
        rows: [
          { relPath: 'p/reviewer-1.json', targets: ['a.json'] },
          { relPath: 'q/reviewer-1.json', targets: ['a.json', 'b.json'] },
          { relPath: 'x/reviewer-1.json', targets: [] },
        ],
      },
      fs,
    )
    expect(fs.files['a-annotations/p/reviewer-1.json']).toBe('A')
    expect(fs.files['a-annotations/q/reviewer-1.json']).toBe('both')
    expect(fs.files['b-annotations/q/reviewer-1.json']).toBe('both')
    expect(fs.files['annotations/x/reviewer-1.json']).toBe('nobody')
    expect(fs.files['annotations/p/reviewer-1.json']).toBeUndefined()
    expect(JSON.parse(fs.files['a.json']).annotationsDir).toBe('a-annotations')
    expect(JSON.parse(fs.files['b.json']).annotationsDir).toBe('b-annotations')
    const firstWrite = fs.log.findIndex((l) => l.startsWith('write'))
    const lastCopy = fs.log.map((l) => l.startsWith('copy')).lastIndexOf(true)
    const firstRemove = fs.log.findIndex((l) => l.startsWith('remove'))
    expect(lastCopy).toBeLessThan(firstWrite)
    expect(fs.log.map((l) => l.startsWith('write')).lastIndexOf(true)).toBeLessThan(firstRemove)
    expect(fs.log).toContain('rmdir annotations/p')
    expect(fs.log).not.toContain('rmdir annotations')
  })

  it('stops before touching anything when a target has no folder', async () => {
    const fs = memoryFs({ 'a.json': '{}', 'annotations/p/reviewer-1.json': 'A' })
    await expect(
      applySplit({ shared: 'annotations', projects: [], rows: [{ relPath: 'p/reviewer-1.json', targets: ['a.json'] }] }, fs),
    ).rejects.toThrow(/No folder/)
    expect(fs.log).toEqual([])
  })
})
