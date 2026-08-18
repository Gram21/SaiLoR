import { describe, it, expect } from 'vitest'
import { readAllConcurrently } from './concurrentRead'

/** Resolves after `delayMs`, so tests can control completion order —
 *  `vi.useFakeTimers` isn't needed here since these are real, short delays
 *  and the property under test is about *ordering*, not timing precision. */
function delayed<T>(value: T, delayMs: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs))
}

describe('readAllConcurrently', () => {
  it('maps every id to its own value when reads resolve in order', async () => {
    const result = await readAllConcurrently(['a', 'b', 'c'], async (id) => `value-${id}`)
    expect(result).toEqual(new Map([['a', 'value-a'], ['b', 'value-b'], ['c', 'value-c']]))
  })

  it('still maps each id to its own value when reads resolve out of order', async () => {
    // Deliberately the reverse of array order: 'c' settles first, 'a' last.
    // This is the actual bug class the old sequential loop couldn't have —
    // and that a naive rewrite (e.g. destructuring a `Promise.all` result
    // array against the wrong index) could silently reintroduce.
    const delays: Record<string, number> = { a: 30, b: 15, c: 0 }
    const result = await readAllConcurrently(['a', 'b', 'c'], (id) => delayed(`value-${id}`, delays[id]))
    expect(result.get('a')).toBe('value-a')
    expect(result.get('b')).toBe('value-b')
    expect(result.get('c')).toBe('value-c')
  })

  it('runs every read concurrently, not one at a time', async () => {
    // Three 30ms reads sequentially would take ~90ms; concurrently, ~30ms.
    // A generous threshold well under the sequential total, so this only
    // fails if the reads are actually serialized, not on ordinary CI jitter.
    const start = Date.now()
    await readAllConcurrently(['a', 'b', 'c'], (id) => delayed(id, 30))
    expect(Date.now() - start).toBeLessThan(75)
  })

  it('a duplicate id resolves to the later occurrence — same last-wins semantics as the original Map.set loop', async () => {
    let call = 0
    const result = await readAllConcurrently(['p1', 'p1'], async () => `call-${++call}`)
    expect(result.size).toBe(1)
    expect(result.get('p1')).toBe('call-2')
  })

  it('returns an empty map for no ids, without calling read', async () => {
    let called = false
    const result = await readAllConcurrently([], async () => {
      called = true
      return 'x'
    })
    expect(result.size).toBe(0)
    expect(called).toBe(false)
  })

  it('rejects the whole call when any read fails', async () => {
    await expect(
      readAllConcurrently(['a', 'b'], async (id) => {
        if (id === 'b') throw new Error('read failed')
        return id
      }),
    ).rejects.toThrow('read failed')
  })
})
