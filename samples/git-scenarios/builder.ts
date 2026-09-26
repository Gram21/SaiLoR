import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { loadProject, projectFromFiles, splitProjectFiles, type Project } from '../../src/model/project'
import { annotationsDirOf } from '../../src/model/annotationsDir'

/**
 * Builds a git scenario — a bare `origin` and one clone per person — from a
 * scenario definition, deterministically: fixed names, e-mail addresses and
 * commit dates, `main` as the branch, and none of the machine's own git
 * configuration, so a scenario gives the same repositories (and commit hashes)
 * everywhere.
 */

export interface Person {
  /** Folder name of this person's clone. */
  id: string
  name: string
  email: string
}

export const ANNA: Person = { id: 'anna', name: 'Anna Example', email: 'anna@example.org' }
export const BEN: Person = { id: 'ben', name: 'Ben Example', email: 'ben@example.org' }

export interface Scenario {
  name: string
  /** One line: what the scenario sets up. */
  summary: string
  /** The project file to open, relative to the scenario folder. */
  open: string
  /** What to do and what you should see, one step per entry. */
  check: string[]
  build(stage: Stage): void
  /** Automated assertions on the built scenario, run by the integration test. */
  verify(stage: Stage): void | Promise<void>
}

/** Start of the fixed clock every commit's date is taken from. */
const EPOCH = Date.parse('2026-01-05T09:00:00Z')

export class Stage {
  readonly dir: string
  private tick = 0
  /** An empty file standing in for the user's global git configuration. */
  private readonly globalConfig: string

  constructor(dir: string) {
    this.dir = resolve(dir)
    mkdirSync(this.dir, { recursive: true })
    this.globalConfig = join(this.dir, '.gitconfig-empty')
    writeFileSync(this.globalConfig, '')
    this.run(this.dir, ['init', '--bare', '--initial-branch=main', 'origin.git'])
  }

  /** Where `who`'s clone is. */
  path(who: Person, ...rel: string[]): string {
    return join(this.dir, who.id, ...rel)
  }

  private env(who?: Person): NodeJS.ProcessEnv {
    const date = new Date(EPOCH + this.tick * 3_600_000).toISOString()
    return {
      PATH: process.env.PATH,
      HOME: this.dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      ...(who
        ? {
            GIT_AUTHOR_NAME: who.name,
            GIT_AUTHOR_EMAIL: who.email,
            GIT_COMMITTER_NAME: who.name,
            GIT_COMMITTER_EMAIL: who.email,
          }
        : {}),
    }
  }

  private run(cwd: string, args: string[], who?: Person): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: this.env(who),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  /** Run git in `who`'s clone; returns stdout. */
  git(who: Person, ...args: string[]): string {
    return this.run(this.path(who), args, who)
  }

  /** Clone `origin` for `who`, with their identity in the clone's own config
   *  so SaiLoR, opened on it later, commits as them. */
  clone(who: Person): void {
    this.run(this.dir, ['clone', '-q', 'origin.git', who.id], who)
    this.git(who, 'config', 'user.name', who.name)
    this.git(who, 'config', 'user.email', who.email)
  }

  write(who: Person, rel: string, content: string | object): void {
    const file = this.path(who, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }

  read(who: Person, rel: string): string {
    return readFileSync(this.path(who, rel), 'utf8')
  }

  remove(who: Person, rel: string): void {
    rmSync(this.path(who, rel), { recursive: true, force: true })
  }

  /**
   * Write a project the way SaiLoR saves it — `rel` plus its annotations
   * folder, one file per paper and seat — from the whole-project shape
   * `loadProject` reads. Files the project no longer needs are removed.
   */
  writeProject(who: Person, rel: string, whole: object): void {
    const { meta, files } = splitProjectFiles(loadProject(whole))
    this.write(who, rel, meta as object)
    const folder = join(dirname(rel), annotationsDirOf(meta))
    for (const f of files) {
      if (f.text === null) this.remove(who, join(folder, f.relPath))
      else this.write(who, join(folder, f.relPath), f.text)
    }
  }

  /** The project `rel` in `who`'s working tree, as SaiLoR would read it. */
  project(who: Person, rel: string): Project {
    return this.projectAt(who, rel, null)
  }

  /** The project `rel` at revision `rev` of `who`'s clone (`null`: the working tree). */
  projectAt(who: Person, rel: string, rev: string | null): Project {
    const metaText = rev ? this.git(who, 'show', `${rev}:${rel}`) : this.read(who, rel)
    const meta: unknown = JSON.parse(metaText)
    const folder = join(dirname(rel), annotationsDirOf(meta)).replace(/\\/g, '/')
    const listed = rev
      ? this.git(who, 'ls-tree', '-r', '--name-only', rev, '--', folder).split('\n').filter(Boolean)
      : this.git(who, 'ls-files', '--cached', '--others', '--exclude-standard', '--', folder).split('\n').filter(Boolean)
    const files: [string, string][] = listed
      .filter((p) => p.endsWith('.json'))
      .map((p) => [p.slice(folder.length + 1), rev ? this.git(who, 'show', `${rev}:${p}`) : this.read(who, p)])
    return projectFromFiles(meta, files)
  }

  /** Stage everything and commit as `who`, one hour after the previous commit. */
  commit(who: Person, message: string): void {
    this.tick++
    this.git(who, 'add', '-A')
    this.git(who, 'commit', '-q', '-m', message)
  }

  push(who: Person): void {
    this.git(who, 'push', '-q', 'origin', 'HEAD:main')
  }

  /** Bring `who` up to date; only ever a fast-forward, like a clean pull. */
  pull(who: Person): void {
    this.git(who, 'fetch', '-q', 'origin')
    this.git(who, 'merge', '-q', '--ff-only', 'origin/main')
  }

  /** A script in the scenario folder the reviewer runs by hand at the right moment. */
  script(name: string, lines: string[]): string {
    const file = join(this.dir, name)
    writeFileSync(file, ['#!/bin/sh', 'set -e', `cd "$(dirname "$0")"`, ...lines, ''].join('\n'), { mode: 0o755 })
    return file
  }
}

/**
 * Build `scenario` into `out`, or a new temporary folder. Refuses a folder
 * inside a git working tree — a scenario brings its own `.git` folders, which
 * must never end up committed into SaiLoR's repository — and one that is not
 * empty.
 */
export function buildScenario(scenario: Scenario, out?: string): Stage {
  const dir = out ? resolve(out) : mkdtempSync(join(tmpdir(), `sailor-scenario-${scenario.name}-`))
  if (out) {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`"${dir}" is not empty. Choose an empty or new folder.`)
    }
    let inside = ''
    try {
      inside = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: existsSync(dir) ? dir : dirname(dir),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      // not inside a repository: good
    }
    if (inside) {
      throw new Error(
        `"${dir}" is inside the git repository "${relative(process.cwd(), inside) || inside}". ` +
          'Build scenarios outside any repository (the default is a temporary folder).',
      )
    }
  }
  const stage = new Stage(dir)
  scenario.build(stage)
  return stage
}
