---
type: landing
title: SaiLoR Developer Documentation
description: Home page for SaiLoR developer documentation. SaiLoR is an Electron desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
tags: [home, overview, documentation]
---

# SaiLoR — Developer Documentation

**SaiLoR** is a tool for reviewers conducting **Systematic Literature Reviews (SLR)** — the letters
are in the name: **S**ai**L**o**R**. A `project.json` file holds the annotation schema (a nested,
cardinality-controlled taxonomy) and the papers' metadata; a sibling `annotations/` folder holds the
actual annotation data, one file per paper per reviewer (plus a consolidated file), so two reviewers
working on different papers rarely collide in git. The app renders each paper's PDF beside a form
generated from the schema, and writes annotations back into that split layout. See
<!-- openwiki: broken internal link [data-model] file "data-model" does not exist. Fix the href or restore the target, then delete this comment. -->
[Data Model](data-model) for the exact shape and the automatic migration from the old single-file
format.

**SaiLoR is Electron-desktop-only.** The codebase used to also ship a static web SPA and a Docker
self-hosting deployment; both are discontinued — the web build now shows a "use the desktop app"
notice at runtime instead of any project-opening UI. The `PlatformAdapter` seam that used to absorb
the difference between the Electron and browser runtimes still exists, but the non-Electron
implementation (`UnsupportedAdapter`) now just refuses every action; see
<!-- openwiki: broken internal link [architecture] file "architecture" does not exist. Fix the href or restore the target, then delete this comment. -->
[Architecture](architecture)'s Platform Adapter section for why the seam is still there.

This wiki is the **developer** documentation. If you are here to *use* SaiLoR — installing a release,
authoring a project file, annotating a paper — start with the
[README](https://github.com/Gram21/SaiLoR#readme) instead.

## Contents

| Page | What it covers |
|---|---|
<!-- openwiki: broken internal link [quickstart] file "quickstart" does not exist. Fix the href or restore the target, then delete this comment. -->
| **[Quickstart](quickstart)** | What SaiLoR is, the tech stack, the commands you actually need, and the repository layout. **Start here.** |
<!-- openwiki: broken internal link [architecture] file "architecture" does not exist. Fix the href or restore the target, then delete this comment. -->
| **[Architecture](architecture)** | The `PlatformAdapter` seam, the Zustand stores and undo/redo, the component tree, the git integration, the Electron main process, and how the build is wired. |
<!-- openwiki: broken internal link [data-model] file "data-model" does not exist. Fix the href or restore the target, then delete this comment. -->
| **[Data Model](data-model)** | The project file format, the in-memory types, and the load → normalize → edit → prune → serialize lifecycle that keeps a hand-edited JSON safe. |
<!-- openwiki: broken internal link [operations] file "operations" does not exist. Fix the href or restore the target, then delete this comment. -->
| **[Operations](operations)** | Developing, building, testing, CI, releasing the desktop installers, deployment (static / Docker / Electron), and how these wiki pages are kept in sync. |

## How this wiki is maintained

**Do not treat this wiki as the original.** These pages live in
[`openwiki/`](https://github.com/Gram21/SaiLoR/tree/main/openwiki) in the main repository and are
mirrored here by a GitHub Action; the folder is the source of truth, and publishing *replaces* the
wiki rather than merging into it.

Editing a page here is still fine: a second Action imports wiki edits back into `openwiki/` and
commits them to `main`, so the two do not drift. See
<!-- openwiki: broken internal link [operations#wiki-sync] file "operations" does not exist. Fix the href or restore the target, then delete this comment. -->
[Operations → Wiki sync](operations#wiki-sync) for the mechanics — including
why the two Actions cannot trigger each other in a loop.
