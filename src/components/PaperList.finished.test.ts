import { describe, it, expect } from 'vitest'
import { loadProject, serializeProject, splitProjectFiles, assembleLegacyProjectJson, type Project } from '../model/project'
import type { AnnotationDef } from '../model/schema'
import { paperIsFinished, paperAnnotationState } from './PaperList'
import { annotationState, matchesFilter } from '../model/annotationState'

/**
 * The reviewer's explicit "Annotation finished" declaration — the checkbox in
 * the annotation panel — and the states the paper list's dot derives from it
 * (`paperAnnotationState`).
 *
 * Data and declaration are deliberately independent: a full form is not a
 * sign-off, and a sign-off is not re-derived from the data once made. What the
 * two *together* mean is the state machine, including when they contradict
 * each other (`flagged`). Everything below pins one of those, plus the on-disk
 * round trip that has to carry the flag between sessions.
 *
 * Both fields are `required`, so this schema can actually reach `flagged` —
 * red means "a field that had to be filled is empty", and a schema that
 * requires nothing never turns red at all (its own case is below).
 */

const SCHEMA: AnnotationDef[] = [
  { name: 'Study Type', type: 'string', required: true },
  { name: 'Notes', type: 'string', required: true },
]

const FULL = { 'Study Type': [{ value: 'RCT' }], Notes: [{ value: 'n/a' }] }
const PARTIAL = { 'Study Type': [{ value: 'RCT' }] }

function project(opts: {
  reviewers?: number
  screening?: { reasons: string[] }
  paper?: Record<string, unknown>
}): Project {
  const config: Record<string, unknown> = opts.screening
    ? { screening: opts.screening }
    : { schema: SCHEMA }
  if (opts.reviewers !== undefined) config.reviewers = opts.reviewers
  return loadProject({
    version: 1,
    config,
    papers: [{ id: 'p1', title: 'Paper 1', authors: [], pdf: 'p1.pdf', ...(opts.paper ?? {}) }],
  })
}

/** The single-reviewer seat, the one every state case below is about. */
const state = (p: Project) => paperAnnotationState(p, p.papers[0], null)

describe('paperAnnotationState — what the dot’s color says', () => {
  it('untouched → partial → complete as fields are filled, without any tick', () => {
    expect(state(project({}))).toBe('untouched')
    expect(state(project({ paper: { annotations: PARTIAL } }))).toBe('partial')
    // Complete, not finished: a full form is nobody's sign-off.
    expect(state(project({ paper: { annotations: FULL } }))).toBe('complete')
  })

  it('is finished only when the tick and a fulfilled schema agree', () => {
    expect(state(project({ paper: { annotations: FULL, finished: true } }))).toBe('finished')
  })

  it('is flagged when the box is ticked while a required field is empty', () => {
    expect(state(project({ paper: { finished: true } }))).toBe('flagged')
    expect(state(project({ paper: { annotations: PARTIAL, finished: true } }))).toBe('flagged')
  })

  it('never flags a schema that requires nothing — no field there *had* to be filled', () => {
    // An unanswered question can be the right record of a paper that does not
    // address it; without `required` the schema has not said otherwise, so a
    // reviewer's tick stands and the paper is simply finished.
    const optional = (paper: Record<string, unknown>) =>
      loadProject({
        version: 1,
        config: { schema: [{ name: 'Study Type', type: 'string' }, { name: 'Notes', type: 'string' }] },
        papers: [{ id: 'p1', title: 'P', authors: [], pdf: 'p.pdf', ...paper }],
      })
    expect(state(optional({ finished: true }))).toBe('finished')
    expect(state(optional({ annotations: PARTIAL, finished: true }))).toBe('finished')
    // …and the un-ticked states are unaffected: progress still counts every
    // field, so the dot fills exactly as it did before.
    expect(state(optional({ annotations: PARTIAL }))).toBe('partial')
    expect(state(optional({ annotations: FULL }))).toBe('complete')
  })

  it('a Yes/No answer is never a hole, even when the field is required', () => {
    // Booleans are excluded from completeness entirely (see `completeness.ts`),
    // so answering "no" — which is unticking a checkbox — records an answer
    // rather than emptying a field, and cannot turn a finished paper red.
    const withBool = (value: boolean) =>
      loadProject({
        version: 1,
        config: {
          schema: [
            { name: 'Study Type', type: 'string', required: true },
            { name: 'Relevant', type: 'boolean', required: true },
          ],
        },
        papers: [
          {
            id: 'p1',
            title: 'P',
            authors: [],
            pdf: 'p.pdf',
            annotations: { 'Study Type': [{ value: 'RCT' }], Relevant: [{ value }] },
            finished: true,
          },
        ],
      })
    expect(state(withBool(true))).toBe('finished')
    expect(state(withBool(false))).toBe('finished')
  })

  it('re-evaluates the mark when a required field is emptied, without touching the declaration', () => {
    // Derived on every read — no save, no separate invalidation step — so
    // emptying the field flips a finished paper to flagged by itself, and
    // refilling it flips back. What must *not* happen is the tick being
    // silently dropped.
    const p = project({ paper: { annotations: FULL, finished: true } })
    expect(state(p)).toBe('finished')
    p.papers[0].annotations['Notes'][0].value = ''
    expect(state(p)).toBe('flagged')
    expect(p.papers[0].finished).toBe(true)
    p.papers[0].annotations['Notes'][0].value = 'n/a'
    expect(state(p)).toBe('finished')
  })

  it('is per reviewer seat — one reviewer’s sign-off is not another’s', () => {
    const p = project({
      reviewers: 2,
      paper: { reviews: { '1': FULL, '2': FULL }, reviewsFinished: { '1': true } },
    })
    expect(paperAnnotationState(p, p.papers[0], '1')).toBe('finished')
    expect(paperAnnotationState(p, p.papers[0], '2')).toBe('complete')
  })

  it('does not read the consolidated flag from a numbered reviewer’s seat', () => {
    const p = project({ reviewers: 2, paper: { annotations: FULL, finished: true, reviews: { '1': FULL } } })
    expect(paperAnnotationState(p, p.papers[0], '1')).toBe('complete')
  })

  it('is null in the seats where completeness does not apply (screening, Consolidation)', () => {
    // Neither seat offers the checkbox, the filter dropdown, or these colors —
    // both keep their own dot meaning.
    const screening = project({ screening: { reasons: ['Wrong topic'] }, paper: { finished: true } })
    expect(paperAnnotationState(screening, screening.papers[0], null)).toBeNull()
    const consolidation = project({ reviewers: 3, paper: { annotations: FULL, finished: true } })
    expect(paperAnnotationState(consolidation, consolidation.papers[0], 'consolidation')).toBeNull()
  })

  it('never claims a paper is finished before a seat is picked', () => {
    const p = project({ reviewers: 2, paper: { annotations: FULL, finished: true } })
    expect(paperIsFinished(p, p.papers[0], null)).toBe(false)
  })

  it('a boolean-only schema is finishable but never flagged — it has nothing to leave empty', () => {
    const bool = (paper: Record<string, unknown>) =>
      loadProject({
        version: 1,
        config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
        papers: [{ id: 'p1', title: 'P', authors: [], pdf: 'p.pdf', ...paper }],
      })
    expect(state(bool({}))).toBe('untouched')
    expect(state(bool({ annotations: { Relevant: [{ value: true }] } }))).toBe('partial')
    expect(state(bool({ finished: true }))).toBe('finished')
  })
})

describe('matchesFilter — the three buckets the dropdown offers', () => {
  it('puts every paper whose box is not ticked under "in progress"', () => {
    for (const s of ['untouched', 'partial', 'complete'] as const) {
      expect(matchesFilter(s, 'in-progress')).toBe(true)
      expect(matchesFilter(s, 'finished')).toBe(false)
      expect(matchesFilter(s, 'issues')).toBe(false)
    }
  })

  it('keeps the two ticked states out of "in progress" — they are what "done" means', () => {
    expect(matchesFilter('finished', 'in-progress')).toBe(false)
    expect(matchesFilter('flagged', 'in-progress')).toBe(false)
    expect(matchesFilter('finished', 'finished')).toBe(true)
    expect(matchesFilter('flagged', 'issues')).toBe(true)
  })

  it('returns an undone annotation to "in progress", however it was undone', () => {
    // Values cleared back to nothing, and the tick removed from a full form:
    // both are papers in progress again, and neither may fall out of the list
    // a reviewer works from.
    expect(matchesFilter(state(project({ paper: { annotations: FULL, finished: true } })), 'in-progress')).toBe(false)
    expect(matchesFilter(state(project({ paper: { annotations: FULL } })), 'in-progress')).toBe(true)
    expect(matchesFilter(state(project({})), 'in-progress')).toBe(true)
  })

  it('passes everything under "all", including seats with no state at all', () => {
    expect(matchesFilter(null, 'all')).toBe(true)
    expect(matchesFilter('flagged', 'all')).toBe(true)
  })

  it('covers every state exactly once across the three buckets', () => {
    // A state that matched two buckets would be double-counted by the
    // counter; one that matched none would be invisible in every filtered
    // view but "all".
    for (const s of ['untouched', 'partial', 'complete', 'finished', 'flagged'] as const) {
      const hits = (['in-progress', 'finished', 'issues'] as const).filter((f) => matchesFilter(s, f))
      expect(hits).toHaveLength(1)
    }
  })
})

describe('annotationState — the vocabulary itself', () => {
  it('is null wherever completeness is', () => {
    expect(annotationState(null, true, true, true)).toBeNull()
  })

  it('separates "form is full" from "reviewer said so" in both directions', () => {
    expect(annotationState({ filled: 3, total: 3 }, false, true, true)).toBe('complete')
    expect(annotationState({ filled: 0, total: 3 }, true, false, true)).toBe('flagged')
  })

  it('only flags when the schema requires something', () => {
    expect(annotationState({ filled: 0, total: 3 }, true, false, false)).toBe('finished')
  })
})

describe('the finished flag on disk', () => {
  it('is dropped unless it is literally true — the file is hand-editable', () => {
    const p = project({ paper: { annotations: FULL, finished: 'yes', reviewsFinished: { '1': 'yes', x: true } } })
    expect(p.papers[0].finished).toBe(false)
    expect(p.papers[0].reviewsFinished).toEqual({})
  })

  it('is omitted from a saved file when nobody has declared anything', () => {
    const p = project({ paper: { annotations: FULL } })
    const written = JSON.parse(serializeProject(p)) as { papers: Record<string, unknown>[] }
    expect(written.papers[0]).not.toHaveProperty('finished')
    expect(written.papers[0]).not.toHaveProperty('reviewsFinished')
  })

  it('round-trips through the single-file shape', () => {
    const p = project({
      reviewers: 2,
      paper: { annotations: FULL, finished: true, reviews: { '1': FULL }, reviewsFinished: { '1': true } },
    })
    const back = loadProject(JSON.parse(serializeProject(p)))
    expect(back.papers[0].finished).toBe(true)
    expect(back.papers[0].reviewsFinished).toEqual({ '1': true })
  })

  it('round-trips through the split per-paper files, each seat in its own file', () => {
    const p = project({
      reviewers: 2,
      paper: { annotations: FULL, finished: true, reviews: { '1': FULL }, reviewsFinished: { '1': true } },
    })
    const { meta, files } = splitProjectFiles(p)
    const byPath = new Map(files.map((f) => [f.relPath, f.text]))
    expect(JSON.parse(byPath.get('p1/consolidated.json')!).finished).toBe(true)
    expect(JSON.parse(byPath.get('p1/reviewer-1.json')!).finished).toBe(true)
    expect(JSON.parse(byPath.get('p1/reviewer-2.json') ?? 'null')).toBeNull()

    const back = loadProject(
      assembleLegacyProjectJson(
        meta,
        new Map([
          [
            'p1',
            {
              consolidated: JSON.parse(byPath.get('p1/consolidated.json')!),
              reviewers: new Map([['1', JSON.parse(byPath.get('p1/reviewer-1.json')!)]]),
              reviewMarks: new Map(),
            },
          ],
        ]),
      ),
    )
    expect(back.papers[0].finished).toBe(true)
    expect(back.papers[0].reviewsFinished).toEqual({ '1': true })
  })

  it('keeps a reviewer file alive that holds only a declaration', () => {
    // The reviewer ticked the box and then cleared their answers: the tree is
    // empty, but deleting the file would silently un-say what they said.
    const p = project({ reviewers: 2, paper: { reviewsFinished: { '1': true } } })
    const files = new Map(splitProjectFiles(p).files.map((f) => [f.relPath, f.text]))
    expect(JSON.parse(files.get('p1/reviewer-1.json')!)).toEqual({ finished: true })
  })
})
