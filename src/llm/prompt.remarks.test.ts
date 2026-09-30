import { describe, it, expect } from 'vitest'
import { resolveSchema } from '../model/schema'
import { unansweredFields } from './fields'
import { buildSystemPrompt, buildAgentSystemPrompt } from './prompt'

const schema = resolveSchema([{ name: 'Year', type: 'number' }])
const targets = unansweredFields(schema, undefined)

describe('schema remarks rule', () => {
  it('appears in prompt and agent prompts, for both deliveries', () => {
    for (const d of ['text', 'pdf'] as const) {
      expect(buildSystemPrompt(schema, targets, d)).toContain('schema_remarks')
      expect(buildAgentSystemPrompt(schema, targets, d)).toContain('schema_remarks')
    }
  })
})
