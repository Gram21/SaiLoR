import { runJob, type Job, type Results } from './projectJobs'

let worker: Worker | undefined
let next = 0
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()

function start(): Worker {
  const w = new Worker(new URL('./projectJobs.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: never; error?: string }>) => {
    const p = pending.get(e.data.id)
    pending.delete(e.data.id)
    if (e.data.ok) p?.resolve(e.data.value as never)
    else p?.reject(new Error(e.data.error))
  }
  w.onerror = () => {
    for (const p of pending.values()) p.reject(new Error('The loading worker failed.'))
    pending.clear()
    worker = undefined
  }
  return w
}

// [impl->req~plt-459~1]
/** Runs a loading step off the main thread, so a big project does not freeze the UI. Without Worker support it runs inline. */
export function offMain<K extends Job['kind']>(job: Extract<Job, { kind: K }>): Promise<Results[K]> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => runJob(job))
  worker ??= start()
  const id = next++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject })
    worker!.postMessage({ id, job })
  })
}
