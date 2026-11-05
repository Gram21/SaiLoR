// [utest->req~plt-430~1]
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const workflow = read('.github/workflows/ci.yml')
const makefile = read('Makefile')

describe('CI scripts', () => {
  it('every workflow job step that builds or tests calls a script that exists', () => {
    const calls = [...workflow.matchAll(/run: (?:\.\/)?(scripts\/[\w./-]+)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const call of calls) expect(existsSync(call), call).toBe(true)
  })

  it('every Makefile ci target runs a script that exists', () => {
    const calls = [...makefile.matchAll(/^ci[\w-]*:.*\n\t(scripts\/[\w./-]+)/gm)].map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const call of calls) expect(existsSync(call), call).toBe(true)
  })

  it('every CI script stops on the first error and works from the repository root', () => {
    for (const path of ['scripts/ci.sh', 'scripts/ci/rust.sh', 'scripts/ci/trace.sh', 'scripts/ci/bundle.sh', 'scripts/ci/e2e.sh']) {
      const text = read(path)
      expect(text, path).toMatch(/^set -euo pipefail$/m)
      expect(text, path).toMatch(/cd "\$\(dirname "\$0"\)/)
    }
  })
})
