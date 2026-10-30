import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './store'

const PROJECT = JSON.stringify({
  version: 1,
  config: {
    schema: [
      { name: 'Study Type', type: 'string' },
      { name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' }] },
    ],
  },
  papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
})

const st = () => useStore.getState()
const studyType = () => st().project!.papers[0].annotations['Study Type'][0].value

beforeEach(() => {
  st().setReadOnly(false)
  st().loadFromText(PROJECT, null, 'test.json')
})

describe('view-only mode', () => {
  it('blocks edits, instances, marks, undo and redo without dirtying the project', () => {
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().setReadOnly(true)

    st().setFieldValue([], 'Study Type', 0, 'cohort')
    st().addInstance([], st().project!.schema[1] as never)
    expect(studyType()).toBe('RCT')
    expect(st().project!.papers[0].annotations['Findings']).toHaveLength(1)
    expect(st().addHighlight(1, [{ x: 0, y: 0, width: 1, height: 1 }], undefined, undefined, 't')).toBeNull()

    st().undo()
    expect(studyType()).toBe('RCT')
  })

  it('allows edits again once switched off', () => {
    st().setReadOnly(true)
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(studyType()).toBeNull()

    st().setReadOnly(false)
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(studyType()).toBe('RCT')
  })
})
