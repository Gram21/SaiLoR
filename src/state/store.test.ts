import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './store'

const PROJECT = JSON.stringify({
  version: 1,
  config: {
    schema: [
      { name: 'Study Type', type: 'string' },
      { name: 'Relevant', type: 'boolean' },
      { name: 'Findings', min: 1, max: null, children: [{ name: 'Claim', type: 'string' }] },
    ],
  },
  papers: [{ id: 'p1', title: 'T', authors: [], pdf: 'a.pdf', annotations: {} }],
})

const st = () => useStore.getState()
const studyType = () => st().project!.papers[0].annotations['Study Type'][0].value
const findings = () => st().project!.papers[0].annotations['Findings']

beforeEach(() => {
  st().loadFromText(PROJECT, null, 'test.json')
})

describe('undo/redo', () => {
  it('undoes and redoes a field edit', () => {
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(studyType()).toBe('RCT')

    st().undo()
    expect(studyType()).toBeNull()

    st().redo()
    expect(studyType()).toBe('RCT')
  })

  it('coalesces consecutive edits of the same field into one undo step', () => {
    st().setFieldValue([], 'Study Type', 0, 'R')
    st().setFieldValue([], 'Study Type', 0, 'RC')
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    expect(studyType()).toBe('RCT')

    st().undo() // one undo reverts the whole typing session
    expect(studyType()).toBeNull()
    expect(st().past).toHaveLength(0)
  })

  it('treats edits to different fields as separate undo steps', () => {
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().setFieldValue([], 'Relevant', 0, true)
    expect(st().project!.papers[0].annotations['Relevant'][0].value).toBe(true)

    st().undo() // reverts the Relevant toggle only
    expect(st().project!.papers[0].annotations['Relevant'][0].value).toBe(false)
    expect(studyType()).toBe('RCT')

    st().undo() // reverts the Study Type edit
    expect(studyType()).toBeNull()
  })

  it('undoes add/remove instance', () => {
    const def = st().project!.schema[2] // Findings (repeatable)
    st().addInstance([], def)
    expect(findings()).toHaveLength(2)

    st().undo()
    expect(findings()).toHaveLength(1)

    st().redo()
    expect(findings()).toHaveLength(2)

    st().removeInstance([], 'Findings', 1)
    expect(findings()).toHaveLength(1)
    st().undo()
    expect(findings()).toHaveLength(2)
  })

  it('a new edit clears the redo stack', () => {
    st().setFieldValue([], 'Study Type', 0, 'RCT')
    st().undo()
    expect(st().future).toHaveLength(1)

    st().setFieldValue([], 'Relevant', 0, true)
    expect(st().future).toHaveLength(0)
  })

  it('does nothing when there is no history', () => {
    expect(() => st().undo()).not.toThrow()
    expect(() => st().redo()).not.toThrow()
    expect(studyType()).toBeNull()
  })
})
