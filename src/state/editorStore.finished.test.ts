import { describe, it, expect } from 'vitest'
import { useEditorStore, buildProjectJson, editorStateFromOpened, makeNode } from './editorStore'
import { loadProject } from '../model/project'
import type { OpenedProject } from '../platform/adapter'

/**
 * `config.finishCheckbox` through the project editor — the path that decides
 * whether opening a project in the editor and saving it preserves the setting,
 * or silently rewrites what "finished" means for the whole review.
 *
 * The editor rebuilds `config` from scratch on every save (`buildProjectJson`),
 * so a setting it does not carry is a setting it deletes. That makes the
 * round trip below the load-bearing test, not the toggle itself.
 */

/** Built through the editor's own factory, so the fixture cannot drift from
 *  the node shape `buildProjectJson` actually consumes. */
const node = { ...makeNode(), name: 'A', required: true }

const draft = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  aiEnabled: true,
  reviewers: 1,
  extra: {},
  nodes: [node],
  papers: [],
  ...overrides,
})

const opened = (config: Record<string, unknown>): OpenedProject => ({
  handle: { kind: 'electron', path: 'd:/x/project.json' } as never,
  name: 'project.json',
  text: JSON.stringify({
    version: 1,
    config: { schema: [{ name: 'A', type: 'string', required: true }], ...config },
    papers: [],
  }),
})

describe('buildProjectJson — config.finishCheckbox', () => {
  it('writes nothing when the default is in force, so an untouched file stays byte-identical', () => {
    const config = buildProjectJson(draft()).config as Record<string, unknown>
    expect(config).not.toHaveProperty('finishCheckbox')
  })

  it('writes the opt-out, and it survives back through loadProject', () => {
    const json = buildProjectJson(draft({ finishCheckbox: false }))
    expect((json.config as Record<string, unknown>).finishCheckbox).toBe(false)
    expect(loadProject(json).finishCheckbox).toBe(false)
  })

  it('treats an absent value as enabled, matching Project.finishCheckbox', () => {
    expect(loadProject(buildProjectJson(draft())).finishCheckbox).toBe(true)
  })
})

describe('editorStateFromOpened — config.finishCheckbox', () => {
  it('reads an existing opt-out rather than resetting it to the default', () => {
    expect(editorStateFromOpened(opened({ finishCheckbox: false })).finishCheckbox).toBe(false)
  })

  it('reads a file that predates the option as enabled', () => {
    expect(editorStateFromOpened(opened({})).finishCheckbox).toBe(true)
  })

  it('survives the full open → save round trip untouched', () => {
    // The regression that matters: edit a schema in a project that opted out,
    // save, and the review must not silently go back to hand sign-off.
    const state = editorStateFromOpened(opened({ finishCheckbox: false }))
    const saved = loadProject(buildProjectJson({ ...state, nodes: [node] } as never))
    expect(saved.finishCheckbox).toBe(false)
  })
})

describe('setFinishCheckbox', () => {
  it('toggles, dirties the draft, and is its own undo step', () => {
    useEditorStore.setState({ finishCheckbox: true, dirty: false, past: [], future: [] })
    const s = () => useEditorStore.getState()

    s().setFinishCheckbox(false)
    expect(s().finishCheckbox).toBe(false)
    expect(s().dirty).toBe(true)

    s().undo()
    expect(s().finishCheckbox).toBe(true)
    s().redo()
    expect(s().finishCheckbox).toBe(false)
  })
})
