import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoAdapter } from './demoAdapter'
import { DEMO_NOT_AVAILABLE, DEMO_NOT_SAVED, DEMO_NO_PDF } from '../demo/text'
import { loadProject } from '../model/project'

// [utest->req~plt-445~1]
describe('demo adapter: opening', () => {
  it('opens the bundled project without a file dialog', async () => {
    const opened = await createDemoAdapter().openProject()
    expect(opened).not.toBeNull()
    expect(loadProject(opened!.text).papers).toHaveLength(7)
    expect(opened!.handle).toEqual({ kind: 'download', name: 'demo-project.json' })
  })

  it('starts again from the bundled project on every open', async () => {
    const adapter = createDemoAdapter()
    const first = await adapter.openProject()
    const second = await adapter.openProject()
    expect(second!.text).toBe(first!.text)
  })

  it('has no recent projects and no opening from disk', async () => {
    const adapter = createDemoAdapter()
    expect(adapter.getRecents()).toEqual([])
    expect(await adapter.openRecent('anything')).toBeNull()
    expect(await adapter.pickPdfs()).toEqual([])
  })
})

// [utest->req~plt-446~1]
describe('demo adapter: nothing is saved', () => {
  let setItem: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    setItem = vi.spyOn(Storage.prototype, 'setItem')
  })
  afterEach(() => {
    setItem.mockRestore()
  })

  it('refuses every save and writes no storage', async () => {
    const adapter = createDemoAdapter()
    const handle = { kind: 'download' as const, name: 'demo-project.json' }
    await expect(adapter.saveProject('{}', handle)).rejects.toThrow(DEMO_NOT_SAVED)
    await expect(adapter.moveAnnotationsDir('x', 'y')).rejects.toThrow(DEMO_NOT_SAVED)
    expect(await adapter.writeTextFile('/tmp/x.txt', 'x')).toEqual({ ok: false, error: DEMO_NOT_SAVED })
    expect(await adapter.embedPdfAnnotations('/tmp/x.pdf', [], 'original')).toEqual({ ok: false, error: DEMO_NOT_SAVED })
    expect(setItem).not.toHaveBeenCalled()
  })

  it('keeps the feedback and PDF folder lists empty', async () => {
    const adapter = createDemoAdapter()
    const handle = { kind: 'download' as const, name: 'demo-project.json' }
    expect(await adapter.writeFeedback(handle, 'f.json', '{}')).toBeNull()
    expect(await adapter.listFeedback(handle)).toEqual([])
    expect(await adapter.scanPdfFolder('pdfs', [], handle)).toEqual({ files: [], known: [] })
    expect(setItem).not.toHaveBeenCalled()
  })
})

// [utest->req~plt-447~1]
describe('demo adapter: disabled desktop operations', () => {
  it('has no git, no update and no local AI runtime', async () => {
    const adapter = createDemoAdapter()
    expect(adapter.getGit()).toBeNull()
    expect(adapter.localRuntime).toBeNull()
    expect(await adapter.checkForNativeUpdate()).toEqual({ supported: false })
    expect(await adapter.listLlmConfigs()).toEqual([])
    expect(await adapter.discoverLocalServer?.('http://127.0.0.1:1')).toEqual({ ok: false, error: DEMO_NOT_AVAILABLE })
  })

  it('refuses network AI and web fetches', async () => {
    const adapter = createDemoAdapter()
    await expect(adapter.callLlm({} as never)).rejects.toThrow(DEMO_NOT_AVAILABLE)
    await expect(adapter.saveLlmConfig({} as never)).rejects.toThrow(DEMO_NOT_AVAILABLE)
    expect(await adapter.fetchWeb('https://example.org')).toMatchObject({ ok: false, error: DEMO_NOT_AVAILABLE })
  })

  it('cancels every file dialog', async () => {
    const adapter = createDemoAdapter()
    expect(await adapter.pickProjectLocation('x.json')).toBeNull()
    expect(await adapter.pickPdfFolder()).toEqual([])
    expect(await adapter.pickReferenceFile()).toBeNull()
    expect(await adapter.pickPdfExportPath('x.pdf')).toBeNull()
    expect(await adapter.pickTextExportPath('x.txt')).toBeNull()
  })

  it('serves the bundled PDF of every demo paper and says why for any other path', async () => {
    const adapter = createDemoAdapter()
    const project = loadProject((await adapter.openProject())!.text)
    for (const paper of project.papers) {
      const source = await adapter.getPdfSource(paper.pdf, { kind: 'download' })
      expect(source.url).toMatch(/papers\/[^/]+\.pdf$/)
    }
    await expect(adapter.getPdfSource('pdfs/missing.pdf', { kind: 'download' })).rejects.toThrow(DEMO_NO_PDF)
  })
})
