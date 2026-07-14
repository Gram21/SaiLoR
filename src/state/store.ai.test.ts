import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import { normalizeTree } from '../model/annotations'
import { validateProject } from '../model/validate'
import type { Suggestion } from '../llm/types'

/**
 * `applyAiSuggestions` is the only place where model output reaches the project
 * data, so this file pins the three promises the design makes to the reviewer:
 *
 *   1. it never overwrites an answer the reviewer already gave,
 *   2. the whole fill is ONE undo step (accept the run, then throw it away whole),
 *   3. a run that writes nothing leaves no trace at all — no undo entry, no dirty flag.
 *
 * Everything else here (repeatables, `max`, malformed trees) exists so that a
 * model which ignores the contract cannot corrupt the tree.
 */

// The store reaches for a platform adapter at module scope (`recents: getPlatform()
// .getRecents()`), and again on close/refresh. The stub therefore has to cover every
// method the store touches — `checkRecents` in particular is called fire-and-forget,
// so a missing stub shows up as an unhandled rejection rather than a failed test.
const mockPlatform = {
  kind: 'browser' as const,
  getOsInfo: () => null,
  getRecents: () => [] as RecentEntry[],
  rememberProject: () => {},
  forgetRecent: () => [] as RecentEntry[],
  checkRecents: async (entries: RecentEntry[]) => entries,
  openProject: async () => null,
  openRecent: async () => null,
  saveProject: async (_text: string, handle: SaveHandle) => handle,
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

const { useStore } = await import('./store')

// A schema with one of each shape the apply path has to handle: plain field,
// number, boolean, enum, an unbounded repeatable group, a bounded repeatable
// group nested inside it, and a plain (non-repeating) group.
const PROJECT = JSON.stringify({
  version: 1,
  title: 'AI apply',
  config: {
    schema: [
      { name: 'Summary', type: 'string', description: 'One sentence.' },
      { name: 'Year', type: 'number' },
      { name: 'Relevant', type: 'boolean' },
      { name: 'Study Type', type: 'string', options: ['RCT', 'Survey', 'Case study'] },
      {
        name: 'Findings',
        min: 1,
        max: null,
        children: [
          { name: 'Claim', type: 'string' },
          { name: 'Evidence', min: 1, max: 2, children: [{ name: 'Metric', type: 'string' }] },
        ],
      },
      { name: 'Context', children: [{ name: 'Venue', type: 'string' }] },
    ],
  },
  papers: [
    { id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} },
    { id: 'p2', title: 'Paper Two', authors: [], pdf: 'p2.pdf', annotations: {} },
  ],
})

const st = () => useStore.getState()
const apply = (suggestions: Suggestion[]) => st().applyAiSuggestions(suggestions)

/** A suggestion as the parser hands it over: path + value, with evidence attached. */
const sug = (path: string, value: Suggestion['value']): Suggestion => ({
  path,
  value,
  evidence: 'quoted from the paper',
  confidence: 0.9,
})

const paperById = (id: string) => st().project!.papers.find((p) => p.id === id)!
const ann = () => paperById(st().currentPaperId!).annotations
/** Value of a top-level field of the selected paper. */
const val = (name: string) => ann()[name][0].value
const findings = () => ann()['Findings']
const claimOf = (i: number) => findings()[i].children!['Claim'][0].value
const evidence = (i: number) => findings()[i].children!['Evidence']

beforeEach(() => {
  st().loadFromText(PROJECT, null, 'test.json')
  st().selectPaper('p1')
})

describe('applyAiSuggestions: filling empty fields', () => {
  it('writes each suggestion into the field its path names', () => {
    const res = apply([
      sug('Summary', 'Uses X to do Y.'),
      sug('Year', 2021),
      sug('Study Type', 'RCT'),
      sug('Context/Venue', 'ICSE'),
      sug('Findings/Claim', 'X improves Y'),
      sug('Findings/Evidence/Metric', 'accuracy'),
    ])

    expect(res).toEqual({ filled: 6, skipped: 0 })
    expect(val('Summary')).toBe('Uses X to do Y.')
    expect(val('Year')).toBe(2021)
    expect(val('Study Type')).toBe('RCT')
    expect(ann()['Context'][0].children!['Venue'][0].value).toBe('ICSE')
    expect(claimOf(0)).toBe('X improves Y')
    expect(evidence(0)[0].children!['Metric'][0].value).toBe('accuracy')

    // The fill is an unsaved change like any other.
    expect(st().dirty).toBe(true)
    expect(st().past).toHaveLength(1)
  })

  it('touches only the paper that is open', () => {
    apply([sug('Summary', 'about paper one')])
    expect(paperById('p2').annotations['Summary'][0].value).toBeNull()
  })
})

describe('applyAiSuggestions: never overwrites the reviewer', () => {
  it('skips a field the reviewer has already answered', () => {
    st().setFieldValue([], 'Study Type', 0, 'Survey')
    const past = st().past.length

    const res = apply([sug('Study Type', 'RCT'), sug('Year', 2021)])

    expect(res).toEqual({ filled: 1, skipped: 1 })
    expect(val('Study Type')).toBe('Survey') // the reviewer's answer stands
    expect(val('Year')).toBe(2021)
    expect(st().past).toHaveLength(past + 1) // one entry for the one thing written
  })

  // Booleans follow `isUnanswered` (src/llm/fields.ts), NOT `isEmptyValue`
  // (src/model/validate.ts), and the two deliberately disagree: the data model
  // cannot express an *unanswered* boolean — an untouched checkbox and a
  // deliberate "no" are both `false` — so validate.ts calls a boolean never
  // empty. Reusing that rule here would mean the AI could never propose a value
  // for a boolean at all, not even the archetypal "Relevant". So a `false`
  // boolean is offered, and a `true` one is not: the AI may flip a box on, and
  // can never clear one the reviewer ticked.
  it('fills a boolean that is false', () => {
    expect(val('Relevant')).toBe(false)
    expect(apply([sug('Relevant', true)])).toEqual({ filled: 1, skipped: 0 })
    expect(val('Relevant')).toBe(true)
  })

  it('skips a boolean the reviewer already ticked, even to un-tick it', () => {
    st().setFieldValue([], 'Relevant', 0, true)
    const past = st().past.length

    expect(apply([sug('Relevant', false)])).toEqual({ filled: 0, skipped: 1 })
    expect(val('Relevant')).toBe(true) // the tick survives
    expect(st().past).toHaveLength(past) // and nothing was written, so no undo entry
  })
})

describe('applyAiSuggestions: one undo step for the whole run', () => {
  const RUN = [
    sug('Summary', 'Uses X to do Y.'),
    sug('Year', 2021),
    sug('Relevant', true),
    sug('Findings/Claim', 'first claim'),
    sug('Findings[1]/Claim', 'second claim'), // creates a Findings instance
  ]

  it('grows the undo stack by exactly one, whatever the run wrote', () => {
    expect(apply(RUN)).toEqual({ filled: 5, skipped: 0 })
    // Five writes across three nesting levels, one entry. This is the whole point
    // of the design: the reviewer accepts a run, and can throw it away as a run.
    expect(st().past).toHaveLength(1)
  })

  it('restores every filled field — and the instances it created — with a single undo', () => {
    apply(RUN)
    expect(findings()).toHaveLength(2)

    st().undo()

    expect(val('Summary')).toBeNull()
    expect(val('Year')).toBeNull()
    expect(val('Relevant')).toBe(false)
    expect(claimOf(0)).toBeNull()
    expect(findings()).toHaveLength(1) // the instance the AI added is gone too
    expect(st().past).toHaveLength(0)
  })

  it('redo puts the whole run back', () => {
    apply(RUN)
    st().undo()
    st().redo()

    expect(val('Summary')).toBe('Uses X to do Y.')
    expect(val('Year')).toBe(2021)
    expect(val('Relevant')).toBe(true)
    expect(claimOf(0)).toBe('first claim')
    expect(claimOf(1)).toBe('second claim')
    expect(st().past).toHaveLength(1)
    expect(st().future).toHaveLength(0)
  })
})

describe('applyAiSuggestions: a run that writes nothing leaves no trace', () => {
  it('returns {0, 0} and records no history for an empty list', () => {
    expect(apply([])).toEqual({ filled: 0, skipped: 0 })
    expect(st().past).toHaveLength(0)
    expect(st().dirty).toBe(false)
  })

  it('records no history when every suggestion is skipped', () => {
    // Neither of these can be written: one path is not in the schema, the other
    // is past its node's `max`.
    const res = apply([sug('Nope', 'x'), sug('Findings/Evidence[2]/Metric', 'y')])

    expect(res).toEqual({ filled: 0, skipped: 2 })
    expect(st().past).toHaveLength(0)
    // An empty undo entry would make Ctrl+Z look broken, and a dirty flag would
    // make the reviewer save a file that did not change.
    expect(st().dirty).toBe(false)
  })

  it('does not stack an entry on top of the reviewer’s own edits', () => {
    st().setFieldValue([], 'Summary', 0, 'mine')
    expect(st().past).toHaveLength(1)

    expect(apply([sug('Summary', 'the model’s')])).toEqual({ filled: 0, skipped: 1 })
    expect(st().past).toHaveLength(1)
    expect(val('Summary')).toBe('mine')
  })
})

describe('applyAiSuggestions: repeatable nodes', () => {
  it('creates the instances the model named, including the ones it skipped over', () => {
    // Only Findings[0] exists; the model names Findings[2]. That is how it records
    // a further Finding, so the intervening instance has to be created too.
    expect(findings()).toHaveLength(1)

    expect(apply([sug('Findings[2]/Claim', 'third claim')])).toEqual({ filled: 1, skipped: 0 })

    expect(findings()).toHaveLength(3)
    expect(claimOf(2)).toBe('third claim')
    expect(claimOf(1)).toBeNull() // padded, not filled
  })

  it('leaves a tree the schema layer still recognises', () => {
    apply([sug('Findings[2]/Claim', 'third claim'), sug('Findings[2]/Evidence[1]/Metric', 'F1')])

    const schema = st().project!.schema
    // The created instances must be exactly what the loader would have produced:
    // normalizing the tree changes nothing, and validation reports no structural
    // problem (a missing child list or a short instance list would show up here).
    expect(normalizeTree(schema, ann())).toEqual(ann())
    const structural = validateProject(st().project!).filter(
      (i) => i.kind === 'type' || i.kind === 'cardinality',
    )
    expect(structural).toEqual([])
  })

  it('respects a bounded max', () => {
    // Evidence is max 2, so [1] is the last slot and [2] does not exist.
    expect(apply([sug('Findings/Evidence[1]/Metric', 'recall')])).toEqual({
      filled: 1,
      skipped: 0,
    })
    expect(evidence(0)).toHaveLength(2)

    expect(apply([sug('Findings/Evidence[2]/Metric', 'precision')])).toEqual({
      filled: 0,
      skipped: 1,
    })
    expect(evidence(0)).toHaveLength(2) // no third Evidence was conjured up
  })
})

describe('applyAiSuggestions: paths the model got wrong', () => {
  it('skips an unknown path without throwing', () => {
    expect(() => apply([sug('Made Up', 'x')])).not.toThrow()
    expect(apply([sug('Findings/Made Up', 'x'), sug('Summary/Nested', 'x')])).toEqual({
      filled: 0,
      skipped: 2,
    })
    expect(st().past).toHaveLength(0)
  })

  it('skips a path that names a group, which holds no value', () => {
    expect(apply([sug('Findings', 'x'), sug('Context', 'x')])).toEqual({ filled: 0, skipped: 2 })
    expect(findings()).toHaveLength(1)
  })
})

describe('applyAiSuggestions: hand-edited, malformed trees', () => {
  it('loads a paper whose node key holds an object instead of a list', () => {
    const malformed = JSON.parse(PROJECT) as { papers: { annotations: unknown }[] }
    malformed.papers[0].annotations = { Findings: { oops: 1 } }
    st().loadFromText(JSON.stringify(malformed), null, 'broken.json')
    st().selectPaper('p1')

    expect(st().loadError).toBeNull()
    expect(() => apply([sug('Findings/Claim', 'c')])).not.toThrow()
    expect(claimOf(0)).toBe('c')
  })

  it('survives the same shape reaching the store unnormalized', () => {
    // `loadProject` normalizes the tree, so the malformed shape above never gets
    // as far as `ensureInstance`. Plant it directly to exercise the store's own
    // guard — the last line of defence if anything ever writes the tree without
    // going through the loader.
    useStore.setState((s) => {
      const paper = s.project!.papers[0] as unknown as { annotations: unknown }
      paper.annotations = { Findings: { oops: 1 }, Summary: 'not a list' }
    })
    // Guard: if the plant did not land, the rest of this test would pass on a
    // perfectly normal tree and prove nothing.
    expect(Array.isArray(ann()['Findings'])).toBe(false)

    expect(() => apply([sug('Findings/Claim', 'c'), sug('Summary', 's')])).not.toThrow()
    // The malformed node is replaced rather than preserved: it held no answer.
    expect(claimOf(0)).toBe('c')
    expect(val('Summary')).toBe('s')
  })
})

describe('applyAiSuggestions: coalescing', () => {
  it('does not let the reviewer’s next keystroke fold into the AI’s undo entry', () => {
    st().setFieldValue([], 'Summary', 0, 'typed')
    expect(st().past).toHaveLength(1)

    apply([sug('Year', 2021)])
    expect(st().past).toHaveLength(2)

    // Same field as before the run. `setFieldValue` collapses consecutive edits of
    // the *same* field into one undo step, so unless the apply resets that key,
    // this edit is folded into the AI's entry and can no longer be undone on its own.
    st().setFieldValue([], 'Summary', 0, 'typed more')
    expect(st().past).toHaveLength(3)

    st().undo()
    expect(val('Summary')).toBe('typed')
    expect(val('Year')).toBe(2021) // undoing the edit does not undo the AI's fill
  })
})
