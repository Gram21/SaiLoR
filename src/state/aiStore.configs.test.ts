import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig } from '../llm/types'

/**
 * The reviewer can configure more than one named LLM target (e.g. "Claude —
 * work key" and "GPT-5 — personal key") and switch between them. This file
 * pins that as a store-level contract: `configs` holds every saved target,
 * `selectedId` always points at one of them (or none), and deleting the
 * selected target falls back to another one rather than pointing at nothing
 * that still exists.
 */

let stored: LlmConfig[] = []

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
  listLlmConfigs: async () => stored,
  saveLlmConfig: async (config: LlmConfig) => {
    const saved = { ...config, hasKey: true }
    const i = stored.findIndex((c) => c.id === saved.id)
    stored = i === -1 ? [...stored, saved] : stored.map((c) => (c.id === saved.id ? saved : c))
    return stored
  },
  deleteLlmConfig: async (id: string) => {
    stored = stored.filter((c) => c.id !== id)
    return stored
  },
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useAiStore } = await import('./aiStore')

function cfg(id: string, name: string): LlmConfig {
  return {
    id,
    name,
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-x',
    attach: 'text',
    hasKey: false,
  }
}

const st = () => useAiStore.getState()

beforeEach(() => {
  stored = []
  useAiStore.setState({ configs: [], selectedId: null })
})

describe('managing multiple named targets', () => {
  it('accumulates each saved target rather than replacing the previous one', async () => {
    await st().saveConfig(cfg('a', 'Claude — work key'))
    await st().saveConfig(cfg('b', 'GPT-5 — personal key'))

    expect(st().configs.map((c) => c.name)).toEqual(['Claude — work key', 'GPT-5 — personal key'])
  })

  it('auto-selects the first saved target, and leaves later ones unselected until chosen', async () => {
    await st().saveConfig(cfg('a', 'first'))
    expect(st().selectedId).toBe('a')

    await st().saveConfig(cfg('b', 'second'))
    expect(st().selectedId).toBe('a') // saving a second target does not steal the selection

    st().selectConfig('b')
    expect(st().selectedId).toBe('b')
  })

  it('edits a target in place by id, without disturbing the others', async () => {
    await st().saveConfig(cfg('a', 'first'))
    await st().saveConfig(cfg('b', 'second'))

    await st().saveConfig({ ...cfg('a', 'first'), model: 'claude-new' })

    expect(st().configs).toHaveLength(2)
    expect(st().configs.find((c) => c.id === 'a')?.model).toBe('claude-new')
    expect(st().configs.find((c) => c.id === 'b')?.name).toBe('second')
  })

  it('falls back the selection to another remaining target when the selected one is deleted', async () => {
    await st().saveConfig(cfg('a', 'first'))
    await st().saveConfig(cfg('b', 'second'))
    st().selectConfig('b')

    await st().deleteConfig('b')

    expect(st().configs.map((c) => c.id)).toEqual(['a'])
    expect(st().selectedId).toBe('a')
  })

  it('deleting a target that is not selected leaves the selection untouched', async () => {
    await st().saveConfig(cfg('a', 'first'))
    await st().saveConfig(cfg('b', 'second'))
    st().selectConfig('a')

    await st().deleteConfig('b')

    expect(st().selectedId).toBe('a')
  })

  it('goes back to no selection once the last target is deleted', async () => {
    await st().saveConfig(cfg('a', 'only'))
    await st().deleteConfig('a')

    expect(st().configs).toEqual([])
    expect(st().selectedId).toBeNull()
  })

  it('refreshConfigs re-points a stale selection at a target that still exists', async () => {
    // Simulates another window/tab deleting the currently-selected target.
    await st().saveConfig(cfg('a', 'first'))
    await st().saveConfig(cfg('b', 'second'))
    st().selectConfig('b')

    stored = stored.filter((c) => c.id !== 'b') // removed elsewhere, store not told directly
    await st().refreshConfigs()

    expect(st().configs.map((c) => c.id)).toEqual(['a'])
    expect(st().selectedId).toBe('a')
  })
})
