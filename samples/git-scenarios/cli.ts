import { join, resolve } from 'node:path'
import { buildScenario } from './builder'
import { SCENARIOS, scenarioNamed, scenariosMarkdown } from './scenarios'

/**
 * `npm run scenario -- list`
 * `npm run scenario -- <name> [--out <folder>]`
 * `npm run scenario -- all --out <folder>`
 * `npm run scenario -- readme` (the scenario list for README.md)
 */
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args[outAt + 1] : undefined
const name = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))

if (name === 'readme') {
  process.stdout.write(scenariosMarkdown())
  process.exit(0)
}

if (!name || name === 'list') {
  for (const s of SCENARIOS) console.log(`${s.name.padEnd(22)} ${s.summary}`)
  process.exit(name ? 0 : 1)
}

const chosen = name === 'all' ? SCENARIOS : [scenarioNamed(name)]
if (chosen.some((s) => !s)) {
  console.error(`No scenario named "${name}". Run \`npm run scenario -- list\`.`)
  process.exit(1)
}
if (name === 'all' && !out) {
  console.error('Building every scenario needs --out <folder>.')
  process.exit(1)
}

for (const s of chosen) {
  const stage = buildScenario(s!, name === 'all' ? join(resolve(out!), s!.name) : out)
  console.log(`\n${s!.name}: ${s!.summary}`)
  console.log(`  Open: ${join(stage.dir, s!.open)}`)
  for (const step of s!.check) console.log(`  - ${step}`)
}
