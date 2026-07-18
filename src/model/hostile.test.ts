import { describe, it, expect } from 'vitest'
import { loadProject, ProjectLoadError } from './project'

/**
 * A project file arrives from a collaborator, a shared drive, or a git clone.
 * None of those are trusted input, and the failure mode these guard against is
 * not a bad error message — it is the process being killed during load, with no
 * dialog and no chance to close the file.
 */

const wrap = (schema: unknown) => ({
  version: 1,
  config: { schema },
  papers: [{ id: 'p', title: 't', pdf: 'a.pdf' }],
})

describe('hostile project files', () => {
  it('rejects a flat enormous min instead of exhausting memory', () => {
    // 139 bytes. `initTree` materializes max(min, 1) instances at load.
    expect(() => loadProject(wrap([{ name: 'A', type: 'string', min: 1_000_000_000, max: null }]))).toThrow(
      ProjectLoadError,
    )
  })

  it('rejects nested mins that multiply, however small the file', () => {
    // ~500 bytes describing 10^10 instances: a per-node cap on `min` cannot
    // catch this, since any ceiling above 1 still multiplies down the branch.
    let node: unknown = { name: 'L', type: 'string', min: 10, max: null }
    for (let i = 0; i < 10; i++) node = { name: `n${i}`, min: 10, max: null, children: [node] }
    expect(() => loadProject(wrap([node]))).toThrow(ProjectLoadError)
  })

  it('rejects deep nesting as a ProjectLoadError, not a raw RangeError', () => {
    // zod's own validation is recursive and overflows around 700 levels. A
    // RangeError escaping here breaks loadProject's documented contract and
    // lands in the store's generic fallback instead of a readable message.
    let node: unknown = { name: 'leaf', type: 'string' }
    for (let i = 0; i < 1500; i++) node = { name: `n${i}`, children: [node] }
    expect(() => loadProject(wrap([node]))).toThrow(ProjectLoadError)
  })

  it('rejects deep nesting under an unknown key, which is passed through to extra', () => {
    // Unknown keys are preserved verbatim, so depth here reaches deepEqualJson
    // and serializeProject — crashing the read-only git-status path too.
    let deep: unknown = 1
    for (let i = 0; i < 5000; i++) deep = { a: deep }
    expect(() =>
      loadProject({ version: 1, config: { schema: [{ name: 'N', type: 'string' }] }, papers: [], junk: deep }),
    ).toThrow(ProjectLoadError)
  })

  it('still loads a generous but legitimate schema', () => {
    const defs: unknown[] = Array.from({ length: 40 }, (_, i) => ({ name: `F${i}`, type: 'string' }))
    defs.push({
      name: 'Findings',
      min: 3,
      max: null,
      children: Array.from({ length: 10 }, (_, i) => ({ name: `C${i}`, type: 'string' })),
    })
    defs.push({
      name: 'Outer',
      min: 2,
      max: null,
      children: [{ name: 'Inner', min: 2, max: null, children: [{ name: 'Leaf', type: 'string' }] }],
    })
    expect(loadProject(wrap(defs)).schema).toHaveLength(42)
  })
})
