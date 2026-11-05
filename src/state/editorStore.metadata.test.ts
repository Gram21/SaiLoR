// [utest->req~edt-180~1]
import { describe, it, expect } from 'vitest'
import { useEditorStore, buildProjectJson, editorStateFromOpened, makeNode } from './editorStore'
import { loadProject } from '../model/project'
import type { OpenedProject } from '../platform/adapter'

const draft = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  aiEnabled: true,
  reviewers: 1,
  extra: {},
  nodes: [{ ...makeNode(), name: 'A' }],
  papers: [],
  ...overrides,
})

const opened = (config: Record<string, unknown>): OpenedProject => ({
  handle: { kind: 'electron', path: 'd:/x/project.json' } as never,
  name: 'project.json',
  text: JSON.stringify({ version: 1, config: { schema: [{ name: 'A', type: 'string' }], ...config }, papers: [] }),
})

describe('metadata edit setting', () => {
  it('writes nothing for off and keeps the other modes', () => {
    expect(buildProjectJson(draft()).config).not.toHaveProperty('metadataEdit')
    expect(buildProjectJson(draft({ metadataEdit: 'off' })).config).not.toHaveProperty('metadataEdit')
    const json = buildProjectJson(draft({ metadataEdit: 'annotation' }))
    expect((json.config as Record<string, unknown>).metadataEdit).toBe('annotation')
    expect(loadProject(json).metadataEdit).toBe('annotation')
  })

  it('reads the mode of an opened project and defaults to off', () => {
    expect(editorStateFromOpened(opened({ metadataEdit: 'project' })).metadataEdit).toBe('project')
    expect(editorStateFromOpened(opened({})).metadataEdit).toBe('off')
  })

  it('is its own undo step', () => {
    useEditorStore.setState({ metadataEdit: 'off', dirty: false, past: [], future: [] })
    const s = () => useEditorStore.getState()
    s().setMetadataEdit('project')
    expect(s().metadataEdit).toBe('project')
    expect(s().dirty).toBe(true)
    s().undo()
    expect(s().metadataEdit).toBe('off')
  })
})
