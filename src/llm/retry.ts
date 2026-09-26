import type { LlmHttpRequest, LlmHttpResponse } from './types'

/**
 * Retry-with-backoff for the rate-limit/overload responses every provider can
 * return under load: 429 (rate limited), 408 (request timeout), and the
 * transient 5xx family (500/502/503/504), plus Anthropic's 529 ("overloaded").
 * Anything else — including every other 4xx — is the caller's problem, not a
 * retry candidate: retrying a 400/401/403/404 just repeats the same failure.
 */

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529])

export function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(abortError())
      },
      { once: true },
    )
  })
}

/**
 * Parse a `Retry-After` header value: either delta-seconds or an HTTP-date
 * (RFC 9110 §10.2.3). Returns milliseconds from `now`, or undefined when the
 * header is absent or unparseable — the caller then falls back to its own
 * backoff schedule. Pure so both the Electron main process (filling
 * `LlmHttpResponse.retryAfterMs`) and this module's own tests can use it
 * without a real clock.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

export interface RetryOptions {
  /** Retries after the first attempt, so `maxRetries: 4` means up to 5 calls total. */
  maxRetries?: number
  baseDelayMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The shape every `callLlm` this app passes around has. */
export type CallLlm = (req: LlmHttpRequest, signal?: AbortSignal) => Promise<LlmHttpResponse>

const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

/** Exponential backoff with full jitter, capped at `MAX_DELAY_MS`. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const cap = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** attempt)
  return Math.random() * cap
}

/**
 * Wraps an `callLlm`-shaped function so HTTP 429/408/5xx/529 responses are
 * retried with backoff instead of surfacing straight to the caller. Honors
 * `retryAfterMs` when the response carries one (see `LlmHttpResponse`).
 * Abort-aware: a sleep in progress rejects immediately on `signal` abort.
 */
export function withRetry(callLlm: CallLlm, opts: RetryOptions = {}): CallLlm {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const sleep = opts.sleep ?? defaultSleep

  return async (req: LlmHttpRequest, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError()
      const res = await callLlm(req, signal)
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) return res
      const delay = res.retryAfterMs ?? backoffDelay(attempt, baseDelayMs)
      await sleep(Math.min(delay, MAX_DELAY_MS), signal)
    }
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once,
 * returning results in input order (like `Promise.allSettled`). Once
 * `signal` aborts, no new item is started, but items already in flight are
 * left to finish (or reject) on their own.
 *
 * ponytail: a simple index cursor shared across `concurrency` loops, not a
 * queue/worker-pool library — this only ever needs "N at a time, in order",
 * add real scheduling if a caller needs pause/resume or priorities.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0

  async function runOne(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne())
  await Promise.all(workers)
  // An item never started (abort came before its turn) still needs a slot.
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) results[i] = { status: 'rejected', reason: abortError() }
  }
  return results
}
