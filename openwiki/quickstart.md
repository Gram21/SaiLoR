# SLR Helper — Quickstart

## What is SLR Helper?

SLR Helper is a tool for reviewers conducting **Systematic Literature Reviews (SLRs)**. You open a single JSON "project" file that bundles two things:

1. **An annotation schema** — a nested, cardinality-controlled taxonomy defining what fields to extract from each paper.
2. **A list of papers** — each with a PDF path and an annotation tree that gets filled in as you review.

The app renders the PDF in the middle pane, shows the annotation form on the right, and lets you **grab text directly from the PDF** to populate fields. Annotations are saved back into the same JSON file.

The codebase runs two ways from a single source:
- **Desktop app** (Electron) — local files, native Open/Save dialogs, custom `slr-file://` protocol for PDF loading.
- **Web app** — a static SPA build that can be hosted anywhere; uses the File System Access API (Chromium) or download fallback.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| State management | Zustand + immer middleware |
| Validation | Zod |
| PDF rendering | react-pdf (pdf.js) |
| Desktop shell | Electron 33 |
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

# Unit tests (model: schema, normalize, prune, round-trip):
npm test

# Type check only:
npm run typecheck
```

## Repository Layout

```
├── electron/              Electron main process + preload
│   ├── main.ts            IPC handlers, slr-file:// protocol, window/menu setup
│   └── preload.ts         contextBridge → window.slr API
├── src/
│   ├── model/              Domain model (pure, unit-tested)
│   │   ├── schema.ts      AnnotationDef/ResolvedDef types, zod schemas, resolveSchema
│   │   ├── annotations.ts AnnotationValueTree, normalize/prune/init/add/remove helpers
│   │   ├── project.ts     loadProject / serializeProject, Paper/Project types
│   │   └── model.test.ts  Vitest unit tests for the model
│   ├── platform/          Platform abstraction for file I/O and PDF loading
│   │   ├── adapter.ts     PlatformAdapter interface + isElectron()
│   │   ├── electron.ts    ElectronAdapter (IPC + slr-file://)
│   │   ├── browser.ts     BrowserAdapter (FSAPI / download / fetch)
│   │   └── index.ts       getPlatform() singleton
│   ├── state/
│   │   └── store.ts      Zustand + immer store (project, papers, save, annotations)
│   ├── components/        React UI
│   │   ├── Toolbar.tsx    Open/Save/Save-as, sidebar toggle, dirty indicator
│   │   ├── PaperList.tsx  Left pane — paper list with annotation status dots
│   │   ├── PdfViewer.tsx  Middle pane — react-pdf, text selection capture
│   │   ├── AnnotationPanel.tsx  Right pane — renders schema recursively
│   │   ├── AnnotationNode.tsx   Recursive node (fields, groups, repeatable instances)
│   │   ├── Field.tsx      Input control + "grab from PDF" button
│   │   └── ErrorPanel.tsx Error overlay for load/save failures
│   ├── hooks/
│   │   ├── useKeybindings.ts  Save, save-as, paper navigation shortcuts
│   │   └── useDirtyGuard.ts   beforeunload guard when dirty
│   ├── App.tsx            Component composition, ?project= auto-load
│   ├── main.tsx           React root
│   └── styles/index.css   Full app styling (light/dark via prefers-color-scheme)
├── samples/
│   ├── project.example.json  Example project with 2 papers + schema
│   └── pdfs/                 Sample PDFs
├── vite.config.ts         Vite + vitest + electron plugin config
├── tsconfig*.json         TypeScript project references (app / node)
└── package.json           Scripts, deps, electron-builder config
```

## Where to Go Next

- [Architecture](architecture.md) — platform adapter pattern, state management, component tree, Electron integration
- [Data Model](data-model.md) — project file format, schema resolution, annotation tree lifecycle (load → normalize → edit → prune → serialize)
- [Operations](operations.md) — build, test, deployment, keyboard shortcuts, change guidance
