import { describe, it, expect } from 'vitest'
import {
  amendVersion,
  moveInMarks,
  moveInTree,
  parseSchemaHistory,
  pendingMoves,
  type SchemaHistoryEntry,
} from './schemaVersion'
import type { PdfMark } from './pdfMarks'
import { loadProject, serializeProject, splitProjectFiles, projectFromFiles } from './project'

const entry = (id: string, parents: string[], moves: SchemaHistoryEntry['moves'] = []): SchemaHistoryEntry => ({
  id,
  parents,
  at: '2026-09-23T10:00:00.000Z',
  moves,
})
const mv = (from: string, to: string) => ({ from: from.split('/'), to: to.split('/') })

describe('pendingMoves', () => {
  const history = [entry('a', [], [mv('X', 'Y')]), entry('b', ['a'], [mv('Y', 'Z')])]

  it('gives a file at the current version nothing, and one before versions everything', () => {
    expect(pendingMoves(history, 'b', 'b')).toEqual([])
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

  it('gives a file stamped with a folded-in version only the moves it has not seen', () => {
    const amended = amendVersion(history, 'b', [mv('Z', 'W')], '2026-09-23T10:05:00.000Z')!
    expect(amended.history.map((e) => e.id)).toEqual(['a', amended.id])
    expect(pendingMoves(amended.history, 'b', amended.id)).toEqual([mv('Z', 'W')])
    expect(pendingMoves(amended.history, 'a', amended.id)).toEqual([mv('Y', 'Z'), mv('Z', 'W')])
    // …and the fold survives a save and reload of the history.
    expect(parseSchemaHistory(JSON.parse(JSON.stringify(amended.history)))).toEqual(amended.history)
  })
})

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
  })
})

describe('moveInMarks', () => {
  it('rewrites a linked field path, keeping the entry index', () => {
    const mark = { id: 'm', linkedFields: [{ path: 'Findings[2]/Claim', label: 'Claim' }] } as unknown as PdfMark
    const [moved] = moveInMarks([mark], mv('Findings/Claim', 'Findings/Statement'))
    expect(moved.linkedFields![0].path).toBe('Findings[2]/Statement')
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

  it('carries the answers across the renames made since', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file('v1', 'kept')]])
    expect(project.papers[0].reviews['1'].New).toEqual([{ value: 'kept' }])
  })

  it('treats a file with no version as older than every recorded move', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file(undefined, 'old')]])
    expect(project.papers[0].reviews['1'].New).toEqual([{ value: 'old' }])
  })

  it('leaves a file of an unknown version alone, and says so', () => {
    const project = projectFromFiles(meta([mv('Old', 'New')]), [['p/reviewer-1.json', file('stranger', 'x')]])
    expect(project.papers[0].unknownSchemaFiles).toEqual(['review-1'])
    expect(project.papers[0].reviews['1'].Old).toEqual([{ value: 'x' }])
  })

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
