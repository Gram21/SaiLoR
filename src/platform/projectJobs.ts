import { loadProject, splitProjectFiles, type Paper, type Project } from '../model/project'
import { assembler } from './assemble'

type Assemble = NonNullable<ReturnType<typeof assembler>>
const sessions = new Map<number, { assemble: Assemble; ids: string[] }>()

type Files = { relPath: string; text: string }[]

/** The CPU-heavy steps of opening a project. They run in a worker, or inline where there is none. */
export type Job =
  | { kind: 'open'; session: number; text: string; siblings?: { name: string; text: string }[] }
  | { kind: 'read'; session: number; files: Files; ids?: string[] }
  | { kind: 'head'; text: string }
  | { kind: 'parse'; text: string }

export interface Results {
  open: { legacy: boolean; text: string; corrupt: string[]; ids: string[] }
  read: { text: string; corrupt: string[] }
  head: { project: Project; meta: string } | null
  parse: { papers: Paper[]; files: { relPath: string; text: string | null }[] }
}

// [impl->req~plt-459~1]
export function runJob<K extends Job['kind']>(job: Extract<Job, { kind: K }>): Results[K]
export function runJob(job: Job): Results[Job['kind']] {
  switch (job.kind) {
    case 'open': {
      const corrupt: string[] = []
      const assemble = assembler({ text: job.text, siblings: job.siblings }, corrupt)
      if (!assemble) return { legacy: true, text: job.text, corrupt, ids: [] }
      const raw = JSON.parse(job.text) as { papers: { id?: unknown }[] }
      const ids = raw.papers.flatMap((x) => (typeof x?.id === 'string' ? [x.id] : []))
      for (const old of sessions.keys()) if (old < job.session - 2) sessions.delete(old)
      sessions.set(job.session, { assemble, ids })
      return { legacy: false, text: assemble([], []), corrupt, ids }
    }
    case 'read': {
      const s = sessions.get(job.session)
      if (!s) throw new Error('The project is no longer open.')
      const corrupt: string[] = []
      return { text: s.assemble(job.files, corrupt, job.ids && new Set(job.ids)), corrupt }
    }
    case 'head':
      try {
        const project = loadProject(job.text)
        return { project, meta: JSON.stringify(splitProjectFiles(project).meta, null, 2) }
      } catch {
        return null
      }
    case 'parse': {
      const project = loadProject(job.text)
      return { papers: project.papers, files: splitProjectFiles(project).files.map(({ relPath, text }) => ({ relPath, text })) }
    }
  }
}
