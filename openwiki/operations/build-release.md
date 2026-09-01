---
type: operations
title: Build, CI, and Release
description: The Vite + vite-plugin-electron build pipeline, the provider-agnostic CI/electron-builder packaging scripts, GitHub Actions workflows, Ed25519 release signing, Docker Electron builds, and wiki sync mechanics.
tags: [build, ci, release, electron-builder, docker, signing, github-actions, openwiki]
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-a722bbb5eba6ff5dc663e4a4
    resource: repo://.github/workflows/integration-tests.yml
  - id: openwiki-source-6d3ac2bdfb0e76882a670989
    resource: repo://.github/workflows/openwiki.yml
  - id: openwiki-source-4d1d392666be6dfdd7a91a2e
    resource: repo://.github/workflows/release.yml
  - id: openwiki-source-794b8a6d2fa178d64fce49a3
    resource: repo://.github/workflows/wiki-import.yml
  - id: openwiki-source-a7a8965ff53d3530162adf6d
    resource: repo://.github/workflows/wiki-publish.yml
  - id: openwiki-source-0c106052b3286e779bed85e7
    resource: repo://docker-compose.dev.yml
  - id: openwiki-source-3697075a7565dd9399f2baf5
    resource: repo://Dockerfile.electron
  - id: openwiki-source-8d6b6eb5e58f91e157e37bde
    resource: repo://electron/main.ts
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-e4fdc2103ccb69e4135298d8
    resource: repo://scripts/afterPack.cjs
  - id: openwiki-source-ebc09c37829da6e456c89f67
    resource: repo://scripts/build-electron.sh
  - id: openwiki-source-0744bbc5adcd6bd563690bde
    resource: repo://scripts/ci.sh
  - id: openwiki-source-1d3476a6e83c1e73809d1a15
    resource: repo://scripts/sign-release.cjs
  - id: openwiki-source-d550d6b8b447fac29ab966c2
    resource: repo://src/model/updateSignature.ts
  - id: openwiki-source-5e1b077422a94ae165e88e4e
    resource: repo://vite.config.ts
generated: { by: "openwiki/0.5.0", at: "2026-09-01T19:42:14.192Z" }
verified:
  - by: openwiki/0.5.0
    at: 2026-09-01T19:42:14.192Z
---

# Build, CI, and Release

SaiLoR ships as both a static web SPA and a packaged Electron desktop app. The
build, test, packaging, and release machinery is deliberately split so that the
real work lives in repo-local scripts that run identically on any CI provider,
while the GitHub Actions workflows only supply runners and provider-specific
glue (artifact upload, scheduled triggers, wiki mirroring).

```mermaid
flowchart TD
  PR["push to main / pull request"] --> CI["ci.yml"]
  CI --> CiSh["scripts/ci.sh<br/>install → typecheck → check:wiki → test → build"]
  Rel["release published"] --> RelYml["release.yml"]
  RelYml --> Int["integration-tests.yml<br/>(jsdom + Playwright/Electron e2e)"]
  Int --> BuildSh["scripts/build-electron.sh<br/>build:electron → electron-builder"]
  BuildSh --> Sign["sign-release.cjs<br/>Ed25519 over latest.yml / latest-linux.yml"]
  Sign --> Attach["installers + .sig attached to release"]
  Mac["macOS dmg arm64+x64"] --> AfterPack["afterPack.cjs ad-hoc sign"]
  Win["Windows nsis"] --> Sign
  Lin["Linux AppImage"] --> Sign
```

*Build, CI, and release flow. CI runs on every push/PR; release runs only on a
published GitHub Release and is gated by the integration/e2e suite.*

## Build pipeline

### Static SPA build (`npm run build`)

`npm run build` is `tsc -b && vite build` — it type-checks via the TypeScript
project references (`tsconfig.app.json` for `src`, `tsconfig.node.json` for
`vite.config.ts`, the Electron sources, `e2e/`, and the integration/vitest
configs) and then produces a plain static SPA in `dist/`. The Vite config
(`vite.config.ts`) uses `base: './'` so the output works both from a server
subpath and from `file://`, and injects `__APP_VERSION__` from `package.json`
so the app's version stays single-sourced.

The `vite-plugin-electron` integration is **gated on `ELECTRON=1`**. Without
it, `vite` produces the static SPA only — no Electron main/preload is built and
no desktop shell is launched. This is the build the CI script runs; it exists
to type-check and exercise the SPA, not to produce a desktop installer.

### Electron build (`npm run build:electron`)

`build:electron` is `cross-env ELECTRON=1 npm run build && electron-builder
--publish never`. Setting `ELECTRON=1` activates `vite-plugin-electron`:

- The **main** process entry is `electron/main.ts`, emitted to `dist-electron/`.
- The **preload** (`electron/preload.ts`) is emitted as **CommonJS with a `.cjs`
  extension**. This is required because the package is `type: module`, so a
  `.js`/`.mjs` preload would be treated as ESM, while Electron loads preload
  scripts as CommonJS. The `rollupOptions.output` is forced to `format: 'cjs'`
  with `entryFileNames: '[name].cjs'`.
- The renderer is left as a normal web build with no Node integration (the
  `renderer` transform option is deliberately omitted).

`electron-builder` then packages the app according to the `build` section of
`package.json` (see [electron-builder configuration](#electron-builder-configuration)).

## CI: `scripts/ci.sh` and `.github/workflows/ci.yml`

`scripts/ci.sh` is the single source of truth for "does the app build and pass
its checks." CI providers should do nothing more than check out the code, supply
a Node.js toolchain, and run it — so the same checks run locally with
`./scripts/ci.sh`. It runs from the repo root under `set -euo pipefail` and
executes, in order:

1. **Install** — `npm ci` when `package-lock.json` is present, else `npm install`.
   Skipped entirely when `SKIP_INSTALL=1` (deps already present).
2. **Type checking** — `npm run typecheck` (`tsc -b --noEmit`).
3. **Wiki link check** — `npm run check:wiki` (`scripts/check-wiki-links.js`,
   over `openwiki/` and `user-guide/`).
4. **Tests** — `npm test` (`vitest run`). The default vitest config excludes the
   slow integration suite (`*.integration.test.*`), so this is the fast
   per-PR unit-test gate.
5. **Build** — `npm run build` (the static SPA build, which also drives the
   `tsc -b` project-reference type-check).

`.github/workflows/ci.yml` runs this script on `ubuntu-latest` (Node 24) on
**push to `main`** and on **every pull request** (whatever it targets — a PR
onto a release branch needs the same checks as one onto main). It deliberately
does *not* combine a push-on-every-branch trigger, since a branch with an open
PR would then build twice per push. A `concurrency` group keyed on
`${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`
keeps only the newest commit per ref. `workflow_dispatch` allows a manual run.

### Integration and e2e tests (separately gated)

The heavier test suites are pulled out of the per-PR CI into a **reusable**
workflow, `.github/workflows/integration-tests.yml`, triggerable via
`workflow_call` and `workflow_dispatch`. It has two jobs:

- **`integration-test`** — `npm run test:integration`
  (`vitest run --config vitest.integration.config.ts`), the jsdom-based
  integration suite in `src/test/integration/` that spins up a real scratch git
  repo per test. It mocks the platform seam entirely.
- **`e2e-test`** — a real Electron smoke test (`npm run test:e2e`, which is
  `cross-env ELECTRON=1 npm run build && playwright test`) that launches the
  actual packaged main process and drives its real `contextBridge`/IPC. It needs
  a real display (Electron opens a native window on Linux regardless), hence
  `xvfb-run -a`.

`release.yml` gates its build job on this reusable workflow via `uses:`, so a
broken end-to-end workflow can't reach a packaged release, while the workflow
stays independently runnable from the Actions tab for a fast check without a
full release run.

## Release: `.github/workflows/release.yml`

Triggered on a **published GitHub Release** (`release: [published]`) and by
`workflow_dispatch` (a manual dry run that builds artifacts but uploads nothing
to a release). It requires `permissions: contents: write` to attach assets.

1. **`integration-tests`** job — calls `integration-tests.yml` (see above) as a
   gate.
2. **`build`** matrix job (`needs: integration-tests`, `fail-fast: false`) —
   one runner per OS, each running `./scripts/build-electron.sh`:

   | OS | Target | Artifacts uploaded | Feed signed |
   |---|---|---|---|
   | `macos-latest` | `dmg` (arm64 + x64) | `release/*.dmg` | — (no feed on mac) |
   | `windows-latest` | `nsis` | `*.exe`, `*.exe.blockmap`, `latest.yml`, `latest.yml.sig` | `release/latest.yml` |
   | `ubuntu-latest` | `AppImage` | `*.AppImage`, `latest-linux.yml`, `latest-linux.yml.sig` | `release/latest-linux.yml` |

   Artifacts are always uploaded to the workflow run (`sailor-<os>`, with
   `if-no-files-found: error`) so a `workflow_dispatch` build is still
   downloadable; they are attached to the release (`softprops/action-gh-release@v2`)
   only when `github.event_name == 'release'`.

`scripts/build-electron.sh` mirrors `ci.sh`'s shape: run from repo root,
optionally install deps (`SKIP_INSTALL=1` to skip), then `npm run build:electron`,
then `ls -lh release/`. electron-builder auto-detects the host OS and emits the
matching target into `./release/`.

### Release signing (Ed25519 feed signature)

Because there is no purchased Authenticode/Apple code-signing certificate
(see [Installer signing and user-side bypass](#installer-signing-and-user-side-bypass)),
`electron-updater`'s own publisher-signature check has nothing to verify
against, and its built-in sha512 installer check only guards against transport
corruption — the hash comes from the same release channel as the installer, so
whoever can publish one can publish a matching hash for the other. SaiLoR
closes that gap independently with an **Ed25519 signature over the feed file**:

- `scripts/sign-release.cjs` reads the `RELEASE_SIGNING_PRIVATE_KEY` secret (a
  PEM-encoded Ed25519 private key, present only in the release workflow's
  environment — never committed), signs the raw bytes of the feed file
  (`latest.yml` on Windows, `latest-linux.yml` on Linux), and writes
  `<path>.sig` (base64) next to it. It runs once per feed; macOS has no feed at
  all (see below) and is skipped (`matrix.feed` is empty).
- The matching **public key is baked into the app** at build time
  (`RELEASE_PUBLIC_KEY_B64` in `src/model/updateSignature.ts`), never fetched
  from the release channel being verified.
- At runtime, `electron/main.ts`'s `verifyUpdateFeed(version)` fetches the same
  feed file and its `.sig` directly from the release download URL, calls
  `verifyReleaseSignature(feedBytes, signatureB64, RELEASE_PUBLIC_KEY_B64)`, and
  **only proceeds to `autoUpdater.downloadUpdate()` if verification passes**.
  This chains trust: our signature covers the feed file, and electron-updater's
  existing sha512 check then covers the installer against that now-trusted feed.

The self-update path is **Windows/Linux only**. `autoUpdater.autoDownload` and
`autoInstallOnAppQuit` are both `false`, so a download only starts when the
renderer calls `update:download` (the reviewer clicked "Download update") after
`verifyUpdateFeed` succeeds, and install only happens on `update:install`
("Restart to update"). macOS is excluded entirely: electron-updater's
Squirrel.Mac path needs the update to pass Gatekeeper, which requires a real
Apple Developer ID signature and notarization that this project does not have;
mac keeps a check-only banner instead.

```mermaid
sequenceDiagram
  participant R as Renderer
  participant M as electron/main.ts
  participant U as electron-updater
  participant GH as GitHub Release

  R->>M: update:check
  M->>U: checkForUpdates()
  U->>GH: fetch latest.yml / latest-linux.yml
  U-->>M: update-available (version)
  M-->>R: update:available {version}
  R->>M: update:download (version)
  M->>GH: fetch feed + feed.sig
  M->>M: verifyReleaseSignature (Ed25519, baked-in pubkey)
  alt signature invalid
    M-->>R: update:error (not downloaded)
  else signature valid
    M->>U: downloadUpdate()
    U->>GH: download installer
    U-->>M: update-downloaded
    M-->>R: update:downloaded
    R->>M: update:install
    M->>U: quitAndInstall()
  end
```

*Self-update control flow (Windows/Linux). The app verifies the feed signature
before allowing electron-updater to download the installer.*

### Installer signing and user-side bypass

The installers themselves are **unsigned by Apple and Microsoft** — no
Developer ID / Authenticode certificate is configured. Two mitigations are in
place:

- **macOS ad-hoc signature (`scripts/afterPack.cjs`)** — the `afterPack` hook
  runs `codesign --force --deep --sign -` on the `.app` bundle when no
  `CSC_LINK`/`CSC_NAME` certificate is configured. Without it, electron-builder
  leaves only a linker-signed stub (`codesign --verify` fails, identifier is
  "Electron"), and a downloaded, quarantined app reports the dead-end
  *"SaiLoR" is damaged and can't be opened.* A free ad-hoc signature
  downgrades that to the ordinary "unidentified developer" prompt, which the
  user can bypass. If a real certificate *is* configured, the hook returns
  early so it does not clobber a proper signature. Notarizing with a real
  Developer ID is still the only way to get no prompt at all.
- **Windows** — the NSIS installer is unsigned, so Windows SmartScreen shows an
  "unrecognized publisher" warning. A real Authenticode certificate would remove
  that warning and build reputation over time, but update *authenticity* is
  already covered independently by the Ed25519 feed signature above.

User-side bypass steps:

- **macOS**: after downloading the `.dmg`, open it and drag SaiLoR to
  Applications. The ad-hoc signature means the first launch shows an
  "unidentified developer" prompt rather than "damaged" — right-click the app →
  *Open* → *Open* in the dialog to bypass, or remove the quarantine attribute
  with `xattr -dr com.apple.quarantine "/Applications/SaiLoR.app"`.
- **Windows**: run the `.exe` installer; if SmartScreen blocks it, click
  *More info* → *Run anyway*.

## electron-builder configuration

The `build` section of `package.json` configures packaging:

- `appId: io.github.gram21.sailor`, `productName: SaiLoR`.
- `asar: true`, `compression: maximum`, `electronLanguages: ["en-US"]`.
- `files`: `dist/**/*`, `dist-electron/**/*`, `build/icon.png`, excluding
  `**/*.map` and `node_modules/**/*`.
- `directories.output: release`, `directories.buildResources: build`.
- `afterPack: scripts/afterPack.cjs` (the macOS ad-hoc signing hook).
- `publish`: GitHub provider, owner `Gram21`, repo `SaiLoR` — the same
  `owner`/`repo` `electron/main.ts` uses to build its own feed URLs.
- Platform targets:
  - **macOS** — `dmg` for `arm64` and `x64`, icon `build/icon.icns`, with a
    custom `dmg` window layout.
  - **Windows** — `nsis`, icon `build/icon.png`.
  - **Linux** — `AppImage`, icon `build/icon.png`.
- Each target sets an `artifactName` of
  `${productName}-${version}-<os>-${arch}.${ext}`.

### npm install-script approval

`package.json` declares `allowScripts: { "esbuild@0.25.12": true }`, permitting
only esbuild's install script to run under the locked dependency set; all other
post-install scripts are blocked. This is the `pnpm`/modern-npm-style explicit
allowlist for native/build-tool install hooks.

## Docker-based Electron builds

`Dockerfile.electron` is a **build image for the Linux Electron installer**.
electron-builder needs glibc and system libraries, so it uses a Debian base
(`node:22-bookworm`, not Alpine), installs `ca-certificates` and `fakeroot`
(which electron-builder uses while packaging Linux targets), runs `npm ci` from
the lockfile (cached until it changes), and defaults to
`npm run build:electron`. It builds **Linux installers (AppImage) into
`/app/release`**; Windows/macOS installers must be built on their native OS
(Windows can also be cross-built by swapping the base for
`electronuserland/builder:wine`).

`docker-compose.dev.yml` bind-mounts the source at `.:/app` (with a named
`/app/node_modules` to keep host/container modules separate) so the image only
carries the toolchain + dependencies. The standard invocation is:

```
docker compose -f docker-compose.dev.yml run --rm electron
```

The compose service's `CMD` can be overridden for other tasks, e.g.
`... run --rm electron npm run build` (renderer-only) or
`... run --rm electron npm test` (unit tests). This is separate from the
production `Dockerfile`; the old web-serving Docker files were removed and the
app no longer ships a containerized web server.

## Wiki sync mechanics

Three workflows keep `openwiki/` (developer docs), `user-guide/` (the user
guide), and the GitHub wiki in sync. One is about *generating* docs; two are
about *mirroring* them to/from the wiki.

### OpenWiki generation

- **`openwiki.yml`** — the **scheduled weekly refresh**. Runs on a Monday 06:00
  UTC cron and `workflow_dispatch`, but does no work inline: it is a thin
  reusable-workflow call that delegates entirely to
  `ardoco/actions/.github/workflows/openwiki.yml@main`, passing the
  `OPENROUTER_API_KEY` secret. The actual generation logic (installing the
  `openwiki` CLI, running `--update --print`, opening a PR) lives in that shared
  workflow, not in this repo — this file only supplies the trigger and the
  secret.

### Wiki mirroring (publish ↔ import)

- **`wiki-publish.yml`** (*Publish openwiki → Wiki*) — triggers on `push` to
  `main` under `openwiki/**`, `user-guide/**`, `.github/wiki-assets/**`, or the
  workflow file itself, and `workflow_dispatch`. It clones `SaiLoR.wiki.git`,
  stages a combined layout: `Home.md` (always `.github/wiki-assets/Home.md`,
  verbatim), `Development.md` (from `openwiki/Home.md`, renamed so the wiki's
  own Home slot is free for the landing page), the rest of `openwiki/*.md` flat
  at the wiki root, `openwiki/{concepts,operations,workflows}/*.md` flattened
  one level deep under explicit `Section-Page` names
  (`Operations-Build-Release`, `Workflows-LLM-Annotation`, … — hand-written to
  keep acronym casing), flattened `user-guide/*.md` renamed to `Guide-*`,
  `user-guide/screenshots/**` flattened alongside the pages, and a global
  `_Sidebar.md`/`_Footer.md` assembled from `.github/wiki-assets/` plus a
  user-guide fragment wrapped in `<!-- wiki-sync:NAME:start/end -->` marker
  pairs. It strips OKF frontmatter, rewrites cross-links (bare `.md` filenames
  → extensionless wiki URLs, `Home` → `Development` in the sidebar,
  `../README.md` → absolute GitHub URLs in the user guide), and
  `rsync --delete` replaces the wiki. It commits as `github-actions[bot]` with a
  `[wiki-sync]` marker.

  `index.md` and `INSTRUCTIONS.md` are deliberately excluded — the former is
  OpenWiki's own directory listing, the latter is the generator's config; both
  are invisible-or-redundant on the wiki, so they stay in the repo only.

- **`wiki-import.yml`** (*Import Wiki → openwiki*) — the reverse direction,
  triggering on `gollum` (a wiki page create/update) and `workflow_dispatch`.
  It clones the wiki and maps each published piece back to its repo source:
  `Home.md` is dropped if it still carries the `<!-- wiki-sync:auto-home -->`
  marker (still the published template, nobody edited it), otherwise it
  replaces `.github/wiki-assets/Home.md`; `Development.md` → `openwiki/Home.md`;
  the `Section-Page` flattened pages → `openwiki/{section}/<page>.md` (reversing
  both the name flattening and the cross-link rewrites, including
  same-subsection siblings and `../` walk-ups); flattened `Guide-*` →
  `user-guide/<src>.md` (reversing the renames, link rewrites, and the absolute
  GitHub URLs back to `../README.md`/`../LICENSE`); `screenshots/` →
  `user-guide/screenshots/`; the `_Sidebar`/`_Footer` user-guide fragments →
  `.github/wiki-assets/` (lifted out of their `<!-- wiki-sync:NAME:start/end -->`
  marker pairs) and the `Development` → `Home` link reversed; then
  `rsync --delete --include '*.md' --exclude '*'` mirrors the remaining `*.md`
  into `openwiki/`. It commits to `main` with a `[wiki-sync]` marker.

### Why the two cannot trigger each other in a loop

Publish and import would otherwise form a loop: publish pushes to the wiki
(`gollum` → import → commit to main → `openwiki/**` push → publish → …). Three
independent layers prevent it:

1. **Concurrency** — both workflows share a `concurrency: group: wiki-sync`
   with `cancel-in-progress: false`, so the two directions can never run at the
   same time (a half-finished mirror is worse than a slow one).
2. **Commit-message guard** — `wiki-publish.yml` skips when the triggering
   commit message contains `[wiki-sync]` (the marker import's commits carry),
   so it never re-publishes a commit the import workflow itself created.
3. **Sender guard** — `wiki-import.yml` skips unless
   `github.event_name == 'workflow_dispatch'` (a manual run) or
   `github.event.sender.login != 'github-actions[bot]'` (the identity publish
   commits as), so it ignores wiki writes made by the publish workflow itself
   and only reacts to a human editing the wiki.

Together these mean each direction only reacts to *human*-originated changes on
the other side, not to the bot's own mirrored commits.
