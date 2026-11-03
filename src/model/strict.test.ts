import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject, splitProjectFiles, ProjectLoadError } from './project'
import {
  parseStrictConfig,
  strictConfigJson,
  strictActive,
  assignedSeat,
  personPapers,
  missingFinishers,
  personCounts,
  bulkAssign,
  type StrictConfig,
} from './strict'

const schema = [{ name: 'Relevant', type: 'boolean' }]
const papers = [
  { id: 'a', title: 'A', authors: [], pdf: 'a.pdf' },
  { id: 'b', title: 'B', authors: [], pdf: 'b.pdf' },
  { id: 'c', title: 'C', authors: [], pdf: 'c.pdf' },
]
const persons = [
  { id: 'p1', name: 'Ann' },
  { id: 'p2', name: 'Bob' },
  { id: 'p3', name: 'Cid' },
]

function file(config: Record<string, unknown>) {
  return JSON.stringify({ version: 1, config: { schema, reviewers: 2, ...config }, papers })
}

function loadError(config: Record<string, unknown>): string[] {
  try {
    loadProject(file(config))
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectLoadError)
    return (err as ProjectLoadError).details
  }
  throw new Error('expected a load error')
}

describe('strict config on load', () => {
  it('leaves a project without strict keys unchanged', () => {
    const text = serializeProject(loadProject(file({})))
    const p = loadProject(text)
    expect(p.strict).toBeUndefined()
    expect(JSON.parse(text).config).toEqual({ schema: expect.any(Array), reviewers: 2 })
  })

  it('round-trips persons and assignments through both file formats', () => {
    const config = {
      strict: true,
      persons,
      assignments: { b: [{ person: 'p2', seat: 2 }, { person: 'p1', seat: 1 }] },
    }
    const p = loadProject(file(config))
    expect(p.strict).toEqual({
      enabled: true,
      persons,
      assignments: { b: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }] },
    })
    const written = JSON.parse(serializeProject(p)).config
    expect(written.strict).toBe(true)
    expect(written.persons).toEqual(persons)
    expect(written.assignments).toEqual({ b: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }] })
    const meta = splitProjectFiles(p).meta as { config: Record<string, unknown> }
    expect(meta.config.assignments).toEqual(written.assignments)
  })

  it('lists every problem in the strict keys', () => {
    expect(loadError({ strict: 'yes' })).toContain('config.strict must be true or false.')
    expect(loadError({ persons: {} })).toContain('config.persons must be a list.')
    expect(loadError({ persons: [{ id: '', name: 'X' }] })[0]).toMatch(/non-empty/)
    expect(loadError({ persons: [persons[0], { id: 'p1', name: 'Other' }] })).toContain(
      'Person id "p1" appears more than once.',
    )
    expect(loadError({ persons: [persons[0], { id: 'p9', name: ' ann ' }] })).toContain(
      'Person name "ann" appears more than once.',
    )
    expect(loadError({ persons, assignments: { a: [{ person: 'zz', seat: 1 }] } })[0]).toMatch(/unknown person/)
    expect(loadError({ persons, assignments: { a: [{ person: 'p1', seat: 0 }] } })[0]).toMatch(/positive whole/)
    expect(
      loadError({ persons, assignments: { a: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 1 }] } }),
    ).toContain('Paper "a" assigns seat 1 twice.')
    expect(
      loadError({ persons, assignments: { a: [{ person: 'p1', seat: 1 }, { person: 'p1', seat: 2 }] } }),
    ).toContain('Paper "a" assigns person "p1" twice.')
  })

  it('drops assignments for unknown papers and keeps seats above the reviewer count', () => {
    const { strict, problems } = parseStrictConfig(
      { persons, assignments: { gone: [{ person: 'p1', seat: 1 }], a: [{ person: 'p1', seat: 3 }] } },
      new Set(['a']),
    )
    expect(problems).toEqual([])
    expect(strict?.assignments).toEqual({ a: [{ person: 'p1', seat: 3 }] })
    expect(strict?.enabled).toBe(false)
  })

  it('writes only the keys that hold a value', () => {
    expect(strictConfigJson(undefined)).toEqual({})
    expect(strictConfigJson({ enabled: false, persons: [], assignments: { a: [] } })).toEqual({})
  })
})

describe('strict helpers', () => {
  const strict: StrictConfig = {
    enabled: true,
    persons,
    assignments: {
      a: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }],
      b: [{ person: 'p1', seat: 2 }, { person: 'p3', seat: 3 }],
    },
  }
  const project = {
    strict,
    reviewers: 2,
    screening: null,
    papers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
  }

  it('is active only for multi-reviewer annotation projects with persons', () => {
    expect(strictActive(project)).toBe(true)
    expect(strictActive({ ...project, reviewers: 1 })).toBe(false)
    expect(strictActive({ ...project, screening: { reasons: [] } as never })).toBe(false)
    expect(strictActive({ ...project, strict: { ...strict, enabled: false } })).toBe(false)
    expect(strictActive({ ...project, strict: { ...strict, persons: [] } })).toBe(false)
  })

  it('finds the seat and the visible papers of a person', () => {
    expect(assignedSeat(project, 'b', 'p1')).toBe('2')
    expect(assignedSeat(project, 'c', 'p1')).toBeNull()
    expect(personPapers(project, 'p1')).toEqual(['a', 'b'])
    expect(personPapers(project, 'p3')).toEqual([])
  })

  it('lists the persons who have not finished a paper', () => {
    expect(missingFinishers(project, { id: 'a', reviewsFinished: { '1': true } }).map((p) => p.name)).toEqual([
      'Bob',
    ])
    expect(missingFinishers(project, { id: 'a', reviewsFinished: { '1': true, '2': true } })).toEqual([])
    expect(missingFinishers(project, { id: 'c', reviewsFinished: {} })).toEqual([])
  })

  it('counts assigned and finished papers per person', () => {
    const counts = personCounts(strict, 2, (key, seat) => key === 'a' && seat === 1)
    expect(counts).toEqual({ p1: { assigned: 2, finished: 1 }, p2: { assigned: 1, finished: 0 }, p3: { assigned: 0, finished: 0 } })
  })

  it('assigns in turn over the persons and fills only papers without assignments', () => {
    const out = bulkAssign(persons, ['a', 'b', 'c', 'd'], { b: [{ person: 'p3', seat: 1 }] }, 2, [1, 2])
    expect(out).toEqual({
      a: [{ person: 'p1', seat: 1 }, { person: 'p2', seat: 2 }],
      b: [{ person: 'p3', seat: 1 }],
      c: [{ person: 'p3', seat: 1 }, { person: 'p1', seat: 2 }],
      d: [{ person: 'p2', seat: 1 }, { person: 'p3', seat: 2 }],
    })
    expect(bulkAssign(persons, ['a'], {}, 5, [1])).toEqual({ a: [{ person: 'p1', seat: 1 }] })
    expect(bulkAssign([], ['a'], {}, 2, [1, 2])).toEqual({})
  })
})
