import { describe, it, expect } from 'vitest'
import { toLines } from './pdfMeta'

/** The exact pre-change implementation, to compare against. */
function oldToLines(items: { str: string; transform: number[]; width?: number }[]) {
  const byY = new Map<number, { size: number; parts: { x: number; width: number; str: string }[] }>()
  for (const item of items) {
    if (!item.str.trim()) continue
    const size = Math.abs(item.transform[3])
    const y = Math.round(item.transform[5])
    let key = y
    for (const existing of byY.keys()) {
      if (Math.abs(existing - y) <= 2) { key = existing; break }
    }
    const line = byY.get(key) ?? { size: 0, parts: [] }
    line.size = Math.max(line.size, size)
    line.parts.push({ x: item.transform[4], width: item.width ?? 0, str: item.str })
    byY.set(key, line)
  }
  return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, l]) => ({ y, size: l.size,
    text: l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ') }))
}

function rng(seed: number) { let s = seed; return () => ((s = (s*1103515245+12345)&0x7fffffff)/0x7fffffff) }

describe('line bucketing', () => {
  it('matches the previous implementation across random layouts', () => {
    for (let trial = 0; trial < 300; trial++) {
      const rand = rng(trial + 1)
      const items = Array.from({ length: 60 }, () => ({
        str: `w${Math.floor(rand() * 90)}`,
        // Cluster baselines tightly so the +/-2 window genuinely overlaps.
        transform: [0, 0, 0, 10 + Math.floor(rand()*3), Math.round(rand()*300), Math.round(rand()*40)],
        width: 5,
      }))
      // Compare grouping and order only: the real toLines decides the
      // separator from x-gaps, which this reference copy does not reproduce
      // and which the change did not touch.
      const strip = (t: string) => t.replace(/\s+/g, '')
      const a = toLines(items).map((l) => `${l.y}:${strip(l.text)}`)
      const b = oldToLines(items).map((l) => `${l.y}:${strip(l.text)}`)
      expect(a).toEqual(b)
    }
  })

  it('is no longer quadratic', () => {
    const items = Array.from({ length: 80000 }, (_, i) => ({
      str: `w${i}`, transform: [0,0,0,10, i % 500, i * 7], width: 5,
    }))
    const t0 = performance.now()
    toLines(items)
    const ms = performance.now() - t0
    console.log(`80k items: ${Math.round(ms)}ms`)
    expect(ms).toBeLessThan(2000)
  })
})
