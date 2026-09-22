import { describe, it, expect } from 'vitest'
import { applyManagedBlock, planRepoSetup, ATTRIBUTES_BODY, IGNORE_BODY } from './repoSetup'

const BEGIN = '# >>> SaiLoR (managed) >>>'
const END = '# <<< SaiLoR (managed) <<<'

describe('applyManagedBlock', () => {
  it('writes the block on its own when there is no file yet', () => {
    const r = applyManagedBlock(null, 'rule')
    expect(r.text).toBe(`${BEGIN}\nrule\n${END}\n`)
    expect(r.changed).toBe(true)
    expect(r.hadExisting).toBe(false)
  })

  it("keeps the user's own rules and appends below them", () => {
    // Somebody's existing setup is not ours to reorganise — it goes first, so
    // a later reader sees what was theirs before what we added.
    const r = applyManagedBlock('*.pdf filter=lfs\n', 'rule')
    expect(r.text).toBe(`*.pdf filter=lfs\n\n${BEGIN}\nrule\n${END}\n`)
    expect(r.hadExisting).toBe(true)
  })

  it('replaces an existing block instead of adding a second one', () => {
    const once = applyManagedBlock('mine\n', 'rule').text
    const twice = applyManagedBlock(once, 'rule')
    expect(twice.changed).toBe(false)
    const thrice = applyManagedBlock(once, 'newer rule')
    expect(thrice.text.split(BEGIN)).toHaveLength(2) // one marker, so two pieces
    expect(thrice.text).toContain('newer rule')
    expect(thrice.text).not.toContain('\nrule\n')
    expect(thrice.text).toContain('mine')
  })

  it('leaves what sits after the block alone', () => {
    const existing = `${BEGIN}\nold\n${END}\n\n*.bin binary\n`
    const r = applyManagedBlock(existing, 'new')
    expect(r.text).toContain('*.bin binary')
    expect(r.text).toContain('new')
  })

  it('treats a whitespace-only file as empty rather than as content to preserve', () => {
    const r = applyManagedBlock('\n  \n', 'rule')
    expect(r.hadExisting).toBe(false)
    expect(r.text).toBe(`${BEGIN}\nrule\n${END}\n`)
  })
})

describe('planRepoSetup', () => {
  it('needs no consent for a repository with neither file', () => {
    const plan = planRepoSetup(null, null)
    expect(plan.upToDate).toBe(false)
    expect(plan.needsConsent).toBe(false)
  })

  it('asks first when the team already set something up', () => {
    const plan = planRepoSetup('*.pdf filter=lfs\n', null)
    expect(plan.needsConsent).toBe(true)
  })

  it('is up to date once applied, so opening a project stays quiet', () => {
    const first = planRepoSetup(null, null)
    const second = planRepoSetup(first.attributes.text, first.ignore.text)
    expect(second.upToDate).toBe(true)
    expect(second.needsConsent).toBe(false)
  })

  it('does not ask again for a file it wrote itself, only for the user\'s own', () => {
    // The block is ours; having written it once does not make a later update
    // to it a change to somebody else's work.
    const mine = applyManagedBlock(null, ATTRIBUTES_BODY).text
    const plan = planRepoSetup(mine, null)
    expect(plan.needsConsent).toBe(false)
  })

  it('carries the rules that actually matter', () => {
    expect(ATTRIBUTES_BODY).toContain('*.json text eol=lf -merge')
    expect(IGNORE_BODY).toContain('.DS_Store')
  })
})
