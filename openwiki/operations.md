---
type: operations
title: SaiLoR Operations
description: Operational guide for SaiLoR — development setup (Electron dev is the only supported way to run the app; the web build is discontinued at runtime), build commands for the desktop installers, testing with Vitest, CI configuration, release packaging, and wiki sync mechanics.
tags: [operations, build, testing, ci, electron-only]
---

# Operations

## SaiLoR is Electron-desktop-only

SaiLoR used to also ship as a static web SPA (File System Access API / download fallback) and as a
Docker self-hosted deployment. **Both are discontinued as real ways to run the app.** The web build
still compiles — kept only so the CI/typecheck pipeline and `vite build` keep working — but at
runtime it renders nothing but a "SaiLoR for the web has been discontinued — use the desktop app"
notice, gated in `src/App.tsx` before any project-opening UI (file picker, drag-and-drop, `?project=`
auto-load) can run. The File System Access API adapter (`src/platform/browser.ts`), the IndexedDB
handle store (`src/platform/idb.ts`), and the `?project=<url>` server-hosted-deployment loader
(`loadFromUrl` in `src/state/store.ts`) were all **deleted**, not merely disabled — the non-Electron
`PlatformAdapter` implementation is now `UnsupportedAdapter` (`src/platform/unsupported.ts`), which
answers every read with "nothing" and throws on every action, as a backstop for the handful of reads
(`getRecents()`) that happen at store module load, before `App` ever renders and can show the gate.
Docker self-hosting served that same static build; its `Dockerfile`/`docker-compose.yml`/`nginx.conf`
have been **removed** from the repo (not just disabled) — the only Docker file left,
`Dockerfile.electron` (plus the trimmed `docker-compose.dev.yml`), builds the Electron installer
instead, see "Dev in Docker" below.

Everything in this page below assumes the **Electron desktop app** as the target; the sections below
that still mention the web dev server say so explicitly, and exist only for contributors iterating on
shared renderer code or on the discontinuation screen itself — not a usable deployment path for a
reviewer.

## Development

### Web dev server — not a usable deployment

```bash
npm run dev
```

Starts the Vite dev server at `http://localhost:5173`. This is **not** a way to annotate papers: the
page renders `isElectron()`'s gate and nothing else, the same "use the desktop app" notice the
production web build shows. It is useful only for contributors working on code shared with the
Electron renderer, or on the discontinuation screen itself — not for reviewers, and not documented
as a deployment option.

### Electron dev (desktop)

```bash
npm run dev:electron
```

Sets `ELECTRON=1` via `cross-env`, which activates the `vite-plugin-electron` plugin in `vite.config.ts`. This builds `electron/main.ts` and `electron/preload.ts` alongside the renderer, then launches the Electron shell loading the Vite dev server URL.

The first `dev:electron` after a fresh `npm ci` prints `Downloading Electron binary…` and pauses for a minute: since Electron 40 the package ships no install script and fetches its ~200 MB runtime lazily, on first use. This is also why the toolchain requires **Electron ≥ 40**: earlier versions extracted that runtime with `extract-zip@2.0.1`, which hangs silently on Node ≥ 26 and leaves behind a stub `node_modules/electron/dist` — the app then dies with *"Electron failed to install correctly"*. Downgrading Node is the other way out; upgrading Electron is the one this project took.

### npm install-script approval

npm ≥ 11.17 blocks dependency install scripts until they are approved, and records the approvals in `package.json` under `allowScripts`. Only **esbuild** is approved (it downloads its native binary; Vite needs it). `canvas` — the native dependency `pdfjs-dist` pulls in but the app never loads, and which is excluded from the packaged build — is deliberately left blocked. If a fresh clone fails with a missing esbuild binary, run `npm approve-scripts --allow-scripts-pending` to see what is pending. Older npm ignores the field and runs everything, so CI (Node 24) is unaffected.

### Dev in Docker (optional)

`docker-compose.dev.yml` builds the Electron app (Linux AppImage, into `./release/`) without a local
Node install:

```bash
docker compose -f docker-compose.dev.yml run --rm electron
```

It's a Debian image (`Dockerfile.electron`) that runs `electron-builder`; Windows/macOS installers
still need their native OS.

## Build

### Static SPA

```bash
npm run build
```

Runs `tsc -b` (TypeScript project references) then `vite build`. Output goes to `dist/` with sourcemaps. The `base: './'` config ensures the build works from any subpath and from `file://`.

### Desktop installers

```bash
npm run build:electron
```

Sets `ELECTRON=1`, builds the SPA + Electron processes, then runs `electron-builder`. Config in `package.json` under `build`:

| Platform | Target |
|---|---|
| macOS | dmg |
| Windows | nsis |
| Linux | AppImage |

Output directory: `release/`. The `appId` is `io.github.gram21.sailor`, product name "SaiLoR". ASAR packaging is enabled.

**App icon.** `public/logo.svg` is the source of truth — the same file the running app shows on its own welcome screen (`src/App.tsx`), so there is one artwork feeding both rather than two copies that could drift apart. `build/icon.png` (1024×1024, transparent) is generated from it with `npm run icon` and committed, because electron-builder and the dock/taskbar need a raster icon. The script (`scripts/make-icon.cjs`) rasterizes the SVG using the Chromium that Electron already ships, so there is no extra image toolchain to install. On macOS it then also builds `build/icon.icns` from that PNG via the OS's own `sips`/`iconutil` (skipped elsewhere, with a note to regenerate it on a Mac) — `mac.icon` points at the `.icns`, not the `.png`. This exists because handing electron-builder the bare PNG and letting *it* auto-convert produced a visibly worse macOS icon (undersized/muddy at small Dock and Finder sizes) than Apple's own `iconutil` does from the same source pixels. Re-run `npm run icon` whenever `logo.svg` changes. `public/favicon.svg` is a separate, hand-simplified version for 16px browser tabs, where `logo.svg`'s detail turns to mush.

**Window icon (Windows/Linux only).** `electron/main.ts` passes `icon: appIcon` (loaded from `build/icon.png`) to `BrowserWindow`, which shows a small icon before the title text in the OS window chrome. macOS has no equivalent convention — its icon lives in the Dock instead, set via `app.dock.setIcon` — so this is a no-op there.

**DMG window layout.** `build.dmg` in `package.json` sets an explicit window size and icon positions (the app on the left, an `/Applications` alias on the right) — without it, electron-builder falls back to its own default layout, which is fine but not deliberately chosen. Two files dmgbuild always writes into the mounted volume, `.background.tiff` and `.VolumeIcon.icns`, are hidden from Finder **only** by the leading-dot filename convention — there is no supported electron-builder option to mark them invisible outright (`DmgContent`'s `type` is limited to `"dir" | "file" | "link"`, and dmgbuild's own undocumented `"position"` trick for repositioning already-created files is rejected by electron-builder's own config-schema validation before it ever reaches dmgbuild). If they show up in a mounted DMG's Finder window, that is Finder's **"Show Hidden Files"** preference (`Cmd+Shift+.`, or `defaults read com.apple.finder AppleShowAllFiles`) being on for that machine, not a broken build — verified by mounting a locally built DMG and confirming neither file carries the Finder-invisible flag (`ls -laO`), so dot-prefix convention is the only thing hiding them either way.

**Package-size optimizations** (in the `build` config): the renderer and main process are fully bundled by Vite, so nothing needs `node_modules` at runtime — the `files` list is `dist/**/*` + `dist-electron/**/*` + `build/icon.png`, with `!node_modules/**/*` (drops ~100 MB, mostly the unused native `canvas` dep pulled in by `pdfjs-dist`) and `!**/*.map` (source maps stay in the web `dist/` but are excluded from the app). `electronLanguages: ["en-US"]` keeps only one Chromium locale (~40 MB → ~0.5 MB), and `compression: "maximum"` shrinks the installer. These take the Linux AppImage from ~137 MB to ~80 MB. The remaining size is the Electron/Chromium runtime itself, which is fixed. Node integration is already disabled in the renderer (`contextIsolation: true`, `nodeIntegration: false`).

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch  # vitest in watch mode
```

Tests live in `src/**/*.test.{ts,tsx}`. `src/model/model.test.ts` covers the model layer, `src/state/store.test.ts` covers the store's undo/redo history (field-edit coalescing, add/remove undo, redo-stack clearing), and `src/state/editorStore.test.ts` covers the project editor (schema ⇄ on-disk conversion and round-trip, drag-and-drop tree moves incl. the self/descendant guard, draft validation, and that `buildProjectJson` produces a file the real `loadProject` accepts with annotations preserved) — split into sibling files for the platform-stubbed flows (`editorStore.pdfs.test.ts` for `addPdfs`/`addPdfFolder` deduplication, `editorStore.import.test.ts` for `importReferences` matching/merging and the "just added" marks, `editorStore.history.test.ts` for undo/redo). `src/model/references.test.ts` pins the BibTeX/RIS/CSL-JSON parser adversarially (nested braces, missing fields, CRLF, a BOM, garbage input, an entry with no title) — every case must resolve to *some* array, never a thrown error. Vitest is configured with jsdom environment and global test APIs (describe/it/expect available without import, though the test files import them explicitly).

**A few tests deliberately run against the real PDFs in `samples/pdfs/`** rather than hand-built inputs: `src/model/pdfText.test.ts`, the `extractPdfMeta against real PDFs` block in `src/model/pdfMeta.test.ts`, and `src/state/editorStore.realPdf.test.ts`. They exist because a hand-built fixture can only encode what its author *believes* pdf.js emits, and that belief has been wrong in a way no unit test could catch: the abstract heuristic's synthetic tests all passed while it extracted nothing whatsoever from a real two-column paper (see the architecture page's Screening section). They need the pdf.js worker pointed at its on-disk file first — jsdom resolves the module URL to `http:`, which pdf.js's Node fallback cannot import — which is what the identical preamble at the top of each of those files is for.

Test coverage:
- Schema resolution: defaults, ids, duplicate names, max < min, repeatable detection
- Annotation tree init: min instances, default values, nested structure
- Add/remove guards: canAdd/canRemove with unbounded, finite, min floor
- Normalize: padding, clamping, dropping unknown keys
- Round-trip: load → edit → serialize → reload preserves data
- Extra/unknown field preservation
- Prune: trailing empty removal, min retention

## Type Checking

```bash
npm run typecheck
```

Runs `tsc -b --noEmit` using TypeScript project references (`tsconfig.json` → `tsconfig.app.json` + `tsconfig.node.json`).

## Continuous Integration

```bash
./scripts/ci.sh          # run the full CI pipeline locally
SKIP_INSTALL=1 ./scripts/ci.sh   # skip `npm ci` when deps are already installed
```

`scripts/ci.sh` is the single source of truth for "does the app build and pass its checks". It runs, in order: dependency install (`npm ci`, or `npm install` if no lockfile), `npm run typecheck`, `npm test`, and `npm run build`. It is `set -euo pipefail` and `cd`s to the repo root, so it works from any directory and fails fast.

The GitHub Actions workflow `.github/workflows/ci.yml` runs on every push to `main` and on **every pull request, whatever it targets** (and via manual `workflow_dispatch`). The pull-request trigger is deliberately not scoped to `main`: a PR onto a release branch needs the same checks as one onto main, and not combining it with a push-on-every-branch trigger avoids building twice for each push on a branch that already has an open PR. A `concurrency` group keyed by workflow + ref cancels the runs a newer commit supersedes. The job itself is deliberately thin — checkout, `actions/setup-node` (Node 24, npm cache), then `./scripts/ci.sh`. Keeping the real work in the shell script means the same checks run locally and the pipeline can be ported to another provider (e.g. GitLab CI) by calling the script from that provider's config instead. Note the CI builds the **static SPA** (`npm run build`); it does not run `electron-builder` (which needs per-OS runners) — `npm run typecheck` still compiles the Electron main/preload TypeScript via the `tsconfig.node.json` project reference.

### Release builds (desktop installers)

```bash
./scripts/build-electron.sh          # build the installer for the current OS into ./release/
SKIP_INSTALL=1 ./scripts/build-electron.sh   # skip `npm ci`
```

`scripts/build-electron.sh` wraps `npm run build:electron`; electron-builder auto-detects the host OS and emits the matching target (dmg / nsis `.exe` / AppImage).

**`electron-builder --publish never` is load-bearing.** Its default is `onTagOrDraft`, so on CI (which it auto-detects) against a tag ref it tries to publish to GitHub *itself* and dies with `GitHub Personal Access Token is not set … "GH_TOKEN"`. We don't want it publishing: the release workflow attaches the artifacts with `softprops/action-gh-release`. `never` makes the build a pure build — no token needed, and the script behaves identically on a laptop and on CI. Don't drop the flag (or add a `GH_TOKEN`) unless you intend to move publishing into electron-builder.

Note that `package.json`'s `build.publish` block *is* set — `{ provider: "github", owner: "Gram21", repo: "SaiLoR" }`. That is **not** for publishing on build (the `--publish never` flag above overrides that), but for the in-app self-updater: `electron-updater` reads it at runtime to find the GitHub releases it checks for updates on Windows/Linux. The `latest.yml` / `latest-linux.yml` and `*.exe.blockmap` files the release workflow now attaches (alongside the installers) are exactly the update metadata `electron-updater` downloads, so they must ship with every release or the win/linux auto-update has nothing to find. macOS does not get this flow (no reliable unsigned auto-update path — see the *macOS code signing* note below), so it has no `latest-mac.yml` and keeps the manual check-only banner.

**macOS code signing.** The builds are **not** signed with an Apple Developer ID and are **not** notarized. Left alone, electron-builder ships the app with only the linker-signed stub the toolchain emits — not a valid bundle signature (`codesign --verify` fails; the identifier reads `Electron`, not our appId). Once downloaded, the app also carries the quarantine flag, and macOS reports that combination as **"SaiLoR is damaged and can't be opened"** — a dead end, since the usual right-click → *Open* escape hatch does not apply to "damaged".

`scripts/afterPack.cjs` therefore **ad-hoc signs** the bundle (`codesign --force --deep --sign -`). That costs nothing — no Apple account — and produces a signature that actually verifies, which downgrades the error to the ordinary *"unidentified developer"* prompt the user can bypass (right-click → *Open*, or *System Settings → Privacy & Security → Open Anyway*). The hook no-ops when `CSC_LINK`/`CSC_NAME` is set, so it never clobbers a real signature.

To remove the prompt entirely you need the **Apple Developer Program** ($99/yr): add a *Developer ID Application* certificate and set `CSC_LINK` (base64 `.p12`) + `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization, as repo secrets exposed to the release job. electron-builder then signs and notarizes automatically.

Users who already have a "damaged" copy can fix it in place by clearing the quarantine flag: `xattr -cr "/Applications/SaiLoR.app"`.

**macOS architectures.** The mac target builds **both** `arm64` (Apple Silicon) and `x64` (Intel) dmgs — the first release shipped arm64 only, leaving Intel users with nothing that ran. `artifactName` puts the arch in the file name so the two are tellable apart.

The workflow `.github/workflows/release.yml` runs when a GitHub **release is published**. It fans out over a matrix of `macos-latest`, `windows-latest`, and `ubuntu-latest`, runs `./scripts/build-electron.sh` on each, and then attaches the OS-specific installer plus the `electron-updater` metadata to the release via `softprops/action-gh-release`: `release/*.dmg` on mac, `release/*.exe` + `release/*.exe.blockmap` + `release/latest.yml` on Windows, and `release/*.AppImage` + `release/latest-linux.yml` on Linux. The Windows/Linux extras are the update feed `electron-updater` downloads at runtime (see the `--publish never` note above), so omitting them from a release breaks the in-app self-updater for that platform; macOS has no equivalent. Each job also uploads its artifact to the workflow run (`actions/upload-artifact`), so a manual `workflow_dispatch` run — which has no release to attach to — still produces downloadable installers. The builds are unsigned (no code-signing certificates are configured). As with CI, the build logic lives in the shell script so it stays runnable locally and portable across providers.

**OpenWiki auto-update.** A separate scheduled workflow `.github/workflows/openwiki.yml` runs weekly (Mondays 06:00 UTC) and on demand. It first checks whether `main` had any non-`openwiki/**` commits in the last 7 days; only if so does it install and run the `openwiki` CLI (needs the `OPENROUTER_API_KEY` repo secret) and open a `docs: update OpenWiki` pull request. This regenerates these docs from the code, so prefer keeping manual doc edits and the code they describe in sync — see also the manual refresh guidance around `.last-update.json`.

The CLI unconditionally re-scaffolds its own recurrence setup on every run — it (re)writes `.github/workflows/openwiki-update.yml` with its own default schedule/env, and refreshes `OPENWIKI:START/END`-delimited snippets in `AGENTS.md` and `CLAUDE.md`. This workflow file is the intentionally customized replacement, so none of that scaffolding must reach the PR: the job explicitly `rm -f .github/workflows/openwiki-update.yml` and `git checkout -- AGENTS.md CLAUDE.md` before creating the pull request. `add-paths: openwiki` already keeps those files out of the commit, but discarding them here is an independent guarantee that doesn't rely on that field never being widened.

## Wiki sync

These pages are mirrored to the repository's [GitHub wiki](https://github.com/Gram21/SaiLoR/wiki), in both directions, by two workflows:

| Workflow | Fires on | Does |
|---|---|---|
| `.github/workflows/wiki-publish.yml` | push to `main` touching `openwiki/**` | Replaces the wiki with the contents of `openwiki/` |
| `.github/workflows/wiki-import.yml` | `gollum` (a wiki page is created/edited, in the browser or by pushing to `SaiLoR.wiki.git`) | Copies the wiki's pages back into `openwiki/` and commits to `main` |

`openwiki/` is the **source of truth**: publishing is a *replace*, not a merge, so a page deleted from the folder disappears from the wiki. Only `*.md` files are pages — `.last-update.json` is state for the OpenWiki generator and is never published, and never clobbered by an import. `INSTRUCTIONS.md` is likewise never published: it's the brief handed *to* the generator (`.github/workflows/openwiki.yml`), not a page it writes, so a wiki visitor has no use for it and `check-wiki-links.js` doesn't require it to be reachable from `_Sidebar.md` either.

**Open Knowledge Format.** OpenWiki writes these pages in Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), which adds two things on top of the plain markdown these pages otherwise are:

- A `---`-delimited YAML frontmatter block (`type`, and optionally `title`/`description`/`tags`/`timestamp`) at the top of most pages. GitHub's wiki renderer (gollum) has no concept of frontmatter — left in place it would render as literal text at the top of every page — so `wiki-publish.yml` strips it before mirroring, and `check-wiki-links.js` strips it before scanning for headings and links, so a frontmatter line is never mistaken for either. Frontmatter does not round-trip through a wiki edit: a page a human edits on the wiki has none by the time `wiki-import.yml` copies it back into `openwiki/`, and the next `openwiki --update` run regenerates it fresh anyway.
- Two reserved filenames. `index.md` is OKF's own directory listing, meant for progressive disclosure by an agent reading the `openwiki/` folder directly rather than by a wiki visitor — it is treated like `.last-update.json` above, generator bookkeeping that is never published, since `Home.md` + `_Sidebar.md` already are the curated equivalent for that second audience and a second, unlinked "index" page would only be redundant clutter (note this is unrelated to the `wiki-sync:auto-home` fallback below, which *synthesizes into `Home.md` itself*, never into a file called `index.md`). `log.md` is OKF's chronological changelog of documentation updates; it has no such overlap with an existing page and is published like any ordinary one — meaning it needs a `_Sidebar.md` entry the same as any other new page, and `check-wiki-links.js` will fail the build with "the page would be orphaned" until it gets one.

**Landing page and navigation.** Two files are wiki chrome rather than ordinary documentation, and both live in `openwiki/` like any other page:

- **`Home.md`** — the wiki's landing page: a short overview and a table of contents. GitHub shows it when you open the Wiki tab.
- **`_Sidebar.md`** — rendered by GitHub as a sidebar on *every* wiki page, so the table of contents is always in reach. It links to each page and to its main sections; if you add or rename a page (or an `##` heading that it links to), update it.
- **`_Footer.md`** — rendered at the foot of *every* wiki page. It carries the things that belong on each page rather than on one: that these pages are a mirror of `openwiki/`, where the repository, issues and releases are, and the licence.

Both round-trip through the sync like any other page. Should `Home.md` ever be deleted, `wiki-publish.yml` falls back to synthesizing an index page (linking each page, titled from its first heading, skipping `Home` and the `_`-prefixed special pages) and stamps it with an HTML comment marker, `wiki-sync:auto-home`. `wiki-import.yml` recognises that marker and drops the file instead of copying it back, so a generated index never leaks into the repository.

**Loop prevention.** The two workflows write to each other's trigger, so they could in principle ping-pong forever. Three independent guards stop that:

1. **The token.** Both push using `GITHUB_TOKEN`, and GitHub does not raise workflow-triggering events for it: *"With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all."* So a publish's wiki push raises no `gollum`, and an import's commit to `main` raises no `push`. On its own this is already sufficient — but it silently stops being true if anyone swaps in a PAT (a tempting fix when a protected branch rejects the import's push), which is why the other two exist.
2. **Content.** Neither workflow commits when the mirror is already identical (`git diff --cached --quiet` → exit). This makes the sync *converge* rather than merely be suppressed: a wiki edit imports, the next publish may push once more (the auto-generated index legitimately gains the new page), and the import after that finds nothing to do. Worst case is one extra hop, then silence — with **no** reliance on guard 1.
3. **Provenance.** Sync commits carry a `[wiki-sync]` marker, which `wiki-publish.yml` skips; `wiki-import.yml` ignores wiki writes whose sender is `github-actions[bot]`.

Both workflows share a `concurrency: wiki-sync` group (with `cancel-in-progress: false`), so the two directions can never run at once and race on the same wiki.

**Two things to know before the first run.** A repository's wiki does not exist as a git repo until its first page is saved — open the Wiki tab and save any page once, or `wiki-publish.yml` fails with a clone error telling you so. And `wiki-import.yml` **pushes straight to `main`**: if `main` is ever protected, that push is rejected and the workflow will need a PAT (see guard 1) or converting to a pull request.

## Deployment

### Discontinued: static hosting and Docker self-hosting

SaiLoR used to support two server-based deployments: copying `dist/` behind a static host (with a
project loaded via `?project=<url>`), and a bundled `docker-compose.yml`/`Dockerfile` self-hosting
setup on port 8080. **Both are discontinued and removed.** The `?project=<url>` loader and the
browser's PDF-fetching adapter it depended on were deleted (see "SaiLoR is Electron-desktop-only"
above), and the `Dockerfile`, `docker-compose.yml`, `Dockerfile.dev`, and `nginx.conf` files that
built/served the static SPA were deleted from the repo — only `Dockerfile.electron` and a trimmed
`docker-compose.dev.yml` (building the desktop installer, see "Dev in Docker" above) remain.

### Desktop

Distribute the `release/` installers produced by `electron-builder`. The desktop app opens local JSON files via native dialog and serves PDFs through the `slr-file://` protocol with no server needed.

**User data after the rename.** The Electron user-data directory follows the product name, so desktop settings and recents now live in `~/Library/Application Support/SaiLoR` on macOS (and the platform equivalents elsewhere) instead of the old `SLR Helper` folder. On first run the app migrates the old folder, so upgrading users keep their recent projects and window size.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + O` | Open project file |
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + Shift + S` | Save as… |
| `Ctrl/Cmd + Z` | Undo annotation change |
| `Ctrl/Cmd + Shift + Z` / `Ctrl + Y` | Redo annotation change |
| `Ctrl/Cmd + F` | Open the in-PDF search bar (focuses the field) |
| `Ctrl/Cmd + +` / `-` / `0` | Zoom the PDF in / out / reset |
| `Ctrl/Cmd + Shift + +` / `-` / `0` | App font size larger / smaller / reset |
| `Alt + ↓` or `]` | Next paper |
| `Alt + ↑` or `[` | Previous paper |
| `F1` | Open help dialog |
| `Ctrl/Cmd + C/V/X` | Native copy/paste/cut (browser or Electron Edit menu) |
| `I` / `E` / `U` | Screening only: include / exclude / un-decide the current paper |
| `1`–`9` | Screening only: exclude with the Nth configured reason |

Note: plain `Ctrl/Cmd +/-/0` zooms the **PDF paper**; adding **Shift** scales the **app font**. (On a US keyboard "+" is `Shift+=`, so PDF zoom-in is `Ctrl+=`; on layouts with a dedicated `+` key it maps to `Ctrl++` directly.)

Undo and redo operate on annotation changes. The store keeps session-only history snapshots in `src/state/store.ts`, and consecutive edits to the same field collapse into a single undo step instead of one step per keystroke. Add/remove instance actions also create their own history entries.

In Electron, the Edit menu routes Undo/Redo back into the renderer through IPC; in the browser, `src/hooks/useKeybindings.ts` handles `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl+Y` directly. If you change annotation editing behavior, update the store and the Electron/menu wiring together so the shortcuts stay consistent across runtimes.

**In the project editor** the same shortcuts drive the *draft* instead: `Ctrl/Cmd+S` saves the JSON (staying in the editor), `Ctrl/Cmd+Shift+S` picks a new location and saves there, and `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` undo/redo schema and paper edits (consecutive keystrokes in one input collapse into a single undo step). Both `useKeybindings` and `useElectronCloseGuard` check `useEditorStore.getState().open` and route to the editor store when it is; the project-only bindings (open, paper navigation, PDF zoom) go inert there, since no project is on screen. Copy/cut/paste are never intercepted — they stay native in both runtimes. Both close guards treat an unsaved *draft* as unsaved changes (the Electron quit dialog and the browser's `beforeunload`). Symmetrically, **closing the editor discards the draft outright** — `close()` clears `dirty` and the draft's undo history, because the user was asked and said not to save. Leaving `dirty` set there is what once made quitting *after* discarding a draft still claim there were unsaved changes.


Paper navigation with `[`/`]` is disabled when typing in an input field; Alt-arrow navigation works even inside fields. See `src/hooks/useKeybindings.ts`.

## Saving Behavior

SaiLoR is Electron-only now, so there is one save path: **Save** writes `project.json` plus the
changed files under `annotations/` to the opened file's location; **Save as…** opens the native save
dialog, then does the same at the new location. See [Data Model](data-model)'s "On-disk layout" and
"Assembling and splitting on disk" for exactly what gets written. (The browser's File System Access
API / download-fallback save paths this table used to compare against were deleted along with the
rest of `src/platform/browser.ts` — see "SaiLoR is Electron-desktop-only" above.)

## Git

**Prerequisite: `git` on this machine's `PATH`.** SaiLoR runs your own `git` binary; it does not
bundle one. *Import from remote git…* and the toolbar's **Git** button are shown disabled, with git's own
error, when `git --version` fails at launch (`GitPlatform.probe()`).

**On macOS specifically, a packaged app's `PATH` does not include Homebrew's `/opt/homebrew/bin`**
(or `/usr/local/bin` on Intel). `/usr/bin/git` — Apple's own Command Line Tools git, or a stub that
offers to install them — is normally found regardless, but a Homebrew-only `git` with nothing at
`/usr/bin/git` will not be. This is a known limitation, documented rather than worked around: there
is no reliable, portable way to guess at a user's shell-configured `PATH` from a GUI app launched
outside a shell, and hard-coding a list of common install locations would be exactly the kind of
brittle guess this codebase avoids elsewhere. If *Import from remote git…* is dimmed on macOS and you know
git is installed, check `which git` in a terminal against what a GUI-launched app actually sees.

Git support is Electron-only: clone, status, commit (with field-level review), pull (with
field-level merge), and push, using the real `git` binary and its config. The old browser build's
"controls stay visible, dimmed" fallback no longer applies — the web build never renders the toolbar
at all now (see "SaiLoR is Electron-desktop-only" above) — but see `architecture.md`'s "Git" section
for why there would have been nothing to fall back to even if it did.

**Credentials are never handled by SaiLoR.** Every git operation runs through the user's own
credential helper, SSH agent, and host-key configuration, exactly as a terminal `git` command would.
The one thing that is turned off is a *terminal* prompt (`GIT_TERMINAL_PROMPT=0`) — there is no
terminal for git to prompt at, so leaving that on would hang the app instead of failing honestly.

**A repository's own config is overridden, because a received folder is untrusted input.** Several
`.git/config` keys name commands git runs, and a project folder that arrives by zip, USB, or shared
drive brings its `.git/` along. A hostile `core.fsmonitor` executes on `git status` — one click on
the **Git** button — and `git:info` runs automatically on project open, so this is reachable without
the user doing anything git-shaped at all. Every git call therefore passes fixed `-c` overrides
(`core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.editor`, `core.alternateRefsCommand`,
`uploadpack.packObjectsHook`, `protocol.ext.allow`), which outrank every config file.

Two practical consequences worth knowing:

- **Your repository's hooks do not run** for operations SaiLoR performs. If you rely on a
  `pre-commit` hook, run those commits from a terminal.
- **Your credential helper, SSH command and signing program are untouched**, so authentication and
  commit signing work exactly as they do in a terminal. Those only run on an explicit network action
  you asked for, never on merely opening a folder.

`filter.*` clean/smudge drivers cannot be overridden this way and remain the known residual; they run
only on an explicit commit or pull. See `architecture.md`'s "The repository's own config is not
trusted" for the full reasoning, including why `diff.external` is handled with `--no-ext-diff` on the
diff call instead of an override.

**What `git → Commit` does for the project's own file**: when it is a tracked modification that
parses as a project on both HEAD and the working tree, its changes are listed field by field —
"Title: Was `X`, now `Y`" — instead of one whole-file tick. Each row is **Use** (commit the new
value), **Ignore** (leave it uncommitted, offered again next time), or **Discard** (revert it, but
only once Commit is actually pressed — picking Discard does not touch the file by itself). Coupled
fields, like an abstract and whether it was PDF-extracted, are shown as one row. Every other changed
file — and the project file itself, when a schema/reviewer-count/etc. change makes field-level review
impossible — keeps the plain whole-file checkbox. See `architecture.md`'s "Field-level commit review"
for the mechanics.

**What `git → Pull` does**: fetches, and either fast-forwards, reports up to date, or — on a genuine
divergence — reads the three revisions of the project JSON and merges them field by field (see
`data-model.md`'s "Merging two copies of a project"). Any field both sides changed, differently, is
shown in a resolution list; nothing is committed until every row has been decided.

**Known limits, by design, not oversight:**

- **No upstream configured** — surfaces as git's own message, naming the command to fix it; SaiLoR
  does not run `--set-upstream` on your behalf.
- **A conflict outside the project JSON** (a PDF, a `.gitignore`, anything else git could not merge
  on its own) — the git merge is aborted cleanly and handed back; resolve it with git directly, then
  pull again.
- **A schema (or `config.reviewers`, `config.screening`, `version`, `provenance`, `protocol`, or an
  unrelated `extra` field) changed on both sides, differently** — the whole merge is refused, naming
  what could not be reconciled, rather than guessing a field-level answer for something that reshapes
  the file (or, for `provenance`/`protocol`, simply has no field-level shape to guess at).
- **No live clone progress bar, and no cancel button** — a spinner and an elapsed-seconds counter
  say "this has not frozen"; a genuinely stuck clone times out after 15 minutes. See
  `architecture.md`'s "Rejected: streamed clone progress and a cancel button" for the reasoning.
- **No branch switching, remote management, or history browsing** — out of scope for this feature.

## PDF Loading

On the desktop app, PDFs are read straight off disk via the custom `slr-file://` protocol — the main
process resolves each paper's `pdf` path relative to the project directory, with no folder-grant
prompt and no server involved. (The browser build used to need a one-time folder-access grant — via
the File System Access API or a `webkitdirectory` `<input>` fallback — and a server-mode fetch path
for `?project=<url>` loads; all of that was deleted along with `src/platform/browser.ts`. See "SaiLoR
is Electron-desktop-only" above.)

## AI-assisted annotation: setting up an LLM target

The **✦ AI** button in the annotation column asks a model to propose values for the fields of the current paper that are still empty. It does nothing until a **target** is configured — a provider, a model name, and the API key to reach it.

**The button is off by default in this build, for every project, regardless of `config.ai`.** See "Availability is gated twice" in `architecture.md` for the mechanism and why — if you're trying to exercise this feature locally (dev, testing, a demo) and the button stays greyed out even with a target configured, that gate — not a missing target — is almost always why. `config.ai: false` still forbids it unconditionally either way.

### Setting one up

1. Open a project, select a paper, and press **✦ AI** → **Set up an LLM…** (or the ⚙ button in the dialog).
2. **+ Add target**, then fill in:
   - **Name** — what you pick from later, e.g. *Claude (work key)*.
   - **Provider** — Anthropic, OpenAI, Google (Gemini), OpenRouter, Groq, Mistral, DeepSeek, xAI
     (Grok), or **OpenAI-compatible** (anything speaking `/v1/chat/completions`: LM Studio,
     llama.cpp, vLLM, a gateway…). Google is the one native (non-OpenAI-shaped) API besides
     Anthropic — see `src/llm/providers.ts`.
   - **Base URL** — fixed and read-only for every named provider; editable **only** for
     OpenAI-compatible, where you enter your server's root (`http://localhost:1234`). Any of the
     root, `…/v1`, or the full `…/v1/chat/completions` works — `join()` in `src/llm/providers.ts`
     will not duplicate what you typed.
   - **API key** — pasted once; see below for where it ends up.
   - **Model** — a searchable dropdown once the app has fetched the provider's own model list
     (**Load models**, or automatic when editing a target that already has a key stored — fetching
     needs a key, same as Verify setup). You can still type a name that isn't in the list: the field
     is free text, and only turns red — with a tooltip — once you leave it with something the loaded
     list doesn't recognize. An unknown model is rejected by the *provider*, not by the app, so
     the red flag is a hint to double-check, not a hard block.
   - **Reasoning effort** — shown only for a model the app knows supports it (from the provider's
     own model-list response, or a documented allowlist for providers whose list doesn't say —
     see `architecture.md`). Defaults to *medium* the moment such a model is picked. Higher effort
     is generally slower and more expensive.
   - **Send the paper as** — *Extracted text* (default: smaller, cheaper, works everywhere) or
     *The PDF itself* (Anthropic / OpenAI / Google / OpenRouter only — the rest have no way to take
     a PDF in a single request; keeps tables and figures intact, costs far more, and is the only way
     to read a scanned paper).
3. **Verify setup** sends a one-word test request and shows the model's reply — or the provider's own error. **It saves the target first**, because the key has to be stored before anything can use it. Use it: a wrong key, model name or URL is much cheaper to discover here than after waiting on a full paper.

Several targets may coexist; the last one used is remembered in `localStorage` under `slr.llm.selected`.

A fetched model list is cached for an hour per target (**Refresh** bypasses that). It is *not*
what makes an unlisted model name work or not work — that's always the provider's call — it only
drives the dropdown and the red-field hint.

### Disclosure: every AI use is recorded in the saved file

Once a proposed value from a run is applied to a paper, the file gains a permanent `aiUsage` entry
on that paper — provider, model, and a timestamp — even after the values themselves are later
edited by hand. This is a disclosure record, not a UI hint like the blue "unconfirmed" borders
(which are session-only and never saved): it exists so a co-reviewer, or you yourself later, can
see that a paper had AI involvement at all, and with what. A paper AI was never used on carries no
such entry — see `docs/annotation-schema.md` §5 for the exact shape.

### Where the API key is stored

The key lives in `llm-config.json` in `app.getPath('userData')`, file mode `0600`, encrypted with
Electron's **`safeStorage`** — the OS keychain (Keychain on macOS, DPAPI on Windows, a Secret Service
keyring on Linux). The key is held by the **main process** and never handed to the renderer; the page
only ever learns `hasKey: true`.

Notes:

- If `safeStorage.isEncryptionAvailable()` is false, the desktop app **refuses to save the key** rather than writing it in the clear — the user is told, and the rest of the app keeps working.
- **On Linux, `safeStorage` can report "available" while using a weak fallback backend** (`basic_text`) when no keyring/Secret Service is running — the encryption is then little more than obfuscation. The app cannot tell the difference. If the key matters, run the desktop app on a session with a working keyring (gnome-keyring / kwallet), or use a scoped, revocable key.
- Deleting a target deletes its stored key with it. A stored key is never shown again, so an edit that leaves the key box blank keeps the existing one.

The request itself is sent by the Electron **main process** (`net.fetch`), which has no origin and no
CORS check. (The web build used to store the key unencrypted in `localStorage` and send the request
from the page, which meant fighting CORS per provider — all of that, including
`BrowserAdapter.callLlm`, was deleted along with the rest of `src/platform/browser.ts`; see "SaiLoR is
Electron-desktop-only" above.)

### Operational notes

- **What leaves the machine**: the paper's extracted text (or the PDF itself, if the target is configured that way) plus the annotation schema, sent to whichever provider the target names. Nothing else. The dialog states this before anything is sent, and the button proposes values only — nothing is written into the project until the reviewer presses **Apply**.
- **A scanned PDF yields no text.** The run stops with an error rather than sending a title and inviting the model to invent a paper from it; the fix is to switch that target to *The PDF itself*, if the provider supports it.
- **Cost** scales with the paper: a long paper as extracted text is a large prompt, and the PDF path is far more expensive again.

## Change Guidance

- **Adding a new npm script**: Add to `scripts` in `package.json`. The existing scripts use `cross-env` for environment variables (needed because `ELECTRON=1` must be set cross-platform).
- **Changing the Vite config**: `vite.config.ts` is the single config for both Vite build and Vitest. The `ELECTRON=1` flag conditionally includes the electron plugin. The `base: './'` is important for Electron `file://` loading — do not change to `/`.
- **Adding electron-builder targets**: Update the `build` section in `package.json`. Current targets are dmg (mac), nsis (win), AppImage (linux). If the new target should be served by the in-app self-updater, also add its `latest-*.yml` / `*.blockmap` artifacts to the `release.yml` matrix and ensure `build.publish` points at the right GitHub repo — `electron-updater` reads that feed at runtime (see the `--publish never` note above). macOS is deliberately excluded from auto-update.
- **Adding new test files**: Place as `*.test.ts` or `*.test.tsx` anywhere under `src/`. The vitest `include` pattern is `src/**/*.test.{ts,tsx}`.
- **TypeScript config**: Uses project references — `tsconfig.json` references `tsconfig.app.json` (renderer/src code) and `tsconfig.node.json` (electron + vite config). `tsc -b` builds both.
- **Changing what CI runs**: Edit `scripts/ci.sh` (the source of truth), not the GitHub workflow. `.github/workflows/ci.yml` only provides the Node toolchain and calls the script, so any change stays in sync with local runs and portable to other CI providers.
