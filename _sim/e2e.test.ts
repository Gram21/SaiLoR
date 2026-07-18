import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject } from '../src/model/project'
import { alignPaper } from '../src/consolidate/align'
import { applyAlignment } from '../src/consolidate/apply'
import { unanimousFills } from '../src/consolidate/unanimous'
import { normalizeTree } from '../src/model/annotations'
import { merge3 } from '../src/git/merge'

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

const SCHEMA = [
  { name: 'Study Type', type: 'string', options: ['RCT', 'Cohort', 'Case study'] },
  { name: 'Sample Size', type: 'number' },
  { name: 'Peer Reviewed', type: 'boolean' },
  { name: 'Year', type: 'year' },
  { name: 'Population / Setting', type: 'string' },
  { name: 'Cost\\Benefit', type: 'string' },
  {
    name: 'Findings', min: 0, max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Confidence', type: 'string', options: ['Low', 'High'] },
      { name: 'Evidence', min: 0, max: null, children: [{ name: 'Metric', type: 'string' }] },
    ],
  },
]

const TYPES = ['RCT', 'Cohort', 'Case study']

function buildProject(nPapers: number, nReviewers: number, seed: number) {
  const rand = rng(seed)
  const papers = []
  for (let p = 0; p < nPapers; p++) {
    const reviews: Record<string, unknown> = {}
    // A "truth" per paper; each reviewer deviates sometimes, and records a
    // varying number of findings so slots are genuinely ragged.
    const truthType = TYPES[Math.floor(rand() * 3)]
    const truthN = 100 + Math.floor(rand() * 900)
    for (let r = 1; r <= nReviewers; r++) {
      const nFind = Math.floor(rand() * 4) // 0..3 findings
      reviews[String(r)] = {
        'Study Type': [{ value: rand() < 0.75 ? truthType : TYPES[Math.floor(rand() * 3)] }],
        'Sample Size': [{ value: rand() < 0.8 ? truthN : truthN + Math.floor(rand() * 10) }],
        'Peer Reviewed': [{ value: rand() < 0.9 }],
        Year: [{ value: 2000 + Math.floor(rand() * 25) }],
        'Population / Setting': [{ value: rand() < 0.7 ? 'Adults, urban' : 'Adults, rural' }],
        'Cost\\Benefit': [{ value: rand() < 0.7 ? 'favourable' : 'unclear' }],
        Findings: Array.from({ length: nFind }, (_, k) => ({
          children: {
            Claim: [{ value: `claim ${k} of ${p}` }],
            Confidence: [{ value: rand() < 0.5 ? 'Low' : 'High' }],
            Evidence: Array.from({ length: Math.floor(rand() * 3) }, (_, m) => ({
              children: { Metric: [{ value: `m${m}` }] },
            })),
          },
        })),
      }
    }
    papers.push({
      id: `p${p}`, title: `Paper ${p}`, authors: ['A. Author'], pdf: `pdfs/p${p}.pdf`,
      annotations: {}, reviews,
    })
  }
  return { version: 1, title: 'Sim', config: { schema: SCHEMA, reviewers: nReviewers }, papers }
}

describe('end-to-end simulation', () => {
  it('multi-reviewer annotation, alignment, consolidation, save round-trip', () => {
    for (const nReviewers of [1, 2, 3, 5]) {
      const raw = buildProject(60, nReviewers, 42 + nReviewers)
      const project = loadProject(raw)
      expect(project.papers).toHaveLength(60)

      let aligned = 0
      let adopted = 0
      for (const paper of project.papers) {
        const reviews: Record<string, any> = {}
        for (let r = 1; r <= nReviewers; r++) {
          reviews[String(r)] = paper.reviews[String(r)] ?? normalizeTree(project.schema, undefined)
        }
        const alignment = alignPaper(project.schema, reviews)

        // Every slot's members must point at real entries.
        for (const node of Object.values(alignment)) {
          for (const slot of node.slots) {
            for (const [rev, idx] of Object.entries(slot.members)) {
              const list = (reviews[rev] as any)?.Findings ?? []
              expect(idx).toBeGreaterThanOrEqual(0)
              expect(idx).toBeLessThan(Math.max(list.length, 1))
            }
            // A reviewer may appear at most once per slot (Object keys ensure it)
            // and each reviewer's entry may occupy at most one slot:
          }
          // No entry used twice across slots, per reviewer.
          const seen: Record<string, Set<number>> = {}
          for (const slot of node.slots) {
            for (const [rev, idx] of Object.entries(slot.members)) {
              seen[rev] ??= new Set()
              expect(seen[rev].has(idx)).toBe(false)
              seen[rev].add(idx)
            }
          }
          aligned++
        }

        const applied = applyAlignment(project.schema, reviews, alignment)
        expect(applied).toBeDefined()

        const fills = unanimousFills(project.schema, reviews, paper.annotations)
        adopted += fills.length
      }

      // Save round-trip must be stable and reloadable.
      const text = serializeProject(project)
      const reloaded = loadProject(JSON.parse(text))
      expect(serializeProject(reloaded)).toBe(text)

      console.log(
        `reviewers=${nReviewers}: ${project.papers.length} papers, ${aligned} aligned nodes, ${adopted} unanimous fills, ${text.length}B`,
      )
    }
  })

  it('git three-way merge of two reviewers editing the same project', () => {
    const raw = buildProject(30, 3, 7)
    const base = serializeProject(loadProject(raw))

    // Reviewer 2 edits their own seat on the first 10 papers.
    const oursObj = JSON.parse(base)
    for (let i = 0; i < 10; i++) {
      oursObj.papers[i].reviews['2']['Study Type'] = [{ value: 'RCT' }]
    }
    // Reviewer 3 edits theirs on the last 10 — disjoint seats, same papers file.
    const theirsObj = JSON.parse(base)
    for (let i = 20; i < 30; i++) {
      theirsObj.papers[i].reviews['3']['Sample Size'] = [{ value: 999 }]
    }

    const res = merge3(base, JSON.stringify(oursObj), JSON.stringify(theirsObj))
    console.log('merge:', JSON.stringify({ ok: res.ok, conflicts: res.conflicts?.length ?? 0 }))
    expect(res.ok).toBe(true)
    if (res.ok) {
      const merged = loadProject(JSON.parse(res.text))
      // Both sides' disjoint edits must survive.
      expect((merged.papers[0].reviews['2'] as any)['Study Type'][0].value).toBe('RCT')
      expect((merged.papers[25].reviews['3'] as any)['Sample Size'][0].value).toBe(999)
    }
  })
})
