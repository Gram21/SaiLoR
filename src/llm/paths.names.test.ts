import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { formatPath, parsePath, resolvePath } from './paths'

/**
 * Field names are user-entered, and they are also *structure*: a canonical path
 * like `Findings[1]/Claim` is built from them, and that string is persisted as
 * `paper.equal` keys, AI-mark keys and conflict ids. An ambiguous encoding here
 * does not corrupt the file — it silently resolves to a *different field*, so a
 * committed answer lands on the wrong one.
 *
 * The nested case is the one that matters: a name containing `/` or `[` could
 * otherwise be read as two segments, or as an index.
 */
const NAMES = [
  'Population / Setting',
  'Cost\\Benefit',
  'Outcome [primary]',
  'a/b/c',
  'x[0]',
  'x[0]/y',
  '\\',
  '\\\\',
  '[',
  ']',
  '/',
  'ends with backslash\\',
  'Findings[1]/Claim',
  'a  b',
  'Ünïcödé — em dash',
]

describe('schema field names containing path metacharacters', () => {
  it('round-trips each name through format then parse', () => {
    for (const name of NAMES) {
      const formatted = formatPath([{ name, index: 0 }])
      const parsed = parsePath(formatted)
      expect(parsed, `format/parse: ${JSON.stringify(name)} -> ${formatted}`).toEqual([
        { name, index: 0 },
      ])
    }
  })

  it('round-trips a nested pair, where ambiguity would resolve to the wrong field', () => {
    for (const outer of NAMES) {
      for (const inner of NAMES) {
        const formatted = formatPath([
          { name: outer, index: 1 },
          { name: inner, index: 0 },
        ])
        expect(parsePath(formatted), `${JSON.stringify([outer, inner])} -> ${formatted}`).toEqual([
          { name: outer, index: 1 },
          { name: inner, index: 0 },
        ])
      }
    }
  })

  it('resolves back to the same field against a real schema', () => {
    for (const name of NAMES) {
      const schema = resolveSchema([
        { name: 'Group', min: 0, max: null, children: [{ name, type: 'string' }] },
      ])
      const canonical = formatPath([
        { name: 'Group', index: 2 },
        { name, index: 0 },
      ])
      const resolved = resolvePath(schema, canonical)
      expect(resolved?.name, `${JSON.stringify(name)} via ${canonical}`).toBe(name)
      expect(resolved?.canonical).toBe(canonical)
    }
  })
})
