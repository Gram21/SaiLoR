# Data Model

This page describes the project file format, the in-memory data structures, and the full lifecycle from loading to saving.

## Project File Format

A project is a single JSON file with this shape:

```jsonc
{
  "version": 1,
  "config": {
    "schema": [ /* AnnotationDef[] — the taxonomy */ ],
    "ai": false  // optional; false disables AI-assisted annotation for this project
  },
  "papers": [ /* Paper[] */ ],
  // any other top-level keys are preserved verbatim on save
}
```

`config.ai` defaults to `true`. When `false`, the ✦ AI button is disabled (with a hover note that
the provider turned it off); the loader reads it into `Project.aiEnabled`, and `serializeProject`
writes it back only when disabled, so a normal file stays clean. The project editor edits it as a
checkbox.

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
  "annotations": {},          // filled in as you annotate
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
  papers: Paper[]
  extra: Record<string, unknown>  // unknown top-level fields preserved
}

interface Paper {
  id: string
  title: string
  authors: string[]
  doi?: string
  pdf: string
  annotations: AnnotationValueTree
  extra: Record<string, unknown>  // unknown per-paper fields preserved
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

## Lifecycle: Load → Normalize → Edit → Prune → Serialize

### 1. Load (`loadProject` in `src/model/project.ts`)

1. Parse JSON text (or accept pre-parsed object)
2. Validate against `projectSchema` (zod) — rejects malformed structure with `ProjectLoadError` containing friendly details
3. `resolveSchema(raw.config.schema)` — applies defaults, assigns ids, enforces uniqueness
4. Check for duplicate paper IDs
5. For each paper: `normalizeTree(schema, p.annotations)` — reconcile annotation data against the schema
6. Extract `extra` fields (unknown keys at root and per-paper level) for preservation

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
- For instances beyond the minimum, drop trailing empty ones (so saved files stay tidy)
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
- Prune (trailing empty removal, min retention)

## Change Guidance

- **Adding a field type**: Update `FieldType` in `schema.ts` → `fieldTypeSchema` zod enum → `emptyValue()` in `annotations.ts` → `isEmptyInstance()` logic → `Field.tsx` rendering. Add a test in `model.test.ts`.
- **Changing schema validation**: Modify the zod schema in `schema.ts` or the `superRefine` logic. Resolution-time checks (sibling uniqueness) are in `resolveDefs()`.
- **Changing serialization format**: Update `serializeProject()` and `dehydrateSchema()`. Ensure `loadProject()` remains backward-compatible or bump `version`. Always run the round-trip test.
- **Adding new known paper/project fields**: Add to the known keys sets (`KNOWN_PAPER_KEYS`, `KNOWN_ROOT_KEYS`) in `project.ts` and to the `Paper`/`Project` interfaces. Update `serializeProject` output.
