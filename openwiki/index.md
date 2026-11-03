---
okf_version: "0.2"
---

# Files

- [SaiLoR Architecture](architecture.md) - Deep dive into SaiLoR's architecture — the Tauri shell (renderer vs Rust process split), why the web SPA runtime was discontinued (desktop-only now), the PlatformAdapter seam over the SlrBridge/Tauri transport, the split project.json + annotations/ on-disk storage format, the four Zustand stores, the Zustand store with undo/redo (incl. PDF marks), reading-position persistence, the component tree, multi-reviewer consolidation with stored alignment, git integration (the Rust shell spawns git), the src-tauri Rust module map, and build wiring.
- [SaiLoR Developer Documentation](Home.md) - Home page for SaiLoR developer documentation. SaiLoR 2.0 is a Tauri desktop tool for conducting Systematic Literature Reviews (SLRs), storing the annotation schema and paper metadata in project.json and each reviewer's/consolidation's annotation data in a sibling annotations/ folder. Links to quickstart, architecture, data model, and operations pages.
- [SaiLoR Quickstart](quickstart.md) - Entry-point guide to SaiLoR, a Tauri 2 desktop tool for conducting Systematic Literature Reviews (SLRs). Covers what SaiLoR is, the split project.json + annotations/ storage format, the current tech stack (React 19, Tauri 2 + Rust shell, Vite 6, Zustand+immer, Zod, react-pdf), quick-start commands, the repository layout, and a task-routing map to the right wiki page for common change areas.
- [Testing Strategy](testing.md) - The four test layers and how to run them — Vitest unit tests, the real-git jsdom integration suite, Rust unit tests in src-tauri, and the tauri-driver e2e probe — plus the wiki-link check, the reproducible git-scenario rig, and what CI gates on.

# Directories

- [concepts](concepts/)
- [operations](operations/)
- [workflows](workflows/)
