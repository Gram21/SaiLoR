import { describe, it, expect } from 'vitest'
import { resolveSchema } from './schema'
import { loadProject, serializeProject, ProjectLoadError } from './project'
import {
  applyFieldHelp,
  cleanPromptOverrides,
  parsePromptOverrides,
  promptOverridesTag,
  PROMPT_OVERRIDE_LIMITS,
} from './promptOverrides'
import { unansweredFields } from '../llm/fields'
import { buildAgentSystemPrompt, buildSystemPrompt, DEFAULT_ROLE } from '../llm/prompt'
import { buildRecheckSystemPrompt, answeredFields } from '../llm/recheck'
import { buildJudgeSystemPrompt } from '../llm/judge'
import { normalizeTree } from './annotations'

const schema = resolveSchema([
  { name: 'Year', type: 'number', description: 'Year of publication.' },
  { name: 'Findings', children: [{ name: 'Claim', type: 'string', description: 'What the authors claim.' }] },
])
const targets = unansweredFields(schema, undefined)

const project = (promptOverrides?: unknown) =>
  JSON.stringify({
    version: 1,
    config: { schema: [{ name: 'Year', type: 'number' }], ...(promptOverrides !== undefined ? { promptOverrides } : {}) },
    papers: [],
  })

describe('parsePromptOverrides', () => {
  // [utest->req~llm-791~1]
  it('accepts valid overrides and treats absent or blank values as the built-in text', () => {
    expect(parsePromptOverrides(undefined)).toEqual({ problems: [] })
    expect(parsePromptOverrides({ role: '  ', examples: '', fieldHelp: { Year: ' ' } })).toEqual({ problems: [] })
    expect(parsePromptOverrides({ role: ' A role. ', fieldHelp: { Year: 'Help.' } })).toEqual({
      overrides: { role: 'A role.', fieldHelp: { Year: 'Help.' } },
      problems: [],
    })
  })

  // [utest->req~llm-791~1]
  it('reports wrong types, unknown keys, bad paths and texts over the limit', () => {
    expect(parsePromptOverrides('x').problems).toHaveLength(1)
    expect(parsePromptOverrides({ rules: 'drop them' }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ role: 3 }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ fieldHelp: ['x'] }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ fieldHelp: { ' ': 'x' } }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ fieldHelp: { Year: 1 } }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ role: 'r'.repeat(PROMPT_OVERRIDE_LIMITS.role + 1) }).problems).toHaveLength(1)
    expect(parsePromptOverrides({ examples: 'e'.repeat(PROMPT_OVERRIDE_LIMITS.examples + 1) }).problems).toHaveLength(1)
    expect(
      parsePromptOverrides({ fieldHelp: { Year: 'h'.repeat(PROMPT_OVERRIDE_LIMITS.fieldHelp + 1) } }).problems,
    ).toHaveLength(1)
    expect(parsePromptOverrides({ role: 'r'.repeat(PROMPT_OVERRIDE_LIMITS.role) }).problems).toEqual([])
  })
})

describe('project file', () => {
  // [utest->req~llm-791~1]
  it('refuses to load a project with invalid overrides', () => {
    expect(() => loadProject(project({ role: 'r'.repeat(PROMPT_OVERRIDE_LIMITS.role + 1) }))).toThrow(ProjectLoadError)
    expect(() => loadProject(project({ outputFormat: 'free text' }))).toThrow(ProjectLoadError)
  })

  // [utest->req~llm-790~1]
  it('keeps overrides through a save and drops an empty set', () => {
    const loaded = loadProject(project({ role: 'Role.', examples: 'Ex.', fieldHelp: { Year: 'Help.' } }))
    expect(loaded.promptOverrides).toEqual({ role: 'Role.', examples: 'Ex.', fieldHelp: { Year: 'Help.' } })
    expect(loadProject(serializeProject(loaded)).promptOverrides).toEqual(loaded.promptOverrides)
    const empty = loadProject(project({ role: '' }))
    expect(empty.promptOverrides).toBeUndefined()
    expect(JSON.parse(serializeProject(empty)).config).not.toHaveProperty('promptOverrides')
  })
})

describe('promptOverridesTag', () => {
  // [utest->req~llm-793~1]
  it('is empty without overrides and changes with their content', () => {
    expect(promptOverridesTag(undefined)).toBe('')
    expect(promptOverridesTag({ role: ' ' })).toBe('')
    const a = promptOverridesTag({ role: 'A' })
    expect(a).toMatch(/^overrides-[0-9a-z]+$/)
    expect(promptOverridesTag({ role: 'B' })).not.toBe(a)
    expect(promptOverridesTag({ fieldHelp: { x: '1', y: '2' } })).toBe(promptOverridesTag({ fieldHelp: { y: '2', x: '1' } }))
  })
})

describe('prompt builders with overrides', () => {
  const overrides = {
    role: 'You are a strict methods reviewer.',
    examples: 'Paper X: Year 2020.\nPaper Y: Year 2019.',
    fieldHelp: { 'Findings/Claim': 'The main claim in one sentence.' },
  }

  // [utest->req~llm-792~1]
  it('leaves the default prompt unchanged', () => {
    const plain = buildSystemPrompt(schema, targets, 'text')
    expect(buildSystemPrompt(schema, targets, 'text', undefined, {})).toBe(plain)
    expect(plain.startsWith(`${DEFAULT_ROLE} Your task is to`)).toBe(true)
    expect(cleanPromptOverrides({})).toBeUndefined()
  })

  // [utest->req~llm-792~1]
  it('replaces role and field help, appends examples and keeps the fixed rules', () => {
    const plain = buildSystemPrompt(schema, targets, 'text')
    const p = buildSystemPrompt(schema, targets, 'text', undefined, overrides)
    expect(p.startsWith('You are a strict methods reviewer. Your task is to')).toBe(true)
    expect(p).not.toContain(DEFAULT_ROLE)
    expect(p).toContain('The main claim in one sentence.')
    expect(p).not.toContain('What the authors claim.')
    expect(p).toContain('Year of publication.')
    expect(p).toContain('## Additional examples from the project')
    expect(p).toContain('> Paper Y: Year 2019.')
    for (const fixed of ['## Rules', 'Quote your evidence.', '## Output format']) {
      expect(plain).toContain(fixed)
      expect(p).toContain(fixed)
    }
    expect(p.indexOf('## Additional examples')).toBeLessThan(p.indexOf('## Rules'))
  })

  // [utest->req~llm-792~1]
  it('applies to the agent and re-check prompts', () => {
    const agent = buildAgentSystemPrompt(schema, targets, 'text', undefined, false, overrides)
    expect(agent).toContain('You are a strict methods reviewer.')
    expect(agent).toContain('The main claim in one sentence.')
    expect(agent).toContain('> Paper X: Year 2020.')
    const tree = normalizeTree(schema, { Year: [{ value: 2020 }] })
    const recheck = buildRecheckSystemPrompt(schema, answeredFields(schema, tree), 'text', undefined, overrides)
    expect(recheck.startsWith('You are a strict methods reviewer.')).toBe(true)
    expect(recheck).toContain('> Paper X: Year 2020.')
  })

  // [utest->req~llm-792~1]
  it('gives the judge the field help only', () => {
    const judge = buildJudgeSystemPrompt(schema, targets, 'text', overrides)
    expect(judge).toContain('The main claim in one sentence.')
    expect(judge).not.toContain('strict methods reviewer')
    expect(judge).not.toContain('Paper X')
  })

  // [utest->req~llm-792~1]
  it('applyFieldHelp keeps the schema when no help is set', () => {
    expect(applyFieldHelp(schema, undefined)).toBe(schema)
    expect(applyFieldHelp(schema, { Year: 'New.' })[0].description).toBe('New.')
    expect(schema[0].description).toBe('Year of publication.')
  })
})
