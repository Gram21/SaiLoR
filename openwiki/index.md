---
okf_version: "0.2"
---

# Files

- [SaiLoR Architecture](architecture.md) - Deep dive into SaiLoR's architecture — why the web SPA runtime was discontinued (Electron-desktop-only now), the split project.json + annotations/ on-disk storage format, the PlatformAdapter seam, the Zustand store with undo/redo (incl. PDF marks), reading-position persistence, PDF internal-link hover previews, the component tree, PDF marks and field-linking, multi-reviewer consolidation with stored alignment, annotation state/finished flags (Consolidation included), git integration (concurrent reads), the Electron main process, and build wiring.
- [SaiLoR Developer Documentation](Home.md) - Home page for SaiLoR developer documentation. SaiLoR is an Electron desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
- [SaiLoR Quickstart](quickstart.md) - Introduction to SaiLoR, an Electron-desktop-only tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the full tech stack (React 19, Electron 43, Vite 6, Zustand+immer, Zod, react-pdf), quick-start commands, the repository layout, and a task-routing map to the right wiki page for common change areas.
- [Testing Strategy](testing.md) - The three-tier test architecture for SaiLoR — Vitest unit tests, a jsdom integration suite with real scratch git repos, and Playwright/Electron e2e smoke tests — plus the CI gating that ties them together.

# Directories

- [concepts](concepts/)
- [operations](operations/)
- [workflows](workflows/)
