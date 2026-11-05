// [utest->req~edt-200~1]
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

describe('pdf folder settings', () => {
  it('writes the keys only when set', () => {
    const plain = buildProjectJson(draft({ pdfFolder: '  ', crossrefLookup: false })).config
    expect(plain).not.toHaveProperty('pdfFolder')
    expect(plain).not.toHaveProperty('crossrefLookup')
    const json = buildProjectJson(draft({ pdfFolder: ' pdfs/new ', crossrefLookup: true }))
    expect(json.config).toMatchObject({ pdfFolder: 'pdfs/new', crossrefLookup: true })
    expect(loadProject(json)).toMatchObject({ pdfFolder: 'pdfs/new', crossrefLookup: true })
  })

  it('reads an opened project and defaults to no folder and no lookup', () => {
    expect(editorStateFromOpened(opened({ pdfFolder: 'pdfs', crossrefLookup: true }))).toMatchObject({
      pdfFolder: 'pdfs',
      crossrefLookup: true,
    })
    expect(editorStateFromOpened(opened({ crossrefLookup: 'yes' }))).toMatchObject({ pdfFolder: '', crossrefLookup: false })
  })

  it('undoes each change', () => {
    useEditorStore.setState({ pdfFolder: '', crossrefLookup: false, dirty: false, past: [], future: [] })
    const s = () => useEditorStore.getState()
    s().setPdfFolder('p')
    s().setPdfFolder('pdfs')
    s().setCrossrefLookup(true)
    expect(s()).toMatchObject({ pdfFolder: 'pdfs', crossrefLookup: true, dirty: true })
    s().undo()
    expect(s().crossrefLookup).toBe(false)
    s().undo()
    expect(s().pdfFolder).toBe('')
  })
})
