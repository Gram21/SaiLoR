import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef, type ResolvedDef } from '../model/schema'
import { closingWouldStrand } from './ConsolidationDialog'

/**
 * The compare popup's one piece of real logic: whether leaving now would strand
 * the field — declared equivalent, but with no value recorded. Everything else
 * in that file is rendering, and there is no component-testing library here
 * (see `PaperList.test.ts` for the same split).
 */

function def(node: AnnotationDef): ResolvedDef {
  return resolveSchema([node])[0]
}

const text = def({ name: 'Study Type', type: 'string' })
const num = def({ name: 'Year', type: 'number' })
const bool = def({ name: 'Relevant', type: 'boolean' })

describe('closingWouldStrand', () => {
  it('is false when the answers were never declared equivalent', () => {
    // Closing without picking is the ordinary case and changes nothing: the
    // field stays a disagreement and will be offered again.
    expect(closingWouldStrand(text, false, null)).toBe(false)
    expect(closingWouldStrand(text, false, undefined)).toBe(false)
  })

  it('is false once a value has actually been recorded', () => {
    expect(closingWouldStrand(text, true, 'RCT')).toBe(false)
    expect(closingWouldStrand(num, true, 2024)).toBe(false)
  })

  it('is true when marked equivalent with nothing recorded — the whole point', () => {
    // The bad state: the field no longer counts as a disagreement, so nothing
    // will surface it again, yet it holds no answer.
    expect(closingWouldStrand(text, true, null)).toBe(true)
    expect(closingWouldStrand(text, true, undefined)).toBe(true)
    expect(closingWouldStrand(num, true, null)).toBe(true)
  })

  it('treats whitespace as nothing recorded', () => {
    expect(closingWouldStrand(text, true, '   ')).toBe(true)
    expect(closingWouldStrand(text, true, '')).toBe(true)
  })

  it('never strands a boolean, in either state', () => {
    // A boolean has no third state: an unticked box is a real `false` in the
    // data, not a gap. Reporting `false` as "nothing recorded" would raise a
    // warning the reviewer cannot clear — picking the answer would leave the
    // field looking exactly as empty as before.
    expect(closingWouldStrand(bool, true, false)).toBe(false)
    expect(closingWouldStrand(bool, true, true)).toBe(false)
  })

  it('accepts a recorded zero, which is a real answer', () => {
    // `0` is falsy; a naive truthiness check here would demand the reviewer
    // pick a value they had already picked.
    expect(closingWouldStrand(num, true, 0)).toBe(false)
  })
})
