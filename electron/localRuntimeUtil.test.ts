import { describe, it, expect } from 'vitest'
import {
  allowedDownloadUrl, buildServerArgs, contentRangeStartsAt, explainStartFailure, isReleaseTag, parseDigest,
  parseHfFile, parseServerLog, parseVersion, resumeOffset, RingLog, selectAsset, type GhAsset,
} from './localRuntimeUtil'

const TAG = 'b11349'
const names = [
  'macos-arm64.tar.gz', 'macos-x64.tar.gz', 'ubuntu-x64.tar.gz', 'ubuntu-vulkan-x64.tar.gz', 'ubuntu-arm64.tar.gz',
  'win-cpu-x64.zip', 'win-cpu-arm64.zip', 'win-vulkan-x64.zip', 'win-cuda-12.4-x64.zip', 'win-cuda-13.4-x64.zip',
]
const assets: GhAsset[] = names.map((n) => ({
  name: `llama-${TAG}-bin-${n}`, size: 1, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/x/${n}`,
}))
const pick = (platform: string, arch: string, backend: Parameters<typeof selectAsset>[4]) =>
  selectAsset(assets, TAG, platform, arch, backend)

describe('selectAsset', () => {
  it('macOS gets the Metal-capable build per arch', () => {
    expect(pick('darwin', 'arm64', 'metal')?.asset.name).toBe(`llama-${TAG}-bin-macos-arm64.tar.gz`)
    expect(pick('darwin', 'x64', 'cpu')?.asset.name).toBe(`llama-${TAG}-bin-macos-x64.tar.gz`)
  })
  it('Windows prefers Vulkan over CUDA, else CPU', () => {
    expect(pick('win32', 'x64', 'cuda')).toMatchObject({ backend: 'vulkan' })
    expect(pick('win32', 'x64', 'vulkan')?.asset.name).toContain('win-vulkan-x64')
    expect(pick('win32', 'x64', 'cpu')?.asset.name).toContain('win-cpu-x64')
    expect(pick('win32', 'arm64', 'vulkan')?.asset.name).toContain('win-cpu-arm64') // no arm64 Vulkan build
  })
  it('Linux: Vulkan when wanted and published, else CPU', () => {
    expect(pick('linux', 'x64', 'vulkan')?.asset.name).toContain('ubuntu-vulkan-x64')
    expect(pick('linux', 'x64', 'cpu')?.asset.name).toContain('ubuntu-x64')
    expect(pick('linux', 'arm64', 'vulkan')?.backend).toBe('cpu')
  })
  it('returns nothing for unknown platforms, arches or missing assets', () => {
    expect(pick('freebsd', 'x64', 'cpu')).toBeUndefined()
    expect(pick('linux', 'ia32', 'cpu')).toBeUndefined()
    expect(selectAsset([], TAG, 'darwin', 'arm64', 'metal')).toBeUndefined()
  })
})

describe('digests', () => {
  it('parseDigest accepts only sha256:<64 hex>', () => {
    expect(parseDigest(`sha256:${'AB'.repeat(32)}`)).toBe('ab'.repeat(32))
    for (const v of [undefined, null, '', 'sha1:abc', `sha256:${'a'.repeat(63)}`, 'a'.repeat(64)]) {
      expect(parseDigest(v)).toBeUndefined()
    }
  })
  it('parseHfFile reads the LFS oid and size', () => {
    const tree = [
      { type: 'file', path: 'README.md', size: 5 },
      { type: 'file', path: 'm.gguf', size: 134, lfs: { oid: 'c0'.repeat(32), size: 99 } },
    ]
    expect(parseHfFile(tree, 'm.gguf')).toEqual({ size: 99, sha256: 'c0'.repeat(32) })
    expect(parseHfFile(tree, 'README.md')).toBeUndefined() // not an LFS file: no checksum, refuse
    expect(parseHfFile(tree, 'nope')).toBeUndefined()
    expect(parseHfFile({}, 'm.gguf')).toBeUndefined()
  })
  it('release tags are restricted to b<digits>', () => {
    expect(isReleaseTag('b11349')).toBe(true)
    for (const v of ['../b1', 'v0.5.0', 'b', 'b1/2', 7]) expect(isReleaseTag(v)).toBe(false)
  })
})

describe('resume math', () => {
  it('resumes a shorter partial, restarts an empty or oversized one', () => {
    expect(resumeOffset(100, 1000)).toBe(100)
    expect(resumeOffset(1000, 1000)).toBe(1000)
    expect(resumeOffset(0, 1000)).toBe(0)
    expect(resumeOffset(1001, 1000)).toBe(0)
  })
  it('contentRangeStartsAt checks the response really starts at the offset', () => {
    expect(contentRangeStartsAt('bytes 100-999/1000', 100)).toBe(true)
    expect(contentRangeStartsAt('bytes 0-999/1000', 100)).toBe(false)
    expect(contentRangeStartsAt(null, 100)).toBe(false)
  })
})

describe('allowedDownloadUrl', () => {
  it('allows GitHub and its asset CDN, https only', () => {
    for (const u of [
      'https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip',
      'https://api.github.com/repos/a/b',
      'https://release-assets.githubusercontent.com/x',
      'https://objects.githubusercontent.com/x',
    ]) expect(allowedDownloadUrl('github', u)).toBe(true)
  })
  it('allows Hugging Face and its CDNs', () => {
    for (const u of ['https://huggingface.co/a/b', 'https://cdn-lfs.huggingface.co/x', 'https://cas-bridge.xethub.hf.co/x']) {
      expect(allowedDownloadUrl('huggingface', u)).toBe(true)
    }
  })
  it('refuses everything else', () => {
    for (const [k, u] of [
      ['github', 'http://github.com/x'],
      ['github', 'https://evilgithub.com/x'],
      ['github', 'https://github.com.evil.io/x'],
      ['github', 'https://huggingface.co/x'],
      ['huggingface', 'https://github.com/x'],
      ['huggingface', 'https://nothf.co/x'],
      ['github', 'https://user:pw@github.com/x'],
      ['github', 'https://github.com:8443/x'],
      ['github', 'file:///etc/passwd'],
      ['github', 'not a url'],
    ] as const) expect(allowedDownloadUrl(k, u)).toBe(false)
  })
})

describe('server flags and logs', () => {
  const base = { modelPath: '/m/x.gguf', port: 5555, contextTokens: 2048, apiKey: 'k' }
  it('builds loopback-only args with batch = context', () => {
    const a = buildServerArgs({ ...base, gpu: true })
    expect(a).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '-c', '2048', '-b', '2048', '-ub', '2048', '-np', '1', '--no-webui']))
    expect(a.join(' ')).toContain('-ngl 99')
    expect(a.join(' ')).toContain('--api-key k')
  })
  it('CPU mode hides the devices', () => {
    expect(buildServerArgs({ ...base, gpu: false }).join(' ')).toContain('-dev none -ngl 0')
  })
  it('parseServerLog reports the real backend', () => {
    const gpu = [
      '0.00.116.899 I llama_prepare_model_devices: using device MTL0 (Apple M3 Pro) (unknown id) - 13639 MiB free',
      '0.00.228.851 I load_tensors: offloaded 31/31 layers to GPU',
    ]
    expect(parseServerLog(gpu)).toEqual({ backend: 'metal', usingGpu: true, layersOffloaded: 31 })
    expect(parseServerLog(gpu.map((l) => l.replace('MTL0', 'CUDA0')))).toMatchObject({ backend: 'cuda' })
    expect(parseServerLog(gpu.map((l) => l.replace('MTL0', 'Vulkan0')))).toMatchObject({ backend: 'vulkan' })
  })
  it('a device that holds zero layers is not GPU use', () => {
    const cpu = ['using device MTL0 (Apple M3 Pro)', 'load_tensors: offloaded 0/31 layers to GPU']
    expect(parseServerLog(cpu)).toEqual({ backend: 'cpu', usingGpu: false, layersOffloaded: 0 })
    expect(parseServerLog([])).toEqual({ backend: 'cpu', usingGpu: false, layersOffloaded: undefined })
  })
  it('explains known start failures', () => {
    expect(explainStartFailure(["error loading model: unknown model architecture: 'ggmlc'"])).toMatch(/cannot load/)
    expect(explainStartFailure(['check_tensor_dims: tensor x has wrong shape'])).toMatch(/cannot load/)
    expect(explainStartFailure(['ggml_vulkan: ErrorOutOfDeviceMemory'])).toMatch(/memory/)
    expect(explainStartFailure(['something else'])).toBeUndefined()
  })
  it('parseVersion extracts the build tag', () => {
    expect(parseVersion('version: 0.5.0-dev (build 11349, commit fb4b2737a)\nbuilt with')).toBe('b11349')
    expect(parseVersion('version: 0.5.0-dev (build 0, commit unknown)')).toBe('0.5.0-dev')
    expect(parseVersion('garbage')).toBeUndefined()
  })
  it('RingLog keeps the last N complete lines', () => {
    const r = new RingLog(3)
    r.push('a\nb\nc')
    r.push('\nd\ne\nf\n')
    expect(r.all()).toEqual(['d', 'e', 'f'])
    r.push('par')
    expect(r.all()).toEqual(['d', 'e', 'f', 'par'])
  })
})
