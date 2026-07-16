# Data Model

This page describes the project file format, the in-memory data structures, and the full lifecycle from loading to saving.

## Project File Format

A project is a single JSON file with this shape:

```jsonc
{
  "version": 1,
  "config": {
    "schema": [ /* AnnotationDef[] — the taxonomy */ ],
    "ai": false,       // optional; false disables AI-assisted annotation for this project
    "reviewers": 3     // optional; >1 turns on independent multi-reviewer annotation
  },
  "papers": [ /* Paper[] */ ],
  // any other top-level keys are preserved verbatim on save
}
```

`config.ai` defaults to `true`. When `false`, the ✦ AI button is disabled (with a hover note that
the provider turned it off); the loader reads it into `Project.aiEnabled`, and `serializeProject`
writes it back only when disabled, so a normal file stays clean. The project editor edits it as a
checkbox.

`config.reviewers` defaults to `1` (single-reviewer — every paper carries one `annotations` tree
and nobody picks a reviewer). A value from 2 to 10 turns on independent multi-reviewer annotation:
each reviewer 1..N annotates into their own tree (`Paper.reviews["N"]`), and a built-in
**Consolidation** role (not counted in `reviewers`) reconciles them into `Paper.annotations`, which
remains the single, final result — see "Multiple reviewers & Consolidation" below.
`serializeProject`/`buildProjectJson` write `config.reviewers` only when it is greater than 1, so a
single-reviewer file is unaffected byte-for-byte. The project editor edits it as a checkbox +
number field next to the AI opt-out.

### AnnotationDef (`src/model/schema.ts`)

Each schema node defines a field or group in the taxonomy:

| Property | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | Display label; must be unique among siblings |
| `type` | no | (group) | `"string"` \| `"number"` \| `"boolean"`. Omit for a name-only group node |
| `children` | no | `[]` | Sub-taxonomy. A node may have `type`, `children`, or both |
| `min` | no | `1` | Minimum occurrences |
| `max` | no | `1` | Max occurrences: a positive integer, or `null` for unbounded |
| `options` | no | — | Array of strings on a `string` field → renders as a filterable enum dropdown (ComboBox). Only valid when `type` is `"string"` |
| `description` | no | — | Optional tooltip text |

**Validation rules** (enforced by zod in `annotationDefSchema`):
- `name` must be a non-empty string
- `max` must be ≥ `min` (when `max` is not `null`)
- A node must have a `type` or non-empty `children` (a name-only node with neither is rejected)
- `options` is only allowed on a `type: "string"` node; using it on any other type (or a group) is a schema error
- Sibling names must be unique (enforced during resolution, not zod)

### Paper

```jsonc
{
  "id": "paper-a",            // unique across all papers
  "title": "…",
  "authors": ["…"],           // defaults to []
  "doi": "10.1000/xyz",       // optional
  "pdf": "pdfs/paper-a.pdf",  // path relative to the project JSON file
  "annotations": {},          // the consolidated result — filled in as you annotate
  "reviews": {                // optional; each independent reviewer's own tree, multi-reviewer only
    "1": { /* AnnotationValueTree */ },
    "2": { /* AnnotationValueTree */ }
  },
  // any other keys preserved verbatim on save
}
```

The `samples/project.example.json` file shows a complete working example with a schema containing boolean, string, number, repeatable group, and bounded group nodes.

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
  aiEnabled: boolean              // config.ai; true unless the file opts out
  reviewers: number                // config.reviewers; 1 (default) = single-reviewer
  papers: Paper[]
  extra: Record<string, unknown>  // unknown top-level fields preserved
}

interface Paper {
  id: string
  title: string
  authors: string[]
  doi?: string
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

## Lifecycle: Load → Normalize → Edit → Prune → Serialize

### 1. Load (`loadProject` in `src/model/project.ts`)

1. Parse JSON text (or accept pre-parsed object)
2. Validate against `projectSchema` (zod) — rejects malformed structure with `ProjectLoadError` containing friendly details
3. `resolveSchema(raw.config.schema)` — applies defaults, assigns ids, enforces uniqueness
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

## Error Handling

`ProjectLoadError` (`src/model/project.ts`) extends `Error` with a `details: string[]` array. It is thrown for:
- Invalid JSON
- Zod validation failures (issues mapped to `"path: message"` strings)
- Schema resolution errors (duplicate names, max < min, no type/children)
- Duplicate paper IDs

The store catches these and sets `loadError` state, which `ErrorPanel` displays as a modal overlay.

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

`src/state/store.reviewers.test.ts` covers the routing rule (`currentTree`) itself: which tree each store action reads/writes for single-reviewer, a numbered reviewer, Consolidation, and the unselected state; that selecting a reviewer is not an undo step and doesn't set `dirty`; and that the selection persists per project. `src/state/store.aimarks.test.ts` covers the reviewer-scoped AI mark keys specifically.

## Change Guidance

- **Adding a field type**: Update `FieldType` in `schema.ts` → `fieldTypeSchema` zod enum → `emptyValue()` in `annotations.ts` → `isEmptyInstance()` logic → `Field.tsx` rendering. Add a test in `model.test.ts`.
- **Changing schema validation**: Modify the zod schema in `schema.ts` or the `superRefine` logic. Resolution-time checks (sibling uniqueness) are in `resolveDefs()`.
- **Changing serialization format**: Update `serializeProject()` and `dehydrateSchema()`. Ensure `loadProject()` remains backward-compatible or bump `version`. Always run the round-trip test.
- **Adding new known paper/project fields**: Add to the known keys sets (`KNOWN_PAPER_KEYS`, `KNOWN_ROOT_KEYS`) in `project.ts` and to the `Paper`/`Project` interfaces. Update `serializeProject` output.
- **Touching anything that reads or writes `paper.annotations` directly**: check whether it should instead go through `currentTree()` in `store.ts` — almost everything that acts on "the current paper's data" should, so a multi-reviewer project's numbered reviewers and Consolidation all see the right tree. Grep for `.annotations` across `src/` when in doubt.
