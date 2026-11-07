import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '../state/editorStore'

vi.mock('./schemaMode', () => ({ DEMO_SCHEMA_MODE: true }))

vi.mock('../platform', async () => {
  const { createDemoAdapter } = await import('../platform/demoAdapter')
  const demo = createDemoAdapter()
  return { getPlatform: () => demo }
})

const st = () => useEditorStore.getState()

// [utest->req~plt-456~1]
describe('schema editor demo', () => {
  let downloads: string[]
  beforeEach(() => {
    downloads = []
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const reader = new FileReader()
      reader.onload = () => downloads.push(String(reader.result))
      reader.readAsText(blob)
      return 'blob:schema'
    })
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('opens a new project in the editor, adds a field and saves it as a download', async () => {
    await st().startNew()
    expect(st().open).toBe(true)
    expect(st().mode).toBe('new')

    st().updateNode(st().nodes[0].uid, { name: 'Relevant', kind: 'boolean' })
    st().addNode(null)
    st().updateNode(st().nodes[1].uid, { name: 'Year', kind: 'number' })

    expect(await st().save()).toBe(true)
    await vi.waitFor(() => expect(downloads).toHaveLength(1))
    const saved = JSON.parse(downloads[0]) as { config: { schema: { name: string; type: string }[] } }
    expect(saved.config.schema).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Relevant', type: 'boolean' })]))
  })
})
