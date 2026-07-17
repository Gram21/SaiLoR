import type { ResolvedDef } from '../model/schema'
import { dehydrateSchema, type Paper } from '../model/project'
import type { FieldTarget } from './fields'

/**
 * The prompt sent to the LLM.
 *
 * Two ideas hold this together. First, the model is told how an annotation
 * schema is *written* before it is shown one, so it can read an unfamiliar
 * schema rather than pattern-match a familiar one. That description mirrors
 * `docs/annotation-schema.md` §3 — if the schema format changes, both must move.
 *
 * Second, every rule pushes the model towards saying nothing rather than saying
 * something plausible. An omitted field costs a reviewer a few seconds; an
 * invented one is a fabricated data point in a literature review, and it looks
 * exactly like a real one. Hence: no outside knowledge, and no value without a
 * verbatim quote to back it.
 */

/** How the paper reaches the model. Text is the default; see src/model/pdfText.ts. */
export type Delivery = 'text' | 'pdf'

/**
 * A generic description of the schema format. Deliberately not derived from the
 * types: it is instruction, not data, and it explains the *intent* of each key
 * (notably that `description` is the instruction for what to extract).
 *
 * Kept in sync by hand with docs/annotation-schema.md §3 "Defining the annotation schema".
 */
const SCHEMA_FORMAT_DOC = `## How an annotation schema is written
The schema is an array of nodes. Each node describes one thing to record:

  name         (required) The label of the field. Sibling names are unique.
  type         "string" | "number" | "boolean" | "year". A node WITH a type holds a value.
               A node WITHOUT a type is a group: a name-only branch of the taxonomy.
               A "year" field holds a four-digit publication year as a plain number (e.g.
               2021), not a string.
  children     Nested nodes. A node may have a type, children, or both.
  min          Minimum number of entries of this node. Default 1.
  max          Maximum number of entries. A whole number, or null for unbounded. Default 1.
  options      For a "string" field: the closed set of allowed values (an enum).
  required     true if the reviewer must fill this field in. Only valid on a node with a type.
  description  What to record in this field. Read it carefully - it is the instruction.

A node whose max is null or greater than 1 is repeatable and may hold several entries.
A repeatable GROUP means several parallel sub-trees (e.g. several Findings, each with its
own Claim and Evidence). A repeatable FIELD means several values (e.g. several Metrics).`

const PATHS_DOC = `## Paths
A path identifies one field: node names joined with "/", each optionally followed by [i] to
select one entry of a repeated node ([0] when omitted).
  "Study Type"                     - a top-level field
  "Findings[1]/Evidence[0]/Metric" - the Metric of the first Evidence of the SECOND Finding
To record a further entry of a repeatable node, use the next free index, staying within its max.`

const OUTPUT_DOC = `## Output format
Return exactly this JSON object:

{
  "fields": [
    {
      "path": "Study Type",
      "value": "Controlled experiment",
      "evidence": "We conducted a controlled experiment with 24 participants.",
      "confidence": 0.9
    }
  ],
  "skipped": [
    { "path": "Year", "reason": "The paper does not state a publication year." }
  ]
}

"fields" holds one entry per value you extracted; "confidence" is between 0.0 and 1.0.
"skipped" holds the fields you deliberately left empty, with a short reason.`

/** One line per field the model is asked to fill: what it is, and what is allowed. */
function fieldLines(targets: FieldTarget[]): string {
  return targets
    .map((t) => {
      const bits: string[] = [t.def.type ?? 'value']
      if (t.def.required) bits.push('required')
      if (t.def.options?.length) bits.push(`one of: ${t.def.options.map((o) => `"${o}"`).join(', ')}`)
      const head = `- ${t.path} (${bits.join('; ')})`
      return t.def.description ? `${head}\n    ${t.def.description}` : head
    })
    .join('\n')
}

/**
 * The system prompt. `delivery` matters: when the paper arrives as extracted
 * text, the model must be warned that the extraction is lossy, or it will
 * happily reconstruct a mangled table into confident numbers.
 */
export function buildSystemPrompt(
  schema: ResolvedDef[],
  targets: FieldTarget[],
  delivery: Delivery,
): string {
  // Show the schema exactly as it appears on disk (defaults omitted) — that is the
  // form the format description above documents.
  const schemaJson = JSON.stringify(dehydrateSchema(schema), null, 2)

  const extractionRule =
    delivery === 'text'
      ? `6. The paper is given to you as text extracted automatically from a PDF. Tables, figures,
   formulas and column layout may be garbled or missing. Do not reconstruct or guess at content
   that is not legible - omit the field instead.
7. Output only the JSON object described below. No commentary, no markdown code fences.`
      : `6. Output only the JSON object described below. No commentary, no markdown code fences.`

  return `You are assisting a researcher conducting a Systematic Literature Review. Your task is to
read one scientific paper and extract structured annotations from it, following a fixed
annotation schema.

${SCHEMA_FORMAT_DOC}

## The schema for this review
\`\`\`json
${schemaJson}
\`\`\`

${PATHS_DOC}

## Fields to fill
These fields are still empty. Fill only these:
${fieldLines(targets)}

## Rules
1. Ground every value in the paper. Use only what the paper itself states - no outside knowledge,
   no inference beyond what is written, no guessing.
2. If the paper does not answer a field, omit that field. An omitted field is a correct and
   expected answer. Never invent a value to fill a gap.
3. Quote your evidence. For every value you return, give a short verbatim quote (at most 200
   characters) copied exactly from the paper that supports it. If you cannot quote it, you cannot
   answer it - omit the field instead.
4. Respect each field's type:
   - "string"  - plain text, no markdown
   - "number"  - a JSON number: no units, no ranges, no approximations
   - "boolean" - true or false
   - "year"    - a JSON number: a four-digit publication year, e.g. 2021
5. If a field declares "options", the value must be exactly one of those strings, copied verbatim.
   If none of them fits, omit the field.
${extractionRule}

${OUTPUT_DOC}`
}

/** The user message that carries the paper itself (text delivery). */
export function buildUserText(paper: Paper, paperText: string): string {
  const authors = paper.authors.length > 0 ? paper.authors.join(', ') : 'unknown authors'
  return `Paper: "${paper.title}" by ${authors}.

Extract the annotations for the fields listed in the schema.

--- BEGIN PAPER TEXT ---
${paperText}
--- END PAPER TEXT ---`
}

/** The text part accompanying a PDF delivery (the PDF itself is a separate part). */
export function buildUserPdfCaption(paper: Paper): string {
  const authors = paper.authors.length > 0 ? paper.authors.join(', ') : 'unknown authors'
  return `Paper: "${paper.title}" by ${authors}.

The paper is attached. Extract the annotations for the fields listed in the schema.`
}
