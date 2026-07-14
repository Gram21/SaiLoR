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

Output directory: `release/`. The `appId` is `org.slr.helper`, product name "SLR Helper". ASAR packaging is enabled.

**Package-size optimizations** (in the `build` config): the renderer and main process are fully bundled by Vite, so nothing needs `node_modules` at runtime — the `files` list is `dist/**/*` + `dist-electron/**/*` + `build/icon.png`, with `!node_modules/**/*` (drops ~100 MB, mostly the unused native `canvas` dep pulled in by `pdfjs-dist`) and `!**/*.map` (source maps stay in the web `dist/` but are excluded from the app). `electronLanguages: ["en-US"]` keeps only one Chromium locale (~40 MB → ~0.5 MB), and `compression: "maximum"` shrinks the installer. These take the Linux AppImage from ~137 MB to ~80 MB. The remaining size is the Electron/Chromium runtime itself, which is fixed. Node integration is already disabled in the renderer (`contextIsolation: true`, `nodeIntegration: false`).

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch  # vitest in watch mode
```

Tests live in `src/**/*.test.{ts,tsx}`. `src/model/model.test.ts` covers the model layer, and `src/state/store.test.ts` covers the store's undo/redo history (field-edit coalescing, add/remove undo, redo-stack clearing). Vitest is configured with jsdom environment and global test APIs (describe/it/expect available without import, though the test files import them explicitly).

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

This serves the app on `http://localhost:8080`. Project JSON files and PDFs go in the `./projects/` directory, which is mounted read-only into the container at `/usr/share/nginx/html/projects`. Open a project:

```
http://localhost:8080/?project=/projects/project.example.json
```

The `nginx.conf` adds the correct MIME type for `.mjs` files (needed by the pdf.js worker), sets immutable caching for hashed `/assets/`, serves `/projects/` with permissive CORS headers, and falls back to `index.html` for SPA routing.

Equivalent raw Docker commands:

```bash
docker build -t slr-helper .
docker run -d -p 8080:80 -v "$PWD/projects:/usr/share/nginx/html/projects:ro" slr-helper
```

### C. Desktop

Distribute the `release/` installers produced by `electron-builder`. The desktop app opens local JSON files via native dialog and serves PDFs through the `slr-file://` protocol with no server needed.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + O` | Open project file |
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + Shift + S` | Save as… |
| `Ctrl/Cmd + Z` | Undo annotation change |
| `Ctrl/Cmd + Shift + Z` / `Ctrl + Y` | Redo annotation change |
| `Ctrl/Cmd + +` / `-` / `0` | Zoom the PDF in / out / reset |
| `Ctrl/Cmd + Shift + +` / `-` / `0` | App font size larger / smaller / reset |
| `Alt + ↓` or `]` | Next paper |
| `Alt + ↑` or `[` | Previous paper |
| `F1` | Open help dialog |
| `Ctrl/Cmd + C/V/X` | Native copy/paste/cut (browser or Electron Edit menu) |

Note: plain `Ctrl/Cmd +/-/0` zooms the **PDF paper**; adding **Shift** scales the **app font**. (On a US keyboard "+" is `Shift+=`, so PDF zoom-in is `Ctrl+=`; on layouts with a dedicated `+` key it maps to `Ctrl++` directly.)

Undo and redo operate on annotation changes. The store keeps session-only history snapshots in `src/state/store.ts`, and consecutive edits to the same field collapse into a single undo step instead of one step per keystroke. Add/remove instance actions also create their own history entries.

In Electron, the Edit menu routes Undo/Redo back into the renderer through IPC; in the browser, `src/hooks/useKeybindings.ts` handles `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl+Y` directly. If you change annotation editing behavior, update the store and the Electron/menu wiring together so the shortcuts stay consistent across runtimes.


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
