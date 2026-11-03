import { describe, it, expect } from 'vitest'
import { resolveSchema, SchemaError, type AnnotationDef } from './schema'
import type { AnnotationValueTree } from './annotations'
import { dropDuplicateSuggestions, duplicateIndexes, duplicateOnWrite } from './unique'
import { validatePaper } from './validate'
import { dehydrateSchema, type Paper } from './project'

const raw: AnnotationDef[] = [
  { name: 'Keywords', type: 'string', min: 0, max: null, unique: true },
  { name: 'Venue', type: 'string', options: ['ICSE', 'FSE'], min: 0, max: null, unique: true },
  {
    name: 'Authors',
    min: 0,
    max: null,
    unique: true,
    uniqueBy: ['Name'],
    children: [
      { name: 'Name', type: 'string' },
      { name: 'Role', type: 'string' },
    ],
  },
  {
    name: 'Pairs',
    min: 0,
    max: null,
    unique: true,
    children: [
      { name: 'A', type: 'string' },
      { name: 'B', type: 'string' },
    ],
  },
  { name: 'Tags', type: 'string', min: 0, max: null },
]
const schema = resolveSchema(raw)
const kw = schema[0]

function tree(over: AnnotationValueTree = {}): AnnotationValueTree {
  return { Keywords: [], Venue: [], Authors: [], Pairs: [], Tags: [], ...over }
}

// [utest->req~dat-400~1]
describe('unique schema option', () => {
  it('resolves unique and uniqueBy, and leaves other nodes unchanged', () => {
    expect(kw.unique).toBe(true)
    expect(schema[2].uniqueBy).toEqual(['Name'])
    expect('unique' in schema[4]).toBe(false)
  })

  it('keeps unique and uniqueBy through save and load', () => {
    expect(resolveSchema(dehydrateSchema(schema) as AnnotationDef[])).toEqual(schema)
  })

  it.each<[string, AnnotationDef, RegExp]>([
    [
      'unique on a non-repeatable node',
      { name: 'G', children: [{ name: 'X', type: 'string', unique: true }] },
      /"G\/X": "unique" is only allowed on a repeatable node/,
    ],
    [
      'uniqueBy without unique',
      { name: 'G', max: null, uniqueBy: ['X'], children: [{ name: 'X', type: 'string' }] },
      /"G": "uniqueBy" needs "unique": true/,
    ],
    [
      'uniqueBy on a leaf',
      { name: 'L', type: 'string', max: null, unique: true, uniqueBy: ['X'] },
      /"L": "uniqueBy" is only allowed on a node with "children"/,
    ],
    [
      'unknown uniqueBy name',
      {
        name: 'G',
        max: null,
        unique: true,
        uniqueBy: ['Nope'],
        children: [{ name: 'X', type: 'string' }],
      },
      /"G": "uniqueBy" names unknown child field\(s\): "Nope"/,
    ],
  ])('rejects %s with a path message', (_label, def, message) => {
    expect(() => resolveSchema([def])).toThrow(SchemaError)
    expect(() => resolveSchema([def])).toThrow(message)
  })
})

// [utest->req~dat-400~1]
describe('duplicateIndexes', () => {
  it('compares free text trimmed and case-insensitive, and skips empty entries', () => {
    const list = [
      { value: 'Deep  Learning' },
      { value: '' },
      { value: ' deep learning ' },
      { value: '' },
    ]
    expect(duplicateIndexes(kw, list)).toEqual([[2, 0]])
  })

  it('compares choices exactly', () => {
    expect(duplicateIndexes(schema[1], [{ value: 'ICSE' }, { value: 'FSE' }])).toEqual([])
    expect(duplicateIndexes(schema[1], [{ value: 'ICSE' }, { value: 'ICSE' }])).toEqual([[1, 0]])
  })

  it('compares only the uniqueBy fields of a group', () => {
    const entry = (name: string, role: string) => ({
      children: { Name: [{ value: name }], Role: [{ value: role }] },
    })
    expect(duplicateIndexes(schema[2], [entry('Ada', 'first'), entry('ADA', 'last')])).toEqual([
      [1, 0],
    ])
  })

  it('compares all fields of a group without uniqueBy', () => {
    const entry = (a: string, b: string) => ({ children: { A: [{ value: a }], B: [{ value: b }] } })
    expect(duplicateIndexes(schema[3], [entry('x', 'y'), entry('x', 'z')])).toEqual([])
    expect(duplicateIndexes(schema[3], [entry('x', 'y'), entry('X', 'y')])).toEqual([[1, 0]])
  })
})

describe('duplicateOnWrite', () => {
  const t = tree({ Keywords: [{ value: 'NLP' }, { value: 'ML' }] })

  it('refuses a write that repeats another entry', () => {
    expect(duplicateOnWrite(schema, t, [{ name: 'Keywords', index: 1 }], ' nlp')).toMatch(
      /"Keywords" already has this entry \(#1\)/,
    )
  })

  it('refuses a new entry past the end that repeats another entry', () => {
    expect(duplicateOnWrite(schema, t, [{ name: 'Keywords', index: 3 }], 'ml')).not.toBeNull()
  })

  it('allows a distinct value, an empty value, and nodes without unique', () => {
    expect(duplicateOnWrite(schema, t, [{ name: 'Keywords', index: 1 }], 'NLP2')).toBeNull()
    expect(duplicateOnWrite(schema, t, [{ name: 'Keywords', index: 1 }], '')).toBeNull()
    const tags = tree({ Tags: [{ value: 'a' }, { value: 'b' }] })
    expect(duplicateOnWrite(schema, tags, [{ name: 'Tags', index: 1 }], 'a')).toBeNull()
  })

  it('does not block an edit that leaves an existing repeat unchanged', () => {
    const entry = (name: string, role: string) => ({
      children: { Name: [{ value: name }], Role: [{ value: role }] },
    })
    const both = tree({ Authors: [entry('Ada', ''), entry('Ada', '')] })
    const segs = [
      { name: 'Authors', index: 1 },
      { name: 'Role', index: 0 },
    ]
    expect(duplicateOnWrite(schema, both, segs, 'last')).toBeNull()
    const other = tree({ Authors: [entry('Ada', ''), entry('Bob', '')] })
    expect(
      // [utest->req~dat-410~1]
      duplicateOnWrite(
        schema,
        other,
        [
          { name: 'Authors', index: 1 },
          { name: 'Name', index: 0 },
        ],
        'ada',
      ),
    ).not.toBeNull()
  })
})

// [utest->req~dat-410~1]
describe('dropDuplicateSuggestions', () => {
  it('drops suggestions that repeat the tree or an earlier suggestion', () => {
    const t = tree({ Keywords: [{ value: 'NLP' }] })
    const s = (path: string, value: string) => ({ path, value })
    const { kept, dropped } = dropDuplicateSuggestions(schema, t, [
      s('Keywords[1]', 'nlp'),
      s('Keywords[1]', 'ML'),
      s('Keywords[2]', 'ml'),
      s('Tags[0]', 'x'),
    ])
    expect(kept.map((k) => k.value)).toEqual(['ML', 'x'])
    expect(dropped.map((d) => d.suggestion.path)).toEqual(['Keywords[1]', 'Keywords[2]'])
  })
})

// [utest->req~dat-420~1]
describe('validatePaper duplicate issues', () => {
  it('reports each repeated entry of a unique node', () => {
    const paper = {
      id: 'p1',
      title: 'One',
      annotations: tree({
        Keywords: [{ value: 'NLP' }, { value: 'nlp' }],
        Tags: [{ value: 'a' }, { value: 'a' }],
      }),
    } as unknown as Paper
    const issues = validatePaper(schema, paper).filter((i) => i.kind === 'duplicate')
    expect(issues).toHaveLength(1)
    expect(issues[0].canonicalPath).toBe('Keywords[1]')
    expect(issues[0].message).toMatch(/repeats #1/)
  })
})
