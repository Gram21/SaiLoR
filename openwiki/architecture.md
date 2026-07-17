---
type: architecture
title: SaiLoR Architecture
description: Deep dive into SaiLoR's architecture — the PlatformAdapter seam that unifies Electron desktop and web SPA runtimes, the Zustand store with undo/redo, the component tree, git integration, the Electron main process, and build wiring.
tags: [architecture, platform-adapter, state-management, electron, git]
---

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

**`PlatformAdapter`** (`src/platform/adapter.ts`) defines these operations (the list below is a
guided tour, not an exhaustive count, which would just go stale as the interface grows):
- `getRecents()` — return the list of recently opened projects (`RecentEntry[]` with `id` + `name`)
- `openRecent(id)` — re-open a project by its recent-entry id (path on Electron, IndexedDB handle key on browser)
- `openProject()` — show an open dialog/picker, return JSON text + a `SaveHandle`
- `saveProject(text, handle)` — write back to the handle's location
- `rebasePdfPaths(pdfPaths, from, to)` — re-express PDF paths that were relative to `from`'s directory as relative to `to`'s. **"Save as" depends on this**: a paper's `pdf` is stored relative to the project file, so writing the old paths to a new location left every PDF pointing at nothing. `store.saveAs()` therefore picks the destination *first* (`pickProjectLocation`), rebases, and only then serializes and writes. Electron does the real path math via a `paths:rebase` IPC (`relative(dirname(to), resolve(dirname(from), rel))`); the browser has no paths and returns the input unchanged.
- `getPdfSource(pdfPath, projectHandle)` — resolve a paper's relative PDF path into a URL react-pdf can load. On Electron it re-asserts the main process's project directory from `projectHandle` first, so PDFs always resolve against the project actually being rendered (the project editor repoints that directory when picking a location).

Three more exist for the **project editor** (see below):
- `pickProjectLocation(suggestedName)` — ask where the project JSON should live; writes nothing. Returns a `ProjectLocation` (`handle`, `name`, and — Electron only — an absolute `path`).
- `pickPdfs()` — pick PDFs to reference; returns `PickedPdf[]` (`name`, plus an absolute `path` on Electron).
- `pickPdfFolder()` — pick a folder and return every PDF inside it, recursively, as `PickedPdf[]`. Electron walks the filesystem via IPC (`pdf:pickFolder`); the browser reuses the same `webkitdirectory` `<input>` the PDF-viewer's one-time folder grant uses (see `pickPdfFolderViaInput` below), filtered to `.pdf` names.
- `pickReferenceFile()` — pick a single `.bib`/`.ris`/`.json` reference-manager export; returns `{ text, name }` or null if cancelled. Parsed by `src/model/references.ts`.
- `relativePdfPaths(pdfs, location)` — the `pdf` values to store, **relative to the JSON's directory**. Electron computes real relative paths via IPC; the browser returns bare file names (the File System Access API exposes no paths).
- `absolutePdfPaths(pdfPaths, from)` — the inverse: absolute paths for values relative to `from`'s directory. Added for `startFromScreening`/`importFromScreening` (see "Screening" below) — a paper carried in from a screening project needs a real `sourcePath`, not just the relative path the source file stored, or `changeLocation` cannot re-derive it later. The browser returns `undefined` per entry (no paths to compute from), leaving those rows exactly where an edited project's rows already sit.
- `siblingProjectLocation(source, fileName)` — the location `fileName` would have if it sat next to `source`'s directory; writes and prompts nothing. What makes "save the new annotation project next to the screening JSON" the *default* rather than a dialog suggestion. Returns `null` in the browser (no paths), and callers fall back to `pickProjectLocation`.

One more is its own capability object rather than a flat method: `getGit(): GitPlatform | null` —
git operations against the user's own git installation, or `null` where the runtime cannot reach one
(the browser). See "Git" below.

**Project title.** A project JSON may set a top-level `title`; the app shows it wherever it would otherwise show the file name (toolbar, recents list, Open menu), falling back to the file name when absent. It is a first-class key on `Project` (not swallowed into `extra`, which would duplicate it on save) and is only written when non-empty. The project editor exposes it as a *Project title* field next to the JSON location.

**Recents are re-read from disk, not trusted.** The title shown for a recent is stored on the entry, but that copy goes stale the moment the project is renamed elsewhere — most obviously by changing the *Project title* in the editor, where the old name would otherwise still be sitting in the list after closing it. So `checkRecents()` **re-reads each project's current title from the file**: on Electron a `project:peek` IPC returns `{ exists, title }` per path in one round trip (parse failures are contained per file); in the browser it reads through the retained handle, but **only when read permission is already granted** — startup must never throw a permission prompt at the user just to refresh a label, so without permission the stored title is kept. The refreshed list is written back (`replaceRecents`, order preserved) so the fresh titles survive a restart, and `editorStore.save()` triggers a refresh so a rename shows up as soon as the editor is closed. A title removed from a file correctly reverts the entry to showing its file name.

**A recent whose file has gone is kept, not forgotten.** `checkRecents()` (run on startup via `refreshRecents()`) re-tests each entry — `fs:exists` on Electron, "do we still hold the IndexedDB handle" in the browser — and sets a runtime-only `available` flag (never persisted). A missing project stays in the list, faded, badged *not found*, and unselectable, because the drive may come back; the user can still dismiss it with the ×. Opening one that has since vanished marks it unavailable rather than pruning it. Note the flag is deliberately tri-state: `undefined` means *not checked yet*, and only an explicit `false` greys an entry out, so nothing flickers on first paint.

**Closing a project** (`requestCloseProject`) returns to the start screen, and when there are unsaved changes it first asks via `ClosePrompt` — the same three choices and wording as Electron's native quit dialog (Save / Don't Save / Cancel). A *failed* save keeps the project open rather than closing and losing the work.

**Recents entries** carry `path` and `title` beyond `id`/`name`. The path is what lets a user tell two projects called `review.json` apart: the start screen shows it under the title (truncated from the *left*, since the tail is what differs — `direction: rtl` + `unicode-bidi: plaintext`, the latter so the leading `/` isn't reordered to the end), and the Open menu shows it as a hover tooltip. On the start screen each entry also carries a **✎** pen (`useEditorStore().startEditRecent(id)`) that opens the project straight into the schema editor instead of the annotation view — the same edit path as *Edit annotation JSON…*, but for a known recent rather than a file picker. Both places offer an **×** to drop an entry (`forgetRecent`), which in the menu deliberately does *not* close it, so several can be cleared in a row. The title is only known once the JSON is parsed, so `loadFromText` re-pushes the entry via `rememberProject()` — `pushRecent` dedupes by id, so this enriches the existing entry rather than duplicating it.

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
| PDF loading | One-time folder grant via `showDirectoryPicker`, blob URL | One-time folder grant via a `webkitdirectory` `<input>`, blob URL | `fetch` relative to project URL |

`setServerBase(url)` records the URL a project was fetched from so sibling PDFs resolve correctly in server mode. The adapter stores `FileSystemFileHandle` references in an internal map keyed by generated IDs.

**Every locally opened project — FSAPI handle or `<input>` fallback alike — resolves its PDFs through a folder the reviewer grants access to once, never a fetch.** A local project has no URL for its PDFs to live at, so `getPdfSource` branches purely on whether `serverBase` is set: unset means "resolve locally", full stop, regardless of how the JSON itself was opened. `resolveLocalPdf` calls the shared `ensureLocalPdfGrant()` (prompts only if neither `pdfDir` nor `pdfFileMap` is set yet — a no-op once one is), then dispatches to whichever grant it produced: `resolveViaDir` walks `getDirectoryHandle`/`getFileHandle` per path segment on the FSAPI directory handle; `resolveViaFileMap` looks the path up in the map `ensureLocalPdfGrant` built from a folder-picking `<input>`'s `webkitdirectory` attribute (non-standard name, but implemented everywhere that matters — Firefox, Safari, Chromium), which reads an entire folder tree in one go and keys each file by its `webkitRelativePath` with the picked folder's own name stripped (that name isn't part of the project-relative paths stored in the JSON). Either mechanism prompts **once per session**.

**`needsPdfFolderGrant()` / `grantPdfFolderAccess()`** are `PlatformAdapter` methods that expose that same grant explicitly, so a caller can ask for it from a real click instead of letting `getPdfSource` pop the native picker unannounced. `PdfViewer.tsx` checks `needsPdfFolderGrant()` before ever calling `getPdfSource` for the first PDF of a locally opened project; if true, it renders an in-app explanation with a **Choose folder…** button instead, and only calls `getPdfSource` after the button's click has driven `grantPdfFolderAccess()` (which just calls the same `ensureLocalPdfGrant()`) to completion. `getPdfSource` itself still auto-prompts via `ensureLocalPdfGrant()` if called directly without this check — a caller like `aiStore.ts`'s `run()`, which reads a paper's PDF bytes for the AI-annotation flow and doesn't go through `PdfViewer`'s gate, still gets a working (if unannounced) prompt rather than an error. `ElectronAdapter` implements both methods as `false`/no-op — there is no such prompt on the desktop build, PDFs are read straight off disk via `slr-file://`.

**`pickPdfFolderViaInput`'s "did the user cancel" detection uses the `cancel` event, not a focus-return guess — and this isn't a stylistic choice.** A focus-based guess (the pattern the older `pickFileViaInput`/`pickFilesViaInput` still use, for a plain — non-directory — file pick) is unsafe here specifically: Firefox inserts its **own** "Upload N files from this folder?" confirmation *after* the OS folder dialog closes, and that OS dialog closing already returns window focus — well before the user has answered Firefox's prompt. A short focus-based timeout reads that in-between moment as a cancel and resolves empty while the real selection is still on its way, which is indistinguishable from a genuine cancel to the caller. The dedicated `cancel` event (Chrome 113+, Firefox 106+, Safari 16.4+) fires only when the picker was actually dismissed with nothing chosen, so it doesn't have this problem; a focus-based fallback still exists for an engine with neither event, but at a much longer delay (2s, up from the old 300ms) specifically to give a pending confirmation step like Firefox's room to resolve first.

This used to only run for an FSAPI handle — every other local-open path (Firefox/Safari, or Chromium without the FSAPI grant) fell straight through to a `fetch` against the *app's own* page URL, which obviously never contains the reviewer's PDFs. That fetch didn't even fail cleanly: on a dev server or any SPA-style static host it 200s with `index.html` instead of 404ing, so the failure surfaced three layers away as pdf.js's opaque `InvalidPDFException: Invalid PDF structure` — indistinguishable from an actually-corrupt file. The byte-level check described below catches that case when it's genuinely a server-mode misconfiguration; this local-resolution fix is what stops it from happening at all for the (very common) case of a reviewer just opening their own project file.

When the File System Access API is available, the `BrowserAdapter` also persists handles in IndexedDB (`src/platform/idb.ts`) so they survive page reloads. `openProject()` and `saveProject()` (via the FSAPI Save As flow) call `rememberHandle()` which stores the handle under a `recent:<name>` key and pushes an entry to `slr.recents.browser`. `openRecent(id)` retrieves the handle from IndexedDB, re-requests read permission (via `ensureReadPermission`), and re-reads the file. If the handle is missing or permission is denied, the entry is pruned from recents.

**Opening any new project — local or server-mode — clears whatever the *previous* project's PDFs resolved through**, via `clearLocalPdfGrants()` (drops `pdfDir`/`pdfFileMap`) alongside resetting `serverBase`, from all three project-load paths plus `setServerBase()` itself. Without this, switching from Project A (with a granted folder or a set server base) to Project B would silently keep resolving PDFs through A's leftover grant — at best a confusing "not found", at worst the *wrong* PDF's bytes for a path that happens to collide between the two projects.

**`getPdfSource`'s server-mode fetch branch validates the response bytes, not just the HTTP status.** A dev server's SPA fallback, a static host's catch-all rewrite, or a reverse-proxy login page can all answer `200` with HTML for a PDF path that doesn't actually exist — `res.ok` alone can't tell that apart from a real PDF. Handing pdf.js those bytes produces its own genuine `InvalidPDFException: Invalid PDF structure`, which reads as a corrupt file when the real problem is upstream (wrong base, missing file, wrong deploy config). So before trusting a fetched body, `hasPdfMagic()` checks it actually starts with PDF's own magic number (`%PDF-`) — read from `res.arrayBuffer()`, not `Content-Type` (plenty of static hosts serve everything as `application/octet-stream`, so a header check alone would reject real PDFs) — and throws a specific "the server answered, but not with a PDF" error naming the URL it tried, instead of letting the failure surface three layers away in pdf.js.

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
| `aiMarks` | `Record<string, true>` | Fields the AI filled and the reviewer has not looked at yet, keyed `` `${paperId}::${canonicalPath}` `` for a single-reviewer project, or `` `${paperId}::${reviewer}::${canonicalPath}` `` for a multi-reviewer one (see "AI marks" below). Session-only: it lives *beside* the project, so `serializeProject` cannot see it |
| `currentReviewer` | `string \| null` | Which reviewer's tree is shown/edited — `"1".."N"`, `"consolidation"`, or `null`. Always `null` for a single-reviewer project; also starts `null` for a multi-reviewer one until picked (see "Multiple reviewers & Consolidation" below). Persisted per project in `localStorage`; not an undo step, does not set `dirty` |
| `consolidationTarget` | `{ path, name, index } \| null` | The field the Consolidation "compare" popup (`ConsolidationDialog`) is showing, or `null` when closed. Session-only |
| `screeningFilter` | `'all' \| 'included' \| 'excluded' \| 'undecided'` | Which decisions the screening paper list shows. Screening projects only; session-only, resets on `closeProject`/`loadFromText` |
| `screeningShowPdf` | `boolean` | Whether the middle pane shows the PDF instead of `ScreeningRecord`'s title+abstract. Session-only, see "Screening" above |
| `screeningSummaryOpen` | `boolean` | Whether `ScreeningSummary` (the PRISMA-style counts modal) is open. Session-only |

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
- **`selectReviewer(reviewer)`** — switches `currentReviewer` and persists the choice per project. A view switch: no undo step, no `dirty`
- **`openConsolidation(path, name, index)` / `closeConsolidation()`** — open/close the compare popup for one field
- **`alignConsolidationNode(paperId, nodeName, coalesce)`** — match the reviewers' repeated entries under one node and write the result in (reorder + grow); see "Matching the reviewers' repeated entries" below
- **`adoptUnanimousValues(paperId, coalesce)`** — fill the consolidated fields every reviewer answered the same way, marking each via `aiMarks`; runs after the matching for a paper
- **`setScreeningDecision(decision, reason?)` / `setScreeningReason(reason)`** — screening-only field writes, routed through `currentTree` like every other write; see "Screening" below for the auto-advance and reason-clearing rules
- **`adoptAllUnanimousScreening()`** — `adoptUnanimousValues` for every paper in one undo step; safe unscheduled (unlike the per-paper alignment scheduler) because a screening schema has nothing for `align.ts` to line up — see "Screening" below
- **`adoptAllUnanimousAnnotations()`** — the ordinary-schema counterpart: aligns, then adopts, paper by paper, in one undo step, skipping any paper the consolidator has already partly answered; see "Batch-adopting across the whole project" above

The `containerAt(root, path)` helper walks the annotation tree following `PathSeg[]` (name + index pairs) to reach the container for a given path. `currentTree(project, currentReviewer, paper, create?)` decides *which* tree that walk starts from — see "Multiple reviewers & Consolidation" below; `setFieldValue`, `addInstance`, `removeInstance`, and `applyAiSuggestions` all call it before touching anything.

## Component Tree

```
App (src/App.tsx)
├── Toolbar (src/components/Toolbar.tsx)
│     Open ▾ dropdown (Open file… + recent projects) + Save ▾ dropdown (Save / Save as…)
│     Font controls (A− A A+), theme toggle (☾/☀), help (?)
│     Reviewer switch (multi-reviewer projects only), centered on the toolbar — Reviewer 1..N + Consolidation, hidden entirely for a single-reviewer project; pills at ≤5 reviewers, a dropdown above that; see "Multiple reviewers & Consolidation" below
├── [if project loaded: workspace — a CSS grid whose column widths come from resizable panes]
│   ├── PaperList (src/components/PaperList.tsx)
│   │     List of papers with search box (META / TAGS modes, see below); a dot showing the active reviewer's completeness — a conic-gradient partial fill, not just touched/untouched, see "Completeness dot" below (screening and Consolidation keep their own tri-state/binary markers); click to select
│   ├── Splitter (src/components/Splitter.tsx) ×2  — drag handles between the panes
│   ├── [screening project + PDF pane not toggled on: ScreeningRecord (src/components/ScreeningRecord.tsx)]
│   │     Title/authors/DOI header + the abstract (or "No abstract recorded"); a "Read the PDF" button swaps to PdfViewer when paper.pdf !== ''
│   ├── [otherwise, including the screening PDF toggle: PdfViewer (src/components/PdfViewer.tsx)]
│   │     react-pdf Document+Page; ResizeObserver for width; zoom controls; multi-page navigation; jump history (back/forward); in-PDF search (Ctrl+F); text selection capture; empty state for paper.pdf === '' (screening only)
│   ├── [screening project: ScreeningPanel (src/components/ScreeningPanel.tsx)]
│   │     Include/Exclude decision buttons + a Reason ComboBox (disabled unless Exclude) + progress line; ◧ Summary always, ⚖ Agreement / ⚠ Disagreements in the Consolidation seat — see "Screening" below
│   └── [otherwise: AnnotationPanel (src/components/AnnotationPanel.tsx)]
│         ✦ AI button in the column header (opens AiDialog; disabled while busy, when the paper has no PDF, when the project forbids it, when no reviewer is picked yet, or — by default — always, until the hidden unlock; see "AI-assisted annotation" below)
│         renders the tree `currentTree()` routes to for the active reviewer; prompts to pick a reviewer instead of the form when a multi-reviewer project has none selected yet
│         └── AnnotationNode (src/components/AnnotationNode.tsx) [recursive]
│               └── Field (src/components/Field.tsx)
│                     Input control (text/number/checkbox/enum ComboBox) + ⧉ grab-from-PDF button + (Consolidation mode only) ⇄ compare button → opens ConsolidationDialog for that field
├── [if no project: welcome screen with "Open project…" button, "New from screening…", and (if any) recent projects list]
├── AiDialog (src/components/AiDialog.tsx)
│     Modal driven by useAiStore's phase: pick a target → Start → review table → Apply
│     └── LlmSettingsDialog (src/components/LlmSettingsDialog.tsx) — manage LLM targets (stacks on top)
├── HelpDialog (src/components/HelpDialog.tsx)
│     Modal overlay with app intro + keyboard shortcuts table
├── ValidationDialog (src/components/ValidationDialog.tsx)
│     Modal overlay showing the results of "Validate", scoped to the active reviewer's own tree (or the consolidated one, for Consolidation) — see below
├── ConsolidationDialog (src/components/ConsolidationDialog.tsx)
│     Modal overlay reachable only from Consolidation mode's ⇄ button: every reviewer's answer for one field, side by side; picking one writes it into the consolidated tree
├── ScreeningSummary (src/components/ScreeningSummary.tsx)
│     Modal: progress + PRISMA-style include/exclude/reason counts for a screening project
├── ScreeningImportDialog (src/components/ScreeningImportDialog.tsx)
│     Modal: the pre-commit summary for "New from screening…" / "Import from screening…", including "New from screening…"'s annotation/screening target-kind radio — see "Screening" below
├── DuplicateReviewDialog (src/components/DuplicateReviewDialog.tsx)
│     Modal: reviewing the *probable* duplicates a reference import found — one row per pair, a merge/separate choice defaulting to undecided — see "Duplicate detection at import" below
├── GitCloneDialog (src/components/GitCloneDialog.tsx)
│     Import-from-git modal, driven by useGitStore's clone.phase: setup (URL + destination) → cloning (spinner + elapsed seconds) → error (git's exact text, back to setup) → done (pick the project JSON, opened inside the clone) — Electron only, see "Git" above
├── GitDialog (src/components/GitDialog.tsx)
│     Modal for the open project's own repository: changes + diff, a commit message, Commit, Pull, Push — shown only when the toolbar's Git button is present. When the open project's own file is a tracked, field-diffable modification, its changes are reviewed field by field (Use/Ignore/Discard per row) instead of as one whole-file checkbox — see "Field-level commit review" below. When every row is marked Discard, the primary button relabels to "Discard all" (danger-red) and reverts marked rows directly via `runDiscard` without committing
├── GitMergeDialog (src/components/GitMergeDialog.tsx)
│     The pull's conflict-resolution list, grouped by paper (one collapsible section per paper, auto-collapsing when its last conflict is decided): your value left, the remote's right, an editable final value in the middle, with full-text wrapping instead of one-line clipping. No Escape, no backdrop-click, no × — see "Git" above for why
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

### PaperList search modes

The paper-list search box (`src/components/PaperList.tsx`) has two modes, toggled by a trigger sitting *inside* the input's right-hand edge, labelled **META** (title + authors + DOI + PDF file name + paper ID, the default) and **TAGS** (the annotation values recorded in the active reviewer's tree; see `currentTree` above). The trigger is given a fixed width rather than relying on its two labels being the same length: the active state is bold, and bold vs. regular text of equal character count still measures a few px apart, which would reintroduce exactly the reflow the fixed width exists to prevent. It replaced a 🔎/🏷 emoji pair whose differing glyph widths visibly resized the control on every toggle. Both modes share one ranking: filter to papers where every query word matches, then sort by distinct words matched, then total matched characters, then original order — only the haystack differs per mode. The META haystack (`paperMetadataHaystack`) includes `paper.pdf` (the file name) and `paper.id` so a reviewer can find a paper by the PDF they remember or by its identifier, not just by bibliographic metadata.

Both haystacks are precomputed once per paper in a `useMemo` keyed on `[papers, schema]`, not re-walked on every keystroke. `papers` is a safe key for annotation content too: the store's immer `set` produces a new paper object — and therefore a new `papers` array — on every field edit, so the memo is invalidated exactly when annotation content actually changes, never stale.

The annotation haystack comes from `annotationText(schema, tree)` (`src/model/annotations.ts`), which mirrors `hasAnnotations`'s recursive walk: it collects every field `value` that is a non-empty string or a number, joined and lowercased. Booleans are skipped — every paper has one per boolean field (defaulting to `false`, never absent), so including "true"/"false" would make almost every paper match. Like the rest of that module, it never throws on a tree that doesn't match the schema's shape.

### Completeness dot

The paper-list dot used to be binary: touched or not, via `hasAnnotations`. `src/model/completeness.ts` replaces that with a real fraction, rendered as a **conic-gradient** partial fill (`.status-dot.partial { background: conic-gradient(var(--ok) var(--fill), transparent 0) }`, `--fill` set inline per row) instead of a flat colour.

- **`completeness(defs, tree)`** walks the schema the same way `hasAnnotations` does and returns `{ filled, total }`. **`hasRequiredFields(defs)`** decides the denominator: if the schema declares *any* required field anywhere (including nested), only required fields are counted; otherwise every field counts. This is the fix `completeness.test.ts` calls out by name as "the headline bug this module fixes" — a schema with one required field out of thirty used to make finishing that one field look like 3% progress.
- **Booleans are excluded from the count entirely**, for the same reason the Validation section below documents `isEmptyValue`/`hasAnnotations` disagreeing on them: an untouched checkbox reads `false`, indistinguishable from a deliberate "no", so there is no way to count it as "filled" or "unfilled" that isn't a guess. Completeness is a third function with its own opinion here — it doesn't count the field at all.
- **Repeatable instances are counted per present instance**, not once per node, so adding a second Finding grows the denominator along with the numerator.
- **`completenessPercent(c)`** returns `null` — the signal to fall back to the old binary dot — whenever `c.total === 0` (an empty schema). It otherwise clamps to `[5, 99]` for any non-zero, non-total count, so a paper at 1/200 fields doesn't visually read as empty and one at 199/200 doesn't read as done; the literal old `status-dot`/`status-dot done` classes are reused verbatim at exactly 0% and 100%, rather than rendering a conic gradient that would look the same as those two classes anyway.
- **Screening projects and the Consolidation seat opt out**, keeping their existing tri-state/binary markers: `paperCompleteness()` (`PaperList.tsx`) returns `null` for them, the same "nothing to compute" signal `total === 0` produces, so both routes land on the same old-dot fallback with no separate branch.

**`PaperRow` was pulled out of `PaperList`'s `.map()` and wrapped in `React.memo`.** Its props (`paper`, `active`, `onSelect`, `dotClassName`, `dotLabel`, `dotFill`) are deliberately primitives — `dotFill` is passed as a bare number rather than the `Completeness` object, specifically so memo's shallow comparison is cheap and correct. This pays off because of how the store's immer `set()` already works (see "State Management" above): editing one field produces a new object for exactly that one paper, leaving the other 1999 array entries referencing their old objects — confirmed directly by `PaperList.perf.test.ts`, which asserts exactly 1 of 2000 paper objects changes identity per edit. So a single edit re-renders exactly one row's `PaperRow`, not all 2000. Measured cost (from the feature's own commit message): recomputing `completeness` (and the search haystack) over 2000 papers costs on the order of 3–4ms, and the row re-render this memoization buys back drops to single-digit milliseconds — comfortably fast enough that no windowing/virtualization was added for this.

### Validation

`src/model/validate.ts` checks a reviewer's annotations against the schema; the **Validate** button in the toolbar runs `validateProject(project)` and `ValidationDialog` shows the result grouped by paper (click a paper to jump to it). Four issue kinds: `required` (a field marked required is empty), `type` (the stored value doesn't match the field's type — the JSON is hand-editable), `enum` (a value outside the field's `options`), and `cardinality` (an instance count outside `[min, max]`).

**Only papers with at least one annotation are actually validated.** `validateProject` returns `{ issues, unannotated }`, not a bare array: a paper nobody has touched yet fails every required field for the single reason that it hasn't been started, which would drown the results in noise that says nothing a reviewer doesn't already know from the paper list's own "not annotated yet" dot. Such a paper is skipped from `issues` entirely and instead added to `unannotated` — the check is `hasAnnotations(schema, paper.annotations)` (`src/model/annotations.ts`, the same primitive that drives that paper-list dot, see below), so "annotated" means exactly the same thing in both places: **on the first field genuinely filled in**, not merely present in the tree. This matters for booleans specifically, since `hasAnnotations` disagrees with `isEmptyValue` on purpose — a boolean left at its untouched `false` does not count as an answer here (only an explicit `true` does), whereas `isEmptyValue` treats a boolean as never empty for the `required` check. The two functions are answering different questions ("has this paper been started at all" vs. "is this one required field answered") and are not meant to agree. `ValidationDialog` renders `unannotated` as a separate, plain "not annotated yet" checklist below the issues — clickable like everything else, but with no kind badge or message, since there is nothing to report beyond "this one hasn't been started."

**Emptiness is the load-bearing definition**, and booleans are the special case: a `boolean` field is **never** empty. An unticked box is a real answer (`false`), and a missing/`null` boolean reads as `false` — so a required boolean can never raise a `required` issue. `0` is likewise a real number, and `''`/whitespace is empty only for strings. A type mismatch suppresses the `required`/`enum` checks for that field, so one broken value yields one issue rather than a cascade. Everything is defensive: a malformed tree produces issues rather than throwing.

Fields are marked required by `required: true` in the schema (`ResolvedDef.required`, defaulting to `false`; rejected on a group, which holds no value). The schema editor exposes it as a **Required** checkbox on non-group rows, and the annotation form marks such fields with a red `*`.

Note that `loadProject` normalizes the tree to each node's `min`/`max`, so in practice `cardinality` issues only arise from a project that bypasses the loader.

**On a multi-reviewer project, Validate checks the active reviewer's own tree**, not the consolidated one — unless the active reviewer *is* Consolidation, in which case it checks the tree that actually ships. `runValidation` (`store.ts`) builds this by mapping each paper's `annotations` through `currentTree()` before calling `validateProject`, so `validate.ts` itself needs no reviewer awareness. The **Validate** button is disabled until a reviewer is picked, for the same reason the annotation form is withheld then: there is no "the reviewer" to validate yet.

### Project editor

A second screen (`src/components/ProjectEditor.tsx`, shown instead of the workspace while `useEditorStore().open`) lets users **create or edit a project JSON** — its annotation schema and the PDFs it references — without hand-writing JSON. It is entered from the welcome screen's *New annotation JSON…* / *Edit annotation JSON…* buttons, or from the **✎** pen on a recent project (`startEditRecent`, which loads that recent by id rather than prompting a file picker; `startEdit` and `startEditRecent` share `editorStateFromOpened`).

The **help dialog is mode-aware**. `HelpDialog` derives a mode from `useEditorStore().open` and whether a project is loaded, then renders one of three guides, each with only the shortcuts that actually do something there, plus a badge in the title naming the mode:
- **Getting started** (start screen, nothing open) — what an SLR project JSON *is*, and what the three buttons do (open / new / edit).
- **Annotating** (a project is open) — pick a paper, read the PDF, fill the fields, save.
- **Editing the annotation JSON** (the editor is open) — schema building, drag-to-nest, adding PDFs, the two save buttons.

Shared sections (appearance, license) render in all three.

Two ways out of the editor: **Save JSON** writes the file and stays put (so you can keep building), while **Save JSON & Begin Annotating** writes it and hands it to the annotation view (`loadFromText`) — that split is `save()` vs `saveAndAnnotate()`. Both validate first, so an invalid draft neither writes nor closes. The editor has its own **undo/redo** history (`past`/`future` snapshots, same shape as the annotation store, with consecutive keystrokes in one input coalesced into a single step), and `useKeybindings` / `useElectronCloseGuard` route `Ctrl+S` / `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` to it whenever it is open.

- **`src/state/editorStore.ts`** — a separate Zustand+immer store holding the draft. It deliberately works on the **raw JSON shape**, not the loaded `Project`: each paper's `annotations` object is carried through **verbatim** while the schema is edited, so editing the schema never prunes existing annotation data (it is normalized against the new schema the next time the project is opened for annotating). Key pieces: `EditorNode` (a schema node with a client-side `uid`, where `kind: 'group'` means "no `type`" — a name-only sub-tree), `EditorPaper` (which also keeps the PDF's absolute `sourcePath`), `toAnnotationDefs`/`fromAnnotationDefs` (conversion to/from the compact on-disk `AnnotationDef`), `moveNodeIn` (tree move that refuses to drop a node into itself or its own subtree), `buildProjectJson`, and `validateDraft` — which runs the *real* `projectSchema` + `resolveSchema` validators, so the editor cannot produce a file the loader would reject. On save it writes the JSON and hands it straight to the main store via `loadFromText`.
- **`SchemaTreeEditor.tsx`** — recursive tree exposing the schema's full expressiveness: name, kind (Group / Text / Number / Yes-no), `min`, `max` (with an ∞ checkbox for `max: null` = unbounded repeats), description, enum `options` (string fields only), nesting, add/remove. Native HTML5 drag-and-drop reorders rows and builds nesting: the drop position comes from the pointer's Y within the target row — top 25% → `before`, bottom 25% → `after`, middle → `inside` (nest as a child).
- **`PapersEditor.tsx`** — add PDFs one at a time, a whole folder at once, import a reference-manager export, or (outside a screening project) import from a screening project's results (four buttons next to each other in the header/empty state), edit each paper's id/title/authors/DOI/abstract and its `pdf` path, reorder by drag, remove.
- **`ScreeningReasonsEditor.tsx`** — replaces `SchemaTreeEditor` in the editor body whenever `useEditorStore().screening` is set: an ordered, editable list of exclusion reasons (add / remove / reorder with plain ↑/↓ buttons rather than drag — the list is short enough that drag-and-drop's extra affordance isn't worth it), writing through `setScreeningReasons`. On blur after renaming a reason, the editor checks `countPapersUsingReason` (`src/screening/reasonUsage.ts`) across both consolidated and per-reviewer trees; if papers still record the old label, it offers to migrate those decisions to the new label (or warns when there is no new label to migrate to), so a rename never silently orphans a decision. See "Screening" below.
- **`ProtocolEditor.tsx`** — a collapsible *Review protocol* section in the project editor for `Project.protocol` (research questions, search strings, databases, search date, notes). See [Data Model](data-model.md)'s "The review protocol" section for the field's shape and merge behavior.

**Adding PDFs** (`addPdfs`) does two things beyond appending rows:
- **Duplicate rejection.** A PDF already referenced is skipped rather than added twice, and the skipped names are reported in a dismissible notice. Identity is `pdfKeys()`: the absolute path when known (Electron) *and* the stored relative path — so re-picking the same file, picking it twice in one dialog, or picking one already listed in an opened project all collapse to one entry. Same-named PDFs in different folders stay distinct.
- **Title/author auto-fill.** `src/model/pdfMeta.ts` reads each added PDF (`PickedPdf.read()` — an IPC in Electron, `File.arrayBuffer()` in the browser) and pre-fills the fields. It tries the PDF's embedded `Title`/`Author` metadata first, validating it (`isPlausibleTitle` rejects artefacts like "Microsoft Word - paper_final_v3.doc"), then falls back to a layout heuristic on page 1: the largest text near the top is the title (joined across wrapped lines), and the lines under it are the authors. A line is not a flat string but a list of **segments**, split wherever two runs on the same baseline sit more than `COLUMN_GAP_RATIO` font-sizes apart — a word space is a fraction of the font size even in justified text, a column gutter is several times it. This matters because the common two-column author block puts each author on the *same baseline* with nothing between them but the gutter: joined first, `Jan Keim` and `Angelika Kaplan` read as the single name "Jan KeimAngelika Kaplan", and no amount of later parsing can recover the boundary, since there is no punctuation at it. So authors are parsed per segment. A run whose `width` pdf.js does not report never starts a segment: without it there is no way to know where a run ends, and guessing could cut mid-phrase. `parseAuthorList` strips affiliation superscripts, footnote daggers, emails and an "Authors:" label; in `strict` mode (used only for the heuristic, which is a *guess*) it also requires each entry to look like a person's name, so a body sentence can't become an author list.

**A long author list wraps, and the break lands inside a name** — a real seven-author paper (`samples/pdfs/A1-37.pdf`) ends one line `… Niklas Ewald, Tobias` and opens the next `Thirolf, and Anne Koziolek`. Parsing each line on its own loses two authors and cannot get them back: `Tobias` is a lone token `strict` mode correctly rejects, and `Thirolf` never recovers its first name. So `namesFromAuthorBlock` joins the lines *before* parsing — per column, matching segments by `x` (`COLUMN_X_TOLERANCE`), so a two-column block's wraps stay inside their own column instead of inventing a name across the gutter. Superscript affiliation keys, which sit on their own raised baseline and so arrive as a line of their own (`"1 1"`) *between* the halves of a wrapped list, are stepped over rather than stopped at (`SUPERSCRIPT_SIZE_RATIO`).

**Growing that block is guarded, and the guard is what makes it safe.** The line under the authors is far more often an affiliation or an email row than the rest of the list, and absorbing one does not merely add noise — it *destroys* names, since the last author fuses with it into a single entry (`"John Smith Karlsruhe Institute of Technology"`) that `parseAuthorList` then drops wholesale as an affiliation. So a candidate line is kept only when the block including it yields strictly **more** names than the block without it. That tests the join on its own evidence, which is both simpler and harder to fool than trying to recognise an affiliation line up front — a real continuation adds names by construction, and every kind of line that shouldn't be absorbed takes them away. Everything is best-effort and only ever pre-fills — rows appear immediately with a name-derived placeholder, extraction patches them in the background, and it never overwrites a value the user has already typed. The pdf.js worker is configured once in `src/platform/pdfjs.ts`, shared by the viewer and the extractor. The same background pass also tries an abstract (`abstractFromLines`) when the row has none — see the Screening section's "A missing abstract is extracted from the PDF, and flagged durably" for why that one gets a persisted `abstractFromPdf` disclosure the title/author guesses above do not need.

**Adding a whole folder of PDFs** (`addPdfFolder`) is `addPdfs` with a different picker: both funnel into a shared `addPickedPdfs(picked)` closure in `editorStore.ts` that does the duplicate rejection, row creation, and background title/author extraction described above. Only `pickPdfs()` vs `pickPdfFolder()` differs. `pickPdfFolder()` returns every `.pdf` found recursively under the chosen folder — Electron via a plain recursive `readdir` walk over the real filesystem, the browser via the same `webkitdirectory` `<input>` mechanism `ensureLocalPdfGrant()` uses for the PDF-viewer's one-time folder grant (see `pickPdfFolderViaInput` above) — filtered to file names ending in `.pdf`. Reusing that input, rather than writing a second one, keeps the one careful piece of cross-browser logic (the `cancel`-event-not-focus-guess cancellation detection, needed because Firefox's own "Upload N files?" confirmation appears *after* the OS dialog already returns focus) in one place.

**Importing references** (`importReferences`) reads a BibTeX/RIS/CSL-JSON export from a reference manager (Zotero, Mendeley, JabRef, EndNote) and turns each entry into a paper row, without requiring a PDF to already be attached. `src/model/references.ts` (`parseReferences(text, filename)`) is a pure, defensive parser — the format is picked from the extension, content-sniffed as a fallback — that **never throws**: a malformed entry (unbalanced braces, a missing field, an entry with no title) is skipped rather than failing the whole file. For each parsed `RefEntry`, `editorStore.ts` **dedupes against existing rows** via `classifyImport` (see "Duplicate detection at import" below): a `certain` match fills in that row's *empty* fields only (never overwriting something the reviewer already typed) and counts as "updated" or "already complete" in the summary notice; a `probable` match is held back for the reviewer to decide (`DuplicateReviewDialog`); a `new` entry adds a fresh row with `pdf: ''` (or the imported `pdfHint`'s file name as a placeholder, if the reference file named one) for the reviewer to attach a PDF to afterward. The whole import (including any duplicate-review decisions) is one undo step. Because `pdf: ''` is something `addPdfs`/`addPdfFolder` never produce, `validateDraft` reports it as a named per-paper issue ("Paper N has no PDF attached") rather than letting it reach `buildProjectJson`/`save()`, which still requires the on-disk `pdf` to be non-empty (`paperSchema` in `src/model/schema.ts` is unchanged — this tolerance is draft-only).

### Duplicate detection at import (`src/model/duplicates.ts`)

Before this existed, `importReferences`' dedup was two flat tiers — an exact DOI match, else an exact normalized-title match — and anything short of that silently became a second row for a paper already in the project. `classifyImport(existing: DupRecord[], incoming: DupRecord[]): DupVerdict[]` replaces both tiers with a graded one: every incoming record is classified `new`, `certain`, or `probable`, checked **both** against the papers already in the project and against earlier records in the same incoming batch (so importing the same paper twice in one file is caught too), in this priority:

1. **Exact DOI** (case-insensitive) — `certain`, and the only tier the year check below never touches.
2. **Exact normalized title** (lowercased, whitespace-collapsed, punctuation-stripped) — `certain`.
3. **Fuzzy full-title match** — `stringSimilarity` (`src/consolidate/similarity.ts`) ≥ 0.90 — `probable`.
4. **Subtitle-stripped base title** (everything before the first `:`) at the same ≥ 0.90 threshold, gated on an author-surname Dice coefficient ≥ 0.50 — `probable`. This is what catches "same paper, different subtitle" without also catching two unrelated papers that happen to share a generic title fragment.

A year gap of `YEAR_GAP_VETO` (2) or more demotes an otherwise-matching **title** pair straight to `new` — two papers four years apart are not the same paper no matter how alike their titles read. The veto is title-only: a DOI match is definitive on its own and is never second-guessed by a year gap.

`classifyImport` **reuses** `stringSimilarity` rather than reimplementing fuzzy title matching — the same one-shared-implementation rule `comparable()` follows for consolidation. Before this feature `stringSimilarity` was internal to `similarity.ts` (called only by its own `valueSimilarity` wrapper, which `align.ts` uses for reviewer-entry matching); `duplicates.ts` is its first outside caller. A cheap pre-check (a token-Dice pass, then a length-bound, then a character-histogram bound) skips the real, more expensive `stringSimilarity` call for pairs that are obviously nothing alike.

A `certain` verdict merges silently, exactly as the old exact-match tier did (fill empty fields only). A `probable` verdict is held back for `DuplicateReviewDialog` (`src/components/DuplicateReviewDialog.tsx`, styled by `src/styles/duplicates.css`): one row per pair, a **merge** / **separate** choice per row that starts **undecided** — Import stays disabled until every row has one, so a probable duplicate is never silently merged *or* silently doubled. `editorStore.ts` wires this as `duplicateReview` state plus `commitImport` (the shared writer both a duplicate-free import and a resolved review call into), `resolveDuplicateReview`, `setDuplicateDecision`, and `setAllDuplicateDecisions`.

`findMatchingPaper` — the function the rest of the editor already called to ask "is this paper already in the project" — is now a thin adapter over `classifyImport`: it returns a match only for a `certain` verdict, so every other caller's behavior is unchanged by the grading in between.

**Highlighting newly added papers.** Every row added by `addPdfs`, `addPdfFolder`, or `importReferences` gets a light-blue border so the reviewer notices the addition and checks the (possibly guessed) metadata — the same idea, and the same `--ai-mark` CSS variable, as the AI-annotation "unconfirmed" marks below. `editorStore.ts` tracks this the same way `aiMarks` does in the main store: a session-only `justAdded: Record<uid, true>`, not part of `EditorSnapshot`/undo (an add already has its own undo step) and never written to the file. It is cleared wholesale on save, on opening a project into the editor, and on closing the editor (`openEditorSession`, `close`, `save`). `PapersEditor.tsx` clears one row's mark (`confirmAdded`) the moment the reviewer focuses any of its fields, mirroring how `Field.tsx` clears an AI mark on focus/click.

**Relative PDF paths.** The JSON's location is chosen **up front** (and changeable any time via *Change…*), because a paper's `pdf` is stored **relative to the JSON file**. Each picked PDF keeps its absolute `sourcePath`, so when the location changes `changeLocation()` re-derives every `pdf` against the new directory (`/reviews/x.json` + `/reviews/pdfs/a.pdf` → `pdfs/a.pdf`; move the JSON up a level and it becomes `reviews/pdfs/a.pdf`). This only works in **Electron**, where real filesystem paths exist: the platform methods `pickProjectLocation` / `pickPdfs` / `relativePdfPaths` (see below) compute it via a `paths:relative` IPC (`path.relative(dirname(json), pdf)`, POSIX-separated). In the **browser** the File System Access API exposes no paths, so a picked PDF is stored as its bare file name and the user places it next to the JSON or edits the relative path by hand — the papers editor says so. A row added by `importReferences` with no PDF yet (`pdf: ''`) has no path to rederive either way, and is left alone until the reviewer attaches one.

### Reference-file parsing (`src/model/references.ts`)

`parseReferences(text, filename)` turns a BibTeX/RIS/CSL-JSON export from a reference manager (Zotero, Mendeley, JabRef, EndNote) into `RefEntry[]` (`title`, `authors`, `doi?`, `year?`, `pdfHint?`). The format is picked from the file extension, content-sniffed as a fallback (`@` → BibTeX, a `TY  -` line → RIS, leading `[`/`{` → CSL-JSON). It is a pure, defensive parser — a malformed entry is skipped rather than failing the whole file, and `parseReferences` itself never throws.

**LaTeX escapes.** BibTeX (and RIS, when it originated from a `.bib` round-tripped through a converter) routinely spells non-ASCII letters as LaTeX escapes rather than UTF-8 — an accent command on a base letter (`\"o`, `\'e`, `\c{c}`) or a handful of standalone letters that aren't "letter + accent" at all (`\ss`, `\o`, `\ae`, `\i`, ...). `unescapeLatex` resolves both via lookup tables (`LATEX_ACCENTS`, `LATEX_LETTERS`) rather than a chain of per-letter replacements, and handles all three shapes a command can appear in — bare (`\"o`), its own braced argument (`\"{o}`), or wrapped in an extra capitalization-protecting brace pair (`{\"o}`) — as one case: it only ever matches backslash-led sequences, so surrounding braces are inert to it either way. This is why `cleanBibValue` runs it *before* stripping braces — `{\"o}`'s braces need to still be there for the bare-letter branch to see past them, and are gone by the time the generic `{}` strip (still needed for plain capitalization protection like `{DNA}`) runs afterward. A bare control word also consumes the single space that terminates it — `S\o ren` is "Søren", because TeX ends a control word at that space and does not treat it as text; getting this wrong mangles most Nordic names. That is safe only because the author list is split on " and " *before* any unescaping (`parseBibEntry`), which is the order BibTeX itself works in: the separator belongs to the field, not to any one name. Unescape first and a name-final control word (`Hans Wei\ss and Sven`) would swallow the separator's space and glue the two names together. An unrecognized escape degrades gracefully: the backslash is dropped and the rest is left as-is, never a crash or a stray backslash. This unescaping does **not** apply to the BibTeX `file` field or RIS `L1`/`UR` (`cleanBibPathSegment`, kept deliberately narrower than `cleanBibValue`) — a Windows path like `C:\Users\name\file.pdf` is mostly backslashes, and the graceful-degradation fallback would otherwise mangle it. CSL-JSON is real JSON, already UTF-8, so none of this runs there.

**Merged author names.** Some exports lose the ` and ` separator between BibTeX authors entirely (`"Jan KeimAngelika Kaplan"`) or partially (`"Jan Keimand Angelika Kaplan"`, `"Jan Keim andAngelika Kaplan"`). `splitAuthorList` repairs the unambiguous half-loss (`andX` with no space and a capital right after — never legitimate text) unconditionally, then `repairMergedAuthorNames` looks for a lowercase→uppercase seam either inside a bare "and"-suffixed token or inside a single fused token, and only commits to a split when both halves come out as plausible multi-token "First Last" names. This is a deliberately conservative heuristic — a wrong split silently corrupts a real name, which is worse than leaving two names glued together — so a `Mc`/`Mac`/`De`/`Di`/`La`/`Van`/`Du` prefix allowlist protects `McDonald`-style surnames, an apostrophe or hyphen at the capital (`O'Brien`, `Smith-Jones`) is never even seen as a seam (the check requires direct lowercase→uppercase adjacency), and the both-sides-multi-token requirement is what keeps genuine names ending in "and" (`Roland`, `Armand`, `Ferdinand`) from being torn apart when nothing follows them worth calling a second name. RIS and CSL-JSON don't get this treatment: their authors are already structurally one-per-entry (`AU`/`A1` lines, `author[]` array), so the separator-loss problem this heuristic exists for cannot occur there.

### PdfViewer

Uses `react-pdf`'s `Document` + `Page` components. The pdf.js worker is loaded from the bundled dependency URL. A `ResizeObserver` tracks container width so pages scale to fit; the final render width is the fit-to-width size multiplied by the store-level `pdfZoom` factor. The PDF header shows the paper title, authors, and DOI, plus zoom controls (−, percentage, +) wired to `zoomOutPdf` / `resetPdfZoom` / `zoomInPdf`. For multi-page PDFs, the header also shows page navigation (prev/next buttons, a page-number input, and a total page count). The current page is tracked from scroll position via `onScroll` — the last page whose top has scrolled past 30% of the viewport height — and typing a page number jumps to that page. The PDF text and annotation layers are both rendered. Pages are `align-items: safe center` so horizontal scrolling remains reachable when zoomed wider than the pane. Text selection is captured via `onMouseUp`/`onKeyUp` → `window.getSelection()` → `setPdfSelection()`.

**External links.** The `<Document>` is given `externalLinkTarget="_blank"` and `externalLinkRel="noopener noreferrer"`, so link annotations pointing at a website render as `target="_blank"` anchors and open in a **new browser tab** rather than navigating the SPA away. Internal (in-PDF) destinations are unaffected — pdf.js renders them without a target and its LinkService scrolls to them. In **Electron**, `main.ts` intercepts the resulting `window.open` with `webContents.setWindowOpenHandler`, hands the URL to `shell.openExternal` (the user's **default browser**), and returns `{ action: 'deny' }` so no Electron window is created. A `will-navigate` listener is a safety net that prevents anything from navigating the app window away, routing off-app URLs to the browser too. Both paths go through `openExternalUrl`, which only opens `http:`/`https:`/`mailto:` — never `file:` or other schemes, which the OS could use to launch programs.

**Jump history (back/forward).** Clicking an internal PDF link (e.g. a reference) lets the pdf.js LinkService scroll to the destination. An `onClickCapture` on the scroll container notices clicks on `<a>` elements and, after polling briefly, records the pre-jump `scrollTop` on a back stack **only if the view actually moved** (so external links, which don't scroll, are ignored). Two header buttons (↩ / ↪, shown once history exists) then move between positions like a browser: `jumpBack` pops the back stack, pushes the live position onto the forward stack, and scrolls there instantly (`scrollTo` with default behavior — reliable under `prefers-reduced-motion`); `jumpForward` is symmetric. The stacks are refs (with `canJumpBack`/`canJumpForward` state mirroring their lengths) and are cleared when the paper changes.

**In-PDF search.** A 🔍 button in the header (and `Ctrl/Cmd+F`) toggles a find bar below the header; opening it focuses the input so the user can type immediately (via a `searchOpen` effect, since the input isn't mounted on the open transition). `findMatches` walks the text nodes of each rendered text layer (`.react-pdf__Page__textContent`), concatenating them per layer so a query can span multiple spans, and returns DOM `Range`s. Matches are painted with the **CSS Custom Highlight API** (`CSS.highlights` + `::highlight(slr-pdf-search)` / `::highlight(slr-pdf-search-active)`) — this tints the transparent text-layer glyphs without mutating react-pdf's DOM, and degrades gracefully where the API is unavailable. The active match is centered in the scroll container; Enter / Shift+Enter (and the ‹ › buttons) cycle matches. Crucially, the `<Page>` elements are **memoized** (`useMemo` on `[numPages, renderWidth, onTextLayerRendered]`) with a stable `onRenderTextLayerSuccess` callback, so typing in the search box reuses the same element references and React skips re-rendering the pages — otherwise every keystroke would tear down and re-render the text layers (a "TextLayer task cancelled" flood) and matches would never resolve.

PDF source resolution is async: `getPlatform().getPdfSource(paper.pdf, saveHandle)` returns a `{ url, revoke? }`. The effect cleans up (revokes blob URLs) on paper/handle change or unmount.

## Multiple reviewers & Consolidation

An SLR is normally annotated by ≥2 reviewers **independently**, then reconciled into one final
answer. `config.reviewers` (2–10) turns this on for a project; see `data-model.md` for the file
format and `Paper.reviews` shape. This section covers the store/UI wiring.

**`currentTree(project, currentReviewer, paper, create?)`** (`src/state/store.ts`) is the single
routing decision every mutating action and every reader goes through: single-reviewer →
`paper.annotations` (unchanged from before this feature); Consolidation → `paper.annotations`
(the tree that ships); a numbered reviewer → `paper.reviews[N]`; nobody picked yet on a
multi-reviewer project → `null`. `create` (default `false`) controls whether a numbered
reviewer's missing tree is lazily initialised and normalized in place (only safe inside an immer
`set()` producer — the mutating store actions pass `true`) or a fresh throwaway default is
returned for display/validation without touching the project (selectors and read-only
computations pass nothing). `setFieldValue`, `addInstance`, `removeInstance`, and
`applyAiSuggestions` all resolve their target tree this way before doing anything else, and bail
out — no write, no undo entry — if a multi-reviewer project has no reviewer selected yet.

### Matching the reviewers' repeated entries (`src/consolidate/`)

Two reviewers who both record three Findings need not record them in the same order: Reviewer 1's
Finding #1 may be Reviewer 2's Finding #3. Comparing them position by position would then report
disagreement that isn't there. Whenever Consolidation is the active seat,
`useConsolidationAlignment` (`src/hooks/`) works out which of each reviewer's entries are *the same
entry* and lines them up.

| Module | Does |
| --- | --- |
| `similarity.ts` | How alike two answers are, as `{score, weight}`. `weight` is what makes "agrees on five fields" outrank "agrees on one" — averaging scores alone cannot tell those apart, as both average to 1.0. Weight 0 means the pair said nothing (a field only one reviewer filled abstains rather than voting against). Text is `max(levenshtein ratio, token Dice)`; enums compare as labels, never as characters ("High"/"Low" overlap and mean the opposite); a `false` boolean carries no evidence, since every untouched boolean reads `false`; a `year` field is scored as an identity, not a magnitude — 1999 vs. 2999 scores 0 exactly like 1999 vs. 2000, because two different publication years are two different papers, not a near-match the way two head-counts might be (`valueSimilarity`'s dedicated `'year'` branch, checked before the `number` branch's relative-closeness scoring) |
| `assign.ts` | Hungarian max-weight assignment. Greedy is not merely worse but wrong here: one locally good pair can force two later entries into a much worse one, and greedy cannot trade the first against the second |
| `align.ts` | The recursion. `alignNode` returns slots per repeatable node; `alignableNodes` lists what is worth doing |
| `apply.ts` | Writes an alignment into the data |
| `unanimous.ts` | Finds the fields every reviewer answered identically, for `adoptUnanimousValues` to fill. Owns `comparable()` — the one rule for "did they say the same answer", shared with `disagreements.ts` and the compare popup so the three cannot drift into different verdicts |
| `disagreements.ts` | The per-field cross-reviewer verdict (`FieldVerdict`): who answered, which category their answer falls in, whether that is agreement. What both the overview and the statistics read |
| `metrics.ts` | Cohen's κ, Fleiss' κ, Krippendorff's α over abstract units × raters, each with an applicability check that explains refusal in a sentence. Knows nothing about papers or schemas, so it can be checked against published worked examples |
| `agreement.ts` | Turns `projectVerdicts` into a `MetricInput` |

**Matching cannot cross**, which is a requirement of the feature: a group's sub-entries are only
ever matched *inside* an already-matched pair of parents, because the recursion never offers a
candidate from another group. It is structural, not a rule applied afterwards.

**The mapping is stored as the ordering itself** — there is no mapping field in the file. Every
reviewer's entries are reordered so position N means the same entry for everyone, and the
consolidated tree is grown to one entry per slot (the feature's "add the maximum number
automatically" rule). This is why `pruneTree` keeps *interior* gaps and drops only trailing
empties: a reviewer with no entry for slot 2 holds an empty one there, and closing that gap would
slide every later entry down a slot and silently re-point the alignment on the next load.

**It runs a node at a time, off the paint path.** Matching is not cheap — a large paper measures in
the hundreds of milliseconds — so the hook yields to the browser between nodes rather than freezing
the window as it opens. Whatever the reviewer opens the ⇄ compare popup on jumps the queue.
`alignConsolidationNode(paperId, nodeName, coalesce)` is the store action; `coalesce` folds later
nodes into the undo entry the run's first node pushed, so lining a paper up is one undo press.

**A node the consolidator has already answered is never re-matched.** Their entry N means a
particular thing to them; re-matching could move a different entry into slot N, leaving their
recorded answer describing something it was never about. The cost is that entries added *after*
consolidation began are not auto-matched for that node — the safe side of the trade, since a stale
match is visible and a silently re-pointed answer is not.

### Unanimous answers are adopted (`adoptUnanimousValues`)

Once the matching for a paper is done, the scheduler runs `adoptUnanimousValues`, which fills every
still-unanswered consolidated field on which **all** reviewers gave the same answer, and marks each
one via `aiMarks` — the same light-blue border an AI fill gets, meaning "the app did this, you have
not looked at it yet". There is nothing to reconcile where everyone already agrees, and copying
those across by hand is the kind of task done on autopilot, which is when the real disagreement two
rows down gets missed.

It runs **after** matching, necessarily: it reads every reviewer at a fixed index, which only means
anything once their entries line up. The rules:

- **Comparison folds case and whitespace only** (`"Controlled experiment"` == `"controlled
  experiment "`). Not punctuation, and no fuzzy matching — the matcher's job is to *pair* entries,
  where near-enough is right; writing a value into the shipping tree unasked is a higher bar. The
  lowest-numbered reviewer's wording is kept, trimmed, so the choice is deterministic.
- **Every reviewer must have answered.** Two agreeing and a third blank is not unanimous — silence is
  not assent. This is also what keeps booleans honest: `isUnanswered` (`src/llm/fields.ts`) counts a
  boolean as answered only once ticked, so untouched checkboxes — which all read `false` — do not
  count as a unanimous "no" and mark every checkbox in the project.
- **A field the consolidator already answered is left alone**, per field (unlike the matching guard,
  which is per node).

### Batch-adopting across the whole project (`adoptAllUnanimousAnnotations`)

`adoptUnanimousValues`/`alignConsolidationNode` above are per-paper, driven by whichever paper is
open. `adoptAllUnanimousAnnotations()` (`store.ts`) is the multi-paper version for an ordinary
(non-screening) multi-reviewer project's Consolidation seat: one button, one pass over every paper.

**For each paper it aligns every alignable node, then adopts unanimous values — in that order, and
the order is load-bearing.** Adopting at a fixed index without aligning first would read reviewer
1's Finding #2 against reviewer 2's Finding #3 whenever the two recorded their findings in a
different order, and report that as agreement neither reviewer actually gave. This is exactly why
the existing `adoptAllUnanimousScreening` (see "Screening" below) never needed an alignment step:
screening's `Decision`/`Reason` are both plain, non-repeatable leaf fields, so `alignableNodes`
already returns `[]` for it and reading at a fixed index was always safe there. An ordinary
schema's repeatable groups are exactly the case that safety doesn't extend to, which is what this
feature adds the missing align step for.

- **A paper the consolidator has already answered under any alignable node is skipped whole** —
  no alignment, no adoption, nothing touched — via the same `consolidatorHasAnswered` predicate
  `alignConsolidationNode`'s own per-node guard uses, now factored out into
  `src/consolidate/readiness.ts` alongside `readyToConsolidate` (previously inlined in `store.ts`'s
  `alignConsolidationNode`). Re-matching a node the consolidator has already recorded an answer
  under could move a *different* entry into the slot their answer describes; skipping the whole
  paper is the safe side of that trade.
- **One undo step for the whole batch**, not one per paper — the same coalescing shape
  `alignConsolidationNode`'s own `coalesce` parameter already provides per paper, threaded across
  the outer loop here too.
- **It yields to the browser between papers** (`await` a `setTimeout(resolve, 0)`), the same
  off-the-paint-path shape `useConsolidationAlignment` already uses between nodes — a paper is the
  smallest unit that can safely yield here, since every one of its nodes must finish aligning before
  any value can be read across it.
- **Progress is reported as it runs**: `unanimousRun` (`{ done, total, filled, skipped, running }`)
  drives the button's own label while busy and a dismissible result banner once it finishes. The
  button lives in `AnnotationPanel.tsx`'s Consolidation tools, alongside ⚖ Agreement and
  ⚠ Disagreements.

**A known, currently unfixed limitation, stated plainly rather than glossed over: the interactive
per-paper path (`useConsolidationAlignment`, driving an ordinary Consolidation-seat paper view) does
not have this batch's paper-level guard.** It still calls `adoptUnanimousValues` unconditionally the
moment its alignment queue drains, with no check for whether any node in that queue was itself
guard-refused along the way (a node the consolidator had already answered, per the per-node guard
above). So a paper the consolidator has *partially* answered — one node done, a *different* node
still open, perhaps because a reviewer added a new entry after consolidation began — can still have
`adoptUnanimousValues` read that still-unaligned node at a stale index and fabricate an agreement
nobody gave, through the ordinary act of just opening the paper. The batch path above avoids this
not by fixing the interactive path, but by being strictly more conservative: it refuses to touch a
paper at all once *any* alignable node on it is already answered, which the interactive path has no
equivalent of before its own final adoption call. This is not covered by a regression test; fixing
it is future work, not something this feature did.

### Picking a seat (`ReviewerPrompt`)

A multi-reviewer project opens with `currentReviewer === null` — never Reviewer 1, since an
unattributed edit is worse than a prompt. `ReviewerPrompt` renders over the app in exactly that
state: it explains what multi-review means (independent annotation, one reconciling pass) and makes
the reviewer choose. There is no dismiss — the form is withheld without a seat anyway, so a dismiss
button would only offer a state in which nothing can be done — but it yields to Help (`helpOpen`),
which is otherwise unreachable behind it.

Because the selection is persisted per project, "prompt shows" means "first open of this file". The
exception is a project with no stable path — a `?project=` URL, or a browser download-only save —
where `reviewerStorageKey` deliberately persists nothing rather than risk restoring a seat under the
wrong project. Those ask on **every** load. That is honest (the app genuinely cannot tell who you
are) but it is the one case where the prompt is not a once-per-project event.

`ReviewerPrompt` also renders a second, unrelated mode: a **mismatch** warning when the already-
selected seat's recorded holder (`config.reviewerIdentities`) doesn't match this machine's own git
identity — offering to take the seat or pick another, never blocking outright. See "Reviewer seat
identity" in the Git section below for the full mechanism (why it's email-only, what it warns about,
and why a project with no recorded identities is unaffected). The Toolbar's reviewer switch carries
the same signal as a "Claimed by …" tooltip hint on each seat.

### Readiness: what Consolidation can act on (`readiness.ts`)

`readyToConsolidate(schema, paper, reviewerCount)` — every numbered reviewer has recorded something
on this paper, by `hasAnnotations` (so a ticked box counts as work; an unticked one never does, since
every boolean reads `false` whether or not anyone looked).

`consolidatorHasAnswered(def, tree)` lives here too — the predicate behind `alignConsolidationNode`'s
per-node "never re-match a node the consolidator already answered" guard, and the same predicate the
batch adoption above uses per paper. One shared function rather than two independent checks is what
keeps the per-node and per-paper guards from silently drifting apart on what "already answered"
means.

The **Consolidation seat itself is not gated** — a consolidator may legitimately start on the papers
that are ready while the rest are still being reviewed. The gate is per paper instead, and one rule
drives both places it shows, so they cannot disagree:

- the paper list's dot (`paperIsMarkedDone`) reads "ready to consolidate" in that seat;
- a field's ⇄ compare button is **disabled** on a paper not every reviewer has annotated. That
  reviewer's column would otherwise render empty, which reads as "they found nothing here" when the
  truth is "they have not looked yet" — inviting a decision on evidence that does not exist.

Alignment and unanimous adoption already decline such papers on their own (`alignConsolidationNode`
needs two reviewer trees; `adoptUnanimousValues` needs every reviewer to have answered), so no extra
guard is needed there.

### Agreement and the disagreement overview

Two buttons sit in `.annotations-head-row` in the Consolidation seat only — the slot the ✦ AI button
occupies elsewhere.

**⚖ Agreement** (`AgreementDialog`) computes the coefficients the reviewer ticks. A **unit** is one
annotation field on one paper; `agreement.ts` includes only the fields **at least two reviewers
answered**, since a field with one answer carries no agreement information (`disagreements.ts` says
so, and warns that callers must gate on `answeredBy.length >= 2` rather than trust `agree`, which is
vacuously true for a single answer). The dialog states the unit count and how many were skipped, so
the reader can see what was measured rather than guess.

A metric that cannot honestly be computed is disabled, at half opacity, with its `Applicability.reason`
verbatim on hover — those strings are written as complete user-facing sentences for exactly that
("Cohen's κ compares exactly two reviewers; this project has 3"). Cohen's needs exactly 2 raters;
Fleiss' needs every reviewer to have rated every unit; Krippendorff's α survives both, which is why
it is worth having all three.

**⚠ Disagreements** (`DisagreementOverview`) lists every field where the answering reviewers gave
different categories, grouped by paper; a row jumps to it (`selectPaper` → `openConsolidation`), which
is the point — finding a disagreement is useless if you then have to hunt for it.

### Semantic equality (`Paper.equal`)

Reviewers write the same thing differently ("RCT" / "randomized controlled trial"). Nothing captured
that, so every statistic understated agreement. The compare popup carries a tick — "these answers mean
the same thing" — persisted as `Paper.equal`, a list of canonical field paths. `disagreements.ts` then
gives those reviewers one shared category, so the field reads as agreement everywhere: the badge, the
overview, and the coefficients. Measured on a two-reviewer demo, marking one such pair moved Cohen's κ
from 0.533 to 0.682.

The box only appears where there is something to declare — when the answers already match after
`comparable()`, there is nothing to add.

**The mark alone is not a resolution, and the popup will not let it pass for one.** It settles *that*
the reviewers agreed, which is enough to drop the field out of the disagreement list and count it as
agreement — but it says nothing about *what* they agreed on, so the consolidated value stays blank.
Marked-but-blank is the worst state available: resolved everywhere, holding no answer, and never
surfaced again. `closingWouldStrand` catches it on every exit (×, Escape, backdrop, and taking a
reviewer's *blank* answer, which records nothing and leaves the same hole). Leaving anyway un-marks
the field, so it returns to the disagreement list rather than disappearing quietly. Escape backs out
of that warning rather than through it — discarding the mark should take a deliberate click.

A boolean can never strand: `isEmptyValue` says a boolean is never empty, and rightly — an unticked
box is a real `false`, not a gap, so there is no value left to pick and the warning would be one the
reviewer could not clear.

**Known limit**, documented at the field: it is one boolean for the whole field, i.e. "all the
answering reviewers here are equivalent". Exact for two reviewers; with three or more it cannot say
"these two agree but that one does not".

### AI is not available in Consolidation

`AnnotationPanel` does not render the ✦ AI button in this seat at all (not disabled, not the
transparent treatment the locked state uses — absent), and `applyAiSuggestions` refuses when
`currentReviewer === 'consolidation'`, so opening the dialog as a reviewer and then switching seats
cannot get round it. Consolidation decides between what the reviewers actually said; a model's answer
would be a fresh opinion invented after the fact, written into the tree that ships and dressed as a
reconciliation of the others.

Matching is lexical only. Bundling a local embedding model (nomic-embed-text and similar) was
evaluated and rejected: ~185 MB installed at best and plausibly several hundred MB of RAM, against
peer-reviewed evidence (VLDB 2023 entity-resolution, DeepMatcher, fuzzylink) that on *short,
structured* strings — which annotation values are — good lexical methods match or beat embeddings,
which win on long dirty text, paraphrase and multilingual instead. `onnxruntime-node` has also
dropped Intel-Mac support. If semantic matching is ever wanted, the shape is an opt-in call to a
local Ollama (`/api/embed`) layered *on top of* lexical scoring, not replacing it.

**`currentReviewer`** is a *view* selection, not project data: switching it is not an undo step
and does not set `dirty`. It defaults to `null` (unselected) whenever a multi-reviewer project is
opened — never silently to Reviewer 1, since an unattributed edit is worse than a prompt — unless
a previous selection for *this* project was persisted. Persistence is per project, keyed by the
save handle's path (`slr.currentReviewer.<path>` via `safeGet`/`safeSet`/`safeRemove` in
`src/state/settings.ts`); a project with no stable path (server mode, or a browser download-only
save) simply doesn't persist a selection. It resets to `null` on `closeProject`/`loadFromText`,
same as `validation`/`aiMarks`.

**Toolbar** (`src/components/Toolbar.tsx`) renders a reviewer switch — buttons for Reviewer
1..N plus a visually distinct Consolidation pill — only when the open project is multi-reviewer;
hidden entirely otherwise. The active seat is highlighted; an unselected state gets a warning
border and a "Pick a reviewer:" prompt. **Validate** is additionally disabled until a reviewer is
picked (see "Validation" above). Note this shares the toolbar with the hidden AI-unlock click
gesture on the app title — the two are unrelated and don't interact.

The switch sits in a dedicated center track of the toolbar (`.toolbar-left` / `.toolbar-center` /
`.toolbar-right` in `index.css`, a 3-column grid with `1fr auto 1fr`) so it's centered on the
toolbar itself rather than merely between its flanking groups — a plain `margin: auto` would drift
as the project title (`.toolbar-status`, on the right) changes length. The two outer tracks are
bare `1fr` (not `minmax(0, 1fr)`), so each floors at its own min-content width and can never be
squeezed into overlapping the center; only `.toolbar-right` is allowed to shrink further, because
`.project-name` beneath it already truncates with an ellipsis. Under real space pressure the row
simply asks for more width than the window has (or the title truncates harder), never overlapping
text.

Above `REVIEWER_DROPDOWN_THRESHOLD` (5) reviewers, the pill row would crowd the toolbar, so the
same choice renders as a `Dropdown` (reusing `src/components/Dropdown.tsx`, extended with an
optional `className` for the warning/Consolidation styling hooks) instead of one button per
reviewer. The closed trigger always names the active seat ("Reviewer 3", "Consolidation", or
"Pick a reviewer" while unselected) rather than a bare caret — the whole point of the switch is
that the active seat reads at a glance without opening anything. The open menu marks the current
selection with a checkmark and keeps Consolidation visually distinct (its own label styling,
matching the pill form's colors) rather than listing it as "reviewer N+1". At 5 or fewer reviewers
the pill row is unchanged.

**AnnotationPanel** withholds the annotation form (showing a prompt instead) whenever a
multi-reviewer project has no reviewer selected, and otherwise renders the tree `currentTree()`
routes to for the active reviewer — falling back to a schema-shaped empty tree (not creating
anything) when that reviewer hasn't written on this paper yet. A small badge next to the paper
title echoes which seat is active, redundant with the toolbar switch on purpose: this is the one
piece of state that must never be ambiguous, since it decides which tree every edit lands in.

**Consolidation compare popup.** When `currentReviewer === 'consolidation'`, `Field.tsx` shows an
extra ⇄ button next to the existing ⧉ grab-from-PDF button (and, for a boolean field, next to the
checkbox) that opens `ConsolidationDialog` for that exact field path. The dialog lists every
reviewer's raw value for the path (via the same `peekValue`/`fieldPath` machinery `store.ts`
already uses, and `resolvePath` from `src/llm/paths.ts` to resolve the `ResolvedDef` for display),
including reviewers who left it empty, and flags whether the answered reviewers agree. Clicking a
row calls the ordinary `setFieldValue` — Consolidation *is* the active reviewer while the dialog
is open, so that write already lands in `paper.annotations` via `currentTree()`'s routing; nothing
dialog-specific exists on the store side beyond `consolidationTarget`/`openConsolidation`/
`closeConsolidation`. Closing without picking changes nothing. Follows the same modal pattern as
`ValidationDialog` (`.modal-overlay` → `.modal` → `.modal-head` + `.modal-body`, Escape-to-close,
backdrop click).

**AI marks and AI-assisted annotation** are reviewer-scoped too — see "AI marks" below and
`unansweredFields`'s call site in `aiStore.ts`'s `openDialog()`, which now proposes values for the
*active reviewer's* empty fields via `currentTree()`, not unconditionally `paper.annotations`.

`PaperList` follows the same rule on both of its reads: the "annotated" dot and the annotation
search mode each go through `currentTree()`, so as Reviewer 2 the sidebar tracks *your* progress and
answers "which papers did *I* record this in" — the same tree the form and validation show. When the
project is multi-reviewer and nobody has picked a seat yet, `currentTree()` returns null and both
degrade to "nothing annotated / nothing to match" rather than falling back to the consolidated tree,
which would attribute someone else's work to the unselected reviewer.

## Screening

A **screening project** is an ordinary project whose schema is *derived* rather than authored.
`config.screening: { reasons: [...] }`'s presence is the opt-in marker and the single source of
truth for the one authorable thing (the exclusion-reason list); `config.schema` is a **projection**
of it — `src/screening/schema.ts`'s `screeningSchemaDefs` — re-derived on every `loadProject` and
rewritten on every `serializeProject`, never read back for a screening project. That one decision
is what makes almost everything else in the codebase need zero changes: to `resolveSchema`,
`normalizeTree`, `pruneTree`, `validate.ts`, `align.ts`, `unanimous.ts`, `disagreements.ts`,
`metrics.ts`, `readiness.ts`, `currentTree`, and undo/redo, a screening project is simply a project
with a two-node schema.

**Rejected: `config.schema` authoritative, with a sync check against `config.screening.reasons`.**
Two sources of truth for one thing, and hand-editing `reasons` would silently desync the dropdown
from the actual protocol — a sync check only catches the drift after the fact, it doesn't prevent
it. **Rejected: omitting `schema` from the in-memory `Project` for a screening project.** Every
downstream module reads `project.schema`; a screening project having a *real* one is exactly what
lets them all work unmodified. Drift between file and in-memory state is structurally impossible
here because the derived value always wins on load and is what gets written on save.

### Why `Decision` is a two-option enum, not a boolean

The obvious reading of "a boolean field if the paper should be excluded" is an `Exclude` checkbox.
This codebase cannot represent an unanswered boolean, and says so in three separate places:
`isEmptyValue` in `src/model/validate.ts` ("booleans are NEVER empty" — an unticked box is a real,
answered `false`); `isUnanswered` in `src/llm/fields.ts` (same rule, for the AI layer); and
`hasAnnotations` in `src/model/annotations.ts`, which only counts a boolean once it is `true`. An
`Exclude` checkbox therefore cannot tell "I decided to include this" apart from "I have not looked
at this yet" — both are `false`. Screening is the one phase where that distinction *is* the
output: the progress count, the PRISMA include/exclude/pending numbers, and — above all — which
papers survive an import (`startFromScreening`) all depend on it.

A checkbox would also have broken every piece of machinery this feature exists to *reuse*, each in
a different way: `hasAnnotations` would call an included paper unannotated (so its progress dot
would never light); `readyToConsolidate` would say a paper both reviewers *included* is not ready
to consolidate; `unanimousFills` would refuse to adopt a unanimous "include" (`isUnanswered`
treating `false` as unanswered-or-not is exactly the ambiguity that breaks); and κ would only ever
see the excluded papers, since an included paper's category would be indistinguishable from an
untouched one. Each of those would need a screening-specific special case — precisely the parallel
machinery this design set out to avoid. Spelling the field as `Decision: "Include" | "Exclude"`
(schema in `src/screening/schema.ts`) gets the tri-state (`null` until chosen) for free, and every
one of those modules is then correct with zero code changes — see `src/screening/status.ts`'s
`screeningStatus`, the one place that reads the field.

The polarity the user's brief asked for is kept where it matters: `Reason` belongs to the exclusion
side, and **only an explicit `Decision === "Exclude"` ever drops a paper** on import — see below.

### `align.ts` is a structural no-op here, and needs no guard

`alignableNodes(schema)` (`src/consolidate/align.ts`) returns `[]` for the screening schema: its
`hasAnythingToMatch` predicate is `isRepeatable(def) || def.children.some(...)`, and both `Decision`
and `Reason` are plain `max: 1` leaf fields with no children. `useConsolidationAlignment`'s queue is
therefore always empty for a screening project, and it goes straight to `adoptUnanimousValues` — no
special-casing added, none needed. This falls out of the schema shape, not of any screening-aware
code; if a future version ever made `Reason` repeatable this reasoning would need re-checking, but
nothing here defends against that on purpose.

### Reused verbatim, and the one thing that had to be scoped

`readiness.ts`, `align.ts`, `unanimous.ts`, `disagreements.ts`, `metrics.ts`, `apply.ts`,
`assign.ts`, `similarity.ts` — **zero changes.** Two reviewers screening independently with a
reconciliation pass *is* the standard SLR screening protocol, and κ over the include/exclude
decision is exactly the statistic a screening phase reports; building anything parallel to the
existing multi-reviewer machinery for that would have been indefensible.

The one scoped change is `agreement.ts`'s `agreementInput`: for a screening project it filters
`projectVerdicts` down to `Decision` only, before the `answeredBy.length < 2` skip accounting.
Without it, `Reason` — a field only even defined on the subset of papers both reviewers
excluded — would be folded into the same coefficient as a different question, producing a number
that answers neither honestly. `Reason` verdicts are filtered out entirely rather than counted as
"skipped" (which means "too few reviewers answered" — not true here).

`ConsolidationDialog` gets one guard too: the "these answers mean the same thing" checkbox is
suppressed on the screening `Decision` field (`isScreeningDecision`, checked against
`SCREENING_DECISION` and an empty container path). "Include and Exclude mean the same thing" is
not a claim anyone can make; without the guard a consolidator could tick it and make a real
disagreement vanish from the overview while inflating agreement. The box stays available on
`Reason`, where two overlapping reasons genuinely can be equivalent — the same reasoning
`closingWouldStrand` already applies to ordinary fields.

### AI is not offered for screening, on the same precedent as Consolidation

`ScreeningPanel` renders no AI button at all (mirroring `AnnotationPanel`'s Consolidation-seat
treatment — absent, not disabled), and `applyAiSuggestions` (`store.ts`) refuses whenever
`project.screening !== null`, so opening the dialog on a different project and switching cannot get
round it either. Screening decides the review's corpus; a model's include/exclude pass would be the
difference between a systematic review and a generated one. It is also mechanically moot most of
the time: the ordinary AI path needs a PDF (`aiDisabled = … || !paper.pdf`), and screening papers
usually have none (`pdf: ""` — see below).

### The middle pane swaps, it does not nest

`App.tsx` renders `ScreeningRecord` (title + abstract) in place of `PdfViewer` by default for a
screening project, toggled to the actual PDF via a session-only `screeningShowPdf` flag
(`toggleScreeningPdf`). **Rejected: nesting `PdfViewer` inside a record component.** `PdfViewer`
owns its own panel, header, `ResizeObserver`, and in-PDF search state — fiddly to embed for no
gain when a flat swap does the same job. **Rejected: two conditional layouts keyed off
`paper.pdf === ''`.** A swap reuses `PdfViewer` whole (including its own now-necessary empty state
for `pdf === ''` — trap below) and degrades cleanly whether or not a PDF is attached, without a
second code path to keep in sync.

**`PdfViewer`'s missing empty state was a latent gap this feature makes reachable.** Before
screening, `paperSchema.pdf` was `z.string().min(1)`, so `pdf: ''` could never survive
`loadProject` and `PdfViewer` never needed to render anything for it — it only guarded `!paperId`.
Screening relaxes `pdf` to `z.string().default('')`, scoped by a `superRefine` that still requires a
non-empty `pdf` for every *non-screening* paper (`src/model/schema.ts`), so the relaxation cannot
leak into ordinary projects. `PdfViewer` now also guards `!pdfPath` with an explicit "This paper has
no PDF attached" panel, right next to the pre-existing `!paperId` guard.

### A missing abstract is extracted from the PDF, and flagged durably

Screening is normally decided from `abstract` alone, but a paper added straight from a PDF (rather
than through a reference-manager export, which usually carries one already — see
`references.ts`'s `RefEntry.abstract`) may have none. `pdfMeta.ts`'s `abstractFromLines` fills that
gap with the same kind of best-effort layout heuristic the module already used for title/authors:
find the "Abstract" heading and follow **the column it sits in** to that column's next section
heading (see the function's own comment for why column-following, not line-reading, is the whole
problem). Two call sites, one function:

- **`editorStore.ts`'s `addPickedPdfs`** — the existing background title/author fill for a directly
  added PDF now also tries the abstract, pre-filling the draft row the same way (never clobbering
  something the reviewer already typed while the read was in flight).
- **`store.ts`'s `extractScreeningAbstract(paperId)`**, fired by **`selectPaper`** — and by
  `loadFromText` for the paper a project opens on, which nothing else would ever fire for. Selection
  is the trigger because the abstract *is* the screening surface: `ScreeningRecord` must simply
  have one to show, without the reviewer opening the PDF to make it appear. An earlier version hung
  this off `toggleScreeningPdf` instead, which inverted the feature — it only produced an abstract
  once you had already opened the PDF you were trying to avoid opening. Auto-advance
  (`setScreeningDecision`) routes through `selectPaper`, so the read-decide-read rhythm gets this for
  free with no second call site.

**Why this writes `abstract` immediately, with no per-paper confirmation step, unlike AI
suggestions.** The AI-annotation flow (`applyAiSuggestions`, below) always gates a machine-produced
value behind an explicit reviewer "Apply" click on a reviewed table. Screening's whole design
optimizes for the opposite: hundreds of papers, seconds each, one keystroke per decision
(`I`/`E`/`1`-`9`, see "Auto-advance" above) — a confirmation dialog per PDF-opened paper would
defeat exactly the throughput this feature exists for. The chosen substitute for that review gate
is a **permanent, unmissable warning** rather than a one-time confirmation: `Paper.abstractFromPdf`
is written to the file (`project.ts`, alongside `abstract`), not held in a session-only structure
like `aiMarks` — a co-reviewer opening the same file later, or the same reviewer in a future
session, must see the same "this is a guess, verify against the PDF" caution the extracting session
did, which a per-session mark cannot promise. `ScreeningRecord.tsx` renders that warning inline,
above the abstract text, whenever the flag is set — text, not just a colored border, since a claim
this consequential to a systematic review's corpus needs to survive a glance. This mirrors the
precedent `Paper.aiUsage` already set: a *durable disclosure*, not a UI hint, for exactly this
reason (see "AI-assisted annotation" below).

**The flag is meaningless without a value to describe it, so it never survives without one.**
`loadProject` drops `abstractFromPdf` whenever `abstract` itself is empty (`p.abstract &&
p.abstractFromPdf === true`, `project.ts`) — a hand-edited file that deletes the abstract but
leaves the flag behind gets the defensive treatment every other structurally-validated field in
this loader gets, not trust.

**A heuristic abstract is explicitly lower-confidence than one actually recorded somewhere.**
Every other field `fillFromRef` (`editorStore.ts`) considers is "fill only if currently blank,
never overwrite" — the reviewer's own input always wins. `abstract` is the one exception: a later
reference-manager import is allowed to replace an `abstractFromPdf`-flagged value with the entry's
real one, clearing the flag in the same write. This is a real answer to a real ordering problem —
a PDF added first, a reference file imported second — not an oversight in the general rule.

**Staleness here is about the project being *gone*, not about anything having changed — and
`loadFromText`'s `get().project === project` reference check is the wrong tool for that, despite
being right for its own narrower job.** immer hands back a **new** `project` object on every edit, so
a reference comparison reads *one screening decision* as "the project was replaced". During
screening that is not an edge case, it is the loop: decide a paper every second or two, while a PDF
read is in flight. Guarding on identity threw away a perfectly good abstract because someone pressed
`I` — and then marked the PDF as having none, so it never retried. `projectGeneration` (a
module-level counter, bumped only by `loadFromText` and `closeProject`) answers the question actually
being asked. The write additionally re-checks, inside the producer, that the paper still has no
abstract, so a hand-typed one that landed first is never clobbered. What it deliberately does *not*
check is the selection: the abstract belongs to `paperId`, so a late result is still written for the
paper it was read from rather than discarded because the reviewer scrolled on.

**It pushes no undo step**, unlike `adoptUnanimousValues` — and the difference is who asked. Adopting
unanimous values is an action a consolidator *invokes*; this is a passive background fill triggered
merely by looking at a paper. On the undo stack it would mean `Ctrl+Z` after a decision silently
removes an abstract instead of undoing that decision, and with auto-advance firing an extraction per
paper the stack would fill with them. It follows the editor's own background title/author fill
(`addPickedPdfs`), which likewise patches rows with no undo entry of its own. `dirty` is still set,
so the ordinary unsaved-changes path persists it. A corollary the `screeningAbstractReads` bookkeeping
has to respect: an undo *can* still restore a snapshot taken before an abstract landed, so a
successful read deliberately leaves no marker behind — re-selecting that paper simply extracts again,
rather than the loss being permanent for the session.

**The two-column layout is the whole difficulty, and hand-built test fixtures could not see it.**
pdf.js reports a two-column paper's left-column "Abstract" heading and its right-column
"1 Introduction" on the *same baseline*, so `toLines` yields one `Line` reading
`"Abstract 1Introduction"`, and every body line below is likewise one `Line` holding a strip of each
column. The first implementation read `line.text` and stopped at the first multi-segment line —
which on a real paper is the line immediately after the heading — so it extracted **nothing at all**
from exactly the documents the feature exists for, while every synthetic unit test passed, because
those fixtures were built from the same wrong mental model as the code. Following the column
requires each segment's `x`, which `toLines` already computed and then discarded; `Segment` now
carries it. The lesson is pinned in place by `pdfMeta.test.ts`'s real-PDF integration tests (against
`samples/pdfs/`, including a genuine two-column ICSE paper) and by
`editorStore.realPdf.test.ts` for the composition — a class of bug no amount of hand-built `Line[]`
could have caught.

**Rejected: treating the extracted abstract as session-only until confirmed, never writing it to
the file.** This was the first design considered, closer to `aiMarks`' "shown but not yet real"
treatment. It fails the actual requirement: a co-reviewer must see the same paper's abstract (and
the same caution about it) the extracting reviewer saw, which a value that lives only in one
person's browser session cannot deliver on a shared, git-tracked project file — and re-extracting
on every single open, for every reviewer, of every paper, is wasted work `abstractFromPdf` avoids
for free once the first extraction lands.

### The paper-list dot's meaning changes in Consolidation, and the mitigation

A screening project's paper list gets a **tri-state** marker (undecided / included / excluded, via
`paperScreeningStatus` in `PaperList.tsx`) instead of the plain done/not-done dot — a single boolean
dot is nearly meaningless once every paper's whole state is one field. The rule is uniform across
every seat: it reads whatever `currentTree` routes to, same as `paperIsMarkedDone` always has. In
the **Consolidation seat**, `currentTree` is `paper.annotations`, so the dot reads as "the final
decision so far" — which is the right thing for that seat to show.

**The cost, stated plainly: in Consolidation this dot stops meaning `readyToConsolidate`** — the
signal `paperIsMarkedDone` computes there for an ordinary project (every numbered reviewer has
recorded something). Losing that signal outright would be a regression, since it is what tells the
consolidator which papers are actually workable. The mitigation is that it has not actually been
lost, only moved: `readyToConsolidate` still runs and is reported in the marker's `title` tooltip,
and — this is the part that matters — the **⇄ compare button's own readiness gate in `Field.tsx` is
completely untouched**. That gate is the thing that actually protects a consolidator from deciding
based on an absent reviewer's empty column; the paper-list dot was always a secondary, at-a-glance
cue on top of it, never the enforcement mechanism itself.

### Auto-advance: one rule, forward-only

Deciding a paper (`setScreeningDecision` in `store.ts`) advances the active seat to the next
undecided paper **only when this seat's own decision went from undecided to decided** — computed by
reading `screeningStatus` *before* the mutation, not after. Re-deciding an already-decided paper, or
un-deciding one (`setScreeningDecision(null)`), never advances. This is deliberately the *only*
rule, applying identically to the keyboard shortcuts and the panel's own Include/Exclude buttons
(both call the same store action), so the two cannot drift apart on it: a reviewer moving forward
through a stack gets a read-decide-read rhythm, and a reviewer who jumps back to fix an earlier call
is never yanked away from the paper they just navigated to.

### Importing from a screening project

`startFromScreening` / `importFromScreening` (`editorStore.ts`) read a screening project through
the real `loadProject` — not a raw JSON parse — specifically so that `paper.annotations` (the
consolidated tree in the multi-reviewer case) is what "included" is read against, never an
individual reviewer's own opinion in `paper.reviews`. `partitionScreeningPapers` buckets every
paper by `screeningStatus(paper.annotations)`; only `'excluded'` is ever dropped. `'undecided'`
covers both "genuinely never touched" and "a hand-edited file holds an unrecognised decision
string" — `screeningStatus` treats both identically, on purpose (see `src/screening/status.ts`):
carrying a paper you meant to drop is recoverable (it shows up, flagged, in the new project);
dropping a paper you meant to keep is invisible and silently corrupts the review. The import
dialog (`ScreeningImportDialog`) states the three counts and lets the reviewer choose to leave the
undecided ones out instead, but never drops them without that explicit choice.

**"New from screening…" can start a second screening pass, not just an annotation project.** A
radio in `ScreeningImportDialog` (defaulting to *annotation*, the original behavior) sets
`startKind: 'annotation' | 'screening'` on the import draft (`setScreeningImportKind`);
`resolveScreeningImport` reads it back when the reviewer confirms. Choosing *screening* used to be
refused outright — a screening-to-screening import had nowhere sensible to go, and a PDF-less
screening paper carried into an *annotation* project simply couldn't be saved, since only a
screening project's `paperSchema` tolerates `pdf: ''`. Building a second screening project fixes
both: PRISMA's title/abstract pass and full-text pass are two rounds of the *same* protocol, so
the destination is a screening project again, seeded with the **source project's own
`screening.reasons`** — never `DEFAULT_SCREENING_REASONS` — because a full-text pass needs to
report against the same reason vocabulary the first pass used, not a fresh generic one. It also
inherits the source's `reviewers` count and suggests a `-fulltext.json` filename, where the
annotation target keeps `reviewers: 1` and suggests `-annotation.json`. Either way, every carried
paper's `annotations` (and, for the screening target, `reviews`) starts **empty** — a first-pass
title/abstract decision must not silently anchor the second pass's full-text one, whether that
second pass is an annotation schema or another screening round.

**The import records where the new project came from, and the project editor shows it.** `Project.provenance: ProjectProvenance |
null` (`src/model/project.ts`) —
```ts
interface ProjectProvenance {
  kind: 'screening-import'
  source: { title?: string; file: string }
  importedAt: string  // ISO 8601
  counts: { included: number; undecided: number; excluded: number; carried: number }
}
```
It is a first-class field on `Project`, not tucked under `config` or `extra`: `config`'s zod schema
has no `.passthrough()`, so an unrecognized key nested under it is silently stripped before
`project.ts` ever sees it, and `extra` is reset to `{}` by a "New from screening…" import in any
case — neither is a place a value can be trusted to survive. `parseProvenance` reads it
defensively (malformed input becomes `null`, never a thrown error), and both `serializeProject`
and the editor's own `buildProjectJson` write it, so a draft never in-memory-only holds provenance
the eventual save would drop. Because a nested record like this has no `FieldConflict` shape,
`mergeProjects` **refuses** the whole merge if both sides changed it differently (see "Merging two
copies of a project" in `data-model.md`), and `detectFieldChanges` treats any provenance difference
as structural, falling back to the plain whole-file commit checkbox — the same treatment
`config.schema` and friends already get, for the same reason: there is no field-level answer to
"which import history is right."

Provenance is now surfaced in the project editor as a read-only **"Imported from"** line (`ProvenanceNote` in `ProjectEditor.tsx`), showing the source file/title, the import date, and the carried/dropped counts — previously written to the file but displayed nowhere.

`resolveScreeningImport` also has to solve a real path-integrity problem, not just a metadata
carry-over: a paper's `pdf` in the screening file is relative to *that* file's directory, so a
carried row needs a real absolute `sourcePath`, or the moment the reviewer later uses **Change…**
on the new project, `changeLocation` (which only re-derives `pdf` for rows that have a
`sourcePath` — see the project-editor section above) would silently leave every PDF pointing at
nothing. `PlatformAdapter.absolutePdfPaths` exists for exactly this (the inverse of
`relativePdfPaths`); `siblingProjectLocation` is the platform op that makes "save the new project
next to the screening JSON" the default rather than a suggestion in a dialog — a sibling location
is what keeps every relative `pdf` path resolving with zero rewriting at all.

For `target:'import'` (merging carried papers into an already-open session rather than starting a new
project), the path-integrity problem is sharper: the open session can live in any directory, almost
certainly not the screening project's own. `resolveScreeningImport` now rebases each carried paper's
`pdf` against the open project's location via `relativePdfPaths` — the same pattern `changeLocation`
uses for "Save as" — rather than copying the verbatim relative path from the source, which would point
at nothing the moment the reviewer looked. (`target:'start'` doesn't need this because it defaults to
a sibling of the source.)

**`pendingUnanimous`** (`src/screening/counts.ts`) exists because `adoptUnanimousValues` only ever
runs for the paper currently open in the Consolidation seat (`useConsolidationAlignment` is driven
by `currentPaperId`) — so a multi-reviewer screening project whose consolidator never happened to
open paper X has no consolidated `Decision` for X even though every reviewer agreed on it. The
import deliberately does **not** auto-consolidate to paper over that gap — writing decisions nobody
actually recorded, from an import dialog, would be worse than surfacing the gap. Instead the import
dialog reports the count and points at `adoptAllUnanimousScreening` (one click, one undo step,
Consolidation seat only) as the fix.

## AI-assisted annotation (`src/llm`)

A **✦ AI** button in the annotation column's header asks an LLM to read the current paper and propose values for the fields that are **still empty**. The reviewer gets a table — field, proposed value, the supporting quote from the paper, the model's confidence, and a checkbox per row — and **nothing is written until they press Apply**.

### Availability is gated twice, and defaults to off

The button being clickable requires **both** of two independent things to be true — `Project.aiEnabled && useStore().aiUnlocked` — and either one being false disables it identically:

1. **`Project.aiEnabled`** (`config.ai` in the file, default `false` for new projects) — the *project's* say. A provider of a project file can set `config.ai: false` to forbid AI use on that file outright; see `docs/annotation-schema.md`. New projects created in the editor now default to `aiEnabled: false` (writing `config.ai: false` into the file), and the AI-annotation checkbox has been removed from the project editor — with no reachable entry point for the feature itself (`aiUnlocked` below), a control that configures it promises something the app doesn't currently deliver. An existing file's own `config.ai` setting is still read and preserved on save.
2. **`useStore().aiUnlocked`** (default `false`, in-memory only, never persisted) — the *app's* say, for now: AI-assisted annotation ships in the app but is **off by default regardless of what `config.ai` says**. `config.ai: true` (or omitting it) is necessary but no longer sufficient. The only way to flip this for the running session is the hidden gesture in `Toolbar.tsx`: **`UNLOCK_CLICK_COUNT` (12) clicks on the "SaiLoR" title within `UNLOCK_CLICK_WINDOW_MS` (2500ms) of each other**, counted by the pure `nextTitleClickState()` (deliberately kept out of the component and unit-tested in `Toolbar.test.ts`, since the "N clicks within a window, else the run resets" rule is exactly the kind of off-by-one/timing logic worth pinning down). The title itself carries no `title` attribute, no pointer cursor, and no other affordance hinting that it does anything — nothing changes even mid-run, since the click count lives in a `useRef` specifically so counting does not trigger a re-render. `aiStore.openDialog()` re-checks both flags as a second line of defense in case the dialog is ever reached another way; the disabled button is the primary gate.

Whenever the button is disabled — for **any** reason (busy, no PDF, `aiEnabled` false, or not `aiUnlocked`) — its tooltip is the uninformative `"Coming soon"` rather than a reason, so the button reads as an ordinary disabled control rather than one hinting it can be unlocked. Reaching for a specific one of these reasons in a new codepath is a sign the tooltip logic needs revisiting, not extending — see `AnnotationPanel.tsx`.

**Not-yet-unlocked (`!aiUnlocked`) goes one step further than the other disabled reasons: the button is fully invisible, not merely dimmed.** `AnnotationPanel.tsx` computes `aiHidden = !aiUnlocked` separately from `aiDisabled`, and applies an `ai-btn-hidden` class (`opacity: 0` in `index.css`, overriding the ordinary `.ai-btn:disabled` dimming via the higher-specificity `.ai-btn:disabled.ai-btn-hidden` selector) plus `aria-hidden="true"` and a `title` of `undefined` — no visual presence, no accessibility-tree presence, no tooltip, nothing for a reviewer who hasn't found the click gesture to notice. The button is still in the DOM at `opacity: 0` (not `display: none`), so unlocking mid-session doesn't shift the header's layout; it is also already `disabled` in this state (`aiHidden` implies `aiDisabled`), so it was never actually clickable regardless of visibility. Once unlocked, the *other* disabled reasons — busy, no PDF, and in particular a project that explicitly sets `config.ai: false` — go back to the ordinary dimmed-but-visible treatment: a reviewer who already knows the feature exists benefits from seeing that this specific project has turned it off, which hiding the button again would only obscure.

If a later product decision makes AI available by default again, `aiUnlocked` and the whole gesture can simply be deleted and `Project.aiEnabled` alone regains control — the two checks are additive (both must hold), not layered logic that needs untangling.

### The modules

| Module | Job |
|---|---|
| `src/llm/types.ts` | The shared shapes: `LlmConfig` (one configured target — provider, base URL, model, `attach`, `reasoningEffort?`), `ModelInfo`/`ReasoningProfile`/`ModelsPage` (the model-listing shapes, see below), `LlmHttpRequest`/`LlmHttpResponse`, `Suggestion`, `SkippedField`, `RejectedSuggestion`, and the `API_KEY_SENTINEL` (`{{apiKey}}`). |
| `src/llm/fields.ts` | `unansweredFields(schema, tree)` — every field the AI will be asked about, in schema order. Its `isUnanswered()` is `validate.ts`'s notion of empty for strings/numbers; a **boolean** is offered unless it is already ticked, since the data model cannot represent an *unanswered* boolean and the archetypal AI field ("Relevant") is one. |
| `src/llm/prompt.ts` | The system prompt: the schema *format* description (`SCHEMA_FORMAT_DOC`), the path syntax, the schema itself (`dehydrateSchema`, i.e. exactly as it appears on disk), one line per field to fill, the rules, and the output shape. Plus `buildUserText` / `buildUserPdfCaption` for the user turn. |
| `src/llm/paths.ts` | The path language of the LLM contract — `"Findings[1]/Evidence[0]/Metric"`. `parsePath` / `formatPath` / `displayPath`, and `resolvePath(schema, raw)`, which checks a path against the **schema** (not the current data), so the model may name the *next free index* of a repeatable node to record a further entry. |
| `src/llm/providers.ts` | Everything that differs per vendor for the *annotation* call: `PROVIDERS` (base URL, whether the URL is editable, whether the provider can take a PDF, which output-length parameter it wants — see below), `buildRequest` (Anthropic `/v1/messages`, Google `/v1beta/models/{model}:generateContent`, or OpenAI-style `/v1/chat/completions` for the rest — plus, when `cfg.reasoningEffort` is set, each provider's own reasoning-effort field, see below), `extractText` and `extractError`. `join()` tolerates a user-typed base URL that already ends in `/v1` or the full chat path. Also exports `baseOf`/`join` for `models.ts` to reuse, and `googleThinkingMechanism`/`GOOGLE_BUDGET_BY_LEVEL` for Gemini's level-vs-budget split. |
| `src/llm/models.ts` | The *model-listing* call: `buildModelsRequest(cfg, cursor?)` (a GET, per-provider endpoint/auth/pagination) and `parseModelsResponse(provider, json)` (→ `ModelsPage`, defensive against every shape above). Also where reasoning-effort **support** is detected per model — see below. |
| `src/llm/parse.ts` | `parseAnswer(schema, raw)` — the trust boundary. Digs the JSON object out of whatever the model sent (fences, prose, stray braces), then validates **every** proposal against its `ResolvedDef`. |
| `src/model/pdfText.ts` | `extractPdfText(bytes)` — the paper as plain text, one `[page N]` block per page, using the same reading-order heuristic as `pdfMeta.ts`. Reports `empty: true` when a document yields almost no characters (a scan). |

`src/state/aiStore.ts` (a separate Zustand+immer store, kept out of the main store for the same reason the project editor is) owns the flow; `src/components/AiDialog.tsx` and `LlmSettingsDialog.tsx` are views over it.

### The flow

1. **`openDialog()`** computes `targets = unansweredFields(schema, paper.annotations)` and loads the configured targets from the platform. The dialog names how many empty fields will be proposed and — before anything is sent — states *what leaves the machine, and to whom*.
2. **`run()`** fetches the paper's bytes from the same URL the viewer renders (`getPdfSource`, so `slr-file://` in Electron and `blob:`/`http` in the browser), then:
   - **`attach: 'text'`** (the default, and the only option for an `openai-compatible` target) → `extractPdfText`. If the extraction is `empty` the run **stops with an error** rather than sending a title and inviting the model to invent a paper from it.
   - **`attach: 'pdf'`** → the PDF is base64'd and sent as an attachment (Anthropic / OpenAI / Google / OpenRouter only — the others have no way to take one inline in a single request). A target set to `pdf` against a provider that cannot take one **silently falls back to text**, and the dialog's consent line mirrors that fallback rather than promising the PDF.
3. `buildSystemPrompt(schema, targets, delivery)` + `buildRequest(config, …)` → an `LlmHttpRequest`. The `delivery` matters: with extracted text the model is told the extraction is lossy, or it will confidently reconstruct a mangled table into numbers.
4. **`platform.callLlm(request, signal)`** sends it (see below) and returns the raw body.
5. `parseAnswer` validates it; the surviving `Suggestion[]` become review rows, **all pre-ticked** — the reviewer's job is to *remove* what is wrong.
6. **`apply()`** hands the ticked suggestions to `useStore.applyAiSuggestions`.

The store keeps an `AbortController` outside the state (it is not serializable), so **Cancel** aborts a call in flight; an elapsed-seconds ticker drives the progress line.

### Model listing and reasoning effort

The model field in `LlmSettingsDialog.tsx` is not free-typed against nothing: `aiStore.fetchModels(config, apiKey?, opts?)` asks the provider itself what models exist, via the same `platform.callLlm` transport the annotation call uses — `buildModelsRequest` (`src/llm/models.ts`) builds a `GET` (the one place `LlmHttpRequest.method` is ever `'GET'`; everything else is `'POST'`), and `parseModelsResponse` turns whatever comes back into `ModelInfo[]`. Results are cached in `aiStore`'s `models`/`modelsLoading`/`modelsError`/`modelsFetchedAt`, keyed by `LlmConfig.id`, for `MODELS_TTL_MS` (1h) unless `opts.force` bypasses it. Fetching still requires a stored key — same requirement, and same "save first" pattern, as `verifyConfig`.

`ModelPicker.tsx` renders the fetched list as a searchable dropdown, but — unlike `ComboBox.tsx` (used for closed enum fields elsewhere) — it **never reverts what the reviewer typed**. A provider's catalog can be incomplete (a brand-new model, a private fine-tune) or simply not fetched yet, so the model field always accepts free text; once the field has been left with text that doesn't match any fetched model, `ModelPicker` marks itself invalid (red border, a tooltip naming the provider) rather than silently discarding it. An empty/unfetched list is never "invalid" — only "unknown".

**Reasoning-effort detection is per-model, not per-provider**, because it depends on which model, not which vendor: `models.ts` attaches a `ReasoningProfile | null` (`{ levels, defaultLevel }`) to each `ModelInfo`, from two different sources depending on the provider:

- **Read from the response itself**, where the provider says so: Anthropic's `capabilities.effort.{level}.supported` (`/v1/models` — the exact levels a model takes, no guessing), Google's `thinking: boolean` flag, OpenRouter's per-model `reasoning.supported_efforts`. These need no maintenance as new models ship.
- **A model-ID pattern**, where the provider's list endpoint says nothing about it (OpenAI: `o[0-9]`/`gpt-5*` minus `-chat` variants; Groq: `openai/gpt-oss*` only; xAI: `grok-4.5` only; Mistral: `mistral-(small|medium)*`). These are best-effort allowlists, verified against each provider's docs at the time they were written, and **will go stale as new models ship** — revisit them the same way `tokenParam` in `providers.ts` already has to be revisited (see *Change Guidance* below).
- **Deliberately `null` for every model on two providers**: DeepSeek (its `reasoning_effort` contract for the newer V4 models could not be confirmed against primary docs) and `openai-compatible` (no single agreed-upon shape across llama.cpp/vLLM/LM Studio — llama.cpp is actively *removing* its per-request toggle in favor of a server-startup flag). Offering a control that silently does nothing on some servers is worse than not offering one.

`LlmSettingsDialog.tsx` shows the reasoning-effort `<select>` only when the *currently selected* model has a profile, defaults it to `defaultLevel` (`"medium"` when the model offers it, else the level in the middle of its range — "if reasoning effort is available, default to medium or the nearest equivalent") the moment such a model is picked, and clears `LlmConfig.reasoningEffort` the moment a non-reasoning model is picked instead — a stale effort level must never outlive the model it was chosen for. `buildRequest` (`providers.ts`) then injects it in whatever shape that provider's chat-completions call actually wants: Anthropic gets `thinking: {type:'adaptive'}, output_config: {effort}`; Google gets `generationConfig.thinkingConfig.thinkingLevel` (Gemini 3.x) or a token-count `.thinkingBudget` translated via `GOOGLE_BUDGET_BY_LEVEL` (Gemini 2.5.x — the two shapes are mutually exclusive on one request, so a model only ever gets one); OpenRouter gets a nested `reasoning: {effort}`; everyone else (OpenAI, Groq, Mistral, xAI) gets a flat `reasoning_effort` field.

Switching provider mid-edit clears both the typed model and the cached model list for that draft (`clearModels(id)`) — the list answered "what does the *old* provider have", which is not an answer to "what does the new one have", even though the draft's `id` (and so the cache key) stays the same across the switch.

### Why the call goes through the Electron main process

A request to an LLM API is a `POST` with `Content-Type: application/json` and an auth header — which makes it a **preflighted cross-origin request**, sent from the renderer's origin (`file://` in a packaged app). It is the same CORS wall that forced `corsEnabled` on the `slr-file://` protocol (documented under *Electron Main Process* below): Chromium rejects the request before it ever reaches the network, and the failure surfaces as an opaque `TypeError` with no detail. So on the desktop the renderer **never sends the request itself** — `ElectronAdapter.callLlm` hands it to `llm:call`, and the main process sends it with `net.fetch`, where no origin and no CORS check apply.

The second reason is the one the whole layer is built around: **the API key never enters the renderer.**

- `LlmConfig` has **no `apiKey` field** — only `hasKey: boolean`. A stored key can never be read back, not even by the settings dialog that wrote it (so leaving the key box blank on an edit *keeps* the stored key; that is the only way to edit a target without retyping it).
- The renderer builds the *entire* request, but can only put `API_KEY_SENTINEL` (`{{apiKey}}`) where the key goes. `electron/main.ts` substitutes the real key into the headers immediately before sending.
- Before it does, it **checks the origin**: `new URL(request.url).origin` must equal `new URL(config.baseUrl).origin`, or it refuses. The renderer names the URL, so a compromised renderer must not be able to post the key to a host of its choosing.
- Keys are stored in `userData/llm-config.json`, encrypted with `safeStorage` (mode `0600`). If `safeStorage.isEncryptionAvailable()` is false the app **refuses to save** rather than silently writing the key in the clear.

`llm:call` also takes a `requestId` and keeps the `AbortController` in an `inFlight` map, because an `AbortSignal` cannot cross IPC — Cancel sends a separate `llm:abort` message that main matches against the id.

The same channel carries the list-models requests from `models.ts`: `LlmHttpRequest.method` (`'GET'` or `'POST'`, defaulting to `'POST'`) tells both `electron/main.ts` and `src/platform/browser.ts` whether to send a body at all — a `GET` carries none, and passing one is a `fetch` error on some runtimes. The origin check and sentinel substitution apply identically either way.

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

On a multi-reviewer project, the key also folds in the active reviewer (`` `${paperId}::${reviewer}::${canonicalPath}` ``, via `aiMarkKey`'s third argument) — otherwise Reviewer 1 running the AI would leave marks that appear to belong to Reviewer 2's identical field paths. A single-reviewer project's keys are exactly the two-part form above (the reviewer argument defaults to `null`, which reproduces it), so nothing about single-reviewer behavior changes.

### AI usage disclosure (`Paper.aiUsage`)

Deliberately the opposite design from AI marks: where a mark is session-only and never reaches the
file, `Paper.aiUsage` (`src/model/project.ts`) is a permanent, append-only log — `{ provider,
model, appliedAt }` — meant to survive into the saved file so a co-reviewer (or the reviewer
themself, later) can see that, and how, AI was used on a paper.

- **Written by `applyAiSuggestions`** (`src/state/store.ts`), inside the *same* `set()` mutation —
  and therefore the same undo step — as the field writes themselves, only when the run actually
  filled something (`filled > 0`). This is a deliberate coupling: undoing the AI fill that produced
  a disclosure entry undoes the entry with it, consistent with how AI marks are already tied to the
  data they describe. There is no cheap way to make a field "survive" an undo of the action that
  created it under this app's whole-project-tree undo/redo (see *State management* above), so rather
  than fight that, the entry rides along with the fill it discloses.
- **Parsed defensively** (`parseAiUsage` in `project.ts`): the file is hand-editable, so a
  malformed entry — wrong types, a non-array `aiUsage`, missing fields — is dropped, never thrown
  over (`aiUsage: z.unknown().optional()` in `schema.ts` intentionally does not typecheck the
  shape at the zod layer, for the same reason `annotations` doesn't: "loosely typed here,
  validated/normalized structurally in project.ts").
- **Written only when non-empty** (`serializeProject`): a paper AI was never used on carries no
  `aiUsage` key at all, so a normal, hand-annotated project's file stays exactly as it always was.
- **Array order is the ordering guarantee** ("the order of use should be apparent"): entries are
  pushed oldest-first, and `appliedAt` (an ISO 8601 timestamp) makes that order explicit even if the
  array is ever hand-edited or reordered.

## Git

### Why Electron-only

**Electron: yes.** The main process is Node, so `child_process.execFile('git', […])` spawns the
user's own `git` binary, which reads their real `~/.gitconfig`, their credential helper
(`osxkeychain`, `manager-core`, …), their `~/.ssh/config`, and their SSH agent. No npm dependency is
needed and none was added — the runtime dependency list stays at 6 (`immer`, `react`, `react-dom`,
`react-pdf`, `zod`, `zustand`).

**Browser: no, and there is nothing to fall back to.** `src/platform/browser.ts` has no `process`,
no `fs`, and no `path` (`rebasePdfPaths` returns its input unchanged with the comment "the browser
has no paths"; `getOsInfo()` returns `null`; PDFs need an explicit user folder grant). A web page
cannot spawn a process, cannot read `~/.gitconfig`, and cannot reach an SSH agent — this is the
sandbox, not a missing feature, and no flag or permission changes it. The feature request's own
fallback clause — "if this is not possible, it should still try to use the local git
configurations" — has no referent in the browser: there is no local git installation reachable, so
there is no local git configuration to try.

**Rejected: a pure-JS reimplementation (isomorphic-git or similar).** It would answer a different
question than the one asked. It is not "the local git installation" — it has its own credential
handling, does not read the user's `~/.gitconfig`, and does not use their SSH agent or credential
helper. Shipping it and calling it "git support" would be dishonest about what actually ran.

**The conclusion: git support is Electron-only.** This mirrors how the codebase already handles
other capability gaps — `getOsInfo(): OsInfo | null`, `needsPdfFolderGrant()` returning `false` on
Electron (there is no such prompt there), the pathless `rebasePdfPaths` — and it is expressed in the
type system, not left as a runtime convention: `PlatformAdapter.getGit(): GitPlatform | null`
returns `null` in the browser, so a caller cannot invoke a git operation without first proving the
runtime has one. A flat `GitPlatform` capability object rather than sixteen individual methods on
`PlatformAdapter` is deliberate too: sixteen flat methods would mean sixteen browser stubs, each of
which either throws at runtime or silently no-ops — "unavailable" would be something a caller
discovers by calling it, not something the type checker catches for them. `getOsInfo(): OsInfo |
null` already established the pattern this follows.

**The browser build shows every git entry point disabled, not absent.** `Toolbar.tsx` checks
`getGit()` the same way any other caller does, but where the annotation UI usually treats "no
capability" as "no control" (there is no PDF-grant button on Electron, because `needsPdfFolderGrant()`
is `false` there and the concept doesn't apply), the toolbar's **Git** button and the Open menu's
**Import from git…** item stay in the layout in the browser build too — dimmed, with
`GIT_BROWSER_DISABLED_HINT` (`Toolbar.tsx`) as the tooltip, telling a reviewer *why* it doesn't work
and that the desktop app is where it does, rather than a control that quietly isn't there for them to
notice missing. This is a genuinely different choice from `needsPdfFolderGrant()`'s: that gap has no
button anywhere to hide, while this one is choosing to surface a capability boundary explicitly
instead of omitting the entry point the way the type-level `GitPlatform | null` design would most
simply suggest.

**On Electron the Git button is now always rendered, disabled with an honest tooltip whenever it
can't be used** — including the start screen (no project open) and when the open project's file isn't
in a git repository. The policy is unified through `gitButtonState()` (`Toolbar.tsx`), a pure function
mirroring the "Import from git…" menu item's precedence: hidden only in the browser (where `getGit()`
is `null` and the concept doesn't apply), disabled-with-reason everywhere else the capability exists
but can't currently be used, and enabled only when a project is open in a real git repo and no other
operation is busy. Showing the button disabled on the start screen — rather than hiding it — keeps the
layout stable so a reviewer who opens a project doesn't see the toolbar jump.

**A third, distinct case: git is not installed.** `GitPlatform.probe()` runs `git --version`. On
failure the app says so honestly, with git's own error text, and the git entry points are shown
**disabled with that reason** rather than hidden entirely — a control this *machine* could offer if
git were installed is worth showing dimmed; a control the *runtime* can never offer (the browser) is
noise and is hidden outright. This is the same asymmetry `AnnotationPanel.tsx` already applies to
the ✦ AI button: invisible when the runtime/session gate (`aiUnlocked`) is off, dimmed-but-visible
when the *project* turned it off (`config.ai: false`).

### The renderer never names an argv

Every git operation the renderer can ask for is one of sixteen enumerated IPC handlers in
`electron/main.ts` (`git:probe`, `git:pickCloneDir`, `git:clone`, `git:pickProjectIn`, `git:info`,
`git:identity`, `git:status`, `git:headContent`, `git:workingContent`, `git:commitPartial`,
`git:commit`, `git:push`, `git:pullBegin`, `git:pullFinish`, `git:pullAbort`, `git:writeWorking`) — never a general
`git <args>` channel. Git has `--exec-path`, aliases, and the `ext::` remote-helper
transport; a channel that let the renderer choose the argv would be handing it arbitrary code
execution wearing a "just run git" label. Main decides what git is actually asked to do; the
renderer only supplies data (a URL, a path, a commit message, a resolved text).

Every call uses `execFile` with an **argument array**, never a shell string, and a `--` terminator
before any user-supplied path or URL — a repository URL or a destination path is user input reaching
a spawned process, and without both, a URL like `--upload-pack=/bin/sh` would be read as an option
rather than an argument. `src/git/url.ts` (`validateGitUrl`/`validateClonePath`) is the actual gate,
and **`electron/main.ts` imports it** — the first, and (with `src/git/output.ts`'s `gitErrorText`)
one of only two, imports of `src/` into `electron/`. That is deliberate and load-bearing: a security
gate must not exist twice, the same reason `comparable()` in `src/consolidate/unanimous.ts` is one
shared function rather than three copies that could drift. Both modules import nothing themselves,
so they typecheck identically under `tsconfig.node.json` (`types: ["node"]`) and `tsconfig.app.json`
— a file appearing in two TypeScript programs is fine as long as neither is `composite` and both are
`noEmit`, which is already true here.

`validateGitUrl` is an **allowlist of transports** (`https://`, `http://`, `ssh://`, `git://`,
`git+ssh://`, `file://`, the `user@host:path` scp shorthand, or an absolute local path), not a
blocklist of characters — because the dangerous case is not a stray shell metacharacter (`execFile`
+ the argument array already close that door) but git's own `ext::` remote-helper syntax, which
makes git run a program *named by the URL*. The `::` check requires two consecutive colons, so an
ordinary `https://` (which has none between the scheme and its slashes) can never trip it —
`src/git/url.test.ts` pins this explicitly, because it is exactly the kind of regex a later
"simplification" could quietly break.

### Not weakening git, only removing what cannot work here

`gitEnv()` (`electron/main.ts`) sets `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, and
`GIT_SEQUENCE_EDITOR=true`, and strips any inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG`-family
variable. None of this weakens anything a user configured:

- The spawned process has no terminal. A git that decided to prompt for a username, or open an
  editor for a commit message, would otherwise block forever on a tty that does not exist, and the
  app would look frozen with no way out. Turning both off makes git fail immediately with its own
  message instead of hanging — the opposite of weakening, since a hang is a worse failure mode than
  an honest error.
- Credential helpers, askpass programs, SSH agents and host-key checking are **never touched**. None
  of them is a terminal prompt, which is exactly the point: the user's configured way of
  authenticating still works unchanged, and only the "type it at the console" path — which cannot
  work in a spawned child with no tty — is turned off.
- The `GIT_DIR`-family variables are stripped because SaiLoR may have been launched from a shell
  that happens to be sitting inside some *other* git repository; an inherited `GIT_DIR` would
  silently point every git call below at that repository instead of the project's own.

### Reviewer seat identity

Which reviewer "you" are on a multi-reviewer project (`currentReviewer`, see "Multiple reviewers &
Consolidation" above) used to be decided **per machine**: a seat choice in `localStorage`, keyed by
clone path, with nothing in the project file recording who actually held which seat. Two different
people who each clone the repository and both pick "Reviewer 1" are invisible to each other — their
independently-annotated trees merge field by field with **zero conflicts raised**, producing one
chimeric tree that silently blends two people's answers. `src/model/identity.ts` (a pure module) and
`Project.reviewerIdentities: Record<string, ReviewerIdentity>` (written to the file as
`config.reviewerIdentities`, keyed `"1".."N"` and the literal `"consolidation"`) exist to record the
claim in the one place both reviewers actually share: the file itself.

- **`ReviewerIdentity = { email: string; name?: string }`.** `sameIdentity(a, b)` compares **email
  only** — `name` is never read — specifically so a reviewer who re-spells their display name
  ("J. Keim" → "Jan Keim") never manufactures a false mismatch or a false merge conflict; email is
  the thing git itself already treats as a stable identity (`user.email`).
- **`checkSeat(identities, seat, myEmail)`** returns `{ kind: 'ok' }` or `{ kind: 'mismatch', holder
  }`. It is silent (`'ok'`) whenever `myEmail` is `null` — no git identity to compare against, which
  covers a solo user, the browser build (`getGit()` is `null`, so identity is never fetched), and a
  seat nobody has claimed yet.
- **`git config user.email`/`user.name`** are read via `git:identity` — an enumerated IPC handler
  in `electron/main.ts` (see "The renderer never names an argv" below for the full list), exposed through `preload.ts` as `gitIdentity`, typed as
  `GitPlatform.identity(root): Promise<GitIdentity>` in `src/git/types.ts`, and implemented in
  `src/platform/electron.ts`. Read with the repository itself as the working directory, not once per
  launch — `user.email` is routinely set per-repository, and a reviewer who took that care is exactly
  who must not be told they are someone else. An unset key exits non-zero with no output, read back as
  `''` rather than an error: "no identity here" is not a failure.
- **`gitStore.ts`'s `refreshRepo`** fetches this identity alongside the ordinary repo status, guarding
  against the same open-project-changed-underneath-it race the rest of `refreshRepo` already guards
  against.
- **On mismatch, the app warns — it never hard-blocks.** `ReviewerPrompt` gains a second render mode:
  when the currently-selected seat's recorded holder's email doesn't match this machine's git email,
  it offers **Take this seat** (writes this identity into `reviewerIdentities` for that seat) or
  **Pick a different seat**, rather than silently proceeding or refusing to open the project.
  `Toolbar.tsx`'s reviewer switch adds a "Claimed by …" hint to each seat's tooltip (and an
  `is-mismatch` styling hook) so the seat-holder is visible before a reviewer even picks one. A file
  with no `reviewerIdentities` at all, or a seat nobody has claimed yet, hits none of this — back
  compat is exact: a plain `reviewers: 2` file with no identities loads and behaves exactly as before
  this feature existed.
- **`mergeProjects` refuses** when two *different* emails claim the same seat (see "What refuses, and
  why" above) and **`detectFieldChanges` treats any `reviewerIdentities` difference as structural**
  (see "Field-level commit review" above) — claiming a seat is a configuration fact, not an
  annotation with a value a reviewer picks between.

### The module layout

| Module | Purpose |
| --- | --- |
| `src/git/types.ts` | Shared shapes crossing the platform seam: `GitRun`, `GitProbe`, `GitFileChange`, `GitStatus`, `GitRepoInfo`, `CloneOutcome`, `PullStart`, and the `GitPlatform` interface itself. |
| `src/git/url.ts` | Pure. `validateGitUrl`, `validateClonePath`, `repoNameFromUrl` — the security gate, imported by `electron/main.ts` (see above). |
| `src/git/output.ts` | Pure. `parsePorcelain` (turns `git status --porcelain=v1 -z` into `GitFileChange[]`), `capDiff` (caps a diff for the DOM), `diffLines` (splits a unified diff into per-line `add`/`remove`/`context` for the coloured view — see below), `gitErrorText` (what to show when a git command failed) — also imported by `electron/main.ts`, so the "what does a failed run's message say" logic exists once. |
| `src/git/merge.ts` | Pure. The field-level three-way merge — see below. Knows nothing about git or the DOM, the same shape `src/consolidate/` follows. |
| `src/git/changes.ts` | Pure. Field-level *local* change detection and composition for the commit panel — see "Field-level commit review" below. Reuses `merge.ts`'s `conflictId`/`MergeTree` for row identity, but not its three-way `merge3` rule (only one side, the working tree, has changed here). |
| `src/state/gitStore.ts` | The clone flow and the commit/pull/push panel; owns the pull orchestration and the field-review state. |
| `src/components/GitCloneDialog.tsx`, `GitDialog.tsx`, `GitMergeDialog.tsx` | Views over `gitStore`. |

**Each dialog's width class is `.modal.git-*-dialog`, not bare `.git-*-dialog`** — a single-class
selector has the same specificity as index.css's own `.modal` (which also sets `width`), so which
one wins is decided by stylesheet order rather than anything about the rules, and that order is not
even the same between dev mode (Vite injects each imported stylesheet as its own `<style>`, in
module-evaluation order) and the production bundle (Rollup concatenates them, and did so the other
way round). Concretely: with the bare selector, every git dialog's own width was silently losing to
`.modal`'s generic one in the shipped build — all three stuck at the same 680px regardless of what
`git.css` said. Qualifying with `.modal` too makes the outcome deterministic instead of an accident
of build order.

**The clone dialog's URL field needed its own width for an unrelated reason.** `.field-input`'s
width comes from `flex: 1 1 auto`, which does nothing outside a flex row — every other place it is
used *is* one, but the URL field is the sole control in the clone dialog's body, so it still rendered
at the browser's default input width no matter how wide the dialog around it was.
`.git-clone-url-input` gives it `width: 100%` directly, which is what actually makes it "big" — the
dialog itself is a bounded `min(600px, 94vw)`, the same shape as the other two dialogs, not scaled to
window width. An earlier version made the *dialog* `92vw` to get a wide field, which worked but took
everything else in the dialog (the destination path, the buttons) along with it, past a comfortable
reading width on a large monitor for no reason those needed to grow at all. Fixing the input's own
width instead of the dialog's gets the same big field at whatever size the dialog actually is.

**The diff is coloured per line, not as one block.** `GitDialog.tsx` renders each line `diffLines`
(`src/git/output.ts`) returns as its own `<span className="git-diff-line git-diff-{kind}">`, since a
unified diff interleaves added, removed, and unchanged context lines — anything coarser would colour
context text too. Classifying a line as `add`/`remove` by a bare `+`/`-` prefix check would misread
two things at once: a genuinely added line whose own content starts with `+`/`-` (`++counter;`), and
— worse — the `+++ b/path`/`--- a/path` file-header pair the moment a file's first real change
happens to start with those same three characters. `diffLines` instead tracks whether a hunk has
started for the *current* file (reset on every `diff --git`, set on that file's first `@@`): the
header pair, which by git's own format only ever appears once per file and always immediately before
that file's first hunk, is `context` regardless of what it looks like, and every `+`/`-` line once
inside a hunk is real content regardless of what *it* looks like.

### State management: `gitStore`

`useGitStore` (`src/state/gitStore.ts`) is a separate Zustand+immer store, kept out of the main store
for the same reason `aiStore` and the project editor are: a self-contained flow with its own
lifecycle that the ordinary annotation path never needs to know exists. The dependency direction is
one-way — `gitStore` reads and drives the main store via `useStore.getState()`, but `store.ts` never
imports `gitStore` (it does not import `aiStore` either, for the same reason). Refreshing `repo`
(where the open project sits git-wise) whenever the open project's `saveHandle` changes is therefore
an effect in `App.tsx`, not a call made from inside `store.ts` — the same shape the AI store's own
wiring already has.

### The pull command sequence

`git:pullBegin` (`electron/main.ts`) is the classification a pull starts with, run in this order:

1. `git status --porcelain=v1 -z` — any tracked change (an untracked file, code `??`, never blocks a
   merge) means `{ kind: 'dirty', paths }`.
2. No `@{u}` (no upstream configured) means `{ kind: 'no-upstream', branch }`.
3. `git fetch`. A failure means `{ kind: 'error', message }`.
4. `HEAD` already an ancestor of `@{u}` means `{ kind: 'up-to-date' }`.
5. `@{u}` already an ancestor of `HEAD` means a fast-forward: `git merge --ff-only @{u}`, then
   `{ kind: 'fast-forwarded' }` or `{ kind: 'error', message }`.
6. Otherwise the histories have diverged. The merge base and the project file's text at all three
   revisions (`git merge-base`, then `git show <rev>:<path>`) are read **before** anything touches
   the work tree, so nothing that follows can change what actually gets merged.
7. `git merge --no-commit --no-ff <ref>`. If it never even started (`MERGE_HEAD` absent — unrelated
   histories, a hook refusing) that is `{ kind: 'error', message }`, without ever calling `merge
   --abort` (which would itself fail with "There is no merge to abort" — checking `MERGE_HEAD` first
   is what keeps the next point true).
8. If anything **other than the project file** is left unmerged, SaiLoR does not know how to help —
   it knows how to merge an annotation JSON, not a PDF or a `.gitignore`. The git merge is aborted
   (`git merge --abort`) and `{ kind: 'conflict-elsewhere', paths }` is returned; nothing is
   half-done.
9. Otherwise: `{ kind: 'merge', ref, base, ours, theirs }` — the three texts, handed to
   `mergeProjects` (below).

**Contract**: `git:pullBegin` always returns with the repository in exactly one of two states — not
mid-merge, for every outcome except `'merge'`, or mid-merge with nothing unmerged except the project
file, for `'merge'`. It never returns leaving a half-merge the renderer did not ask for.

`git:pullFinish(root, relPath, text)` always writes `text` — the *merged* project's own
`serializeProject` output — over whatever git's own line-based attempt produced, then `git add` +
`git commit --no-edit`. `git commit` after a merge with `MERGE_HEAD` set is what records both
parents and tolerates an empty tree change, which is why the merge commit is finished this way
rather than with `commit-tree` or `merge -m`; `--no-edit` takes git's own prepared `MERGE_MSG`, and
`GIT_EDITOR=true` (above) is the backstop if it ever tried to open one anyway.

### Two gates before a pull touches anything: on-disk clean, and in-memory clean

`git:pullBegin`'s `'dirty'` check answers one question: is the **file on disk** clean by git's own
`status`. It says nothing about the reviewer's **unsaved, in-memory** annotations — those exist only
in the React state and are invisible to git entirely. `gitStore.ts`'s `runPull()` therefore refuses
outright, before ever calling `beginPull`, when `useStore.getState().dirty` is true: a fast-forward
or a finished merge reloads the project file from disk (`reloadOpenProject`, which is exactly
`openRecent(path)` — the file changed underneath the open project, so the in-memory copy is stale
either way), and without this guard that reload would silently discard whatever the reviewer had not
yet saved. This is the single most important line in the whole feature: get it wrong and a pull can
lose a reviewer's unsaved work with no warning at all. `GitDialog.tsx` shows a dirty-banner with a
**Save project** button and disables Pull (and Commit — committing the file on disk while the
in-memory copy disagrees with it is its own kind of confusing) while it's up.

### The merge (`src/git/merge.ts`)

The full reasoning lives in `data-model.md`'s "Merging two copies of a project"; this is the shape of
it from the code side.

- **The one rule (`merge3`)**: a side that did not change a value away from the base does not get a
  vote on it. Applied identically from the project's own title down to a single annotation field —
  not a special case, the actual algorithm. Returns a conflict only when both sides changed a value,
  to different things.
- **Exact equality, not `comparable()`.** `unanimous.ts`'s `comparable()` folds case and whitespace
  because it is answering "did the reviewers say the same thing"; a merge is answering "did *I*
  change this value since the base", and folding away a capitalization fix would silently revert the
  reviewer's own edit in favor of the remote's. `merge.ts` uses plain `===` on `FieldValue`, and
  `merge.test.ts` pins the distinction directly (a base→ours case-only fix survives unopposed; the
  same fix made *differently* on both sides is a real conflict).
- **Absent reads as empty (`valueAt`).** `pruneTree` drops only the *trailing* empty instances on
  save, so an instance that is empty-but-present and one that is simply missing are the same thing on
  disk — and must merge the same way, or a field one side filled in from nothing would wrongly
  conflict against an "absent" base, and an entry the remote deleted would come back. This is also
  what makes instance *removal* fall out of the ordinary field-level rule with no instance-level logic
  at all: a removed entry reads as all-empty on that side, the rule takes the empties, and
  `pruneTree` drops the now-trailing instance on the next save.
- **Repeatable arrays are unioned by index and never compacted.** `count` is the union of all three
  sides' lengths (clamped to `def.max`); position is never closed up, because position carries
  meaning — consolidation lines up each reviewer's entries by index (`src/consolidate/apply.ts`), and
  closing a gap here would silently re-point that alignment.
- **A conflicted field holds *our* value in `merged` until it is resolved.** If the resolution dialog
  is ever bypassed, the file still holds the local reviewer's own work — the safe side. It is not a
  decision on the merge's part: `GitMergeDialog` marks every conflicted row undecided regardless, and
  will not finish the merge until each one has actually been answered.
- **What refuses, and why.** A change to `version`, `config.schema`, `config.ai`, `config.reviewers`,
  `config.screening`, or a root/paper `extra` key, made differently on both sides, refuses the
  *whole* merge rather than guessing a field-level answer — each of these re-shapes the file (most
  obviously the schema, which decides the shape of every annotation tree; `config.screening` for the
  same reason, since it decides `config.schema` via `screeningSchemaDefs` in the first place), and a
  left/middle/right conflict row cannot ask "which taxonomy is right". `Project.title` is
  deliberately **not** on this list: it is one string, a conflict row expresses it perfectly, and
  refusing an entire merge over two people renaming the review would be absurd. Two more refuse for
  two different reasons: `provenance` is a nested record no `FieldConflict` shape can express, not
  something that reshapes the file — the common case (only one side ever sets it) still resolves
  cleanly with no refusal at all. `config.reviewerIdentities.<seat>` refuses **per seat**, and only
  when the two sides name **different emails** for the same seat (compared via `sameIdentity` —
  email only, so a name-only edit merges silently); a name-only difference is not this feature's
  hazard and must not force a refusal on its own. This is deliberately a refusal, not a conflict row:
  a conflict row can be clicked through without a second thought, and clicking through is exactly how
  the chimeric reviews tree this feature exists to prevent gets built — see `identity.ts`'s module
  doc and "Reviewer seat identity" above.
- **The paper-deletion asymmetry.** A paper one side deleted and the other side *changed* is kept,
  with a note, never silently deleted — a field-level UI cannot ask "keep or delete this paper", and
  the two failure directions are not symmetric (a paper nobody wanted is one click from gone; deleted
  annotated work is just gone). Contrast with `reviews`: a reviewer's tree is **never** deleted by a
  merge, only by both sides having already dropped it — the same rule `normalizeReviews` already
  applies on load (see "Lowering the reviewer count" in the schema guide), because a reviewer's tree
  is someone's labour, not a project-author decision the way a paper is.
- **`aiUsage` is a union, not a three-way merge**, and deliberately does not consult `base` — it is an
  append-only disclosure log with no delete operation, so a record either side still holds must
  survive regardless of what the base looked like.
- **A boolean can never conflict.** `Paper.equal`, a set spelled as an array, merges per-path via
  `merge3<boolean>` — a boolean has only two values, so "both sides changed it, differently" cannot
  happen; `merge3`'s first branch (`eq(ours, theirs)`) always takes it.
- **`Paper.abstract` and `abstractFromPdf` are ordinary paper-level fields, merged independently.**
  Each gets its own `merge3` call and its own possible conflict row, the same as `title`/`doi`/`pdf`.
  A known, accepted gap: resolving an `abstract` conflict does not retroactively touch
  `abstractFromPdf` — if only one side changed the flag, `merge3`'s "one side changed" branch takes
  it before the reviewer ever sees the separate `abstract` conflict, so the resolved text and the
  disclosure flag can end up describing two different edits. `merge.test.ts` demonstrates and pins
  this exact case rather than hiding it. This was a genuine bug until fixed: both fields were
  entirely absent from `mergePaper`'s field list, `canonicalPaper`, and `applyOne` — every pull
  silently dropped every paper's abstract, and `canonicalPaper`'s omission meant an abstract-only
  edit could make `paperUnchanged` wrongly true, risking the paper being dropped as part of the
  paper-deletion asymmetry above.

`applyResolutions` writes the reviewer's per-conflict choices into the merged project with immer's
`produce` — not `structuredClone` (not something to bet on under every runtime this ships to) and not
`JSON.parse(JSON.stringify(...))` (which drops `undefined`-valued keys that both `deepEqualJson` and
the round-trip test care about). `deepEqualJson` itself is **exported from `src/model/project.ts`**
rather than redefined in `merge.ts` — the same "one shared implementation" rule as `comparable()`.

### Field-level commit review

Before this existed, `git → Commit` only offered a whole-file checkbox: tick the project JSON or
don't. `src/git/changes.ts` breaks the open project's own file down into the individual fields that
actually changed, so a reviewer can decide field by field whether to commit it now (**Use**), leave
it as a still-uncommitted local change to revisit later (**Ignore**), or revert it (**Discard**) —
without touching everything else in the file.

**The comparison is structural, not textual.** `detectFieldChanges(head, working)` compares two
parsed `Project`s (HEAD's own copy of the file, read via `git:headContent` — `git show HEAD:relPath`
— against the working tree's, read via the side-effect-free `git:workingContent`), walking annotation
trees the same recursive way `merge.ts`'s three-way walk does and reusing its `conflictId`/`MergeTree`
shapes for row identity. This is deliberately immune to JSON formatting/key-order noise — the same
"compare parsed values, not text" choice the codebase already made for `needsShapeMigration`. Unlike
`merge.ts`, there is no three-way question here: only the working tree has changed, so every
difference is something the reviewer decides about, not something that might resolve itself.

**A structural difference refuses field-level review entirely, falling back to the plain file
checkbox** — the same refusal list `mergeProjects` uses (`config.schema`, `config.reviewers`,
`config.ai`, `config.screening`, `config.reviewerIdentities`, `version`, `provenance`, root
`extra`): once the schema itself might differ, "which fields changed" stops being a question with
a field-level answer. `provenance` is here for a different reason than the rest — it doesn't
reshape anything, it's just a nested record no `FieldConflict` row can express. `reviewerIdentities`
is here because claiming a seat isn't an annotation with a "which value do I want" answer; the cost
is bounded and self-healing — only the one commit that first claims a seat falls back to the
whole-file checkbox (which still commits it), every commit after that sees `head` and `working`
already agree and field-level review resumes.

**Coupled fields are bundled into one row.** `PAPER_META_BUNDLES` maps `abstract` to its hidden
dependent, `abstractFromPdf` — the disclosure flag is not an independent fact a reviewer chooses
among, it just describes whichever `abstract` value ends up committed, so it never gets a row of its
own; it silently follows the primary field's disposition (`applyFieldWithBundle`, which reads the raw
boolean directly from the source `Project` rather than trying to derive it from the bundled field's
own display string).

**Discarding is deferred, and it is a real write.** Picking Discard on a row does *not* touch the
file on disk — it only records the decision, in `gitStore`'s `panel.fieldReview.decisions`. Nothing
is reverted until the reviewer actually presses **Commit**: `composeContents(head, working, changes,
decisions)` then builds two divergent `Project`s from the same three inputs — `committed` (what gets
staged: HEAD's own value for every `discard`/`ignore` row, the working tree's value for every `use`
row) and `workingOut` (what the file on disk ends up holding afterward: HEAD's value written back in
for every `discard` row, unchanged everywhere else). A paper added locally follows the same shape —
**discard** deletes it from `workingOut`; a paper removed locally follows it too — **discard**
restores it from `head` into `workingOut`.

**Standalone discard without committing.** When every changed row is marked Discard (nothing is marked
Use), the primary button in `GitDialog` relabels from "Commit" to **"Discard all"** and turns
danger-red. Pressing it calls `runDiscard` (`gitStore.ts`), which composes only `workingOut` (the
reverted file content) and writes it directly via `git:writeWorking` — a separate IPC handler that
writes text to the working file without staging or committing anything. This lets a reviewer revert
all local edits in one action without going through the commit ceremony. The per-row **Discard**
button was also moved to the row's right edge (opposite Use/Ignore) so the three dispositions read
left-to-right as a single visual axis.

**Partial-file staging has no native git primitive, so it is a write → commit → write-back
sequence.** `git:commitPartial` (`electron/main.ts`) writes `committedText` to the file, `git add` +
`git commit`s it (along with whatever else is in `otherPaths`, the ordinary whole-file selections),
then — in a `finally` block, unconditionally, whether or not the commit itself succeeded — writes
`workingText` back over it. The `finally` is load-bearing: without it, a failed commit would leave the
working file stuck holding content that was never actually staged as anything.

**Decisions survive an incidental refresh.** Clicking the panel's own ↻ (or `runPull`/`runCommit`
implicitly calling `refreshStatus`) recomputes `detectFieldChanges` from scratch; `refreshFieldReview`
(`gitStore.ts`) carries forward any decision whose row id is still present in the new result and
drops the rest — an accidental re-scan must never silently reset a reviewer's careful per-row choices,
but a row that stopped being a change (its id vanished) has nothing left to carry the decision about.

### Testing

`src/git/merge.test.ts` builds every fixture through the real `loadProject`, never a hand-assembled
`Project`, so base/ours/theirs are exactly as schema-normalized and empty-skeleton-shaped as
`mergeProjects`' actual caller hands it. It covers the field-level guarantee in both directions,
repeatable-node growth (colliding and non-colliding), the interior-gap and instance-removal
invariants, the multi-reviewer headline case (disjoint edits by two reviewers, zero conflicts), the
paper add/remove asymmetry, every refusal, the `aiUsage` union, the `Paper.equal` boolean-set merge,
the `abstract`/`abstractFromPdf` merge (including the documented resolve-order gap above),
`applyResolutions`, and a full round-trip through `serializeProject`/`loadProject`.
`src/git/changes.test.ts` covers `detectFieldChanges` (structural refusal, no changes, paper-metadata
diffing, the `abstract`/`abstractFromPdf` bundle including its no-primary-row fallback, annotation
tree fields including nested repeatable groups and per-reviewer trees, paper add/remove) and
`composeContents` (all three dispositions on a field, on an added paper, and on a removed paper —
including "discard restores a removed paper" — the bundle applying as one unit, and round-trip
stability). `src/state/gitStore.test.ts` covers `runPull`'s orchestration against a fake
`GitPlatform`: each pull classification, a refused merge (aborts and reports why), an unparseable
revision (aborts, writes nothing), and the dirty guard refusing to even call `beginPull` — plus
`refreshFieldReview`'s branches (untracked, unreadable, unparseable, structural, a genuine detected
change, decisions surviving and being dropped across a refresh), `setFieldDisposition`/
`setAllFieldDispositions`, and `runCommit`'s `commitPartial` branch (composed content, success with
its reload, and a failure surfacing the error without one).

**Serializer round-trip guard.** `src/state/editorStore.test.ts` includes a test that verifies `buildProjectJson` (the editor's serializer) and `serializeProject` (the core's) agree on every root field — if one writes a field the other silently drops, the test fails. This catches the class of bug where a field is lost depending on which path last saved, the same shape of bug that once dropped `abstract` in the merge layer.

### Rejected: streamed clone progress and a cancel button

`execFile` buffers the whole child process output; a live progress bar (git's own `--progress`
percentage lines) would need a second IPC channel, a subscription lifecycle, and parsing a
carriage-return-animated stderr stream — real work for a cosmetic improvement. Cancelling a clone
mid-flight would also leave a partial `.git` directory that would need cleaning up. A spinner plus an
elapsed-seconds counter already say "this has not frozen", which is the actual requirement, and the
network timeout (`GIT_NETWORK_TIMEOUT_MS`, 15 minutes) is the backstop against a clone that really
has hung.

### Why the merge dialog has no Escape

`GitMergeDialog` is the one modal in the app with no Escape, no backdrop-click, and no × in the
header — a deliberate deviation from the app's own modal pattern. The repository is genuinely
mid-merge for as long as it is open; dismissing it the ordinary way would leave the reviewer's
checkout in a state they cannot get out of without the command line, which is the one outcome a merge
UI must never produce. Only **Cancel merge** (`git merge --abort`) and **Finish merge** (disabled
until every row is decided) leave.

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
  - `pdf:pickFolder` — `dialog.showOpenDialog` with `properties: ['openDirectory']`, then a recursive `readdir` walk collecting every `.pdf` (a directory that can't be read is skipped, not fatal); returns absolute paths
  - `reference:pick` — `dialog.showOpenDialog` filtered to `.bib`/`.ris`/`.json`; returns `{ text, name }` for `src/model/references.ts` to parse, or null if cancelled
  - `pdf:read` — raw bytes of a PDF by absolute path, so the editor can read its title/authors. Deliberately *not* confined to the project directory (unlike `slr-file://`): the user may add PDFs from anywhere and picked them through a native dialog.
  - `paths:relative` — `path.relative(dirname(fromFile), to)` for each target, POSIX-separated. This is what makes a paper's `pdf` relative to the JSON, and what re-derives the paths when the JSON moves.
  - `paths:absolute` — the inverse of `paths:relative`: `path.resolve(dirname(fromFile), rel)` for each target. Backs `absolutePdfPaths`, used when importing papers from a screening project.
  - `paths:sibling` — `path.join(dirname(sourceFile), fileName)`. Backs `siblingProjectLocation`, the default save location for a new project started from screening results.
  - `app:setDirty` — the renderer reports its unsaved-changes state (drives the quit dialog)
  - `app:saveComplete` — the renderer reports the result of a save it was asked to run before quitting
  - `llm:configs` / `llm:saveConfig` / `llm:deleteConfig` — the LLM targets in `userData/llm-config.json`. The renderer is handed `publicConfigs()`: everything **except** the key, plus `hasKey`.
  - `llm:call` / `llm:abort` — send a renderer-built request with `net.fetch` after substituting the real key and checking the target origin against the config's `baseUrl` (see *AI-assisted annotation* above). `llm:abort` aborts an in-flight call by its `requestId`, since an `AbortSignal` cannot cross IPC.
  - `git:probe` — `git --version`; `{ available, version, error }`
  - `git:pickCloneDir` — `dialog.showOpenDialog` for the clone destination folder
  - `git:clone` — validates the URL/destination (`src/git/url.ts`), then `git clone -- <url> <dest>`
  - `git:pickProjectIn` — `dialog.showOpenDialog` with `defaultPath: dir`, the mechanism that opens the picker already inside a freshly cloned repository
  - `git:info` — `rev-parse --is-inside-work-tree` / `--show-toplevel` / `--show-prefix`, branch, upstream, whether `HEAD` exists
  - `git:identity` — `git config --get user.email` / `user.name`, run with the repository as cwd; an unset key comes back as `''`, never an error — see "Reviewer seat identity" above
  - `git:status` — raw `status --porcelain=v1 -z` + `diff --no-color HEAD --`, parsed on the renderer side (`src/git/output.ts`)
  - `git:headContent` / `git:workingContent` — the project file's text at `HEAD` (`git show HEAD:relPath`) and on disk (a plain, side-effect-free read); the two inputs `detectFieldChanges` compares for the commit panel's field-level review
  - `git:commitPartial` — the write → `add` + `commit` → write-back sequence field-level commit review needs, since git has no native partial-file staging primitive; see "Field-level commit review" above
  - `git:commit` — pathspec-limited `add` then `commit -m`
  - `git:push` — plain `git push`; a missing upstream surfaces git's own message rather than inventing `--set-upstream`
  - `git:pullBegin` / `git:pullFinish` / `git:pullAbort` — the pull classification and its two ways to conclude; see "Git" above for the full command sequence
  - `git:writeWorking` — writes `composeContents`'s `workingOut` directly to the working file, letting a reviewer discard local edits without committing (see "Field-level commit review" above)
- **Menu**: custom template with File, Edit, View, Window menus.
  - The **Edit** menu is hand-built: **Undo/Redo** send `app:undo` / `app:redo` to the renderer (routing to the store's history) rather than the native text-undo role, so undo works app-wide; cut/copy/paste/selectAll keep their native roles.
  - The **View** menu is hand-built (not the default `{ role: 'viewMenu' }`) and deliberately omits zoom roles so that `Ctrl +/-/0` reach the renderer for PDF zoom (and `Ctrl+Shift +/-/0` for app font scaling) instead of triggering native browser/Electron zoom.
- **Unsaved-changes quit flow**: a window `close` handler (`promptUnsavedChanges`) intercepts the close/quit when `isDirty` is set, and shows a native **Save / Don't Save / Cancel** dialog. "Save" asks the renderer to save (`app:requestSave`) and closes once it reports back; "Don't Save" closes discarding changes. A `before-quit` flag lets the guard resume `app.quit()` after confirmation (so Cmd+Q fully quits on macOS, where destroying the window alone would not).

**`electron/preload.ts`** uses `contextBridge.exposeInMainWorld('slr', ...)` to expose IPC-backed methods: `openProject`, `openPath` (read file by absolute path), `saveProject`, `saveProjectAs`, `setProjectDir`, plus the quit/menu coordination — `setDirty`, `onRequestSave`, `saveComplete`, `onUndo`, `onRedo` — and the sixteen `git*` methods (`gitProbe`, `gitPickCloneDir`, `gitClone`, `gitPickProjectIn`, `gitInfo`, `gitIdentity`, `gitStatus`, `gitHeadContent`, `gitWorkingContent`, `gitCommitPartial`, `gitCommit`, `gitPush`, `gitPullBegin`, `gitPullFinish`, `gitPullAbort`, `gitWriteWorking`) mirroring the `git:*` IPC handlers one for one. This `window.slr` object is the detection signal for `isElectron()`.

## Hooks

- **`useKeybindings`** (`src/hooks/useKeybindings.ts`): Global keyboard shortcuts registered on `window.keydown`. Handles open (Ctrl/Cmd+O), save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), paper navigation (Alt+↓/↑, `[`/`]`), zoom/font (Ctrl/Cmd + `+/=/-`/`0` → PDF zoom; add Shift → app font size), and help (F1). Paper navigation skips when typing in a field (unless Alt is held). Zoom/font detection matches `e.key` and `e.code` to handle numpad and international layouts; reset is detected by the digit-0 `e.code` (Shift-independent) to avoid the German Shift+0 → `=` clash. Copy/cut/paste/undo are left to the browser/Electron Edit menu.

- **`useDirtyGuard`** (`src/hooks/useDirtyGuard.ts`): **Browser only.** Registers a `beforeunload` listener that calls `e.preventDefault()` when either the project *or* the editor's draft is dirty, triggering the browser's "unsaved changes" confirmation. Both, for the same reason `useElectronCloseGuard`'s `isDirty()` checks both: an unsaved schema draft is no less lost on a tab close than an unsaved annotation, and while the editor is open it is the only thing on screen. It is skipped under Electron (`isElectron()`), because a `beforeunload` that returns a value there silently cancels the quit with no dialog — Electron handles unsaved changes via a native dialog in the main process instead (see `useElectronCloseGuard` and the quit flow below).

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
- **Adding a new LLM provider**: Add it to `Provider` in `src/llm/types.ts` and to `PROVIDERS` in `src/llm/providers.ts` (base URL, whether it is editable, whether it can take a PDF, `tokenParam`), then handle its request shape in `buildRequest` and its response shape in `extractText` / `extractError`. Also add a branch to `buildModelsRequest` / `parseModelsResponse` in `src/llm/models.ts` — its list-models endpoint, auth, and pagination scheme are almost never identical to another provider's chat endpoint even when the chat shape is "OpenAI-compatible" (Mistral's `/v1/models` returns a bare array, not `{data:[...]}`; OpenRouter paginates, Groq doesn't). Decide reasoning-effort support last, and only from what you can confirm — a model-ID pattern if the provider's own docs name specific models, or nothing at all (`null`) if you can't confirm the field/values, per the DeepSeek/`openai-compatible` precedent above. Nothing else needs to change — `PROVIDER_LIST` drives the settings dropdown and the "which providers can take a PDF" hint automatically, so the platform and UI layers are provider-agnostic.

  **Verify against the provider's own current docs before writing `buildRequest`, not against another provider's shape.** The bug that made `tokenParam` a field in the first place: this app originally sent `max_tokens` to every OpenAI-shaped provider, and OpenAI's *own* API now rejects that on current models — `"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."` xAI and Groq have followed the same rename (both have reasoning-model variants, which is what drove OpenAI's original change); OpenRouter, Mistral, DeepSeek and generic self-hosted OpenAI-compatible servers still document `max_tokens` and do not confirm the newer name. Four vendors that all claim "OpenAI-compatible" disagreed on one required parameter — assume the same is possible for endpoint paths, PDF support, auth header names, list-models shapes, and reasoning-effort contracts, and check each freshly. `supportsPdf` in particular is not "does the vendor support PDFs at all" but "can a **single request** carry the bytes inline the way this app's `PaperPart` does" — Mistral's PDF support needs a fetchable URL (no inline-base64 form in chat completions), and xAI's needs an upload-then-reference flow across two requests, so both are `false` here despite the vendor supporting PDFs some other way.
- **Changing the schema format**: it is described to the model in `SCHEMA_FORMAT_DOC` (`src/llm/prompt.ts`), which mirrors `docs/annotation-schema.md` §3 by hand. Both must move together, or the model reads an unfamiliar schema against a stale description.
- **Adding a new keyboard shortcut**: Add to `useKeybindings.ts`. Check `isEditable()` if it should be ignored inside input fields.
- **Changing the Electron IPC surface**: Update `preload.ts` (the `SlrBridge` interface), `electron/main.ts` (IPC handler), and `src/platform/electron.ts` (adapter method). All three must stay in sync.
- **Adding a git operation**: add the new operation as an *enumerated* handler in `electron/main.ts`
  (never widen the renderer's power to name an argv — see "The renderer never names an argv" above),
  the matching bridge method in `preload.ts`, the method on `GitPlatform` in `src/git/types.ts`, and
  the pass-through in `ElectronAdapter`'s `git` object (`src/platform/electron.ts`) — a `private
  readonly` field, not a fresh object literal per `getGit()` call, since `getPlatform()` is a
  singleton and a new object every call would make every `useGitStore` selector see a "different"
  platform and churn. Keep the *decision* (what the operation does, what it validates) in `src/git/`
  where it is unit-testable; keep the *argv* in `electron/main.ts` where it is enforced.
- **Adding a new settings/appearance option**: Add to `src/state/settings.ts` (load/apply functions), add state + actions to the store, add UI controls to `Toolbar.tsx`, and add keybindings if needed.
- **Touching anything that reads or writes the current paper's annotation data**: route it through `currentTree()` (`src/state/store.ts`) rather than `paper.annotations` directly, or it will silently ignore reviewer selection on a multi-reviewer project. Grep for `.annotations` across `src/` and check each hit against "should this see the active reviewer's tree or always the consolidated one". The direct reads that remain outside `src/model/` are deliberate: `currentTree()`'s own body; `ConsolidationDialog`, which reads the consolidated tree *on purpose* (it is showing you what the final answer currently is); `editorStore`, which edits the file's papers and has no reviewer concept; and null-project fallbacks.
- **Reading a screening project's schema**: always go through `loadProject`/`Project.schema`, never the raw file. `config.screening.reasons` is the single source of truth; `config.schema` in the on-disk JSON is a *projection* of it that `loadProject` ignores and `serializeProject` rewrites on every save (see *Screening* above). A tool that reads the raw JSON's `config.schema` directly (rather than through this app) will see the derived snapshot from whenever the file was last saved, not something it can trust to reflect a hand-edited `reasons` list until the file is re-saved.
