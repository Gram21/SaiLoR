import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import { serializeProject } from '../model/project'
import type { Suggestion } from '../llm/types'

/**
 * The AI marks: the light-blue borders that tell the reviewer "the model wrote
 * this, you have not looked at it yet". They are a *session* artefact, and this
 * file pins the two things that makes them safe:
 *
 *   1. they mark exactly what the AI wrote — nothing it skipped, and nothing on
 *      another paper that happens to share the path,
 *   2. they never reach the file: a project saved with marks is byte-identical
 *      to the same project saved without them.
 *
 * Everything that changes the data underneath a mark (undo, redo, loading a
 * different project, closing) drops them all, because a border pointing at a
 * value that is no longer there would be a lie.
 */

// Same stub as store.ai.test.ts: the store grabs a platform adapter at module
// scope and calls `checkRecents` fire-and-forget, so a missing method surfaces as
// an unhandled rejection rather than a failed test.
const saved: string[] = []
const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (text: string, handle: SaveHandle) => {
    saved.push(text)
    return handle
  },
  rebasePdfPaths: async (paths: string[]) => paths,
  getPdfSource: async () => ({ url: '' }),
  pickProjectLocation: async () => null,
  pickPdfs: async () => [],
  relativePdfPaths: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useStore, aiMarkKey } = await import('./store')

const PROJECT = JSON.stringify({
  version: 1,
  title: 'AI marks',
  config: {
    schema: [
      { name: 'Summary', type: 'string' },
      { name: 'Year', type: 'number' },
      { name: 'Relevant', type: 'boolean' },
      { name: 'Study Type', type: 'string', options: ['RCT', 'Survey'] },
      {
        name: 'Findings',
        min: 1,
        max: null,
        children: [
          { name: 'Claim', type: 'string' },
          { name: 'Evidence', min: 1, max: 2, children: [{ name: 'Metric', type: 'string' }] },
        ],
      },
    ],
  },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const TEST_USAGE = { provider: 'openai', model: 'gpt-5.5' }
const apply = (suggestions: Suggestion[]) => st().applyAiSuggestions(suggestions, TEST_USAGE)

const sug = (path: string, value: Suggestion['value']): Suggestion => ({
  path,
  value,
  evidence: 'quoted from the paper',
  confidence: 0.9,
})

/** The marks, as the UI sees them: paper-scoped keys. */
const marks = () => Object.keys(st().aiMarks).sort()
const isMarked = (paperId: string, canonical: string) =>
  st().aiMarks[aiMarkKey(paperId, canonical)] === true

beforeEach(() => {
  saved.length = 0
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
})

describe('marks follow what the AI actually wrote', () => {
  it('marks every filled field, across nesting levels', () => {
    apply([
      sug('Summary', 'Uses X to do Y.'),
      sug('Year', 2021),
      sug('Relevant', true),
      sug('Study Type', 'RCT'),
      sug('Findings/Claim', 'X improves Y'),
      sug('Findings/Evidence/Metric', 'accuracy'),
    ])

    expect(marks()).toEqual(
      [
        'p1::Summary',
        'p1::Year',
        'p1::Relevant',
        'p1::Study Type',
        'p1::Findings/Claim',
        'p1::Findings/Evidence/Metric',
      ].sort(),
    )
  })

  it('does not mark a suggestion it skipped', () => {
    // Answered by the reviewer, so the AI's value is dropped — and an untouched
    // field must not be dressed up as the model's work.
    st().setFieldValue([], 'Study Type', 0, 'Survey')

    const res = apply([
      sug('Study Type', 'RCT'), // already answered
      sug('Nope', 'x'), // not in the schema
      sug('Findings/Evidence[2]/Metric', 'y'), // past Evidence's max
      sug('Year', 2021), // the only one written
    ])

    expect(res).toEqual({ filled: 1, skipped: 3 })
    expect(marks()).toEqual(['p1::Year'])
  })

  it('keys marks per paper', () => {
    apply([sug('Summary', 'about paper one')])
    st().selectPaper('p2')

    expect(isMarked('p1', 'Summary')).toBe(true)
    expect(isMarked('p2', 'Summary')).toBe(false) // same path, different paper

    apply([sug('Summary', 'about paper two')])
    expect(marks()).toEqual(['p1::Summary', 'p2::Summary'])
  })

  it('distinguishes the instances of a repeatable node', () => {
    apply([sug('Findings/Claim', 'first'), sug('Findings[1]/Claim', 'second')])

    // Index 0 is implicit in the canonical form, so "Findings/Claim" and
    // "Findings[1]/Claim" are two different keys — clicking one leaves the other.
    expect(marks()).toEqual(['p1::Findings/Claim', 'p1::Findings[1]/Claim'].sort())
    expect(isMarked('p1', 'Findings[0]/Claim')).toBe(false)
  })
})

describe('confirmAiMark', () => {
  beforeEach(() => {
    apply([sug('Summary', 's'), sug('Year', 2021), sug('Findings[1]/Claim', 'second')])
  })

  it('removes exactly the one mark, leaving the rest', () => {
    st().confirmAiMark('p1', 'Year')

    expect(isMarked('p1', 'Year')).toBe(false)
    expect(marks()).toEqual(['p1::Summary', 'p1::Findings[1]/Claim'].sort())
  })

  it('clears a repeatable instance without touching its siblings', () => {
    apply([sug('Findings/Claim', 'first')])
    st().confirmAiMark('p1', 'Findings[1]/Claim')

    expect(isMarked('p1', 'Findings[1]/Claim')).toBe(false)
    expect(isMarked('p1', 'Findings/Claim')).toBe(true)
  })

  it('is a no-op for a field that carries no mark', () => {
    const before = st().aiMarks
    st().confirmAiMark('p1', 'Relevant')
    st().confirmAiMark('p2', 'Summary')

    // Same object: an unmarked field must not re-render every other field.
    expect(st().aiMarks).toBe(before)
  })

  it('leaves the value alone — the mark is a hint, not the data', () => {
    st().confirmAiMark('p1', 'Summary')
    expect(st().project!.papers[0].annotations['Summary'][0].value).toBe('s')
    expect(st().dirty).toBe(true)
  })
})

describe('marks are dropped whenever the data moves underneath them', () => {
  beforeEach(() => {
    apply([sug('Summary', 's'), sug('Year', 2021)])
    expect(marks()).toHaveLength(2)
  })

  it('undo clears them — the values it removed are no longer the AI’s to mark', () => {
    st().undo()
    expect(st().aiMarks).toEqual({})
  })

  it('redo does not resurrect them', () => {
    st().undo()
    st().redo()

    // The values are back...
    expect(st().project!.papers[0].annotations['Summary'][0].value).toBe('s')
    // ...but history restores data, not marks. The reviewer has been round this
    // loop; the borders are not re-armed.
    expect(st().aiMarks).toEqual({})
  })

  it('closeProject clears them', () => {
    st().closeProject()
    expect(st().aiMarks).toEqual({})
  })

  it('loadFromText clears them', () => {
    st().loadFromText(PROJECT, null, 'again.json')
    expect(st().aiMarks).toEqual({})
  })
})

describe('marks are never persisted', () => {
  const RUN = [
    sug('Summary', 'Uses X to do Y.'),
    sug('Year', 2021),
    sug('Relevant', true),
    sug('Study Type', 'RCT'),
    sug('Findings/Claim', 'X improves Y'),
  ]

  it('the serialized project is identical with the marks present and after they are gone', () => {
    apply(RUN)
    expect(marks()).toHaveLength(5)

    const withMarks = serializeProject(st().project!)

    for (const key of Object.keys(st().aiMarks)) {
      const [paperId, canonical] = key.split('::')
      st().confirmAiMark(paperId, canonical)
    }
    expect(st().aiMarks).toEqual({})

    expect(serializeProject(st().project!)).toBe(withMarks)
    expect(withMarks).not.toContain('aiMark')
  })

  it('produces the same annotation data as the same values typed by hand — plus a usage record the hand-typed file does not have', () => {
    // The marks live beside the project, not inside it, so they cannot be the
    // difference. But an AI fill also writes an `aiUsage` disclosure entry
    // (see store.ai.test.ts's "usage disclosure" block) that a hand-typed fill
    // never does — that is the *intended* difference now, not a regression, so
    // this test asserts the annotation data matches while acknowledging that
    // one field doesn't.
    apply(RUN)
    const fromAi = JSON.parse(serializeProject(st().project!))
    expect(Object.keys(st().aiMarks)).not.toHaveLength(0)
    expect(fromAi.papers[0].aiUsage).toHaveLength(1)

    st().loadFromText(PROJECT, null, 'test.json')
    st().selectPaper('p1')
    st().setFieldValue([], 'Summary', 0, 'Uses X to do Y.')
    st().setFieldValue([], 'Year', 0, 2021)
    st().setFieldValue([], 'Relevant', 0, true)
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().setFieldValue([{ name: 'Findings', index: 0 }], 'Claim', 0, 'X improves Y')

    expect(st().aiMarks).toEqual({}) // typing marks nothing
    const fromHand = JSON.parse(serializeProject(st().project!))
    expect(fromHand.papers[0].aiUsage).toBeUndefined() // no usage record when nobody used AI

    // Same annotation content either way — only the disclosure record differs.
    delete fromAi.papers[0].aiUsage
    expect(fromAi).toEqual(fromHand)
  })

  it('the text handed to the platform on save carries no marks', async () => {
    apply(RUN)
    useStore.setState({ saveHandle: { kind: 'download', name: 'test.json' } })

    expect(await st().save()).toBe(true)

    expect(saved).toHaveLength(1)
    expect(saved[0]).toBe(serializeProject(st().project!))
    expect(JSON.parse(saved[0])).not.toHaveProperty('aiMarks')
    // And saving does not clear the marks: the file is written, the reviewer's
    // "still to check" list is not.
    expect(marks()).toHaveLength(5)
  })
})
