# Requirements — Platform, Desktop Shell & File Handling

Requirements for the Electron desktop shell: project open/save, unsaved-changes
protection, recents, window/settings persistence, PDF file access, security posture,
self-update, and build targets. See the [index](index.md) for the glossary.

---

### REQ-PLT-10 — Desktop-only operation
- **Description:** When the application runs outside the Electron desktop shell, the system shall present a notice that the web variant is discontinued and shall reject every project-opening action.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/unsupported.ts:4-28`, `src/platform/index.ts:10-23`, commit `7fbaa84`
- **Status:** Implemented

### REQ-PLT-20 — Open projects via native dialog
- **Description:** When "Open project" is triggered, the system shall present a native file-open dialog filtered to `.json` files and shall treat dialog cancellation as a no-op.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:659-670`
- **Status:** Implemented

### REQ-PLT-30 — Restrict saves to session-authorized paths
- **Description:** The system shall write a project only to a path that was opened or chosen via a native dialog in the current session, and shall refuse writes to any other path.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:657-807`, `e2e/openSaveProject.spec.ts:45-95`
- **Status:** Implemented

### REQ-PLT-40 — Split project storage
- **Description:** The system shall store a project as a metadata-only `project.json` plus one annotation file per paper per reviewer seat under a sibling `annotations/` folder, and shall reassemble these into one logical project on open.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:504-651,761-797`, `src/model/project.ts:881-1029`, `e2e/openSaveProject.spec.ts:129`, commit `7fbaa84`
- **Status:** Implemented

### REQ-PLT-50 — Migrate single-file projects
- **Description:** When a pre-split single-file project is opened, the system shall load it unchanged and shall write the split layout on the next save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:517-524,637-651`, `src/model/project.ts:1036-1109`
- **Status:** Implemented

### REQ-PLT-60 — Tolerate corrupt annotation files
- **Description:** When an individual annotation file is unreadable or corrupt during project open, the system shall treat that file as absent and continue opening the project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:585-631`
- **Status:** Implemented

### REQ-PLT-70 — Refuse symlinked and escaping write targets
- **Description:** The system shall refuse a file write whose target is a symbolic link or whose resolved path lies outside the project's `annotations/` directory.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:695-709,772-795`
- **Status:** Implemented

### REQ-PLT-80 — Save As with path rebasing
- **Description:** When a project is saved to a new location, the system shall re-derive every paper's relative PDF path against the new location, write nothing on dialog cancellation, and clear the undo history so undo cannot restore pre-rebase paths.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:822-831,1332-1339`, `src/state/store.saveas.test.ts:79-133`
- **Status:** Implemented

### REQ-PLT-90 — Refuse sibling-project collisions
- **Description:** When saving to a directory that contains another project of the same family sharing at least one paper identifier, the system shall refuse the save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:850-883`, `src/state/store.saveas.test.ts:134-152`, commit `a7c5153`
- **Status:** Implemented

### REQ-PLT-100 — Prompt on close with unsaved changes
- **Description:** When the window is closed or the application quits with unsaved changes, the system shall present a three-choice dialog (Save, Don't Save, Cancel) and shall close only after a successful save or an explicit discard.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:290-326,1372-1381`, `src/state/store.close.test.ts:59-135`
- **Status:** Implemented

### REQ-PLT-110 — Keep project open on failed save
- **Description:** When a save triggered by a close or open-another-project prompt fails, the system shall keep the current project open and dirty.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.close.test.ts:59-252`
- **Status:** Implemented

### REQ-PLT-120 — Guard reload shortcuts
- **Description:** When a reload shortcut is used while unsaved changes exist, the system shall request confirmation before reloading, with Cancel as the default.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:338-353,474-491`
- **Status:** Implemented

### REQ-PLT-130 — Preserve newer changes during save
- **Description:** When the project changes while a save is being written, the system shall keep the project marked dirty and retain the newer in-memory value.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.save.test.ts:52-86`, commit `7f96e40`
- **Status:** Implemented

### REQ-PLT-140 — Recent projects list
- **Description:** The system shall maintain a locally persisted list of the five most recently opened projects, newest first, deduplicated by absolute path, displaying each project's stored title.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/recents.ts:7-69`, `src/platform/recents.test.ts`
- **Status:** Implemented

### REQ-PLT-150 — Re-check recents on display
- **Description:** When displaying the recents list, the system shall re-check each entry's file existence and current title on disk, presenting missing files as unavailable while keeping their entries removable.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:956-975`, `src/platform/recents.ts:16-20`, `src/state/store.close.test.ts:137-175`
- **Status:** Implemented

### REQ-PLT-160 — Persist window state
- **Description:** The system shall persist window size, position, and maximized state across runs, defaulting to 1920×1080, and shall reuse a saved position only when it still overlaps a connected display.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:138-203,269-282`
- **Status:** Implemented

### REQ-PLT-170 — Persist appearance settings
- **Description:** The system shall persist locally the theme (defaulting to the operating-system preference), the font scale (clamped to 0.7–2.0), the autosave toggle (off by default), and the pane widths.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/settings.ts`
- **Status:** Implemented

### REQ-PLT-180 — Migrate legacy settings folder
- **Description:** When the application starts with a never-used profile, the system shall copy window state and local storage from a pre-rename "SLR Helper" settings folder if one exists, without overwriting an existing profile and without failing startup on error.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:91-134`, `README.md` ("Upgrading from SLR Helper?")
- **Status:** Implemented

### REQ-PLT-190 — Portable relative PDF paths
- **Description:** The system shall store each paper's PDF path relative to the project file using forward slashes on all platforms.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1323-1328`, `src/platform/adapter.ts:169-175`
- **Status:** Implemented

### REQ-PLT-200 — Confine PDF access to the project folder
- **Description:** The system shall serve a paper's PDF only when its resolved real path lies inside the project folder; for a path outside the folder, the system shall ask the user via a native main-process dialog and, on approval, allow that exact path for the current session only.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:361-410,1002-1026`, commit `8c52edf`
- **Status:** Implemented

### REQ-PLT-210 — Explain blocked PDF loads
- **Description:** When a paper's PDF cannot be loaded, the system shall report the specific reason (path escapes the project, file not found, or no project) instead of a generic load failure.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:991-1000`, `src/platform/electron.ts:249-295`, commit `445a6a5`
- **Status:** Implemented

### REQ-PLT-220 — Recursive PDF folder import
- **Description:** When a folder is picked for PDF import, the system shall collect every `*.pdf` file recursively, matching the extension case-insensitively and skipping unreadable directories.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:904-933`
- **Status:** Implemented

### REQ-PLT-230 — Renderer sandboxing
- **Description:** The system shall run the user-interface process with context isolation, disabled Node integration, and the Chromium sandbox, exposing native capability only through one preload bridge.
- **Type:** Non-functional, design constraint (ISO 25010: Security)
- **Evidence:** `electron/main.ts:244-249`, `electron/preload.ts:7`
- **Status:** Implemented

### REQ-PLT-240 — Deny device permissions
- **Description:** The system shall deny all Chromium permission requests (camera, microphone, geolocation, notifications).
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1389-1394`
- **Status:** Implemented

### REQ-PLT-250 — Route external links to the system browser
- **Description:** The system shall deny in-app window creation and shall hand navigation away from the application document to the default system browser, restricted to the http, https, and mailto schemes.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:205-224,254-266`
- **Status:** Implemented

### REQ-PLT-260 — Restrict export writes
- **Description:** The system shall write text and PDF exports only to destinations picked via an export save dialog in the current session, refusing symlinked targets and reporting failures as results rather than crashes.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1146-1221`
- **Status:** Implemented

### REQ-PLT-270 — Self-update on Windows and Linux only
- **Description:** The system shall offer in-app update download and install on Windows and Linux, and shall report self-update as unsupported on macOS while still offering an update notice.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1223-1321`, `src/platform/adapter.ts:291-316`, commit `9b8eb12`
- **Status:** Implemented

### REQ-PLT-280 — No unattended updates
- **Description:** The system shall download and install updates only on explicit user actions and shall never update automatically.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1235-1237`
- **Status:** Implemented

### REQ-PLT-290 — Verify update-feed signatures
- **Description:** Before downloading any update, the system shall verify an Ed25519 signature on the update feed against a public key embedded at build time, and shall abort the download with an error when verification fails.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1254-1316`, `src/model/updateSignature.ts:28-59`, commit `742ad60`
- **Status:** Implemented

### REQ-PLT-300 — Startup update check
- **Description:** On startup, the system shall compare the running version against the latest published release using semantic-version ordering, cache the result for 15 minutes, remain silent on any check failure, and offer the installer asset matching the platform and architecture or the release page when none matches.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/version.ts:1-177`, `src/model/version.test.ts`, commit `c6d3689`
- **Status:** Implemented

### REQ-PLT-310 — Application undo via menu
- **Description:** The system shall route the Edit-menu Undo and Redo commands to the application's annotation history rather than native text undo, while keeping cut, copy, paste, and select-all native.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:447-469`, `electron/preload.ts:62-69`
- **Status:** Implemented

### REQ-PLT-320 — Build targets
- **Description:** The system shall build distributable installers for macOS (dmg, arm64 and x64), Windows (NSIS installer, x64), and Linux (AppImage, x64), named `SaiLoR-<version>-<os>-<arch>.<ext>`.
- **Type:** Non-functional, design constraint (ISO 25010: Portability — Adaptability)
- **Evidence:** `package.json:51-117`, `README.md` (release table)
- **Status:** Implemented

### REQ-PLT-330 — Ad-hoc sign unsigned macOS builds
- **Description:** When no code-signing certificate is configured, the build shall ad-hoc sign the macOS application so that macOS reports it as unidentified rather than damaged.
- **Type:** Non-functional, design constraint (ISO 25010: Usability — Operability)
- **Evidence:** `scripts/afterPack.cjs`, commit `3850b55`
- **Status:** Implemented

### REQ-PLT-340 — Optional autosave
- **Description:** When autosave is enabled, the system shall save the open project automatically every 5 minutes.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx` (Save menu), `src/state/settings.ts` (`slr.autosave`)
- **Status:** Implemented
