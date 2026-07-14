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

**`PlatformAdapter`** (`src/platform/adapter.ts`) defines nine operations:
- `getRecents()` — return the list of recently opened projects (`RecentEntry[]` with `id` + `name`)
- `openRecent(id)` — re-open a project by its recent-entry id (path on Electron, IndexedDB handle key on browser)
- `openProject()` — show an open dialog/picker, return JSON text + a `SaveHandle`
- `saveProject(text, handle)` — write back to the handle's location
- `saveProjectAs(text, suggestedName)` — prompt for new location and write
- `getPdfSource(pdfPath, projectHandle)` — resolve a paper's relative PDF path into a URL react-pdf can load. On Electron it re-asserts the main process's project directory from `projectHandle` first, so PDFs always resolve against the project actually being rendered (the project editor repoints that directory when picking a location).

Three more exist for the **project editor** (see below):
- `pickProjectLocation(suggestedName)` — ask where the project JSON should live; writes nothing. Returns a `ProjectLocation` (`handle`, `name`, and — Electron only — an absolute `path`).
- `pickPdfs()` — pick PDFs to reference; returns `PickedPdf[]` (`name`, plus an absolute `path` on Electron).
- `relativePdfPaths(pdfs, location)` — the `pdf` values to store, **relative to the JSON's directory**. Electron computes real relative paths via IPC; the browser returns bare file names (the File System Access API exposes no paths).

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
| `past` / `future` | `HistoryEntry[]` | Undo/redo stacks for annotation edits (session-only, capped at 100). Each entry is `{ project, paperId }`; thanks to immer's structural sharing, snapshots are cheap references |

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
- **`undo()` / `redo()`** — swap the current project snapshot with one from the `past`/`future` stack (and switch to the affected paper). The mutating actions push a snapshot before applying; consecutive edits to the *same* field coalesce into one undo step (a module-level `lastFieldKey` tracks this), while add/remove/paper-switch reset it. History is cleared on project load.
- **`setHelpOpen(open)`** — shows/hides the help dialog

The `containerAt(root, path)` helper walks the annotation tree following `PathSeg[]` (name + index pairs) to reach the container for a given path.

## Component Tree

```
App (src/App.tsx)
├── Toolbar (src/components/Toolbar.tsx)
│     Open ▾ dropdown (Open file… + recent projects) + Save ▾ dropdown (Save / Save as…)
│     Font controls (A− A A+), theme toggle (☾/☀), help (?)
├── [if project loaded: workspace — a CSS grid whose column widths come from resizable panes]
│   ├── PaperList (src/components/PaperList.tsx)
│   │     List of papers with search box; green dot if hasAnnotations(); click to select
│   ├── Splitter (src/components/Splitter.tsx) ×2  — drag handles between the panes
│   ├── PdfViewer (src/components/PdfViewer.tsx)
│   │     react-pdf Document+Page; ResizeObserver for width; zoom controls; multi-page navigation; jump history (back/forward); in-PDF search (Ctrl+F); text selection capture
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

### Project editor

A second screen (`src/components/ProjectEditor.tsx`, shown instead of the workspace while `useEditorStore().open`) lets users **create or edit a project JSON** — its annotation schema and the PDFs it references — without hand-writing JSON. It is entered from the welcome screen's *New annotation JSON…* / *Edit annotation JSON…* buttons.

The **help dialog is mode-aware**. `HelpDialog` derives a mode from `useEditorStore().open` and whether a project is loaded, then renders one of three guides, each with only the shortcuts that actually do something there, plus a badge in the title naming the mode:
- **Getting started** (start screen, nothing open) — what an SLR project JSON *is*, and what the three buttons do (open / new / edit).
- **Annotating** (a project is open) — pick a paper, read the PDF, fill the fields, save.
- **Editing the annotation JSON** (the editor is open) — schema building, drag-to-nest, adding PDFs, the two save buttons.

Shared sections (appearance, license) render in all three.

Two ways out of the editor: **Save JSON** writes the file and stays put (so you can keep building), while **Save JSON & Begin Annotating** writes it and hands it to the annotation view (`loadFromText`) — that split is `save()` vs `saveAndAnnotate()`. Both validate first, so an invalid draft neither writes nor closes. The editor has its own **undo/redo** history (`past`/`future` snapshots, same shape as the annotation store, with consecutive keystrokes in one input coalesced into a single step), and `useKeybindings` / `useElectronCloseGuard` route `Ctrl+S` / `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` to it whenever it is open.

- **`src/state/editorStore.ts`** — a separate Zustand+immer store holding the draft. It deliberately works on the **raw JSON shape**, not the loaded `Project`: each paper's `annotations` object is carried through **verbatim** while the schema is edited, so editing the schema never prunes existing annotation data (it is normalized against the new schema the next time the project is opened for annotating). Key pieces: `EditorNode` (a schema node with a client-side `uid`, where `kind: 'group'` means "no `type`" — a name-only sub-tree), `EditorPaper` (which also keeps the PDF's absolute `sourcePath`), `toAnnotationDefs`/`fromAnnotationDefs` (conversion to/from the compact on-disk `AnnotationDef`), `moveNodeIn` (tree move that refuses to drop a node into itself or its own subtree), `buildProjectJson`, and `validateDraft` — which runs the *real* `projectSchema` + `resolveSchema` validators, so the editor cannot produce a file the loader would reject. On save it writes the JSON and hands it straight to the main store via `loadFromText`.
- **`SchemaTreeEditor.tsx`** — recursive tree exposing the schema's full expressiveness: name, kind (Group / Text / Number / Yes-no), `min`, `max` (with an ∞ checkbox for `max: null` = unbounded repeats), description, enum `options` (string fields only), nesting, add/remove. Native HTML5 drag-and-drop reorders rows and builds nesting: the drop position comes from the pointer's Y within the target row — top 25% → `before`, bottom 25% → `after`, middle → `inside` (nest as a child).
- **`PapersEditor.tsx`** — add PDFs via a native/browser picker, edit each paper's id/title/authors/DOI and its `pdf` path, reorder by drag, remove.

**Adding PDFs** (`addPdfs`) does two things beyond appending rows:
- **Duplicate rejection.** A PDF already referenced is skipped rather than added twice, and the skipped names are reported in a dismissible notice. Identity is `pdfKeys()`: the absolute path when known (Electron) *and* the stored relative path — so re-picking the same file, picking it twice in one dialog, or picking one already listed in an opened project all collapse to one entry. Same-named PDFs in different folders stay distinct.
- **Title/author auto-fill.** `src/model/pdfMeta.ts` reads each added PDF (`PickedPdf.read()` — an IPC in Electron, `File.arrayBuffer()` in the browser) and pre-fills the fields. It tries the PDF's embedded `Title`/`Author` metadata first, validating it (`isPlausibleTitle` rejects artefacts like "Microsoft Word - paper_final_v3.doc"), then falls back to a layout heuristic on page 1: the largest text near the top is the title (joined across wrapped lines), and the lines under it are the authors. `parseAuthorList` strips affiliation superscripts, footnote daggers, emails and an "Authors:" label; in `strict` mode (used only for the heuristic, which is a *guess*) it also requires each entry to look like a person's name, so a body sentence can't become an author list. Everything is best-effort and only ever pre-fills — rows appear immediately with a name-derived placeholder, extraction patches them in the background, and it never overwrites a value the user has already typed. The pdf.js worker is configured once in `src/platform/pdfjs.ts`, shared by the viewer and the extractor.

**Relative PDF paths.** The JSON's location is chosen **up front** (and changeable any time via *Change…*), because a paper's `pdf` is stored **relative to the JSON file**. Each picked PDF keeps its absolute `sourcePath`, so when the location changes `changeLocation()` re-derives every `pdf` against the new directory (`/reviews/x.json` + `/reviews/pdfs/a.pdf` → `pdfs/a.pdf`; move the JSON up a level and it becomes `reviews/pdfs/a.pdf`). This only works in **Electron**, where real filesystem paths exist: the platform methods `pickProjectLocation` / `pickPdfs` / `relativePdfPaths` (see below) compute it via a `paths:relative` IPC (`path.relative(dirname(json), pdf)`, POSIX-separated). In the **browser** the File System Access API exposes no paths, so a picked PDF is stored as its bare file name and the user places it next to the JSON or edits the relative path by hand — the papers editor says so.

### PdfViewer

Uses `react-pdf`'s `Document` + `Page` components. The pdf.js worker is loaded from the bundled dependency URL. A `ResizeObserver` tracks container width so pages scale to fit; the final render width is the fit-to-width size multiplied by the store-level `pdfZoom` factor. The PDF header shows the paper title, authors, and DOI, plus zoom controls (−, percentage, +) wired to `zoomOutPdf` / `resetPdfZoom` / `zoomInPdf`. For multi-page PDFs, the header also shows page navigation (prev/next buttons, a page-number input, and a total page count). The current page is tracked from scroll position via `onScroll` — the last page whose top has scrolled past 30% of the viewport height — and typing a page number jumps to that page. The PDF text and annotation layers are both rendered. Pages are `align-items: safe center` so horizontal scrolling remains reachable when zoomed wider than the pane. Text selection is captured via `onMouseUp`/`onKeyUp` → `window.getSelection()` → `setPdfSelection()`.

**External links.** The `<Document>` is given `externalLinkTarget="_blank"` and `externalLinkRel="noopener noreferrer"`, so link annotations pointing at a website render as `target="_blank"` anchors and open in a **new browser tab** rather than navigating the SPA away. Internal (in-PDF) destinations are unaffected — pdf.js renders them without a target and its LinkService scrolls to them. In **Electron**, `main.ts` intercepts the resulting `window.open` with `webContents.setWindowOpenHandler`, hands the URL to `shell.openExternal` (the user's **default browser**), and returns `{ action: 'deny' }` so no Electron window is created. A `will-navigate` listener is a safety net that prevents anything from navigating the app window away, routing off-app URLs to the browser too. Both paths go through `openExternalUrl`, which only opens `http:`/`https:`/`mailto:` — never `file:` or other schemes, which the OS could use to launch programs.

**Jump history (back/forward).** Clicking an internal PDF link (e.g. a reference) lets the pdf.js LinkService scroll to the destination. An `onClickCapture` on the scroll container notices clicks on `<a>` elements and, after polling briefly, records the pre-jump `scrollTop` on a back stack **only if the view actually moved** (so external links, which don't scroll, are ignored). Two header buttons (↩ / ↪, shown once history exists) then move between positions like a browser: `jumpBack` pops the back stack, pushes the live position onto the forward stack, and scrolls there instantly (`scrollTo` with default behavior — reliable under `prefers-reduced-motion`); `jumpForward` is symmetric. The stacks are refs (with `canJumpBack`/`canJumpForward` state mirroring their lengths) and are cleared when the paper changes.

**In-PDF search.** A 🔍 button in the header (and `Ctrl/Cmd+F`) toggles a find bar below the header; opening it focuses the input so the user can type immediately (via a `searchOpen` effect, since the input isn't mounted on the open transition). `findMatches` walks the text nodes of each rendered text layer (`.react-pdf__Page__textContent`), concatenating them per layer so a query can span multiple spans, and returns DOM `Range`s. Matches are painted with the **CSS Custom Highlight API** (`CSS.highlights` + `::highlight(slr-pdf-search)` / `::highlight(slr-pdf-search-active)`) — this tints the transparent text-layer glyphs without mutating react-pdf's DOM, and degrades gracefully where the API is unavailable. The active match is centered in the scroll container; Enter / Shift+Enter (and the ‹ › buttons) cycle matches. Crucially, the `<Page>` elements are **memoized** (`useMemo` on `[numPages, renderWidth, onTextLayerRendered]`) with a stable `onRenderTextLayerSuccess` callback, so typing in the search box reuses the same element references and React skips re-rendering the pages — otherwise every keystroke would tear down and re-render the text layers (a "TextLayer task cancelled" flood) and matches would never resolve.

PDF source resolution is async: `getPlatform().getPdfSource(paper.pdf, saveHandle)` returns a `{ url, revoke? }`. The effect cleans up (revokes blob URLs) on paper/handle change or unmount.

## Electron Main Process

**`electron/main.ts`** is a thin main process:

- **Window**: `BrowserWindow` defaulting to **1920×1080**, context isolation enabled, node integration disabled, preload script loaded. The taskbar/dock icon is set from `build/icon.png` via `nativeImage` (and `app.dock.setIcon` on macOS so it shows in dev, not just the packaged bundle).
- **Window-state persistence**: size, position, and maximized state are saved to `window-state.json` in `app.getPath('userData')` and restored on the next launch. Writes are debounced on `resize`/`move`/`maximize`/`unmaximize` (400 ms) and flushed synchronously on `close`; maximized/fullscreen windows store their `getNormalBounds()` so restore returns to the user's chosen size. A saved position is only reused if it still overlaps a connected display (`screen.getAllDisplays()`), so a disconnected monitor can't strand the window off-screen; otherwise only the size is applied and the window is centered. Absent/corrupt state falls back to the 1920×1080 default.
- **Dev vs prod**: loads `VITE_DEV_SERVER_URL` in dev, `dist/index.html` in production.
- **External links**: `setWindowOpenHandler` sends `target="_blank"` links (external links in PDFs) to the system browser via `shell.openExternal` and denies the popup; `will-navigate` prevents any off-app navigation of the window itself. Only `http:`/`https:`/`mailto:` URLs are passed to the OS.
- **`slr-file://` protocol**: registered as privileged (secure, stream, fetch API). Handler resolves paths relative to `projectDir` with traversal guard (`path.resolve` + prefix check). Returns 403 for traversal attempts, 404 for missing files.
- **IPC handlers**:
  - `project:open` — `dialog.showOpenDialog` → `readFile`
  - `project:openPath` — reads a file by absolute path (for re-opening recent projects); returns `null` if the file is missing or unreadable
  - `project:save` — `writeFile` to given path
  - `project:saveAs` — `dialog.showSaveDialog` → `writeFile`
  - `project:setDir` — sets `projectDir` from the project file's directory
  - `project:pickSavePath` — `dialog.showSaveDialog` to choose where a project JSON should live; **writes nothing** (the project editor picks a location before there is a file)
  - `pdf:pick` — `dialog.showOpenDialog` with `multiSelections` to add PDFs; returns absolute paths
  - `pdf:read` — raw bytes of a PDF by absolute path, so the editor can read its title/authors. Deliberately *not* confined to the project directory (unlike `slr-file://`): the user may add PDFs from anywhere and picked them through a native dialog.
  - `paths:relative` — `path.relative(dirname(fromFile), to)` for each target, POSIX-separated. This is what makes a paper's `pdf` relative to the JSON, and what re-derives the paths when the JSON moves.
  - `app:setDirty` — the renderer reports its unsaved-changes state (drives the quit dialog)
  - `app:saveComplete` — the renderer reports the result of a save it was asked to run before quitting
- **Menu**: custom template with File, Edit, View, Window menus.
  - The **Edit** menu is hand-built: **Undo/Redo** send `app:undo` / `app:redo` to the renderer (routing to the store's history) rather than the native text-undo role, so undo works app-wide; cut/copy/paste/selectAll keep their native roles.
  - The **View** menu is hand-built (not the default `{ role: 'viewMenu' }`) and deliberately omits zoom roles so that `Ctrl +/-/0` reach the renderer for PDF zoom (and `Ctrl+Shift +/-/0` for app font scaling) instead of triggering native browser/Electron zoom.
- **Unsaved-changes quit flow**: a window `close` handler (`promptUnsavedChanges`) intercepts the close/quit when `isDirty` is set, and shows a native **Save / Don't Save / Cancel** dialog. "Save" asks the renderer to save (`app:requestSave`) and closes once it reports back; "Don't Save" closes discarding changes. A `before-quit` flag lets the guard resume `app.quit()` after confirmation (so Cmd+Q fully quits on macOS, where destroying the window alone would not).

**`electron/preload.ts`** uses `contextBridge.exposeInMainWorld('slr', ...)` to expose IPC-backed methods: `openProject`, `openPath` (read file by absolute path), `saveProject`, `saveProjectAs`, `setProjectDir`, plus the quit/menu coordination — `setDirty`, `onRequestSave`, `saveComplete`, `onUndo`, `onRedo`. This `window.slr` object is the detection signal for `isElectron()`.

## Hooks

- **`useKeybindings`** (`src/hooks/useKeybindings.ts`): Global keyboard shortcuts registered on `window.keydown`. Handles open (Ctrl/Cmd+O), save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), paper navigation (Alt+↓/↑, `[`/`]`), zoom/font (Ctrl/Cmd + `+/=/-`/`0` → PDF zoom; add Shift → app font size), and help (F1). Paper navigation skips when typing in a field (unless Alt is held). Zoom/font detection matches `e.key` and `e.code` to handle numpad and international layouts; reset is detected by the digit-0 `e.code` (Shift-independent) to avoid the German Shift+0 → `=` clash. Copy/cut/paste/undo are left to the browser/Electron Edit menu.

- **`useDirtyGuard`** (`src/hooks/useDirtyGuard.ts`): **Browser only.** Registers a `beforeunload` listener that calls `e.preventDefault()` when `dirty` is true, triggering the browser's "unsaved changes" confirmation. It is skipped under Electron (`isElectron()`), because a `beforeunload` that returns a value there silently cancels the quit with no dialog — Electron handles unsaved changes via a native dialog in the main process instead (see `useElectronCloseGuard` and the quit flow below).

- **`useElectronCloseGuard`** (`src/hooks/useElectronCloseGuard.ts`): **Electron only.** Wires the renderer to the main process for a clean quit and for the Edit menu: it pushes the current `dirty` state to main (`slr.setDirty`), runs a save when main asks after the user picks "Save" in the native close dialog (`slr.onRequestSave` → `save()` → `slr.saveComplete(ok)`), and routes the Edit-menu Undo/Redo (`slr.onUndo` / `slr.onRedo`) to the store's `undo()` / `redo()`.

## Settings & Theming (`src/state/settings.ts`)

App appearance is controlled by a settings module that persists to `localStorage`:

- **Theme**: `'light' | 'dark'` — defaults to OS preference (`prefers-color-scheme`) on first load. `applyTheme()` sets `document.documentElement.dataset.theme`. CSS uses `:root[data-theme='dark']` selectors so the theme is user-controlled, not OS-only.
- **Font scale**: float from 0.7 to 2.0 (step 0.1). `applyFontScale()` sets the `--app-font-scale` CSS variable on `<html>`. The base font size is `calc(14px * var(--app-font-scale))` and most text sizes use `rem` units so they scale proportionally. The PDF paper itself is always rendered on a white background regardless of theme.
- **Pane widths**: the left (paper list) and right (annotations) pane widths are persisted via `loadPaneWidths()` / `savePaneWidths()` (localStorage, clamped). `App.tsx` holds them in state, applies them as the workspace grid template, and updates them as the `Splitter` drag handles are dragged.

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
