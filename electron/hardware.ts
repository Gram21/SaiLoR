// Best-effort hardware probe for choosing a llama.cpp backend. Every probe
// may fail (tool missing, sandbox, timeout) — that means "unknown", never an error.

import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import type { Backend, GpuVendor, HardwareInfo } from '../src/platform/localRuntime'

type Gpu = HardwareInfo['gpus'][number]

export function vendorOf(name: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name)) return 'nvidia'
  if (/\bamd\b|radeon|advanced micro/i.test(name)) return 'amd'
  if (/intel|\barc\b|iris|uhd/i.test(name)) return 'intel'
  if (/apple/i.test(name)) return 'apple'
  return 'other'
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (memory in MiB). */
export function parseNvidiaSmi(out: string): Gpu[] {
  const gpus: Gpu[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(.+?),\s*(\d+)\s*$/)
    if (m) gpus.push({ vendor: 'nvidia', name: m[1].trim(), vramBytes: Number(m[2]) * 1024 * 1024 })
  }
  return gpus
}

/** `system_profiler SPDisplaysDataType -json`. Apple GPUs share system RAM, so no VRAM figure. */
export function parseSystemProfiler(json: string): Gpu[] {
  try {
    const items = (JSON.parse(json) as { SPDisplaysDataType?: { sppci_model?: string }[] }).SPDisplaysDataType ?? []
    return items.flatMap((i) => (i.sppci_model ? [{ vendor: vendorOf(i.sppci_model), name: i.sppci_model }] : []))
  } catch {
    return []
  }
}

/** One adapter name per line (`Get-CimInstance Win32_VideoController`). Skips software adapters. */
export function parseWindowsVideo(out: string): Gpu[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/basic render|basic display|remote display|virtual/i.test(l))
    .map((name) => ({ vendor: vendorOf(name), name }))
}

/** `lspci` lines for display controllers. */
export function parseLspci(out: string): Gpu[] {
  return out
    .split(/\r?\n/)
    .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
    .map((l) => {
      const name = l.replace(/^.*?(VGA compatible controller|3D controller|Display controller):\s*/i, '').trim()
      return { vendor: vendorOf(name), name }
    })
}

export function recommendBackend(platform: string, arch: string, gpus: Gpu[]): Backend {
  if (platform === 'darwin') return arch === 'arm64' ? 'metal' : 'cpu' // Intel Macs: the stock build is CPU-only here
  if (gpus.some((g) => g.vendor === 'nvidia')) return platform === 'win32' || platform === 'linux' ? 'vulkan' : 'cpu'
  // ponytail: NVIDIA also runs on Vulkan; a CUDA build needs a separate cudart bundle, add when Vulkan is too slow.
  if (gpus.some((g) => g.vendor === 'amd' || g.vendor === 'intel')) return 'vulkan'
  return 'cpu'
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    )
  })
}

async function probeGpus(platform: string, arch: string): Promise<Gpu[]> {
  if (platform === 'darwin') {
    const found = parseSystemProfiler(await run('system_profiler', ['SPDisplaysDataType', '-json'], 8000))
    if (found.length) return found
    return arch === 'arm64' ? [{ vendor: 'apple', name: 'Apple GPU' }] : []
  }
  const nvidia = parseNvidiaSmi(
    await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']),
  )
  const others =
    platform === 'win32'
      ? parseWindowsVideo(
          await run(
            'powershell.exe',
            ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'],
            8000,
          ),
        )
      : parseLspci(await run('lspci', []))
  // nvidia-smi has the VRAM figure; drop the same cards from the name-only list.
  return [...nvidia, ...others.filter((g) => g.vendor !== 'nvidia' || nvidia.length === 0)]
}

export async function probeHardware(dataDir: string): Promise<HardwareInfo> {
  const platform = process.platform
  const arch = process.arch
  const [gpus, diskFreeBytes] = await Promise.all([
    probeGpus(platform, arch).catch(() => []),
    statfs(dataDir).then((s) => s.bavail * s.bsize, () => -1),
  ])
  return {
    platform,
    arch,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    gpus,
    diskFreeBytes,
    recommendedBackend: recommendBackend(platform, arch, gpus),
  }
}
