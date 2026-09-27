import { describe, it, expect, vi } from 'vitest'
import { withRetry, runPool, parseRetryAfter } from './retry'
import type { LlmHttpRequest, LlmHttpResponse } from './types'

const req: LlmHttpRequest = { configId: 'c1', url: 'https://x', headers: {} }

function fakeSleep() {
  const calls: number[] = []
  const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    calls.push(ms)
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
  })
  return { sleep, calls }
}

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000)
  })

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2024-01-01T00:00:00Z')
    expect(parseRetryAfter('Mon, 01 Jan 2024 00:00:05 GMT', now)).toBe(5000)
  })

  it('is undefined for absent or unparseable headers', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('not-a-date', 0)).toBeUndefined()
  })
})

describe('withRetry', () => {
  it('retries retryable statuses and returns the eventual success', async () => {
    const { sleep } = fakeSleep()
    let calls = 0
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => {
      calls++
      if (calls < 3) return { ok: false, status: 429, body: '' }
      return { ok: true, status: 200, body: 'done' }
    })
    const wrapped = withRetry(callLlm, { sleep, maxRetries: 4, baseDelayMs: 10 })
    const res = await wrapped(req)
    expect(res.body).toBe('done')
    expect(callLlm).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('honors retryAfterMs instead of computing its own backoff', async () => {
    const { sleep, calls } = fakeSleep()
    let n = 0
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => {
      n++
      if (n === 1) return { ok: false, status: 429, body: '', retryAfterMs: 5000 }
      return { ok: true, status: 200, body: '' }
    })
    await withRetry(callLlm, { sleep, baseDelayMs: 10 })(req)
    expect(calls).toEqual([5000])
  })

  it('never retries a non-retryable 4xx', async () => {
    const { sleep } = fakeSleep()
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => ({ ok: false, status: 401, body: '' }))
    const res = await withRetry(callLlm, { sleep })(req)
    expect(res.status).toBe(401)
    expect(callLlm).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after maxRetries and returns the last failure', async () => {
    const { sleep } = fakeSleep()
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => ({ ok: false, status: 503, body: '' }))
    const res = await withRetry(callLlm, { sleep, maxRetries: 2, baseDelayMs: 10 })(req)
    expect(res.status).toBe(503)
    expect(callLlm).toHaveBeenCalledTimes(3)
  })

  it('calls onRetry with the attempt, delay, and status before each retry sleep', async () => {
    const { sleep } = fakeSleep()
    let calls = 0
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => {
      calls++
      if (calls < 3) return { ok: false, status: 429, body: '', retryAfterMs: 7 }
      return { ok: true, status: 200, body: '' }
    })
    const onRetry = vi.fn()
    await withRetry(callLlm, { sleep, baseDelayMs: 10, onRetry })(req)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 0, delayMs: 7, status: 429 })
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 1, delayMs: 7, status: 429 })
  })

  it('rejects with an AbortError when the signal aborts mid-sleep', async () => {
    const { sleep } = fakeSleep()
    const controller = new AbortController()
    const callLlm = vi.fn(async (): Promise<LlmHttpResponse> => ({ ok: false, status: 429, body: '' }))
    controller.abort()
    await expect(withRetry(callLlm, { sleep })(req, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('runPool', () => {
  it('runs with bounded concurrency and returns results in input order', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const worker = async (item: number) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return item * 2
    }
    const results = await runPool([1, 2, 3, 4, 5], 2, worker)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([2, 4, 6, 8, 10])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('captures a rejected worker without failing the batch', async () => {
    const results = await runPool([1, 2], 2, async (item) => {
      if (item === 1) throw new Error('boom')
      return item
    })
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 2 })
  })

  it('stops starting new items once aborted', async () => {
    const controller = new AbortController()
    let started = 0
    const worker = async (item: number) => {
      started++
      if (item === 1) controller.abort()
      await new Promise((r) => setTimeout(r, 5))
      return item
    }
    const results = await runPool([1, 2, 3, 4], 1, worker, controller.signal)
    expect(started).toBe(1)
    expect(results).toHaveLength(4)
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 1 })
    expect(results[1]).toMatchObject({ status: 'rejected' })
  })
})
