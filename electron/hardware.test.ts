import { describe, it, expect } from 'vitest'
import { parseLspci, parseNvidiaSmi, parseSystemProfiler, parseWindowsVideo, recommendBackend, vendorOf } from './hardware'

describe('hardware parsers', () => {
  it('nvidia-smi csv (MiB) to bytes', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA T4, 15360\n')).toEqual([
      { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramBytes: 24564 * 1024 * 1024 },
      { vendor: 'nvidia', name: 'NVIDIA T4', vramBytes: 15360 * 1024 * 1024 },
    ])
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate')).toEqual([])
    expect(parseNvidiaSmi('')).toEqual([])
  })
  it('system_profiler json', () => {
    const j = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Pro' }, { _name: 'no model' }] })
    expect(parseSystemProfiler(j)).toEqual([{ vendor: 'apple', name: 'Apple M3 Pro' }])
    expect(parseSystemProfiler('not json')).toEqual([])
  })
  it('PowerShell adapter names skip software adapters', () => {
    const out = 'NVIDIA GeForce GTX 1060\r\nMicrosoft Basic Render Driver\r\nIntel(R) UHD Graphics 630\r\n\r\n'
    expect(parseWindowsVideo(out).map((g) => g.vendor)).toEqual(['nvidia', 'intel'])
  })
  it('lspci display controllers', () => {
    const out = [
      '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620',
      '01:00.0 3D controller: NVIDIA Corporation GP108M [GeForce MX150]',
      '00:1f.3 Audio device: Intel Corporation Sunrise Point-LP HD Audio',
    ].join('\n')
    expect(parseLspci(out)).toEqual([
      { vendor: 'intel', name: 'Intel Corporation UHD Graphics 620' },
      { vendor: 'nvidia', name: 'NVIDIA Corporation GP108M [GeForce MX150]' },
    ])
  })
  it('vendorOf', () => {
    expect(vendorOf('AMD Radeon RX 7900')).toBe('amd')
    expect(vendorOf('Mystery Board')).toBe('other')
  })
})

describe('recommendBackend', () => {
  const nv = [{ vendor: 'nvidia' as const, name: 'x' }]
  it('Apple silicon uses Metal; Intel Macs CPU', () => {
    expect(recommendBackend('darwin', 'arm64', [])).toBe('metal')
    expect(recommendBackend('darwin', 'x64', [])).toBe('cpu')
  })
  it('discrete GPUs map to Vulkan, none to CPU', () => {
    expect(recommendBackend('win32', 'x64', nv)).toBe('vulkan')
    expect(recommendBackend('linux', 'x64', [{ vendor: 'amd', name: 'x' }])).toBe('vulkan')
    expect(recommendBackend('linux', 'x64', [])).toBe('cpu')
  })
})
