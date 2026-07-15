import { describe, it, expect } from 'vitest'
import { resolveSchema, type ResolvedDef } from '../model/schema'
import { loadProject, type Paper } from '../model/project'
import { normalizeTree } from '../model/annotations'
import { unansweredFields, type FieldTarget } from './fields'
import { buildSystemPrompt, buildUserText } from './prompt'

/**
 * The prompt is the whole contract with the model, so these tests pin the parts a
 * refactor could quietly drop without any type error:
 *
 *  - the *generic* description of the schema format (without it the model can only
 *    pattern-match a schema it has seen before, not read this reviewer's),
 *  - each field's `description`, which IS the instruction for what to extract,
 *  - the "omit rather than invent" rules, and the PDF-extraction warning that only
 *    applies when the paper arrives as machine-extracted text.
 *
 * Schema and targets are built with the real `resolveSchema`/`unansweredFields`, so
 * the prompt is exercised against the exact shapes the app feeds it at runtime.
 */

const schema: ResolvedDef[] = resolveSchema([
  {
    name: 'Study Type',
    type: 'string',
    options: ['RCT', 'Survey'],
    description: 'The design of the study, as the paper describes it.',
  },
  { name: 'Year', type: 'number', required: true, description: 'Year of publication.' },
  { name: 'Relevant', type: 'boolean', description: 'Whether the paper is in scope.' },
  {
    name: 'Findings',
    min: 1,
    max: null,
    children: [
      { name: 'Claim', type: 'string', required: true, description: 'What the authors claim.' },
      { name: 'Evidence', min: 1, max: 2, children: [{ name: 'Metric', type: 'string' }] },
    ],
  },
])

// "Study Type" is already answered, so it must NOT appear in the field list; the
// rest are still empty and must.
const tree = normalizeTree(schema, { 'Study Type': [{ value: 'RCT' }] })
const targets: FieldTarget[] = unansweredFields(schema, tree)

const textPrompt = buildSystemPrompt(schema, targets, 'text')
const pdfPrompt = buildSystemPrompt(schema, targets, 'pdf')

/** The schema block the model is shown, parsed back out of the prompt. */
function embeddedSchema(prompt: string): Array<Record<string, unknown>> {
  const block = /```json\n([\s\S]*?)\n```/.exec(prompt)
  expect(block).not.toBeNull()
  return JSON.parse(block![1]) as Array<Record<string, unknown>>
}

describe('buildSystemPrompt: how to read a schema', () => {
  // The model is told how a schema is *written* before it is shown one. Drop this
  // and an unfamiliar schema (a repeatable group, an enum, a bounded max) becomes
  // guesswork.
  it('explains every key of the schema format', () => {
    expect(textPrompt).toMatch(/min\s+Minimum number of entries/)
    expect(textPrompt).toMatch(/max\s+Maximum number of entries/)
    expect(textPrompt).toMatch(/options\s+For a "string" field/)
    expect(textPrompt).toMatch(/description\s+What to record in this field/)
    // The group/field distinction: a node without a type carries no value.
    expect(textPrompt).toMatch(/without a type is a group/i)
    expect(textPrompt).toMatch(/repeatable/i)
  })

  it('explains the path syntax the answer has to use', () => {
    expect(textPrompt).toContain('Findings[1]/Evidence[0]/Metric')
    expect(textPrompt).toMatch(/next free index/)
  })
})

describe('buildSystemPrompt: the project’s own schema', () => {
  it('embeds it as parseable JSON', () => {
    const embedded = embeddedSchema(textPrompt)
    expect(embedded.map((n) => n.name)).toEqual(['Study Type', 'Year', 'Relevant', 'Findings'])
  })

  it('carries the details the model needs: options, cardinality, nesting', () => {
    const embedded = embeddedSchema(textPrompt)
    const studyType = embedded.find((n) => n.name === 'Study Type')!
    expect(studyType.options).toEqual(['RCT', 'Survey'])
    expect(studyType.type).toBe('string')

    const findings = embedded.find((n) => n.name === 'Findings') as { max: unknown; children: unknown[] }
    expect(findings.max).toBeNull() // unbounded: the model may add entries
    expect((findings.children as Array<{ name: string }>).map((c) => c.name)).toEqual([
      'Claim',
      'Evidence',
    ])
  })
})

describe('buildSystemPrompt: the fields to fill', () => {
  it('lists every unanswered field and nothing else', () => {
    for (const t of targets) expect(textPrompt).toContain(`- ${t.path} (`)
    // Already answered, so the model is not invited to touch it.
    expect(textPrompt).not.toContain('- Study Type (')
  })

  it('states each field’s type, its required flag and its options', () => {
    expect(textPrompt).toContain('- Year (number; required)')
    expect(textPrompt).toContain('- Relevant (boolean)')
    expect(textPrompt).toContain('- Findings/Claim (string; required)')
    expect(textPrompt).toContain('- Findings/Evidence/Metric (string)')

    // An enum field renders its closed set inline, so the model does not have to
    // hunt for it in the schema block.
    const enumSchema = resolveSchema([
      { name: 'Design', type: 'string', options: ['RCT', 'Survey'], description: 'The design.' },
    ])
    const enumPrompt = buildSystemPrompt(
      enumSchema,
      unansweredFields(enumSchema, normalizeTree(enumSchema, {})),
      'text',
    )
    expect(enumPrompt).toContain('- Design (string; one of: "RCT", "Survey")')
  })

  // The description is the *instruction* for the field. Losing it would leave the
  // model guessing from a bare name — a silent quality regression, not a crash.
  it('carries each field’s description', () => {
    const described = targets.filter((t) => t.def.description)
    expect(described.length).toBeGreaterThan(0)
    for (const t of described) expect(textPrompt).toContain(t.def.description!)

    expect(textPrompt).toContain('Year of publication.')
    expect(textPrompt).toContain('What the authors claim.')
  })
})

describe('buildSystemPrompt: the rules that keep the model honest', () => {
  it.each([
    ['text', textPrompt],
    ['pdf', pdfPrompt],
  ])('tells the %s delivery to omit rather than invent', (_delivery, prompt) => {
    expect(prompt).toMatch(/no outside knowledge/i)
    expect(prompt).toContain('Never invent a value to fill a gap.')
    expect(prompt).toMatch(/omit that field/i)
    // No value without a verbatim quote to back it.
    expect(prompt).toMatch(/verbatim quote/i)
  })

  it.each([
    ['text', textPrompt],
    ['pdf', pdfPrompt],
  ])('gives the %s delivery the output format', (_delivery, prompt) => {
    expect(prompt).toContain('"fields": [')
    expect(prompt).toContain('"skipped": [')
    expect(prompt).toContain('"evidence"')
    expect(prompt).toContain('"confidence"')
    expect(prompt).toMatch(/no markdown code fences/i)
  })
})

describe('buildSystemPrompt: the extraction warning depends on the delivery', () => {
  // Text delivery means pdfText.ts flattened the PDF: tables and columns come out
  // garbled. Without this warning the model reconstructs them into confident
  // numbers, which is the worst possible failure for a literature review.
  it('warns the model when the paper is machine-extracted text', () => {
    expect(textPrompt).toMatch(/text extracted automatically from a PDF/i)
    expect(textPrompt).toMatch(/garbled or missing/i)
    expect(textPrompt).toMatch(/Do not reconstruct or guess at content/i)
  })

  it('says nothing of the sort when the PDF itself is attached', () => {
    expect(pdfPrompt).not.toMatch(/extracted automatically/i)
    expect(pdfPrompt).not.toMatch(/garbled/i)
    expect(pdfPrompt).not.toMatch(/reconstruct/i)
  })
})

// ---------------------------------------------------------------------------
// buildUserText
// ---------------------------------------------------------------------------

const project = loadProject(
  JSON.stringify({
    version: 1,
    config: { schema: [{ name: 'Year', type: 'number' }] },
    papers: [
      {
        id: 'p1',
        title: 'On the Reading of Papers',
        authors: ['A. Author', 'B. Writer'],
        pdf: 'p1.pdf',
      },
      { id: 'p2', title: 'Anonymous Submission', authors: [], pdf: 'p2.pdf' },
    ],
  }),
)
const withAuthors: Paper = project.papers[0]
const withoutAuthors: Paper = project.papers[1]

/** Whatever sits between the two markers — this is what the model reads as the paper. */
function paperBody(message: string): string {
  const m = /--- BEGIN PAPER TEXT ---\n([\s\S]*)\n--- END PAPER TEXT ---/.exec(message)
  expect(m).not.toBeNull()
  return m![1]
}

describe('buildUserText', () => {
  it('names the paper and its authors', () => {
    const message = buildUserText(withAuthors, 'body')
    expect(message).toContain('Paper: "On the Reading of Papers" by A. Author, B. Writer.')
  })

  it('carries the paper text between the markers, unaltered', () => {
    // Includes a line that looks like a marker: the model gets the text as-is.
    const text = 'Abstract\n\nWe study X.\n--- not a real marker ---\nWe conclude Y.'
    expect(paperBody(buildUserText(withAuthors, text))).toBe(text)
  })

  it('reads sensibly when the paper lists no authors', () => {
    const message = buildUserText(withoutAuthors, 'body')
    expect(message).toContain('Paper: "Anonymous Submission" by unknown authors.')
    // Not "by ." or "by ,": an empty author list must never leave a dangling "by".
    expect(message).not.toMatch(/by\s*[,.]/)
  })
})
