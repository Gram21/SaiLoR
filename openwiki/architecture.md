# Architecture

## Overview

SaiLoR is a single-codebase React app that runs as both an Electron desktop application and a static web SPA. The key architectural seam is the **PlatformAdapter** interface, which abstracts all file I/O and PDF loading so the React UI is identical in both runtimes.

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
- `rebasePdfPaths(pdfPaths, from, to)` — re-express PDF paths that were relative to `from`'s directory as relative to `to`'s. **"Save as" depends on this**: a paper's `pdf` is stored relative to the project file, so writing the old paths to a new location left every PDF pointing at nothing. `store.saveAs()` therefore picks the destination *first* (`pickProjectLocation`), rebases, and only then serializes and writes. Electron does the real path math via a `paths:rebase` IPC (`relative(dirname(to), resolve(dirname(from), rel))`); the browser has no paths and returns the input unchanged.
- `getPdfSource(pdfPath, projectHandle)` — resolve a paper's relative PDF path into a URL react-pdf can load. On Electron it re-asserts the main process's project directory from `projectHandle` first, so PDFs always resolve against the project actually being rendered (the project editor repoints that directory when picking a location).

Three more exist for the **project editor** (see below):
- `pickProjectLocation(suggestedName)` — ask where the project JSON should live; writes nothing. Returns a `ProjectLocation` (`handle`, `name`, and — Electron only — an absolute `path`).
- `pickPdfs()` — pick PDFs to reference; returns `PickedPdf[]` (`name`, plus an absolute `path` on Electron).
- `relativePdfPaths(pdfs, location)` — the `pdf` values to store, **relative to the JSON's directory**. Electron computes real relative paths via IPC; the browser returns bare file names (the File System Access API exposes no paths).

**Project title.** A project JSON may set a top-level `title`; the app shows it wherever it would otherwise show the file name (toolbar, recents list, Open menu), falling back to the file name when absent. It is a first-class key on `Project` (not swallowed into `extra`, which would duplicate it on save) and is only written when non-empty. The project editor exposes it as a *Project title* field next to the JSON location.

**Recents are re-read from disk, not trusted.** The title shown for a recent is stored on the entry, but that copy goes stale the moment the project is renamed elsewhere — most obviously by changing the *Project title* in the editor, where the old name would otherwise still be sitting in the list after closing it. So `checkRecents()` **re-reads each project's current title from the file**: on Electron a `project:peek` IPC returns `{ exists, title }` per path in one round trip (parse failures are contained per file); in the browser it reads through the retained handle, but **only when read permission is already granted** — startup must never throw a permission prompt at the user just to refresh a label, so without permission the stored title is kept. The refreshed list is written back (`replaceRecents`, order preserved) so the fresh titles survive a restart, and `editorStore.save()` triggers a refresh so a rename shows up as soon as the editor is closed. A title removed from a file correctly reverts the entry to showing its file name.

**A recent whose file has gone is kept, not forgotten.** `checkRecents()` (run on startup via `refreshRecents()`) re-tests each entry — `fs:exists` on Electron, "do we still hold the IndexedDB handle" in the browser — and sets a runtime-only `available` flag (never persisted). A missing project stays in the list, faded, badged *not found*, and unselectable, because the drive may come back; the user can still dismiss it with the ×. Opening one that has since vanished marks it unavailable rather than pruning it. Note the flag is deliberately tri-state: `undefined` means *not checked yet*, and only an explicit `false` greys an entry out, so nothing flickers on first paint.

**Closing a project** (`requestCloseProject`) returns to the start screen, and when there are unsaved changes it first asks via `ClosePrompt` — the same three choices and wording as Electron's native quit dialog (Save / Don't Save / Cancel). A *failed* save keeps the project open rather than closing and losing the work.

**Recents entries** carry `path` and `title` beyond `id`/`name`. The path is what lets a user tell two projects called `review.json` apart: the start screen shows it under the title (truncated from the *left*, since the tail is what differs — `direction: rtl` + `unicode-bidi: plaintext`, the latter so the leading `/` isn't reordered to the end), and the Open menu shows it as a hover tooltip. Both places offer an **×** to drop an entry (`forgetRecent`), which in the menu deliberately does *not* close it, so several can be cleared in a row. The title is only known once the JSON is parsed, so `loadFromText` re-pushes the entry via `rememberProject()` — `pushRecent` dedupes by id, so this enriches the existing entry rather than duplicating it.

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
| `sidebarCollapsed` | `boolean` | Paper list visibility. Driven by `SidebarToggle`, which renders inside the paper list's own header while it is open and in the toolbar once collapsed — otherwise the button would disappear with the pane it reopens. |
| `pdfSelection` | `string` | Latest text selected in the PDF viewer (for "grab from PDF") |
| `theme` | `Theme` (`'light' \| 'dark'`) | Current app theme (persisted in localStorage via `src/state/settings.ts`) |
| `fontScale` | `number` | Current font scale factor (0.7–2.0, persisted in localStorage) |
| `pdfZoom` | `number` | PDF zoom multiplier (0.4–3.0, session-only, default 1) |
| `recents` | `RecentEntry[]` | Recently opened projects (max 5, from `platform.getRecents()`) |
| `helpOpen` | `boolean` | Help dialog visibility |
| `past` / `future` | `HistoryEntry[]` | Undo/redo stacks for annotation edits (session-only, capped at 100). Each entry is `{ project, paperId }`; thanks to immer's structural sharing, snapshots are cheap references |
| `aiMarks` | `Record<string, true>` | Fields the AI filled and the reviewer has not looked at yet, keyed `` `${paperId}::${canonicalPath}` `` (see "AI marks" below). Session-only: it lives *beside* the project, so `serializeProject` cannot see it |

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
- **`applyAiSuggestions(suggestions)`** — writes the reviewer-approved AI proposals into the current paper as **one undo step**, and marks every field it wrote (see "AI-assisted annotation" below)
- **`confirmAiMark(paperId, canonicalPath)`** — drops one AI mark; the reviewer clicked into that field (or its label)
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
│         ✦ AI button in the column header (opens AiDialog; disabled while busy or when the paper has no PDF)
│         └── AnnotationNode (src/components/AnnotationNode.tsx) [recursive]
│               └── Field (src/components/Field.tsx)
│                     Input control (text/number/checkbox/enum ComboBox) + ⧉ grab-from-PDF button
├── [if no project: welcome screen with "Open project…" button + recent projects list]
├── AiDialog (src/components/AiDialog.tsx)
│     Modal driven by useAiStore's phase: pick a target → Start → review table → Apply
│     └── LlmSettingsDialog (src/components/LlmSettingsDialog.tsx) — manage LLM targets (stacks on top)
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

### Update check

The start screen shows the running version at the bottom (`SaiLoR v0.1.0`) and, when a newer release exists, a notice linking to it. `src/model/version.ts` fetches `api.github.com/repos/Gram21/SaiLoR/releases/latest` and compares the tag with `__APP_VERSION__` — injected from `package.json` by `vite.config.ts`, so package.json stays the single source of truth for the version.

**This only works while the repository is public.** GitHub answers **404** to an unauthenticated request for a private repo's releases, and the app is *distributed* — embedding a token to get around that would ship a credential to every user, so we don't. The check is therefore written to fail silently: a 404 (private), 403 (rate-limited), network error, draft release, or unparseable version all yield `null`, and the app simply shows no notice. It starts working the moment the repo is made public, with no code change.

When a newer release exists, the notice offers a **direct download of the installer for this machine** rather than dumping the user on the releases page: `pickInstaller` matches the release's assets against the OS/arch reported by `getOsInfo()` (Electron exposes `process.platform`/`process.arch` through the preload bridge; the browser returns `null`, since a web deployment has no installer and updates by redeploying). Matching keys off the OS/arch we bake into the artifact names (`SaiLoR-0.2.0-macos-arm64.dmg`), so it stays correct as long as package.json's `artifactName` patterns do. When nothing matches it offers **nothing** rather than the wrong binary, and the release-notes link is always there as a fallback.

`isNewerVersion` compares numeric components, not strings (`0.10.0` > `0.9.0`, which a string compare gets wrong), strips a leading `v`, and sorts a pre-release below its release (`1.0.0-beta` < `1.0.0`). It never claims an update from a version it cannot parse.

The result — *including a `null`* — is cached in `localStorage` (`slr.updateCheck`) for 24 h, so a private repo or an offline launch doesn't re-request on every startup, and the 60-requests-per-hour unauthenticated rate limit is never a concern.

### Validation

`src/model/validate.ts` checks a reviewer's annotations against the schema; the **Validate** button in the toolbar runs `validateProject(project)` and `ValidationDialog` shows the result grouped by paper (click a paper to jump to it). Four issue kinds: `required` (a field marked required is empty), `type` (the stored value doesn't match the field's type — the JSON is hand-editable), `enum` (a value outside the field's `options`), and `cardinality` (an instance count outside `[min, max]`).

**Emptiness is the load-bearing definition**, and booleans are the special case: a `boolean` field is **never** empty. An unticked box is a real answer (`false`), and a missing/`null` boolean reads as `false` — so a required boolean can never raise a `required` issue. `0` is likewise a real number, and `''`/whitespace is empty only for strings. A type mismatch suppresses the `required`/`enum` checks for that field, so one broken value yields one issue rather than a cascade. Everything is defensive: a malformed tree produces issues rather than throwing.

Fields are marked required by `required: true` in the schema (`ResolvedDef.required`, defaulting to `false`; rejected on a group, which holds no value). The schema editor exposes it as a **Required** checkbox on non-group rows, and the annotation form marks such fields with a red `*`.

Note that `loadProject` normalizes the tree to each node's `min`/`max`, so in practice `cardinality` issues only arise from a project that bypasses the loader.

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

## AI-assisted annotation (`src/llm`)

A **✦ AI** button in the annotation column's header asks an LLM to read the current paper and propose values for the fields that are **still empty**. The reviewer gets a table — field, proposed value, the supporting quote from the paper, the model's confidence, and a checkbox per row — and **nothing is written until they press Apply**.

### The modules

| Module | Job |
|---|---|
| `src/llm/types.ts` | The shared shapes: `LlmConfig` (one configured target), `LlmHttpRequest`/`LlmHttpResponse`, `Suggestion`, `SkippedField`, `RejectedSuggestion`, and the `API_KEY_SENTINEL` (`{{apiKey}}`). |
| `src/llm/fields.ts` | `unansweredFields(schema, tree)` — every field the AI will be asked about, in schema order. Its `isUnanswered()` is `validate.ts`'s notion of empty for strings/numbers; a **boolean** is offered unless it is already ticked, since the data model cannot represent an *unanswered* boolean and the archetypal AI field ("Relevant") is one. |
| `src/llm/prompt.ts` | The system prompt: the schema *format* description (`SCHEMA_FORMAT_DOC`), the path syntax, the schema itself (`dehydrateSchema`, i.e. exactly as it appears on disk), one line per field to fill, the rules, and the output shape. Plus `buildUserText` / `buildUserPdfCaption` for the user turn. |
| `src/llm/paths.ts` | The path language of the LLM contract — `"Findings[1]/Evidence[0]/Metric"`. `parsePath` / `formatPath` / `displayPath`, and `resolvePath(schema, raw)`, which checks a path against the **schema** (not the current data), so the model may name the *next free index* of a repeatable node to record a further entry. |
| `src/llm/providers.ts` | Everything that differs per vendor: `PROVIDERS` (base URL, whether the URL is editable, whether the provider can take a PDF), `buildRequest` (Anthropic `/v1/messages` vs. OpenAI-style `/v1/chat/completions`), `extractText` and `extractError`. `join()` tolerates a user-typed base URL that already ends in `/v1` or the full chat path. |
| `src/llm/parse.ts` | `parseAnswer(schema, raw)` — the trust boundary. Digs the JSON object out of whatever the model sent (fences, prose, stray braces), then validates **every** proposal against its `ResolvedDef`. |
| `src/model/pdfText.ts` | `extractPdfText(bytes)` — the paper as plain text, one `[page N]` block per page, using the same reading-order heuristic as `pdfMeta.ts`. Reports `empty: true` when a document yields almost no characters (a scan). |

`src/state/aiStore.ts` (a separate Zustand+immer store, kept out of the main store for the same reason the project editor is) owns the flow; `src/components/AiDialog.tsx` and `LlmSettingsDialog.tsx` are views over it.

### The flow

1. **`openDialog()`** computes `targets = unansweredFields(schema, paper.annotations)` and loads the configured targets from the platform. The dialog names how many empty fields will be proposed and — before anything is sent — states *what leaves the machine, and to whom*.
2. **`run()`** fetches the paper's bytes from the same URL the viewer renders (`getPdfSource`, so `slr-file://` in Electron and `blob:`/`http` in the browser), then:
   - **`attach: 'text'`** (the default, and the only option for an `openai-compatible` target) → `extractPdfText`. If the extraction is `empty` the run **stops with an error** rather than sending a title and inviting the model to invent a paper from it.
   - **`attach: 'pdf'`** → the PDF is base64'd and sent as an attachment (Anthropic / OpenAI / OpenRouter only). A target set to `pdf` against a provider that cannot take one **silently falls back to text**, and the dialog's consent line mirrors that fallback rather than promising the PDF.
3. `buildSystemPrompt(schema, targets, delivery)` + `buildRequest(config, …)` → an `LlmHttpRequest`. The `delivery` matters: with extracted text the model is told the extraction is lossy, or it will confidently reconstruct a mangled table into numbers.
4. **`platform.callLlm(request, signal)`** sends it (see below) and returns the raw body.
5. `parseAnswer` validates it; the surviving `Suggestion[]` become review rows, **all pre-ticked** — the reviewer's job is to *remove* what is wrong.
6. **`apply()`** hands the ticked suggestions to `useStore.applyAiSuggestions`.

The store keeps an `AbortController` outside the state (it is not serializable), so **Cancel** aborts a call in flight; an elapsed-seconds ticker drives the progress line.

### Why the call goes through the Electron main process

A request to an LLM API is a `POST` with `Content-Type: application/json` and an auth header — which makes it a **preflighted cross-origin request**, sent from the renderer's origin (`file://` in a packaged app). It is the same CORS wall that forced `corsEnabled` on the `slr-file://` protocol (documented under *Electron Main Process* below): Chromium rejects the request before it ever reaches the network, and the failure surfaces as an opaque `TypeError` with no detail. So on the desktop the renderer **never sends the request itself** — `ElectronAdapter.callLlm` hands it to `llm:call`, and the main process sends it with `net.fetch`, where no origin and no CORS check apply.

The second reason is the one the whole layer is built around: **the API key never enters the renderer.**

- `LlmConfig` has **no `apiKey` field** — only `hasKey: boolean`. A stored key can never be read back, not even by the settings dialog that wrote it (so leaving the key box blank on an edit *keeps* the stored key; that is the only way to edit a target without retyping it).
- The renderer builds the *entire* request, but can only put `API_KEY_SENTINEL` (`{{apiKey}}`) where the key goes. `electron/main.ts` substitutes the real key into the headers immediately before sending.
- Before it does, it **checks the origin**: `new URL(request.url).origin` must equal `new URL(config.baseUrl).origin`, or it refuses. The renderer names the URL, so a compromised renderer must not be able to post the key to a host of its choosing.
- Keys are stored in `userData/llm-config.json`, encrypted with `safeStorage` (mode `0600`). If `safeStorage.isEncryptionAvailable()` is false the app **refuses to save** rather than silently writing the key in the clear.

`llm:call` also takes a `requestId` and keeps the `AbortController` in an `inFlight` map, because an `AbortSignal` cannot cross IPC — Cancel sends a separate `llm:abort` message that main matches against the id.

**The browser build cannot make those promises**, and says so instead of pretending otherwise (`src/platform/browser.ts`): the key lives **unencrypted** in `localStorage` (`slr.llm.configs`), the request goes out **from the page**, so the provider must be willing to answer a cross-origin call (Anthropic needs the explicit `anthropic-dangerous-direct-browser-access` header, which the adapter adds; a self-hosted OpenAI-compatible endpoint usually sends no CORS headers at all and simply fails), and a cross-origin block is caught and re-thrown with an error that names the likely cause rather than reading as "the provider is down". The settings dialog shows a red notice in that runtime and points at the desktop app.

### Why a misbehaving model cannot corrupt a project

Two gates, and both are unconditional:

- **`parse.ts` validates every proposal against the schema.** `resolvePath` rejects unknown names, group paths (a group holds no value), non-final segments that have no children, and any index at or beyond a node's `max`; then the value must *typecheck* against its `ResolvedDef`. It bends only where models misbehave in a way with exactly one honest reading (`"2021"` → `2021`, `"True"` → `true`, a case-off enum value snapped onto its option). Everything else — `"about 20"`, a value outside the enum, a duplicate answer for the same field — is **rejected, never guessed at**, and rejections are *shown* to the reviewer, because a silently dropped answer looks like the model never said anything. `parseAnswer` never throws: it sits on a network response, where garbage is a normal outcome.
- **`applyAiSuggestions` (`src/state/store.ts`) is one undo step.** It decides what to write *before* touching anything — a suggestion is dropped if its path no longer resolves, or if the field has been answered since the model was asked, so **the reviewer's own work is never overwritten** — and if nothing survives, it leaves no empty entry on the undo stack. It then snapshots once and mutates, creating any instances of repeatable nodes the model addressed but that did not exist yet. `lastFieldKey` is reset so the reviewer's next keystroke is not coalesced into the AI's step. `Ctrl/Cmd+Z` therefore undoes the **whole fill** in one go. It returns an `AiApplyResult` (`filled` / `skipped`) for the summary the dialog shows.

### AI marks

A field the model filled gets a light-blue border (`--ai-mark`, `.ai-marked` in `src/styles/index.css`) so the reviewer can see at a glance which values are not their own. Clicking into the control — or on its label (`NodeName`) — clears it: that click *is* the confirmation. `Field` and `AnnotationNode` read the flag through the `useAiMark(path, name, index)` hook and clear it via `confirmAiMark`.

Two properties make the marks safe:

- **They are session-only, by construction.** `aiMarks` is a `Record<string, true>` in the store, *not* a field of `Project`, so `serializeProject` has nothing to write even by accident — a saved file is byte-identical to one saved without the feature (pinned by `src/state/store.aimarks.test.ts`). Loading or closing a project clears them.
- **They only ever point at real AI values.** `applyAiSuggestions` marks the suggestions it *wrote*, never the ones it skipped. `undo`/`redo` clear **all** marks: undoing an AI run empties exactly the fields the marks point at, and a blue border on a now-empty field would be a lie. History restores values, not marks.

The key is `` `${paperId}::${formatPath([...path, { name, index }])}` `` — paper-scoped because every paper shares the same paths, and canonical (`src/llm/paths.ts`) so a mark set from a model suggestion and one looked up by the UI meet on the same string. Index 0 stays implicit, which is what keeps `Findings[1]/Claim` a different field from `Findings/Claim`.

## Electron Main Process

**`electron/main.ts`** is a thin main process:

- **Window**: `BrowserWindow` defaulting to **1920×1080**, context isolation enabled, node integration disabled, preload script loaded. The taskbar/dock icon is set from `build/icon.png` via `nativeImage` (and `app.dock.setIcon` on macOS so it shows in dev, not just the packaged bundle).
- **Window-state persistence**: size, position, and maximized state are saved to `window-state.json` in `app.getPath('userData')` and restored on the next launch. Writes are debounced on `resize`/`move`/`maximize`/`unmaximize` (400 ms) and flushed synchronously on `close`; maximized/fullscreen windows store their `getNormalBounds()` so restore returns to the user's chosen size. A saved position is only reused if it still overlaps a connected display (`screen.getAllDisplays()`), so a disconnected monitor can't strand the window off-screen; otherwise only the size is applied and the window is centered. Absent/corrupt state falls back to the 1920×1080 default.
- **Dev vs prod**: loads `VITE_DEV_SERVER_URL` in dev, `dist/index.html` in production.
- **External links**: `setWindowOpenHandler` sends `target="_blank"` links (external links in PDFs) to the system browser via `shell.openExternal` and denies the popup; `will-navigate` prevents any off-app navigation of the window itself. Only `http:`/`https:`/`mailto:` URLs are passed to the OS.
- **`slr-file://` protocol**: registered as privileged (secure, stream, fetch API, **CORS-enabled**). Handler resolves paths relative to `projectDir` with traversal guard (`path.resolve` + prefix check). Returns 403 for traversal attempts, 404 for missing files. `corsEnabled` is required, not cosmetic: the renderer's origin (dev server, or `file://` when packaged) differs from `slr-file://`, so loading a PDF is a cross-origin request. Without it Chromium rejects the request *before* `protocol.handle` runs, and pdf.js surfaces the opaque failure as `Unexpected server response (0)`.
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
  - `llm:configs` / `llm:saveConfig` / `llm:deleteConfig` — the LLM targets in `userData/llm-config.json`. The renderer is handed `publicConfigs()`: everything **except** the key, plus `hasKey`.
  - `llm:call` / `llm:abort` — send a renderer-built request with `net.fetch` after substituting the real key and checking the target origin against the config's `baseUrl` (see *AI-assisted annotation* above). `llm:abort` aborts an in-flight call by its `requestId`, since an `AbortSignal` cannot cross IPC.
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
- **Adding a new annotation field type**: Update `FieldType` in `schema.ts`, `emptyValue()` in `annotations.ts`, and `Field.tsx` rendering. Consider validation in the zod schema. Also teach the AI layer about it: `isUnanswered()` in `src/llm/fields.ts`, `coerce()` in `src/llm/parse.ts`, and the type rules in `src/llm/prompt.ts`.
- **Adding a new LLM provider**: Add it to `Provider` in `src/llm/types.ts` and to `PROVIDERS` in `src/llm/providers.ts` (base URL, whether it is editable, whether it can take a PDF), then handle its request shape in `buildRequest` and its response shape in `extractText` / `extractError`. Nothing else needs to change — the platform layer is provider-agnostic.
- **Changing the schema format**: it is described to the model in `SCHEMA_FORMAT_DOC` (`src/llm/prompt.ts`), which mirrors `docs/annotation-schema.md` §3 by hand. Both must move together, or the model reads an unfamiliar schema against a stale description.
- **Adding a new keyboard shortcut**: Add to `useKeybindings.ts`. Check `isEditable()` if it should be ignored inside input fields.
- **Changing the Electron IPC surface**: Update `preload.ts` (the `SlrBridge` interface), `electron/main.ts` (IPC handler), and `src/platform/electron.ts` (adapter method). All three must stay in sync.
- **Adding a new settings/appearance option**: Add to `src/state/settings.ts` (load/apply functions), add state + actions to the store, add UI controls to `Toolbar.tsx`, and add keybindings if needed.
