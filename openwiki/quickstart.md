# SaiLoR — Quickstart

## What is SaiLoR?

SaiLoR is a tool for reviewers conducting **Systematic Literature Reviews (SLRs)** — the letters are in the name: **S**ai**L**o**R**. You open a single JSON "project" file that bundles two things:

1. **An annotation schema** — a nested, cardinality-controlled taxonomy defining what fields to extract from each paper.
2. **A list of papers** — each with a PDF path and an annotation tree that gets filled in as you review.

The app renders the PDF in the middle pane, shows the annotation form on the right, and lets you **grab text directly from the PDF** to populate fields. Annotations are saved back into the same JSON file.

The codebase runs three ways from a single source:
- **Desktop app** (Electron) — local files, native Open/Save dialogs, custom `slr-file://` protocol for PDF loading.
- **Web app** — a static SPA build that can be hosted anywhere; uses the File System Access API (Chromium) or download fallback.
- **Docker** — multi-stage build (Node → nginx) with a read-only volume of project files (the bundled `samples/` by default) served under `/projects/`; `docker compose up -d --build` serves on port 8080.

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

# Web dev (browser):
npm run dev
# → http://localhost:5173
# Open the bundled example: http://localhost:5173/?project=/samples/project.example.json

# Electron dev (desktop):
npm run dev:electron

# Build static SPA into dist/:
npm run build

# Build desktop installers into release/:
npm run build:electron

# Docker (self-hosting — serves on http://localhost:8080):
docker compose up -d --build

# Unit tests (model: schema, normalize, prune, round-trip):
npm test

# Type check only:
npm run typecheck
```

## Repository Layout

```
├── electron/              Electron main process + preload
│   ├── main.ts            IPC handlers (open, openPath, save, saveAs, setDir), slr-file:// protocol, window/menu setup, window-state persistence
│   └── preload.ts         contextBridge → window.slr API (openProject, openPath, save, saveAs, …)
├── src/
│   ├── model/              Domain model (pure, unit-tested)
│   │   ├── schema.ts      AnnotationDef/ResolvedDef types, zod schemas, resolveSchema
│   │   ├── annotations.ts AnnotationValueTree, normalize/prune/init/add/remove helpers
│   │   ├── project.ts     loadProject / serializeProject, Paper/Project types
│   │   ├── pdfMeta.ts     Best-effort title/author extraction from a PDF (metadata, then layout heuristic)
│   │   ├── validate.ts    Checks a reviewer's annotations (required / type / enum / cardinality)
│   │   ├── version.ts     Update check against the GitHub releases API (silent while the repo is private)
│   │   └── model.test.ts  Vitest unit tests for the model
│   ├── platform/          Platform abstraction for file I/O and PDF loading
│   │   ├── adapter.ts     PlatformAdapter interface (9 ops) + isElectron()
│   │   ├── electron.ts    ElectronAdapter (IPC + slr-file://, recents)
│   │   ├── browser.ts     BrowserAdapter (FSAPI / download / fetch, recents, IndexedDB handles)
│   │   ├── pdfjs.ts       Single place configuring the pdf.js worker (viewer + extractor)
│   │   ├── idb.ts         Tiny IndexedDB wrapper for persisting FileSystemFileHandle objects
│   │   ├── recents.ts     Recent-projects list in localStorage (max 5)
│   │   └── index.ts       getPlatform() singleton
│   ├── state/
│   │   ├── store.ts      Zustand + immer store (project, papers, save, annotations, undo/redo, theme, fontScale, pdfZoom, recents, help)
│   │   ├── editorStore.ts  Draft state for the project editor (schema tree + papers, relative PDF paths, validate/save)
│   │   └── settings.ts   Theme + font-scale persistence (localStorage), applyTheme/applyFontScale
│   ├── components/        React UI
│   │   ├── Toolbar.tsx    Open ▾ / Save ▾ dropdowns, font controls, theme toggle, help button
│   │   ├── SidebarToggle.tsx  Show/hide the paper list (in its header; moves to the toolbar when hidden)
│   │   ├── Dropdown.tsx   Reusable click-to-open dropdown menu
│   │   ├── PaperList.tsx  Left pane — paper list with search box and annotation status dots
│   │   ├── Splitter.tsx   Drag handles between the three panes (widths persisted)
│   │   ├── PdfViewer.tsx  Middle pane — react-pdf, zoom controls, multi-page navigation, jump history (back/forward), in-PDF search (Ctrl+F), text selection capture
│   │   ├── AnnotationPanel.tsx  Right pane — renders schema recursively
│   │   ├── AnnotationNode.tsx   Recursive node (fields, groups, repeatable instances)
│   │   ├── NodeName.tsx   Node label with ⓘ description tooltip (portaled)
│   │   ├── Field.tsx      Input control (text/number/checkbox/enum dropdown) + "grab from PDF" button
│   │   ├── ComboBox.tsx   Filterable dropdown for enum (options) string fields
│   │   ├── ProjectEditor.tsx    Create/edit a project JSON (location bar + schema + papers)
│   │   ├── SchemaTreeEditor.tsx Drag-and-drop annotation-schema builder (reorder + nest)
│   │   ├── PapersEditor.tsx     Add/edit/reorder the PDFs the project references
│   │   ├── ValidationDialog.tsx  "Validate" results, grouped by paper
│   │   ├── ClosePrompt.tsx      Save / Don't Save / Cancel when closing a dirty project
│   │   ├── HelpDialog.tsx Modal with app intro + keyboard shortcuts
│   │   └── ErrorPanel.tsx Error overlay for load/save failures
│   ├── hooks/
│   │   ├── useKeybindings.ts       Open, save, save-as, undo/redo, paper nav, PDF zoom / font size, help
│   │   ├── useDirtyGuard.ts        beforeunload guard when dirty (browser only)
│   │   └── useElectronCloseGuard.ts  Electron quit dialog + Edit-menu undo/redo IPC wiring
│   ├── App.tsx            Component composition, ?project= auto-load, welcome screen with recents, HelpDialog
│   ├── main.tsx           React root (applies theme + font scale before render)
│   └── styles/index.css   Full app styling (light/dark via data-theme attribute, font-scale CSS var)
├── samples/               Also the default Docker volume (mounted read-only, served at /projects/)
│   ├── project.example.json  Example project (title, 4 papers incl. a multi-page PDF) + schema with required and enum fields
│   └── pdfs/                 Sample PDFs (incl. multipage.pdf with an internal link)
├── scripts/ci.sh          Provider-agnostic CI pipeline (install → typecheck → test → build)
├── scripts/build-electron.sh  Provider-agnostic desktop build (electron-builder for the host OS)
├── .github/workflows/ci.yml       GitHub Actions — runs scripts/ci.sh on push to main and on every pull request
├── .github/workflows/release.yml  GitHub Actions — builds desktop installers on release, attaches them
├── .github/workflows/openwiki.yml Scheduled weekly OpenWiki doc refresh (only when code changed)
├── .github/CODEOWNERS     Default reviewers for pull requests
├── docs/                  In-depth authoring guide (annotation-schema.md)
├── build/icon.png         App icon (also the macOS dock / packaged-bundle icon)
├── public/favicon.svg     Browser favicon
├── Dockerfile             Production: multi-stage Node build → nginx runtime
├── docker-compose.yml     Production: builds and serves on port 8080 with ./samples mounted
├── nginx.conf             MIME fix for .mjs, /assets/ caching, /projects/ serving, SPA fallback
├── Dockerfile.dev         Dev image: Vite dev server (browser)
├── Dockerfile.electron    Dev image: electron-builder (Linux AppImage)
├── docker-compose.dev.yml Dev stack — `browser` / `electron` Compose profiles
├── vite.config.ts         Vite + vitest + electron plugin config
├── tsconfig*.json         TypeScript project references (app / node)
└── package.json           Scripts, deps, electron-builder config
```

## Where to Go Next

- [Architecture](architecture.md) — platform adapter pattern, state management, component tree, Electron integration
- [Data Model](data-model.md) — project file format, schema resolution, annotation tree lifecycle (load → normalize → edit → prune → serialize)
- [Operations](operations.md) — build, test, deployment, keyboard shortcuts, change guidance
