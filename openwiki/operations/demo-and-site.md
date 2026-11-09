---
type: operations
title: Online Demo and Project Site
description: How the compile-time DEMO_MODE build, the in-memory demo adapter, the schema-editor demo mode and the bundled demo PDFs work, and how the static project site plus the demo are built and deployed to GitHub Pages.
tags: [demo, site, github-pages, vite, platform-adapter]
sources:
  - id: openwiki-source-5f219f204b3e870beec929d9
    resource: repo://.github/workflows/pages.yml
  - id: openwiki-source-d6a9eb56960e984a3cd0cce3
    resource: repo://CITATION.cff
  - id: openwiki-source-2f6e34c116f239a0a80c7cae
    resource: repo://scripts/ci/pages.sh
  - id: openwiki-source-d440ddd3334dbd9c611629bf
    resource: repo://site/index.html
  - id: openwiki-source-54631e6ebf1d3b815c4a5eed
    resource: repo://src/App.tsx
  - id: openwiki-source-f65a101199959fef5004fce6
    resource: repo://src/demo/mode.ts
  - id: openwiki-source-d638993d4c41f8352e3f9b82
    resource: repo://src/demo/project.ts
  - id: openwiki-source-1d97b5a9fe029fab66d928ad
    resource: repo://src/demo/schemaMode.ts
  - id: openwiki-source-56b94f66668550f8b821f297
    resource: repo://src/platform/demoAdapter.ts
  - id: openwiki-source-776dd28cc442c205e0a91460
    resource: repo://src/platform/index.ts
  - id: openwiki-source-5e1b077422a94ae165e88e4e
    resource: repo://vite.config.ts
generated: { by: "claude-code", at: "2026-11-09T14:02:19.724Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-09T14:02:19.724Z
---

# Online Demo and Project Site

SaiLoR is a desktop app, but the project website at <https://janke.im/SaiLoR/> lets visitors try the real
React UI in a browser. Two demo links exist: an **annotation demo** (`demo/`) and a **schema editor demo**
(`demo/?mode=schema`). The demo is a separate build of the same renderer, not a second code base.

## The compile-time demo switch

- `npm run build:demo` runs `vite build --mode demo` and writes `dist-demo/` (`vite.config.ts`).
- The config defines `__DEMO__` as a build-time constant. `DEMO_MODE` in `src/demo/mode.ts` re-exports
  it, so the normal build folds it to `false` and drops every branch that reads it.
- `DEMO_SCHEMA_MODE` (`src/demo/schemaMode.ts`) is true only in the demo opened with `?mode=schema`.

Because the demo has no Tauri shell, the app's usual gate would show the "use the desktop app" notice.
`App.tsx` therefore lifts the gate with `!isTauri() && !DEMO_MODE`, shows a `DemoBanner` (with a back link
to the site), skips the update check, and opens the demo project at start.

## The demo adapter

`getPlatform()` (`src/platform/index.ts`) returns `createDemoAdapter()` when `DEMO_MODE` is set and the
shell is absent (see [Architecture](../architecture.md)). The adapter in `src/platform/demoAdapter.ts`
holds one project in memory. Every method that would touch the disk, the network or git answers as if the
user cancelled, or refuses with `DEMO_NOT_SAVED` / `DEMO_NOT_AVAILABLE` (`src/demo/text.ts`). This
includes `writeBinaryFile`, so the graph PNG download refuses with `DEMO_NOT_SAVED`. Nothing
reaches local storage, so a reload starts over. In schema mode the save handle is a download, so saving
the schema hands the visitor a `project.json` file.

## Demo content

`src/demo/project.ts` builds the demo project text from the project file, the reviewer seat files
(`reviewer-*.json`) and the consolidated files (`consolidated.json`) under `src/demo/data/annotations/`, so
the demo also shows the consolidation seat. There are seven demo papers with bundled PDFs in
`samples/pdfs/`, shared with the sample projects; their licences are listed in `src/demo/PDF-LICENSES.md`.
The PDFs are not imported by the code. A small Vite plugin in the demo build emits every PDF in that folder
as a plain file, except the test fixtures (`paper-*`, `multipage*`, `A1-*`), so the normal build never
contains them, and the file names must match `DEMO_PDF_FILES` in `src/demo/project.ts`.

## Site and Pages deploy

- `site/` holds the static pages (`index.html`, `create-project.html`, images, assets).
- `scripts/ci/pages.sh` builds the demo, copies `site/` into `_site/`, copies `dist-demo/` to
  `_site/demo/`, and runs `scripts/check-site-links.js` on the result. It runs locally as `make ci-pages`;
  `npm run check:site` runs only the link check.
- `.github/workflows/pages.yml` runs that script and deploys `_site` with the GitHub Actions Pages
  actions. It triggers on pushes to `main` and on manual dispatch. A deployment in
  progress is never cancelled (`concurrency: pages`).
- The Pages source must be set to GitHub Actions once in the repository settings, and the
  `github-pages` environment must allow the deploying branch.

## Citation on the site

`site/index.html` has a "How to cite" section with the Zenodo concept DOI and a BibTeX block that has a
`VERSION` placeholder. A comment in the page says to use the version DOI of the release before release.
`CITATION.cff` in the repository root holds the same data for GitHub's "Cite this repository" button.

## Tests and requirements

The behaviour is traced to `REQ-PLT-445` to `REQ-PLT-456` in `docs/requirements/platform.md`. Focused
tests: `src/demo/*.test.ts` (project, session, start, language, schema mode) and
`src/platform/demoSchemaAdapter.test.ts`.
