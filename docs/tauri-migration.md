# Evaluation: Move from Electron to Tauri

Status: proposal. No code changed.
Date: 2026-11-01. Branch: `release/2.0.0`.

## 1. Summary

| Question | Answer |
| --- | --- |
| Is a Rust-based option available? | Yes. Tauri v2 is the mature option. |
| Does the React/Vite renderer stay? | Yes. Most of `src/` stays unchanged. |
| What must be rewritten? | The whole `electron/` main process (about 5,600 lines of TypeScript, 98 IPC handlers). |
| Rough effort | 6–10 weeks for one developer who knows Rust. Add 3–4 weeks if Rust is new. |
| Main gain | Installer size (about 10 MB instead of about 100 MB), lower RAM, Rust-side security boundary. |
| Main risks | System WebView differences (PDF rendering), weaker end-to-end testing, loss of shared TypeScript logic in the main process. |
| Recommendation | Run a 1–2 week spike first. Do not commit to the full migration before the spike passes the go/no-go checks in section 7. |

## 2. What "Rust-based platform" means

Tauri v2 replaces two Electron parts:

| Part | Electron today | Tauri |
| --- | --- | --- |
| Backend ("main process") | Node.js, TypeScript | Rust |
| Web engine | Bundled Chromium (Electron 43) | System WebView |
| IPC | `contextBridge` + `ipcMain.handle` | `#[tauri::command]` + `invoke()` |
| Updater | `electron-updater` + custom Ed25519 check | `tauri-plugin-updater` (signed manifests) |
| Packaging | `electron-builder` (dmg, NSIS, AppImage) | `tauri build` (dmg/app, NSIS/MSI, AppImage/deb) |

System WebView per OS:

- macOS: WKWebView (Safari engine).
- Windows: WebView2 (Chromium, installed or bootstrapped).
- Linux: WebKitGTK (`webkit2gtk-4.1`).

The renderer no longer runs on one fixed Chromium version. It runs on three different engines.

Other options considered:

| Option | Verdict |
| --- | --- |
| Keep Electron, trim size | Lowest risk. Already uses `asar`, max compression, one language pack. |
| Tauri v2 | Best fit for the stated goal. |
| Electrobun / Neutralino | Less mature. Smaller ecosystem for updater, signing, dialogs. |
| Wails (Go) | Same WebView trade-offs as Tauri. Go instead of Rust. Not requested. |
| Native Rust UI (egui, Slint, Dioxus desktop) | Full UI rewrite. PDF annotation UI would need a new PDF renderer. Out of scope. |

## 3. Current Electron footprint (from the code)

| Area | Where | Size / count |
| --- | --- | --- |
| Main process | `electron/main.ts` | 3,593 lines |
| Local LLM runtime (llama.cpp download, spawn, health) | `electron/localRuntime*.ts` | about 700 lines |
| Ollama client | `electron/ollama.ts` | 277 lines |
| Hardware probe, web fetch, feedback, LLM config | `electron/hardware.ts`, `webFetch.ts`, `feedback.ts`, `llmConfig.ts` | about 320 lines |
| Preload bridge (`window.slr`) | `electron/preload.ts` | 205 lines, 101 bridge calls |
| Renderer adapter | `src/platform/electron.ts` | 717 lines |
| IPC handlers | `ipcMain.handle(...)` | 98 |
| Unit tests of the main process | `electron/*.test.ts` | 7 files |
| End-to-end tests | `e2e/*.spec.ts` (Playwright launching real Electron) | 6 files |

Electron features in use, and the Tauri equivalent:

| Electron feature | Use in SaiLoR | Tauri equivalent |
| --- | --- | --- |
| `dialog.showOpenDialog/SaveDialog/MessageBox` | Open/save project, PDFs, exports, unsaved-changes prompt | `tauri-plugin-dialog` or Rust `rfd` |
| Session-authorized path set (`knownProjectPaths`) | Refuse writes to paths not chosen in this session (REQ-PLT-30) | Keep in Rust `State<Mutex<HashSet>>`. Do not use the generic `fs` plugin scope for this. |
| `protocol.handle('slr-file')` + `net.fetch(file://)` | Serve PDFs to pdf.js with path checks | `register_uri_scheme_protocol` with the same checks |
| `safeStorage` | API keys encrypted with OS keychain | `keyring` crate (or Stronghold plugin) |
| `autoUpdater` + signed `latest.yml` | Manual-confirm update, Ed25519 verification | `tauri-plugin-updater` (minisign signatures, `latest.json`) |
| `Menu` template with undo/redo/reload guard | App menu | Tauri menu API |
| Window state persistence | Size and position | `tauri-plugin-window-state` |
| Single instance lock (REQ-PLT-11) | One window | `tauri-plugin-single-instance` |
| `execFile('git', ...)` | All git operations | `std::process::Command` or `tokio::process` |
| `spawn('llama-server')` + `taskkill` | Local runtime | `tokio::process`, kill on drop |
| `pdf-lib` in main | PDF export with marks | Port, or move to renderer (see section 4) |
| `dns` / `net` | SSRF guard in `web:fetch` | `reqwest` + `hickory-resolver` or `std::net` |
| `shell.openExternal`, `will-navigate` guard | External links | `tauri-plugin-opener`, navigation handler |

## 4. The hard part: shared TypeScript

`electron/main.ts` imports about 25 pure TypeScript modules from `src/` (git parsing, project split, PDF marks, update signature, URL/ref validators). The renderer uses the same modules. Tests cover them once.

A Rust backend cannot import these modules. Choose one strategy per module:

| Strategy | Effect | Use for |
| --- | --- | --- |
| A. Move logic to the renderer, keep Rust as a thin I/O layer | No duplicate logic. Security checks must stay in Rust. | Parsing git output, project split/merge, PDF marks export (`pdf-lib` runs in the WebView) |
| B. Port to Rust | Fast, testable in Rust. Two copies if the renderer also needs it. | Validators on the trust boundary: `validateGitUrl`, `relPathProblem`, `refProblem`, `allowedDownloadUrl`, update verification |
| C. Keep a Node sidecar | Almost no rewrite. Removes most of the size gain. | Not recommended |

Caution: strategy A must not weaken the trust model. Today the renderer cannot choose URLs, executables, or write paths. In Tauri the Rust commands must keep the same authorization and validation. Do not expose the generic `fs` or `shell` plugin to the renderer.

Recommended split: Rust owns authorization, process spawning, downloads, keychain, and file I/O. TypeScript keeps parsing, merge logic, and PDF assembly.

## 5. Impact and risks

### 5.1 Benefits

- Smaller installers and lower idle memory.
- Rust backend with a smaller attack surface than a Node main process.
- Built-in signed updater. It can replace `src/model/updateSignature.ts` and the custom Ed25519 flow.
- Capability system restricts which commands each window can call.

### 5.2 Risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| PDF rendering | `react-pdf` 9 uses `pdfjs-dist` 4.8. It needs recent JavaScript features. Old WKWebView (before Safari 17.4) and old WebKitGTK may fail. | Spike on the oldest supported macOS and on Ubuntu LTS. Add polyfills or raise the minimum OS. |
| Cross-engine CSS/JS | Three engines instead of one. | Test matrix on all OS. Keep CSS conservative. |
| Linux | WebKitGTK is the least stable target. AppImage bundling of WebKitGTK is fragile. | Spike on Ubuntu 22.04 and 24.04, Fedora. Consider dropping AppImage for deb/rpm. |
| End-to-end tests | Playwright launches Electron directly. It cannot launch Tauri. `tauri-driver` (WebDriver) works on Windows and Linux. It does not work on macOS. | Keep jsdom integration tests. Add Rust unit tests for each command. Run WebDriver e2e on Linux/Windows. Test macOS by hand or via the web build with a mocked bridge. |
| Updater format | macOS updates use an `.app.tar.gz` bundle, not the dmg. Manifest becomes `latest.json`. Old Electron installs cannot auto-update to the Tauri build. | One manual-install release as the bridge. Document it. |
| Code signing | macOS currently uses ad-hoc signing. Windows installer is unsigned. Tauri does not change this. | Decide separately about a Developer ID and an Authenticode certificate. |
| Local LLM runtime | Process lifecycle, resumable hash-verified downloads, and log ring buffer must be re-implemented. | Port `localRuntimeUtil.ts` first (pure functions, already tested). |
| Team skill | Rust is required for all backend changes. | Budget learning time. Keep commands small. |
| Frozen Chromium | Electron ships a known Chromium. Tauri depends on the user's OS. | Set a minimum OS version in the docs. |

### 5.3 Requirements documents

`docs/requirements/platform.md` names Electron in its title and in evidence paths (`electron/main.ts:...`). Many REQ items cite `electron/` files. During migration, update evidence links and the wording "Electron desktop shell". The requirement behavior itself (REQ-PLT-*) should not change.

## 6. Migration plan

Work on a long-lived branch. Keep Electron releasable until Phase 5.

### Phase 0 — Spike (1–2 weeks)

Goal: prove the risky parts before any large rewrite.

1. Create `src-tauri/` with a minimal Tauri v2 app that loads the existing Vite build. → App window shows SaiLoR on macOS, Windows, Linux.
2. Implement three commands: `project:open`, `pdf:read`, `slr-file` protocol. → A sample project opens and a PDF renders with highlights.
3. Test `pdfjs-dist` on the oldest target OS and on Ubuntu LTS. → No rendering or worker errors.
4. Run `tauri build` on all three OS in CI. → Installers produced; sizes recorded.
5. Run `tauri-driver` against the spike on Linux. → One e2e test passes.

Go/no-go: all five checks pass. If PDF rendering fails on a target OS, stop and keep Electron.

### Phase 1 — Bridge abstraction (about 1 week)

1. Rename `window.slr` bridge typing into a transport-neutral interface in `src/platform/`. → `npm run typecheck` passes.
2. Add `TauriAdapter` next to `ElectronAdapter`, selected in `src/platform/index.ts`. → Unit tests for both adapters pass.
3. Keep the channel names (`project:open`, `git:status`, ...) as Rust command names. → One mapping table, no renderer logic change.

### Phase 2 — Core file and project commands (1–2 weeks)

1. Port path authorization (`knownProjectPaths`), dialogs, open, save, `setDir`, recents, feedback, `paths:*`. → `e2e/openSaveProject.spec.ts` logic passes on the Tauri build.
2. Port `slr-file` protocol with the same real-path checks. → PDF reads outside authorized paths are refused (add Rust test).
3. Port window state, menu, single instance, unsaved-changes close flow. → REQ-PLT-11 and close-prompt behavior verified by hand and by test.

### Phase 3 — Git (2–3 weeks)

1. Port `git:*` handlers (about 30) to Rust using `Command` with fixed argument vectors. → Each command has a Rust test against a temp repo.
2. Reuse `samples/git-scenarios` to build fixture repos. → `e2e/gitScenarios.spec.ts` scenarios pass.
3. Keep output parsing in TypeScript (`src/git/output.ts`). → No duplicate parser.
4. Port validators (`url`, `ref`, `relpath`) to Rust as the trust-boundary copy. → Same test vectors pass in both languages.

### Phase 4 — AI, update, secrets (2–3 weeks)

1. Port `llmConfig` and key storage to the `keyring` crate. → Key never reaches the renderer.
2. Port `ollama`, `webFetch` (with SSRF guard), `hardware`. → Existing unit-test cases are rewritten in Rust and pass.
3. Port `localRuntime` (download, hash check, spawn, idle stop, kill tree). → Install and chat with a small model on all three OS.
4. Replace the updater with `tauri-plugin-updater`. Generate a new signing key. → Update from build N to N+1 works on all three OS.
5. Decide where PDF export runs (renderer or Rust). → Exported PDF matches the current output byte-for-byte in the marks test.

### Phase 5 — Release engineering (about 1 week)

1. Replace `build:electron`, `Dockerfile.electron`, `scripts/build-electron.sh`, `afterPack.cjs`, `sign-release.cjs` with Tauri equivalents. → `release.yml` builds all three installers.
2. Update `ci.yml`: add `cargo test`, `cargo clippy`, `cargo fmt --check`. → CI green.
3. Re-run the full integration and e2e suites. → Zero regressions against the Electron build.

### Phase 6 — Cutover (about 1 week)

1. Publish a final Electron release that shows a notice with the download link for the Tauri build. → Users know to reinstall.
2. Remove `electron/`, `electron-builder`, `electron-updater`, `vite-plugin-electron`, `playwright` Electron config. → `npm ci` has no Electron packages.
3. Update `docs/requirements/platform.md`, `README.md`, `openwiki/` sources, and the wiki. → `npm run check:wiki` passes.
4. Tag the first Tauri release (suggest `3.0.0`, or `2.0.0` if this branch ships the migration). → Release published.

## 7. Go/no-go checklist for the spike

- [ ] pdf.js renders and annotates on the oldest supported macOS.
- [ ] pdf.js renders on Ubuntu 22.04 and 24.04 (WebKitGTK).
- [ ] Windows without WebView2 installs correctly (bootstrapper).
- [ ] Installer size is under 25 MB on all OS.
- [ ] One automated e2e test runs on Linux with `tauri-driver`.
- [ ] Team accepts Rust ownership for backend code.

If two or more items fail, keep Electron and apply size reductions instead.

## 8. Effort estimate

| Phase | Estimate (Rust-experienced dev) |
| --- | --- |
| 0 Spike | 1–2 weeks |
| 1 Bridge | 1 week |
| 2 Files/project | 1–2 weeks |
| 3 Git | 2–3 weeks |
| 4 AI/update/secrets | 2–3 weeks |
| 5 Release engineering | 1 week |
| 6 Cutover | 1 week |
| Total | 9–13 weeks calendar, 6–10 weeks of focused work |

The estimate excludes code-signing setup and a Rust learning curve.

## 9. Open questions

1. ~~Minimum OS versions~~ Decided: see section 12.
2. ~~Linux packaging~~ Decided: see section 12.
3. Is the installer size a real user problem, or is the goal the Rust backend?
4. Will the team maintain Rust long term?
5. Should this ship as a major version, with a breaking update path?
6. Should key storage move to the OS keychain via `keyring` with a migration for existing Electron-encrypted keys? (Existing `safeStorage` blobs cannot be read by Rust. Users must re-enter keys.)

## 10. Facts to verify before deciding

These points come from general knowledge of Tauri v2, not from running it here. Confirm them in the spike:

- Current `tauri-driver` platform support (macOS is not supported at the time of writing).
- Exact `pdfjs-dist` 4.8 minimum browser versions versus your minimum macOS.
- Updater behavior with NSIS and AppImage in your release flow.
- Installer size with your assets.

## 11. Phase 0 spike results (2026-11-01)

Code: `src-tauri/`, `spike/`, `vite.spike.config.ts`, `.github/workflows/tauri-spike.yml` on branch `spike/tauri`. The spike does not touch the app source.

Local run: macOS 26.6 arm64. CI run: GitHub Actions `Tauri spike` workflow, five runners.

| Runner | WebView engine | Build | pdf.js load + render | Traversal blocked | Installer size |
| --- | --- | --- | --- | --- | --- |
| macOS 26.6 (local) | WKWebView | Pass | Pass | 403 | dmg 2.1 MB |
| macos-14 | WKWebView | Pass | Pass | 403 | dmg 2.2 MB |
| macos-15 | WKWebView | Pass | Pass | 403 | dmg 2.2 MB |
| ubuntu-22.04 | WebKitGTK | Pass | Pass | 403 | deb 2.0 MB, rpm 2.0 MB, AppImage 80.6 MB |
| ubuntu-24.04 | WebKitGTK | Pass | Pass | 403 | deb 2.0 MB, rpm 2.0 MB, AppImage 80.9 MB |
| windows-latest | WebView2 (Chromium 155) | Pass | Pass | Probe used a Unix path (404). Probe fixed to `Windows/win.ini`. | msi 2.2 MB, NSIS 1.7 MB |

Not tested: macOS older than 14, `tauri-driver` e2e, native open dialog (the probe opens the project through `SPIKE_PROJECT`), Windows without WebView2, Windows traversal after the probe fix.

Findings:

- pdf.js 4.8 renders on all three engines. The main risk from section 5.2 did not occur on current OS versions.
- Linux AppImage is 80 MB because it bundles WebKitGTK. The deb and rpm are 2 MB. The size gain on Linux needs deb/rpm, not AppImage.
- The spike protocol handler returns the whole file and ignores `Range` requests. pdf.js falls back to a full download. The real handler needs `Range` support for large PDFs.
- On Windows the scheme URL is `http://slr-file.localhost`. The spike branches on the user agent.
- The size gain for the shell alone is about 2% of the Electron installer (93 MB macOS arm64). The real app adds its own assets.

Go/no-go: go on the rendering and size checks. Open items: oldest supported macOS, `tauri-driver` e2e on Linux, and the decision on Linux packaging (deb/rpm instead of AppImage).

### 11.1 tauri-driver e2e spike results (2026-11-01)

Code: `spike/e2e/probe.test.mjs` and `.github/workflows/tauri-e2e-spike.yml` on branch `spike/tauri-e2e`. Green run: <https://github.com/Gram21/SaiLoR/actions/runs/41305362434>.

The test uses `node:test` and plain `fetch` against the WebDriver HTTP API. It adds no npm dependency. It starts `tauri-driver`, opens a session on the release binary (`npx tauri build --no-bundle`), and polls `#log` through `execute/sync`. It asserts `RENDER OK` and a `-> 403` traversal probe.

| Runner | Native driver | Result | Test time | Job time (warm cache) |
| --- | --- | --- | --- | --- |
| ubuntu-24.04 | WebKitWebDriver (`webkit2gtk-driver` 2.52.6), `xvfb-run` | Pass | 35 s | 2.5 min |
| windows-latest | msedgedriver 155.0.4283.62 (matches WebView2 155.0.4283.62) | Pass | 16 s (includes `gsudo` install) | 5.5 min |
| macOS | None | Not run. `tauri-driver` has no macOS support. | – | – |

Versions: `tauri-driver` 2.1.0, Rust 1.99.1, Node 24.22.1.

Findings:

- Linux works with the documented setup. Session start takes about 30 s under `xvfb`. The app log shows an AT-SPI D-Bus warning in that time.
- Windows fails with `DevToolsActivePort file doesn't exist` if the test runs elevated. GitHub runners are elevated. WebView2 then ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` from msedgedriver ([wry#1782](https://github.com/tauri-apps/wry/issues/1782)). The fix is `gsudo --integrity Medium`, as in Tauri's own `test-api-e2e.yml`.
- msedgedriver must match the WebView2 version. The workflow reads the version from the EdgeUpdate registry key and downloads the matching driver.
- The old Windows traversal probe (`../` x12 + `Windows/win.ini`) returned 404. The workspace is on drive `D:`, so the target did not exist. The probe now uses `../package.json` on all OS. Windows returns 403 for it.
- Uncached `cargo install tauri-driver` takes about 1 min. On Linux `rust-cache` keeps it. On Windows it compiled again in every run.
- CI cost: about 8 runner minutes per push for both jobs.

Checklist item "One automated e2e test runs on Linux with `tauri-driver`" (section 7): pass. Windows also passes.

## 12. Decisions

| Date | Decision | Consequence |
| --- | --- | --- |
| 2026-11-01 | Minimum supported macOS is 14 (Sonoma). | The Tauri bundle sets `minimumSystemVersion` to `14.0`. The spike CI covers `macos-14` and `macos-15`. The "oldest supported macOS" checks in section 7 are met by those runners. Do not claim support for macOS 13 or older. |
| 2026-11-01 | Ship both AppImage and deb/rpm on Linux. | The release workflow builds `appimage`, `deb` and `rpm`. Only the AppImage auto-updates through `tauri-plugin-updater`. deb and rpm users update by hand or through the system package manager. State this in the README and the release notes. |

Open work from these decisions:

1. Set `bundle.targets` for Linux to `["appimage", "deb", "rpm"]` in the release configuration (Phase 5).
2. Add the minimum macOS version and the Linux update behavior to `README.md` and `docs/requirements/platform.md` at cutover (Phase 6).

## 13. Phase 2 progress

Branch: `spike/tauri-phase2`. Scope: the Rust side of the file and project commands. The TypeScript bridge does not call these commands yet.

Modules in `src-tauri/src/`:

| Module | Content |
| --- | --- |
| `authz.rs` | Session state: project directory, allowed escapes, known projects, readable PDFs, export targets, file stamps (REQ-PLT-30). |
| `project.rs` | `project_open`, `project_open_path`, `project_save`, `project_set_dir`, `project_pick_save_path`, `project_peek`. |
| `feedback.rs` | `project_write_feedback`, `project_list_feedback`. |
| `pdf.rs` | `pdf_pick`, `pdf_pick_folder`, `pdf_read`, `pdf_check_path`, `pdf_allow_path`, `pdf_pick_export_path`, `text_pick_export_path`. |
| `paths.rs` | `paths_relative`, `paths_rebase`, `paths_absolute`, `paths_sibling`. |
| `protocol.rs` | `slr-file` scheme with single byte ranges (206, 416) and the correct `Content-Type`. |

Command names are the IPC channel names with `:` changed to `_` and camelCase changed to snake_case. Arguments use the camelCase keys of the Electron preload.

Open items for the TypeScript side:

- Map each bridge channel to its snake_case command name.
- `project_open` and `project_open_path` return `{ path, text, files, siblings }`. `text` is the stored `project.json`. Assemble the whole project and compute `corrupt` in TypeScript with `src/model/project.ts`.
- `pdf_read` returns an `ArrayBuffer`.
- Port `text:write` and `pdf:embedMarks`. They are the consumers of the export targets.

Differences from Electron:

- The `pdf_allow_path` warning dialog cannot set a default button. The Enter key can select "Open anyway".
- `paths_sibling` also refuses `.` and `..` as file names.
