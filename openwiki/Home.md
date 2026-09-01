---
type: landing
title: SaiLoR Developer Documentation
description: Home page for SaiLoR developer documentation. SaiLoR is an Electron desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
tags: [home, overview, documentation]
verified:
  - by: openwiki/0.5.0
    at: 2026-09-01T19:42:14.192Z
sources:
  - id: openwiki-source-6d3ac2bdfb0e76882a670989
    resource: repo://.github/workflows/openwiki.yml
  - id: openwiki-source-794b8a6d2fa178d64fce49a3
    resource: repo://.github/workflows/wiki-import.yml
  - id: openwiki-source-a7a8965ff53d3530162adf6d
    resource: repo://.github/workflows/wiki-publish.yml
  - id: openwiki-source-cfc82c903899c2457ec703b0
    resource: repo://docs/annotation-schema.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-54631e6ebf1d3b815c4a5eed
    resource: repo://src/App.tsx
  - id: openwiki-source-776dd28cc442c205e0a91460
    resource: repo://src/platform/index.ts
  - id: openwiki-source-9b49ad2f97827d5ed9890232
    resource: repo://src/platform/unsupported.ts
generated: { by: "openwiki/0.5.0", at: "2026-09-01T19:42:14.192Z" }
---

# SaiLoR — Developer Documentation

**SaiLoR** is a tool for reviewers conducting **Systematic Literature Reviews (SLR)** — the letters
are in the name: **S**ai**L**o**R**. A `project.json` file holds the annotation schema (a nested,
cardinality-controlled taxonomy) and the papers' metadata; a sibling `annotations/` folder holds the
actual annotation data, one file per paper per reviewer (plus a consolidated file), so two reviewers
working on different papers rarely collide in git. The app renders each paper's PDF beside a form
generated from the schema, and writes annotations back into that split layout. See
[Data Model](concepts/data-model.md) for the exact shape and the automatic migration from the old single-file
format.

**SaiLoR is Electron-desktop-only.** The codebase used to also ship a static web SPA and a Docker
self-hosting deployment; both are discontinued — the web build now shows a "use the desktop app"
notice at runtime instead of any project-opening UI. The `PlatformAdapter` seam that used to absorb
the difference between the Electron and browser runtimes still exists, but the non-Electron
implementation (`createUnsupportedAdapter`) now just refuses every action; see
[Architecture](architecture.md)'s Platform Adapter section for why the seam is still there.

This wiki is the **developer** documentation. If you are here to *use* SaiLoR — installing a release,
authoring a project file, annotating a paper — start with the
[README](https://github.com/Gram21/SaiLoR#readme) instead, and use
[`docs/annotation-schema.md`](https://github.com/Gram21/SaiLoR/blob/main/docs/annotation-schema.md)
as the project file authoring reference.

## Contents

| Page | What it covers |
|---|---|
| **[Quickstart](quickstart.md)** | What SaiLoR is, the split `project.json` + `annotations/` storage format, the tech stack (React 19, Electron, Vite, Zustand, Zod), why SaiLoR is Electron-desktop-only, the commands you actually need, and the repository layout. **Start here.** |
| **[Architecture](architecture.md)** | The renderer/main process split, the `PlatformAdapter` seam (and why the inert non-Electron adapter still exists), the Zustand stores and undo/redo (incl. PDF marks), the component tree, multi-reviewer consolidation with stored alignment, the git integration (concurrent reads), the Electron main process and signed update feed, and how the build is wired. |
| **[Data Model](concepts/data-model.md)** | The project on-disk format (meta-only `project.json` plus a sibling `annotations/` folder), the in-memory TypeScript types, PDF marks, stored consolidation alignment, annotation state/finished flags, and the load → normalize → edit → prune → serialize lifecycle that keeps a hand-edited JSON safe. |
| **[Operations](operations/build-release.md)** | Building the desktop installers, unit/integration/e2e testing (Vitest, React Testing Library, Playwright), CI, release packaging gated on the integration/e2e suite, and how these wiki pages are kept in sync. See also [Electron Main Process and IPC](operations/electron-shell.md) for the desktop shell, and [Testing Strategy](testing.md) for the test architecture. |

## How this wiki is maintained

**Do not treat this wiki as the original.** These pages live in
[`openwiki/`](https://github.com/Gram21/SaiLoR/tree/main/openwiki) in the main repository and are
mirrored to the GitHub wiki by a GitHub Action; the folder is the source of truth, and publishing
*replaces* the wiki rather than merging into it.

Editing a page on the wiki is still fine: a second Action imports wiki edits back into `openwiki/`
and commits them to `main`, so the two do not drift. A third, `openwiki.yml`, regenerates these
pages from the code on a weekly Monday 06:00 UTC schedule (and on demand via `workflow_dispatch`),
delegating the update to the `ardoco/actions` reusable OpenWiki workflow rather than running the
steps inline. See [Operations → Wiki sync](operations/build-release.md#wiki-sync-mechanics) for
the mechanics — including the three independent loop-prevention guards that stop the two sync
Actions triggering each other forever: the shared `concurrency: wiki-sync` group (so the two
directions never run at once), a `[wiki-sync]` commit-message guard on publish, and a
`github-actions[bot]` sender guard on import.
