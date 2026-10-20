// App-managed local runtime: finds or installs llama.cpp's `llama-server`,
// downloads decision-model files, and runs one server per model on 127.0.0.1.
//
// Trust model: the renderer only names a catalog id. URLs, file paths and the
// executable are decided here; every download is hash-verified against a digest
// the host itself publishes (GitHub asset digest / Hugging Face LFS oid), and a
// download only starts after the matching plan was produced (and shown to the
// user for consent) in this session. No Python, no remote code.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { findCatalogEntry, requireAvailableEntry } from '../src/llm/localCatalog'
import type {
  InstalledModel, LocalProgress, LocalServerInfo, LocalServerStatus, ModelPlan, RuntimePlan, RuntimeStatus,
} from '../src/platform/localRuntime'
import { probeHardware } from './hardware'
import {
  allowedDownloadUrl, buildServerArgs, explainStartFailure, isReleaseTag, parseDigest, parseHfFile, parseServerLog,
  parseVersion, resumeOffset, contentRangeStartsAt, RingLog, selectAsset, SYSTEMONE_COMMIT, type GhAsset, type HostKind,
} from './localRuntimeUtil'

const IDLE_STOP_MS = 10 * 60 * 1000
const HEALTH_TIMEOUT_MS = 120_000
const STALL_MS = 60_000
const GH = 'https://api.github.com/repos/ggml-org/llama.cpp'
const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
const UA = { 'user-agent': 'SaiLoR' }

export interface LocalRuntimeDeps {
  dataDir: () => string
  emit: (p: LocalProgress) => void
}

interface Running {
  child: ChildProcess
  port: number
  apiKey: string
  info: LocalServerInfo
  log: RingLog
  lastUsed: number
}

export function createLocalRuntime(deps: LocalRuntimeDeps) {
  const runtimeRoot = () => path.join(deps.dataDir(), 'local-runtime', 'llama.cpp')
  const modelsRoot = () => path.join(deps.dataDir(), 'local-models')
  const aborts = new Map<string, AbortController>()
  const servers = new Map<string, Running>()
  const starting = new Map<string, Promise<LocalServerInfo>>()
  const logs = new Map<string, RingLog>()
  const runtimePlans: { current?: RuntimePlan } = {}
  const modelPlans = new Map<string, ModelPlan>()

  // ---- HTTP -------------------------------------------------------------

  /** GET with manual redirects so every hop is host-checked. */
  async function get(kind: HostKind, url: string, init: RequestInit = {}): Promise<Response> {
    let cur = url
    for (let hop = 0; hop < 6; hop++) {
      if (!allowedDownloadUrl(kind, cur)) throw new Error(`Refusing to download from ${new URL(cur).host}.`)
      const res = await fetch(cur, { ...init, redirect: 'manual', headers: { ...UA, ...init.headers } })
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel()
        cur = new URL(loc, cur).toString()
        continue
      }
      return res
    }
    throw new Error('Too many redirects.')
  }

  async function getJson(kind: HostKind, url: string): Promise<unknown> {
    const res = await get(kind, url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`)
    return res.json()
  }

  async function sha256Of(file: string, onBytes?: (n: number) => void): Promise<string> {
    const h = createHash('sha256')
    let n = 0
    for await (const chunk of createReadStream(file)) {
      h.update(chunk as Buffer)
      n += (chunk as Buffer).length
      onBytes?.(n)
    }
    return h.digest('hex')
  }

  /** Download `url` to `partial` (resuming a previous partial), then verify its SHA-256. */
  async function downloadVerified(a: {
    id: string; kind: LocalProgress['kind']; host: HostKind; url: string; partial: string; size: number; sha256: string
  }): Promise<void> {
    const ctl = new AbortController()
    aborts.set(a.id, ctl)
    const emit = (completed: number, phase: LocalProgress['phase']) =>
      deps.emit({ id: a.id, kind: a.kind, completed, total: a.size, phase })
    try {
      await mkdir(path.dirname(a.partial), { recursive: true })
      const have = await stat(a.partial).then((s) => s.size, () => 0)
      let offset = resumeOffset(have, a.size)
      if (offset < a.size) {
        const res = await get(a.host, a.url, { headers: offset ? { range: `bytes=${offset}-` } : {}, signal: ctl.signal })
        if (res.status === 206 && contentRangeStartsAt(res.headers.get('content-range'), offset)) {
          // resuming
        } else if (res.status === 200) offset = 0
        else throw new Error(`Download failed (${res.status}).`)
        const out = createWriteStream(a.partial, { flags: offset ? 'a' : 'w' })
        let done = offset
        let last = 0
        let stall = setTimeout(() => ctl.abort(), STALL_MS)
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (!out.write(chunk)) await once(out, 'drain')
            done += chunk.length
            clearTimeout(stall)
            stall = setTimeout(() => ctl.abort(), STALL_MS)
            if (Date.now() - last > 250) { last = Date.now(); emit(done, 'download') }
          }
        } finally {
          clearTimeout(stall)
          out.end()
          await once(out, 'close')
        }
        emit(done, 'download')
      }
      emit(a.size, 'verify')
      const size = (await stat(a.partial)).size
      if (size !== a.size || (await sha256Of(a.partial)) !== a.sha256) {
        await rm(a.partial, { force: true })
        throw new Error('Downloaded file does not match its published SHA-256; it was discarded.')
      }
    } catch (e) {
      if (ctl.signal.aborted) throw new Error('Download cancelled or stalled; the partial file is kept for resuming.')
      throw e
    } finally {
      aborts.delete(a.id)
    }
  }

  // ---- runtime ----------------------------------------------------------

  async function findBinary(dir: string, depth = 0): Promise<string | undefined> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (entries.some((e) => e.isFile() && e.name === EXE)) return path.join(dir, EXE)
    if (depth >= 2) return undefined
    for (const e of entries) {
      if (e.isDirectory()) {
        const f = await findBinary(path.join(dir, e.name), depth + 1)
        if (f) return f
      }
    }
    return undefined
  }

  function versionOf(bin: string): Promise<string | undefined> {
    return new Promise((resolve) =>
      execFile(bin, ['--version'], { timeout: 10_000, windowsHide: true }, (_e, out, err) =>
        resolve(parseVersion(`${out}\n${err}`)),
      ),
    )
  }

  async function findSystem(): Promise<string | undefined> {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const dirs = [
      ...(process.env.PATH ?? '').split(path.delimiter),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin'),
    ].filter(Boolean)
    for (const d of dirs) {
      const f = path.join(d, EXE)
      if (await stat(f).then((s) => s.isFile(), () => false)) return f
    }
    return undefined
  }

  async function runtime(): Promise<RuntimeStatus> {
    // ponytail: a user-set path comes only from this env var — never from the renderer, which would be arbitrary exec.
    const envPath = process.env.SAILOR_LLAMA_SERVER
    if (envPath && (await stat(envPath).then((s) => s.isFile(), () => false))) {
      return { found: true, source: 'system', path: envPath, version: await versionOf(envPath), supportsSystemOne: 'unknown' }
    }
    const tags = (await readdir(runtimeRoot()).catch(() => [] as string[])).filter(isReleaseTag)
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
    for (const tag of tags) {
      const bin = await findBinary(path.join(runtimeRoot(), tag))
      if (!bin) continue
      const manifest = JSON.parse(await readFile(path.join(runtimeRoot(), tag, 'manifest.json'), 'utf-8').catch(() => '{}'))
      return {
        found: true, source: 'managed', path: bin, version: tag,
        supportsSystemOne: typeof manifest.includesSystemOne === 'boolean' ? manifest.includesSystemOne : 'unknown',
      }
    }
    const sys = await findSystem()
    if (sys) return { found: true, source: 'system', path: sys, version: await versionOf(sys), supportsSystemOne: 'unknown' }
    return { found: false, source: 'none', supportsSystemOne: 'unknown' }
  }

  async function includesRoute(tag: string): Promise<boolean | 'unknown'> {
    try {
      const j = (await getJson('github', `${GH}/compare/${SYSTEMONE_COMMIT}...${tag}`)) as { status?: string }
      return j.status === 'ahead' || j.status === 'identical'
    } catch {
      return 'unknown'
    }
  }

  async function runtimePlan(): Promise<RuntimePlan> {
    const hw = await probeHardware(deps.dataDir())
    // `releases/latest` points at an unrelated tag stream; the b<N> builds are the pre-releases listed here.
    const releases = (await getJson('github', `${GH}/releases?per_page=15`)) as {
      tag_name: string; draft: boolean; assets: GhAsset[]
    }[]
    for (const r of releases) {
      if (r.draft || !isReleaseTag(r.tag_name)) continue
      const pick = selectAsset(r.assets, r.tag_name, process.platform, process.arch, hw.recommendedBackend)
      const sha256 = parseDigest(pick?.asset.digest)
      if (!pick || !sha256) continue // assets still uploading, or no published digest: skip, never guess
      const plan: RuntimePlan = {
        tag: r.tag_name, assetName: pick.asset.name, url: pick.asset.browser_download_url, sizeBytes: pick.asset.size,
        sha256, backend: pick.backend, includesSystemOne: await includesRoute(r.tag_name),
        license: 'MIT', source: 'github.com/ggml-org/llama.cpp',
        destination: path.join(runtimeRoot(), r.tag_name), diskFreeBytes: hw.diskFreeBytes,
      }
      runtimePlans.current = plan
      return plan
    }
    throw new Error('No llama.cpp release with a verifiable build for this machine was found.')
  }

  function extract(archive: string, into: string): Promise<void> {
    // bsdtar reads .tar.gz and .zip; on Windows use the system one (a PATH `tar` may be GNU tar, which cannot read zip).
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    return new Promise((resolve, reject) =>
      execFile(tar, ['-xf', archive, '-C', into], { timeout: 120_000, windowsHide: true }, (e, _o, err) =>
        e ? reject(new Error(`Could not extract the runtime: ${err || e.message}`)) : resolve(),
      ),
    )
  }

  async function runtimeInstall(): Promise<RuntimeStatus> {
    const plan = runtimePlans.current
    if (!plan) throw new Error('Review the runtime download plan first.')
    if (plan.includesSystemOne === false) {
      throw new Error(`The newest llama.cpp release (${plan.tag}) does not include the System One route yet. Try again later.`)
    }
    const root = runtimeRoot()
    const partial = path.join(root, '.downloads', plan.assetName + '.partial')
    await downloadVerified({ id: 'runtime', kind: 'runtime', host: 'github', url: plan.url, partial, size: plan.sizeBytes, sha256: plan.sha256 })
    deps.emit({ id: 'runtime', kind: 'runtime', completed: plan.sizeBytes, total: plan.sizeBytes, phase: 'extract' })
    const tmp = path.join(root, `.tmp-${plan.tag}`)
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    try {
      await extract(partial, tmp)
      const bin = await findBinary(tmp)
      if (!bin) throw new Error('The archive contains no llama-server.')
      if (process.platform !== 'win32') await chmod(bin, 0o755)
      if (!(await versionOf(bin))) throw new Error('The downloaded llama-server does not run on this machine.')
      await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify({ tag: plan.tag, backend: plan.backend, includesSystemOne: plan.includesSystemOne }))
      await rm(plan.destination, { recursive: true, force: true })
      await rename(tmp, plan.destination)
    } finally {
      await rm(tmp, { recursive: true, force: true })
      await rm(partial, { force: true })
    }
    for (const t of await readdir(root)) if (isReleaseTag(t) && t !== plan.tag) await rm(path.join(root, t), { recursive: true, force: true })
    deps.emit({ id: 'runtime', kind: 'runtime', completed: plan.sizeBytes, total: plan.sizeBytes, phase: 'done' })
    return runtime()
  }

  // ---- model files ------------------------------------------------------

  const modelFile = (id: string, file: string) => path.join(modelsRoot(), id, file)

  async function modelPlan(catalogId: string): Promise<ModelPlan> {
    const e = requireAvailableEntry(catalogId)
    const rev = e.revision ?? ((await getJson('huggingface', `https://huggingface.co/api/models/${e.hfRepo}`)) as { sha?: string }).sha
    if (!rev || !/^[0-9a-f]{40}$/.test(rev)) throw new Error('Could not resolve the model revision.')
    const tree = await getJson('huggingface', `https://huggingface.co/api/models/${e.hfRepo}/tree/${rev}`)
    const f = parseHfFile(tree, e.hfFile)
    if (!f) throw new Error('Hugging Face lists no verifiable checksum for this model file.')
    const dest = modelFile(e.id, e.hfFile)
    const plan: ModelPlan = {
      catalogId: e.id, repo: e.hfRepo, file: e.hfFile, sizeBytes: f.size, sha256: f.sha256, license: e.license,
      url: `https://huggingface.co/${e.hfRepo}/resolve/${rev}/${e.hfFile}`, destination: dest,
      diskFreeBytes: (await probeHardware(deps.dataDir())).diskFreeBytes,
      resumeFrom: await stat(dest + '.partial').then((s) => s.size, () => 0),
    }
    modelPlans.set(e.id, plan)
    return plan
  }

  async function modelInstall(catalogId: string): Promise<InstalledModel> {
    const e = requireAvailableEntry(catalogId)
    const plan = modelPlans.get(e.id)
    if (!plan) throw new Error('Review the model download plan first.')
    if (plan.diskFreeBytes >= 0 && plan.diskFreeBytes < plan.sizeBytes - plan.resumeFrom) throw new Error('Not enough free disk space.')
    const partial = plan.destination + '.partial'
    await downloadVerified({ id: e.id, kind: 'model', host: 'huggingface', url: plan.url, partial, size: plan.sizeBytes, sha256: plan.sha256 })
    await rename(partial, plan.destination)
    deps.emit({ id: e.id, kind: 'model', completed: plan.sizeBytes, total: plan.sizeBytes, phase: 'done' })
    return { catalogId: e.id, file: e.hfFile, sizeBytes: plan.sizeBytes }
  }

  async function installed(): Promise<InstalledModel[]> {
    const out: InstalledModel[] = []
    for (const id of await readdir(modelsRoot()).catch(() => [] as string[])) {
      const e = findCatalogEntry(id)
      const s = e && (await stat(modelFile(id, e.hfFile)).catch(() => undefined))
      if (e && s?.isFile()) out.push({ catalogId: id, file: e.hfFile, sizeBytes: s.size })
    }
    return out
  }

  async function remove(catalogId: string): Promise<InstalledModel[]> {
    const e = findCatalogEntry(catalogId)
    if (!e) throw new Error('Unknown local model.')
    await stop(e.id)
    await rm(path.join(modelsRoot(), e.id), { recursive: true, force: true })
    return installed()
  }

  // ---- server manager ---------------------------------------------------

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const s = net.createServer()
      s.once('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo
        s.close(() => resolve(port))
      })
    })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function launch(bin: string, catalogId: string, gpu: boolean): Promise<Running> {
    const e = requireAvailableEntry(catalogId)
    const port = await freePort()
    const apiKey = randomBytes(24).toString('hex')
    const args = buildServerArgs({ modelPath: modelFile(e.id, e.hfFile), port, contextTokens: e.contextTokens, gpu, apiKey })
    const log = new RingLog(200)
    logs.set(catalogId, log)
    // The offload summary sits early in a long startup log; the 200-line ring would drop it.
    const startupLog = new RingLog(2000)
    const child = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let exited = false
    child.on('exit', () => {
      exited = true
      if (servers.get(catalogId)?.child === child) servers.delete(catalogId)
    })
    child.on('error', () => { exited = true })
    for (const s of [child.stdout, child.stderr]) {
      s?.setEncoding('utf-8')
      s?.on('data', (d: string) => { log.push(d); startupLog.push(d) })
    }
    const fail = async (msg: string): Promise<never> => {
      kill(child)
      const hint = explainStartFailure(startupLog.all().concat(log.all()))
      // An incompatible build/model fails the same way on the CPU, so don't retry there.
      throw Object.assign(new Error(hint ?? msg), { noRetry: Boolean(hint) && !/memory/i.test(hint!), log: log.all() })
    }
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    for (;;) {
      if (exited) return fail('The local model server exited during startup.')
      if (Date.now() > deadline) return fail('The local model server did not become ready in time.')
      const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
      if (ok) break
      await sleep(150)
    }
    const real = parseServerLog(startupLog.all())
    const info: LocalServerInfo = { catalogId, baseUrl: `http://127.0.0.1:${port}`, ...real }
    return { child, port, apiKey, info, log, lastUsed: Date.now() }
  }

  /** Ask the freshly started server a tiny question; a build without the route answers 404. */
  async function probeRoute(r: Running): Promise<void> {
    const res = await fetch(`${r.info.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.apiKey}` },
      body: JSON.stringify({ state: 'ok', questions: { q: { type: 'noul', instructions: 'Is this text?' } } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) return
    kill(r.child)
    if (res.status === 404 || res.status === 405) {
      throw new Error('This llama.cpp build has no System One route (/v1/systemone). Install a newer runtime.')
    }
    if (res.status === 501) throw new Error('This model is not a decision model for this llama.cpp build.')
    throw new Error(`The local model server rejected the self-test (${res.status}).`)
  }

  function kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.pid === undefined) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref()
    }
  }

  async function start(catalogId: string): Promise<LocalServerInfo> {
    const e = requireAvailableEntry(catalogId)
    const cur = servers.get(e.id)
    if (cur && cur.child.exitCode === null) { cur.lastUsed = Date.now(); return cur.info }
    const pending = starting.get(e.id)
    if (pending) return pending
    const p = (async () => {
      if (process.getuid?.() === 0) throw new Error('Refusing to run a model server as root.')
      if (!(await installed()).some((m) => m.catalogId === e.id)) throw new Error('The model is not downloaded yet.')
      const rt = await runtime()
      if (!rt.found || !rt.path) throw new Error('No llama.cpp runtime is installed.')
      let run: Running
      let note: string | undefined
      try {
        run = await launch(rt.path, e.id, true)
      } catch (err) {
        // GPU init can fail on odd drivers or run out of VRAM: try once more on the CPU and say so.
        const msg = (err as Error).message
        if ((err as { noRetry?: boolean }).noRetry) throw err
        run = await launch(rt.path, e.id, false)
        note = `GPU start failed (${msg}); running on the CPU.`
      }
      if (note) run.info.note = note
      servers.set(e.id, run)
      await probeRoute(run).catch((err) => { servers.delete(e.id); throw err })
      run.lastUsed = Date.now()
      return run.info
    })().finally(() => starting.delete(e.id))
    starting.set(e.id, p)
    return p
  }

  async function stop(catalogId: string): Promise<void> {
    const r = servers.get(catalogId)
    servers.delete(catalogId)
    if (r) kill(r.child)
  }

  function stopAll(): void {
    for (const id of [...servers.keys()]) void stop(id)
  }

  const idleTimer = setInterval(() => {
    for (const [id, r] of servers) if (Date.now() - r.lastUsed > IDLE_STOP_MS) void stop(id)
  }, 30_000)
  idleTimer.unref()
  process.once('exit', () => servers.forEach((r) => r.child.exitCode === null && r.child.kill('SIGKILL')))

  /** For `llm:call`: lazily start the model and hand out its origin and per-session API key. */
  async function endpoint(catalogId: string): Promise<{ baseUrl: string; apiKey: string }> {
    const info = await start(catalogId)
    const r = servers.get(catalogId)!
    r.lastUsed = Date.now()
    return { baseUrl: info.baseUrl, apiKey: r.apiKey }
  }

  return {
    probe: () => probeHardware(deps.dataDir()),
    runtime, runtimePlan, runtimeInstall,
    modelPlan, modelInstall,
    cancel: async (id: string) => { aborts.get(id)?.abort() },
    installed, remove, start, stop, stopAll, endpoint,
    status: async (): Promise<LocalServerStatus[]> => [
      ...[...servers].map(([id, r]): LocalServerStatus => ({ catalogId: id, state: 'running', info: r.info })),
      ...[...starting.keys()].filter((id) => !servers.has(id)).map((id): LocalServerStatus => ({ catalogId: id, state: 'starting' })),
    ],
    logs: async (id: string) => (logs.get(id) ?? new RingLog()).all(),
  }
}

export type LocalRuntime = ReturnType<typeof createLocalRuntime>
