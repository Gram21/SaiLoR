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

**`PlatformAdapter`** (`src/platform/adapter.ts`) defines six operations:
- `getRecents()` — return the list of recently opened projects (`RecentEntry[]` with `id` + `name`)
- `openRecent(id)` — re-open a project by its recent-entry id (path on Electron, IndexedDB handle key on browser)
- `openProject()` — show an open dialog/picker, return JSON text + a `SaveHandle`
- `saveProject(text, handle)` — write back to the handle's location
- `saveProjectAs(text, suggestedName)` — prompt for new location and write
- `getPdfSource(pdfPath, projectHandle)` — resolve a paper's relative PDF path into a URL react-pdf can load

Recent projects are managed by `src/platform/recents.ts` — a platform-opaque module that stores up to 5 entries in `localStorage` (separate keys for Electron and browser). On Electron, the entry `id` is the absolute file path; on browser it is a key into the IndexedDB handle store.

`getPlatform()` (`src/platform/index.ts`) returns a singleton: `ElectronAdapter` if `window.slr` exists (preload bridge), otherwise `BrowserAdapter`. Detection uses `isElectron()` which checks for the preload-bridged `window.slr` object.

### ElectronAdapter (`src/platform/electron.ts`)

Delegates to `window.slr` (the preload bridge). File operations use IPC to the main process. PDFs are served via the custom `slr-file://project/<encoded-path>` protocol — the main process resolves paths relative to the project directory. `setProjectDir` is called on open/save-as so the protocol knows the base directory. On open and save-as, the adapter pushes an entry to the recents list (`slr.recents.electron` localStorage key). `openRecent(id)` calls `bridge().openPath(id)` to read a file by absolute path; if the file no longer exists the entry is pruned from recents.

### BrowserAdapter (`src/platform/browser.ts`)

Has three tiers of capability:

| Capability | Chromium (FSAPI) | Other browsers | Server mode |
|---|---|---|---|
| Open | `showOpenFilePicker` — in-place handle retained | Hidden `<input type=file>` | `fetch(url)` via `?project=` |
| Save | `createWritable` on retained handle | Download blob | Download blob |
| Save as | `showSaveFilePicker` | Download blob | Download blob |
| PDF loading | One-time directory grant via `showDirectoryPicker`, blob URL | `fetch` relative to page | `fetch` relative to project URL |

`setServerBase(url)` records the URL a project was fetched from so sibling PDFs resolve correctly in server mode. The adapter stores `FileSystemFileHandle` references in an internal map keyed by generated IDs.

When the File System Access API is available, the `BrowserAdapter` also persists handles in IndexedDB (`src/platform/idb.ts`) so they survive page reloads. `openProject()` and `saveProject()` (via the FSAPI Save As flow) call `rememberHandle()` which stores the handle under a `recent:<name>` key and pushes an entry to `slr.recents.browser`. `openRecent(id)` retrieves the handle from IndexedDB, re-requests read permission (via `ensureReadPermission`), and re-reads the file. If the handle is missing or permission is denied, the entry is pruned from recents. Opening a local file resets `serverBase` to `null` so PDF loading uses the handle instead of server fetch.

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
| `theme` | `Theme` (`'light' \| 'dark'`) | Current app theme (persisted in localStorage via `src/state/settings.ts`) |
| `fontScale` | `number` | Current font scale factor (0.7–2.0, persisted in localStorage) |
| `pdfZoom` | `number` | PDF zoom multiplier (0.4–3.0, session-only, default 1) |
| `recents` | `RecentEntry[]` | Recently opened projects (max 5, from `platform.getRecents()`) |
| `helpOpen` | `boolean` | Help dialog visibility |

### Key Actions

- **`openProject()`** — delegates to `platform.openProject()`, then `loadFromText()`, refreshes `recents`
- **`openRecent(id)`** — delegates to `platform.openRecent(id)`; on success → `loadFromText` + refreshes `recents`; on null → prunes recents and sets `loadError`
- **`loadFromUrl(url)`** — `fetch` the project JSON, set `serverBase` on browser adapter, then `loadFromText()`
- **`loadFromText(text, handle, name)`** — calls `loadProject(text)` from the model layer, sets state, selects first paper
- **`save()` / `saveAs()`** — `serializeProject(project)` → delegate to platform, clears `dirty`, refreshes `recents`
- **`selectPaper(id)`** — switches paper, clears `pdfSelection`
- **`setFieldValue(path, name, index, value)`** — navigates the annotation tree via `containerAt()`, sets `inst.value`, marks dirty
- **`addInstance(path, def)` / `removeInstance(path, name, index)`** — manages repeatable annotation instances, respects `max`/`min`
- **`toggleTheme()` / `setTheme(theme)`** — flips or sets the app theme, applies via `applyTheme()` (sets `data-theme` attribute on `<html>`)
- **`increaseFont()` / `decreaseFont()` / `resetFont()`** — adjusts `fontScale` by ±0.1 (clamped to 0.7–2.0), applies via `applyFontScale()` (sets `--app-font-scale` CSS variable)
- **`zoomInPdf()` / `zoomOutPdf()` / `resetPdfZoom()`** — adjusts `pdfZoom` by ±0.2 (clamped to 0.4–3.0, rounded to 2 decimals) or resets to 1; session-only, not persisted
- **`setHelpOpen(open)`** — shows/hides the help dialog

The `containerAt(root, path)` helper walks the annotation tree following `PathSeg[]` (name + index pairs) to reach the container for a given path.

## Component Tree

```
App (src/App.tsx)
├── Toolbar (src/components/Toolbar.tsx)
│     Open ▾ dropdown (Open file… + recent projects) + Save ▾ dropdown (Save / Save as…)
│     Font controls (A− A A+), theme toggle (☾/☀), help (?)
├── [if project loaded: workspace]
│   ├── PaperList (src/components/PaperList.tsx)
│   │     List of papers with search box; green dot if hasAnnotations(); click to select
│   ├── PdfViewer (src/components/PdfViewer.tsx)
│   │     react-pdf Document+Page; ResizeObserver for width; zoom controls; multi-page navigation; text selection capture
│   └── AnnotationPanel (src/components/AnnotationPanel.tsx)
│         └── AnnotationNode (src/components/AnnotationNode.tsx) [recursive]
│               └── Field (src/components/Field.tsx)
│                     Input control (text/number/checkbox/enum ComboBox) + ⧉ grab-from-PDF button
├── [if no project: welcome screen with "Open project…" button + recent projects list]
├── HelpDialog (src/components/HelpDialog.tsx)
│     Modal overlay with app intro + keyboard shortcuts table
└── ErrorPanel (src/components/ErrorPanel.tsx)
      Modal overlay for load/save errors
```

### Dropdown component

`Dropdown` (`src/components/Dropdown.tsx`) is a reusable click-to-open menu. Items are a union of `item` (label, optional shortcut, disabled, onSelect), `separator`, or `header`. It closes on outside-mousedown, Escape, or item selection. The Toolbar uses two `Dropdown` instances: Open ▾ (with recent projects list) and Save ▾ (with shortcut labels).

### AnnotationNode (recursive renderer)

`AnnotationNode` is the core recursive component. Given a `ResolvedDef` and a `container` (`AnnotationValueTree`), it:

1. For a **single non-repeatable leaf** — renders one `Field` on a single row (the common case).
2. For **repeatable or group nodes** — renders a header with "+ Add" button (if repeatable), then iterates instances. Each instance shows a remove ("×") control (if repeatable), an optional field, and recursively renders children with an extended `path`.

The `path` (`PathSeg[]`) is extended at each nesting level: `[...path, { name: def.name, index: i }]`. This path is passed to store actions to navigate the tree.

### Field component

`Field` renders the appropriate input based on `def.type`:
- `boolean` → checkbox
- `number` → `<input type=number>`
- `string` with `options` (enum) → `ComboBox` (`src/components/ComboBox.tsx`) — a filterable dropdown of allowed values; no free-text grab button
- `string` without `options` → auto-expanding `<textarea>` (single line when idle, grows on focus up to 240px, max 500 chars)

The **grab-from-PDF** button (⧉) reads `useStore.getState().pdfSelection` and inserts it. It is shown for `string` (non-enum) and `number` fields. For number fields, it extracts the first numeric token via `parseNumber()` (handles comma decimals).

### Annotation names and descriptions

`src/components/NodeName.tsx` renders schema node names. When a definition has a `description`, the UI adds an `ⓘ` marker, shows the description as a hover/focus tooltip, and renders that tooltip in a portal so it is not clipped by the annotation panel scroll container. The wrapper also includes an `aria-label` that combines the name and description for assistive technology.

### PdfViewer

Uses `react-pdf`'s `Document` + `Page` components. The pdf.js worker is loaded from the bundled dependency URL. A `ResizeObserver` tracks container width so pages scale to fit; the final render width is the fit-to-width size multiplied by the store-level `pdfZoom` factor. The PDF header shows the paper title, authors, and DOI, plus zoom controls (−, percentage, +) wired to `zoomOutPdf` / `resetPdfZoom` / `zoomInPdf`. For multi-page PDFs, the header also shows page navigation (prev/next buttons, a page-number input, and a total page count). The current page is tracked from scroll position via `onScroll` — the last page whose top has scrolled past 30% of the viewport height — and typing a page number jumps to that page. The PDF text and annotation layers are both rendered. Pages are `align-items: safe center` so horizontal scrolling remains reachable when zoomed wider than the pane. Text selection is captured via `onMouseUp`/`onKeyUp` → `window.getSelection()` → `setPdfSelection()`.

PDF source resolution is async: `getPlatform().getPdfSource(paper.pdf, saveHandle)` returns a `{ url, revoke? }`. The effect cleans up (revokes blob URLs) on paper/handle change or unmount.

## Electron Main Process

**`electron/main.ts`** is a thin main process:

- **Window**: 1400×900 `BrowserWindow`, context isolation enabled, node integration disabled, preload script loaded.
- **Dev vs prod**: loads `VITE_DEV_SERVER_URL` in dev, `dist/index.html` in production.
- **`slr-file://` protocol**: registered as privileged (secure, stream, fetch API). Handler resolves paths relative to `projectDir` with traversal guard (`path.resolve` + prefix check). Returns 403 for traversal attempts, 404 for missing files.
- **IPC handlers**:
  - `project:open` — `dialog.showOpenDialog` → `readFile`
  - `project:openPath` — reads a file by absolute path (for re-opening recent projects); returns `null` if the file is missing or unreadable
  - `project:save` — `writeFile` to given path
  - `project:saveAs` — `dialog.showSaveDialog` → `writeFile`
  - `project:setDir` — sets `projectDir` from the project file's directory
- **Menu**: custom template with File, Edit, View, Window menus. The View menu is hand-built (not the default `{ role: 'viewMenu' }`) and deliberately omits zoom roles so that `Ctrl +/-/0` reach the renderer for PDF zoom (and `Ctrl+Shift +/-/0` for app font scaling) instead of triggering native browser/Electron zoom.

**`electron/preload.ts`** uses `contextBridge.exposeInMainWorld('slr', ...)` to expose IPC-backed methods including `openProject`, `openPath` (read file by absolute path), `saveProject`, `saveProjectAs`, `setProjectDir`, and `getPdfSource`. This `window.slr` object is the detection signal for `isElectron()`.

## Hooks

- **`useKeybindings`** (`src/hooks/useKeybindings.ts`): Global keyboard shortcuts registered on `window.keydown`. Handles open (Ctrl/Cmd+O), save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), paper navigation (Alt+↓/↑, `[`/`]`), zoom/font (Ctrl/Cmd + `+/=/-`/`0` → PDF zoom; add Shift → app font size), and help (F1). Paper navigation skips when typing in a field (unless Alt is held). Zoom/font detection matches `e.key` and `e.code` to handle numpad and international layouts; reset is detected by the digit-0 `e.code` (Shift-independent) to avoid the German Shift+0 → `=` clash. Copy/cut/paste/undo are left to the browser/Electron Edit menu.

- **`useDirtyGuard`** (`src/hooks/useDirtyGuard.ts`): Registers a `beforeunload` listener that calls `e.preventDefault()` when `dirty` is true, triggering the browser's "unsaved changes" confirmation.

## Settings & Theming (`src/state/settings.ts`)

App appearance is controlled by a settings module that persists to `localStorage`:

- **Theme**: `'light' | 'dark'` — defaults to OS preference (`prefers-color-scheme`) on first load. `applyTheme()` sets `document.documentElement.dataset.theme`. CSS uses `:root[data-theme='dark']` selectors so the theme is user-controlled, not OS-only.
- **Font scale**: float from 0.7 to 2.0 (step 0.1). `applyFontScale()` sets the `--app-font-scale` CSS variable on `<html>`. The base font size is `calc(14px * var(--app-font-scale))` and most text sizes use `rem` units so they scale proportionally. The PDF paper itself is always rendered on a white background regardless of theme.

`src/main.tsx` calls `applyTheme(loadTheme())` and `applyFontScale(loadFontScale())` before rendering React to avoid a flash of unstyled or wrong-theme content on startup.

## App Initialization (`src/App.tsx`)

1. `useKeybindings()` and `useDirtyGuard()` are called at the top level.
2. On mount, checks `?project=<url>` query parameter — if present, calls `loadFromUrl(url)` for server-deployment auto-loading.
3. Renders `Toolbar` always. If a project is loaded, renders the three-pane workspace; otherwise shows a welcome screen with an "Open project…" button and, if there are recent projects, a clickable list of them wired to `openRecent(id)`.
4. `ErrorPanel` is always rendered (renders null when no error).

## Build Configuration

**`vite.config.ts`** uses `base: './'` so the built SPA works from both a server subpath and `file://` (for Electron). The `ELECTRON=1` environment variable conditionally adds the `vite-plugin-electron` plugin which builds `electron/main.ts` and `electron/preload.ts` (preload emitted as `.cjs` since the package is `type: module`).

## Change Guidance

- **Adding a new platform operation**: Add it to `PlatformAdapter`, implement in both `ElectronAdapter` and `BrowserAdapter`, then call from the store or components.
- **Adding a new annotation field type**: Update `FieldType` in `schema.ts`, `emptyValue()` in `annotations.ts`, and `Field.tsx` rendering. Consider validation in the zod schema.
- **Adding a new keyboard shortcut**: Add to `useKeybindings.ts`. Check `isEditable()` if it should be ignored inside input fields.
- **Changing the Electron IPC surface**: Update `preload.ts` (the `SlrBridge` interface), `electron/main.ts` (IPC handler), and `src/platform/electron.ts` (adapter method). All three must stay in sync.
- **Adding a new settings/appearance option**: Add to `src/state/settings.ts` (load/apply functions), add state + actions to the store, add UI controls to `Toolbar.tsx`, and add keybindings if needed.
