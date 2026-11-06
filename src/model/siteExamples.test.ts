import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from './project'

const page = readFileSync(join(process.cwd(), 'site', 'create-project.html'), 'utf8')

const examples = [...page.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((match) =>
  match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&'),
)

// [utest->req~plt-444~1]
describe('project examples in the project site walkthrough', () => {
  it('contains the minimal and the extended example', () => {
    expect(examples).toHaveLength(2)
  })

  it('the minimal example loads as a SaiLoR project', () => {
    expect(() => loadProject(examples[0])).not.toThrow()
  })

  it('the extended example loads as a SaiLoR project', () => {
    expect(() => loadProject(examples[1])).not.toThrow()
  })
})
