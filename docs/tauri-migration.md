# Evaluation: Move from Electron to Tauri

Status: done. Phase 6 (cutover) removed Electron. See section 20.
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

Code: `src-tauri/`, `spike/`, `vite.spike.config.ts`, `.github/workflows/tauri-build.yml` on branch `spike/tauri`. The workflow is now the `tauri-build` job in `ci.yml`. The spike does not touch the app source.

Local run: macOS 26.6 arm64. CI run: GitHub Actions `Tauri build` workflow, five runners.

| Runner | WebView engine | Build | pdf.js load + render | Traversal blocked | Installer size |
| --- | --- | --- | --- | --- | --- |
| macOS 26.6 (local) | WKWebView | Pass | Pass | 403 | dmg 2.1 MB |
| macos-14 (retired 2026-11-02) | WKWebView | Pass | Pass | 403 | dmg 2.2 MB |
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

Code: `spike/e2e/probe.test.mjs` and `.github/workflows/tauri-e2e.yml` on branch `spike/tauri-e2e`. The workflow is now the `tauri-e2e` job in `ci.yml`, and the test is `e2e/probe.test.mjs`. Green run: <https://github.com/Gram21/SaiLoR/actions/runs/41305362434>.

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
| 2026-11-01 | Minimum supported macOS is 14 (Sonoma). Superseded on 2026-11-02. | See the next row. |
| 2026-11-02 | Minimum supported macOS is 15 (Sequoia). | GitHub retires the `macos-14` runners, so the oldest tested macOS is 15. The Tauri bundle sets `minimumSystemVersion` to `15.0`. CI covers `macos-15` (lowest) and `macos-26` (newest). Do not claim support for macOS 14 or older. |
| 2026-11-01 | Ship both AppImage and deb/rpm on Linux. | The release workflow builds `appimage`, `deb` and `rpm`. Only the AppImage auto-updates through `tauri-plugin-updater`. deb and rpm users update by hand or through the system package manager. State this in the README and the release notes. |

Open work from these decisions:

1. Set `bundle.targets` for Linux to `["appimage", "deb", "rpm"]` in the release configuration (Phase 5). Done in `src-tauri/tauri.release.conf.json` (section 16).
2. Add the minimum macOS version and the Linux update behavior to `README.md` and `docs/requirements/platform.md` at cutover (Phase 6). Done (section 20).

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

Status: Done. See section 18.

Differences from Electron:

- The `pdf_allow_path` warning dialog cannot set a default button. The Enter key can select "Open anyway".
- `paths_sibling` also refuses `.` and `..` as file names.

## 14. Phase 4 progress (AI)

Scope: the Rust side of the AI channels, without `localRuntime` and without the updater. The bridge in `src/platform/tauri.ts` already maps these channels.

Modules in `src-tauri/src/`:

| Module | Content |
| --- | --- |
| `net.rs` | Shared HTTP client setup, the abort registry, and a `TcpListener` mock server for tests. |
| `llm.rs` | `llm_configs`, `llm_save_config`, `llm_delete_config`, `llm_call`, `llm_abort`. |
| `ollama.rs` | `ollama_version`, `ollama_list`, `ollama_show`, `ollama_ps`, `ollama_pull`, `ollama_cancel_pull`, `ollama_delete`, `ollama_manifest_size`, `localserver_discover`. |
| `webfetch.rs` | `web_fetch`, `web_abort`, with the SSRF guard, 5 redirects, 2 MiB and 20 s limits. |
| `hardware.rs` | `local_probe`. |

New dependencies:

| Crate | Reason |
| --- | --- |
| `reqwest` (no default features, `rustls-no-provider`, `system-proxy`) | Streaming HTTP client with a pluggable DNS resolver. Electron used `net.fetch`. The custom resolver is the SSRF guard. |
| `rustls` (`ring`) | TLS without OpenSSL. `ring` builds without CMake, unlike `aws-lc-rs`. HTTP/2 is off because LLM calls do not need it. |
| `tokio` | Timeouts, abort signals and child processes. Tauri already depends on it. |
| `url` | WHATWG URL parsing for origin checks. Tauri already depends on it. |
| `encoding_rs` | Decodes `web_fetch` bodies by their charset, like `TextDecoder`. |
| `keyring` | Stores API keys in the macOS Keychain, the Windows Credential Manager, or the Secret Service on Linux. |
| `sysinfo` (`system`, `disk`) | RAM and free disk space for `local_probe`. |

Config file compatibility:

- The file is `<config dir>/SaiLoR/llm-config.json`, the same path as the packaged Electron app.
- The format stays a JSON array of targets. Unknown fields are kept.
- A key saved in Tauri goes to the keychain (service `SaiLoR`, account `llm:<id>`). The entry gets `"keyring": true`.
- Tauri cannot decrypt the Electron `safeStorage` blob in `key`. The blob stays in the file, but Tauri reports `hasKey: false` for that target.
- Caution: Users must enter each API key again once after the switch to Tauri. Targets with `noKey` need no action.
- Electron ignores the keychain. A key saved only in Tauri is not visible to Electron.
- Tauri sets the file mode to `0600` on every write, not only when it creates the file.

Not ported:

| Channel | Reason |
| --- | --- |
| `local:*` except `local:probe` | Ported later. See section 17. |
| `llm:call` for managed targets | Ported later. See section 17. |
| `update:*` | Moved to `tauri-plugin-updater`. See section 16. |

Differences from Electron:

- `web_fetch` pins DNS: the resolver checks every address and the client connects only to checked addresses. Electron checked the name, then resolved it again for the connection. This closes the DNS-rebinding gap.
- `llm_call` reports a redirect as `Refusing to follow a redirect from <origin>.`. Electron reported a generic fetch error.
- `Retry-After` reads delta seconds and IMF-fixdate. The obsolete RFC 850 and asctime date forms give no retry hint.
- `local_probe` reports available RAM as `freeRamBytes`. Node reports free RAM, which is lower on macOS.

Verification: `cargo test` runs the ported cases of `ollama.test.ts`, `hardware.test.ts` and the SSRF cases of `webFetch.test.ts` against a local mock server.

## 15. Phase 3 progress

Scope: the Rust side of the 36 `git:*` channels. The TypeScript bridge already calls them by name (`src/platform/tauri.ts`). The renderer does not read the new result shapes yet.

| Module | Content |
| --- | --- |
| `git.rs` | All `git_*` commands, the git runner, the URL, ref and relative-path validators, and tests against temporary repositories. |
| `authz.rs` | New `known_git_roots` set (REQ-GIT-90). |

The runner starts `git` with a fixed argument vector and no shell. It uses the Electron environment hardening, `-c` safety options and timeouts (30 s, 900 s for network, 60 s for background fetch). The Rust validators use the same test vectors as `src/git/url.test.ts`, `src/git/ref.test.ts` and `src/git/relpath.test.ts`.

Open items for the TypeScript side:

- Revision content (`git_head_content`, `git_log_diff` texts, `merge` results `base`/`ours`/`theirs`) is a `Snapshot` `{ text, files }`. Assemble it with `src/model/project.ts`.
- `git_working_content` and the branch-switch `ours` return the `project_open` shape `{ path, text, files, siblings }`. Assemble it the same way.
- `pullFinish`, `branchSwitchFinish`, `commitPartial` and `writeWorking` take `{ metaText, files }` in the `project_save` file format.
- Output parsing that Electron left to the renderer stays in TypeScript: `capDiff`, `diffLines`, `repoNameFromUrl` and the field-level merge.

Status: Done. See section 18.

Differences from Electron:

- Every command that takes a root requires a root from `git_info` or `git_clone` in this session. Electron checked this only for background fetch, checkout, branch switch and stash commands. `git_probe`, `git_clone`, `git_info` and the pickers do not take a known root.
- Commands run on a blocking thread pool. `git show` for revisions runs on at most 8 threads.
- The 32 MB output cap is the same as in Electron. See section 18.3.
- `ls-tree` uses `-z`, so paths with non-ASCII characters are not quoted.
- A git process that a signal stops reports `code: null` and keeps its stderr.

## 16. Phase 4 step 4 and Phase 5 progress (updater, release)

### 16.1 Updater

`src-tauri/src/update.rs` implements the `update:*` channels on `tauri-plugin-updater`. The bridge in `src/platform/tauri.ts` already maps them.

| Command | Behavior |
| --- | --- |
| `update_check` | Asks the feed for a newer version. Emits `update:available` `{ version }` or `update:error`. Returns `{ supported: true }`. |
| `update_download` | Starts the download of the reported update and returns at once. Emits `update:progress` `{ percent }`, then `update:downloaded` or `update:error`. Does nothing if no update was reported. |
| `update_install` | Installs the downloaded update and restarts the app. On Windows the NSIS installer closes the app. Emits `update:error` on failure. |

Configuration in `src-tauri/tauri.conf.json`:

- `version` reads `../package.json`, so the app version and the feed version use the same source.
- `plugins.updater.endpoints` is `https://github.com/Gram21/SaiLoR/releases/latest/download/latest.json`.
- `plugins.updater.pubkey` is the placeholder `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`.
- `plugins.updater.requireSignedVersion` is `true`. The Tauri CLI 2.12 and later writes the version into the signature. The plugin rejects a feed that pairs a version with a different artifact.
- The capability file does not grant `updater:default`. The renderer cannot call the plugin directly and cannot supply a URL.

Differences from Electron:

- macOS self-updates. Electron reported `{ supported: false }` on macOS.
- deb and rpm return `{ supported: false, manual: true }` and do not contact the feed. Unbundled binaries (`cargo run`, `tauri dev`) return the same.
- The plugin verifies a minisign signature of each artifact. Electron verified an Ed25519 signature of the feed (`latest*.yml`).
- Caution: The feed URL returns 404 until a Tauri release is the latest published release. Before the cutover, `update_check` emits `update:error` on a supported bundle.

Open items for the TypeScript side:

- `App.tsx` shows the download and install buttons only if `isElectron()` is true. `isElectron()` is false in Tauri, so the in-app update UI is hidden.
- `useElectronCloseGuard` subscribes to `update:progress`, `update:downloaded` and `update:error` only in Electron.
- `getOsInfo()` returns `null` in Tauri. `checkForUpdate` and the release-asset match need the OS and architecture.

Status: Done. See section 18.

### 16.2 Release workflow

`.github/workflows/release.yml` builds the Tauri app and attaches the files to a draft GitHub release. Before Phase 6 this file was `tauri-release.yml` and used `tauri-v*` tags.

- Triggers: a pushed tag `v<version>`, or a manual run. A manual run uses `v<version>` from `package.json`.
- The tag must match the `package.json` version.
- The `release` job stops if the public key is still the placeholder or if `TAURI_SIGNING_PRIVATE_KEY` is not set.
- The `release` job reuses an existing draft for the tag. It stops if the release is already published.
- The `build` job runs `tauri-apps/tauri-action@v1` with `src-tauri/tauri.release.conf.json` on these runners:

| Runner | Target | Files |
| --- | --- | --- |
| `macos-15` | `aarch64-apple-darwin` | `.dmg`, `.app.tar.gz` and `.sig` |
| `macos-15` | `x86_64-apple-darwin` | `.dmg`, `.app.tar.gz` and `.sig` |
| `windows-latest` | `x86_64-pc-windows-msvc` | NSIS `.exe` and `.sig` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb`, `.rpm` and `.sig` |

- Each build job merges its platform into `latest.json` on the release.
- The `check-updater-json` job fails if `latest.json` misses a platform. If this occurs, run the failed build job again.
- `src-tauri/tauri.release.conf.json` sets `createUpdaterArtifacts`. The base configuration does not, so the `tauri-build` and `tauri-e2e` jobs in `ci.yml` need no signing key.

Zenodo:

- The `zenodo` job runs when a release is published. It archives the release as a new version of concept record 23804729.
- The other jobs do not run on the publish event.
- Phase 6 moved this job from the Electron `release.yml`. Before Phase 6, `tauri-v*` releases were not archived.

`ci.yml` has a new `rust` job. It runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri`.

### 16.3 Signing key and secrets

Warning: Do not commit the private key. If you lose the private key, installed apps cannot accept new updates. Keep a backup in a password manager.

Create the updater key once:

1. Run `npx tauri signer generate -w ~/.tauri/sailor.key`.
2. Enter a password, or leave it empty.
3. Copy the content of `~/.tauri/sailor.key.pub` into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
4. Commit `tauri.conf.json`.
5. Set the repository secrets in the next table.

| Secret | Required | Content |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Yes | Content of `~/.tauri/sailor.key`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | If the key has a password | The key password. |
| `APPLE_CERTIFICATE` | No | Base64 of the Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | With `APPLE_CERTIFICATE` | The `.p12` password. |
| `APPLE_SIGNING_IDENTITY` | With `APPLE_CERTIFICATE` | For example `Developer ID Application: Name (TEAMID)`. If not set, the app is ad-hoc signed (`-`). |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | No | Apple ID, app-specific password and team ID for notarization. |
| `WINDOWS_CERTIFICATE` | No | Base64 of the code-signing `.pfx`. If not set, the installer is unsigned. |
| `WINDOWS_CERTIFICATE_PASSWORD` | With `WINDOWS_CERTIFICATE` | The `.pfx` password. |

To make a release:

1. Set the version in `package.json`.
2. Push the tag `v<version>`, or start "Release" from the Actions tab.
3. Check the draft release and `latest.json`.
4. Publish the draft.

Open items for the cutover (Phase 6): all done. See section 20.

- Electron users install the first Tauri release by hand. electron-updater cannot read `latest.json`.

Verification: `cargo test` tests the bundle gate, the progress percent and the updater configuration. The release workflow was not run. It needs the secrets and a tag.

## 17. Phase 4 step 3 progress (local runtime)

Scope: the Rust side of the app-managed llama.cpp runtime. This covers all `local:*` channels, the `local:progress` event, and `llm_call` for managed targets. The bridge in `src/platform/tauri.ts` already maps these channels.

| Module | Content |
| --- | --- |
| `localruntime.rs` | `local_runtime`, `local_runtime_plan`, `local_runtime_install`, `local_model_plan`, `local_model_install`, `local_cancel`, `local_installed`, `local_remove`, `local_start`, `local_stop`, `local_status`, `local_logs`. It also holds the catalog mirror, verified downloads, the server manager, and `stop_all` for app exit. |
| `llm.rs` | `llm_call` sends a managed target to the running server with that server's key. Only `/v1/*` and `/health` paths go through. |
| `main.rs` | Registers the commands. Calls `localruntime::stop_all` on `RunEvent::Exit`. |

New dependencies:

| Crate | Reason |
| --- | --- |
| `ring` | SHA-256 for download checks and the random server API key. `rustls` already compiles it, so the build adds no new code. |
| `libc` (unix only) | `getuid` for the root refusal and `kill(-pgid)` for the process-group kill. It is already in `Cargo.lock`. |

Archives are extracted with the system `tar`, the same as Electron. Windows uses `%SystemRoot%\System32\tar.exe`, which reads zip. No zip or tar crate is added.

Install layout: the layout is the same as Electron. The data dir is `<config dir>/SaiLoR`.

- The runtime goes to `local-runtime/llama.cpp/<tag>/` with `manifest.json`.
- A partial runtime download goes to `local-runtime/llama.cpp/.downloads/<asset>.partial`.
- A model goes to `local-models/<id>/<file>`. A partial model download goes to `<file>.partial`.
- Runtimes and models that Electron installed work in Tauri without a new download.

The catalog in `localruntime.rs` copies `src/llm/localCatalog.ts`. A test fails if the two lists differ.

Differences from Electron:

- Stop and app exit kill the whole process tree. On macOS and Linux the server runs in its own process group, which gets SIGTERM and then SIGKILL after 3 s. On Windows `taskkill /T /F` runs on stop and on exit. Electron killed only the server process on macOS and Linux.
- If the self-test of `/v1/systemone` fails for any reason, the server stops. Electron stopped it only when the server answered with an error status.
- Managed `llm_call` requests use a client without proxy and without redirects.
- A global lock lets only one server start at a time.

Verification: `cargo test` runs the ported cases of `localRuntimeUtil.test.ts` and the `managedTargetUrl` cases. Download tests use the local mock server: full download, resume with `206`, restart on `200`, hash mismatch, `404`, refused redirect hop, and cancel. No test downloads a real runtime or model. A unix test checks that the process-group kill also stops a grandchild process.

## 18. Port leftovers (renderer, exports, git cap)

Scope: the open items of sections 13, 15 and 16.1. The renderer now runs the same code paths in Tauri and in Electron.

### 18.1 Project and revision assembly

`src/platform/tauri.ts` builds the Electron result shapes from the Rust results.

| Rust result | Bridge calls | Renderer gets |
| --- | --- | --- |
| `{ path, text, files, siblings }` | `openProject`, `openPath` | `{ path, text, corrupt }` |
| `{ text, files }` (`Snapshot`) | `gitHeadContent`, `gitWorkingContent`, `gitLogDiff` (`head`, `parent`) | The whole-project text |
| `merge` with `base`, `ours`, `theirs` | `gitPullBegin`, `gitMergeBegin`, `gitBranchSwitchBegin` | The same `merge` object with whole-project texts |

`assembleProject` is a port of `readProjectText` and `readProjectAtRevision` in `electron/main.ts`:

- A legacy single-file project text stays unchanged.
- Only the files of the open project kind go into the project. Screening projects also read old highlight files (`marks-N.json`), unless a non-screening sibling project lists the paper.
- A file that is not valid JSON goes into `corrupt`. The project opens without it.

### 18.2 Exports

`src-tauri/src/pdf.rs` adds `pdf_embed_marks` and `text_write`.

- `text_write` and `pdf_embed_marks` with `{ newPath }` write only to a path that the export dialog returned in this session (`writableExportPaths`). Both refuse a symlink target.
- `pdf_embed_marks` uses `lopdf`. It adds one annotation per mark (a highlight, or a note icon for a note mark) and keeps the existing annotations. It refuses an encrypted PDF.
- New dependencies: `lopdf` (no default features) and `chrono` (`alloc` only) for the annotation date.

Differences from Electron:

- `pdf_embed_marks` reads only a PDF of the open project: a file inside the project folder, or an outside path that the reviewer approved. Electron read any path. This also applies to the target `original`.

### 18.3 Git output cap

`run_git` in `src-tauri/src/git.rs` stops git when stdout or stderr passes 32 MB. The result is `{ ok: false, code: null, stderr: "git output exceeded 32 MB." }` with no stdout. Electron's `maxBuffer` has the same limit.

### 18.4 Desktop shell detection

- `PlatformAdapter.kind` is `tauri` in Tauri. It is not `electron`.
- Components that need a desktop shell check `kind !== 'browser'`. Examples: the macOS shortcut labels and the AI feedback files.
- `getOsInfo()` returns the OS and architecture in Tauri. The `slr-os` plugin in `src-tauri/src/main.rs` sets `window.__SLR_OS__` with an init script. The values use the Node names (`darwin`, `win32`, `linux`, `x64`, `arm64`).

### 18.5 Update UI

- `checkForUpdate` stores the `supported` answer of `checkForNativeUpdate` in `nativeUpdate`.
- `App.tsx` shows the download and install buttons only if `nativeUpdate` is true. If not, it shows the download link.
- Electron does not call `checkForNativeUpdate` on macOS. Tauri calls it on every OS, because `update.rs` decides by bundle type.
- `useElectronCloseGuard` uses `getBridge()` in both shells. It receives `update:progress`, `update:downloaded` and `update:error` in Tauri.
- The download link picks the Tauri file names (`_aarch64.dmg`, `_x64.dmg`, `_x64-setup.exe`, `_amd64.AppImage`). Fix applied after the cutover.

### 18.6 Close guard

`src-tauri/src/close.rs` ports the unsaved-changes dialog (REQ-PLT-100).

| Command or event | Behavior |
| --- | --- |
| `app_set_dirty` | Stores the dirty flag that the renderer sends. |
| `CloseRequested`, `ExitRequested` with `code: None` | If the project is dirty, prevents the close and shows "Save", "Don't Save" and "Cancel". A second close while the dialog is open shows no second dialog. |
| `app:requestSave` | Emitted after "Save". The renderer saves and calls `app_save_complete`. |
| `app_save_complete` | Exits the app if the save succeeded. |

- "Don't Save" exits the app.
- "Cancel" and a failed save keep the window open.
- `app.exit` and `app.restart` (update install) set `code`, so the guard lets them pass. `update_install` therefore refuses with an `update:error` event while the project has unsaved changes.

Differences from Electron:

- `app_save_complete(true)` closes the app only after a save that the dialog requested. Electron closed on every `saveComplete(true)`.
- The dialog has no default button.

### 18.7 Verification and gaps

Verification:

- `cargo test` tests the close-guard state, the dialog button mapping, the git cap, the PDF embed and the export authorization.
- `npx vitest run` tests the project assembly, the bridge shapes and the `nativeUpdate` gate.

Not tested:

- No test runs the Tauri app. The close dialog, Cmd+Q on macOS and the `slr-os` init script were not tried by hand.
- `beforeunload` (`useDirtyGuard`) still runs in Tauri. Its effect in the webview on reload was not tried.
- The updater was not tried against a real feed.
- `lopdf` was tested only with generated PDFs.

## 19. Remaining project channels

Branch: `feat/tauri-port-remaining-ipc`. This section ports the last six channels of `electron/preload.ts`. Every preload channel now has a Rust command.

| Channel | Command | Module |
| --- | --- | --- |
| `project:annotationsDirUsers` | `project_annotations_dir_users` | `annotations.rs` |
| `project:moveAnnotationsDir` | `project_move_annotations_dir` | `annotations.rs` |
| `project:sharedAnnotations` | `project_shared_annotations` | `annotations.rs` |
| `project:splitAnnotations` | `project_split_annotations` | `annotations.rs` |
| `project:screeningSource` | `project_screening_source` | `project.rs` |
| `reference:pick` | `reference_pick` | `project.rs` |

### 19.1 Behavior

- `project_annotations_dir_users` returns only the names of the sibling project files that use the folder and share a paper of the same kind. Rust applies the `filesCollide` rule (NFC, case-insensitive ids).
- `project_move_annotations_dir` renames the folder first. If the project file write fails, it renames the folder back. It stamps the project file and the moved files.
- `project_shared_annotations` returns the Electron shape `{ folder, projects, files }`. It stores the listed projects, their stamps and the listed files in `Session.listed_splits`.
- `project_split_annotations` accepts only a plan for the listed projects and files. It refuses the plan if a listed project file changed. All checks run before the first write. The writes keep the `applySplit` order: copy, point each project file at its folder, delete, remove empty folders.
- `planSplit` stays in TypeScript.
- `project_screening_source` returns the raw project like `project_open`. The bridge assembles `text` with `assembleProject`.
- `reference_pick` opens the "Import references" dialog and returns `{ text, name }`.

Project file rewrites keep the key order of the file. For this, `serde_json` uses the `preserve_order` feature.

### 19.2 Differences from Electron

- `project_annotations_dir_users` requires a project that this session opened. Electron did not check this. All renderer callers pass an open project.
- `project_move_annotations_dir` refuses a project file that is not a JSON object.
- `project_move_annotations_dir` removes only an empty target folder. Electron used a recursive remove.
- `project_split_annotations` checks that the real parent of each copy target is inside the project directory.
- A refused folder name gives no reason. Electron added the `annotationsDirProblem` text.
- Project file rewrites print numbers in the Rust format. For example, `1.0` stays `1.0` and does not become `1`.

### 19.3 Verification and gaps

Verification:

- `cargo test` tests the collision rule, the known-project checks, the folder move and its restore, the listing, the split and its refusals, the key order and the screening-source name rules.
- `npx vitest run` tests the channel mapping and the `screeningSource` shape.

Not tested:

- No test runs the Tauri app. The "Import references" dialog was not tried by hand.
- The restore after a failed project file write is tested only on systems that refuse writes to read-only files.

## 20. Phase 6 cutover

Branch: `feat/tauri-cutover`. Electron is removed. The Tauri shell builds and ships the real app.

### 20.1 Removed

- `electron/`, the `build` block of `package.json` (electron-builder), `electron`, `electron-builder`, `electron-updater` and `vite-plugin-electron`.
- The Playwright e2e suite (`e2e/*.spec.ts`), `playwright.config.ts` and `npm run test:e2e`.
- `npm run dev:electron`, `npm run build:electron`, `scripts/build-electron.sh`, `scripts/afterPack.cjs`, `scripts/sign-release.cjs` and `scripts/make-icon.cjs`.
- `src/model/updateSignature.ts`. The Tauri updater checks a minisign signature instead.
- `Dockerfile.electron` and the `electron` service in `docker-compose.dev.yml`.
- The Electron `release.yml` and `integration-tests.yml` workflows.

### 20.2 App identity

| Setting | Value |
| --- | --- |
| `productName` and window title | `SaiLoR` |
| Cargo package and binary | `sailor` |
| `identifier` | `io.github.gram21.sailor` |
| `build.frontendDist` | `../dist` (the real renderer from `npm run build`) |

Effects of the identifier change:

- The WebView storage is new. Recent projects and the UI settings in `localStorage` (`slr.*` keys) start empty.
- The macOS bundle ID changes. macOS treats the app as a new app.
- Project files do not change.
- The LLM configuration, the local runtime and the local models stay in `<config dir>/SaiLoR`. The Rust code builds this path without the identifier.
- API keys that Electron saved with `safeStorage` cannot be read. Users enter them once more. Tauri saves keys in the keychain (service `SaiLoR`).

### 20.3 Probe build

- `e2e/index.html` and `e2e/main.tsx` hold the probe page (moved from `spike/`). `vite.probe.config.ts` builds it into `dist-probe/`.
- `make probe` builds the probe app with `src-tauri/tauri.probe.conf.json` and the `probe` cargo feature.
- Only the `probe` feature registers `probe_auto` and `probe_report`. Release builds do not contain them.
- The probe binary is `src-tauri/target/release/sailor`, the same path as the app binary. Build the probe after the app build.
- The `tauri-build` job in `ci.yml` runs the probe on every OS. The `tauri-e2e` job runs `e2e/probe.test.mjs` with `tauri-driver` on Linux and Windows.

### 20.4 Renderer

- `src/platform/electron.ts` is now `src/platform/desktop.ts` (`DesktopAdapter`). `TauriAdapter` extends it and sets the Tauri bridge.
- `isElectron()` is removed. `PlatformAdapter.kind` is `tauri` or `browser`.
- `getBridge()` throws if no bridge is set. Only the Tauri shell sets a bridge.
- `useElectronCloseGuard` is now `useCloseGuard`.
- The `unsupported` adapter stays for every other runtime.
- A vitest test checks that the bridge invokes exactly the commands that `main.rs` registers.
- `vite.config.ts` no longer writes source maps. Tauri embeds every file of `dist/` in the binary.

Kept on purpose:

- `SaveHandle.kind` keeps the value `electron`. It is in memory only and is used in many files.
- The `localStorage` key `slr.recents.electron` keeps its name.

### 20.5 Workflows

- `release.yml` (was `tauri-release.yml`) runs on `v*` tags and on a manual run. It builds a draft release.
- The `zenodo` job runs when the draft is published.
- `npm run test:integration` runs in `scripts/ci.sh`, so it runs in the `build` job of `ci.yml` on every push.
- The `rust` job runs clippy with `--all-features`, so it also checks the probe commands.

### 20.6 Not done

- The download link picks the Tauri file names. Fix applied after the cutover.
- A final Electron release with a reinstall notice (Phase 6 step 1) is not part of this branch.
- `openwiki/` is generated. The scheduled workflow updates it.

The Electron shell had these features. The Tauri shell does not have them yet. `docs/requirements/platform.md` marks the matching requirements.

- Reload guard on the menu reload (REQ-PLT-120). Only the renderer `beforeunload` handler exists.

### 20.7 Window title and Close project button

- The window title shows the project, for example "My review - SaiLoR". With no project open, it shows "SaiLoR" (REQ-UI-25).
- A "● " prefix marks unsaved changes. The toolbar no longer shows the project name or a dirty dot.
- `useWindowTitle` calls `PlatformAdapter.setWindowTitle`. The Tauri bridge calls `getCurrentWindow().setTitle()`.
- `core:default` does not allow `setTitle`. `capabilities/default.json` adds `core:window:allow-set-title`.
- In the browser, the `unsupported` adapter sets `document.title`.
- "Close project" is an icon button left of the "SaiLoR" app title. It is always present so the app title keeps its place. Without a project it is hidden and disabled (REQ-UI-20).
- The Open menu no longer has a "Close project" item. No keyboard shortcut existed for it.
- The button calls `requestCloseProject`, so unsaved changes still open the close prompt. `src-tauri/src/close.rs` is not changed.

The native title bar stays. An overlay title bar is not used, for these reasons:

- macOS `titleBarStyle: Overlay` hides the native title text. The project name must show in that title.
- With a visible overlay title, the native title text sits over the web content. It overlaps the centered reviewer switch.
- Windows and Linux have no overlay style in Tauri. They need `decorations: false` and custom window controls. That removes native snap and the native window menu.
- Each overlay needs `data-tauri-drag-region` areas. Every toolbar control then needs a check for drag conflicts.


## 21. Platform gaps

Branch: `feat/tauri-platform-gaps`. This section ports Electron shell features that section 20.6 listed as missing. The code is in `src-tauri/src/shell.rs`.

### 21.1 Behavior

| Requirement | Tauri implementation |
| --- | --- |
| Single instance (REQ-PLT-11) | `tauri-plugin-single-instance`. A second start exits. The running app restores, shows and focuses the `main` window. |
| Window state (REQ-PLT-160) | `tauri-plugin-window-state` saves size, position and the maximized state in `<app config dir>/.window-state.json`. It restores a position only if it is on a connected display. |
| Device permissions (REQ-PLT-240) | `Builder::on_permission_request` answers every request with `Deny`. |
| External links (REQ-PLT-250) | `tauri.conf.json` sets `create: false` on the `main` window. `shell::setup` builds the window from that config with two hooks. `on_navigation` keeps app URLs in the window and cancels all other URLs. `on_new_window` always denies. Both hooks open http and https URLs in the system browser with `tauri_plugin_opener::open_url`. |
| Legacy folder (REQ-PLT-180) | `shell::migrate_legacy` runs first in `shell::setup`. If `<config dir>/SaiLoR` has no `window-state.json` and no `Local Storage`, it copies both items from `<config dir>/SLR Helper` or `<config dir>/slr-helper`. The copy skips symlinks and never replaces a file. Errors go to stderr. Startup continues. |
| Edit menu (REQ-PLT-310) | macOS only. `shell::edit_menu` takes the Tauri default menu and replaces its native Undo and Redo with items `app:undo` (Cmd+Z) and `app:redo` (Cmd+Shift+Z). A menu click emits the event of the same name. The renderer already listens for both events. Cut, copy, paste and select all stay native. |

### 21.2 Differences from Electron

- The second start does not forward its arguments. Electron did not forward them either.
- The default window size is 1400x900. Electron used 1920x1080.
- The window state file is new. The app does not read the Electron `window-state.json`, so the first start uses the default size.
- The permission hook covers less than Electron. Windows (WebView2) and Linux (WebKitGTK) report every request kind. macOS (WKWebView) reports only camera and microphone. On macOS, geolocation and notifications fail without an entitlement, so the page cannot use them either.
- External links open only for http and https. Electron also allowed `mailto`. The app has no `mailto` links.
- App URLs are `tauri://localhost`, `http(s)://tauri.localhost` (Windows) and `about:blank`. Debug builds also allow the `devUrl` origin.
- The opener plugin is not registered. The renderer gets no opener commands, and `capabilities/default.json` does not change.
- The migrated files are copies only. The Tauri WebView keeps `localStorage` in its own store, and the window-state plugin uses its own file. So the old window size and recent projects do not come back.
- Windows and Linux get no menu bar. Electron showed File, Edit, View and Window menus there. The renderer key binding runs undo and redo. The WebView handles copy and paste natively.
- The View menu has no Reload, Force Reload or Toggle DevTools item. The reload guard stays open (REQ-PLT-120).
- No double undo: WKWebView sends Cmd+Z to the page first. `useKeybindings` calls `preventDefault`, so the menu item does not fire. A click on the menu item runs one undo through the event.

### 21.3 Verification and gaps

Verification:

- A manual run on macOS started the debug build twice. The second process exited. The first process kept running.
- A manual run on macOS moved and resized the window and quit from the menu. The next start used the saved position and size.
- `cargo test` tests the scheme check and the app URL check.
- `cargo test` tests the legacy copy: one copy into an unused profile, no copy into a used profile, no overwrite, and no folder without a legacy profile.
- A manual run on macOS with a separate `HOME` copied `SLR Helper/window-state.json` into `SaiLoR`.
- The same run listed the Edit menu as Undo, Redo, separator, Cut, Copy, Paste, Select All, then the macOS items.

Not tested:

- No test asks the WebView for a device permission.
- No test clicks a link in the running app.
- Cmd+Z in the running app was not tried by hand. The single undo per key press follows from the WKWebView key order.
- Windows and Linux were not run by hand.
