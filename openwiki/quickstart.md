---
type: guide
title: SaiLoR Quickstart
description: Introduction to SaiLoR, a tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the full tech stack (React 19, Electron, Vite, Zustand, Zod), why SaiLoR is now Electron-desktop-only, quick-start commands, and the repository layout.
tags: [quickstart, setup, tech-stack, commands, electron-only]
---

# SaiLoR — Quickstart

## What is SaiLoR?

SaiLoR is a tool for reviewers conducting **Systematic Literature Reviews (SLRs)** — the letters are in the name: **S**ai**L**o**R**. You open a "project" — a `project.json` file plus a sibling `annotations/` folder — that together hold:

1. **An annotation schema** — a nested, cardinality-controlled taxonomy defining what fields to extract from each paper, stored in `project.json`.
2. **A list of papers** — each with a PDF path and metadata, also in `project.json`.
3. **Every reviewer's/consolidation's annotation data** — the actual filled-in answers, stored separately under `annotations/<paperId>/` (see "On-disk layout" below and [Data Model](data-model.md)).

The app renders the PDF in the middle pane, shows the annotation form on the right, and lets you **grab text directly from the PDF** to populate fields. Annotations are saved back to the split files described above.

A project can also be set to **screening** mode instead of authoring a schema: one fast
Include/Exclude decision per paper (plus a reason when excluded), usually made from the title and
abstract before annotation even begins. See the "Screening" sections of
[Architecture](architecture.md) and [Data Model](data-model.md).

### On-disk layout

```
my-review/
├── project.json          Schema, protocol, screening config, and paper METADATA only —
│                          no annotation data
└── annotations/
    └── <paperId>/
        ├── consolidated.json   The single/consolidated annotation tree, plus aiUsage + equal
        └── reviewer-<n>.json   Each independent reviewer's own tree (multi-reviewer only)
```

A **screening** project names these `screening-consolidated.json` / `screening-<n>.json` instead —
same layout, distinguishable at a glance from an annotation project's files.

Per-paper, per-reviewer files are created lazily — only once that reviewer has actually written
something for that paper — and deleted again if the tree becomes empty. This exists because a
single all-in-one JSON file used to make two reviewers working on different papers (or different
reviewer slots of the same paper) collide in git on every save; splitting the data means ordinary
git tracks, diffs, and merges each paper/reviewer's file independently. **A project saved in the
old single-file shape opens and continues to work as before — it is migrated to the split layout
automatically on the next save, with no explicit "migrate" step.** See [Data Model](data-model.md)
for the full shape and migration mechanics.

## SaiLoR is Electron-desktop-only

**The browser/web build has been discontinued.** SaiLoR used to also ship as a static web SPA
(File System Access API or download fallback) and as a Docker self-hosted deployment. Both are
gone as real ways to use the app: the web build still technically compiles (kept only so the
CI/typecheck pipeline and Vite build still pass), but at runtime it shows a "SaiLoR for the web has
been discontinued — use the desktop app" message and blocks all project-opening UI before any file
picker or project state can be reached (`src/App.tsx`'s `isElectron()` gate). Docker self-hosting
serves that same static build, so it no longer does anything useful either. See
[Architecture](architecture.md) and [Operations](operations.md) for what this removed
(`src/platform/browser.ts`, `src/platform/idb.ts`, the `?project=<url>` loader) and why.

The **desktop app (Electron)** — local files, native Open/Save dialogs, custom `slr-file://`
protocol for PDF loading, and full git integration — is the only supported way to use SaiLoR now.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| State management | Zustand + immer middleware |
| Validation | Zod |
| PDF rendering | react-pdf (pdf.js) |
| Desktop shell | Electron 43 |
| Build tool | Vite 6 (with vite-plugin-electron) |
| Testing | Vitest 3 + jsdom |

## Quick Commands

```bash
npm install

# Electron dev (desktop) — the only usable way to run the app for real review work:
npm run dev:electron

# Web dev server — NOT a usable deployment: it renders the discontinuation
# screen and nothing else. Useful only if you're iterating on that screen
# itself or on code shared with the Electron renderer.
npm run dev
# → http://localhost:5173

# Build static SPA into dist/ (kept only for CI/typecheck; not a supported deployment):
npm run build

# Build desktop installers into release/:
npm run build:electron

# Unit tests (model: schema, normalize, prune, round-trip):
npm test

# Type check only:
npm run typecheck
```

## Repository Layout

```
├── electron/              Electron main process + preload
│   ├── main.ts            IPC handlers (open, openPath, save, saveAs, setDir, llm:*, git:* incl. mergeBegin/logBegin/logDiff/discardFile/branchDelete/lastCommitMessage, native update:* incl. Ed25519 feed-signature verification), slr-file:// protocol, window/menu setup, window-state persistence, sandbox: true
│   └── preload.ts         contextBridge → window.slr API (openProject, openPath, save, saveAs, git*, …)
├── src/
│   ├── model/              Domain model (pure, unit-tested)
│   │   ├── schema.ts      AnnotationDef/ResolvedDef types, zod schemas, resolveSchema
│   │   ├── annotations.ts AnnotationValueTree, normalize/prune/init/add/remove helpers
│   │   ├── project.ts     loadProject / serializeProject / splitProjectFiles / isLegacyProjectShape, Paper/Project types, deepEqualJson
│   │   ├── annotationState.ts  5-state annotation vocabulary (untouched/partial/complete/finished/flagged), filter buckets, completenessApplies (project-only gate), finishCheckboxLabel (seat-aware checkbox name)
│   │   ├── alignment.ts   StoredAlignment — persisted consolidation entry-matching mapping, alignedReviews projection
│   │   ├── refPreview.ts  detectEntryBox — SumatraPDF-style fit of a hover-preview crop to the destination's own entry (pure, unit-tested)
│   │   ├── pdfMarks.ts    PdfMark type, sortMarksForCycling (column-then-y), cross-page groupId deduplication
│   │   ├── pdfExport.ts   Pure coordinate math for burning marks into real PDF annotations
│   │   ├── pdfMeta.ts     Best-effort title/author/abstract extraction from a PDF (metadata, then layout heuristic)
│   │   ├── validate.ts    Checks annotated papers (required / type / enum / cardinality); unannotated papers are skipped, not flagged
│   │   ├── linkify.ts     Splits free text into plain-text and URL segments for rendering clickable links in descriptions
│   │   ├── version.ts     Update check against the GitHub releases API (silent while the repo is private); the win/linux in-app self-updater (electron-updater) hangs off this check. Also `NEW_ISSUE_URL`, where the Help dialog's and start screen's "Report a bug" links open
│   │   ├── updateSignature.ts  Ed25519 verification of the electron-updater feed (`latest.yml`/`latest-linux.yml`) before a native update is downloaded — the release workflow signs each feed with `scripts/sign-release.cjs`; imported by `electron/main.ts`
│   │   └── model.test.ts  Vitest unit tests for the model
│   ├── screening/          Screening mode: derived schema, pure logic (unit-tested)
│   │   ├── schema.ts      The derived two-node (Decision/Reason) schema; isScreening()
│   │   ├── status.ts      screeningStatus/screeningReason — the tri-state read of a decision tree
│   │   ├── counts.ts      screeningCounts (PRISMA-style totals + per-reason breakdown), pendingUnanimous
│   │   └── validate.ts    screeningIssues — the two cross-field validation rules screening needs
│   ├── git/                Git support — pure logic; the plumbing (electron/main.ts) and UI stay thin
│   │   ├── types.ts       Shared shapes crossing the platform seam: GitRun, GitStatus, PullStart/MergeStart, GitBranch (with `remote`), CommitRecord, GitPlatform, …
│   │   ├── url.ts         validateGitUrl / validateClonePath / repoNameFromUrl — the security gate, imported by electron/main.ts
│   │   ├── output.ts      parsePorcelain / parseGitLog / capDiff / gitErrorText — turning what git printed into data
│   │   ├── ref.ts         refProblem / isSafeRef — the security gate for ref names handed to git (a branch to merge, a revision to diff), imported by electron/main.ts
│   │   ├── relpath.ts     relPathProblem / isSafeRelPath / annotationsRelDir — the security gate for paths written under a project's annotations/ folder
│   │   ├── ownAnnotationPath.ts  ownAnnotationPathMatcher — does a path under annotations/ belong to *this* project or a sibling sharing the folder? (pure, unit-tested; imported by electron/main.ts for branch-switch/merge/Save-As guards)
│   │   ├── concurrentRead.ts  readAllConcurrently — concurrent one-per-id reads preserving id→result mapping (extracted from readProjectText for testability; used by readProjectText, readProjectAtRevision)
│   │   ├── deriveGitInfo.ts   deriveGitInfo — maps git:info's five concurrent git calls to their fields (extracted for testability)
│   │   └── merge.ts       mergeProjects / applyResolutions — the field-level three-way merge (see architecture.md's "Git" section)
│   ├── platform/          Platform abstraction for file I/O, PDF loading, and git — Electron only now, see "SaiLoR is Electron-desktop-only" above
│   │   ├── adapter.ts     PlatformAdapter interface + isElectron()
│   │   ├── electron.ts    ElectronAdapter (IPC + slr-file://, recents, git incl. merge/log/discard-file/branch-delete, splits project text into project.json + annotations/ files on save)
│   │   ├── unsupported.ts UnsupportedAdapter — stands in for the platform outside Electron; every read answers "nothing", every action throws (a backstop — `App.tsx` blocks all project-opening UI before any of this is reachable)
│   │   ├── pdfjs.ts       Single place configuring the pdf.js worker (viewer + extractor)
│   │   ├── recents.ts     Recent-projects list in localStorage (max 5)
│   │   └── index.ts       getPlatform() singleton (ElectronAdapter or UnsupportedAdapter)
│   ├── state/
│   │   ├── store.ts      Zustand + immer store (project, papers, save, annotations, undo/redo incl. PDF marks, theme, fontScale, pdfZoom, recents, reading position, help, native self-update progress on win/linux)
│   │   ├── store.readingPosition.test.ts  "Continue where you left off" — reopening a project lands on the same paper and PDF page
│   │   ├── store.marks.test.ts  PDF mark mutations (addHighlight/setMarkComment/setMarkColor/removeMark) and their undo steps
│   │   ├── editorStore.ts  Draft state for the project editor (schema tree + papers, relative PDF paths, validate/save)
│   │   ├── gitStore.ts    Zustand + immer store for the clone flow, the commit/pull/push panel, the merge-branch/delete-branch prompts, the commit-history panel, and whole-file discard (reads store.ts one-way; store.ts never imports it)
│   │   └── settings.ts   Theme + font-scale persistence (localStorage), applyTheme/applyFontScale
│   ├── components/        React UI
│   │   ├── Toolbar.tsx    Open ▾ / Save ▾ dropdowns, font controls, theme toggle, help button, Git button
│   │   ├── SidebarToggle.tsx  Show/hide the paper list (in its header; moves to the toolbar when hidden)
│   │   ├── Dropdown.tsx   Reusable click-to-open dropdown menu
│   │   ├── PaperList.tsx  Left pane — paper list with search box and annotation status dots
│   │   ├── Splitter.tsx   Drag handles between the three panes (widths persisted)
│   │   ├── PdfViewer.tsx  Middle pane — react-pdf, zoom controls, multi-page navigation, jump history (back/forward), in-PDF search (Ctrl+F, debounced), text selection capture, internal-link hover previews (destination entry fit), dedupe of overlapping highlight rects
│   │   ├── AnnotationPanel.tsx  Right pane — renders schema recursively
│   │   ├── AnnotationNode.tsx   Recursive node (fields, groups, repeatable instances)
│   │   ├── NodeName.tsx   Node label with ⓘ description tooltip (portaled); Ctrl/Cmd-click opens a single-link description directly
│   │   ├── Field.tsx      Input control (text/number/checkbox/enum dropdown) + "grab from PDF" button + 🔗 field-link popover
│   │   ├── ComboBox.tsx   Filterable dropdown for enum (options) string fields, with clear (×) button
│   │   ├── ExportPdfDialog.tsx  Modal — burn in-app marks into real PDF annotations (new file or overwrite)
│   │   ├── SchemaInfoDialog.tsx  Modal — shows the schema-wide info comment (auto-opens on first load)
│   │   ├── ScreeningRecord.tsx  Middle pane for a screening project — title/authors/DOI + abstract, swaps to PdfViewer
│   │   ├── ScreeningPanel.tsx   Right pane for a screening project — Include/Exclude + Reason, progress
│   │   ├── ScreeningSummary.tsx Modal — PRISMA-style include/exclude/reason counts
│   │   ├── ScreeningImportDialog.tsx  Modal — pre-commit summary for importing from a screening project
│   │   ├── ProjectEditor.tsx    Create/edit a project JSON (location bar + schema/screening + papers)
│   │   ├── SchemaTreeEditor.tsx Drag-and-drop annotation-schema builder (reorder + nest)
│   │   ├── ScreeningReasonsEditor.tsx  Replaces SchemaTreeEditor when the draft is a screening project
│   │   ├── PapersEditor.tsx     Add/edit/reorder the PDFs (and abstracts) the project references
│   │   ├── ConsolidationOverview.tsx Project-wide modal for Consolidation batch actions (disagreement list, Adopt all unanimous, opens Agreement/disagreements)
│   │   ├── ConsolidationVerdicts.ts Per-field agree/disagree status via React Context (consumed by Field.tsx)
│   │   ├── ConsolidationDialog.tsx Modal: every reviewer's answer for one field; resolve, defer, or enter a different value
│   │   ├── ClosePrompt.tsx      Save / Don't Save / Cancel when closing a dirty project
│   │   ├── GitCloneDialog.tsx   Import-from-git modal: URL + destination → clone → pick the project JSON
│   │   ├── GitDialog.tsx        Commit message (with Amend checkbox), Commit/Pull/Push (above the changes list), branch switcher, Merge branch… and History… header buttons
│   │   ├── GitMergeDialog.tsx   Pull's, merge-branch's, and branch-switch's conflict-resolution list
│   │   ├── MergeBranchPrompt.tsx  "Merge branch…" button's own small prompt — pick a branch, see the direction spelled out
│   │   ├── DeleteBranchPrompt.tsx  "- Delete branch…" entry's own dialog — pick a local branch to delete
│   │   ├── GitHistoryDialog.tsx  "History…" button's read-only commit-history panel, with lazy per-commit field diffs
│   │   ├── HelpDialog.tsx Modal with app intro + keyboard shortcuts (mode-aware, incl. screening)
│   │   └── ErrorPanel.tsx Error overlay for load/save failures
│   ├── hooks/
│   │   ├── useKeybindings.ts       Open, save, save-as, undo/redo, paper nav (filtered list order), PDF zoom / font size, help
│   │   ├── useAutosave.ts          Periodic 5-min autosave (opt-in, skipped while editor is open)
│   │   ├── useExportTextMenu.ts    Reusable "Copy to clipboard" / "Save to file…" dropdown for text exports
│   │   ├── useDirtyGuard.ts        beforeunload guard when dirty (dead code in practice — `isElectron()` gates it out; kept only because it is cheap to keep and Electron's own quit dialog covers the same case)
│   │   └── useElectronCloseGuard.ts  Electron quit dialog + Edit-menu undo/redo IPC wiring
│   ├── clipboard.ts       copyText — clipboard write with legacy fallback, never throws
│   ├── App.tsx            Component composition; `isElectron()` gate shows the web-discontinued notice and blocks all project-opening UI otherwise; welcome screen with recents, HelpDialog
│   ├── main.tsx           React root (applies theme + font scale before render)
│   └── styles/            index.css (full app styling), ai.css, editor.css, papers-editor.css, schema-editor.css, git.css
├── samples/               Single-file example projects (auto-migrate to the split layout on first save)
│   ├── project.example.json  Example project (title, 4 papers incl. a multi-page PDF) + schema with required and enum fields
│   ├── screening.example.json  Example screening project (same 4 papers + 3 abstract-only, all decision states)
│   └── pdfs/                 Sample PDFs (incl. multipage.pdf with an internal link, A1-37.pdf for two-column author parsing)
├── scripts/ci.sh          Provider-agnostic CI pipeline (install → typecheck → test → build)
├── scripts/build-electron.sh  Provider-agnostic desktop build (electron-builder for the host OS)
├── .github/workflows/ci.yml       GitHub Actions — runs scripts/ci.sh on push to main and on every pull request
├── .github/workflows/release.yml  GitHub Actions — builds desktop installers on release, attaches them
├── .github/workflows/openwiki.yml Scheduled weekly OpenWiki doc refresh (only when code changed)
├── .github/workflows/openwiki-update.yml  Triggered OpenWiki doc update on push to main
├── .github/CODEOWNERS     Default reviewers for pull requests
├── docs/                  In-depth authoring guide (annotation-schema.md)
├── public/logo.svg        App logo — source of truth; also shown on the welcome screen
├── build/icon.png         Generated from public/logo.svg (dock / packaged-bundle icon)
├── public/favicon.svg     Browser favicon (separate, hand-simplified for 16px tabs)
├── Dockerfile.electron    Debian image that runs electron-builder — Linux installers into ./release/
├── docker-compose.dev.yml Builds the Dockerfile.electron image (`docker compose -f docker-compose.dev.yml run --rm electron`)
├── vite.config.ts         Vite + vitest + electron plugin config
├── tsconfig*.json         TypeScript project references (app / node)
└── package.json           Scripts, deps, electron-builder config
```

## Where to Go Next

- [Architecture](architecture.md) — platform adapter pattern, state management (incl. undoable PDF marks, reading-position persistence), component tree, PDF internal-link hover previews, Electron integration
- [Data Model](data-model.md) — project file format, schema resolution, annotation tree lifecycle (load → normalize → edit → prune → serialize), Consolidation finished flag
- [Operations](operations.md) — build, test, deployment, keyboard shortcuts, change guidance
