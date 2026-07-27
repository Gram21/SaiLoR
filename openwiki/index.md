---
okf_version: "0.1"
---

# Files

- [SaiLoR Architecture](architecture.md) - Deep dive into SaiLoR's architecture — the PlatformAdapter seam (now Electron-only; the browser build is discontinued), the split project.json + annotations/ storage format, the Zustand store with undo/redo, the component tree, git integration, the Electron main process, and build wiring.
- [SaiLoR Data Model](data-model.md) - The SaiLoR project file format — a meta-only project.json (schema, protocol, paper metadata) plus a sibling annotations/ folder holding each reviewer's/consolidation's annotation trees — the in-memory TypeScript types (ResolvedDef, Project, Paper, AnnotationValueTree), and the full load → normalize → edit → prune → serialize lifecycle, including automatic migration from the old single-file shape.
- [SaiLoR Developer Documentation](Home.md) - Home page for SaiLoR developer documentation. SaiLoR is an Electron-desktop-only tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
- [SaiLoR Operations](operations.md) - Operational guide for SaiLoR — development setup (Electron dev is the only supported way to run the app; the web dev server only shows the discontinuation notice), build commands for the desktop installers, testing with Vitest, CI configuration, release packaging, and wiki sync mechanics.
- [SaiLoR Quickstart](quickstart.md) - Introduction to SaiLoR, a tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the full tech stack (React 19, Electron, Vite, Zustand, Zod), why SaiLoR is now Electron-desktop-only, and the repository layout.
