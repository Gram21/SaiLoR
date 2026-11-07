import { runJob, type Job } from './projectJobs'

self.onmessage = (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data
  try {
    self.postMessage({ id, ok: true, value: runJob(job) })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
