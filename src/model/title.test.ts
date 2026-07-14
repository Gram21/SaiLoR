import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadProject, serializeProject } from './project'

/** The smallest project the loader accepts, plus whatever we want to add. */
const base = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    ...extra,
    config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
    papers: [{ id: 'p1', title: 'A Paper', authors: [], pdf: 'a.pdf', annotations: {} }],
  })

describe('project title', () => {
  it('is read from the file when set', () => {
    expect(loadProject(base({ title: 'My Review' })).title).toBe('My Review')
  })

  it('is undefined when the file omits it, so the UI falls back to the file name', () => {
    expect(loadProject(base()).title).toBeUndefined()
  })

  it('round-trips through serialize, and is not written when absent', () => {
    const withTitle = serializeProject(loadProject(base({ title: 'My Review' })))
    expect(JSON.parse(withTitle).title).toBe('My Review')
    expect(loadProject(withTitle).title).toBe('My Review')

    // A project with no title must not gain an empty one.
    const without = JSON.parse(serializeProject(loadProject(base())))
    expect('title' in without).toBe(false)
  })

  it('is not swallowed into `extra` (which would duplicate it on save)', () => {
    const project = loadProject(base({ title: 'My Review', custom: 1 }))
    expect(project.extra).toEqual({ custom: 1 })
    // Exactly one `title` key survives the round trip.
    const out = JSON.parse(serializeProject(project)) as Record<string, unknown>
    expect(out.title).toBe('My Review')
    expect(out.custom).toBe(1)
  })

  it('rejects a non-string title', () => {
    expect(() => loadProject(base({ title: 42 }))).toThrow()
  })

  it('is set on the bundled sample', () => {
    const sample = loadProject(readFileSync('samples/project.example.json', 'utf-8'))
    expect(sample.title).toBe('Example SLR: Code Search and Program Repair')
  })
})
