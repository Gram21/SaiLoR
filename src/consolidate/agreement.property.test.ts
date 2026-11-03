import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree, type InstanceNode } from '../model/annotations'
import type { Paper, Project } from '../model/project'
import { alignNode } from './align'
import { toStoredAlignment } from './apply'
import { agreementInput, type FieldAgreement } from './agreement'
import type { MetricInput } from './metrics'
import { cohenKappa, cohenKappaApplicable, fleissKappa, fleissKappaApplicable, krippendorffAlpha, krippendorffAlphaApplicable } from './metrics'

const DEFS: AnnotationDef[] = [
  {
    name: 'Findings',
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Kind', type: 'string', options: ['RCT', 'Survey', 'Case study'] },
      { name: 'Notes', max: null, children: [{ name: 'Text', type: 'string' }] },
    ],
  },
]
const SCHEMA = resolveSchema(DEFS)

const CLAIMS = ['Tests reduce defects', 'Reviews find bugs', 'CI speeds delivery', '']
const KINDS = ['RCT', 'Survey', 'Case study', '']
const NOTES = ['Table 4', 'RQ2', '']

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
      Notes: notes,
    },
  }
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

function paper(id: string, reviews: Record<string, AnnotationValueTree>): Paper {
  return {
    id,
    title: id,
    authors: [],
    pdf: `${id}.pdf`,
    annotations: {},
    reviews,
    aiUsage: [],
    equal: [],
    alignment: toStoredAlignment(alignNode(SCHEMA, reviews, 'Findings')),
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
  }
}

function project(reviewers: number, papers: Paper[]): Project {
  return {
    version: 1,
    provenance: null,
    protocol: null,
    schemaInfo: null,
    schemaVersion: null,
    schemaHistory: [],
    annotationsDir: null,
    schema: SCHEMA,
    aiEnabled: true,
    aiSeat: false,
    finishCheckbox: true,
    reviewers,
    extra: {},
    papers,
    screening: null,
  }
}

function metrics(input: MetricInput): (number | null)[] {
  return [
    cohenKappaApplicable(input).usable ? cohenKappa(input).value : null,
    fleissKappaApplicable(input).usable ? fleissKappa(input).value : null,
    krippendorffAlphaApplicable(input).usable ? krippendorffAlpha(input).value : null,
  ]
}

function summary(fields: FieldAgreement[]) {
  return fields
    .map((f) => ({
      key: f.key,
      units: f.input.units.map((u) => JSON.stringify(u)).sort(),
      metrics: metrics(f.input).map((v) => (v === null ? null : v.toFixed(9))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function randomStudy(next: () => number) {
  const reviewers = 2 + Math.floor(next() * 2)
  return Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
    const reviews: Record<string, AnnotationValueTree> = {}
    for (let r = 1; r <= reviewers; r++) {
      const count = Math.floor(next() * 4)
      reviews[String(r)] = normalizeTree(SCHEMA, { Findings: Array.from({ length: count }, () => finding(next)) })
    }
    return reviews
  })
}

describe('agreement properties', () => {
  it('gives the same agreement whatever order the reviewers recorded entries in', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed)
      const study = randomStudy(next)
      const reviewers = Object.keys(study[0]).length
      const shuffledStudy = study.map((reviews) => {
        const out: Record<string, AnnotationValueTree> = {}
        for (const [r, tree] of Object.entries(reviews)) out[r] = shuffleTree(next, tree)
        return out
      })
      const before = agreementInput(project(reviewers, study.map((rv, i) => paper(`p${i}`, rv))))
      const after = agreementInput(project(reviewers, shuffledStudy.map((rv, i) => paper(`p${i}`, rv))))
      expect(after.unitCount, `seed ${seed}`).toBe(before.unitCount)
      expect(after.skipped, `seed ${seed}`).toBe(before.skipped)
      expect(metrics(after.input).map((v) => v?.toFixed(9)), `seed ${seed}`).toEqual(
        metrics(before.input).map((v) => v?.toFixed(9)),
      )
      expect(summary(after.perField), `seed ${seed}`).toEqual(summary(before.perField))
      expect(summary(after.perEntry), `seed ${seed}`).toEqual(summary(before.perEntry))
    }
  })

  it('gives agreement 1 per field and per entry when the reviewers recorded the same entries', () => {
    let measured = 0
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed)
      const papers = randomStudy(next).map((reviews, i) => paper(`p${i}`, { '1': reviews['1'], '2': shuffleTree(next, reviews['1']) }))
      const built = agreementInput(project(2, papers))
      for (const input of [built.input, ...built.perField.map((f) => f.input), ...built.perEntry.map((f) => f.input)]) {
        for (const value of metrics(input)) {
          if (value === null) continue
          measured++
          expect(value, `seed ${seed}`).toBe(1)
        }
      }
    }
    expect(measured).toBeGreaterThan(100)
  })
})
