import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LlmConfig } from '../llm/types'

const saveLlmConfig = vi.fn(async (config: LlmConfig) => [config])
const platform: Record<string, unknown> = {}

vi.mock('../platform', () => ({ getPlatform: () => platform }))

// Read by the project store at import time.
const BASE = {
  kind: 'electron',
  getRecents: () => [],
  getOsInfo: () => null,
  listLlmConfigs: async () => useAiStore.getState().configs,
  saveLlmConfig: (c: LlmConfig) => saveLlmConfig(c),
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
  localRuntime: null,
  ollama: undefined,
}
Object.assign(platform, BASE)

const { useAiStore } = await import('../state/aiStore')
const { LlmSettingsDialog } = await import('./LlmSettingsDialog')

const HW = {
  platform: 'darwin', arch: 'arm64', totalRamBytes: 16e9, freeRamBytes: 8e9,
  gpus: [{ vendor: 'apple', name: 'Apple M3' }], diskFreeBytes: 200e9, recommendedBackend: 'metal',
}
const RT_PLAN = {
  tag: 'b9999', assetName: 'llama.zip', url: 'u', sizeBytes: 30e6, sha256: 'x', backend: 'metal',
  includesSystemOne: true, license: 'MIT', source: 'github.com/ggml-org/llama.cpp', destination: '/rt', diskFreeBytes: 200e9,
}
const MODEL_PLAN = {
  catalogId: 'laya-en-q8', repo: 'ggml-org/Laya-GGUF', file: 'f', url: 'u', sizeBytes: 449e6, sha256: 'x',
  license: 'Apache-2.0', destination: '/models/laya.gguf', diskFreeBytes: 200e9, resumeFrom: 0,
}

function localRuntime(over: Record<string, unknown> = {}) {
  return {
    probe: vi.fn(async () => HW),
    runtime: vi.fn(async () => ({ found: false, source: 'none', supportsSystemOne: 'unknown' })),
    runtimePlan: vi.fn(async () => RT_PLAN),
    runtimeInstall: vi.fn(async () => ({ found: true, source: 'managed', supportsSystemOne: true })),
    modelPlan: vi.fn(async () => MODEL_PLAN),
    modelInstall: vi.fn(async () => ({ catalogId: 'laya-en-q8', file: 'f', sizeBytes: 449e6 })),
    cancel: vi.fn(async () => {}),
    installed: vi.fn(async () => []),
    remove: vi.fn(async () => []),
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(async () => []),
    logs: vi.fn(async () => []),
    onProgress: vi.fn(() => () => {}),
    ...over,
  }
}

beforeEach(() => {
  saveLlmConfig.mockClear()
  for (const k of Object.keys(platform)) delete platform[k]
  Object.assign(platform, BASE)
  useAiStore.setState({ settingsOpen: true, configs: [], models: {}, modelsLoading: {}, modelsError: {} })
})

async function addAndPick(kind: string) {
  render(<LlmSettingsDialog />)
  await userEvent.click(screen.getByRole('button', { name: '+ Add model…' }))
  await userEvent.selectOptions(screen.getByLabelText('Provider'), kind)
}

describe('guided provider entries', () => {
  it('offers the three guided entries and no raw systemone/ollama entries', async () => {
    await addAndPick('openai')
    const labels = within(screen.getByLabelText('Provider')).getAllByRole('option').map((o) => o.textContent)
    expect(labels).toContain('Local model — chat (Ollama, LM Studio, llama.cpp, vLLM)')
    expect(labels).toContain('Local model — decision model (System 1)')
    expect(labels).toContain('Hosted decision model — Clef (Cloudflare) / Jev')
    expect(labels).not.toContain('System One (Jev-compatible)')
    expect(labels).not.toContain('Ollama (local)')
  })

  it('shows "Available in the desktop app" in the browser build', async () => {
    await addAndPick('local-s1')
    expect(screen.getByText('Available in the desktop app.')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'local-chat')
    expect(screen.getByText('Available in the desktop app.')).toBeInTheDocument()
  })
})

describe('hosted Clef on Cloudflare', () => {
  it('rejects a bad account id and saves the cloudflare fields with the Clef context', async () => {
    await addAndPick('hosted-s1')
    expect(screen.getByLabelText('Model')).toHaveValue('clef-flash')
    expect(screen.getByLabelText('Context window (tokens)')).toHaveValue(65536)
    await userEvent.type(screen.getByLabelText('Name'), 'Clef')
    await userEvent.type(screen.getByLabelText('API token'), 'tok')

    await userEvent.type(screen.getByLabelText('Account ID'), 'XYZ')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveLlmConfig).not.toHaveBeenCalled()
    expect(screen.getAllByText(/32 lowercase hex/).length).toBeGreaterThan(0)

    await userEvent.clear(screen.getByLabelText('Account ID'))
    await userEvent.type(screen.getByLabelText('Account ID'), 'a'.repeat(32))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'systemone', systemOneFlavor: 'cloudflare', accountId: 'a'.repeat(32), model: 'clef-flash', contextTokens: 65536,
      }),
    )
  })
})

describe('local System One panel', () => {
  it('shows hardware, and asks consent before installing the runtime', async () => {
    const rt = localRuntime()
    platform.localRuntime = rt
    await addAndPick('local-s1')
    expect(await screen.findByText(/Will run on GPU \(Metal\)/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Review runtime download/ }))
    const box = await screen.findByRole('group', { name: 'Runtime download consent' })
    expect(rt.runtimeInstall).not.toHaveBeenCalled()
    await userEvent.click(within(box).getByRole('button', { name: /Download 30 MB/ }))
    expect(rt.runtimeInstall).toHaveBeenCalledTimes(1)
  })

  it('explains that no release has the route yet and keeps install disabled', async () => {
    const rt = localRuntime({ runtimePlan: vi.fn(async () => ({ ...RT_PLAN, includesSystemOne: false })) })
    platform.localRuntime = rt
    await addAndPick('local-s1')
    await userEvent.click(await screen.findByRole('button', { name: /Review runtime download/ }))
    const box = await screen.findByRole('group', { name: 'Runtime download consent' })
    expect(within(box).getByRole('alert')).toHaveTextContent(/No released llama\.cpp build includes the System One route yet/)
    expect(within(box).getByRole('button', { name: /Download/ })).toBeDisabled()
    expect(rt.runtimeInstall).not.toHaveBeenCalled()
  })

  it('lists planned models without a download button, and downloads only after consent', async () => {
    const rt = localRuntime()
    platform.localRuntime = rt
    await addAndPick('local-s1')
    const clef = await screen.findByRole('listitem', { name: 'Clef Flash' })
    expect(clef).toHaveTextContent(/Needs a llama\.cpp build with Clef support/)
    expect(within(clef).queryByRole('button')).toBeNull()

    const laya = screen.getByRole('listitem', { name: 'Laya (English, Q8_0)' })
    expect(laya).toHaveTextContent(/up to 192 for questions and answer options/)
    await userEvent.click(within(laya).getByRole('button', { name: 'Download' }))
    const box = await screen.findByRole('group', { name: 'Model download consent' })
    expect(box).toHaveTextContent(/downloads a 449 MB model file from huggingface\.co \(ggml-org\/Laya-GGUF\) to \/models\/laya\.gguf/)
    expect(rt.modelInstall).not.toHaveBeenCalled()
    await userEvent.click(within(box).getByRole('button', { name: /Download 449 MB/ }))
    expect(rt.modelInstall).toHaveBeenCalledWith('laya-en-q8')
  })

  it('saves an installed catalog model as a managed target', async () => {
    platform.localRuntime = localRuntime({ installed: vi.fn(async () => [{ catalogId: 'laya-en-q8', file: 'f', sizeBytes: 1 }]) })
    await addAndPick('local-s1')
    await userEvent.click(await screen.findByRole('button', { name: 'Use this model' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'systemone', managed: { catalogId: 'laya-en-q8' }, noKey: true, contextTokens: 2048, optionsBudgetTokens: 192,
      }),
    )
  })
})

describe('local chat panel', () => {
  const OLLAMA_URL = 'http://localhost:11434'
  function ollamaPlatform(over: Record<string, unknown> = {}) {
    const ollama = {
      version: vi.fn(async () => ({ ok: true, version: '0.9.0', isLocal: true })),
      list: vi.fn(async () => ({
        ok: true, isLocal: true,
        models: [{ name: 'qwen3.5:4b', sizeBytes: 3.4e9, parameterSize: '4B', quantization: 'Q4_K_M' }],
      })),
      show: vi.fn(async () => ({ ok: true, info: { capabilities: [], contextTokens: 262_144, thinking: null, kvBytes: 1e9 } })),
      ps: vi.fn(async () => ({ ok: true, running: [{ name: 'qwen3.5:4b', sizeBytes: 4e9, sizeVram: 4e9 }] })),
      pull: vi.fn(async (_u: string, _m: string, onProgress: (p: unknown) => void) => {
        onProgress({ status: 'pulling abc', total: 100, completed: 40 })
        return { ok: true }
      }),
      delete: vi.fn(async () => ({ ok: true })),
      manifestSize: vi.fn(async () => ({ ok: true, bytes: 3.5e9 })),
      ...over,
    }
    platform.ollama = ollama
    platform.localRuntime = localRuntime()
    platform.discoverLocalServer = vi.fn(async () => ({ ok: true, kind: 'ollama', models: [], isLocal: true }))
    return ollama
  }

  it('checks the connection, picks a model with a context default and saves an ollama target', async () => {
    const ollama = ollamaPlatform()
    await addAndPick('local-chat')
    expect(screen.getByLabelText('Server URL')).toHaveValue(OLLAMA_URL)
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    const row = await screen.findByRole('listitem', { name: 'qwen3.5:4b' })
    expect(row).toHaveTextContent(/3\.4 GB · 4B · Q4_K_M · loaded: 100% GPU/)
    expect(ollama.version).toHaveBeenCalled()

    await userEvent.click(within(row).getByRole('button', { name: 'Use' }))
    expect(await screen.findByLabelText('Context to use')).toHaveValue(32768)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ollama', model: 'qwen3.5:4b', noKey: true, contextTokens: 32768 }),
    )
  })

  it('warns when the estimated memory exceeds free RAM', async () => {
    ollamaPlatform({ show: vi.fn(async () => ({ ok: true, info: { capabilities: [], contextTokens: 262_144, thinking: null, kvBytes: 6e9 } })) })
    await addAndPick('local-chat')
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await userEvent.click(within(await screen.findByRole('listitem', { name: 'qwen3.5:4b' })).getByRole('button', { name: 'Use' }))
    expect(await screen.findByText(/part of the model will run on the CPU: slow/)).toBeInTheDocument()
  })

  it('warns when the host is not local', async () => {
    ollamaPlatform()
    platform.discoverLocalServer = vi.fn(async () => ({ ok: true, kind: 'lmstudio', models: [{ id: 'm1', contextTokens: 8192 }], isLocal: false }))
    await addAndPick('local-chat')
    await userEvent.selectOptions(screen.getByLabelText('Server type'), 'lmstudio')
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    expect(await screen.findByText('Papers will be sent over the network to localhost:1234.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Use' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai-compatible', model: 'm1', contextTokens: 8192 }))
  })

  it('shows the exact manifest size in the consent, then pull progress', async () => {
    const ollama = ollamaPlatform()
    await addAndPick('local-chat')
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    const row = await screen.findByRole('listitem', { name: 'Ministral 3 3B' })
    await userEvent.click(within(row).getByRole('button', { name: 'Download' }))
    const box = await screen.findByRole('group', { name: 'Model download consent' })
    expect(box).toHaveTextContent(/downloads ≈3\.5 GB into Ollama's model folder on localhost:11434/)
    expect(ollama.pull).not.toHaveBeenCalled()
    await userEvent.click(within(box).getByRole('button', { name: /Download 3\.5 GB/ }))
    expect(ollama.pull).toHaveBeenCalled()
    await waitFor(() => expect(ollama.list.mock.calls.length).toBeGreaterThan(1))
  })

  it('reports a missing tag and a failed pull', async () => {
    const ollama = ollamaPlatform({ manifestSize: vi.fn(async () => ({ ok: true, bytes: null })) })
    await addAndPick('local-chat')
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    const row = await screen.findByRole('listitem', { name: 'Ministral 3 3B' })
    await userEvent.click(within(row).getByRole('button', { name: 'Download' }))
    expect(await screen.findByText(/not found in the Ollama registry/)).toBeInTheDocument()

    ollama.manifestSize.mockResolvedValue({ ok: true, bytes: 1e9 })
    ollama.pull.mockResolvedValue({ ok: false, error: 'disk full' } as never)
    await userEvent.click(within(row).getByRole('button', { name: 'Download' }))
    await userEvent.click(await screen.findByRole('button', { name: /Download 1\.0 GB/ }))
    expect(await screen.findByText(/Download failed: disk full/)).toBeInTheDocument()
  })
})
