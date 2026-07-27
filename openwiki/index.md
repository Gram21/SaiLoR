---
type: Documentation Index
title: "OpenWiki"
description: "Files and subdirectories in OpenWiki."
---

# Files

- [SaiLoR Architecture](architecture.md) - Deep dive into SaiLoR's architecture — why the web SPA runtime was discontinued (Electron-desktop-only now), the split project.json + annotations/ on-disk storage format, the PlatformAdapter seam, the Zustand store with undo/redo, the component tree, git integration, the Electron main process, and build wiring.
- [SaiLoR Data Model](data-model.md) - The SaiLoR project on-disk format — a meta-only project.json (schema, protocol, paper metadata) plus a sibling annotations/ folder holding each reviewer's/consolidation's annotation trees, and automatic migration from the old single-file shape — the in-memory TypeScript types (ResolvedDef, Project, Paper, AnnotationValueTree), and the full load → normalize → edit → prune → serialize lifecycle that keeps hand-edited JSON safe.
- [SaiLoR Developer Documentation](Home.md) - Home page for SaiLoR developer documentation. SaiLoR is an Electron desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
- [SaiLoR Operations](operations.md) - Operational guide for SaiLoR — development setup (Electron dev is the only supported way to run the app; the web build is discontinued at runtime), build commands for the desktop installers, testing with Vitest, CI configuration, release packaging, and wiki sync mechanics.
- [SaiLoR Quickstart](quickstart.md) - Introduction to SaiLoR, a tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the full tech stack (React 19, Electron, Vite, Zustand, Zod), why SaiLoR is now Electron-desktop-only, quick-start commands, and the repository layout.
