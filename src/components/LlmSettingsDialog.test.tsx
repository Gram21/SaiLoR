import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecentEntry, SaveHandle } from '../platform/adapter'
import type { LlmConfig, ModelInfo } from '../llm/types'

/**
 * Focused coverage for the per-target price fields: typing/clearing a price,
 * and prefilling from a fetched model's `pricing` without clobbering a price
 * the reviewer already typed. Everything else about this dialog is exercised
 * elsewhere (or not yet at all) — this file only covers REQ-LLM price inputs.
 */

const saveLlmConfig = vi.fn(async (config: LlmConfig) => [config])

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
  // Echoes back whatever the store already holds — a real listLlmConfigs would
  // return what was last saved, not silently forget the test's fixture.
  listLlmConfigs: async () => useAiStore.getState().configs,
  saveLlmConfig: (config: LlmConfig, _apiKey?: string) => saveLlmConfig(config),
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  fetchWeb: async () => ({ ok: false, status: 0, url: '', contentType: '', body: '', truncated: false }),
}

vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useAiStore } = await import('../state/aiStore')
const { LlmSettingsDialog } = await import('./LlmSettingsDialog')

function cfg(): LlmConfig {
  return {
    id: 'c1',
    name: 'Test target',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    model: 'model-a',
    attach: 'text',
    hasKey: true,
  }
}

function modelWithPricing(id: string): ModelInfo {
  return { id, label: id, reasoning: null, pricing: { input: 3, output: 15 } }
}

beforeEach(async () => {
  saveLlmConfig.mockClear()
  useAiStore.setState({
    settingsOpen: true,
    configs: [cfg()],
    models: {},
    modelsLoading: {},
    modelsError: {},
  })
})

async function openEdit() {
  render(<LlmSettingsDialog />)
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
}

describe('price fields', () => {
  it('typing a price updates the draft and is included in what saveConfig is called with', async () => {
    await openEdit()

    await userEvent.type(screen.getByLabelText('Price per 1M input tokens (USD)'), '3.5')
    await userEvent.type(screen.getByLabelText('Price per 1M output tokens (USD)'), '15')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(saveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({ inputPrice: 3.5, outputPrice: 15 }),
    )
  })

  it('clearing a price field back to empty saves undefined, not 0 or NaN', async () => {
    useAiStore.setState({
      configs: [{ ...cfg(), inputPrice: 3.5, outputPrice: 15 }],
    })
    await openEdit()

    const input = screen.getByLabelText('Price per 1M input tokens (USD)')
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(saveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({ inputPrice: undefined, outputPrice: 15 }),
    )
  })

  it('prefills empty price fields from the selected model\'s fetched pricing', async () => {
    useAiStore.setState({ models: { c1: [modelWithPricing('model-a')] } })
    await openEdit()

    expect(screen.getByLabelText('Price per 1M input tokens (USD)')).toHaveValue(3)
    expect(screen.getByLabelText('Price per 1M output tokens (USD)')).toHaveValue(15)
  })

  it('does not overwrite a price the reviewer already typed when a priced model is picked', async () => {
    useAiStore.setState({
      models: { c1: [modelWithPricing('model-a'), modelWithPricing('model-b')] },
    })
    await openEdit()

    const inputPrice = screen.getByLabelText('Price per 1M input tokens (USD)')
    await userEvent.clear(inputPrice)
    await userEvent.type(inputPrice, '99')

    const modelField = screen.getByRole('combobox', { name: 'Model' })
    await userEvent.clear(modelField)
    await userEvent.type(modelField, 'model-b')

    expect(screen.getByLabelText('Price per 1M input tokens (USD)')).toHaveValue(99)
    expect(screen.getByLabelText('Price per 1M output tokens (USD)')).toHaveValue(15)
  })
})

describe('no-key toggle', () => {
  function ocCfg(): LlmConfig {
    return {
      id: 'c2',
      name: 'Local server',
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234',
      model: 'local-model',
      attach: 'text',
      hasKey: false,
    }
  }

  it('is offered for openai-compatible and lets the target save without a key', async () => {
    useAiStore.setState({ configs: [ocCfg()] })
    await openEdit()

    await userEvent.click(screen.getByLabelText('No API key'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ noKey: true }))
  })

  it('is not offered for a fixed-URL provider like OpenRouter', async () => {
    useAiStore.setState({ configs: [cfg()] })
    await openEdit()

    expect(screen.queryByLabelText('No API key')).not.toBeInTheDocument()
  })
})
