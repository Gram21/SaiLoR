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

### REQ-PLT-11 — Single application instance
- **Description:** When the application is launched while another instance is running, the system shall not start a second instance and shall bring the existing window to the front.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `electron/main.ts:1559`, commit `0bc6c9c`
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

### REQ-PLT-41 — Write only changed files
- **Description:** When saving to the location a project was last opened from or saved to, the system shall write only the project file and the annotation files whose serialized content differs from what that open or save produced, leaving every other file byte-identical; after any git operation that can rewrite the working tree, the next save shall write every file.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/electron.ts:55,57-59,73-76,81-88,294`, commits `27bf461`, `4abaebb`
- **Verified by:** `src/platform/electron.test.ts` (`writes only the papers edited since the project was opened`, `forgets the baseline when a git call rewrites the working tree`)
- **Status:** Implemented

### REQ-PLT-42 — Remove files of removed or renamed papers
- **Description:** When saving to the same location, the system shall delete the annotation files the project previously wrote for a paper that has since been removed or whose identifier changed, subject to REQ-PLT-61, and shall remove a paper folder that deletion leaves empty; a folder still holding any other file shall be kept.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/electron.ts:319`, `electron/main.ts:928`, commit `fc8aa26`
- **Verified by:** `src/platform/electron.test.ts` (`deletes the files of a paper removed since the project was opened`, `moves a paper's files when its id is renamed`)
- **Status:** Implemented

### REQ-PLT-50 — Migrate single-file projects
- **Description:** When a pre-split single-file project is opened, the system shall load it unchanged and shall write the split layout on the next save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:517-524,637-651`, `src/model/project.ts:1036-1109`
- **Status:** Implemented

### REQ-PLT-60 — Tolerate corrupt annotation files
- **Description:** When an individual annotation file is unreadable or corrupt during project open, the system shall treat that file as absent and continue opening the project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:585-641`
- **Status:** Implemented

### REQ-PLT-61 — Never delete unparseable annotation files
- **Description:** When writing the `annotations/` folder, the system shall never delete an existing annotation file whose on-disk content is non-empty and not valid JSON, even when the in-memory project state maps that slot to absent.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src/model/project.ts:1041-1049` (`isDeletableAnnotationText`), `electron/main.ts:793-811`
- **Verified by:** `src/model/split.test.ts` (`isDeletableAnnotationText` describe block)
- **Status:** Implemented

### REQ-PLT-62 — Report unparseable annotation files on open
- **Description:** When a project opens with one or more annotation files that could not be parsed, the system shall keep the project loaded, shall surface a load error naming the affected files (capped at ten, with a count of any remainder) instead of silently treating them as unannotated, and shall keep a warning visible for as long as the project is open that displays the list again.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:439-453,506,1713`, `src/components/Toolbar.tsx:369`, `src/platform/adapter.ts`, commit `7e82c96`
- **Verified by:** `src/state/store.corruptFiles.test.ts`, `src/components/Toolbar.test.tsx` (`unreadable annotation files stay visible for the whole session`)
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

### REQ-PLT-135 — Stop saving over externally changed files
- **Description:** When a save would write or delete a file that has changed on disk, or has appeared, since the application last read or wrote it, the system shall write nothing and ask the user how to proceed (REQ-PLT-136), naming the changed files by paper and seat (up to ten, with a count of any remainder); files rewritten by the application's own git operations shall not count as changed.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `electron/main.ts:718,720-727,730-740,751-762,965`, `src/model/fileStamps.ts:41-45`, `src/platform/electron.ts:329`, `src/state/store.ts:1558`, `src/components/StaleSaveDialog.tsx:10-25`, commits `0bc6c9c`, `5e2abb4`
- **Verified by:** `src/model/fileStamps.test.ts`, `src/state/store.staleSave.test.ts` (`writes nothing and asks, instead of raising an error`)
- **Status:** Implemented

### REQ-PLT-136 — Resolve a save that met changed files
- **Description:** When a save has been stopped under REQ-PLT-135, the system shall offer to overwrite the changed files with the user's version, to keep the on-disk version of those files while saving the user's other edits, or to combine both versions with the field-level three-way merge of REQ-GIT-240 against the project as last read or written, letting the user decide each field both sides changed; files the user did not edit shall keep their on-disk content in every case. When the versions cannot be combined, the system shall say why and offer the other two choices; when the user postpones the decision, the next save shall ask again rather than write.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/staleSave.ts:33-86`, `src/state/store.ts:1102-1113,1524,1568-1669`, `src/components/StaleSaveDialog.tsx:33-140`, `src/components/ConflictResolutionDialog.tsx`, commit `5e2abb4`
- **Verified by:** `src/model/staleSave.test.ts`, `src/state/store.staleSave.test.ts`
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
