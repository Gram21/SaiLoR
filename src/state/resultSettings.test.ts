import { beforeEach, describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../model/diagram'
import { loadDiagramConfig, loadGraphFilters, saveDiagramConfig, saveGraphFilters } from './resultSettings'

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

beforeEach(() => localStorage.clear())

describe('result view settings', () => {
  // [utest->req~ui-380~1]
  it('keeps diagram settings and falls back to the default for nothing stored', () => {
    expect(loadDiagramConfig()).toEqual(DEFAULT_CONFIG)
    saveDiagramConfig({ ...DEFAULT_CONFIG, type: 'pie', title: 'T', horizontal: true, colors: { a: '#123456' } })
    expect(loadDiagramConfig()).toMatchObject({ type: 'pie', title: 'T', horizontal: true, colors: { a: '#123456' } })
  })

  // [utest->req~ui-380~1]
  it('rejects wrong values, bad colours and broken JSON', () => {
    localStorage.setItem('slr.result.diagram', JSON.stringify({ type: 'cube', palette: 'x', sort: 7, width: 99999, height: 'tall', limit: 1, title: 5, colors: { a: 'red', b: '#abcdef' } }))
    expect(loadDiagramConfig()).toEqual({ ...DEFAULT_CONFIG, width: 3000, limit: 2, colors: { b: '#abcdef' } })
    localStorage.setItem('slr.result.diagram', '{oops')
    expect(loadDiagramConfig()).toEqual(DEFAULT_CONFIG)
  })

  // [utest->req~ui-380~1]
  it('keeps graph filters and drops unknown node types', () => {
    expect(loadGraphFilters()).toEqual({ edges: 0, nodeTypes: [] })
    saveGraphFilters({ edges: 5, nodeTypes: ['Author', 'Keyword'] })
    expect(loadGraphFilters()).toEqual({ edges: 5, nodeTypes: ['Author', 'Keyword'] })
    localStorage.setItem('slr.result.graph', JSON.stringify({ edges: 'x', nodeTypes: ['Author', 'Moon'] }))
    expect(loadGraphFilters()).toEqual({ edges: 0, nodeTypes: ['Author'] })
  })
})
