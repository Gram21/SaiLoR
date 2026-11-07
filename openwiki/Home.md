---
type: landing
title: SaiLoR Developer Documentation
description: Home page for SaiLoR developer documentation. SaiLoR 2.0 is a Tauri desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
tags: [home, overview, documentation]
sources:
  - id: openwiki-source-6d3ac2bdfb0e76882a670989
    resource: repo://.github/workflows/openwiki.yml
  - id: openwiki-source-5f219f204b3e870beec929d9
    resource: repo://.github/workflows/pages.yml
  - id: openwiki-source-794b8a6d2fa178d64fce49a3
    resource: repo://.github/workflows/wiki-import.yml
  - id: openwiki-source-a7a8965ff53d3530162adf6d
    resource: repo://.github/workflows/wiki-publish.yml
  - id: openwiki-source-cfc82c903899c2457ec703b0
    resource: repo://docs/annotation-schema.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-99b0214e9f2113a0f6a2cf92
    resource: repo://src-tauri/src/main.rs
  - id: openwiki-source-5e350144821ef45403557db2
    resource: repo://src-tauri/src/project.rs
  - id: openwiki-source-54631e6ebf1d3b815c4a5eed
    resource: repo://src/App.tsx
  - id: openwiki-source-68e9e61da0efb614946dda70
    resource: repo://src/model/project.ts
  - id: openwiki-source-776dd28cc442c205e0a91460
    resource: repo://src/platform/index.ts
  - id: openwiki-source-9b49ad2f97827d5ed9890232
    resource: repo://src/platform/unsupported.ts
generated: { by: "claude-code", at: "2026-11-02T08:58:22.323Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-07T10:50:01.257Z
---

# SaiLoR — Developer Documentation

**SaiLoR** is a tool for reviewers conducting **Systematic Literature Reviews (SLR)** — the letters
are in the name: **S**ai**L**o**R**. A `project.json` file holds the annotation schema (a nested,
cardinality-controlled taxonomy) and the papers' metadata; a sibling `annotations/` folder holds the
actual annotation data, one file per paper per reviewer (plus a consolidated file), so two reviewers
working on different papers rarely collide in git. The app renders each paper's PDF beside a form
generated from the schema, and writes annotations back into that split layout; a project still saved
in the legacy single-file shape opens unchanged and migrates to the split layout automatically on the
next save. See [Data Model](concepts/data-model.md) for the exact shape and the migration.

**SaiLoR 2.0 is a desktop app built on [Tauri](https://v2.tauri.app/) v2** — the React renderer,
Zustand stores, and Vite build are unchanged from 1.x, but the shell is a Rust binary
(`src-tauri/`) driving the OS's system WebView instead of Electron. It is fully local: local PDF
files, native Open/Save dialogs, and git through the user's own `git` binary. The codebase used to
also ship a static web SPA and a Docker self-hosting deployment; the web build is discontinued — at
runtime it shows a "use the desktop app" notice instead of any project-opening UI (Docker remains
only as a way to build the Linux installers). The `PlatformAdapter` seam that used to absorb the
difference between desktop and browser runtimes still exists, but the non-desktop implementation
(`createUnsupportedAdapter`) now just refuses every action; see
[Architecture](architecture.md)'s Platform Adapter section for why the seam is still there. The
one exception is the online demo build (`vite build --mode demo`), which swaps in an in-memory
`createDemoAdapter` so the project site can show the real UI without saving, git, or AI; see
[Online Demo and Project Site](operations/demo-and-site.md).

This wiki is the **developer** documentation. If you are here to *use* SaiLoR — installing a release,
authoring a project file, annotating a paper — start with the
[README](https://github.com/Gram21/SaiLoR#readme) instead, and use
[`docs/annotation-schema.md`](https://github.com/Gram21/SaiLoR/blob/main/docs/annotation-schema.md)
as the project file authoring reference.

## Contents

| Page | What it covers |
|---|---|
| **[Quickstart](quickstart.md)** | What SaiLoR is, the split `project.json` + `annotations/` storage format, the tech stack (React 19, Tauri v2, Vite, Zustand, Zod), the commands you actually need, and the repository layout. **Start here.** |
| **[Architecture](architecture.md)** | The renderer/shell process split, the `PlatformAdapter` → `SlrBridge` → `TauriAdapter` seam (and why the inert non-desktop adapter still exists), the Zustand stores and undo/redo (incl. PDF marks), the component tree, multi-reviewer consolidation with stored alignment, the git integration (concurrent reads), the Rust shell, and how the build is wired. |
| **[Annotation Schema and Validation](concepts/annotation-schema.md)** | The `AnnotationDef`/`ResolvedDef` schema model — field types, cardinality, visibleIf conditions, `resolveSchema`, and the validation rules checked against annotated papers. |
| **[Data Model](concepts/data-model.md)** | The project on-disk format (meta-only `project.json` plus a sibling `annotations/` folder), the in-memory TypeScript types, PDF marks, stored consolidation alignment, annotation state/finished flags, and the load → normalize → edit → prune → serialize lifecycle that keeps a hand-edited JSON safe. |
| **[Testing Strategy](testing.md)** | The test layers — Vitest unit tests, the real-git integration suite, Rust unit tests in `src-tauri/`, and the tauri-driver e2e probe — plus the wiki-link check and what CI gates on. |
| **[Build, CI, and Release](operations/build-release.md)** | The Make targets and `tauri build` pipeline, CI (renderer script, Rust lint/tests, per-OS build matrix + probe, tauri-driver e2e), the release workflow with the signed updater feed and Zenodo archive, the Linux Docker build, and how these wiki pages are kept in sync. |
| **[Tauri Shell, IPC and Self-Update](operations/tauri-shell.md)** | The Rust desktop shell — the command inventory, the `slr-file://` protocol and its security model, session authorization allowlists, OS-keychain API-key handling, and the signed self-update flow. |
| **[Multi-Reviewer Consolidation](workflows/consolidation.md)** | Entry matching across reviewer seats, the stored alignment persisted in the project, growing/freezing the consolidated tree, agreement statistics, and the compare/adopt UI. |
| **[Git Integration](workflows/git-integration.md)** | Clone-to-import, commit/pull/push, the field-level three-way merge, the security gates, and the reproducible git scenarios used as tests. |
| **[AI-Assisted Annotation](workflows/llm-annotation.md)** | The provider abstraction and its four modes (prompt, agent + judge, classify/System One, re-check), the key-never-in-the-renderer invariant, the aiStore run loop, and the AI-usage disclosure records. |
| **[AI-Assisted Screening](workflows/ai-screening.md)** | The aiScreeningStore flow: one Include/Exclude proposal per paper from title+abstract, prompt vs System One engines, and the review table where the human approves each proposal before anything is written. |
| **[Local Models and Ollama](workflows/local-models.md)** | Running models fully offline: the managed llama.cpp runtime with hash-verified downloads, the local model catalog, hardware probing, and connecting to a user-run Ollama server. |
| **[PDF Viewer and Marks](workflows/pdf-viewing.md)** | The pdf.js-based viewer: rendering and zoom, text-selection capture for field grabbing, highlights/notes with per-seat persistence and evidence linking, reading-position persistence, and mark export into real PDF annotations. |
| **[Screening Mode](workflows/screening.md)** | The derived Decision/Reason schema, tri-state status, PRISMA-style counts, the screening UI, and the screening → annotation project hand-off. |
| **[Knowledge Graph View](workflows/knowledge-graph.md)** | The graph built from papers, authors, venues, keywords and answers; the force-layout canvas, the folded Nodes drawer, depth queries, the Cypher subset run in a worker with hard limits, and the export formats. |
| **[Progressive Project Loading](concepts/progressive-loading.md)** | How large projects open in batches, the load-state and generation guards, and why saving is blocked while a project is still loading. |
| **[Online Demo and Project Site](operations/demo-and-site.md)** | The compile-time `__DEMO__` build, the in-memory demo adapter, the schema-editor demo, the bundled demo PDFs, and the GitHub Pages deploy of the `site/` folder. |

## How this wiki is maintained

**Do not treat this wiki as the original.** These pages live in
[`openwiki/`](https://github.com/Gram21/SaiLoR/tree/main/openwiki) in the main repository and are
mirrored to the GitHub wiki by a GitHub Action; the folder is the source of truth, and publishing
*replaces* the wiki rather than merging into it.

Editing a page on the wiki is still fine: a second Action imports wiki edits back into `openwiki/`
and commits them to `main`, so the two do not drift. A third, `openwiki.yml`, regenerates these
pages from the code on a weekly Monday 06:00 UTC schedule (and on demand via `workflow_dispatch`),
delegating the update to the `ardoco/actions` reusable OpenWiki workflow rather than running the
<!-- openwiki: broken internal link [operations/build-release.md#wiki-sync-mechanics] heading anchor "wiki-sync-mechanics" does not exist in "operations/build-release.md". Fix the href or restore the target, then delete this comment. -->
steps inline. See [Operations → Wiki sync](operations/build-release.md#wiki-sync-mechanics) for
the mechanics — including the three independent loop-prevention guards that stop the two sync
Actions triggering each other forever: the shared `concurrency: wiki-sync` group (so the two
directions never run at once), a `[wiki-sync]` commit-message guard on publish, and a
`github-actions[bot]` sender guard on import.
