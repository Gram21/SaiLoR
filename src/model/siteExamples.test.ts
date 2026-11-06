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

describe('project examples in the project site walkthrough', () => {
  it('contains the minimal and the extended example', () => {
    expect(examples).toHaveLength(2)
  })

  it.each([0, 1])('example %i loads as a SaiLoR project', (index) => {
    expect(() => loadProject(examples[index])).not.toThrow()
  })
})
