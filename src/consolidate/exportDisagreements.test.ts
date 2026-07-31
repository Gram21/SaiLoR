import { describe, it, expect } from 'vitest'
import { resolveSchema, type AnnotationDef } from '../model/schema'
import { normalizeTree, type AnnotationValueTree } from '../model/annotations'
import type { Paper } from '../model/project'
import { paperVerdicts } from './disagreements'
import { consolidationFieldStatus } from '../components/ConsolidationVerdicts'
import { paperDisagreementsText, projectDisagreementsText } from './exportDisagreements'

const SCHEMA_DEFS: AnnotationDef[] = [
  { name: 'Study Type', type: 'string' },
  { name: 'Relevant', type: 'boolean' },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [{ name: 'Claim', type: 'string' }],
  },
]
const SCHEMA = resolveSchema(SCHEMA_DEFS)

function tree(data: AnnotationValueTree): AnnotationValueTree {
  return normalizeTree(SCHEMA, data)
}

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    title: 'Paper One',
    authors: [],
    pdf: 'p1.pdf',
    annotations: {},
    reviews: {},
    aiUsage: [],
    equal: [],
    alignment: {},
    marks: [],
    reviewMarks: {},
    finished: false,
    reviewsFinished: {},
    extra: {},
    ...overrides,
  }
}

/** The same filter DisagreementOverview/ConsolidationOverview apply before
 *  handing verdicts to the export — a real disagreement, not just a field
 *  nobody has reached yet. */
function disagreementsOf(paper: Paper, reviewerCount = 2) {
  return paperVerdicts(SCHEMA, paper, reviewerCount).filter(
    (v) => consolidationFieldStatus(v.answeredBy.length, reviewerCount, v.agree, v.oneSided, v.participantCount) === 'disagree',
  )
}

describe('paperDisagreementsText', () => {
  it('renders metadata, then each disagreement\'s location and every reviewer\'s value', () => {
    const paper = makePaper({
      id: 'A17',
      title: 'Deep Learning for Code Search',
      authors: ['A. Author', 'B. Writer'],
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
        '2': tree({ 'Study Type': [{ value: 'Survey' }] }),
      },
    })
    const text = paperDisagreementsText(paper, disagreementsOf(paper))

    expect(text).toBe(
      ['ID: A17', 'Authors: A. Author, B. Writer', 'Title: Deep Learning for Code Search', '', 'Study Type', '  R1: RCT', '  R2: Survey'].join(
        '\n',
      ),
    )
  })

  it('lists every reviewer who answered, not just two, in reviewer-id order', () => {
    const paper = makePaper({
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
        '2': tree({ 'Study Type': [{ value: 'Survey' }] }),
        '3': tree({ 'Study Type': [{ value: 'Case study' }] }),
      },
    })
    const text = paperDisagreementsText(paper, disagreementsOf(paper, 3))
    expect(text).toContain('  R1: RCT\n  R2: Survey\n  R3: Case study')
  })

  it('formats a boolean value as Yes/No, same as the UI', () => {
    // A boolean only counts as "answered" from a reviewer who has touched
    // *something* on this paper (see disagreements.ts's `touchedBy`) — an
    // untouched paper's whole tree defaults to `false`, which must not read
    // as a deliberate "no". Reviewer 2 gets a second field filled in so their
    // `false` on Relevant counts as a real answer, not paper-wide silence.
    const paper = makePaper({
      reviews: {
        '1': tree({ Relevant: [{ value: true }] }),
        '2': tree({ Relevant: [{ value: false }], 'Study Type': [{ value: 'RCT' }] }),
      },
    })
    const text = paperDisagreementsText(paper, disagreementsOf(paper))
    expect(text).toContain('R1: Yes')
    expect(text).toContain('R2: No')
  })

  it('says so plainly when there are no disagreements', () => {
    const paper = makePaper({ title: 'Clean Paper' })
    expect(paperDisagreementsText(paper, [])).toBe(
      ['ID: p1', 'Authors: (none recorded)', 'Title: Clean Paper', '', 'No disagreements.'].join('\n'),
    )
  })

  it('separates two disagreements with a blank line and no trailing blank at the end', () => {
    const paper = makePaper({
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'RCT' }], Relevant: [{ value: true }] }),
        '2': tree({ 'Study Type': [{ value: 'Survey' }], Relevant: [{ value: false }] }),
      },
    })
    const text = paperDisagreementsText(paper, disagreementsOf(paper))
    expect(text.endsWith('R2: No')).toBe(true)
    expect(text).not.toMatch(/\n\n\n/)
  })
})

describe('projectDisagreementsText', () => {
  it('skips a paper with no disagreements entirely', () => {
    const clean = makePaper({ id: 'clean', title: 'Clean' })
    const messy = makePaper({
      id: 'messy',
      title: 'Messy',
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
        '2': tree({ 'Study Type': [{ value: 'Survey' }] }),
      },
    })
    const byPaper = new Map([
      ['clean', disagreementsOf(clean)],
      ['messy', disagreementsOf(messy)],
    ])
    const text = projectDisagreementsText([clean, messy], byPaper)
    expect(text).not.toContain('ID: clean')
    expect(text).toContain('ID: messy')
  })

  it('is "" when nothing in the whole project disagrees', () => {
    const paper = makePaper()
    expect(projectDisagreementsText([paper], new Map([['p1', []]]))).toBe('')
  })

  it('keeps paper order and separates blocks with a divider', () => {
    const a = makePaper({
      id: 'a',
      title: 'A',
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'RCT' }] }),
        '2': tree({ 'Study Type': [{ value: 'Survey' }] }),
      },
    })
    const b = makePaper({
      id: 'b',
      title: 'B',
      reviews: {
        '1': tree({ 'Study Type': [{ value: 'Case study' }] }),
        '2': tree({ 'Study Type': [{ value: 'Meta-analysis' }] }),
      },
    })
    const text = projectDisagreementsText(
      [a, b],
      new Map([
        ['a', disagreementsOf(a)],
        ['b', disagreementsOf(b)],
      ]),
    )
    const idA = text.indexOf('ID: a')
    const idB = text.indexOf('ID: b')
    expect(idA).toBeGreaterThanOrEqual(0)
    expect(idB).toBeGreaterThan(idA)
  })
})
