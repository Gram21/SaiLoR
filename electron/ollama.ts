import { isIP } from 'node:net'
import type { IpcMain } from 'electron'
import {
  capabilitiesOf,
  contextOf,
  drainNdjson,
  estimateKvBytes,
  isValidModelTag,
  manifestUrl,
  parseLlamaCppProps,
  parseLmStudioModels,
  parseOpenAiModelsMeta,
  parsePs,
  parsePullLine,
  parseTags,
  sumManifestBytes,
  thinkingOf,
  type LocalServerInfo,
  type LocalServerModel,
} from '../src/llm/ollama'
import { isBlockedAddress, isBlockedHostname } from './webFetch'

/**
 * Control and discovery of a user-run local LLM server (Ollama first). The
 * renderer names the server URL, so it is validated here: http(s) only, no
 * credentials, reduced to its origin. No API key is ever attached — a server
 * that needs one is not supported by these calls (ponytail: add a bearer from
 * the stored config if keyed Ollama proxies matter; chat calls via llm:call do
 * support keys).
 */

export interface OllamaDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  send: (channel: string, payload: unknown) => void
}

const REQUEST_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 3_000
/** A pull that delivers nothing for this long is considered dead. */
const PULL_IDLE_MS = 2 * 60_000

export type BaseUrlCheck = { ok: true; origin: string; isLocal: boolean } | { ok: false; error: string }

/** Validate a renderer-supplied server URL; `isLocal` is true for loopback/private hosts. */
export function checkBaseUrl(raw: unknown): BaseUrlCheck {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    return { ok: false, error: 'Invalid server URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme "${url.protocol}".` }
  }
  if (url.username || url.password) return { ok: false, error: 'URLs with embedded credentials are not allowed.' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const isLocal = isIP(host) ? isBlockedAddress(host) : isBlockedHostname(host)
  // ponytail: the path is dropped, so a server behind a path-prefixed reverse proxy is unreachable here.
  return { ok: true, origin: url.origin, isLocal }
}

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

function describeError(e: unknown, origin: string): string {
  if (e instanceof Error && e.name === 'AbortError') return `Timed out waiting for ${origin}.`
  return `Can't reach ${origin}. Is the server running?`
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { error?: unknown }
    if (typeof j.error === 'string' && j.error) return `${j.error} (HTTP ${res.status})`
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
}

export function registerOllamaHandlers(ipcMain: Pick<IpcMain, 'handle' | 'on'>, deps: OllamaDeps): void {
  const pulls = new Map<string, AbortController>()

  /** One JSON request with a timeout. Redirects are refused: a local API has no reason to redirect. */
  async function request(
    origin: string,
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ ok: true; json: unknown } | Fail> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
    try {
      const res = await deps.fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!res.ok) return fail(await readError(res))
      const text = await res.text()
      // DELETE and some errors answer with an empty body.
      return { ok: true, json: text ? (JSON.parse(text) as unknown) : null }
    } catch (e) {
      return fail(describeError(e, origin))
    } finally {
      clearTimeout(timer)
    }
  }

  /** Check the URL (and optionally a model tag), then run `fn` against the origin. */
  async function withServer<T>(
    baseUrl: unknown,
    model: unknown,
    fn: (origin: string, isLocal: boolean) => Promise<T | Fail>,
  ): Promise<T | Fail> {
    const base = checkBaseUrl(baseUrl)
    if (!base.ok) return base
    if (model !== undefined && !isValidModelTag(model)) return fail('Invalid model name.')
    return fn(base.origin, base.isLocal)
  }

  ipcMain.handle('ollama:version', (_e, baseUrl: string) =>
    withServer(baseUrl, undefined, async (origin, isLocal) => {
      const r = await request(origin, '/api/version')
      if (!r.ok) return r
      const version = (r.json as { version?: unknown } | null)?.version
      return typeof version === 'string' ? { ok: true as const, version, isLocal } : fail('Not an Ollama server.')
    }),
  )

  ipcMain.handle('ollama:list', (_e, baseUrl: string) =>
    withServer(baseUrl, undefined, async (origin, isLocal) => {
      const r = await request(origin, '/api/tags')
      return r.ok ? { ok: true as const, models: parseTags(r.json), isLocal } : r
    }),
  )

  ipcMain.handle('ollama:show', (_e, baseUrl: string, model: string, numCtx?: number) =>
    withServer(baseUrl, model, async (origin) => {
      const r = await request(origin, '/api/show', { method: 'POST', body: { model } })
      if (!r.ok) return r
      const modelInfo = (r.json as { model_info?: unknown } | null)?.model_info
      const ctx = Number.isInteger(numCtx) && (numCtx as number) > 0 ? (numCtx as number) : undefined
      return {
        ok: true as const,
        info: {
          capabilities: capabilitiesOf(r.json),
          contextTokens: contextOf(r.json),
          thinking: thinkingOf(r.json),
          kvBytes: ctx ? estimateKvBytes(modelInfo, ctx) : null,
        },
      }
    }),
  )

  ipcMain.handle('ollama:ps', (_e, baseUrl: string) =>
    withServer(baseUrl, undefined, async (origin) => {
      const r = await request(origin, '/api/ps')
      return r.ok ? { ok: true as const, running: parsePs(r.json) } : r
    }),
  )

  ipcMain.handle('ollama:delete', (_e, baseUrl: string, model: string) =>
    withServer(baseUrl, model, async (origin) => {
      const r = await request(origin, '/api/delete', { method: 'DELETE', body: { model } })
      return r.ok ? { ok: true as const } : r
    }),
  )

  ipcMain.handle('ollama:manifestSize', async (_e, model: string) => {
    const url = manifestUrl(model)
    if (!url) return fail('Invalid model name.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await deps.fetch(url, {
        headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' },
        signal: controller.signal,
      })
      if (res.status === 404) return { ok: true as const, bytes: null }
      if (!res.ok) return fail(await readError(res))
      return { ok: true as const, bytes: sumManifestBytes(await res.json()) }
    } catch (e) {
      return fail(describeError(e, 'registry.ollama.ai'))
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('ollama:pull', (_e, requestId: string, baseUrl: string, model: string) =>
    withServer(baseUrl, model, async (origin) => {
      if (typeof requestId !== 'string' || !requestId) return fail('Missing request id.')
      const controller = new AbortController()
      pulls.set(requestId, controller)
      let idle: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(idle)
        idle = setTimeout(() => controller.abort(), PULL_IDLE_MS)
      }
      try {
        arm()
        const res = await deps.fetch(`${origin}/api/pull`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: true }),
          signal: controller.signal,
          redirect: 'error',
        })
        if (!res.ok || !res.body) return fail(await readError(res))
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let succeeded = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          arm()
          const drained = drainNdjson(buffer + decoder.decode(value, { stream: true }))
          buffer = drained.rest
          for (const line of drained.lines) {
            const p = parsePullLine(line)
            if (!p) continue
            if (p.error) return fail(p.error)
            if (p.status === 'success') succeeded = true
            deps.send('ollama:pullProgress', { requestId, ...p })
          }
        }
        return succeeded ? { ok: true as const } : fail('The download ended before it finished. Pull again to resume.')
      } catch (e) {
        return fail(controller.signal.aborted ? 'Download stopped.' : describeError(e, origin))
      } finally {
        clearTimeout(idle)
        pulls.delete(requestId)
      }
    }),
  )

  // Closes the connection; the server may keep downloading (no cancel API), and pulling again resumes.
  ipcMain.on('ollama:cancelPull', (_e, requestId: string) => {
    pulls.get(requestId)?.abort()
  })

  ipcMain.handle('localserver:discover', (_e, baseUrl: string) =>
    withServer(baseUrl, undefined, async (origin, isLocal) => {
      const probe = async (path: string): Promise<unknown> => {
        const r = await request(origin, path, { timeoutMs: PROBE_TIMEOUT_MS })
        return r.ok ? r.json : null
      }
      const found = (kind: LocalServerInfo['kind'], models: LocalServerModel[]) =>
        ({ ok: true as const, kind, models, isLocal })

      const version = (await probe('/api/version')) as { version?: unknown } | null
      if (typeof version?.version === 'string') {
        const running = parsePs(await probe('/api/ps'))
        const models = parseTags(await probe('/api/tags')).map((m): LocalServerModel => {
          const live = running.find((r) => r.name === m.name)
          return { id: m.name, sizeBytes: m.sizeBytes, loaded: Boolean(live), contextTokens: live?.contextLength }
        })
        return found('ollama', models)
      }

      const lm = parseLmStudioModels(await probe('/api/v1/models'))
      if (lm.length) return found('lmstudio', lm)

      const nCtx = parseLlamaCppProps(await probe('/props'))
      const openai = parseOpenAiModelsMeta(await probe('/v1/models'))
      if (nCtx !== null) {
        // /props states the window actually served; /v1/models only the training maximum.
        return found('llamacpp', openai.models.map((m) => ({ ...m, contextTokens: nCtx, loaded: true })))
      }
      if (openai.vllm) return found('vllm', openai.models)
      if (openai.models.length) return found('unknown', openai.models)
      return fail(`No local LLM server answered at ${origin}.`)
    }),
  )
}
