import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { buildScenario, ANNA, type Stage } from '../../../samples/git-scenarios/builder'
import { SCENARIOS, scenariosMarkdown } from '../../../samples/git-scenarios/scenarios'

/**
 * Every scenario in `samples/git-scenarios/` builds, and sets up what its
 * README entry says — so a scenario someone opens by hand is known to show
 * what it claims, and a change to SaiLoR that breaks one fails here.
 */
const built: Stage[] = []
afterAll(() => {
  for (const s of built) rmSync(s.dir, { recursive: true, force: true })
})

describe('git scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s builds and holds what it promises', async (_name, scenario) => {
    const stage = buildScenario(scenario)
    built.push(stage)
    await scenario.verify(stage)
  })

  it('builds the same repositories every time', () => {
    const scenario = SCENARIOS.find((s) => s.name === 'disjoint-reviewers')!
    const [a, b] = [buildScenario(scenario), buildScenario(scenario)]
    built.push(a, b)
    expect(a.git(ANNA, 'rev-parse', 'HEAD')).toBe(b.git(ANNA, 'rev-parse', 'HEAD'))
  })

  it("lists every scenario in the README exactly as `npm run scenario -- readme` prints them", () => {
    const readme = readFileSync('samples/git-scenarios/README.md', 'utf8')
    const block = readme.slice(readme.indexOf('<!-- scenarios:begin -->\n') + 25, readme.indexOf('\n<!-- scenarios:end -->'))
    expect(block).toBe(scenariosMarkdown().replace(/\n+$/, ''))
  })

  it('refuses to build inside a git working tree', () => {
    expect(() => buildScenario(SCENARIOS[0], `${process.cwd()}/samples/git-scenarios/out`)).toThrow(/inside the git repository/)
  })
})
