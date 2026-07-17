import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject, type Project } from '../model/project'
import type { AnnotationDef } from '../model/schema'
import { detectFieldChanges, composeContents, type Disposition } from './changes'

/**
 * Fixtures are built through `loadProject`, the same rule `merge.test.ts`
 * follows — so `head`/`working` are exactly as schema-normalized and
 * empty-skeleton-shaped as what the store actually hands this module.
 */

const SIMPLE: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
]

const REPEAT: AnnotationDef[] = [
  { name: 'Findings', max: null, children: [{ name: 'Claim', type: 'string' }] },
]

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
  }
}

interface ProjectOpts {
  schema?: AnnotationDef[]
  reviewers?: number
  papers?: Record<string, unknown>[]
  provenance?: unknown
  reviewerIdentities?: Record<string, unknown>
}

function project(opts: ProjectOpts = {}): Project {
  const config: Record<string, unknown> = { schema: opts.schema ?? SIMPLE }
  if (opts.reviewers !== undefined) config.reviewers = opts.reviewers
  if (opts.reviewerIdentities !== undefined) config.reviewerIdentities = opts.reviewerIdentities
  return loadProject({
    version: 1,
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
    config,
    papers: opts.papers ?? [],
  })
}

function decisionsOf(id: string, disposition: Disposition): Record<string, Disposition> {
  return { [id]: disposition }
}

describe('detectFieldChanges — structural changes refuse field-level review', () => {
  it('returns null when the schema differs', () => {
    const head = project({ schema: SIMPLE })
    const working = project({ schema: [...SIMPLE, { name: 'Extra', type: 'string' }] })
    expect(detectFieldChanges(head, working)).toBeNull()
  })

  it('returns null when config.reviewers differs', () => {
    const head = project({ reviewers: 1 })
    const working = project({ reviewers: 2 })
    expect(detectFieldChanges(head, working)).toBeNull()
  })

  it('returns a real result when nothing structural differs', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a')] })
    expect(detectFieldChanges(head, working)).not.toBeNull()
  })

  it('returns null when provenance differs', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({
      papers: [paper('a')],
      provenance: {
        kind: 'screening-import',
        source: { file: 'screening.json' },
        importedAt: '2026-07-15T10:00:00.000Z',
        counts: { included: 1, undecided: 0, excluded: 0, carried: 1 },
      },
    })
    expect(detectFieldChanges(head, working)).toBeNull()
  })

  it('returns null when config.reviewerIdentities differs — a seat claim is not a per-field decision', () => {
    const head = project({ reviewers: 2, papers: [paper('a')] })
    const working = project({
      reviewers: 2,
      reviewerIdentities: { '1': { email: 'alice@kit.edu' } },
      papers: [paper('a')],
    })
    expect(detectFieldChanges(head, working)).toBeNull()
  })

  it('is not obstructed by an identical provenance on both sides', () => {
    const provenance = {
      kind: 'screening-import',
      source: { file: 'screening.json' },
      importedAt: '2026-07-15T10:00:00.000Z',
      counts: { included: 1, undecided: 0, excluded: 0, carried: 1 },
    }
    const head = project({ papers: [paper('a')], provenance })
    const working = project({
      papers: [paper('a', { annotations: { Relevant: [{ value: true }] } })],
      provenance,
    })
    expect(detectFieldChanges(head, working)).not.toBeNull()
  })

  it('self-heals: once head and working share the same claim, field-level review resumes', () => {
    const identities = { '1': { email: 'alice@kit.edu' } }
    const head = project({ reviewers: 2, reviewerIdentities: identities, papers: [paper('a', { title: 'Old' })] })
    const working = project({
      reviewers: 2,
      reviewerIdentities: identities,
      papers: [paper('a', { title: 'New' })],
    })
    const result = detectFieldChanges(head, working)
    expect(result).not.toBeNull()
    expect(result!.fields.some((f) => f.canonical === 'title')).toBe(true)
  })
})

describe('detectFieldChanges — no changes', () => {
  it('reports nothing for identical projects', () => {
    const head = project({ papers: [paper('a', { annotations: { Relevant: [{ value: true }] } })] })
    const working = project({ papers: [paper('a', { annotations: { Relevant: [{ value: true }] } })] })
    const result = detectFieldChanges(head, working)!
    expect(result.fields).toEqual([])
    expect(result.papers).toEqual([])
  })
})

describe('detectFieldChanges — paper metadata', () => {
  it('detects a title change with both values', () => {
    const head = project({ papers: [paper('a', { title: 'Old Title' })] })
    const working = project({ papers: [paper('a', { title: 'New Title' })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'title')!
    expect(c.headValue).toBe('Old Title')
    expect(c.workingValue).toBe('New Title')
    expect(c.tree).toEqual({ kind: 'paper' })
  })

  it('detects an authors change, joined for display', () => {
    const head = project({ papers: [paper('a', { authors: ['Amy'] })] })
    const working = project({ papers: [paper('a', { authors: ['Amy', 'Bob'] })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'authors')!
    expect(c.headValue).toBe('Amy')
    expect(c.workingValue).toBe('Amy, Bob')
  })

  it('detects a DOI going from absent to present', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a', { doi: '10.1000/xyz' })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'doi')!
    expect(c.headValue).toBeNull()
    expect(c.workingValue).toBe('10.1000/xyz')
  })

  it('detects a year change, typed as "year" not "number"', () => {
    const head = project({ papers: [paper('a', { year: 2021 })] })
    const working = project({ papers: [paper('a', { year: 2022 })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'year')!
    expect(c.headValue).toBe(2021)
    expect(c.workingValue).toBe(2022)
    expect(c.type).toBe('year')
  })

  it('detects a venue change', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a', { venue: 'ICSE' })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'venue')!
    expect(c.headValue).toBeNull()
    expect(c.workingValue).toBe('ICSE')
  })
})

describe('detectFieldChanges — abstract/abstractFromPdf bundling', () => {
  it('bundles abstractFromPdf into the abstract row when both changed together', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a', { abstract: 'Extracted.', abstractFromPdf: true })] })
    const result = detectFieldChanges(head, working)!
    expect(result.fields.find((f) => f.canonical === 'abstractFromPdf')).toBeUndefined()
    const c = result.fields.find((f) => f.canonical === 'abstract')!
    expect(c.workingValue).toBe('Extracted.')
    expect(c.bundled).toEqual(['abstractFromPdf'])
  })

  it('does not bundle abstractFromPdf when only the abstract text changed', () => {
    // A reference-import supplying a real abstract for a paper that never
    // had abstractFromPdf set — no flag to fold in.
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a', { abstract: 'From a reference file.' })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'abstract')!
    expect(c.bundled).toEqual([])
  })

  it('falls back to its own row when abstractFromPdf changes without the text (edge case)', () => {
    // Not a path the app's own code takes, but a hand-edited file could.
    const head = project({ papers: [paper('a', { abstract: 'Same text.' })] })
    const working = project({
      papers: [{ ...paper('a', { abstract: 'Same text.' }), abstractFromPdf: true }],
    })
    const result = detectFieldChanges(head, working)!
    expect(result.fields.find((f) => f.canonical === 'abstract')).toBeUndefined()
    const c = result.fields.find((f) => f.canonical === 'abstractFromPdf')!
    expect(c.workingValue).toBe('Extracted from the PDF')
  })
})

describe('detectFieldChanges — annotation tree fields', () => {
  it('detects a change in the single/consolidated tree', () => {
    const head = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: null }] } })] })
    const working = project({ papers: [paper('a', { annotations: { 'Study Type': [{ value: 'RCT' }] } })] })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'Study Type')!
    expect(c.headValue).toBeNull()
    expect(c.workingValue).toBe('RCT')
    expect(c.tree).toEqual({ kind: 'annotations' })
  })

  it('detects a change in a numbered reviewer\'s own tree, not the consolidated one', () => {
    const head = project({
      reviewers: 2,
      papers: [paper('a', { reviews: { '1': { Relevant: [{ value: false }] }, '2': { Relevant: [{ value: false }] } } })],
    })
    const working = project({
      reviewers: 2,
      papers: [paper('a', { reviews: { '1': { Relevant: [{ value: true }] }, '2': { Relevant: [{ value: false }] } } })],
    })
    const result = detectFieldChanges(head, working)!
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].tree).toEqual({ kind: 'review', reviewer: '1' })
    expect(result.fields[0].workingValue).toBe(true)
  })

  it('detects a change nested inside a repeatable group, labelled with its instance number', () => {
    const head = project({ schema: REPEAT, papers: [paper('a', { annotations: {} })] })
    const working = project({
      schema: REPEAT,
      papers: [paper('a', { annotations: { Findings: [{ children: { Claim: [{ value: 'X improves Y' }] } }] } })],
    })
    const result = detectFieldChanges(head, working)!
    const c = result.fields.find((f) => f.canonical === 'Findings/Claim')!
    expect(c.workingValue).toBe('X improves Y')
    expect(c.label).toContain('Findings')
  })
})

describe('detectFieldChanges — papers added and removed', () => {
  it('reports a paper only in the working tree as added', () => {
    const head = project({ papers: [] })
    const working = project({ papers: [paper('a', { title: 'New Paper' })] })
    const result = detectFieldChanges(head, working)!
    expect(result.papers).toEqual([
      expect.objectContaining({ paperId: 'a', paperTitle: 'New Paper', kind: 'added' }),
    ])
    expect(result.fields).toEqual([]) // no field-level rows for a paper that doesn't exist on both sides
  })

  it('reports a paper only in HEAD as removed', () => {
    const head = project({ papers: [paper('a', { title: 'Deleted Paper' })] })
    const working = project({ papers: [] })
    const result = detectFieldChanges(head, working)!
    expect(result.papers).toEqual([
      expect.objectContaining({ paperId: 'a', paperTitle: 'Deleted Paper', kind: 'removed' }),
    ])
  })
})

describe('composeContents — field-level dispositions', () => {
  const head = project({ papers: [paper('a', { title: 'Old Title' })] })
  const working = project({ papers: [paper('a', { title: 'New Title' })] })
  const changes = detectFieldChanges(head, working)!
  const fieldId = changes.fields[0].id

  it('use: committed gets the new value, the working file is unaffected', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(fieldId, 'use'))
    expect(committed.papers[0].title).toBe('New Title')
    expect(workingOut.papers[0].title).toBe('New Title')
  })

  it('ignore: committed keeps the old value, the working file still has the new one', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(fieldId, 'ignore'))
    expect(committed.papers[0].title).toBe('Old Title')
    expect(workingOut.papers[0].title).toBe('New Title')
  })

  it('discard: committed keeps the old value, and the working file is reverted to match', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(fieldId, 'discard'))
    expect(committed.papers[0].title).toBe('Old Title')
    expect(workingOut.papers[0].title).toBe('Old Title')
  })

  it('defaults to "use" for a field with no recorded decision', () => {
    const { committed } = composeContents(head, working, changes, {})
    expect(committed.papers[0].title).toBe('New Title')
  })
})

describe('composeContents — year and venue write-back', () => {
  // A dedicated pair, not just reused via `title` above: `writePaperMeta`'s
  // `year` case round-trips the value through `parseYear` rather than writing
  // it straight through, so this is the one place that boundary is actually
  // exercised end to end.
  const head = project({ papers: [paper('a', { year: 2021, venue: 'ICSE' })] })
  const working = project({ papers: [paper('a', { year: 2022, venue: 'FSE' })] })
  const changes = detectFieldChanges(head, working)!
  const yearId = changes.fields.find((f) => f.canonical === 'year')!.id
  const venueId = changes.fields.find((f) => f.canonical === 'venue')!.id

  it('use: commits the new year and venue', () => {
    const { committed } = composeContents(head, working, changes, {
      ...decisionsOf(yearId, 'use'),
      ...decisionsOf(venueId, 'use'),
    })
    expect(committed.papers[0].year).toBe(2022)
    expect(committed.papers[0].venue).toBe('FSE')
  })

  it('discard: reverts the working file to the old year and venue', () => {
    const { committed, workingOut } = composeContents(head, working, changes, {
      ...decisionsOf(yearId, 'discard'),
      ...decisionsOf(venueId, 'discard'),
    })
    expect(committed.papers[0].year).toBe(2021)
    expect(committed.papers[0].venue).toBe('ICSE')
    expect(workingOut.papers[0].year).toBe(2021)
    expect(workingOut.papers[0].venue).toBe('ICSE')
  })
})

describe('composeContents — the abstract/abstractFromPdf bundle applies together', () => {
  it('carries the real boolean, not the display string, through "use"', () => {
    const head = project({ papers: [paper('a')] })
    const working = project({ papers: [paper('a', { abstract: 'Extracted.', abstractFromPdf: true })] })
    const changes = detectFieldChanges(head, working)!
    const fc = changes.fields.find((f) => f.canonical === 'abstract')!

    const used = composeContents(head, working, changes, decisionsOf(fc.id, 'use'))
    expect(used.committed.papers[0].abstract).toBe('Extracted.')
    expect(used.committed.papers[0].abstractFromPdf).toBe(true)

    const discarded = composeContents(head, working, changes, decisionsOf(fc.id, 'discard'))
    expect(discarded.workingOut.papers[0].abstract).toBeUndefined()
    expect(discarded.workingOut.papers[0].abstractFromPdf).toBeUndefined()
  })
})

describe('composeContents — paper added locally', () => {
  const head = project({ papers: [] })
  const working = project({ papers: [paper('a', { title: 'New Paper' })] })
  const changes = detectFieldChanges(head, working)!
  const paperChangeId = changes.papers[0].id

  it('use: the paper is committed and stays in the working tree', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'use'))
    expect(committed.papers.map((p) => p.id)).toEqual(['a'])
    expect(workingOut.papers.map((p) => p.id)).toEqual(['a'])
  })

  it('ignore: not committed yet, but still on disk for next time', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'ignore'))
    expect(committed.papers).toEqual([])
    expect(workingOut.papers.map((p) => p.id)).toEqual(['a'])
  })

  it('discard: not committed, and deleted from the working tree too', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'discard'))
    expect(committed.papers).toEqual([])
    expect(workingOut.papers).toEqual([])
  })
})

describe('composeContents — paper removed locally', () => {
  const head = project({ papers: [paper('a', { title: 'Old Paper' })] })
  const working = project({ papers: [] })
  const changes = detectFieldChanges(head, working)!
  const paperChangeId = changes.papers[0].id

  it('use: the deletion is committed, and the working tree already has none', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'use'))
    expect(committed.papers).toEqual([])
    expect(workingOut.papers).toEqual([])
  })

  it('ignore: the paper stays committed (deletion not yet committed), but is still gone locally', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'ignore'))
    expect(committed.papers.map((p) => p.id)).toEqual(['a'])
    expect(workingOut.papers).toEqual([])
  })

  it('discard: the paper stays committed, and is restored to the working tree', () => {
    const { committed, workingOut } = composeContents(head, working, changes, decisionsOf(paperChangeId, 'discard'))
    expect(committed.papers.map((p) => p.id)).toEqual(['a'])
    expect(workingOut.papers.map((p) => p.id)).toEqual(['a'])
  })
})

describe('composeContents — round-trip and shape invariants', () => {
  it('both outputs serialize and reload as valid, stable projects', () => {
    const head = project({
      schema: REPEAT,
      papers: [paper('a', { title: 'T', annotations: {} })],
    })
    const working = project({
      schema: REPEAT,
      papers: [paper('a', { title: 'T2', annotations: { Findings: [{ children: { Claim: [{ value: 'X' }] } }] } })],
    })
    const changes = detectFieldChanges(head, working)!
    const decisions: Record<string, Disposition> = {}
    for (const f of changes.fields) decisions[f.id] = 'use'
    const { committed, workingOut } = composeContents(head, working, changes, decisions)

    for (const p of [committed, workingOut]) {
      const text = serializeProject(p)
      expect(serializeProject(loadProject(text))).toBe(text)
    }
  })
})
