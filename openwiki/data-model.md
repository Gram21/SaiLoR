---
type: reference
title: SaiLoR Data Model
description: The SaiLoR project file format (JSON schema for annotation taxonomies and papers), the in-memory TypeScript types (ResolvedDef, Project, Paper, AnnotationValueTree), and the full load → normalize → edit → prune → serialize lifecycle that keeps hand-edited JSON safe.
tags: [data-model, json, schema, types, lifecycle]
---

# Data Model

This page describes the project file format, the in-memory data structures, and the full lifecycle from loading to saving.

## Project File Format

A project is a single JSON file with this shape:

```jsonc
{
  "version": 1,
  "config": {
    "schema": [ /* AnnotationDef[] — the taxonomy. Ignored + derived when "screening" is set */ ],
    "ai": false,       // optional; false disables AI-assisted annotation for this project
    "reviewers": 3,    // optional; >1 turns on independent multi-reviewer annotation
    "screening": { "reasons": ["Wrong topic", "Duplicate"] },  // optional; see "Screening" below
    "reviewerIdentities": {                                    // optional; see below
      "1": { "email": "a@example.org" },
      "consolidation": { "email": "b@example.org", "name": "B. Reviewer" }
    }
  },
  "provenance": null,  // optional; ProjectProvenance | null — see "Screening" below
  "protocol": null,    // optional; ProjectProtocol | null — see below
  "papers": [ /* Paper[] */ ],
  // any other top-level keys are preserved verbatim on save; keys inside
  // `config`, however, are NOT — config is rebuilt from its known fields on
  // every save, so a hand-added config.<anything> is dropped (this is exactly
  // why `protocol` is a root-level field, not a config key)
}
```

`config.ai` defaults to `false` for new projects created in the editor (which writes `config.ai:
false` into the file). An existing file's own setting is always read and preserved. When `false`, the ✦ AI button is disabled (with a hover note that
the provider turned it off); the loader reads it into `Project.aiEnabled`, and `serializeProject`
writes it back only when disabled, so a normal file stays clean. The AI-annotation checkbox has been
removed from the project editor — with no reachable entry point for the feature itself, a control
that configures it would promise something the app doesn't currently deliver.

`config.reviewers` defaults to `1` (single-reviewer — every paper carries one `annotations` tree
and nobody picks a reviewer). A value from 2 to 10 turns on independent multi-reviewer annotation:
each reviewer 1..N annotates into their own tree (`Paper.reviews["N"]`), and a built-in
**Consolidation** role (not counted in `reviewers`) reconciles them into `Paper.annotations`, which
remains the single, final result — see "Multiple reviewers & Consolidation" below.
`serializeProject`/`buildProjectJson` write `config.reviewers` only when it is greater than 1, so a
single-reviewer file is unaffected byte-for-byte. The project editor edits it as a checkbox +
number field next to the AI opt-out.

`config.reviewerIdentities: Record<string, ReviewerIdentity>` (`ReviewerIdentity = { email: string;
name?: string }`) records, per seat (`"1".."N"` or the literal `"consolidation"`), the git identity
that holds it — written the first time a reviewer with a known git email claims a seat, omitted
entirely when empty (so a solo project or one whose reviewers never had a git identity to record is
unaffected byte-for-byte). It exists to close a real hazard: the seat choice itself is otherwise only
ever recorded per-machine, in `localStorage`, so two different people who each pick "Reviewer 1" on
their own clone are invisible to each other and their answers merge into one chimeric tree with no
conflict raised. See `architecture.md`'s "Reviewer seat identity" for the full mechanism (why the
comparison is email-only, how a mismatch is surfaced, and why it never blocks) and "Merging two
copies of a project" below for what it does to a merge.

### AnnotationDef (`src/model/schema.ts`)

Each schema node defines a field or group in the taxonomy:

| Property | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | Display label; must be unique among siblings |
| `type` | no | (group) | `"string"` \| `"number"` \| `"boolean"` \| `"year"`. Omit for a name-only group node |
| `children` | no | `[]` | Sub-taxonomy. A node may have `type`, `children`, or both |
| `min` | no | `1` | Minimum occurrences. Materialized eagerly at load, so it is bounded in aggregate — see the instance budget below |
| `max` | no | `1` | Max occurrences: a positive integer, or `null` for unbounded |
| `options` | no | — | Array of strings on a `string` field → renders as a filterable enum dropdown (ComboBox). Only valid when `type` is `"string"` |
| `required` | no | `false` | Marks a **field** (a node with a `type`) as one the reviewer must fill; shown with a red `*`, checked by `validate.ts`'s `required` issue. Rejected on a group (holds no value); **silently dropped on a `boolean`** — a checkbox is never "empty" (`isEmptyValue` returns `false` for booleans), so `required` there can never fire. `resolveSchema` drops the flag on load (not a load error), and the schema editor doesn't offer it for a boolean field |
| `description` | no | — | Optional tooltip text |

**Validation rules** (enforced by zod in `annotationDefSchema`):
- `name` must be a non-empty string
- `max` must be ≥ `min` (when `max` is not `null`)
- A node must have a `type` or non-empty `children` (a name-only node with neither is rejected)
- `options` is only allowed on a `type: "string"` node; using it on any other type (or a group) is a schema error
- Sibling names must be unique (enforced during resolution, not zod)
- `name` may not be `__proto__` (enforced during resolution)

**The instance budget** (`assertInstanceBudget`, enforced during resolution). A schema whose empty
tree would materialize more than `MAX_INITIAL_INSTANCES` (100 000) instances is rejected with a
`SchemaError`.

This exists because `min` is not a lazy declaration: `initTree`/`normalizeTree` *materialize*
`max(min, 1)` instances per node, recursively, at load, before the reviewer has entered anything.
The file describing an enormous tree stays tiny — a flat `min: 1000000000` is 139 bytes, and ten
nested groups of `min: 10` is about 500 bytes describing 10¹⁰ instances — so the cost is entirely
invisible from the file's size. Unbounded, that is an out-of-memory kill of the process during load,
with no error dialog and no chance to close the file.

The budget is checked on the **product** down each branch rather than as a per-node ceiling on
`min`, because a per-node cap cannot help: any ceiling above 1 still multiplies with depth. It
short-circuits as soon as the cap is passed, so a 10¹⁰ schema is refused in about a millisecond.
Real schemas are nowhere near it — a 100-row × 20-field checklist scores 2 100, and a typical
taxonomy scores in the low hundreds.

**`"year"`** is a `number` on disk — same `FieldValue`, same `emptyValue()` — with a real range check
`validate.ts` applies that a plain `number` field never gets: an integer in `[YEAR_MIN, YEAR_MAX]`
(`1000`–`2100`, `src/model/year.ts`), so a hand-edited typo like `20221` or `55` fails validation
instead of loading as a "valid" year. `src/model/year.ts`'s `parseYear`/`isPlausibleYear` are the one
shared implementation every layer that touches a year — the loader, `validate.ts`, `references.ts`'s
three import formats, `git/merge.ts`, `git/changes.ts`, `Field.tsx`'s PDF-grab, and the editor's
string↔number boundary — reads through, rather than each hand-rolling its own four-digit regex. A
full `date` type (month/day) was considered and rejected as more precision than an SLR's publication
year needs (`schema.ts`'s own doc comment on `FieldType`); opening a `year` field in an older SaiLoR
build fails to load, the same as any new type would, since `type` validates against a fixed enum.

### Paper

```jsonc
{
  "id": "paper-a",            // unique across all papers
  "title": "…",
  "authors": ["…"],           // defaults to []
  "year": 2021,                // optional; a plausible year (1000–2100), see src/model/year.ts
  "venue": "…",                // optional; journal/conference/publisher — one free-text field, see below
  "doi": "10.1000/xyz",       // optional
  "abstract": "…",            // optional; what screening reads when there is no PDF (see "Screening" below)
  "pdf": "pdfs/paper-a.pdf",  // path relative to the project JSON file; "" only valid in a screening project
  "annotations": {},          // the consolidated result — filled in as you annotate
  "reviews": {                // optional; each independent reviewer's own tree, multi-reviewer only
    "1": { /* AnnotationValueTree */ },
    "2": { /* AnnotationValueTree */ }
  },
  // any other keys preserved verbatim on save
}
```

The `samples/project.example.json` file shows a complete working example with a schema containing boolean, string, number, repeatable group, and bounded group nodes. `samples/screening.example.json` is its screening counterpart: the same papers plus abstract-only ones covering every decision state, built through `loadProject`/`serializeProject` so it is in the exact normalized form the app itself would write.

## In-Memory Types

### ResolvedDef (`src/model/schema.ts`)

When a project is loaded, raw `AnnotationDef[]` are resolved into `ResolvedDef[]` via `resolveSchema()`. Resolution:
- Applies defaults: `min` → `1`, `max` → `1` (if undefined)
- Assigns a stable `id` derived from the node's path (slash-joined names, e.g. `"Findings/Claim"`)
- Enforces sibling-name uniqueness (throws `SchemaError`)
- Passes through `options` (if present) for enum string fields
- Recursively resolves `children`

### Project and Paper (`src/model/project.ts`)

```typescript
interface Project {
  version: number
  title?: string
  schema: ResolvedDef[]
  aiEnabled: boolean              // config.ai; false for new projects, preserved from file otherwise
  reviewers: number                // config.reviewers; 1 (default) = single-reviewer
  reviewerIdentities: Record<string, ReviewerIdentity>  // config.reviewerIdentities; {} if none recorded
  papers: Paper[]
  screening: ScreeningConfig | null  // config.screening; see "Screening" below
  provenance: ProjectProvenance | null  // set by "New from screening…"; see "Screening" below
  protocol: ProjectProtocol | null   // the review's authored protocol; see below
  extra: Record<string, unknown>  // unknown top-level fields preserved
}

interface ReviewerIdentity {
  email: string   // the only field ever compared (sameIdentity) — see architecture.md's "Reviewer seat identity"
  name?: string    // display only
}

interface ProjectProvenance {
  kind: 'screening-import'
  source: { title?: string; file: string }
  importedAt: string   // ISO 8601
  counts: { included: number; undecided: number; excluded: number; carried: number }
}

interface ProjectProtocol {   // every field optional; an all-empty protocol is null, not {}
  researchQuestions?: string[]
  searchStrings?: string[]
  databases?: string[]
  searchDate?: string   // free text — a search is usually a range, not one instant
  notes?: string        // inclusion/exclusion criteria and other protocol notes
}

interface Paper {
  id: string
  title: string
  authors: string[]
  year?: number                    // a plausible year (1000–2100); see src/model/year.ts
  venue?: string                   // journal/conference/publisher — one free-text field, no source format
                                    // reliably distinguishes them
  doi?: string
  abstract?: string                // what screening reads when there is no PDF; ordinary metadata otherwise
  abstractFromPdf?: boolean        // true when `abstract` was PDF-extracted, not authored; see "Screening" below
  pdf: string
  annotations: AnnotationValueTree          // the single/consolidated result — unchanged in meaning
  reviews: Record<string, AnnotationValueTree>  // each reviewer's own tree, keyed "1".."N"; {} if single-reviewer
  aiUsage: AiUsageRecord[]        // AI-assisted-annotation disclosure log, oldest first; [] if never used
  extra: Record<string, unknown>  // unknown per-paper fields preserved
}

interface AiUsageRecord {
  provider: string    // e.g. "anthropic" — the provider id, not its display label
  model: string        // exactly as configured, e.g. "claude-opus-4-8"
  appliedAt: string    // ISO 8601 timestamp of the Apply click
}
```

### AnnotationValueTree and InstanceNode (`src/model/annotations.ts`)

Annotation data mirrors the schema. At each level it is a map keyed by node name; every key holds an **array of instances** (length bounded by `min`/`max`):

```typescript
interface AnnotationValueTree {
  [nodeName: string]: InstanceNode[]
}

interface InstanceNode {
  value?: FieldValue        // present if the node is a field (has a type)
  children?: AnnotationValueTree  // present if the node has children
}

type FieldValue = string | number | boolean | null
```

Example annotation tree for the sample schema:
```
{
  "Relevant": [{ value: true }],
  "Study Type": [{ value: "RCT" }],
  "Year": [{ value: 2021 }],
  "Findings": [
    { children: {
        "Claim": [{ value: "X improves Y" }],
        "Evidence": [{ value: "Section 4" }],
        "Confidence": [{ value: 4 }]
    }},
    { children: {
        "Claim": [{ value: "Z reduces W" }],
        "Evidence": [{ value: "Table 2" }],
        "Confidence": [{ value: 3 }]
    }}
  ]
}
```

## Multiple reviewers & Consolidation

An SLR is normally annotated by ≥2 reviewers **independently**, then reconciled into one final
answer. `config.reviewers` (≥2) turns this on:

- Each numbered reviewer 1..N reads and writes their **own** tree, `Paper.reviews["N"]` —
  `AnnotationValueTree`, same shape as `annotations`. Present as a full, normalized-empty skeleton
  from the moment the project is **loaded** (`normalizeReviews` in `project.ts`), for every
  reviewer 1..N whether or not they have written anything — not created lazily on first write.
  `currentTree`'s `create` path still exists and still lazily normalizes a genuinely-missing tree,
  as a defensive fallback; it just no longer does the routine work, since load already has.
- `Paper.annotations` keeps its existing meaning **unchanged**: the single/consolidated result.
  In a single-reviewer project it is the only tree there is; in a multi-reviewer project it is
  what the built-in **Consolidation** role writes — the final, agreed answer, and the only tree
  `validateProject`, `hasAnnotations`, and any future export read.
- Consolidation is not one of the N reviewers (it is not counted in `config.reviewers`) — it is a
  distinct role that compares every reviewer's answer for a field and picks the one that ships.

**Lowering `config.reviewers` doesn't delete data — it makes it unreachable.** `parseReviews`
(`src/model/project.ts`) keeps any `reviews` key matching a reviewer number regardless of the
current `config.reviewers`, and `serializeProject` writes back every key present in `Paper.reviews`,
not just `1..N`. So a reviewer's tree above the current count round-trips through load/save
untouched — `normalizeReviews` (below) only ever *adds* missing keys `1..N`, it never removes one
outside that range. What changes is reachability: the Toolbar reviewer switch only offers seats
`1..config.reviewers`, so `currentTree` is never invoked for a higher one — it can't be selected,
edited, or (via `runValidation`) validated — and `alignConsolidationNode`/`adoptUnanimousValues`
(both in `store.ts`) loop `1..project.reviewers`, excluding it from matching and unanimous-value
adoption too — both also now check `hasAnnotations`, not mere tree presence, since every in-range
reviewer has a tree from load regardless of whether they have written anything. Raising
`config.reviewers` again makes the same tree reachable, unchanged.

**Routing.** `currentTree(project, currentReviewer, paper)` in `src/state/store.ts` is the single
place this is decided: single-reviewer → `paper.annotations`; Consolidation → `paper.annotations`;
a numbered reviewer → `paper.reviews[N]`; multi-reviewer with nobody picked yet → `null` (nothing
to read or write — an unattributed edit must never land in the shipped tree). Every store action
that touches annotation data (`setFieldValue`, `addInstance`, `removeInstance`,
`applyAiSuggestions`, `runValidation`) routes through this, so "which paper" and "which reviewer"
are independent selections: switching reviewer never changes the selected paper, and vice versa.

**Reviewer selection** (`currentReviewer: string | null` in the store — `"1".."N"` or the literal
`"consolidation"`) is a *view* switch, not an edit: it is not an undo step and does not set
`dirty`. It defaults to `null` (unselected) on load for a multi-reviewer project — never silently
to Reviewer 1 — and is persisted per project in `localStorage`, keyed by the project's save-handle
path, so reopening the same file returns to the same seat.

**AI marks are reviewer-scoped too.** `aiMarkKey(paperId, canonicalPath, reviewer)` folds the
active reviewer into the key for a multi-reviewer project (a single-reviewer project's keys are
unaffected — passing `null` reproduces the original two-part form), so Reviewer 1's "the AI wrote
this" borders never bleed onto Reviewer 2's copy of the same field.

**Serialization stays clean for a single-reviewer project.** `config.reviewers` is written only
when `> 1`, and `Paper.reviews` stays `{}` — omitted entirely — since `annotations` alone carries
the data there, exactly as before this feature existed. For a **multi-reviewer** project,
`Paper.reviews` is now *always* written (see "The empty skeleton is real data" below) — every
reviewer's tree is pruned the same way `annotations` is, but the key itself is never omitted just
because a reviewer hasn't written anything.

### The empty skeleton is real data, not incidental emptiness

A freshly-created paper's `annotations` — and, in a multi-reviewer project, every reviewer's
`reviews["N"]` — is written to disk as the **full normalized skeleton**: every field present, at
its schema minimum, holding `null`/`false`, not `{}` and not an absent key. This is deliberate,
and it is *for* something specific: a reviewer's first real annotation then changes a *value on a
line that was already there* for every other paper and reviewer, rather than adding a brand-new
key. That is what makes a `git diff` of one reviewer's work legible on its own, and what makes a
`git merge` of two reviewers' independently-annotated copies of the same file tractable instead of
a near-guaranteed conflict on the shape of the JSON itself, on top of whatever the reviewers
actually disagree about.

**It now has a second consumer, and the relationship deserves stating correctly rather than
flatteringly.** SaiLoR's own git support (see "Merging two copies of a project" below and
`architecture.md`'s "Git" section) does **not** rely on git's line-based merge to succeed — its
**Pull** reads the three revisions of the project file and reconciles them field by field over the
*parsed* project, so its correctness never depended on the file's line structure to begin with. The
skeleton was not made redundant by that; it is still doing its original two jobs, and both still
matter: it is what makes a plain `git diff` of one reviewer's work legible on its own, and it is
what makes a plain `git merge` — run from the command line, or by any tool that is not SaiLoR —
tractable rather than a conflict on the shape of the JSON, on top of whatever the reviewers actually
disagree about.

Two pieces make this hold in practice:

- **`pruneTree` (`src/model/annotations.ts`) only drops *trailing* empties**, never an interior
  gap, and never below a node's `min`. Given an already-normalized (all-empty) tree, it is a no-op
  — see its own doc comment; this is also why consolidation's entry-matching survives a save/reload
  round-trip (`src/consolidate/apply.ts`), which depends on the same interior-gap guarantee.
- **`normalizeReviews` (`src/model/project.ts`)** backfills a normalized-empty tree for every
  reviewer `1..config.reviewers` who doesn't already have one, on **load** — not on save, and not
  lazily on first write (see "Multiple reviewers" above). `loadProject`'s existing
  `normalizeTree(schema, p.annotations)` call already did the equivalent for `annotations`; this
  closes the same gap for `reviews`.

**A file that doesn't have this shape yet is migrated automatically, and re-saved.**
`needsShapeMigration(project, rawText)` (`project.ts`) re-parses the raw text and structurally
compares (`deepEqualJson` — order-independent for object keys, order-sensitive for arrays, i.e.
JSON's own equality, never a text/string comparison) each paper's `annotations`/`reviews` against
what saving right now would produce. `loadFromText` (`store.ts`) checks this immediately after
`loadProject` and, if true, writes the migrated shape back through `getPlatform().saveProject` —
but only when there is somewhere safe and unsurprising to write it: a real in-place handle
(`'electron'` or `'fsapi'`), never `'download'` (which would trigger a browser file download the
instant a project is opened) and never a bare `null` handle (a `?project=` URL, or a browser pick
with no persistent handle — the project is simply held in its migrated, better shape in memory,
which converges again harmlessly next time it's opened). The write is fire-and-forget; on success
`saveHandle` is refreshed the same way an ordinary save updates it, on failure the project is
marked `dirty` so the ordinary unsaved-changes guard — not an alarming banner for a fix nobody
asked for — eventually gets it saved.

`needsShapeMigration` deliberately compares **parsed values**, not the canonical re-serialization's
*text* against the raw file's text: `serializeProject` always pretty-prints with its own key order,
so a text comparison would flag `equal-but-differently-formatted` (or merely differently-indented)
files as needing migration too — precisely the kind of file every hand-written test fixture in this
codebase is, which is how this got caught. The comparison is scoped to exactly `annotations` and
`reviews`; nothing else about a file's formatting or unrelated content is examined.

## Screening

```typescript
interface ScreeningConfig {
  reasons: string[]   // non-empty, trimmed, deduped by project.ts; order is the order reported
}
```

`config.screening`'s presence — reflected in `Project.screening: ScreeningConfig | null` — is what
makes a project a screening project. `config.schema` is not the source of truth for one: it is a
**derived projection** of `screening.reasons`, produced by `screeningSchemaDefs()`
(`src/screening/schema.ts`):

```jsonc
[
  { "name": "Decision", "type": "string", "options": ["Include", "Exclude"] },
  { "name": "Reason", "type": "string", "options": ["Wrong topic", "Duplicate", "…"] }
]
```

**Lifecycle step, not a one-off transform.** `loadProject` derives this schema fresh from
`raw.config.screening` on **every load** and never reads `raw.config.schema` for a screening
project (`raw.config.schema!` is used only in the non-screening branch, where the zod `superRefine`
guarantees it is present). `serializeProject` writes the same derived projection back out on
**every save**. There is no code path in which a screening project's `config.schema` in the file
and `screeningSchemaDefs(project.screening)` can disagree once the file has been re-saved by this
app — a hand-edited `config.schema` in a screening project's file is simply overwritten on the next
save, never read.

**`pdf` may be `""`, but only here.** `paperSchema.pdf` is `z.string().default('')`; the
"non-empty" requirement moved out of the field-level zod schema and into `projectSchema`'s
`superRefine`, which — able to see whether `config.screening` is set — only enforces it for a
*non-screening* paper. A screening project built from a reference-manager export routinely has no
PDFs at all yet, so relaxing this only there (never for an ordinary project) is what makes that
workflow possible without weakening the check everywhere else.

**`screeningStatus(tree)`** (`src/screening/status.ts`) reads the tri-state a screening decision
actually has:

| `Decision` value | Status |
|---|---|
| `"Include"` | `included` |
| `"Exclude"` | `excluded` |
| anything else — `null`, missing, a non-array node, an unrecognised string | `undecided` |

The last row is deliberate and conservative: the file is hand-editable, and an unrecognised
decision is not a decision — it must never be misread as `excluded` (which would silently drop the
paper from an import) or as `included` (which would silently claim a paper was screened when it
was not). `undecided` is the only safe default for anything this function cannot make sense of.

`screeningCounts()` (`src/screening/counts.ts`) is the total/included/excluded/undecided +
per-reason breakdown behind `ScreeningSummary`; it reads through the same seat routing
`currentTree` uses (reimplemented locally as `seatTree`, to keep `src/screening/` free of a
`state/store.ts` import — the same precedent `consolidate/readiness.ts` and
`consolidate/disagreements.ts` already set). `pendingUnanimous()` counts papers every reviewer
decided identically that Consolidation has not adopted yet (see the architecture page's "Screening"
section for why that gap exists).

**`abstractFromPdf` is a durable disclosure, the same idea `aiUsage` embodies for AI-assisted
annotation, applied to a basic text heuristic instead of a model.** `Paper.abstract` can be filled
by a heuristic that reads a PDF's own text (`pdfMeta.ts`'s `abstractFromLines` — find the "Abstract"
heading and follow its column to the next section) rather than by a human or a reference-manager export,
and when it is, `abstractFromPdf: true` is written into the file right alongside it — never a
session-only flag, so a co-reviewer opening the file later sees the same "unverified, check the PDF
if in doubt" warning the extracting session did. `loadProject` drops the flag whenever `abstract`
itself is empty (a flag with nothing to describe is meaningless, most likely a stale or hand-edited
file), and a later reference-manager import is the one thing allowed to overwrite an
`abstractFromPdf`-flagged value — every other paper field a reviewer might have typed is left
alone. See the architecture page's "A missing abstract is extracted from the PDF, and flagged
durably" for the full design (both call sites, and why this writes immediately rather than behind a
confirmation step the way AI suggestions do).

**A screening import's target project can itself be a screening project — a second pass, not just
an annotation project.** `resolveScreeningImport` (`editorStore.ts`) reads a `startKind:
'annotation' | 'screening'` off the import draft (chosen via a radio in `ScreeningImportDialog`,
defaulting to `'annotation'`). Building a second screening project was previously refused outright —
this is what PRISMA's title/abstract pass feeding a full-text pass actually needs. Its
`config.screening.reasons` is seeded from the **source** project's own reasons, never
`DEFAULT_SCREENING_REASONS`, so both passes report against the same reason vocabulary; it inherits
the source's `config.reviewers`; and it suggests a `-fulltext.json` filename where an annotation
target keeps `reviewers: 1` and suggests `-annotation.json`. Either way, every carried paper's
`annotations` (and `reviews`, for a screening target) starts empty — see "The empty skeleton is real
data" above for why an empty tree, not an absent key, is what a fresh paper always gets — because a
first-pass title/abstract decision is not itself a full-text (or second-round) decision.

The import also records its own provenance: `Project.provenance: ProjectProvenance | null` (shape
above) is written whenever "New from screening…" builds a project, naming the source file/title, an
ISO 8601 timestamp, and the included/undecided/excluded/carried counts the import dialog showed. It
is a first-class field — not nested under `config` (whose zod object silently drops an unrecognized
key, since it has no `.passthrough()`) and not under `extra` (which a screening import resets to
`{}`) — parsed defensively by `parseProvenance` (malformed input becomes `null`, never a thrown
error) and written by both `serializeProject` and the editor's `buildProjectJson`. See "Merging two
copies of a project" below for what a divergent `provenance` does to a pull, and `architecture.md`'s
"Importing from a screening project" for the UI/store mechanics.

## The review protocol (`Project.protocol`)

`Project.protocol: ProjectProtocol | null` (shape above) records the review's research questions,
search strings, databases, search date, and inclusion/exclusion notes — authored by hand in the
project editor's collapsed *Review protocol* section. It is a first-class root field for a
load-bearing reason: `config` is a strict zod object rebuilt from its known fields on every save, so
a hand-added `config.protocol` (or `config.researchQuestions`) is *silently dropped* on the first
save — the exact trap `provenance` avoids the same way. `parseProtocol` degrades it **field by
field** (a malformed `databases` drops only that list, keeping the research questions beside it,
unlike `parseProvenance`'s all-or-nothing), an all-empty protocol parses to `null` (never a stray
`{}`), and both serializers write it. A two-sided divergent edit refuses the merge rather than
half-dropping an authored protocol (see below).

A guard covers the two-serializer hazard the whole thing depends on: `buildProjectJson` (the editor's
serializer) and `serializeProject` (the core's) must both carry every root field or one silently
drops it depending on which path last saved — `editorStore.test.ts` round-trips a project with every
root field set through both and fails if they disagree.

## Merging two copies of a project

`src/git/merge.ts`'s `mergeProjects(base, ours, theirs)` is a three-way merge over three parsed
`Project`s — not over the file's text — driven by git's **Pull**. This is the data-model view of what
it does; `architecture.md`'s "Git" section covers the plumbing that gets it there.

**The identity a field is merged under is `(paper id, tree, canonical field path)`.** `canonical` is
`formatPath`'s form (`src/llm/paths.ts`), e.g. `"Findings[1]/Claim"` — but the path alone is **not**
sufficient: the identical path exists once in `annotations` and once in *every* `reviews[N]`, so
which tree it lives in (`{kind:'annotations'}`, `{kind:'review', reviewer:'2'}`, `{kind:'paper'}` for
title/pdf/doi/authors/year/venue/abstract/abstractFromPdf, or `{kind:'project'}` for the project's
own title) is part of the key. Two conflicts on the same canonical path in different trees are
different conflicts. `year` and `venue` merge exactly like `abstract`/`abstractFromPdf` — an ordinary
`merge3` call each, a `FieldConflict` on genuine disagreement, no special-casing.
`abstract` and `abstractFromPdf` merge as two independent ordinary fields — a known, accepted gap is
that resolving an `abstract` conflict does not retroactively touch `abstractFromPdf`, which may
already have resolved on its own via the "only one side changed it" rule below; see
`architecture.md`'s "Git" section for the full reasoning and the bug this fixed.

**The one rule**: a side that did not change a value away from the merge base does not get a vote on
it. A field only one side changed takes that side's value automatically; a field both sides changed
to the *same* thing is not a conflict either; only a field both sides changed to *different* things
becomes one — the one case nothing but a person can settle. This is exactly the guarantee the
feature exists to make: pulling can never silently discard a reviewer's own change to a field the
remote never touched.

**Absent reads as empty.** A field with no instance at that index reads the same as an instance whose
value is the schema's empty value (`null`/`false`) — required because `pruneTree` already treats
those two as the same thing on disk (see above), so a merge that told them apart would treat a field
one side simply hasn't reached yet as a conflict against a value the other side actually wrote. This
is also what makes instance **removal** need no special handling at all: an entry one side deleted
reads as all-empty on that side, the field-level rule takes the empties (since the other side didn't
change it either), and the ordinary trailing-empty prune drops the now-trailing instance on the next
save — deletion falls out of the same rule that handles an ordinary edit.

**Papers merge by id**, in ours' own order followed by the papers only theirs has (in theirs' order).
A paper one side deleted and the other side *changed* is **kept**, with a note — a field-level UI has
no way to ask "keep or delete this whole paper", and the two failure directions are not symmetric (an
unwanted kept paper is one click from gone; deleted annotated work is simply gone). Only when the
side that kept the paper made no actual change to it does the deletion go through.

**`reviews` is never deleted by a merge** — only by both sides having already dropped a reviewer's
key, the same rule `normalizeReviews` already applies when `config.reviewers` is lowered (see above).
A reviewer's tree is someone's labour, which is why this is treated differently from a paper: a
project's papers are the project author's call; a reviewer's answers are not anyone else's to delete
by implication.

**`Paper.aiUsage` is a union, not a three-way merge**, and does not consult the base: it is an
append-only disclosure log with no delete operation the app exposes, so a record either side still
holds must survive regardless of what the merge base looked like — three-way logic could otherwise
drop a genuine disclosure and misreport how AI was used on a paper.

**`Paper.equal` is a set**, merged per-path the same way an ordinary field is (`merge3<boolean>` on
"does this path's mark include this reviewer's declaration"). A boolean has only two values, so "both
sides changed it, differently" cannot happen — a mark can never conflict.

**What refuses, rather than guessing.** A change to `version`, `config.schema`, `config.ai`,
`config.reviewers`, `config.screening`, or a root/paper `extra` key, made differently on both sides,
refuses the whole merge and names what could not be reconciled, instead of picking a field-level
answer for something that reshapes the file — most obviously the schema (and, for the same reason,
`config.screening`: whether a project screens at all, or its reason list, decides `config.schema` via
`screeningSchemaDefs`, so a difference there reshapes the file exactly as directly authoring a
different schema would). `Project.title` is not on this list: it is an ordinary string, a conflict
row expresses it perfectly, and refusing a whole merge over two people renaming the review would be
absurd.

A few more refuse, for reasons that are not "this reshapes the file": `provenance` and `protocol`
(each a nested record no `FieldConflict` shape can express — for `protocol`, refusing a two-sided
edit is also the safe choice, since half-dropping a reviewer's authored protocol is worse than
asking them to reconcile it; the common case of only one side ever setting either still resolves with
no refusal and no note) and
`config.reviewerIdentities.<seat>`, which refuses **per seat**, and only when the two sides record
**different emails** for that seat (compared via `sameIdentity`, which is email-only — a name-only
edit on the same email merges silently, never refuses). This is deliberately a refusal rather than a
conflict row: a conflict row can be clicked through without a second thought, and a click-through is
exactly how the chimeric reviews tree this mechanism exists to prevent would get built. See
`architecture.md`'s "Reviewer seat identity" for the hazard this closes.

**Testing**: `src/git/merge.test.ts` builds every base/ours/theirs through the real `loadProject`
(never a hand-assembled `Project`), so fixtures are exactly as schema-normalized and
empty-skeleton-shaped as `mergeProjects`' real caller hands it — and pins the field-level guarantee,
the interior-gap and instance-removal invariants, the multi-reviewer case, every refusal, the
`abstract`/`abstractFromPdf` merge and its resolve-order gap, and a full
`serializeProject`/`loadProject` round-trip of a resolved merge. A dedicated `describe` block covers
`config.reviewerIdentities`: two different emails on one seat refuses, a name-only difference on the
same email merges silently, and claiming a previously-free seat is an ordinary one-side-changed-it
merge.

**A separate, related question — what changed locally, for the commit panel** — is `src/git/changes.ts`'s
`detectFieldChanges`/`composeContents`, covered in `architecture.md`'s "Field-level commit review".
It reuses this section's field-identity shape but answers a genuinely different question: not "which
of two divergent copies wins", but "which of the working tree's own changes against HEAD does the
reviewer want to keep".

## Lifecycle: Load → Normalize → Edit → Prune → Serialize

### 1. Load (`loadProject` in `src/model/project.ts`)

1. Parse JSON text (or accept pre-parsed object)
2. Validate against `projectSchema` (zod) — rejects malformed structure with `ProjectLoadError` containing friendly details
3. `resolveSchema(screening ? screeningSchemaDefs(screening) : raw.config.schema)` — applies
   defaults, assigns ids, enforces uniqueness. For a screening project the schema is derived from
   `config.screening.reasons`, never read from `config.schema` — see "Screening" above
4. Check for duplicate paper IDs
5. For each paper: `normalizeTree(schema, p.annotations)` — reconcile annotation data against the schema
6. For each paper of a multi-reviewer project: `normalizeReviews(p.reviews, schema, reviewerCount)` —
   the same reconciliation per reviewer's tree, plus a fresh empty one for every reviewer `1..N` who
   doesn't have one yet (see "The empty skeleton is real data" above)
7. Extract `extra` fields (unknown keys at root and per-paper level) for preservation

### 2. Normalize (`normalizeTree` in `src/model/annotations.ts`)

Reconciles an existing (possibly partial or loaded) value tree against the schema:
- **Drop** keys not in the schema
- **Coerce** each present instance's structure to the def (ensure `value` for fields, `children` for groups)
- **Pad** up to `max(min, 1)` instances with fresh `makeInstance()` calls
- **Clamp** down to `max` if exceeded

`makeInstance(def)` builds a single fresh instance: `emptyValue()` for fields, `initTree(def.children)` for children. `initTree(defs)` creates `max(min, 1)` instances per sibling.

### 3. Edit (in the Zustand store)

The store actions `setFieldValue`, `addInstance`, and `removeInstance` mutate the annotation tree via immer. They navigate to the correct container using `containerAt(root, path)` which follows a `PathSeg[]` path (name + index pairs). Each mutation sets `dirty = true` and pushes an undo snapshot onto the store's `past` stack (consecutive edits to the same field coalesce into one step) — see `undo()` / `redo()` in the architecture page.

Cardinality guards:
- `canAdd(def, current)` — true if `def.max === null` or `current < def.max`
- `canRemove(def, current)` — true if `current > max(def.min, 1)`

### 4. Prune (`pruneTree` in `src/model/annotations.ts`)

Called during serialization. For each node:
- Keep the first `max(min, 1)` instances unconditionally
- Drop the empty instances **trailing** the end of the list (so saved files stay tidy)
- Keep an empty instance that has a filled one after it — position carries meaning. Consolidation
  records which of each reviewer's entries are the same entry by lining their lists up
  (`src/consolidate/apply.ts`), and a reviewer with no entry for the second slot holds an empty one
  there. Closing that gap would slide every later entry down a slot and silently re-point the
  alignment on the next load
- An instance is "empty" (`isEmptyInstance`) if its field value is falsy (boolean: `false`; others: `null`/`undefined`/`""`) AND all recursive children are empty

### 5. Serialize (`serializeProject` in `src/model/project.ts`)

1. Spread `project.extra` (unknown top-level fields first)
2. Write `version`, `config` (dehydrated schema), `papers`
3. For each paper: spread `paper.extra`, write known fields, then `pruneTree(schema, annotations)`
4. `dehydrateSchema()` converts `ResolvedDef[]` back to compact `AnnotationDef[]` (omits defaults: `min: 1`, `max: 1` are not written back)
5. Output is `JSON.stringify(out, null, 2)` — pretty-printed with 2-space indent

## Reference import: what a malformed file costs

The parsers' contract is that a malformed *entry* is skipped — not that a
malformed entry takes the rest of the file with it. Three ways that was violated,
all of them silent:

- **An entry written outside a list** (`"Study Type": "RCT"`, or a lone
  `{"value": "RCT"}`, where the format wants `["RCT"]`) is adopted as that one
  entry rather than dropped. Dropping it opened the file cleanly and let the
  next ordinary save write `null` over a real answer — the same hazard
  `normalizeInstance` already guards for a bare primitive *inside* the list.
  `null` and an absent key still mean no answer.
- **A RIS file with no `ER` lines** kept only its last record, because starting a
  new record overwrote the one in progress. Records are now finalized when the
  next `TY` arrives, the same rescue the final record already had.
- **RIS continuation lines** (a long value wrapped onto following lines with no
  tag of its own) were dropped, truncating a title mid-sentence — which then also
  changed how duplicate detection scored it. Only the prose fields are joined: a
  line after `AU` is a new author rather than more of the last one, and gluing a
  stray line onto a DOI would corrupt an identifier.
- **One unbalanced BibTeX brace** consumed everything after it, so a 500-entry
  export with a malformed third entry imported three papers and reported success.
  The scan now resyncs to the next `@` at a line start.

Duplicate classification has a related rule worth knowing: an **exact title match
with no author in common is `probable`, not `certain`**. Titles like
"Introduction" and "Editorial" recur across a proceedings-heavy corpus, and a
`certain` match merges without asking — `fillFromRef` then writes one paper's
DOI, year and venue onto the other, which is a wrong record rather than a missing
one. Complete disjointness only, so a shortened author list ("et al.") or
initials still shares a surname and stays `certain`; an empty author list on
either side abstains rather than voting against, the same rule the base-title
tier already followed.

## Values a reviewer types are text, never structure

A recurring question is whether an annotation value containing JSON
metacharacters — a quote, a brace, a backslash — can break the file the way a
quote breaks a naively built SQL query. It cannot. Values go through
`JSON.stringify`, which escapes them, so a value can never close the string it
lives in and start a new key. `src/model/jsonvalues.test.ts` pins this down with
quotes, braces, backslashes, a deliberate `"}, "papers": [], "evil": "`, control
characters, a lone surrogate and `__proto__` as a value, all round-tripping
byte-exactly. There is also no CSV or spreadsheet export, so the
formula-injection risk that usually comes with one (`=cmd|…` executing when the
file is opened in Excel) does not arise — worth knowing if an export is ever
added.

**The risk that is real is elsewhere: anywhere a value is used as *structure*.**
Three places in this codebase do that, and each needs its own defence:

- **Object keys.** A value used as a key means `__proto__`, `constructor` and
  `toString` behave differently from ordinary strings. The screening reason
  tallies (`byReason`, `excludedByReason`) are `Object.create(null)` for exactly
  this reason; `metrics.ts` counts in `Map`s, which are immune; `disagreements.ts`
  keys by reviewer id rather than by value.
- **Cache keys joined with a separator.** `stringSimilarity`'s pair cache prefixes
  the key with the first string's length, because joining with a separator alone
  assumes that separator cannot occur inside a value — and no character
  satisfies that. It previously used a bare NUL, and a value containing one made
  two different pairs share a cache entry: a pair of identical strings scored
  0.2 instead of 1.0, aligning a perfect match as though it barely matched.
- **Canonical paths built from field names.** See `formatPath`/`parsePath` — an
  ambiguous encoding there does not corrupt the file, it resolves to a *different
  field*, so a committed answer lands on the wrong one. `/`, `[`, `]` and `\` are
  escaped; **leading and trailing whitespace deliberately is not**, because
  changing the format would strand every canonical already stored under the old
  spelling. Instead `resolveSchema` refuses a schema whose sibling names differ
  only by surrounding spaces — the one point where that ambiguity can still be
  caught, since once both names exist no path can name one of them — and
  `resolvePath` resolves a *lone* padded name through a trimmed fallback, which
  is safe precisely because of that refusal.
- **The LLM prompt.** Field names, descriptions and enum options are
  user-authored and land in a section structured by line breaks and `-` bullets,
  so `prompt.ts` flattens each to one line and JSON-quotes the options. Screening
  exclusion reasons become enum options, so this is ordinary reviewer content in
  a structural position, not just a hostile file.

`conflictId` (`git/merge.ts`) is the pattern to copy when adding another
composite key: it `JSON.stringify`s its parts rather than joining them, so no
part can impersonate a delimiter.

## Error Handling

`ProjectLoadError` (`src/model/project.ts`) extends `Error` with a `details: string[]` array. It is thrown for:
- Invalid JSON
- **Nesting deeper than `MAX_JSON_DEPTH` (200 levels)** — checked by `exceedsDepth` on the raw data
  *before* anything walks it
- Zod validation failures (issues mapped to `"path: message"` strings)
- Schema resolution errors (duplicate names, max < min, no type/children, `__proto__`, the instance
  budget above)
- Duplicate paper IDs

The store catches these and sets `loadError` state, which `ErrorPanel` displays as a modal overlay.

**Why the depth check comes first.** Nearly every traversal in the app is recursive — zod's own
validation, `resolveDefs`, `normalizeTree`, `deepEqualJson`, `serializeProject` — and each gives out
somewhere between a few hundred and a few thousand levels. A ~29 KB file nested 704 deep made
`projectSchema.parse` throw a raw `RangeError`, which escapes this function's "throws
`ProjectLoadError` with friendly details" contract and lands in the store's generic fallback. One
check at the entrance covers all of them. It matters for unknown keys in particular: those are passed
through verbatim into `extra`, so their depth is otherwise unbounded and surfaces later in
`deepEqualJson` — which crashes the **read-only git-status path**, not just save. `exceedsDepth` is
iterative, so it cannot itself overflow on the input it exists to reject, and a `RangeError` escaping
the zod parse is still converted as a backstop.

200 is far above anything real: the annotation tree costs 3 JSON levels per schema nesting level, so
the limit allows 64 levels of schema nesting against a real-world 2–4.

## Testing

`src/model/model.test.ts` uses Vitest to test the model layer (and `src/state/store.test.ts` covers the store's undo/redo history):
- Schema resolution (defaults, ids, duplicate detection, max < min, repeatable detection)
- Annotation tree init (min instances, default values, nested structure)
- Add/remove guards (canAdd/canRemove with unbounded, finite, and min floor)
- Normalize (padding, clamping, dropping unknown keys)
- Full round-trip (load → edit → serialize → reload, preserving data)
- Extra/unknown field preservation
- Prune (trailing empty removal, min retention, interior gaps kept)
- Multiple reviewers: `config.reviewers` defaults/bounds/round-trip, `Paper.reviews` parsing (defensive, normalized, malformed/non-numeric keys dropped) and backfilling (every reviewer `1..N` present as an empty skeleton, an out-of-range key never dropped), serialization staying clean for a single-reviewer project (see the `"multiple reviewers"` describe block in `model.test.ts`)
- `needsShapeMigration`/the auto-migrate-on-open path: an old-shape file gets fixed and re-saved through a real handle, never through a `'download'` or `null` one, and is stable (no re-migration, byte-identical re-serialization) once fixed — verified end-to-end against real files on disk, not just mocked platform calls

`src/state/store.reviewers.test.ts` covers the routing rule (`currentTree`) itself: which tree each store action reads/writes for single-reviewer, a numbered reviewer, Consolidation, and the unselected state; that selecting a reviewer is not an undo step and doesn't set `dirty`; and that the selection persists per project (a `describe` block also covers claiming a seat via a git identity, and `takeSeat`'s explicit-override path — see `architecture.md`'s "Reviewer seat identity"). `src/state/store.aimarks.test.ts` covers the reviewer-scoped AI mark keys specifically.

`src/model/hostile.test.ts` covers the load-time refusals specifically, from the attacker's side
rather than the schema author's: a flat enormous `min`, nested `min`s that multiply, deep nesting in
the schema, and deep nesting under an *unknown* key (the `extra` passthrough) — each asserting a
`ProjectLoadError` rather than a crash — plus a deliberately generous legitimate schema that must
still load, so the limits cannot be tightened into rejecting real work without a test failing.

Several newer pure modules have their own dedicated test files: `src/model/year.test.ts` (`parseYear`/`isPlausibleYear` boundaries and string-scanning behavior), `src/model/duplicates.test.ts` (`classifyImport`'s four-tier priority, the year-gap veto, author-surname Dice edge cases, and a differential test that the cheap cost-guard agrees pair-for-pair with an unguarded reference), `src/model/identity.test.ts` (`sameIdentity`'s email-only truth table, `checkSeat`), and `src/model/completeness.test.ts` (the required-only-when-declared denominator rule, boolean exclusion, per-instance counting for repeatables). One honest gap as of this writing: `Paper.year`/`Paper.venue` themselves are pinned down at the parsing/validation layer (`year.test.ts`, `references.test.ts`), but the git-layer behavior described above — `merge.ts`'s conflict handling, `changes.ts`'s field-level review row, and `similarity.ts`'s identity-not-magnitude scoring — has no dedicated test coverage yet.

**Screening** has its own set of test files, mirroring the `src/consolidate/*.test.ts` convention
(pure functions, no React, no store imports): `src/screening/schema.test.ts` (the derived schema's
exact shape, reasons flowing into `Reason.options` in order), `src/screening/status.test.ts` (the
tri-state read, including a hand-edited unknown decision reading as `undecided`), `counts.test.ts`
(the totals, the per-reason breakdown including zero-count reasons, `pendingUnanimous`), and
`validate.test.ts` (the two cross-field rules). `src/state/store.screening.test.ts` covers
`setScreeningDecision`'s seat routing, undo-step shape, the reason-clearing-on-decision-change and
auto-advance rules, and `adoptAllUnanimousScreening`. `src/state/editorStore.screening.test.ts`
covers `buildProjectJson`/`validateDraft` for a screening draft and the
`startFromScreening`/`resolveScreeningImport` partition-and-carry logic, including the
never-drop-on-uncertainty rule for a hand-edited unknown decision. `src/model/model.test.ts`'s
`describe('screening')` block covers the file-format round-trip, including the single most
important assertion in it: **a single-reviewer, non-screening project serializes byte-for-byte
identically to before this feature existed.**

## Change Guidance

- **Adding a field type**: Update `FieldType` in `schema.ts` → `fieldTypeSchema` zod enum → `emptyValue()` in `annotations.ts` → `isEmptyInstance()` logic → `Field.tsx` rendering. Add a test in `model.test.ts`. `year` (`src/model/year.ts`) is a worked example of the cheapest version of this: it needed no `emptyValue()`/`isEmptyInstance()` change at all, since it rides the same JSON-number `FieldValue` shape a plain `number` already has — only `validate.ts` (a real range check instead of "is this a number"), `Field.tsx` (rendering + PDF-grab), and `SchemaTreeEditor.tsx` (the kind picker) needed to know about it.
- **Changing schema validation**: Modify the zod schema in `schema.ts` or the `superRefine` logic. Resolution-time checks (sibling uniqueness) are in `resolveDefs()`.
- **Changing serialization format**: Update `serializeProject()` and `dehydrateSchema()`. Ensure `loadProject()` remains backward-compatible or bump `version`. Always run the round-trip test.
- **Adding new known paper/project fields**: Add to the known keys sets (`KNOWN_PAPER_KEYS`, `KNOWN_ROOT_KEYS`) in `project.ts` and to the `Paper`/`Project` interfaces. Update `serializeProject` output.
- **Touching anything that reads or writes `paper.annotations` directly**: check whether it should instead go through `currentTree()` in `store.ts` — almost everything that acts on "the current paper's data" should, so a multi-reviewer project's numbered reviewers and Consolidation all see the right tree. Grep for `.annotations` across `src/` when in doubt.
- **Touching the screening schema or its counts**: the pure logic lives entirely in `src/screening/` (`schema.ts` derives the two-node schema, `status.ts` reads the tri-state, `counts.ts` aggregates, `validate.ts` has the two cross-field rules) — extend it there, with a test in the matching `*.test.ts`, rather than special-casing screening inside `model/`, `consolidate/`, or `state/store.ts`. Those three are meant to stay screening-agnostic; screening reuses them by presenting a two-field schema, not by teaching them what screening is.
