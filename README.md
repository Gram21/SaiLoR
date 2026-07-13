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

## Building & testing

```bash
npm run build            # static SPA into dist/ (host anywhere)
npm run build:electron   # desktop installers into release/ (via electron-builder)
npm test                 # unit tests (model: schema, normalize, round-trip)
npm run typecheck
```

## Deployment

### A. Browser variant — static hosting

`npm run build` emits a self-contained static site in `dist/`. Serve that folder from any static
host (nginx, Apache, S3/CloudFront, GitHub Pages, …). The build uses a relative base, so it also
works from a subpath.

Place each project JSON next to its `pdfs/` folder on the same host and link to it with
`?project=<url>` — the app fetches the JSON and resolves its PDFs relative to that URL:

```
https://your.host/?project=/reviews/2026/project.json
```

Users can also just click **Open…** in the app to load a local JSON from their own machine.

### B. Browser variant — Docker (recommended for self-hosting)

A multi-stage [`Dockerfile`](Dockerfile) builds the SPA and serves it with nginx; the
[`docker-compose.yml`](docker-compose.yml) wires up the port and a projects volume.

```bash
# Build and start (serves on http://localhost:8080)
docker compose up -d --build

# Stop
docker compose down
```

Drop your project JSON files and their PDFs into the `./projects/` folder on the host (mounted
read-only into the container at `/projects`). An example project ships there already, so once the
container is up you can open:

```
http://localhost:8080/?project=/projects/project.example.json
```

Layout of the projects volume:

```
projects/
  my-review.json          # references pdfs/paperX.pdf (paths relative to the JSON)
  pdfs/
    paperX.pdf
```

Change the published port by editing the `ports:` mapping in `docker-compose.yml` (default
`8080:80`). To build/run the image without Compose:

```bash
docker build -t slr-helper .
docker run -d -p 8080:80 -v "$PWD/projects:/usr/share/nginx/html/projects:ro" slr-helper
```

> The browser variant is read-only on the server: saving happens client-side (File System Access
> API or a download), never written back to the container — hence the read-only mount.

### C. Desktop variant — Electron installers

`npm run build:electron` runs `electron-builder` and produces native installers in `release/`
(the `build` block in [`package.json`](package.json) targets `dmg` on macOS, `nsis` on Windows,
`AppImage` on Linux). Build on (or cross-build for) each target OS as needed. The desktop app reads
local PDF files directly, so no server is involved.

## Architecture

- `src/model/` — schema types + zod validation, project load/normalize/serialize, annotation
  instance-tree helpers (unit-tested).
- `src/platform/` — a `PlatformAdapter` seam so the UI is identical in Electron and the browser
  (`electron.ts` = IPC + `slr-file://` protocol; `browser.ts` = File System Access API / fetch).
- `src/state/store.ts` — Zustand + immer store.
- `src/components/` — Toolbar, PaperList, PdfViewer, AnnotationPanel/Node/Field.
- `electron/` — thin main process (BrowserWindow, Edit-role menu, dialog/fs IPC, PDF protocol) and
  a context-isolated preload.
