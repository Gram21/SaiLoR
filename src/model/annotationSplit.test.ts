// [utest->req~plt-95~1]
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

  it('gives the reason for each decision', () => {
    const two = [project('/a.json', meta(['p'], { schemaVersion: 'va' })), project('/b.json', meta(['p'], { schema: [{ name: 'Outcome', type: 'string' }] }))]
    const reasons = (projects: SplitProject[], relPath: string, text: string) => planSplit(projects, [{ relPath, text }])[0]
    expect(reasons(two, 'gone/reviewer-1.json', '{}')).toMatchObject({
      targets: [],
      reason: 'No project here lists this paper for this kind of file.',
    })
    expect(reasons(two.slice(0, 1), 'p/reviewer-1.json', answers({}))).toMatchObject({
      targets: ['/a.json'],
      reason: 'Only this project lists this paper.',
    })
    expect(reasons(two, 'p/reviewer-1.json', '{ nope')).toMatchObject({
      targets: ['/a.json', '/b.json'],
      reason: 'The file cannot be read, so it is copied to each.',
    })
    expect(reasons(two, 'p/reviewer-1.json', answers({}, { schemaVersion: 'va' }))).toMatchObject({
      targets: ['/a.json'],
      reason: "Written under this project's schema version.",
    })
    expect(reasons(two, 'p/reviewer-1.json', answers({ Outcome: [{ value: 'x' }] }))).toMatchObject({
      targets: ['/b.json'],
      reason: "Its answers fit this project's schema best.",
    })
    expect(reasons(two, 'p/reviewer-1.json', answers({}))).toMatchObject({
      targets: ['/a.json', '/b.json'],
      reason: 'Nothing tells the projects apart, so it is copied to each.',
    })
  })

  it('knows every version in the history, absorbed ones included', () => {
    const history = [{ id: 'h1', parents: [], at: '', moves: [], absorbed: [{ id: 'h0', moves: 0 }] }]
    const projects = [project('/a.json', { ...(meta(['p']) as object), schemaHistory: history }), project('/b.json', meta(['p']))]
    const rows = planSplit(projects, [
      { relPath: 'p/reviewer-1.json', text: answers({}, { schemaVersion: 'h1' }) },
      { relPath: 'p/reviewer-2.json', text: answers({}, { schemaVersion: 'h0' }) },
    ])
    expect(rows.map((r) => r.targets)).toEqual([['/a.json'], ['/a.json']])
  })

  it('reads damaged project files and considers only the candidate projects', () => {
    const projects = [
      project('/a.json', { papers: [null, { id: 'p' }] }),
      project('/b.json', meta(['p'])),
      project('/c.json', meta(['q'], { schema: [{ name: 'Outcome', type: 'string' }] })),
    ]
    const [row] = planSplit(projects, [{ relPath: 'p/reviewer-1.json', text: answers({ Outcome: [{ value: 'x' }] }) }])
    expect(row.targets).toEqual(['/a.json', '/b.json'])
  })

  it('counts only recorded answers, nested ones included', () => {
    const projects = [
      project('/a.json', meta(['p'], { schema: [{ name: 'Design', type: 'string' }] })),
      project('/b.json', meta(['p'], { schema: [{ name: 'Outcome', type: 'string' }] })),
      project('/c.json', meta(['p'], { schema: [{ name: 'Findings', children: [{ name: 'Claim', type: 'string' }] }] })),
    ]
    const rows = planSplit(projects, [
      { relPath: 'p/reviewer-1.json', text: answers({ Design: [null, {}, { value: null }, { value: '' }], Outcome: [{ value: 'x' }] }) },
      { relPath: 'p/reviewer-2.json', text: answers({ Findings: [{ children: { Claim: [{ value: 'x' }] } }] }) },
      { relPath: 'p/reviewer-3.json', text: JSON.stringify({ annotations: null }) },
    ])
    expect(rows.map((r) => r.targets)).toEqual([['/b.json'], ['/c.json'], ['/a.json', '/b.json', '/c.json']])
  })

  it('lets the field links of a marks file decide between projects of either kind', () => {
    const projects = [
      project('/a.json', meta(['p'], { schema: [{ name: 'Findings', children: [{ name: 'Claim', type: 'string' }] }] })),
      project('/b.json', meta(['p'], { screening: true })),
    ]
    const links = (...paths: unknown[]) => ({ linkedFields: paths.map((path) => (path === null ? null : { path })) })
    const rows = planSplit(projects, [
      {
        relPath: 'p/marks-1.json',
        text: JSON.stringify({ marks: [links('Findings[0]/Claim'), {}, null, links(null, 5, 'Findings/Nope', 'A[')] }),
      },
      { relPath: 'p/marks-2.json', text: JSON.stringify({ marks: {} }) },
      { relPath: 'p/marks-3.json', text: JSON.stringify({ marks: [links('Other/Thing')] }) },
    ])
    expect(rows.map((r) => r.targets)).toEqual([['/a.json'], ['/a.json', '/b.json'], ['/a.json', '/b.json']])
  })

  it('gives screening highlight files to the screening project and unknown files to none', () => {
    const projects = [project('/screen.json', meta(['p'], { screening: true })), project('/review.json', meta(['p']))]
    const rows = planSplit(
      projects,
      ['screening-marks-1.json', 'screening-marks-12.json', 'screening-marks-1.json.bak', 'notes.json'].map((name) => ({
        relPath: `p/${name}`,
        text: '{}',
      })),
    )
    expect(rows.map((r) => r.candidates)).toEqual([['/screen.json'], ['/screen.json'], [], []])
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

  it('changes nothing when a later project file is malformed', async () => {
    const fs = memoryFs({
      'a.json': JSON.stringify({ version: 1 }),
      'b.json': '{ not json',
      'annotations/p/reviewer-1.json': 'A',
    })
    await expect(
      applySplit(
        {
          shared: 'annotations',
          projects: [
            { file: 'a.json', folder: 'a-annotations' },
            { file: 'b.json', folder: 'b-annotations' },
          ],
          rows: [{ relPath: 'p/reviewer-1.json', targets: ['a.json', 'b.json'] }],
        },
        fs,
      ),
    ).rejects.toThrow()
    expect(fs.log.filter((l) => !l.startsWith('read'))).toEqual([])
  })
})
