import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mergeProjects, type MergeOutcome } from '../../src/git/merge'
import { applyManagedBlock, ATTRIBUTES_BODY, IGNORE_BODY } from '../../src/git/repoSetup'
import { ANNA, BEN, type Person, type Stage } from './builder'

/**
 * The review every scenario starts from: two reviewers, four papers, a schema
 * with a fixed-choice field, a number and a repeated group — enough for every
 * kind of merge SaiLoR has to make.
 */

export const PROJECT = 'review.json'

export const PAPERS = ['smith2021', 'lee2022', 'garcia2023', 'chen2024'] as const
export type PaperId = (typeof PAPERS)[number]

const TITLES: Record<PaperId, string> = {
  smith2021: 'Searching code with natural language',
  lee2022: 'Repairing programs from failing tests',
  garcia2023: 'A study of code review at scale',
  chen2024: 'Large language models for bug localisation',
}
const AUTHORS: Record<PaperId, string> = {
  smith2021: 'Smith, J.',
  lee2022: 'Lee, K.',
  garcia2023: 'Garcia, M.',
  chen2024: 'Chen, L.',
}

export const SCHEMA = [
  { name: 'Design', type: 'string', options: ['RCT', 'Cohort', 'Case study'] },
  { name: 'Sample size', type: 'number' },
  { name: 'Findings', min: 0, max: null, children: [{ name: 'Claim', type: 'string' }] },
]

/** The schema version the base project starts at. */
export const V0 = 'v0-base'

type Tree = Record<string, unknown>
export interface PaperAnswers {
  r1?: Tree
  r2?: Tree
  consolidated?: Tree
}

/** An answer tree from `{ field: value }` pairs. */
export function answers(values: Record<string, string | number>): Tree {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [{ value: v }]]))
}

export interface ReviewOptions {
  answers?: Partial<Record<PaperId, PaperAnswers>>
  schema?: object[]
  reviewers?: number
  protocol?: object
  schemaVersion?: string
  schemaHistory?: object[]
  annotationsDir?: string
  title?: string
}

/** The whole-project shape `loadProject` reads, for `Stage.writeProject`. */
export function review(opts: ReviewOptions = {}): object {
  return {
    version: 1,
    title: opts.title ?? 'Example review for git scenarios',
    ...(opts.annotationsDir ? { annotationsDir: opts.annotationsDir } : {}),
    schemaVersion: opts.schemaVersion ?? V0,
    schemaHistory: opts.schemaHistory ?? [{ id: V0, parents: [], at: '2026-01-05T09:00:00.000Z', moves: [] }],
    ...(opts.protocol ? { protocol: opts.protocol } : {}),
    config: { reviewers: opts.reviewers ?? 2, schema: opts.schema ?? SCHEMA },
    papers: PAPERS.map((id) => {
      const a = opts.answers?.[id] ?? {}
      return {
        id,
        title: TITLES[id],
        authors: [AUTHORS[id]],
        pdf: `pdfs/${id}.pdf`,
        annotations: a.consolidated ?? {},
        reviews: { 1: a.r1 ?? {}, 2: a.r2 ?? {} },
      }
    }),
  }
}

/** A history entry after `parent`, with the renames and moves it made. */
export function version(id: string, parents: string[], moves: { from: string[]; to: string[] }[] = []): object {
  return { id, parents, at: '2026-01-06T09:00:00.000Z', moves }
}

// Resolved from the repository root: `npm run scenario` and the test suites run there.
const SAMPLE_PDF = resolve('samples/pdfs/paper-a.pdf')

export interface StartOptions {
  /** Leave out SaiLoR's `.gitattributes`/`.gitignore` rules. */
  noRepoSetup?: boolean
  /** Content of a `.gitattributes` of the team's own, instead of SaiLoR's. */
  ownAttributes?: string
  base?: ReviewOptions
}

/**
 * Anna sets the review up and pushes it; Ben clones it. The repository
 * already has SaiLoR's git rules, so opening a clone asks nothing unless the
 * scenario is about exactly that.
 */
export function start(stage: Stage, opts: StartOptions = {}): void {
  stage.clone(ANNA)
  stage.writeProject(ANNA, PROJECT, review(opts.base))
  const pdf = stage.path(ANNA, 'pdfs/smith2021.pdf')
  mkdirSync(dirname(pdf), { recursive: true })
  if (existsSync(SAMPLE_PDF)) copyFileSync(SAMPLE_PDF, pdf)
  if (opts.ownAttributes !== undefined) stage.write(ANNA, '.gitattributes', opts.ownAttributes)
  else if (!opts.noRepoSetup) {
    stage.write(ANNA, '.gitattributes', applyManagedBlock(null, ATTRIBUTES_BODY).text)
    stage.write(ANNA, '.gitignore', applyManagedBlock(null, IGNORE_BODY).text)
  }
  stage.commit(ANNA, 'Set up the review')
  stage.push(ANNA)
  stage.clone(BEN)
}

/**
 * What Pull would do for `who`: SaiLoR's field-level merge of the merge base,
 * `who`'s HEAD and `origin/main`, exactly as the app runs it.
 */
export function pullOutcome(stage: Stage, who: Person): MergeOutcome {
  stage.git(who, 'fetch', '-q', 'origin')
  const base = stage.git(who, 'merge-base', 'HEAD', 'origin/main').trim()
  return mergeProjects(
    stage.projectAt(who, PROJECT, base),
    stage.projectAt(who, PROJECT, 'HEAD'),
    stage.projectAt(who, PROJECT, 'origin/main'),
  )
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Scenario check failed: ${message}`)
}
