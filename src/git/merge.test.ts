import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject, type Project } from '../model/project'
import { normalizeTree } from '../model/annotations'
import { moveInTree, pendingMoves } from '../model/schemaVersion'
import type { AnnotationDef } from '../model/schema'
import {
  merge3,
  mergeResultProblem,
  mergeProjects,
  applyResolutions,
  conflictId,
  treeLabel,
  type FieldConflict,
  type MergeOutcome,
  type Resolutions,
} from './merge'

/**
 * Fixtures are built through `loadProject` (the real load path), not
 * hand-assembled `Project` objects — so every base/ours/theirs is exactly as
 * schema-normalized and empty-skeleton-shaped as a file `mergeProjects`'
 * caller would actually hand it.
 */

const SIMPLE: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Year', type: 'number' },
  { name: 'Relevant', type: 'boolean' },
]

const REPEAT: AnnotationDef[] = [
  { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
]

const REPEAT2: AnnotationDef[] = [
  {
    name: 'Findings',
    max: null,
    children: [
      { name: 'Claim', type: 'string' },
      { name: 'Metric', type: 'string' },
    ],
  },
]

function findings2Tree(rows: [string, string][]): Record<string, unknown> {
  return {
    Findings: rows.map(([claim, metric]) => ({
      children: { Claim: [{ value: claim }], Metric: [{ value: metric }] },
    })),
  }
}

interface PaperOpts {
  title?: string
  authors?: string[]
  doi?: string
  year?: number
  venue?: string
  abstract?: string
  abstractFromPdf?: boolean
  pdf?: string
  annotations?: Record<string, unknown>
  reviews?: Record<string, unknown>
  aiUsage?: unknown[]
  equal?: string[]
  extra?: Record<string, unknown>
}

function paper(id: string, opts: PaperOpts = {}): Record<string, unknown> {
  return {
    id,
    title: opts.title ?? `Paper ${id}`,
    authors: opts.authors ?? [],
    ...(opts.doi ? { doi: opts.doi } : {}),
    ...(opts.year !== undefined ? { year: opts.year } : {}),
    ...(opts.venue ? { venue: opts.venue } : {}),
    ...(opts.abstract ? { abstract: opts.abstract } : {}),
    ...(opts.abstractFromPdf ? { abstractFromPdf: true } : {}),
    pdf: opts.pdf ?? `${id}.pdf`,
    annotations: opts.annotations ?? {},
    ...(opts.reviews ? { reviews: opts.reviews } : {}),
    ...(opts.aiUsage ? { aiUsage: opts.aiUsage } : {}),
    ...(opts.equal ? { equal: opts.equal } : {}),
    ...(opts.extra ?? {}),
  }
}

interface ProjectOpts {
  schema?: AnnotationDef[]
  reviewers?: number
  ai?: boolean
  title?: string
  version?: number
  papers?: Record<string, unknown>[]
  extra?: Record<string, unknown>
  /** Presence alone makes this a screening project — see `screeningSchemaDefs`. */
  screening?: { reasons: string[] }
  /** Root-level, not under `extra` — a real field, same rule `screening` follows. */
  provenance?: unknown
  protocol?: unknown
  schemaInfo?: unknown
}

function project(opts: ProjectOpts = {}): Project {
  const config: Record<string, unknown> = opts.screening
    ? { screening: opts.screening }
    : { schema: opts.schema ?? SIMPLE }
  if (opts.reviewers !== undefined) config.reviewers = opts.reviewers
  if (opts.ai !== undefined) config.ai = opts.ai
  return loadProject({
    version: opts.version ?? 1,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
    ...(opts.protocol !== undefined ? { protocol: opts.protocol } : {}),
    ...(opts.schemaInfo !== undefined ? { schemaInfo: opts.schemaInfo } : {}),
    config,
    papers: opts.papers ?? [],
    ...(opts.extra ?? {}),
  })
}

function findingsTree(claims: (string | null)[]): Record<string, unknown> {
  return { Findings: claims.map((c) => ({ children: { Claim: [{ value: c }] } })) }
}

function expectMerged(outcome: MergeOutcome): asserts outcome is MergeOutcome & { kind: 'merged' } {
  if (outcome.kind !== 'merged') throw new Error(`Expected a merge, got a refusal: ${outcome.reason}`)
}

function expectRefused(outcome: MergeOutcome): asserts outcome is MergeOutcome & { kind: 'refused' } {
  if (outcome.kind !== 'refused') throw new Error('Expected a refusal, got a merge')
}

function conflictAt(conflicts: FieldConflict[], canonical: string): FieldConflict | undefined {
  return conflicts.find((c) => c.canonical === canonical)
}

describe('merge3', () => {
  it('takes the shared value when both sides agree', () => {
    expect(merge3(1, 2, 2, (a, b) => a === b)).toEqual({ value: 2 })
  })

  it('takes theirs when only theirs changed away from base', () => {
    expect(merge3(1, 1, 2, (a, b) => a === b)).toEqual({ value: 2 })
  })

  it('takes ours when only ours changed away from base', () => {
    expect(merge3(1, 2, 1, (a, b) => a === b)).toEqual({ value: 2 })
  })

  it('returns null when both changed, differently', () => {
    expect(merge3(1, 2, 3, (a, b) => a === b)).toBeNull()
  })
})

describe('mergeProjects — the field-level guarantee', () => {
  it('takes ours when only ours changed a field, with no conflict', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('takes theirs when only theirs changed a field, with no conflict', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('Survey')
  })

  it('has no conflict when both sides changed a field to the same value', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('conflicts when both sides changed a field differently, and merged holds ours', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toHaveLength(1)
    const c = outcome.conflicts[0]
    expect(c.canonical).toBe('Study Type')
    expect(c.tree).toEqual({ kind: 'annotations' })
    expect(c.base).toBeNull()
    expect(c.ours).toBe('RCT')
    expect(c.theirs).toBe('Survey')
    // Ours until the reviewer resolves it — the safe side.
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('conflicts when the file did not exist at the base and the sides disagree', () => {
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(null, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toHaveLength(1)
  })

  it('has no conflict when the file did not exist at the base and both sides agree', () => {
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const outcome = mergeProjects(null, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
  })

  it('absent and empty merge the same way: filling a blank field is unopposed', () => {
    const base = project({ papers: [paper('a')] }) // Study Type absent -> normalized to null
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a')] }) // left empty
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('a boolean can never conflict', () => {
    const base = project({ papers: [paper('a', { annotations: { Relevant: [{ value: false }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { Relevant: [{ value: true }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { Relevant: [{ value: false }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].annotations.Relevant[0].value).toBe(true)
    expect(outcome.conflicts.filter((c) => c.type === 'boolean')).toEqual([])
  })
})

describe('mergeProjects — repeatable nodes', () => {
  it('keeps both entries — not a conflict, not a dropped one — when both sides append', () => {
    // The corrected expectation for what used to be "conflicts only at the
    // colliding index when both sides grow the list": that framing was the
    // bug. Both sides *added* a new, unrelated entry at the same position;
    // treating that as one slot with two competing values either destroyed
    // one entry outright ("use all remote") or let a reviewer recombine the
    // two into a finding neither of them wrote. See Bug 1 in merge.ts.
    const base = project({ schema: REPEAT2, papers: [paper('a', { annotations: findings2Tree([['A', 'a']]) })] })
    const ours = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['B', 'b']]) })],
    })
    const theirs = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['C', 'c']]) })],
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    const rows = outcome.merged.papers[0].annotations.Findings.map(
      (f) => [f.children!.Claim[0].value, f.children!.Metric[0].value] as const,
    )
    expect(rows).toContainEqual(['B', 'b'])
    expect(rows).toContainEqual(['C', 'c'])
    // The pathological outcome — a row combining one side's Claim with the
    // other's Metric, a finding neither reviewer wrote — must not be
    // reachable, from either the merge itself or a resolution built on it.
    expect(rows.some(([claim, metric]) => (claim === 'B' && metric === 'c') || (claim === 'C' && metric === 'b'))).toBe(
      false,
    )
    expect(outcome.notes.some((n) => n.kind === 'repeatable-additions-kept')).toBe(true)
  })

  it('refuses when one side deletes an entry and the other edits an entry stranded past the deletion', () => {
    // Bug 2: a deletion shifts every later index, so ours' correction to
    // finding B's Metric lands on the same array slot theirs' deletion of A
    // vacated. There is no safe guess here — refuse and name the paper.
    const base = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['B', 'b']]) })],
    })
    const ours = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['B', 'b2']]) })],
    })
    const theirs = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['B', 'b']]) })],
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectRefused(outcome)
    expect(outcome.details.some((d) => /Findings/.test(d) && /Paper a/.test(d))).toBe(true)
  })

  it('refuses the symmetric case: ours deletes, theirs edits the stranded entry', () => {
    const base = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['B', 'b']]) })],
    })
    const ours = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['B', 'b']]) })],
    })
    const theirs = project({
      schema: REPEAT2,
      papers: [paper('a', { annotations: findings2Tree([['A', 'a'], ['B2', 'b']]) })],
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectRefused(outcome)
    expect(outcome.details.some((d) => /Findings/.test(d) && /Paper a/.test(d))).toBe(true)
  })

  it('grows cleanly when only one side adds an entry', () => {
    const base = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A']) })] })
    const ours = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A', 'B']) })] })
    const theirs = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A']) })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations.Findings.map((f) => f.children!.Claim[0].value)).toEqual([
      'A',
      'B',
    ])
  })

  it('preserves an interior gap when only a later entry is edited', () => {
    const base = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A', null, 'C']) })] })
    const ours = project({
      schema: REPEAT,
      papers: [paper('a', { annotations: findingsTree(['A', null, 'C2']) })],
    })
    const theirs = project({
      schema: REPEAT,
      papers: [paper('a', { annotations: findingsTree(['A', null, 'C']) })],
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const findings = outcome.merged.papers[0].annotations.Findings
    expect(findings).toHaveLength(3)
    expect(findings[1].children!.Claim[0].value).toBeNull()
    expect(findings[2].children!.Claim[0].value).toBe('C2')
  })

  it('an instance removed on one side is dropped on save, via the ordinary prune', () => {
    const base = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A', 'B']) })] })
    const ours = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A', 'B']) })] })
    const theirs = project({ schema: REPEAT, papers: [paper('a', { annotations: findingsTree(['A']) })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const saved = JSON.parse(serializeProject(outcome.merged)) as {
      papers: { annotations: { Findings: unknown[] } }[]
    }
    expect(saved.papers[0].annotations.Findings).toHaveLength(1)
  })

  it('never exceeds a repeatable node\'s max even when every side is already at it', () => {
    const capped: AnnotationDef[] = [
      { name: 'Findings', max: 2, children: [{ name: 'Claim', type: 'string' }] },
    ]
    const base = project({ schema: capped, papers: [paper('a', { annotations: findingsTree(['A']) })] })
    const ours = project({ schema: capped, papers: [paper('a', { annotations: findingsTree(['A', 'B']) })] })
    const theirs = project({ schema: capped, papers: [paper('a', { annotations: findingsTree(['A']) })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].annotations.Findings.length).toBeLessThanOrEqual(2)
  })
})

describe('mergeProjects — multiple reviewers', () => {
  function reviewerProject(reviews: Record<string, unknown>): Project {
    return project({ reviewers: 2, papers: [paper('a', { reviews })] })
  }
  const empty = { 'Study Type': [{ value: null }], Year: [{ value: null }], Relevant: [{ value: false }] }

  it('the headline case: disjoint edits by two reviewers both survive, with zero conflicts', () => {
    const base = reviewerProject({ '1': empty, '2': empty })
    const ours = reviewerProject({
      '1': { ...empty, 'Study Type': [{ value: 'RCT' }] },
      '2': empty,
    })
    const theirs = reviewerProject({
      '1': empty,
      '2': { ...empty, 'Study Type': [{ value: 'Survey' }] },
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].reviews['1']['Study Type'][0].value).toBe('RCT')
    expect(outcome.merged.papers[0].reviews['2']['Study Type'][0].value).toBe('Survey')
  })

  it('conflicts when both sides change the same reviewer\'s field differently', () => {
    const base = reviewerProject({ '1': empty, '2': empty })
    const ours = reviewerProject({ '1': { ...empty, 'Study Type': [{ value: 'RCT' }] }, '2': empty })
    const theirs = reviewerProject({ '1': { ...empty, 'Study Type': [{ value: 'Survey' }] }, '2': empty })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toHaveLength(1)
    expect(outcome.conflicts[0].tree).toEqual({ kind: 'review', reviewer: '1' })
  })

  it('keeps a reviewer tree only one side has, and drops one neither side has', () => {
    const base = reviewerProject({})
    const ours = reviewerProject({ '1': { ...empty, 'Study Type': [{ value: 'RCT' }] } })
    const theirs = reviewerProject({ '2': { ...empty, 'Study Type': [{ value: 'Survey' }] } })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].reviews['1']['Study Type'][0].value).toBe('RCT')
    expect(outcome.merged.papers[0].reviews['2']['Study Type'][0].value).toBe('Survey')
  })
})

describe('mergeProjects — papers added and removed', () => {
  it('keeps a paper added locally', () => {
    const base = project({ papers: [] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a'])
    expect(outcome.notes.some((n) => n.kind === 'paper-added-local')).toBe(true)
  })

  it('appends a paper added remotely, after ours\' own papers', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [paper('a'), paper('b')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a', 'b'])
    expect(outcome.notes.some((n) => n.kind === 'paper-added-remote')).toBe(true)
  })

  it('drops a paper removed remotely that ours never touched', () => {
    const base = project({ papers: [paper('a'), paper('b')] })
    const ours = project({ papers: [paper('a'), paper('b')] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a'])
    expect(outcome.notes.some((n) => n.kind === 'paper-removed-remote')).toBe(true)
  })

  it('keeps a paper removed remotely if ours annotated it', () => {
    const base = project({ papers: [paper('a'), paper('b')] })
    const ours = project({
      papers: [paper('a'), paper('b', { annotations: { 'Study Type': [{ value: 'RCT' }] } })],
    })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a', 'b'])
    expect(outcome.notes.some((n) => n.kind === 'paper-kept')).toBe(true)
  })

  it('keeps a paper removed locally if theirs annotated it', () => {
    // The symmetric branch of the test above: this time ours is the side that
    // deleted the paper, and theirs is the side that annotated it. Same
    // removal asymmetry, mirrored.
    const base = project({ papers: [paper('a'), paper('b')] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({
      papers: [paper('a'), paper('b', { annotations: { 'Study Type': [{ value: 'RCT' }] } })],
    })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a', 'b'])
    expect(outcome.notes.some((n) => n.kind === 'paper-kept')).toBe(true)
  })

  it('drops a paper removed on both sides silently', () => {
    const base = project({ papers: [paper('a'), paper('b')] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.map((p) => p.id)).toEqual(['a'])
    expect(outcome.notes.some((n) => n.kind.startsWith('paper-removed'))).toBe(false)
  })
})

describe('mergeProjects — schema changes', () => {
  const MINUS_RELEVANT: AnnotationDef[] = [
    { name: 'Study Type', type: 'string' },
    { name: 'Year', type: 'number' },
  ]
  const PLUS_X: AnnotationDef[] = [...SIMPLE, { name: 'Extra X', type: 'string' }]
  const PLUS_Y: AnnotationDef[] = [...SIMPLE, { name: 'Extra Y', type: 'string' }]

  it('uses the remote schema when only the remote changed it, and drops a field it removed', () => {
    const base = project({ schema: SIMPLE, papers: [paper('a')] })
    const ours = project({ schema: SIMPLE, papers: [paper('a')] })
    const theirs = project({ schema: MINUS_RELEVANT, papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Study Type', 'Year'])
    expect(outcome.merged.papers[0].annotations.Relevant).toBeUndefined()
    expect(outcome.notes.some((n) => n.kind === 'schema-remote')).toBe(true)
  })

  it('keeps answers under a field the remote removed, hidden, and says so', () => {
    // The merged tree is walked against every node either side kept, and an
    // answer under a node the schema no longer has rides along as a hidden
    // answer — so removing a field on one side never discards the other
    // side's answers under it.
    const base = project({ schema: SIMPLE, papers: [paper('a')] })
    const ours = project({
      schema: SIMPLE,
      papers: [paper('a', { annotations: { Relevant: [{ value: true }] } })],
    })
    const theirs = project({ schema: MINUS_RELEVANT, papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Study Type', 'Year'])
    expect(outcome.merged.papers[0].annotations.Relevant).toEqual([{ value: true }])
    expect(outcome.notes.some((n) => n.kind === 'schema-removed-answers' && /Relevant/.test(n.message))).toBe(true)
  })

  it('still merges cleanly when a remote schema removal has no answers under it', () => {
    // The complementary, legitimate case: nothing is at stake, so the
    // ordinary "remote schema wins" path must not regress into a refusal.
    const base = project({ schema: SIMPLE, papers: [paper('a')] })
    const ours = project({ schema: SIMPLE, papers: [paper('a')] })
    const theirs = project({ schema: MINUS_RELEVANT, papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Study Type', 'Year'])
    expect(outcome.merged.papers[0].annotations.Relevant).toBeUndefined()
    expect(outcome.notes.some((n) => n.kind === 'schema-remote')).toBe(true)
  })

  it('combines a schema both sides extended, node by node', () => {
    const base = project({ schema: SIMPLE, papers: [] })
    const ours = project({ schema: PLUS_X, papers: [] })
    const theirs = project({ schema: PLUS_Y, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Study Type', 'Year', 'Relevant', 'Extra X', 'Extra Y'])
    expect(outcome.conflicts).toEqual([])
  })

  it('asks for the reviewer count when both sides changed it, differently', () => {
    const base = project({ reviewers: 1, papers: [] })
    const ours = project({ reviewers: 2, papers: [] })
    const theirs = project({ reviewers: 3, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const row = outcome.conflicts.find((c) => c.canonical === 'reviewers')!
    expect(row).toMatchObject({ type: 'number', ours: 2, theirs: 3 })
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [row.id]: 4 }).reviewers).toBe(4)
  })

  it('carries a non-screening project\'s screening field through as null', () => {
    // The regression this guards: `Project.screening` is a required field, and
    // an ordinary merge must still produce a value for it — not `undefined` —
    // even though nothing in this test ever sets it explicitly.
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.screening).toBeNull()
  })

  it('carries a screening project\'s config through when only the remote turned it on', () => {
    const base = project({ papers: [] })
    const ours = project({ papers: [] })
    const theirs = project({ screening: { reasons: ['Wrong topic'] }, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.screening).toEqual({ reasons: ['Wrong topic'] })
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Decision', 'Reason'])
    expect(outcome.notes.some((n) => n.kind === 'screening-remote')).toBe(true)
  })

  it('asks whose screening setup to keep when both sides changed it, differently', () => {
    const base = project({ screening: { reasons: ['Wrong topic'] }, papers: [] })
    const ours = project({ screening: { reasons: ['Duplicate'] }, papers: [] })
    const theirs = project({ screening: { reasons: ['Not in English'] }, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const row = outcome.conflicts.find((c) => c.canonical === 'screening')!
    expect(row.type).toBe('choice')
    expect(row.theirsText).toMatch(/Not in English/)
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [row.id]: 'theirs' })
    expect(resolved.screening).toEqual({ reasons: ['Not in English'] })
    expect(resolved.schema.find((d) => d.name === 'Reason')?.options).toContain('Not in English')
  })

  it('takes the remote turning screening off, when only the remote changed it', () => {
    const base = project({ screening: { reasons: ['Wrong topic'] }, papers: [] })
    const ours = project({ screening: { reasons: ['Wrong topic'] }, papers: [] }) // unchanged
    const theirs = project({ schema: SIMPLE, papers: [] }) // switched to an authored schema
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome) // only theirs changed — takes theirs, same as any other reshaping field
    expect(outcome.merged.screening).toBeNull()
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(SIMPLE.map((d) => d.name))
  })

  it('asks whose value to keep for a root extra key both sides changed', () => {
    const base = project({ extra: { source: 'a' } })
    const ours = project({ extra: { source: 'b' } })
    const theirs = project({ extra: { source: 'c' } })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const row = outcome.conflicts.find((c) => c.canonical === 'extra.source')!
    expect(outcome.merged.extra.source).toBe('b')
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [row.id]: 'theirs' }).extra.source).toBe('c')
  })

  it('asks whose value to keep for a paper extra key both sides changed', () => {
    const base = project({ papers: [paper('a', { extra: { note: 'base' } })] })
    const ours = project({ papers: [paper('a', { extra: { note: 'ours' } })] })
    const theirs = project({ papers: [paper('a', { extra: { note: 'theirs' } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const row = outcome.conflicts.find((c) => c.canonical === 'extra.note')!
    expect(row.paperId).toBe('a')
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [row.id]: 'theirs' }).papers[0].extra.note).toBe('theirs')
  })
})

describe('mergeProjects — provenance', () => {
  const PROV_A = {
    kind: 'screening-import',
    source: { file: 'screening.json' },
    importedAt: '2026-07-15T10:00:00.000Z',
    counts: { included: 1, undecided: 0, excluded: 0, carried: 1 },
  }
  const PROV_B = {
    kind: 'screening-import',
    source: { file: 'other-screening.json' },
    importedAt: '2026-07-16T10:00:00.000Z',
    counts: { included: 2, undecided: 0, excluded: 0, carried: 2 },
  }

  it('carries a non-imported project\'s provenance through as null', () => {
    // Required-nullable, same regression `screening` guards above: a plain
    // merge must still produce a value, never `undefined`.
    const base = project({ papers: [] })
    const ours = project({ papers: [] })
    const theirs = project({ papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.provenance).toBeNull()
  })

  it('takes the remote value when only the remote set it, with no note', () => {
    const base = project({ papers: [] })
    const ours = project({ papers: [] })
    const theirs = project({ provenance: PROV_A, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.provenance).toEqual(PROV_A)
    // Nothing here reshapes anything, unlike schema/reviewers/screening, so
    // there is nothing worth a "the remote changed X" note about.
    expect(outcome.notes).toEqual([])
  })

  it('preserves an unchanged provenance when the other side changed something unrelated', () => {
    const base = project({ provenance: PROV_A, papers: [paper('a')] })
    const ours = project({ provenance: PROV_A, title: 'Renamed', papers: [paper('a')] })
    const theirs = project({ provenance: PROV_A, papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.provenance).toEqual(PROV_A)
  })

  it('asks whose provenance to keep when both sides set a different one', () => {
    const base = project({ papers: [] })
    const ours = project({ provenance: PROV_A, papers: [] })
    const theirs = project({ provenance: PROV_B, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const row = outcome.conflicts.find((c) => c.canonical === 'provenance')!
    expect(row.theirsText).toMatch(/other-screening\.json/)
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [row.id]: 'theirs' }).provenance).toEqual(PROV_B)
  })

  it('merges cleanly when both sides independently set the identical provenance', () => {
    const base = project({ papers: [] })
    const ours = project({ provenance: PROV_A, papers: [] })
    const theirs = project({ provenance: PROV_A, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.provenance).toEqual(PROV_A)
  })
})

describe('mergeProjects — protocol', () => {
  const PROTO_A = { researchQuestions: ['RQ1'], databases: ['Scopus'] }
  const PROTO_B = { researchQuestions: ['A different RQ'], databases: ['IEEE'] }

  it('carries a project with no protocol through as null', () => {
    const outcome = mergeProjects(project({ papers: [] }), project({ papers: [] }), project({ papers: [] }))
    expectMerged(outcome)
    expect(outcome.merged.protocol).toBeNull()
  })

  it('takes the one side that authored a protocol', () => {
    const base = project({ papers: [] })
    const ours = project({ protocol: PROTO_A, papers: [] })
    const theirs = project({ papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.protocol).toEqual(PROTO_A)
  })

  it('keeps an unchanged protocol when the other side changed something unrelated', () => {
    const base = project({ protocol: PROTO_A, papers: [paper('a')] })
    const ours = project({ protocol: PROTO_A, title: 'Renamed', papers: [paper('a')] })
    const theirs = project({ protocol: PROTO_A, papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.protocol).toEqual(PROTO_A)
  })

  it('asks per protocol entry when both sides edited it differently — never half-drops an authored one', () => {
    const base = project({ protocol: PROTO_A, papers: [] })
    const ours = project({ protocol: PROTO_B, papers: [] })
    const theirs = project({ protocol: { researchQuestions: ['A third RQ'] }, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const rq = outcome.conflicts.find((c) => c.canonical === 'protocol.researchQuestions')!
    const db = outcome.conflicts.find((c) => c.canonical === 'protocol.databases')!
    expect(rq).toMatchObject({ ours: 'A different RQ', theirs: 'A third RQ' })
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, {
      [rq.id]: 'A different RQ\nA third RQ',
      [db.id]: 'IEEE',
    })
    expect(resolved.protocol).toEqual({ researchQuestions: ['A different RQ', 'A third RQ'], databases: ['IEEE'] })
  })

  it('merges cleanly when both sides independently authored the identical protocol', () => {
    const base = project({ papers: [] })
    const ours = project({ protocol: PROTO_A, papers: [] })
    const theirs = project({ protocol: PROTO_A, papers: [] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.protocol).toEqual(PROTO_A)
  })
})

describe('mergeProjects — AI usage disclosure (append-only union)', () => {
  it('unions and dedups, sorted by appliedAt; a lost record comes back if the other side still has it', () => {
    const rec1 = { provider: 'openai', model: 'gpt', appliedAt: '2024-01-01T00:00:00Z' }
    const rec2 = { provider: 'anthropic', model: 'claude', appliedAt: '2024-02-01T00:00:00Z' }
    const base = project({ papers: [paper('a', { aiUsage: [rec1] })] })
    // ours "lost" rec1 (e.g. a hand-edit); theirs still has it, and also gained rec2.
    const ours = project({ papers: [paper('a', { aiUsage: [] })] })
    const theirs = project({ papers: [paper('a', { aiUsage: [rec1, rec2] })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].aiUsage).toEqual([rec1, rec2])
  })

  it('never duplicates a record both sides carry', () => {
    const rec = { provider: 'openai', model: 'gpt', appliedAt: '2024-01-01T00:00:00Z' }
    const base = project({ papers: [paper('a', { aiUsage: [rec] })] })
    const ours = project({ papers: [paper('a', { aiUsage: [rec] })] })
    const theirs = project({ papers: [paper('a', { aiUsage: [rec] })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].aiUsage).toEqual([rec])
  })
})

describe('mergeProjects — Paper.equal (a boolean set)', () => {
  it('unions additions from both sides and drops what one side deliberately removed', () => {
    const base = project({ papers: [paper('a', { equal: ['C', 'D'] })] })
    const ours = project({ papers: [paper('a', { equal: ['A', 'D'] })] }) // added A, removed C
    const theirs = project({ papers: [paper('a', { equal: ['B', 'C', 'D'] })] }) // added B, kept C
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].equal.slice().sort()).toEqual(['A', 'B', 'D'])
  })

  it('drops a mark removed on both sides', () => {
    const base = project({ papers: [paper('a', { equal: ['C'] })] })
    const ours = project({ papers: [paper('a', { equal: [] })] })
    const theirs = project({ papers: [paper('a', { equal: [] })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].equal).toEqual([])
  })
})

describe('mergeProjects — the finished declaration', () => {
  it('takes the side that changed it', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { extra: { finished: true } })] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].finished).toBe(true)
  })

  it('keeps the declaration when one side ticked it and the other unticked it', () => {
    // Deliberately asymmetric, like the deleted-vs-changed paper rule: a
    // wrongly-kept sign-off is one click from gone, a dropped one is a
    // reviewer's statement silently discarded.
    const base = project({ papers: [paper('a', { extra: { finished: true } })] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [paper('a', { extra: { finished: true } })] })
    const flipped = mergeProjects(base, ours, theirs)
    expectMerged(flipped)
    expect(flipped.merged.papers[0].finished).toBe(false) // only ours changed it

    const both = mergeProjects(
      base,
      project({ papers: [paper('a')] }),
      project({ papers: [paper('a', { extra: { finished: true } })] }),
    )
    expectMerged(both)
    expect(both.merged.papers[0].finished).toBe(false)
  })

  it('unions per-reviewer declarations', () => {
    const opts = { reviewers: 2, papers: [paper('a')] }
    const base = project(opts)
    const ours = project({ ...opts, papers: [paper('a', { extra: { reviewsFinished: { '1': true } } })] })
    const theirs = project({ ...opts, papers: [paper('a', { extra: { reviewsFinished: { '2': true } } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].reviewsFinished).toEqual({ '1': true, '2': true })
  })
})

describe('mergeProjects — paper metadata conflicts', () => {
  it('conflicts on title, with canonical "title" under the paper tree', () => {
    const base = project({ papers: [paper('a', { title: 'T0' })] })
    const ours = project({ papers: [paper('a', { title: 'T1' })] })
    const theirs = project({ papers: [paper('a', { title: 'T2' })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'title')!
    expect(c.tree).toEqual({ kind: 'paper' })
  })

  it('conflicts on authors, joined for display, and splits back on resolution', () => {
    const base = project({ papers: [paper('a', { authors: ['Amy'] })] })
    const ours = project({ papers: [paper('a', { authors: ['Amy', 'Bob'] })] })
    const theirs = project({ papers: [paper('a', { authors: ['Amy', 'Carl'] })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'authors')!
    expect(c.ours).toBe('Amy, Bob')
    expect(c.theirs).toBe('Amy, Carl')

    const resolutions: Resolutions = { [c.id]: 'Amy, Bob, , Dan' }
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, resolutions)
    const resolvedPaper = resolved.papers.find((p) => p.id === 'a')!
    expect(resolvedPaper.authors).toEqual(['Amy', 'Bob', 'Dan'])
  })
})

describe('mergeProjects — paper abstract and abstractFromPdf', () => {
  // The regression this block exists for: mergePaper built its returned Paper
  // with an explicit field list (title, authors, doi, pdf, ...) that predated
  // abstract/abstractFromPdf, and simply never grew to include them — not a
  // type error, since both are optional, so every paper's abstract vanished
  // on every pull-merge with nothing to catch it.
  it('carries an unconflicted abstract through the merge, not silently', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { abstract: 'Extracted text.', abstractFromPdf: true })] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const p = outcome.merged.papers.find((x) => x.id === 'a')!
    expect(p.abstract).toBe('Extracted text.')
    expect(p.abstractFromPdf).toBe(true)
  })

  it('conflicts on abstract text when both sides changed it differently', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { abstract: 'Mine.' })] })
    const theirs = project({ papers: [paper('a', { abstract: 'Theirs.' })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'abstract')!
    expect(c.tree).toEqual({ kind: 'paper' })
    expect(c.ours).toBe('Mine.')
    expect(c.theirs).toBe('Theirs.')

    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: 'Reconciled.' })
    expect(resolved.papers.find((p) => p.id === 'a')!.abstract).toBe('Reconciled.')
  })

  it('resolving the abstract-text conflict does not update abstractFromPdf, which already resolved on its own — the documented gap', () => {
    // `abstractFromPdf` only ever loads as `true` or `undefined` (project.ts
    // coerces anything else away), so with just two possible values a genuine
    // three-way *conflict* on the flag alone is not reachable — one side
    // always ends up matching base, and merge3 takes the other side cleanly.
    // That is exactly what makes this scenario possible: the flag resolves
    // by itself, quietly, before the person ever weighs in on the text.
    const base = project({ papers: [paper('a')] })
    // ours: extracted from the PDF, text and flag set together, as the real
    // feature always sets them.
    const ours = project({ papers: [paper('a', { abstract: 'Extracted text.', abstractFromPdf: true })] })
    // theirs: a human typed a real abstract by hand — changed the text, never
    // touched the flag.
    const theirs = project({ papers: [paper('a', { abstract: 'Typed by a human.' })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)

    // The flag already resolved to `true` with no conflict — theirs never
    // changed it away from base, so merge3 took ours' value automatically.
    expect(conflictAt(outcome.conflicts, 'abstractFromPdf')).toBeUndefined()
    expect(outcome.merged.papers.find((p) => p.id === 'a')!.abstractFromPdf).toBe(true)

    // The text itself is a real conflict — both sides changed it, differently.
    const c = conflictAt(outcome.conflicts, 'abstract')!
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: c.theirs })
    const resolvedPaper = resolved.papers.find((p) => p.id === 'a')!

    // The reviewer picked the human-typed text — but the flag still says
    // "extracted from the PDF", because nothing re-examines it once the text
    // conflict is resolved separately. This is the inconsistency the code
    // comment above the abstractFromPdf merge3 call names as out of scope for
    // this fix: not solved here, but pinned down as an observed, known gap
    // rather than left to be rediscovered as a surprise.
    expect(resolvedPaper.abstract).toBe('Typed by a human.')
    expect(resolvedPaper.abstractFromPdf).toBe(true)
  })

  it('an abstract-only local edit is never mistaken for "no change" and dropped', () => {
    // canonicalPaper (paperUnchanged's basis) is what this pins: before the
    // fix, a paper whose only edit was its abstract compared equal to the
    // base paper, so a remote deletion of it would have gone through
    // silently instead of triggering the "kept, annotated" note.
    const base = project({ papers: [paper('a', { title: 'Kept Paper' })] })
    const ours = project({ papers: [paper('a', { title: 'Kept Paper', abstract: 'New text.' })] })
    const theirs = project({ papers: [] }) // deleted remotely
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.some((p) => p.id === 'a')).toBe(true)
    expect(outcome.notes.some((n) => n.kind === 'paper-kept')).toBe(true)
  })
})

describe('mergeProjects — paper year and venue', () => {
  // Ordinary paper-level fields, merged and carried through the same way
  // title/doi are — added to `mergePaper`'s field list, `canonicalPaper`, and
  // `applyOne` in the same change that added the fields themselves, precisely
  // because abstract was once missing from exactly those three spots and
  // silently dropped on every pull-merge. This block is the regression test
  // for that not happening again to year/venue.
  it('carries an unconflicted year and venue through the merge', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { year: 2021, venue: 'ICSE' })] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const p = outcome.merged.papers.find((x) => x.id === 'a')!
    expect(p.year).toBe(2021)
    expect(p.venue).toBe('ICSE')
  })

  it('conflicts on year when both sides set it differently', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { year: 2021 })] })
    const theirs = project({ papers: [paper('a', { year: 2022 })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'year')!
    expect(c.tree).toEqual({ kind: 'paper' })
    expect(c.type).toBe('year')
    expect(c.ours).toBe(2021)
    expect(c.theirs).toBe(2022)

    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: 2022 })
    expect(resolved.papers.find((p) => p.id === 'a')!.year).toBe(2022)
  })

  it('conflicts on venue when both sides set it differently', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { venue: 'ICSE' })] })
    const theirs = project({ papers: [paper('a', { venue: 'FSE' })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'venue')!
    expect(c.ours).toBe('ICSE')
    expect(c.theirs).toBe('FSE')

    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: c.theirs })
    expect(resolved.papers.find((p) => p.id === 'a')!.venue).toBe('FSE')
  })

  it('a year/venue-only local edit is never mistaken for "no change" and dropped', () => {
    // canonicalPaper (paperUnchanged's basis) is what this pins — the same
    // hazard the abstract-only test above pins for abstract: a paper whose
    // only edit was its year/venue must not compare equal to the base paper,
    // or a remote deletion of it would go through silently instead of
    // triggering the "kept, annotated" note.
    const base = project({ papers: [paper('a', { title: 'Kept Paper' })] })
    const ours = project({
      papers: [paper('a', { title: 'Kept Paper', year: 2021, venue: 'ICSE' })],
    })
    const theirs = project({ papers: [] }) // deleted remotely
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers.some((p) => p.id === 'a')).toBe(true)
    expect(outcome.notes.some((n) => n.kind === 'paper-kept')).toBe(true)
  })
})

describe('mergeProjects — project title', () => {
  it('conflicts, but does not refuse the whole merge', () => {
    const base = project({ title: 'X' })
    const ours = project({ title: 'Y' })
    const theirs = project({ title: 'Z' })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'title')!
    expect(c.tree).toEqual({ kind: 'project' })
    expect(c.paperId).toBe('')
  })
})

describe('mergeProjects — schema info comment', () => {
  it('conflicts, but does not refuse the whole merge', () => {
    const base = project({ schemaInfo: 'X' })
    const ours = project({ schemaInfo: 'Y' })
    const theirs = project({ schemaInfo: 'Z' })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'schemaInfo')!
    expect(c.tree).toEqual({ kind: 'project' })
    expect(c.paperId).toBe('')
  })

  it('one side changing it, the other leaving it alone, merges without a conflict', () => {
    const base = project({ schemaInfo: 'X' })
    const ours = project({ schemaInfo: 'X' })
    const theirs = project({ schemaInfo: 'Y' })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(conflictAt(outcome.conflicts, 'schemaInfo')).toBeUndefined()
    expect(outcome.merged.schemaInfo).toBe('Y')
  })

  it('applyResolutions actually writes the chosen value into schemaInfo', () => {
    const base = project({ schemaInfo: 'X' })
    const ours = project({ schemaInfo: 'Y' })
    const theirs = project({ schemaInfo: 'Z' })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'schemaInfo')!
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: c.theirs }).schemaInfo).toBe('Z')
    expect(applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: '' }).schemaInfo).toBeNull()
  })
})

describe('applyResolutions', () => {
  it('writes a resolved value into the right tree and path', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'Study Type')!
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: 'Case study' })
    expect(resolved.papers[0].annotations['Study Type'][0].value).toBe('Case study')
  })

  it('keeps ours for a conflict with no resolution', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, {})
    expect(resolved.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('ignores a resolution whose id is not one of the conflicts', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a')] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(() =>
      applyResolutions(outcome.merged, outcome.conflicts, { 'not-a-real-id': 'x' }),
    ).not.toThrow()
  })
})

describe('conflictId', () => {
  it('distinguishes the same canonical path across different trees', () => {
    const ids = new Set([
      conflictId('p1', { kind: 'annotations' }, 'Study Type'),
      conflictId('p1', { kind: 'review', reviewer: '1' }, 'Study Type'),
      conflictId('p1', { kind: 'review', reviewer: '2' }, 'Study Type'),
      conflictId('p1', { kind: 'paper' }, 'title'),
    ])
    expect(ids.size).toBe(4)
  })

  it('is stable for identical inputs', () => {
    const a = conflictId('p1', { kind: 'review', reviewer: '1' }, 'Study Type')
    const b = conflictId('p1', { kind: 'review', reviewer: '1' }, 'Study Type')
    expect(a).toBe(b)
  })
})

describe('treeLabel', () => {
  it('is blank for the single tree of a single-reviewer project', () => {
    expect(treeLabel({ kind: 'annotations' }, 1)).toBe('')
  })

  it('names Consolidation for a multi-reviewer project', () => {
    expect(treeLabel({ kind: 'annotations' }, 3)).toBe('Consolidation')
  })

  it('names the project, the paper, and the reviewer', () => {
    expect(treeLabel({ kind: 'project' }, 1)).toBe('Project')
    expect(treeLabel({ kind: 'paper' }, 1)).toBe('Paper details')
    expect(treeLabel({ kind: 'review', reviewer: '2' }, 3)).toBe('Reviewer 2')
  })
})

describe('exact equality, not comparable() — a case fix survives, a case-only difference conflicts', () => {
  it('takes the side that changed capitalization when the other side left it alone', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'rct' }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'rct' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.papers[0].annotations['Study Type'][0].value).toBe('RCT')
  })

  it('conflicts when the two sides change capitalization differently — a case difference is a real difference here', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'rct' }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Rct' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toHaveLength(1)
  })
})

describe('round-trip and shape invariants', () => {
  it('a resolved merge survives serialize -> reload unchanged', () => {
    const base = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'Survey' }] } })] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const c = conflictAt(outcome.conflicts, 'Study Type')!
    const resolved = applyResolutions(outcome.merged, outcome.conflicts, { [c.id]: 'Case study' })

    const reloaded = loadProject(serializeProject(resolved))
    expect(JSON.parse(serializeProject(reloaded))).toEqual(JSON.parse(serializeProject(resolved)))
  })

  it('the merged tree is already shaped exactly as normalizeTree would produce', () => {
    const base = project({ papers: [paper('a')] })
    const ours = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const theirs = project({ papers: [paper('a')] })
    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    const tree = outcome.merged.papers[0].annotations
    expect(tree).toEqual(normalizeTree(outcome.merged.schema, tree))
  })
})

describe('mergeProjects — answers under a field the schema no longer has', () => {
  // Orphans are carried through a merge so that removing a field is not made
  // permanent by the next pull. Both sides having *different* ones is the case
  // with nowhere to render a conflict row: there is no schema left to build it
  // from, and no canonical path to key it by.
  const NO_NOTES: AnnotationDef[] = [{ name: 'Study Type', type: 'string' }]
  const orphaned = (value: string) => ({
    'Study Type': [{ value: 'RCT' }],
    Notes: [{ value }],
  })

  it('keeps ours and says so when both sides hold different ones', () => {
    const base = project({ schema: NO_NOTES, papers: [paper('a')] })
    const ours = project({ schema: NO_NOTES, papers: [paper('a', { annotations: orphaned('mine') })] })
    const theirs = project({ schema: NO_NOTES, papers: [paper('a', { annotations: orphaned('theirs') })] })

    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].annotations.Notes).toEqual([{ value: 'mine' }])
    const note = outcome.notes.find((n) => n.kind === 'orphans-kept-ours')
    expect(note?.message).toMatch(/Notes/)
  })

  it('says nothing when only one side has them — nothing was lost', () => {
    const base = project({ schema: NO_NOTES, papers: [paper('a')] })
    const ours = project({ schema: NO_NOTES, papers: [paper('a', { annotations: orphaned('mine') })] })
    const theirs = project({ schema: NO_NOTES, papers: [paper('a')] })

    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.merged.papers[0].annotations.Notes).toEqual([{ value: 'mine' }])
    expect(outcome.notes.some((n) => n.kind === 'orphans-kept-ours')).toBe(false)
  })

  it('says nothing when both sides hold the same ones', () => {
    const base = project({ schema: NO_NOTES, papers: [paper('a')] })
    const ours = project({ schema: NO_NOTES, papers: [paper('a', { annotations: orphaned('same') })] })
    const theirs = project({ schema: NO_NOTES, papers: [paper('a', { annotations: orphaned('same') })] })

    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.notes.some((n) => n.kind === 'orphans-kept-ours')).toBe(false)
  })
})

describe('mergeProjects — schema, node by node', () => {
  const merged = (base: AnnotationDef[], ours: AnnotationDef[], theirs: AnnotationDef[], papers = [paper('a')]) => {
    const outcome = mergeProjects(project({ schema: base, papers }), project({ schema: ours, papers }), project({ schema: theirs, papers }))
    expectMerged(outcome)
    return outcome
  }
  const row = (o: { conflicts: FieldConflict[] }, part: string) => o.conflicts.find((c) => JSON.parse(c.canonical)[1] === part)!

  it('merges edits to different properties of one node without asking', () => {
    const base: AnnotationDef[] = [{ name: 'Kind', type: 'string' }]
    const o = merged(base, [{ name: 'Kind', type: 'string', description: 'What kind' }], [
      { name: 'Kind', type: 'string', options: ['A', 'B'] },
    ])
    expect(o.conflicts).toEqual([])
    expect(o.merged.schema[0]).toMatchObject({ description: 'What kind', options: ['A', 'B'] })
  })

  it('asks where both sides changed the same property, and accepts a combined third version', () => {
    const base: AnnotationDef[] = [{ name: 'Kind', type: 'string', options: ['A'] }]
    const o = merged(base, [{ name: 'Kind', type: 'string', options: ['A', 'B'] }], [
      { name: 'Kind', type: 'string', options: ['A', 'C'] },
    ])
    const options = row(o, 'options')
    expect(options).toMatchObject({ type: 'string', ours: 'A\nB', theirs: 'A\nC' })
    const resolved = applyResolutions(o.merged, o.conflicts, { [options.id]: 'A\nB\nC' })
    expect(resolved.schema[0].options).toEqual(['A', 'B', 'C'])
  })

  it('merges children of a group both sides changed', () => {
    const base: AnnotationDef[] = [{ name: 'G', children: [{ name: 'a', type: 'string' }] }]
    const o = merged(
      base,
      [{ name: 'G', children: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }] }],
      [{ name: 'G', children: [{ name: 'a', type: 'string', required: true }, { name: 'c', type: 'string' }] }],
    )
    expect(o.conflicts).toEqual([])
    const g = o.merged.schema[0]
    expect(g.children.map((d) => [d.id, d.required])).toEqual([
      ['G/a', true],
      ['G/b', false],
      ['G/c', false],
    ])
  })

  it('asks to keep or remove a node one side removed and the other changed', () => {
    const base: AnnotationDef[] = [{ name: 'Keep', type: 'string' }, { name: 'X', type: 'string' }]
    const o = merged(base, [{ name: 'Keep', type: 'string' }], [
      { name: 'Keep', type: 'string' },
      { name: 'X', type: 'string', description: 'now described' },
    ])
    const presence = row(o, 'presence')
    expect(presence).toMatchObject({ type: 'choice', payload: { ours: 'remove', theirs: 'keep' } })
    // Held in the merge until decided, so the trees are merged against it.
    expect(o.merged.schema.map((d) => d.name)).toEqual(['Keep', 'X'])
    expect(applyResolutions(o.merged, o.conflicts, { [presence.id]: 'ours' }).schema.map((d) => d.name)).toEqual(['Keep'])
    expect(applyResolutions(o.merged, o.conflicts, { [presence.id]: 'theirs' }).schema.map((d) => d.name)).toEqual(['Keep', 'X'])
  })

  it('offers a type change as a choice, and keeps the answers under a node chosen away', () => {
    const base: AnnotationDef[] = [{ name: 'N', type: 'string' }]
    const answered = [paper('a', { annotations: { N: [{ value: 'seven' }] } })]
    const o = merged(base, [{ name: 'N', type: 'number' }], [{ name: 'N', type: 'year' }], answered)
    const type = row(o, 'type')
    expect(type).toMatchObject({ type: 'choice', oursText: 'Number', theirsText: 'Year' })
    expect(applyResolutions(o.merged, o.conflicts, { [type.id]: 'theirs' }).schema[0].type).toBe('year')
    expect(o.merged.papers[0].annotations.N).toEqual([{ value: 'seven' }])
  })

  it('treats a rename as a removal plus an addition, merging without asking', () => {
    const base: AnnotationDef[] = [{ name: 'Old', type: 'string' }, { name: 'Other', type: 'string' }]
    const o = merged(base, [{ name: 'New', type: 'string' }, { name: 'Other', type: 'string' }], [
      { name: 'Old', type: 'string' },
      { name: 'Other', type: 'string', required: true },
    ])
    expect(o.conflicts).toEqual([])
    expect(o.merged.schema.map((d) => d.name)).toEqual(['New', 'Other'])
  })
})

describe('mergeResultProblem', () => {
  it('names a combined schema the loader would refuse', () => {
    // Each side removed a different one of G's children, leaving it with none.
    const two = [{ name: 'G', children: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }] }] as AnnotationDef[]
    const b = project({ schema: two, papers: [] })
    const o = project({ schema: [{ name: 'G', children: [{ name: 'b', type: 'string' }] }], papers: [] })
    const t = project({ schema: [{ name: 'G', children: [{ name: 'a', type: 'string' }] }], papers: [] })
    const outcome = mergeProjects(b, o, t)
    expectMerged(outcome)
    expect(outcome.merged.schema[0].children).toEqual([])
    expect(mergeResultProblem(outcome.merged)).toBeTruthy()
    expect(mergeResultProblem(b)).toBeNull()
  })
})

describe('mergeProjects — schema versions', () => {
  const H = (id: string, parents: string[], moves: { from: string[]; to: string[] }[] = []) => ({ id, parents, at: '', moves })

  it('merges an edit made under the old name into the field the other side renamed', () => {
    const v0 = [H('v0', [])]
    const base = project({ schema: SIMPLE, papers: [paper('a')], extra: {} })
    base.schemaVersion = 'v0'
    base.schemaHistory = v0
    const ours = project({
      schema: [{ name: 'Design', type: 'string' }, ...SIMPLE.slice(1)],
      papers: [paper('a')],
    })
    ours.schemaVersion = 'v1'
    ours.schemaHistory = [...v0, H('v1', ['v0'], [{ from: ['Study Type'], to: ['Design'] }])]
    const theirs = project({ schema: SIMPLE, papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    theirs.schemaVersion = 'v0'
    theirs.schemaHistory = v0

    const outcome = mergeProjects(base, ours, theirs)
    expectMerged(outcome)
    expect(outcome.conflicts).toEqual([])
    expect(outcome.merged.schema.map((d) => d.name)).toEqual(['Design', 'Year', 'Relevant'])
    expect(outcome.merged.papers[0].annotations.Design).toEqual([{ value: 'RCT' }])
    expect(outcome.merged.schemaVersion).toBe('v1')
  })

  it('gives a merge of two new versions a version descending from both', () => {
    const v0 = [H('v0', [])]
    const mk = (schema: AnnotationDef[], v: string, h: ReturnType<typeof H>[]) => {
      const p = project({ schema, papers: [] })
      p.schemaVersion = v
      p.schemaHistory = h
      return p
    }
    const outcome = mergeProjects(
      mk(SIMPLE, 'v0', v0),
      mk([...SIMPLE, { name: 'X', type: 'string' }], 'a', [...v0, H('a', ['v0'])]),
      mk([...SIMPLE, { name: 'Y', type: 'string' }], 'b', [...v0, H('b', ['v0'])]),
    )
    expectMerged(outcome)
    const last = outcome.merged.schemaHistory.at(-1)!
    expect(outcome.merged.schemaVersion).toBe(last.id)
    expect(last.parents).toEqual(['a', 'b'])
    expect(outcome.merged.schemaHistory.map((e) => e.id).slice(0, 3)).toEqual(['v0', 'a', 'b'])
  })
})

describe('mergeProjects — a field renamed differently on each side', () => {
  const H = (id: string, parents: string[], moves: { from: string[]; to: string[] }[] = []) => ({ id, parents, at: '', moves })
  const v0 = [H('v0', [])]
  const mk = (name: string, v: string, hist: ReturnType<typeof H>[], value?: string) => {
    const p = project({ schema: [{ name, type: 'string' }], papers: [paper('a', value ? { annotations: { [name]: [{ value }] } } : {})] })
    p.schemaVersion = v
    p.schemaHistory = hist
    return p
  }
  const merge = (oursValue?: string, theirsValue?: string) => {
    const outcome = mergeProjects(
      mk('A', 'v0', v0, 'base'),
      mk('B', 'o', [...v0, H('o', ['v0'], [{ from: ['A'], to: ['B'] }])], oursValue ?? 'base'),
      mk('C', 't', [...v0, H('t', ['v0'], [{ from: ['A'], to: ['C'] }])], theirsValue ?? 'base'),
    )
    expectMerged(outcome)
    return outcome
  }
  const renameRow = (o: { conflicts: FieldConflict[] }) => o.conflicts.find((c) => c.label.includes('renamed differently'))!

  it('asks which name to keep, and merges both sides\' answers under it', () => {
    const o = merge('base', 'theirs edit')
    expect(renameRow(o)).toMatchObject({ oursText: 'Call it “B”', theirsText: 'Call it “C”' })
    expect(o.merged.schema.map((d) => d.name)).toEqual(['B'])
    // Only theirs changed the answer, so it merges without a row of its own.
    expect(o.merged.papers[0].annotations.B).toEqual([{ value: 'theirs edit' }])
    expect(o.notes.filter((n) => n.kind === 'schema-removed-answers')).toEqual([])
  })

  it("taking theirs moves the field, its answers, and the merge version's recorded move", () => {
    const o = merge('ours edit', 'base')
    const row = renameRow(o)
    const resolved = applyResolutions(o.merged, o.conflicts, { [row.id]: 'theirs' })
    expect(resolved.schema.map((d) => d.name)).toEqual(['C'])
    expect(resolved.papers[0].annotations.C).toEqual([{ value: 'ours edit' }])
    expect(resolved.schemaHistory.at(-1)!.moves).toEqual([{ from: ['B'], to: ['C'] }])
    expect(o.merged.schemaHistory.at(-1)!.moves).toEqual([{ from: ['C'], to: ['B'] }])
  })

  it('brings a file that arrives later from either branch to the chosen name', () => {
    const o = merge()
    const later = (stamp: string, tree: Record<string, unknown>) => {
      const moves = pendingMoves(o.merged.schemaHistory, stamp, o.merged.schemaVersion)
      if (moves === 'unknown') throw new Error('unknown')
      return moves.reduce(moveInTree, tree as never)
    }
    expect(later('t', { C: [{ value: 'late' }] })).toEqual({ B: [{ value: 'late' }] })
    expect(later('o', { B: [{ value: 'late' }] })).toEqual({ B: [{ value: 'late' }] })
  })

  it('applies an answer row under the field before renaming it', () => {
    const o = merge('ours edit', 'theirs edit')
    const answer = o.conflicts.find((c) => c.tree.kind === 'annotations')!
    const resolved = applyResolutions(o.merged, o.conflicts, { [renameRow(o).id]: 'theirs', [answer.id]: 'agreed' })
    expect(resolved.papers[0].annotations.C).toEqual([{ value: 'agreed' }])
  })
})
