import { describe, it, expect } from 'vitest'
import { LOCAL_MODEL_CATALOG, findCatalogEntry, requireAvailableEntry } from './localCatalog'

describe('local model catalog', () => {
  it('has unique, validator-compatible ids', () => {
    const ids = LOCAL_MODEL_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9._-]{1,64}$/)
  })
  it('available entries are fully specified; planned ones say why', () => {
    for (const e of LOCAL_MODEL_CATALOG) {
      if (e.status === 'available') {
        expect(e.hfFile).toMatch(/^[\w.-]+\.gguf$/) // no path separators: it is joined into a local path
        expect(e.hfRepo).toMatch(/^[\w.-]+\/[\w.-]+$/)
        expect(e.approxBytes).toBeGreaterThan(0)
        expect(e.contextTokens).toBeGreaterThan(0)
        expect(e.license).toBeTruthy()
      } else {
        expect(e.plannedReason).toBeTruthy()
      }
    }
  })
  it('Clef is planned, Laya English is available', () => {
    expect(findCatalogEntry('clef')?.status).toBe('planned')
    expect(findCatalogEntry('clef-flash')?.status).toBe('planned')
    expect(requireAvailableEntry('laya-en-q8').hfRepo).toBe('ggml-org/Laya-GGUF')
  })
  it('refuses unknown, planned and non-string ids', () => {
    expect(() => requireAvailableEntry('../../etc')).toThrow('Unknown')
    expect(() => requireAvailableEntry('clef')).toThrow(/Clef/)
    expect(() => requireAvailableEntry(42)).toThrow()
  })
})
