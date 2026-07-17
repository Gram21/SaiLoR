import { describe, it, expect } from 'vitest'
import { loadProject } from '../model/project'
import { useStore } from '../state/store'
import type { AnnotationDef } from '../model/schema'
import { annotationText } from '../model/annotations'
import { completeness } from '../model/completeness'

/**
 * Measures, rather than assumes, the two things the PaperList perf work
 * hinges on:
 *
 *  1. How expensive `annotationText` + `completeness` actually are over a
 *     large paper list — the two `useMemo`s the brief flagged rebuild these
 *     on every edit.
 *  2. Whether immer's structural sharing really does leave every *other*
 *     paper's object identity untouched after a single-field edit — the
 *     premise `React.memo` on `PaperRow` depends on for its win.
 *
 * Thresholds are generous (order-of-magnitude, not tight) because CI/dev
 * hardware varies; the point is to catch a real regression (an accidental
 * quadratic walk, a memo that stops memoizing), not to chase a specific
 * millisecond figure. The measured numbers are logged either way, per the
 * brief's "report the numbers, including 'it was fine'" instruction.
 */

const PAPER_COUNT = 2000

// A 30-field schema in the shape a real review would use: several plain
// fields, a couple of required ones, a boolean (excluded from completeness —
// see `completeness.ts`), and one unbounded repeatable group, so the walk
// exercises recursion and instance-counting, not just a flat field list.
const SCHEMA: AnnotationDef[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ name: `String Field ${i}`, type: 'string' as const })),
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `Required Field ${i}`,
    type: 'string' as const,
    required: true,
  })),
  ...Array.from({ length: 6 }, (_, i) => ({ name: `Number Field ${i}`, type: 'number' as const })),
  { name: 'Relevant', type: 'boolean' as const },
  {
    name: 'Findings',
    max: null,
    children: [
      { name: 'Claim', type: 'string' as const, required: true },
      { name: 'Evidence', type: 'string' as const },
    ],
  },
]

function largeProjectJson(): string {
  const papers = Array.from({ length: PAPER_COUNT }, (_, i) => ({
    id: `p${i}`,
    title: `Paper ${i}: a study of things`,
    authors: [`Author ${i}A`, `Author ${i}B`],
    pdf: `p${i}.pdf`,
    // Every third paper gets a couple of fields filled, so the walk is not
    // measuring an all-empty best case.
    annotations:
      i % 3 === 0
        ? {
            'String Field 0': [{ value: `Some answer for paper ${i}` }],
            'Required Field 0': [{ value: 'answered' }],
          }
        : {},
  }))
  return JSON.stringify({ version: 1, config: { schema: SCHEMA }, papers })
}

describe('PaperList perf — measured, not assumed', () => {
  it('annotationText + completeness over 2000 papers stays cheap', () => {
    const project = loadProject(largeProjectJson())
    const schema = project.schema

    // Warm up (JIT), matching how the app actually runs this repeatedly.
    for (const p of project.papers) {
      annotationText(schema, p.annotations)
      completeness(schema, p.annotations)
    }

    const start = performance.now()
    let filledTotal = 0
    for (const p of project.papers) {
      annotationText(schema, p.annotations)
      const c = completeness(schema, p.annotations)
      filledTotal += c.filled
    }
    const elapsed = performance.now() - start

    // eslint-disable-next-line no-console
    console.log(
      `[perf] annotationText + completeness over ${PAPER_COUNT} papers: ${elapsed.toFixed(2)}ms`,
    )

    expect(filledTotal).toBeGreaterThan(0) // sanity: the fixture actually has filled fields
    // Generous: this ran under 5ms in the sandbox that produced this test.
    // 50ms leaves an order of magnitude of headroom for slower CI hardware
    // while still catching an accidental O(n²) walk.
    expect(elapsed).toBeLessThan(50)
  })

  it('a single field edit changes only the edited paper’s object identity — the premise React.memo relies on', () => {
    const st = () => useStore.getState()
    st().loadFromText(largeProjectJson(), null, 'large.json')
    st().selectPaper('p1000')

    const before = st().project!.papers
    const beforeRefs = before.map((p) => p)

    const start = performance.now()
    st().setFieldValue([], 'String Field 0', 0, 'edited value')
    const elapsed = performance.now() - start
    // eslint-disable-next-line no-console
    console.log(`[perf] single setFieldValue over ${PAPER_COUNT} papers: ${elapsed.toFixed(2)}ms`)

    const after = st().project!.papers
    expect(after).not.toBe(before) // the array itself is replaced (immer)

    let changed = 0
    for (let i = 0; i < after.length; i++) {
      if (after[i] !== beforeRefs[i]) changed++
    }
    // Exactly the edited paper (p1000) changed identity; all 1999 others are
    // the literal same object as before the edit — this is what lets a
    // memoized row skip re-rendering for everything except the paper the
    // reviewer is actually typing into.
    expect(changed).toBe(1)
    expect(after.find((p) => p.id === 'p1000')).not.toBe(beforeRefs.find((p) => p.id === 'p1000'))
  })
})
