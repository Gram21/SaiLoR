---
type: guide
title: SaiLoR Quickstart
description: Introduction to SaiLoR, an Electron-desktop-only tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the full tech stack (React 19, Electron 43, Vite 6, Zustand+immer, Zod, react-pdf), quick-start commands, the repository layout, and a task-routing map to the right wiki page for common change areas.
tags: [quickstart, setup, tech-stack, commands, electron-only, task-routing]
verified:
  - by: openwiki/0.5.0
    at: 2026-09-01T19:42:14.192Z
sources:
  - id: openwiki-source-4d1d392666be6dfdd7a91a2e
    resource: repo://.github/workflows/release.yml
  - id: openwiki-source-5c59216b8218fe8745f9ce38
    resource: repo://e2e/openSaveProject.spec.ts
  - id: openwiki-source-8d6b6eb5e58f91e157e37bde
    resource: repo://electron/main.ts
  - id: openwiki-source-4934747c1d2001daf65dee21
    resource: repo://electron/preload.ts
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-ebc09c37829da6e456c89f67
    resource: repo://scripts/build-electron.sh
  - id: openwiki-source-0744bbc5adcd6bd563690bde
    resource: repo://scripts/ci.sh
  - id: openwiki-source-1d3476a6e83c1e73809d1a15
    resource: repo://scripts/sign-release.cjs
  - id: openwiki-source-54631e6ebf1d3b815c4a5eed
    resource: repo://src/App.tsx
  - id: openwiki-source-0e14c9aaf12eaa87038c7351
    resource: repo://src/consolidate/align.ts
  - id: openwiki-source-a258703e59a20a265c4d7784
    resource: repo://src/consolidate/apply.ts
  - id: openwiki-source-645237ab18a1b0effda09b72
    resource: repo://src/git/merge.ts
  - id: openwiki-source-d2e79df56d937d834ecbd575
    resource: repo://src/git/ref.ts
  - id: openwiki-source-edb4606d45ab1f4b8b69cb80
    resource: repo://src/git/relpath.ts
  - id: openwiki-source-45eebe3ca36ab988bd9323a9
    resource: repo://src/git/url.ts
  - id: openwiki-source-ded932c19c04aac08bb5edf2
    resource: repo://src/model/annotations.ts
  - id: openwiki-source-68e9e61da0efb614946dda70
    resource: repo://src/model/project.ts
  - id: openwiki-source-a0459bce65b7490683280544
    resource: repo://src/model/schema.ts
  - id: openwiki-source-d550d6b8b447fac29ab966c2
    resource: repo://src/model/updateSignature.ts
  - id: openwiki-source-ff5f46fa2216a7ebb3226632
    resource: repo://src/model/validate.ts
  - id: openwiki-source-24c09c3b54387889db23d752
    resource: repo://src/platform/adapter.ts
  - id: openwiki-source-769f5f5c1e3631cf9ab273bc
    resource: repo://src/platform/electron.ts
  - id: openwiki-source-776dd28cc442c205e0a91460
    resource: repo://src/platform/index.ts
  - id: openwiki-source-9b49ad2f97827d5ed9890232
    resource: repo://src/platform/unsupported.ts
  - id: openwiki-source-5f3156110d9aafbc8e103762
    resource: repo://src/screening/counts.ts
  - id: openwiki-source-c0a5a9016440eaf62ed2a380
    resource: repo://src/screening/schema.ts
  - id: openwiki-source-479c74ae5cbf30b0a06174a1
    resource: repo://src/screening/status.ts
  - id: openwiki-source-fa765b0e395ba25b6016d05a
    resource: repo://src/screening/validate.ts
  - id: openwiki-source-c1ab92e18d72fec6435ab66e
    resource: repo://src/state/aiStore.ts
  - id: openwiki-source-89409d7a9c0280067e058c1a
    resource: repo://src/state/store.ts
  - id: openwiki-source-5e1b077422a94ae165e88e4e
    resource: repo://vite.config.ts
  - id: openwiki-source-9b13c737ac155b0b0c8d76b9
    resource: repo://vitest.integration.config.ts
generated: { by: "openwiki/0.5.0", at: "2026-09-01T19:42:14.192Z" }
---

# SaiLoR — Quickstart

## What is SaiLoR?

SaiLoR is a tool for reviewers conducting **Systematic Literature Reviews (SLRs)** — the letters are in the name: **S**ai**L**o**R**. You open a "project" — a `project.json` file plus a sibling `annotations/` folder — that together hold:

1. **An annotation schema** — a nested, cardinality-controlled taxonomy defining what fields to extract from each paper, stored in `project.json`.
2. **A list of papers** — each with a PDF path and metadata, also in `project.json`.
3. **Every reviewer's/consolidation's annotation data** — the actual filled-in answers, stored separately under `annotations/<paperId>/` (see "On-disk layout" below and [Data Model](concepts/data-model.md)).

The app renders the PDF in the middle pane, shows the annotation form on the right, and lets you **grab text directly from the PDF** to populate fields. Annotations are saved back to the split files described above.

A project can also be set to **screening** mode instead of authoring a schema: one fast
Include/Exclude decision per paper (plus a reason when excluded), usually made from the title and
abstract before annotation even begins. See [Screening Mode](workflows/screening.md).

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
automatically on the next save, with no explicit "migrate" step.** See
[Data Model](concepts/data-model.md) for the full shape and migration mechanics.

## SaiLoR is Electron-desktop-only

**The browser/web build has been discontinued.** SaiLoR used to also ship as a static web SPA
(File System Access API or download fallback) and as a Docker self-hosted deployment. Both are
gone as real ways to use the app: the web build still technically compiles (kept only so the
CI/typecheck pipeline and Vite build still pass), but at runtime it shows a "SaiLoR for the web has
been discontinued — use the desktop app" message and blocks all project-opening UI before any file
picker or project state can be reached (`src/App.tsx`'s `isElectron()` gate). Docker self-hosting
serves that same static build, so it no longer does anything useful either. See
[Architecture](architecture.md) for what this removed (`src/platform/browser.ts`,
`src/platform/idb.ts`, the `?project=<url>` loader) and why.

The **desktop app (Electron)** — local files, native Open/Save dialogs, custom `slr-file://`
protocol for PDF loading, and full git integration — is the only supported way to use SaiLoR now.
`npm run dev` (the plain web dev server) shows only the discontinuation screen and nothing else;
Electron dev is the only usable way to run the app.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| State management | Zustand + immer middleware |
| Validation | Zod |
| PDF rendering | react-pdf (pdf.js) |
| Desktop shell | Electron 43 |
| Build tool | Vite 6 (with vite-plugin-electron) |
| Testing | Vitest 3 + jsdom; Playwright for e2e |

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

# Integration tests (spin up real scratch git repos; slow, gated before release):
npm run test:integration

# End-to-end tests (real Electron; builds first, gated before release):
npm run test:e2e

# Type check only:
npm run typecheck
```

`scripts/ci.sh` chains the provider-agnostic CI pipeline (install → typecheck → wiki-link check →
test → build). `scripts/build-electron.sh` packages the desktop app for the host OS. See
[Build, CI, and Release](operations/build-release.md) for the full pipeline, GitHub Actions
workflows, Docker-based builds, and release signing.

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
│   │   └── merge.ts       mergeProjects / applyResolutions — the field-level three-way merge
│   ├── llm/                AI-assisted annotation — pure logic (providers, prompt, parse, paths, models)
│   ├── consolidate/        Multi-reviewer consolidation — pure logic (align, apply, similarity, metrics, disagreements, unanimous, readiness)
│   ├── platform/          Platform abstraction for file I/O, PDF loading, and git — Electron only now, see "SaiLoR is Electron-desktop-only" above
│   │   ├── adapter.ts     PlatformAdapter interface + isElectron()
│   │   ├── electron.ts    ElectronAdapter (IPC + slr-file://, recents, git incl. merge/log/discard-file/branch-delete, splits project text into project.json + annotations/ files on save)
│   │   ├── unsupported.ts createUnsupportedAdapter — stands in for the platform outside Electron; a Proxy that answers the two pre-gate reads (kind, getRecents) for real and throws on everything else (a backstop — `App.tsx` blocks all project-opening UI before any of this is reachable)
│   │   ├── pdfjs.ts       Single place configuring the pdf.js worker (viewer + extractor)
│   │   ├── recents.ts     Recent-projects list in localStorage (max 5)
│   │   └── index.ts       getPlatform() singleton (ElectronAdapter or createUnsupportedAdapter)
│   ├── state/
│   │   ├── store.ts      Zustand + immer store (project, papers, save, annotations, undo/redo incl. PDF marks, theme, fontScale, pdfZoom, recents, reading position, help, native self-update progress on win/linux)
│   │   ├── store.readingPosition.test.ts  "Continue where you left off" — reopening a project lands on the same paper, PDF page, and scroll offset within it (offsetFraction compat/clamp)
│   │   ├── store.marks.test.ts  PDF mark mutations (addHighlight/setMarkComment/setMarkColor/removeMark) and their undo steps
│   │   ├── editorStore.ts  Draft state for the project editor (schema tree + papers, relative PDF paths, validate/save)
│   │   ├── gitStore.ts    Zustand + immer store for the clone flow, the commit/pull/push panel, the merge-branch/delete-branch prompts, the commit-history panel, and whole-file discard (reads store.ts one-way; store.ts never imports it)
│   │   ├── aiStore.ts     Zustand store for the AI-assisted annotation flow (its own phase lifecycle; meets the main store only at `applyAiSuggestions`)
│   │   └── settings.ts   Theme + font-scale persistence (localStorage), applyTheme/applyFontScale
│   ├── components/        React UI (Toolbar, PaperList, PdfViewer, AnnotationPanel, Field, Screening*, Consolidation*, Git*, Ai*, LlmSettingsDialog, ModelPicker, …)
│   ├── hooks/             useKeybindings, useAutosave, useExportTextMenu, useDirtyGuard, useElectronCloseGuard
│   ├── clipboard.ts       copyText — clipboard write with legacy fallback, never throws
│   ├── App.tsx            Component composition; `isElectron()` gate shows the web-discontinued notice and blocks all project-opening UI otherwise; welcome screen with recents, HelpDialog
│   ├── main.tsx           React root (applies theme + font scale before render)
│   └── styles/            index.css (full app styling), ai.css, editor.css, papers-editor.css, schema-editor.css, git.css
├── e2e/                    Playwright e2e (openSaveProject, gitPush) — real Electron, gated on build
├── samples/               Single-file example projects (auto-migrate to the split layout on first save)
├── scripts/ci.sh          Provider-agnostic CI pipeline (install → typecheck → test → build)
├── scripts/build-electron.sh  Provider-agnostic desktop build (electron-builder for the host OS)
├── scripts/sign-release.cjs  Ed25519 signs the electron-updater feed for native self-update
├── .github/workflows/     ci.yml, integration-tests.yml, release.yml, openwiki*.yml
├── Dockerfile.electron    Debian image that runs electron-builder — Linux installers into ./release/
├── docker-compose.dev.yml Builds the Dockerfile.electron image
├── docs/                  In-depth authoring guide (annotation-schema.md) — the user-facing reference
├── public/logo.svg        App logo — source of truth; also shown on the welcome screen
├── build/icon.png         Generated from public/logo.svg (dock / packaged-bundle icon)
├── vite.config.ts         Vite + vitest + electron plugin config
├── vitest.integration.config.ts  Standalone config for the integration suite (separate from `npm test`)
├── tsconfig*.json         TypeScript project references (app / node)
└── package.json           Scripts, deps, electron-builder config
```

## Task Routing

Where to start for common change areas (wiki page → source entry points → key symbols/types → focused tests → minimal validation):

| Change area / intent | Wiki page | Source entry points | Key symbols / types | Focused tests | Minimal validation |
|---|---|---|---|---|---|
| Annotation field value / instance lifecycle | [Architecture](architecture.md) | `src/state/store.ts` | `setFieldValue`, `addInstance`, `removeInstance`, `currentTree` | `src/state/store.test.ts`, `src/state/store.reviewers.test.ts` | `npm test -- src/state/store.test.ts` |
| PDF mark (highlight/note) + its undo step | [PDF Viewer and Marks](workflows/pdf-viewing.md) | `src/components/PdfViewer.tsx`, `src/state/store.ts`, `src/model/pdfMarks.ts` | `addHighlight`, `setMarkComment`, `removeMark`, `linkMarkToField` | `src/state/store.marks.test.ts`, `src/model/pdfMarks.test.ts` | `npm test -- src/state/store.marks.test.ts` |
| "Continue where you left off" reading position | [PDF Viewer and Marks](workflows/pdf-viewing.md) | `src/components/PdfViewer.tsx`, `src/state/store.ts` | `noteReadingPosition`, `initialPdfPosition`, `offsetFraction`, `clearInitialPdfPosition` | `src/state/store.readingPosition.test.ts`, `src/test/integration/pdfReadingPosition.integration.test.tsx` | `npm test -- src/state/store.readingPosition.test.ts`; integration: `npm run test:integration` |
| Schema resolution / model round-trip | [Annotation Schema and Validation](concepts/annotation-schema.md), [Project Data Model](concepts/data-model.md) | `src/model/schema.ts`, `src/model/project.ts`, `src/model/annotations.ts` | `resolveSchema`, `loadProject`, `serializeProject`, `splitProjectFiles`, `isLegacyProjectShape`, `normalizeTree` | `src/model/model.test.ts`, `src/model/split.test.ts` | `npm test -- src/model/model.test.ts` |
| Consolidation entry matching / alignment | [Multi-Reviewer Consolidation](workflows/consolidation.md) | `src/consolidate/align.ts`, `src/consolidate/apply.ts`, `src/state/store.ts` | `alignNode`, `alignableNodes`, `growConsolidated` | `src/consolidate/align.test.ts`, `src/consolidate/apply.test.ts` | `npm test -- src/consolidate` |
| Git merge / three-way field merge | [Git Integration](workflows/git-integration.md) | `src/git/merge.ts`, `src/git/changes.ts`, `src/state/gitStore.ts` | `mergeProjects`, `applyResolutions` | `src/git/merge.test.ts`, `src/state/gitStore.test.ts` | `npm test -- src/git/merge.test.ts` |
| Git ref/path safety primitives | [Git Integration](workflows/git-integration.md) | `src/git/ref.ts`, `src/git/relpath.ts`, `src/git/url.ts`, `src/git/ownAnnotationPath.ts` | `refProblem`, `relPathProblem`, `annotationsRelDir`, `validateGitUrl` | `src/git/ref.test.ts`, `src/git/relpath.test.ts`, `src/git/url.test.ts` | `npm test -- src/git/ref.test.ts src/git/relpath.test.ts` |
| LLM annotation (AI-assisted pre-fill) | [AI-Assisted Annotation](workflows/llm-annotation.md) | `src/llm/providers.ts`, `src/llm/prompt.ts`, `src/llm/parse.ts`, `src/state/aiStore.ts`, `src/state/store.ts` | `buildRequest`, `buildSystemPrompt`, `parseAnswer`, `applyAiSuggestions` | `src/llm/parse.test.ts`, `src/state/store.ai.test.ts`, `src/state/aiStore.models.test.ts` | `npm test -- src/llm src/state/store.ai.test.ts` |
| Screening mode (Include/Exclude + reason) | [Screening Mode](workflows/screening.md) | `src/screening/schema.ts`, `src/screening/status.ts`, `src/screening/counts.ts`, `src/screening/validate.ts`, `src/state/store.ts` | `isScreening`, `screeningStatus`, `screeningCounts`, `screeningIssues` | `src/screening/counts.test.ts`, `src/screening/status.test.ts`, `src/state/store.screening.test.ts` | `npm test -- src/screening src/state/store.screening.test.ts` |
| Platform adapter / file-IO / PDF-loading seam | [Architecture](architecture.md) | `src/platform/adapter.ts`, `src/platform/electron.ts`, `src/platform/index.ts`, `src/platform/unsupported.ts` | `PlatformAdapter`, `ElectronAdapter`, `createUnsupportedAdapter`, `getPlatform`, `isElectron` | `src/test/integration/*.integration.test.tsx` (mocks `getPlatform`) | `npm run typecheck` |
| Electron IPC surface (main/preload/adapter) | [Electron Main Process and IPC](operations/electron-shell.md) | `electron/main.ts`, `electron/preload.ts`, `src/platform/electron.ts` | `window.slr` bridge, `ipcMain` handlers (`project:*`, `pdf:*`, `git:*`, `llm:*`, `text:*`, `paths:*`, `update:*`) | `e2e/openSaveProject.spec.ts`, `e2e/gitPush.spec.ts` | `npm run test:e2e` |
| Native self-update / signed release feed | [Electron Main Process and IPC](operations/electron-shell.md), [Build, CI, and Release](operations/build-release.md) | `src/model/updateSignature.ts`, `src/model/version.ts`, `electron/main.ts` | Ed25519 feed verification, `electron-updater` | `src/model/updateSignature.test.ts`, `src/model/version.test.ts` | `npm test -- src/model/updateSignature.test.ts src/model/version.test.ts` |
| Project editor (schema tree + papers) | [Annotation Schema and Validation](concepts/annotation-schema.md) | `src/state/editorStore.ts`, `src/components/ProjectEditor.tsx` | `editorStore`, `buildProjectJson` | `src/state/editorStore.test.ts` (+ siblings) | `npm test -- src/state/editorStore.test.ts` |
| Build / CI / release / packaging | [Build, CI, and Release](operations/build-release.md) | `scripts/ci.sh`, `scripts/build-electron.sh`, `vite.config.ts`, `package.json` | `build:electron`, electron-builder config | `e2e/` (release-gated) | `npm run typecheck && npm test` |

## Where to Go Next

- [Architecture](architecture.md) — the renderer/main process split, the `PlatformAdapter` seam,
  the Zustand stores and undo/redo (incl. undoable PDF marks), the component tree, multi-reviewer
  consolidation with stored alignment, and how the build is wired.
- [Annotation Schema and Validation](concepts/annotation-schema.md) — `AnnotationDef`/`ResolvedDef`
  types, zod schemas, `resolveSchema`, field types, cardinality, and validation rules.
- [Project Data Model](concepts/data-model.md) — the on-disk `project.json` + `annotations/`
  format, the in-memory types, and the load → normalize → edit → prune → serialize lifecycle.
- [Multi-Reviewer Consolidation](workflows/consolidation.md) — entry matching, agreement scoring,
  stored alignment, and the consolidation UI.
- [Git Integration](workflows/git-integration.md) — clone-to-import, commit/pull/push, the
  field-level three-way merge, and the security gates.
- [AI-Assisted Annotation](workflows/llm-annotation.md) — the provider abstraction, prompt
  construction, response parsing, and API-key security.
- [PDF Viewer and Marks](workflows/pdf-viewing.md) — react-pdf rendering, text-selection capture,
  highlights/notes, mark export, and reading-position persistence.
- [Screening Mode](workflows/screening.md) — the derived Decision/Reason schema, tri-state
  status, PRISMA-style counts, and the screening UI.
- [Electron Main Process and IPC](operations/electron-shell.md) — the main process, preload bridge,
  `slr-file://` protocol, IPC handler groups, and the signed self-update feed.
- [Build, CI, and Release](operations/build-release.md) — the Vite + electron-builder pipeline,
  CI, release packaging, and Docker-based builds.
- [Testing Strategy](testing.md) — Vitest unit tests, the integration suite, and Playwright e2e.
