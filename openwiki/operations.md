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

Output directory: `release/`. The `appId` is `org.slr.helper`, product name "SLR Helper". ASAR packaging is enabled. Files included: `dist/**/*` and `dist-electron/**/*`.

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch  # vitest in watch mode
```

Tests live in `src/**/*.test.{ts,tsx}`. Currently `src/model/model.test.ts` covers the entire model layer. Vitest is configured with jsdom environment and global test APIs (describe/it/expect available without import, though the test file imports them explicitly).

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

### Server deployment

Copy `dist/` behind any static host. Place the project JSON and its `pdfs/` directory alongside (or at the URL referenced by `?project=`). Link to a hosted project:

```
https://your.host/?project=/reviews/2026/project.json
```

PDF paths in the project file are resolved relative to the project URL (via `BrowserAdapter.setServerBase()`). The `getPdfSource` method fetches each PDF and creates a blob URL for react-pdf.

### Desktop deployment

Distribute the `release/` installers produced by `electron-builder`. The desktop app opens local JSON files via native dialog and serves PDFs through the `slr-file://` protocol with no server needed.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + S` | Save |
| `Ctrl/Cmd + Shift + S` | Save as… |
| `Alt + ↓` or `]` | Next paper |
| `Alt + ↑` or `[` | Previous paper |
| `Ctrl/Cmd + C/V/X/Z` | Native copy/paste/cut/undo (browser or Electron Edit menu) |

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
