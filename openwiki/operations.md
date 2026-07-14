# Operations

## Development

### Web dev (browser)

```bash
npm run dev
```

Starts the Vite dev server at `http://localhost:5173`. Open the bundled example with:

```
http://localhost:5173/?project=/samples/project.example.json
```

The `?project=<url>` query parameter triggers `loadFromUrl()` in `App.tsx`, which fetches the JSON and sets the server base URL for PDF resolution.

### Electron dev (desktop)

```bash
npm run dev:electron
```

Sets `ELECTRON=1` via `cross-env`, which activates the `vite-plugin-electron` plugin in `vite.config.ts`. This builds `electron/main.ts` and `electron/preload.ts` alongside the renderer, then launches the Electron shell loading the Vite dev server URL.

### Dev in Docker (optional)

A separate `docker-compose.dev.yml` (with `Dockerfile.dev` and `Dockerfile.electron`) lets you develop without a local Node install. It is independent of the production `docker-compose.yml` — nothing runs on a plain `docker compose up` — and selects a target with a Compose **profile**:

```bash
# Browser dev server (Vite + HMR) on http://localhost:5173
docker compose -f docker-compose.dev.yml --profile browser up --build

# Build the Electron app (Linux AppImage) into ./release/
docker compose -f docker-compose.dev.yml --profile electron run --rm electron
```

The browser-dev service bind-mounts the source for hot reload (set `VITE_USE_POLLING=1` if file changes aren't detected on macOS/Windows mounts). The electron service is a Debian image that runs `electron-builder`; Windows/macOS installers still need their native OS.

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

**App icon.** `build/icon.svg` is the source of truth; `build/icon.png` (1024×1024, transparent) is generated from it with `npm run icon` and committed, because electron-builder and the dock/taskbar need a raster icon. The script (`scripts/make-icon.cjs`) rasterizes the SVG using the Chromium that Electron already ships, so there is no extra image toolchain to install. Re-run it whenever the SVG changes. `public/favicon.svg` is the web favicon and is maintained by hand alongside it.

**Package-size optimizations** (in the `build` config): the renderer and main process are fully bundled by Vite, so nothing needs `node_modules` at runtime — the `files` list is `dist/**/*` + `dist-electron/**/*` + `build/icon.png`, with `!node_modules/**/*` (drops ~100 MB, mostly the unused native `canvas` dep pulled in by `pdfjs-dist`) and `!**/*.map` (source maps stay in the web `dist/` but are excluded from the app). `electronLanguages: ["en-US"]` keeps only one Chromium locale (~40 MB → ~0.5 MB), and `compression: "maximum"` shrinks the installer. These take the Linux AppImage from ~137 MB to ~80 MB. The remaining size is the Electron/Chromium runtime itself, which is fixed. Node integration is already disabled in the renderer (`contextIsolation: true`, `nodeIntegration: false`).

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch  # vitest in watch mode
```

Tests live in `src/**/*.test.{ts,tsx}`. `src/model/model.test.ts` covers the model layer, `src/state/store.test.ts` covers the store's undo/redo history (field-edit coalescing, add/remove undo, redo-stack clearing), and `src/state/editorStore.test.ts` covers the project editor (schema ⇄ on-disk conversion and round-trip, drag-and-drop tree moves incl. the self/descendant guard, draft validation, and that `buildProjectJson` produces a file the real `loadProject` accepts with annotations preserved). Vitest is configured with jsdom environment and global test APIs (describe/it/expect available without import, though the test files import them explicitly).

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

The GitHub Actions workflow `.github/workflows/ci.yml` runs on every push and pull request to `main` (and via manual `workflow_dispatch`). It is deliberately thin — checkout, `actions/setup-node` (Node 22, npm cache), then `./scripts/ci.sh`. Keeping the real work in the shell script means the same checks run locally and the pipeline can be ported to another provider (e.g. GitLab CI) by calling the script from that provider's config instead. Note the CI builds the **static SPA** (`npm run build`); it does not run `electron-builder` (which needs per-OS runners) — `npm run typecheck` still compiles the Electron main/preload TypeScript via the `tsconfig.node.json` project reference.

### Release builds (desktop installers)

```bash
./scripts/build-electron.sh          # build the installer for the current OS into ./release/
SKIP_INSTALL=1 ./scripts/build-electron.sh   # skip `npm ci`
```

`scripts/build-electron.sh` wraps `npm run build:electron`; electron-builder auto-detects the host OS and emits the matching target (dmg / nsis `.exe` / AppImage).

**`electron-builder --publish never` is load-bearing.** Its default is `onTagOrDraft`, so on CI (which it auto-detects) against a tag ref it tries to publish to GitHub *itself* and dies with `GitHub Personal Access Token is not set … "GH_TOKEN"`. We don't want it publishing: the release workflow attaches the artifacts with `softprops/action-gh-release`. `never` makes the build a pure build — no token needed, and the script behaves identically on a laptop and on CI. Don't drop the flag (or add a `GH_TOKEN`) unless you intend to move publishing into electron-builder.

**macOS code signing.** The builds are **not** signed with an Apple Developer ID and are **not** notarized. Left alone, electron-builder ships the app with only the linker-signed stub the toolchain emits — not a valid bundle signature (`codesign --verify` fails; the identifier reads `Electron`, not our appId). Once downloaded, the app also carries the quarantine flag, and macOS reports that combination as **"SaiLoR is damaged and can't be opened"** — a dead end, since the usual right-click → *Open* escape hatch does not apply to "damaged".

`scripts/afterPack.cjs` therefore **ad-hoc signs** the bundle (`codesign --force --deep --sign -`). That costs nothing — no Apple account — and produces a signature that actually verifies, which downgrades the error to the ordinary *"unidentified developer"* prompt the user can bypass (right-click → *Open*, or *System Settings → Privacy & Security → Open Anyway*). The hook no-ops when `CSC_LINK`/`CSC_NAME` is set, so it never clobbers a real signature.

To remove the prompt entirely you need the **Apple Developer Program** ($99/yr): add a *Developer ID Application* certificate and set `CSC_LINK` (base64 `.p12`) + `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization, as repo secrets exposed to the release job. electron-builder then signs and notarizes automatically.

Users who already have a "damaged" copy can fix it in place by clearing the quarantine flag: `xattr -cr "/Applications/SaiLoR.app"`.

**macOS architectures.** The mac target builds **both** `arm64` (Apple Silicon) and `x64` (Intel) dmgs — the first release shipped arm64 only, leaving Intel users with nothing that ran. `artifactName` puts the arch in the file name so the two are tellable apart.

The workflow `.github/workflows/release.yml` runs when a GitHub **release is published**. It fans out over a matrix of `macos-latest`, `windows-latest`, and `ubuntu-latest`, runs `./scripts/build-electron.sh` on each, and then attaches the OS-specific installer (`release/*.dmg`, `release/*.exe`, `release/*.AppImage`) to the release via `softprops/action-gh-release`. Each job also uploads its artifact to the workflow run (`actions/upload-artifact`), so a manual `workflow_dispatch` run — which has no release to attach to — still produces downloadable installers. The builds are unsigned (no code-signing certificates are configured). As with CI, the build logic lives in the shell script so it stays runnable locally and portable across providers.

**OpenWiki auto-update.** A separate scheduled workflow `.github/workflows/openwiki.yml` runs weekly (Mondays 06:00 UTC) and on demand. It first checks whether `main` had any non-`openwiki/**` commits in the last 7 days; only if so does it install and run the `openwiki` CLI (needs the `OPENROUTER_API_KEY` repo secret) and open a `docs: update OpenWiki` pull request. This regenerates these docs from the code, so prefer keeping manual doc edits and the code they describe in sync — see also the manual refresh guidance around `.last-update.json`.

## Deployment

### A. Static hosting

Copy `dist/` behind any static host (nginx, Apache, S3, GitHub Pages). Place the project JSON and its `pdfs/` directory alongside (or at the URL referenced by `?project=`). The `base: './'` Vite config ensures the build works from any subpath. Link to a hosted project:

```
https://your.host/?project=/reviews/2026/project.json
```

PDF paths in the project file are resolved relative to the project URL (via `BrowserAdapter.setServerBase()`). The `getPdfSource` method fetches each PDF and creates a blob URL for react-pdf.

### B. Docker (self-hosting)

The repo includes a multi-stage `Dockerfile` (Node build → nginx runtime) and `docker-compose.yml`:

```bash
docker compose up -d --build    # build and start
docker compose down             # stop
```

This serves the app on `http://localhost:8080`. The volume in `docker-compose.yml` mounts a host folder of project JSONs and their PDFs read-only into the container at `/usr/share/nginx/html/projects`, i.e. served under the `/projects/` URL namespace. It defaults to the bundled `./samples` folder, so the example works out of the box; point it at your own folder to use your own reviews. Open a project:

```
http://localhost:8080/?project=/projects/project.example.json
```

The `nginx.conf` adds the correct MIME type for `.mjs` files (needed by the pdf.js worker), sets immutable caching for hashed `/assets/`, serves `/projects/` with permissive CORS headers, and falls back to `index.html` for SPA routing.

Equivalent raw Docker commands:

```bash
docker build -t sailor .
docker run -d -p 8080:80 -v "$PWD/samples:/usr/share/nginx/html/projects:ro" sailor
```

### C. Desktop

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

Note: plain `Ctrl/Cmd +/-/0` zooms the **PDF paper**; adding **Shift** scales the **app font**. (On a US keyboard "+" is `Shift+=`, so PDF zoom-in is `Ctrl+=`; on layouts with a dedicated `+` key it maps to `Ctrl++` directly.)

Undo and redo operate on annotation changes. The store keeps session-only history snapshots in `src/state/store.ts`, and consecutive edits to the same field collapse into a single undo step instead of one step per keystroke. Add/remove instance actions also create their own history entries.

In Electron, the Edit menu routes Undo/Redo back into the renderer through IPC; in the browser, `src/hooks/useKeybindings.ts` handles `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl+Y` directly. If you change annotation editing behavior, update the store and the Electron/menu wiring together so the shortcuts stay consistent across runtimes.

**In the project editor** the same shortcuts drive the *draft* instead: `Ctrl/Cmd+S` saves the JSON (staying in the editor), `Ctrl/Cmd+Shift+S` picks a new location and saves there, and `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` undo/redo schema and paper edits (consecutive keystrokes in one input collapse into a single undo step). Both `useKeybindings` and `useElectronCloseGuard` check `useEditorStore.getState().open` and route to the editor store when it is; the project-only bindings (open, paper navigation, PDF zoom) go inert there, since no project is on screen. Copy/cut/paste are never intercepted — they stay native in both runtimes. The Electron quit dialog also treats an unsaved *draft* as unsaved changes.


Paper navigation with `[`/`]` is disabled when typing in an input field; Alt-arrow navigation works even inside fields. See `src/hooks/useKeybindings.ts`.

## Saving Behavior by Platform

| Platform | Save | Save as… |
|---|---|---|
| Electron | Writes to the opened file path | Native save dialog |
| Chromium (FSAPI) | Writes in-place via retained handle | `showSaveFilePicker` |
| Other browsers | Downloads JSON | Downloads JSON |
| Server mode (no handle) | Falls back to Save as… | Downloads JSON |

## Change Guidance

- **Adding a new npm script**: Add to `scripts` in `package.json`. The existing scripts use `cross-env` for environment variables (needed because `ELECTRON=1` must be set cross-platform).
- **Changing the Vite config**: `vite.config.ts` is the single config for both Vite build and Vitest. The `ELECTRON=1` flag conditionally includes the electron plugin. The `base: './'` is important for Electron `file://` loading — do not change to `/`.
- **Adding electron-builder targets**: Update the `build` section in `package.json`. Current targets are dmg (mac), nsis (win), AppImage (linux).
- **Adding new test files**: Place as `*.test.ts` or `*.test.tsx` anywhere under `src/`. The vitest `include` pattern is `src/**/*.test.{ts,tsx}`.
- **TypeScript config**: Uses project references — `tsconfig.json` references `tsconfig.app.json` (renderer/src code) and `tsconfig.node.json` (electron + vite config). `tsc -b` builds both.
- **Changing what CI runs**: Edit `scripts/ci.sh` (the source of truth), not the GitHub workflow. `.github/workflows/ci.yml` only provides the Node toolchain and calls the script, so any change stays in sync with local runs and portable to other CI providers.
