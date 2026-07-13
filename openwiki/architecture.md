# Architecture

## Overview

SLR Helper is a single-codebase React app that runs as both an Electron desktop application and a static web SPA. The key architectural seam is the **PlatformAdapter** interface, which abstracts all file I/O and PDF loading so the React UI is identical in both runtimes.

## Platform Adapter Pattern

The entire file-system and PDF-loading layer is abstracted behind a single interface:

```
src/platform/adapter.ts  →  PlatformAdapter interface
src/platform/index.ts    →  getPlatform() singleton factory
src/platform/electron.ts →  ElectronAdapter
src/platform/browser.ts   →  BrowserAdapter
```

**`PlatformAdapter`** (`src/platform/adapter.ts`) defines four operations:
- `openProject()` — show an open dialog/picker, return JSON text + a `SaveHandle`
- `saveProject(text, handle)` — write back to the handle's location
- `saveProjectAs(text, suggestedName)` — prompt for new location and write
- `getPdfSource(pdfPath, projectHandle)` — resolve a paper's relative PDF path into a URL react-pdf can load

`getPlatform()` (`src/platform/index.ts`) returns a singleton: `ElectronAdapter` if `window.slr` exists (preload bridge), otherwise `BrowserAdapter`. Detection uses `isElectron()` which checks for the preload-bridged `window.slr` object.

### ElectronAdapter (`src/platform/electron.ts`)

Delegates to `window.slr` (the preload bridge). File operations use IPC to the main process. PDFs are served via the custom `slr-file://project/<encoded-path>` protocol — the main process resolves paths relative to the project directory. `setProjectDir` is called on open/save-as so the protocol knows the base directory.

### BrowserAdapter (`src/platform/browser.ts`)

Has three tiers of capability:

| Capability | Chromium (FSAPI) | Other browsers | Server mode |
|---|---|---|---|
| Open | `showOpenFilePicker` — in-place handle retained | Hidden `<input type=file>` | `fetch(url)` via `?project=` |
| Save | `createWritable` on retained handle | Download blob | Download blob |
| Save as | `showSaveFilePicker` | Download blob | Download blob |
| PDF loading | One-time directory grant via `showDirectoryPicker`, blob URL | `fetch` relative to page | `fetch` relative to project URL |

`setServerBase(url)` records the URL a project was fetched from so sibling PDFs resolve correctly in server mode. The adapter stores `FileSystemFileHandle` references in an internal map keyed by generated IDs.

## State Management

The entire app state lives in a single Zustand store with immer middleware:

**`src/state/store.ts`** → `useStore`

### State Shape

| Field | Type | Purpose |
|---|---|---|
| `project` | `Project \| null` | The loaded, normalized project (schema + papers) |
| `currentPaperId` | `string \| null` | Currently selected paper |
| `saveHandle` | `SaveHandle \| null` | Where to write back (path, FSAPI handle id, or download) |
| `projectName` | `string` | Display name for title bar |
| `dirty` | `boolean` | Unsaved changes flag; gates `beforeunload` guard |
| `loadError` | `LoadError \| null` | Error overlay data |
| `busy` | `boolean` | Disables toolbar buttons during async operations |
| `sidebarCollapsed` | `boolean` | Paper list visibility |
| `pdfSelection` | `string` | Latest text selected in the PDF viewer (for "grab from PDF") |

### Key Actions

- **`openProject()`** — delegates to `platform.openProject()`, then `loadFromText()`
- **`loadFromUrl(url)`** — `fetch` the project JSON, set `serverBase` on browser adapter, then `loadFromText()`
- **`loadFromText(text, handle, name)`** — calls `loadProject(text)` from the model layer, sets state, selects first paper
- **`save()` / `saveAs()`** — `serializeProject(project)` → delegate to platform, clears `dirty`
- **`selectPaper(id)`** — switches paper, clears `pdfSelection`
- **`setFieldValue(path, name, index, value)`** — navigates the annotation tree via `containerAt()`, sets `inst.value`, marks dirty
- **`addInstance(path, def)` / `removeInstance(path, name, index)`** — manages repeatable annotation instances, respects `max`/`min`

The `containerAt(root, path)` helper walks the annotation tree following `PathSeg[]` (name + index pairs) to reach the container for a given path.

## Component Tree

```
App (src/App.tsx)
├── Toolbar (src/components/Toolbar.tsx)
│     Open / Save / Save-as buttons, sidebar toggle, project name + dirty dot
├── [if project loaded: workspace]
│   ├── PaperList (src/components/PaperList.tsx)
│   │     List of papers; green dot if hasAnnotations(); click to select
│   ├── PdfViewer (src/components/PdfViewer.tsx)
│   │     react-pdf Document+Page; ResizeObserver for width; captures text selection
│   └── AnnotationPanel (src/components/AnnotationPanel.tsx)
│         └── AnnotationNode (src/components/AnnotationNode.tsx) [recursive]
│               └── Field (src/components/Field.tsx)
│                     Input control + ⧉ grab-from-PDF button
├── [if no project: welcome screen with "Open project…" button]
└── ErrorPanel (src/components/ErrorPanel.tsx)
      Modal overlay for load/save errors
```

### AnnotationNode (recursive renderer)

`AnnotationNode` is the core recursive component. Given a `ResolvedDef` and a `container` (`AnnotationValueTree`), it:

1. For a **single non-repeatable leaf** — renders one `Field` on a single row (the common case).
2. For **repeatable or group nodes** — renders a header with "+ Add" button (if repeatable), then iterates instances. Each instance shows a remove ("×") control (if repeatable), an optional field, and recursively renders children with an extended `path`.

The `path` (`PathSeg[]`) is extended at each nesting level: `[...path, { name: def.name, index: i }]`. This path is passed to store actions to navigate the tree.

### Field component

`Field` renders the appropriate input based on `def.type`:
- `boolean` → checkbox
- `number` → `<input type=number>`
- `string` → `<input type=text>`

The **grab-from-PDF** button (⧉) reads `useStore.getState().pdfSelection` and inserts it. For number fields, it extracts the first numeric token via `parseNumber()` (handles comma decimals).

### PdfViewer

Uses `react-pdf`'s `Document` + `Page` components. The pdf.js worker is loaded from the bundled dependency URL. A `ResizeObserver` tracks container width so pages scale to fit. Text selection is captured via `onMouseUp`/`onKeyUp` → `window.getSelection()` → `setPdfSelection()`.

PDF source resolution is async: `getPlatform().getPdfSource(paper.pdf, saveHandle)` returns a `{ url, revoke? }`. The effect cleans up (revokes blob URLs) on paper/handle change or unmount.

## Electron Main Process

**`electron/main.ts`** is a thin main process:

- **Window**: 1400×900 `BrowserWindow`, context isolation enabled, node integration disabled, preload script loaded.
- **Dev vs prod**: loads `VITE_DEV_SERVER_URL` in dev, `dist/index.html` in production.
- **`slr-file://` protocol**: registered as privileged (secure, stream, fetch API). Handler resolves paths relative to `projectDir` with traversal guard (`path.resolve` + prefix check). Returns 403 for traversal attempts, 404 for missing files.
- **IPC handlers**:
  - `project:open` — `dialog.showOpenDialog` → `readFile`
  - `project:save` — `writeFile` to given path
  - `project:saveAs` — `dialog.showSaveDialog` → `writeFile`
  - `project:setDir` — sets `projectDir` from the project file's directory
- **Menu**: minimal template with File, Edit, View, Window menus (keeps standard copy/paste/undo shortcuts).

**`electron/preload.ts`** uses `contextBridge.exposeInMainWorld('slr', ...)` to expose four IPC-backed methods. This `window.slr` object is the detection signal for `isElectron()`.

## Hooks

- **`useKeybindings`** (`src/hooks/useKeybindings.ts`): Global keyboard shortcuts registered on `window.keydown`. Handles save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), paper navigation (Alt+↓/↑, `[`/`]`). Paper navigation skips when typing in a field (unless Alt is held). Copy/cut/paste/undo are left to the browser/Electron Edit menu.

- **`useDirtyGuard`** (`src/hooks/useDirtyGuard.ts`): Registers a `beforeunload` listener that calls `e.preventDefault()` when `dirty` is true, triggering the browser's "unsaved changes" confirmation.

## App Initialization (`src/App.tsx`)

1. `useKeybindings()` and `useDirtyGuard()` are called at the top level.
2. On mount, checks `?project=<url>` query parameter — if present, calls `loadFromUrl(url)` for server-deployment auto-loading.
3. Renders `Toolbar` always. If a project is loaded, renders the three-pane workspace; otherwise shows a welcome screen with an "Open project…" button.
4. `ErrorPanel` is always rendered (renders null when no error).

## Build Configuration

**`vite.config.ts`** uses `base: './'` so the built SPA works from both a server subpath and `file://` (for Electron). The `ELECTRON=1` environment variable conditionally adds the `vite-plugin-electron` plugin which builds `electron/main.ts` and `electron/preload.ts` (preload emitted as `.cjs` since the package is `type: module`).

## Change Guidance

- **Adding a new platform operation**: Add it to `PlatformAdapter`, implement in both `ElectronAdapter` and `BrowserAdapter`, then call from the store or components.
- **Adding a new annotation field type**: Update `FieldType` in `schema.ts`, `emptyValue()` in `annotations.ts`, and `Field.tsx` rendering. Consider validation in the zod schema.
- **Adding a new keyboard shortcut**: Add to `useKeybindings.ts`. Check `isEditable()` if it should be ignored inside input fields.
- **Changing the Electron IPC surface**: Update `preload.ts` (the `SlrBridge` interface), `electron/main.ts` (IPC handler), and `src/platform/electron.ts` (adapter method). All three must stay in sync.
