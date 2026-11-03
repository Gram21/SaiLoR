import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree, type InstanceNode } from '../model/annotations'
import { alignNode, type NodeAlignment, type TreeAlignment } from './align'

const DEFS: AnnotationDef[] = [
  {
    name: 'Findings',
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Kind', type: 'string', options: ['RCT', 'Survey', 'Case study'] },
      { name: 'Sample', type: 'number' },
      { name: 'Notes', max: null, children: [{ name: 'Text', type: 'string' }] },
    ],
  },
]
const SCHEMA = resolveSchema(DEFS)

const CLAIMS = ['Tests reduce defects', 'tests reduce defects.', 'Reviews find bugs', 'CI speeds delivery', '']
const KINDS = ['RCT', 'Survey', 'Case study', '']
const NOTES = ['Table 4', 'RQ2', 'see appendix', '']

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, xs: T[]): T {
  return xs[Math.floor(next() * xs.length)]
}

function shuffled<T>(next: () => number, xs: T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function finding(next: () => number): InstanceNode {
  const notes = Array.from({ length: Math.floor(next() * 3) }, () => ({
    children: { Text: [{ value: pick(next, NOTES) }] },
  }))
  return {
    children: {
      Claim: [{ value: pick(next, CLAIMS) }],
      Kind: [{ value: pick(next, KINDS) }],
      Sample: [{ value: next() < 0.5 ? null : pick(next, [10, 11, 40]) }],
      Notes: notes,
    },
  }
}

function randomReviews(next: () => number): Record<string, AnnotationValueTree> {
  const reviewerCount = 2 + Math.floor(next() * 2)
  const out: Record<string, AnnotationValueTree> = {}
  for (let r = 1; r <= reviewerCount; r++) {
    const count = Math.floor(next() * 5)
    out[String(r)] = normalizeTree(SCHEMA, { Findings: Array.from({ length: count }, () => finding(next)) })
  }
  return out
}

function shuffleTree(next: () => number, tree: AnnotationValueTree): AnnotationValueTree {
  const out: AnnotationValueTree = {}
  for (const [name, list] of Object.entries(tree)) {
    out[name] = shuffled(next, list).map((inst) =>
      inst.children ? { ...inst, children: shuffleTree(next, inst.children) } : inst,
    )
  }
  return out
}

function entryKey(inst: InstanceNode | undefined): string {
  if (!inst) return ''
  const nested = Object.entries(inst.children ?? {})
    .map(([name, list]) => [name, list.map(entryKey).sort()])
    .sort()
  return JSON.stringify([inst.value ?? null, nested])
}

function canonicalNode(
  node: NodeAlignment,
  lists: Record<string, InstanceNode[]>,
  childLists: (inst: InstanceNode | undefined, name: string) => InstanceNode[],
): string[] {
  return node.slots
    .map((slot) => {
      const members = Object.entries(slot.members)
        .map(([r, i]) => `${r}=${entryKey(lists[r][i])}`)
        .sort()
      const children: Record<string, string[]> = {}
      for (const [name, child] of Object.entries(slot.children)) {
        const nested: Record<string, InstanceNode[]> = {}
        for (const [r, i] of Object.entries(slot.members)) nested[r] = childLists(lists[r][i], name)
        children[name] = canonicalNode(child, nested, childLists)
      }
      return JSON.stringify([members, slot.agreement.toFixed(9), slot.evidence.toFixed(9), children])
    })
    .sort()
}

function canonical(alignment: TreeAlignment, reviews: Record<string, AnnotationValueTree>): string[] {
  const lists: Record<string, InstanceNode[]> = {}
  for (const [r, tree] of Object.entries(reviews)) lists[r] = tree.Findings ?? []
  return canonicalNode(alignment.Findings, lists, (inst, name) => inst?.children?.[name] ?? [])
}

describe('alignment properties', () => {
  it('gives the same pairing whatever order the reviewers recorded entries in', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed)
      const reviews = randomReviews(next)
      const shuffledReviews: Record<string, AnnotationValueTree> = {}
      for (const [r, tree] of Object.entries(reviews)) shuffledReviews[r] = shuffleTree(next, tree)

      const before = canonical(alignNode(SCHEMA, reviews, 'Findings'), reviews)
      const after = canonical(alignNode(SCHEMA, shuffledReviews, 'Findings'), shuffledReviews)
      expect(after, `seed ${seed}`).toEqual(before)
    }
  })

  it('pairs every entry with its copy when the reviewers recorded the same entries', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed)
      const base = randomReviews(next)['1']
      const reviews = { '1': base, '2': shuffleTree(next, base) }
      const alignment = alignNode(SCHEMA, reviews, 'Findings').Findings
      expect(alignment.slots.length, `seed ${seed}`).toBe(base.Findings.length)
      for (const slot of alignment.slots) {
        expect(Object.keys(slot.members).sort(), `seed ${seed}`).toEqual(['1', '2'])
        if (slot.evidence > 0) expect(slot.agreement, `seed ${seed}`).toBe(1)
      }
    }
  })
})
