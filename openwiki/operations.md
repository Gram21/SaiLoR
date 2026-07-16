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

The first `dev:electron` after a fresh `npm ci` prints `Downloading Electron binary…` and pauses for a minute: since Electron 40 the package ships no install script and fetches its ~200 MB runtime lazily, on first use. This is also why the toolchain requires **Electron ≥ 40**: earlier versions extracted that runtime with `extract-zip@2.0.1`, which hangs silently on Node ≥ 26 and leaves behind a stub `node_modules/electron/dist` — the app then dies with *"Electron failed to install correctly"*. Downgrading Node is the other way out; upgrading Electron is the one this project took.

### npm install-script approval

npm ≥ 11.17 blocks dependency install scripts until they are approved, and records the approvals in `package.json` under `allowScripts`. Only **esbuild** is approved (it downloads its native binary; Vite needs it). `canvas` — the native dependency `pdfjs-dist` pulls in but the app never loads, and which is excluded from the packaged build — is deliberately left blocked. If a fresh clone fails with a missing esbuild binary, run `npm approve-scripts --allow-scripts-pending` to see what is pending. Older npm ignores the field and runs everything, so CI (Node 24) is unaffected.

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

The GitHub Actions workflow `.github/workflows/ci.yml` runs on every push to `main` and on **every pull request, whatever it targets** (and via manual `workflow_dispatch`). The pull-request trigger is deliberately not scoped to `main`: a PR onto a release branch needs the same checks as one onto main, and not combining it with a push-on-every-branch trigger avoids building twice for each push on a branch that already has an open PR. A `concurrency` group keyed by workflow + ref cancels the runs a newer commit supersedes. The job itself is deliberately thin — checkout, `actions/setup-node` (Node 22, npm cache), then `./scripts/ci.sh`. Keeping the real work in the shell script means the same checks run locally and the pipeline can be ported to another provider (e.g. GitLab CI) by calling the script from that provider's config instead. Note the CI builds the **static SPA** (`npm run build`); it does not run `electron-builder` (which needs per-OS runners) — `npm run typecheck` still compiles the Electron main/preload TypeScript via the `tsconfig.node.json` project reference.

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

## Wiki sync

These pages are mirrored to the repository's [GitHub wiki](https://github.com/Gram21/SaiLoR/wiki), in both directions, by two workflows:

| Workflow | Fires on | Does |
|---|---|---|
| `.github/workflows/wiki-publish.yml` | push to `main` touching `openwiki/**` | Replaces the wiki with the contents of `openwiki/` |
| `.github/workflows/wiki-import.yml` | `gollum` (a wiki page is created/edited, in the browser or by pushing to `SaiLoR.wiki.git`) | Copies the wiki's pages back into `openwiki/` and commits to `main` |

`openwiki/` is the **source of truth**: publishing is a *replace*, not a merge, so a page deleted from the folder disappears from the wiki. Only `*.md` files are pages — `.last-update.json` is state for the OpenWiki generator and is never published, and never clobbered by an import.

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

### A. Static hosting

Copy `dist/` behind any static host (nginx, Apache, S3, GitHub Pages). Place the project JSON and its `pdfs/` directory alongside (or at the URL referenced by `?project=`). The `base: './'` Vite config ensures the build works from any subpath. Link to a hosted project:

```
https://your.host/?project=/reviews/2026/project.json
```

PDF paths in the project file are resolved relative to the project URL (via `BrowserAdapter.setServerBase()`). The `getPdfSource` method fetches each PDF and creates a blob URL for react-pdf.

**A missing PDF on a static host frequently does not 404.** Most SPA-style hosts (a dev server, S3+CloudFront with an SPA rewrite rule, an nginx `try_files … /index.html` config) answer any unmatched path with `200` and the app's own `index.html`, rather than a real 404 — so if a PDF's path is wrong, or the `pdfs/` directory wasn't actually deployed alongside the project JSON, the fetch still "succeeds" and hands pdf.js an HTML page instead of a PDF. `getPdfSource` checks the response actually starts with PDF's magic number (`%PDF-`) before trusting it, so this now surfaces as *"the server answered, but not with a PDF"* naming the exact URL it tried — check that URL directly (e.g. `curl -I <url>`) if you see it; it almost always means the PDF isn't actually being served at the path the project JSON references.

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

## PDF Loading in the Browser Build

Opening a **local** project file (any "Open…" that isn't a `?project=<url>` server-mode load) shows a one-time in-app prompt the first time you view a paper — *"SaiLoR needs to know where this project's PDFs are"* — with a **Choose folder…** button. Clicking it opens your browser's own folder picker; pick the folder that contains the project JSON (the one with `pdfs/` inside it, not the `pdfs/` folder itself). That grant is then reused for every PDF in the project for the rest of the session; you're not asked again unless you open a different project.

The in-app prompt exists so the native folder dialog never appears out of nowhere the moment you open a paper — particularly on Firefox, whose own dialog frames this as an "upload," which reads as alarming with no context. If you ever see that native dialog without having clicked **Choose folder…** first, something outside the app triggered it (e.g. the AI-annotation flow reading a paper's PDF for a paper you haven't viewed yet) — it's the same one-time-per-session grant either way, just requested by a different caller.

| Runtime | Mechanism |
|---|---|
| Chromium (FSAPI) | `showDirectoryPicker` — a real directory handle, PDFs read lazily by path as you open them |
| Other browsers (Firefox, Safari) | A folder-picking `<input>` (`webkitdirectory`) — reads the whole folder tree at once on the first prompt |
| Server mode (`?project=<url>`) | Fetched from the project's URL; no prompt |

A **local** project's PDFs are never fetched from a URL — there isn't one for them to be at. If you instead see an error naming a URL (*"the server answered, but not with a PDF"*), you're in **server mode**, not the local-folder path above — see the static-hosting note below for what that means and how to fix it.

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

| Runtime | Location | Protection |
|---|---|---|
| **Electron (desktop)** | `llm-config.json` in `app.getPath('userData')`, file mode `0600` | Encrypted with Electron's **`safeStorage`**, i.e. the OS keychain (Keychain on macOS, DPAPI on Windows, a Secret Service keyring on Linux). The key is held by the **main process** and never handed to the renderer; the page only ever learns `hasKey: true`. |
| **Browser (web build)** | `localStorage`, key `slr.llm.configs` | **None. The key is stored in the clear.** Any script on the page, and anyone with access to that browser profile, can read it. The settings dialog says so in red. |

Notes:

- If `safeStorage.isEncryptionAvailable()` is false, the desktop app **refuses to save the key** rather than writing it in the clear — the user is told, and the rest of the app keeps working.
- **On Linux, `safeStorage` can report "available" while using a weak fallback backend** (`basic_text`) when no keyring/Secret Service is running — the encryption is then little more than obfuscation. The app cannot tell the difference. If the key matters, run the desktop app on a session with a working keyring (gnome-keyring / kwallet), or use a scoped, revocable key.
- Deleting a target deletes its stored key with it. A stored key is never shown again, so an edit that leaves the key box blank keeps the existing one.

### Limitations of the web build

The desktop app is the supported path for AI annotation. In the browser two things are genuinely worse, and neither is a bug we can fix from this side:

1. **The key is unencrypted** (above). There is no keychain in a page, and no main process to hold the key out of its reach.
2. **CORS.** The call goes out *from the page*, so it is a cross-origin `POST` and the provider must be willing to answer it:
   - **Anthropic** refuses browser-origin calls unless the caller opts in; the adapter sends `anthropic-dangerous-direct-browser-access: true` for you.
   - **A self-hosted OpenAI-compatible endpoint usually sends no CORS headers at all** and will simply fail — LM Studio, llama.cpp and friends do not expect a browser client. Putting a reverse proxy in front of it that adds the CORS headers is the only fix from outside the app.
   - A cross-origin block surfaces as an opaque `TypeError`, so `BrowserAdapter.callLlm` catches it and re-throws an error naming the likely cause instead of letting it read as "the provider is down".

   The desktop build has none of this: the request is sent by the Electron **main process** (`net.fetch`), which has no origin and no CORS check. See *AI-assisted annotation* in `architecture.md`.

If you use the web build anyway, use a throwaway or tightly scoped key.

### Operational notes

- **What leaves the machine**: the paper's extracted text (or the PDF itself, if the target is configured that way) plus the annotation schema, sent to whichever provider the target names. Nothing else. The dialog states this before anything is sent, and the button proposes values only — nothing is written into the project until the reviewer presses **Apply**.
- **A scanned PDF yields no text.** The run stops with an error rather than sending a title and inviting the model to invent a paper from it; the fix is to switch that target to *The PDF itself*, if the provider supports it.
- **Cost** scales with the paper: a long paper as extracted text is a large prompt, and the PDF path is far more expensive again.

## Change Guidance

- **Adding a new npm script**: Add to `scripts` in `package.json`. The existing scripts use `cross-env` for environment variables (needed because `ELECTRON=1` must be set cross-platform).
- **Changing the Vite config**: `vite.config.ts` is the single config for both Vite build and Vitest. The `ELECTRON=1` flag conditionally includes the electron plugin. The `base: './'` is important for Electron `file://` loading — do not change to `/`.
- **Adding electron-builder targets**: Update the `build` section in `package.json`. Current targets are dmg (mac), nsis (win), AppImage (linux).
- **Adding new test files**: Place as `*.test.ts` or `*.test.tsx` anywhere under `src/`. The vitest `include` pattern is `src/**/*.test.{ts,tsx}`.
- **TypeScript config**: Uses project references — `tsconfig.json` references `tsconfig.app.json` (renderer/src code) and `tsconfig.node.json` (electron + vite config). `tsc -b` builds both.
- **Changing what CI runs**: Edit `scripts/ci.sh` (the source of truth), not the GitHub workflow. `.github/workflows/ci.yml` only provides the Node toolchain and calls the script, so any change stays in sync with local runs and portable to other CI providers.
