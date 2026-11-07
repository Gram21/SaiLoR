import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoAdapter } from './demoAdapter'

vi.mock('../demo/schemaMode', () => ({ DEMO_SCHEMA_MODE: true }))

// [utest->req~plt-456~1]
describe('demo adapter in the schema editor demo', () => {
  let clicks: HTMLAnchorElement[]
  beforeEach(() => {
    clicks = []
    URL.createObjectURL = vi.fn(() => 'blob:schema')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this)
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('offers a new project.json location without a file dialog', async () => {
    expect(await createDemoAdapter().pickProjectLocation('project.json')).toEqual({
      handle: { kind: 'download', name: 'project.json' },
      name: 'project.json',
    })
  })

  it('downloads the saved text as project.json and writes nothing else', async () => {
    const handle = await createDemoAdapter().saveProject('{"version":1}', { kind: 'download', name: 'project.json' })
    expect(handle).toEqual({ kind: 'download', name: 'project.json' })
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('project.json')
    expect(clicks[0].href).toBe('blob:schema')
  })
})
