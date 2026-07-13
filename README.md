# SLR Helper

A tool to assist reviewers during **Systematic Literature Reviews (SLR)**. Open a single JSON
"project" file that holds both an annotation schema (a nested, cardinality-controlled taxonomy)
and the papers to annotate. Read each paper's PDF, fill in typed annotation fields — optionally
grabbing values straight from selected PDF text — and save the annotations back into the JSON.

The same codebase runs two ways:

- **Desktop app** (Electron) — fully local, opens local PDF files, native Open/Save dialogs.
- **Web app** — a static build you can host on any server (or open locally in a Chromium browser).

## Quick start

```bash
npm install

# Web development (browser):
npm run dev
# then open http://localhost:5173

# Desktop app (Electron) in dev:
npm run dev:electron
```

Open the bundled example from the browser dev server via:
`http://localhost:5173/?project=/samples/project.example.json`

## Project file format

```jsonc
{
  "version": 1,
  "config": {
    "schema": [
      { "name": "Relevant", "type": "boolean" },        // leaf field
      { "name": "Study Type", "type": "string", "min": 1, "max": 1 },
      { "name": "Year", "type": "number" },
      {
        "name": "Findings", "min": 1, "max": null,       // group, repeatable (unbounded)
        "children": [
          { "name": "Claim", "type": "string" },
          { "name": "Evidence", "type": "string" },
          { "name": "Confidence", "type": "number" }
        ]
      }
    ]
  },
  "papers": [
    {
      "id": "paper-a",
      "title": "…",
      "authors": ["…"],
      "doi": "10.1000/xyz",         // optional
      "pdf": "pdfs/paper-a.pdf",    // path relative to this JSON file
      "annotations": {}             // filled in as you annotate
    }
  ]
}
```

**Annotation nodes** (`config.schema[]`):

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Display label (required). Sibling names must be unique.                 |
| `type`        | `string` \| `number` \| `boolean`. Omit for a group (name-only) node.   |
| `children`    | Sub-taxonomy. A node may have `type`, `children`, or both.              |
| `min`         | Minimum occurrences (default `1`).                                      |
| `max`         | Maximum occurrences: a number, or `null` for unbounded (default `1`).   |
| `description` | Optional tooltip.                                                       |

**Annotation data** mirrors the schema: at each level a map keyed by node name, where every key
holds an array of instances (bounded by `min`/`max`). Each instance carries a `value` (for fields)
and/or nested `children`. Saving prunes trailing empty optional instances and leaves `config`
untouched. Unknown top-level and per-paper fields are preserved verbatim.

## Using the app

- **Left pane** — collapsible list of papers (toggle with the ☰ button). A green dot marks papers
  that already have annotations. Click a paper to open it.
- **Middle pane** — the paper's PDF, rendered with a selectable text layer.
- **Right pane** — the annotation form, laid out by the taxonomy. Repeatable nodes show **+ Add**
  (up to `max`) and a remove (**×**) control (down to `min`).
- **Grab from PDF** — select text in the PDF, then click the **⧉** button next to a string/number
  field to insert it (numeric fields extract the first number).

### Keyboard shortcuts

| Shortcut                | Action              |
| ----------------------- | ------------------- |
| `Ctrl/Cmd + S`          | Save                |
| `Ctrl/Cmd + Shift + S`  | Save as…            |
| `Alt + ↓` or `]`        | Next paper          |
| `Alt + ↑` or `[`        | Previous paper      |
| `Ctrl/Cmd + C/V/X/Z`    | Native copy/paste/… |

## Saving

- **Desktop**: writes to the opened file's path; **Save as** opens a native dialog.
- **Browser (Chromium)**: uses the File System Access API to save in place / to a new file.
- **Browser (other)**: downloads the updated JSON.

## Building

```bash
npm run build            # static SPA into dist/ (host anywhere)
npm run build:electron   # desktop installers into release/ (via electron-builder)
npm test                 # unit tests (model: schema, normalize, round-trip)
npm run typecheck
```

### Server deployment

Copy `dist/` behind any static host, and place the project JSON + its `pdfs/` alongside. Link to a
hosted project with `?project=<url>` (PDFs resolve relative to that URL), e.g.
`https://your.host/?project=/reviews/2026/project.json`.

## Architecture

- `src/model/` — schema types + zod validation, project load/normalize/serialize, annotation
  instance-tree helpers (unit-tested).
- `src/platform/` — a `PlatformAdapter` seam so the UI is identical in Electron and the browser
  (`electron.ts` = IPC + `slr-file://` protocol; `browser.ts` = File System Access API / fetch).
- `src/state/store.ts` — Zustand + immer store.
- `src/components/` — Toolbar, PaperList, PdfViewer, AnnotationPanel/Node/Field.
- `electron/` — thin main process (BrowserWindow, Edit-role menu, dialog/fs IPC, PDF protocol) and
  a context-isolated preload.
