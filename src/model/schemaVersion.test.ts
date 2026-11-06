import { describe, it, expect } from 'vitest'
import {
  amendVersion,
  ancestorsOf,
  moveInDefs,
  moveInMarks,
  moveInTree,
  parseSchemaHistory,
  parseSchemaVersion,
  pendingMoves,
  type SchemaHistoryEntry,
} from './schemaVersion'
import type { PdfMark } from './pdfMarks'
import type { ResolvedDef } from './schema'
import { loadProject, serializeProject, splitProjectFiles, projectFromFiles } from './project'

const entry = (id: string, parents: string[], moves: SchemaHistoryEntry['moves'] = []): SchemaHistoryEntry => ({
  id,
  parents,
  at: '2026-09-23T10:00:00.000Z',
  moves,
})
const mv = (from: string, to: string) => ({ from: from.split('/'), to: to.split('/') })

// [utest->req~dat-167~1]
describe('pendingMoves', () => {
  const history = [entry('a', [], [mv('X', 'Y')]), entry('b', ['a'], [mv('Y', 'Z')])]

  it('gives a file at the current version nothing, and one before versions everything', () => {
    expect(pendingMoves(history, 'b', 'b')).toEqual([])
    expect(pendingMoves(history, undefined, 'b')).toEqual([])
    expect(pendingMoves(history, 'x', 'x')).toEqual([])
    expect(pendingMoves(history, null, 'b')).toEqual([mv('X', 'Y'), mv('Y', 'Z')])
  })

  it('gives a file only the moves after its own version', () => {
    expect(pendingMoves(history, 'a', 'b')).toEqual([mv('Y', 'Z')])
  })

  it('calls a version it has never heard of unknown', () => {
    expect(pendingMoves(history, 'elsewhere', 'b')).toBe('unknown')
  })

  it('follows both branches of a merge', () => {
    const merged = [
      entry('base', []),
      entry('ours', ['base'], [mv('A', 'B')]),
      entry('theirs', ['base'], [mv('C', 'D')]),
      entry('m', ['ours', 'theirs']),
    ]
    expect(pendingMoves(merged, 'theirs', 'm')).toEqual([mv('A', 'B')])
    expect(pendingMoves(merged, 'ours', 'm')).toEqual([mv('C', 'D')])
  })

  // [utest->req~edt-42~1]
  it('gives a file stamped with a folded-in version only the moves it has not seen', () => {
    const amended = amendVersion(history, 'b', [mv('Z', 'W')], '2026-09-23T10:05:00.000Z')!
    expect(amended.history.map((e) => e.id)).toEqual(['a', amended.id])
    expect(pendingMoves(amended.history, 'b', amended.id)).toEqual([mv('Z', 'W')])
    expect(pendingMoves(amended.history, 'a', amended.id)).toEqual([mv('Y', 'Z'), mv('Z', 'W')])
    // …and the fold survives a save and reload of the history.
    expect(parseSchemaHistory(JSON.parse(JSON.stringify(amended.history)))).toEqual(amended.history)
  })

  // [utest->req~edt-42~1]
  it('gives a file stamped with a folded-in version the moves of later versions too', () => {
    const amended = amendVersion(history, 'b', [mv('Z', 'W')], '2026-09-23T10:05:00.000Z')!
    const later = [...amended.history, entry('d', [amended.id], [mv('W', 'V')])]
    expect(pendingMoves(later, 'b', 'd')).toEqual([mv('Z', 'W'), mv('W', 'V')])
  })

  it('cannot amend a version the history does not have', () => {
    expect(amendVersion(history, 'nope', [mv('Z', 'W')], '2026-09-23T10:05:00.000Z')).toBeNull()
  })
})

// [utest->req~dat-166~1]
describe('ancestorsOf', () => {
  const sorted = (s: Set<string>) => [...s].sort()

  it('includes the folded-in versions and tolerates unknown ids', () => {
    const amended = amendVersion([entry('a', []), entry('b', ['a'])], 'b', [], '2026-09-23T10:05:00.000Z')!
    expect(sorted(ancestorsOf(amended.history, amended.id))).toEqual(['a', 'b', amended.id].sort())
    expect(sorted(ancestorsOf([entry('a', ['gone'])], 'a'))).toEqual(['a', 'gone'])
    expect(sorted(ancestorsOf([], 'x'))).toEqual(['x'])
  })

  it('stops on a cycle in a damaged history', () => {
    expect(sorted(ancestorsOf([entry('a', ['b']), entry('b', ['a'])], 'a'))).toEqual(['a', 'b'])
  })
})

describe('parsing the stored history', () => {
  it('drops the entries, moves and folds it cannot read', () => {
    const raw = [
      null,
      'x',
      { id: '' },
      { id: 7 },
      {
        id: 'a',
        parents: ['p', 3],
        at: 5,
        moves: [
          { from: ['A'], to: ['B'] },
          { from: [], to: ['B'] },
          { from: ['A', ''], to: ['B'] },
          { from: ['A', 1], to: ['B'] },
          { from: 'A', to: ['B'] },
          { from: ['A'] },
          null,
        ],
        absorbed: [{ id: 'x', moves: 2.7 }, { id: 'y', moves: -1 }, { id: 3, moves: 1 }, { id: 'z', moves: '1' }, null],
      },
      { id: 'b', parents: 'a', at: '2026-09-23', moves: 'no', absorbed: [{ id: 3, moves: 1 }] },
    ]
    expect(parseSchemaHistory(raw)).toStrictEqual([
      { id: 'a', absorbed: [{ id: 'x', moves: 2 }], parents: ['p'], at: '', moves: [{ from: ['A'], to: ['B'] }] },
      { id: 'b', parents: [], at: '2026-09-23', moves: [] },
    ])
    expect(parseSchemaHistory({})).toEqual([])
  })

  it('reads a version id only from a non-empty string', () => {
    expect(parseSchemaVersion('v1')).toBe('v1')
    expect(parseSchemaVersion('')).toBeNull()
    expect(parseSchemaVersion(3)).toBeNull()
  })
})

// [utest->req~dat-167~1]
describe('moveInTree', () => {
  it('renames a field', () => {
    expect(moveInTree({ Old: [{ value: 'x' }] }, mv('Old', 'New'))).toEqual({ New: [{ value: 'x' }] })
  })

  it('renames a group, children and all, in every repeated entry of their shared parent', () => {
    const tree = { R: [{ children: { G: [{ children: { f: [{ value: 1 }] } }] } }, { children: { G: [{ children: { f: [{ value: 2 }] } }] } }] }
    expect(moveInTree(tree, mv('R/G', 'R/H'))).toEqual({
      R: [{ children: { H: [{ children: { f: [{ value: 1 }] } }] } }, { children: { H: [{ children: { f: [{ value: 2 }] } }] } }],
    })
  })

  it('moves a field into a single group, creating it', () => {
    expect(moveInTree({ f: [{ value: 'x' }] }, mv('f', 'G/f'))).toEqual({ G: [{ children: { f: [{ value: 'x' }] } }] })
  })

  it('leaves the answers where they are when they would have to pass through repeated entries', () => {
    const tree = { R: [{ children: { f: [{ value: 1 }] } }, { children: { f: [{ value: 2 }] } }] }
    expect(moveInTree(tree, mv('R/f', 'f'))).toEqual(tree)
  })

  it('does not overwrite answers already at the destination', () => {
    const tree = { Old: [{ value: 'a' }], New: [{ value: 'b' }] }
    expect(moveInTree(tree, mv('Old', 'New'))).toEqual(tree)
    const repeated = { Old: [{ value: 'a' }], New: [{ value: '' }, { value: 'b' }] }
    expect(moveInTree(repeated, mv('Old', 'New'))).toEqual(repeated)
  })

  it('leaves a missing tree or a missing source as it is', () => {
    expect(moveInTree(undefined, mv('Old', 'New'))).toBeUndefined()
    expect(moveInTree({}, mv('R/G', 'R/H'))).toEqual({})
    expect(moveInTree({ x: [{ value: 1 }] }, mv('G/f', 'H/f'))).toEqual({ x: [{ value: 1 }] })
    expect(moveInTree({ x: [{ value: 1 }] }, mv('Old', 'New'))).toStrictEqual({ x: [{ value: 1 }] })
    const noField = { G: [{ children: { g: [{ value: 'y' }] } }] }
    expect(moveInTree(noField, mv('G/f', 'f'))).toEqual(noField)
  })

  it('moves a field out of a single group, keeping its siblings', () => {
    expect(moveInTree({ G: [{ children: { f: [{ value: 'x' }], g: [{ value: 'y' }] } }] }, mv('G/f', 'f'))).toEqual({
      G: [{ children: { g: [{ value: 'y' }] } }],
      f: [{ value: 'x' }],
    })
  })

  it('moves a field from one group to another', () => {
    expect(moveInTree({ A: [{ children: { f: [{ value: 'x' }] } }] }, mv('A/f', 'B/f'))).toEqual({
      A: [{ children: {} }],
      B: [{ children: { f: [{ value: 'x' }] } }],
    })
  })

  it('moves a field into an existing single group, or creates it when the group has no entry', () => {
    expect(moveInTree({ f: [{ value: 'x' }], G: [{ children: { g: [{ value: 'y' }] } }] }, mv('f', 'G/f'))).toEqual({
      G: [{ children: { g: [{ value: 'y' }], f: [{ value: 'x' }] } }],
    })
    expect(moveInTree({ f: [{ value: 'x' }], G: [] }, mv('f', 'G/f'))).toEqual({ G: [{ children: { f: [{ value: 'x' }] } }] })
    const repeated = { f: [{ value: 'x' }], G: [{ children: {} }, { children: {} }] }
    expect(moveInTree(repeated, mv('f', 'G/f'))).toEqual(repeated)
  })

  it('turns a field into a group of the same name and back', () => {
    expect(moveInTree({ x: [{ value: 1 }] }, mv('x', 'x/y'))).toEqual({ x: [{ children: { y: [{ value: 1 }] } }] })
    expect(moveInTree({ x: [{ children: { y: [{ value: 1 }] } }] }, mv('x/y', 'x'))).toEqual({ x: [{ value: 1 }] })
  })
})

describe('moveInMarks', () => {
  const marks = (...paths: string[]) => [
    { id: 'plain' },
    { id: 'm', linkedFields: paths.map((path) => ({ path, label: 'L' })) },
  ] as unknown as PdfMark[]
  const paths = (list: PdfMark[]) => list.flatMap((m) => (m.linkedFields ?? []).map((l) => l.path))

  it('rewrites a linked field path, keeping the entry index', () => {
    const mark = { id: 'm', linkedFields: [{ path: 'Findings[2]/Claim', label: 'Claim' }] } as unknown as PdfMark
    const [moved] = moveInMarks([mark], mv('Findings/Claim', 'Findings/Statement'))
    expect(moved.linkedFields![0].path).toBe('Findings[2]/Statement')
  })

  it('leaves unrelated, shorter and unreadable paths, and returns the same list when nothing moved', () => {
    const list = marks('Other/Claim', 'Findings', '')
    expect(paths(moveInMarks(list, mv('Findings/Claim', 'Findings/Statement')))).toEqual(['Other/Claim', 'Findings', ''])
    expect(moveInMarks(list, mv('Findings/Claim', 'Findings/Statement'))).toBe(list)
  })

  it('moves only links through the first entry of a group, keeping the final index', () => {
    expect(paths(moveInMarks(marks('G/f[2]', 'G[1]/f'), mv('G/f', 'f')))).toEqual(['f[2]', 'G[1]/f'])
    expect(paths(moveInMarks(marks('f[2]'), mv('f', 'G/f')))).toEqual(['G/f[2]'])
  })
})

describe('moveInDefs', () => {
  const def = (name: string, children: ResolvedDef[] = []) =>
    ({ id: name, name, min: 0, max: 1, required: false, children }) as ResolvedDef
  const names = (list: ResolvedDef[]): unknown[] => list.map((d) => (d.children.length ? [d.name, names(d.children)] : d.name))

  it('renames a top-level node, appending it', () => {
    expect(names(moveInDefs([def('A'), def('B')], mv('A', 'C')))).toEqual(['B', 'C'])
  })

  it('moves a nested node into another group', () => {
    const defs = [def('G', [def('f'), def('g')]), def('H', [def('h')]), def('K', [def('f')])]
    expect(names(moveInDefs(defs, mv('G/f', 'H/f')))).toEqual([['G', ['g']], ['H', ['h', 'f']], ['K', ['f']]])
  })

  it('leaves the schema alone when the source is missing, the target exists or has no parent', () => {
    const defs = [def('G', [def('f')]), def('H', [def('f')])]
    expect(moveInDefs(defs, mv('G/x', 'H/x'))).toBe(defs)
    expect(moveInDefs(defs, mv('G/f', 'H/f'))).toBe(defs)
    expect(moveInDefs(defs, mv('X/f', 'H/y'))).toBe(defs)
    expect(moveInDefs(defs, mv('G/f', 'X/f'))).toBe(defs)
    expect(moveInDefs(defs, mv('G/f', 'H/X/f'))).toBe(defs)
  })
})

describe('loading files written under an older schema version', () => {
  const meta = (moves: SchemaHistoryEntry['moves']) => ({
    version: 1,
    schemaVersion: 'v2',
    schemaHistory: [entry('v1', []), entry('v2', ['v1'], moves)],
    config: { reviewers: 2, schema: [{ name: 'New', type: 'string' }] },
    papers: [{ id: 'p', title: 'P', authors: [], pdf: 'p.pdf' }],
  })
  const file = (schemaVersion: string | undefined, value: string) =>
    JSON.stringify({ ...(schemaVersion ? { schemaVersion } : {}), annotations: { Old: [{ value }] } })

  // [utest->req~dat-167~1]
  it('carries the answers across the renames made since', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file('v1', 'kept')]])
    expect(project.papers[0].reviews['1'].New).toEqual([{ value: 'kept' }])
  })

  it('treats a file with no version as older than every recorded move', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file(undefined, 'old')]])
    expect(project.papers[0].reviews['1'].New).toEqual([{ value: 'old' }])
  })

  // [utest->req~dat-168~1]
  it('leaves a file of an unknown version alone, and says so', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file('stranger', 'x')]])
    expect(project.papers[0].unknownSchemaFiles).toEqual(['review-1'])
    expect(project.papers[0].reviews['1'].Old).toEqual([{ value: 'x' }])
  })

  // [utest->req~dat-166~1]
  it('stamps every file it writes, and reading its own text back moves nothing again', () => {
    // Old → New, then a new "Old" added: moving twice would wrongly move the new one too.
    const m = { ...meta([mv('Old', 'New')]), config: { reviewers: 2, schema: [{ name: 'New', type: 'string' }, { name: 'Old', type: 'string' }] } }
    const project = projectFromFiles(m, [['p/reviewer-1.json', file('v1', 'first')]])
    const again = loadProject(serializeProject(project))
    expect(again.papers[0].reviews['1'].New).toEqual([{ value: 'first' }])
    const { files } = splitProjectFiles(project)
    expect(JSON.parse(files.find((f) => f.relPath === 'p/reviewer-1.json')!.text!).schemaVersion).toBe('v2')
  })
})
