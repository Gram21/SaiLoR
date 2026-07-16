---
type: Documentation Index
title: "OpenWiki"
description: "Files and subdirectories in OpenWiki."
---

# Files

- [SaiLoR Wiki Footer](_Footer.md) - Footer for the SaiLoR developer wiki. Notes that these pages are mirrored from the repository's openwiki/ folder and provides links to the repository, README, issues, releases, annotation schema guide, and license.
- [SaiLoR Wiki Sidebar](_Sidebar.md) - Sidebar navigation for the SaiLoR developer wiki. Contains links to the Quickstart, Architecture, Data Model, and Operations pages with their section anchors.
- [SaiLoR Architecture](architecture.md) - Deep dive into SaiLoR's architecture — the PlatformAdapter seam that unifies Electron desktop and web SPA runtimes, the Zustand store with undo/redo, the component tree, git integration, the Electron main process, and build wiring.
- [SaiLoR Data Model](data-model.md) - The SaiLoR project file format (JSON schema for annotation taxonomies and papers), the in-memory TypeScript types (ResolvedDef, Project, Paper, AnnotationValueTree), and the full load → normalize → edit → prune → serialize lifecycle that keeps hand-edited JSON safe.
- [SaiLoR Developer Documentation](Home.md) - Home page for SaiLoR developer documentation. SaiLoR is a tool for conducting Systematic Literature Reviews (SLRs) with a single JSON project file holding both the annotation schema and the papers to annotate. Links to quickstart, architecture, data model, and operations pages.
- [SaiLoR Operations](operations.md) - Operational guide for SaiLoR — development setup (web, Electron, Docker), build commands for the static SPA and desktop installers, testing with Vitest, CI configuration, release packaging, deployment options, and wiki sync mechanics.
- [SaiLoR Quickstart](quickstart.md) - Introduction to SaiLoR, a tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the full tech stack (React 19, Electron, Vite, Zustand, Zod), quick-start commands for web/desktop/Docker, and the repository layout.
