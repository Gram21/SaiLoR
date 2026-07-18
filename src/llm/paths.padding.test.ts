/**
 * A field name carrying leading or trailing whitespace is only reachable by
 * hand-editing a project file — the schema editor trims on save — but that is
 * the file the app is built to receive, share over git, and import.
 *
 * The format cannot represent such a name unambiguously: `parseSegment` trims a
 * segment so that "Findings [1]" reads as "Findings", which is the lenient
 * behaviour model output relies on. So the two halves are split: a schema
 * holding two siblings that trim alike is *refused* (no path could name one of
 * them, and `git/changes.ts` writes by resolved name, so a committed answer
 * would land in the other field), while a lone padded name resolves through a
 * trimmed fallback instead of failing forever.
 */
import { describe, it, expect } from 'vitest'
import { resolveSchema, SchemaError } from '../model/schema'
import { formatPath, resolvePath } from './paths'

describe('names with leading/trailing whitespace', () => {
  it('refuses siblings that differ only by padding', () => {
    expect(() =>
      resolveSchema([
        { name: 'Claim', type: 'string' },
        { name: 'Claim ', type: 'string' },
      ]),
    ).toThrow(SchemaError)
  })

  it('resolves a lone padded name to its own def', () => {
    const schema = resolveSchema([{ name: 'Claim ', type: 'string' }])
    const canonical = formatPath([{ name: 'Claim ', index: 0 }])
    const resolved = resolvePath(schema, canonical)
    expect(resolved?.name).toBe('Claim ')
  })

  it('still resolves ordinary names, and lenient spacing around a path', () => {
    const schema = resolveSchema([
      { name: 'Findings', min: 0, max: null, children: [{ name: 'Claim', type: 'string' }] },
    ])
    expect(resolvePath(schema, 'Findings[1]/Claim')?.name).toBe('Claim')
    expect(resolvePath(schema, 'Findings [1] / Claim')?.name).toBe('Claim')
  })
})
