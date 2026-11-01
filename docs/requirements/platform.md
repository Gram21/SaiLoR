# Requirements — Platform, Desktop Shell & File Handling

Requirements for the Tauri desktop shell: project open/save, unsaved-changes
protection, recents, window/settings persistence, PDF file access, security posture,
self-update, and build targets. See the [index](index.md) for the glossary.

---

### REQ-PLT-10 — Desktop-only operation
- **Description:** When the application runs outside the Tauri desktop shell, the system shall present a notice that the web variant is discontinued and shall reject every project-opening action.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/unsupported.ts:4-28`, `src/platform/index.ts:9-24`, commit `7fbaa84`
- **Status:** Implemented

### REQ-PLT-11 — Single application instance
- **Description:** When the application is launched while another instance is running, the system shall not start a second instance and shall bring the existing window to the front.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src-tauri/src/main.rs` (`tauri_plugin_single_instance`), `src-tauri/src/shell.rs` (`focus_main`), commit `6ce60d5` (`electron/main.ts`, removed), commit `0bc6c9c`
- **Status:** Implemented

### REQ-PLT-20 — Open projects via native dialog
- **Description:** When "Open project" is triggered, the system shall present a native file-open dialog filtered to `.json` files and shall treat dialog cancellation as a no-op.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`project_open`, `open`)
- **Status:** Implemented

### REQ-PLT-30 — Restrict saves to session-authorized paths
- **Description:** The system shall write a project only to a path that was opened or chosen via a native dialog in the current session, and shall refuse writes to any other path.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src-tauri/src/authz.rs` (`Session`), `src-tauri/src/project.rs` (`save`, `project_open`, `project_pick_save_path`)
- **Verified by:** `src-tauri/src/project.rs` (`save_refuses_unauthorized_path`)
- **Status:** Implemented

### REQ-PLT-40 — Split project storage
- **Description:** The system shall store a project as a metadata-only `project.json` plus one annotation file per paper per reviewer seat under a sibling `annotations/` folder, and shall reassemble these into one logical project on open.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`read_project`, `write_project_files`), `src/platform/tauri.ts` (`assembleProject`), `src/model/project.ts:881-1029`, commit `7fbaa84`
- **Verified by:** `src-tauri/src/project.rs` (`save_round_trip_stale_and_deletion_rules`)
- **Status:** Implemented

### REQ-PLT-41 — Write only changed files
- **Description:** When saving to the location a project was last opened from or saved to, the system shall write only the project file and the annotation files whose serialized content differs from what that open or save produced, leaving every other file byte-identical; after any git operation that can rewrite the working tree, the next save shall write every file.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/desktop.ts` (`noteWritten`, `noteOpened`, `withBaselineDropped`, `saveProject`), commits `27bf461`, `4abaebb`
- **Verified by:** `src/platform/desktop.test.ts` (`writes only the papers edited since the project was opened`, `forgets the baseline when a git call rewrites the working tree`)
- **Status:** Implemented

### REQ-PLT-42 — Remove files of removed or renamed papers
- **Description:** When saving to the same location, the system shall delete the annotation files the project previously wrote for a paper that has since been removed or whose identifier changed, subject to REQ-PLT-61, and shall remove a paper folder that deletion leaves empty; a folder still holding any other file shall be kept.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/desktop.ts` (`saveProject`), `src-tauri/src/project.rs` (`write_project_files`), commit `fc8aa26`
- **Verified by:** `src/platform/desktop.test.ts` (`deletes the files of a paper removed since the project was opened`, `moves a paper's files when its id is renamed`)
- **Status:** Implemented

### REQ-PLT-43 — Do not rewrite files a schema version only migrated
- **Description:** When a save introduces a new schema version, the system shall compare each annotation file against its previous content as read under the new version, writing only files whose content changed beyond that migration.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/platform/desktop.ts` (`rebaselined`), commit `40e0668`
- **Verified by:** `src/platform/desktop.test.ts` (`writes only project.json when a new schema version renames a field nobody edited since`)
- **Status:** Implemented

### REQ-PLT-50 — Migrate single-file projects
- **Description:** When a pre-split single-file project is opened, the system shall load it unchanged and shall write the split layout on the next save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`is_legacy_shape`, `read_project`), `src/model/project.ts:1036-1109`
- **Status:** Implemented

### REQ-PLT-60 — Tolerate corrupt annotation files
- **Description:** When an individual annotation file is unreadable or corrupt during project open, the system shall treat that file as absent and continue opening the project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`read_project`, `safe_read`)
- **Status:** Implemented

### REQ-PLT-61 — Never delete unparseable annotation files
- **Description:** When writing the `annotations/` folder, the system shall never delete an existing annotation file whose on-disk content is non-empty and not valid JSON, even when the in-memory project state maps that slot to absent.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src/model/project.ts:1041-1049` (`isDeletableAnnotationText`), `src-tauri/src/project.rs` (`deletable`, `write_project_files`)
- **Verified by:** `src/model/split.test.ts` (`isDeletableAnnotationText` describe block), `src-tauri/src/project.rs` (`save_round_trip_stale_and_deletion_rules`)
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
- **Evidence:** `src-tauri/src/project.rs` (`write_project_files`), `src-tauri/src/authz.rs` (`assert_not_symlink`, `within`)
- **Verified by:** `src-tauri/src/project.rs` (`save_refuses_symlinks`, `save_refuses_escapes_and_feedback`)
- **Status:** Implemented

### REQ-PLT-80 — Save As with path rebasing
- **Description:** When a project is saved to a new location, the system shall re-derive every paper's relative PDF path against the new location, write nothing on dialog cancellation, and clear the undo history so undo cannot restore pre-rebase paths.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`project_pick_save_path`), `src-tauri/src/paths.rs` (`paths_rebase`), `src/platform/desktop.ts` (`rebasePdfPaths`), `src/state/store.saveas.test.ts:79-133`
- **Status:** Implemented

### REQ-PLT-90 — Keep one annotations folder per project
- **Description:** When a project is saved to a directory where another project file of the same kind (screening or annotation) listing at least one of the same paper identifiers already uses its annotations folder, the system shall save it with a folder named after the file instead, and refuse the save when that name is taken too; the project editor shall refuse a folder name another project file next to it uses while the two are of the same kind and share a paper identifier; other projects may share a folder.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/project.rs` (`projects_using_folder`), `src/state/store.ts`, commit `c1b40ec`, `src-tauri/src/annotations.rs` (`annotations_dir_users`)
- **Verified by:** `src/state/store.saveas.test.ts` (`takes a folder named after the file when the destination already uses the default one`), `src/state/editorStore.annotationsDir.test.ts`, `src-tauri/src/annotations.rs` (tests)
- **Status:** Implemented

### REQ-PLT-95 — Split a shared annotations folder
- **Description:** When a project is opened whose annotations folder other project files in the same directory also use while being of the same kind and listing at least one of the same paper identifiers, the system shall propose giving each of them its own folder, assigning each annotation file by paper identifier and file kind and, where several projects could own it, by the schema version it records or by which project's schema its answers fit, listing those files for confirmation and copying undecidable ones to each; on confirmation it shall copy the files, record each project's folder in its project file, and only then remove the originals, refusing while the open project has unsaved changes, a target folder is not empty, or a listed project file changed.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotationSplit.ts`, `src/components/SplitAnnotationsDialog.tsx`, commit `c1b40ec`, `src-tauri/src/annotations.rs` (`shared`, `split`)
- **Verified by:** `src/model/annotationSplit.test.ts`, `src/state/store.annotationsSplit.test.ts`, `src/test/integration/annotationSplit.integration.test.tsx`, `src-tauri/src/annotations.rs` (tests)
- **Status:** Implemented

### REQ-PLT-96 — Move the annotations folder on rename
- **Description:** When the annotations folder of a saved project is renamed in the project editor, the system shall rename the folder on disk and record the new name in the project file together, restoring the folder if the project file cannot be written.
- **Type:** Functional (ISO 25010: Reliability)
- **Evidence:** `src/state/editorStore.ts`, commit `c1b40ec`, `src-tauri/src/annotations.rs` (`move_dir`)
- **Verified by:** `src/state/editorStore.annotationsDir.test.ts` (`moves the folder of an existing project before saving the new name`), `src-tauri/src/annotations.rs` (tests)
- **Status:** Implemented

### REQ-PLT-100 — Prompt on close with unsaved changes
- **Description:** When the window is closed or the application quits with unsaved changes, the system shall present a three-choice dialog (Save, Don't Save, Cancel) and shall close only after a successful save or an explicit discard. The system shall show the same dialog for a window close and a user quit, and shall close after a save only when the dialog requested that save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/close.rs` (`intercept`, `app_set_dirty`, `app_save_complete`), `src/hooks/useCloseGuard.ts` (`useCloseGuard`), `src/state/store.close.test.ts:59-135`
- **Verified by:** `src-tauri/src/close.rs` (`dirty_project_asks_once_and_cancel_keeps_it_open`, `closes_only_after_a_requested_save_succeeds`)
- **Status:** Implemented

### REQ-PLT-110 — Keep project open on failed save
- **Description:** When a save triggered by a close or open-another-project prompt fails, the system shall keep the current project open and dirty.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.close.test.ts:59-252`
- **Status:** Implemented

### REQ-PLT-120 — Guard reload shortcuts
- **Description:** When a reload shortcut is used while unsaved changes exist, the system shall request confirmation before reloading, with Cancel as the default.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useDirtyGuard.ts` (`useDirtyGuard`), commit `6ce60d5` (`electron/main.ts`, removed)
- **Status:** Partial: the renderer registers a `beforeunload` guard while changes are unsaved. The Tauri shell has no reload confirmation dialog of its own.

### REQ-PLT-130 — Preserve newer changes during save
- **Description:** When the project changes while a save is being written, the system shall keep the project marked dirty and retain the newer in-memory value.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.save.test.ts:52-86`, commit `7f96e40`
- **Status:** Implemented

### REQ-PLT-135 — Stop saving over externally changed files
- **Description:** When a save would write or delete a file that has changed on disk, or has appeared, since the application last read or wrote it, the system shall write nothing and ask the user how to proceed (REQ-PLT-136), naming the changed files by paper and seat (up to ten, with a count of any remainder); files rewritten by the application's own git operations shall not count as changed.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src-tauri/src/project.rs` (`save`), `src-tauri/src/authz.rs` (`stamp`, `changed`), `src/model/fileStamps.ts:41-45`, `src/platform/desktop.ts` (`saveProject`), `src/state/store.ts:1558`, `src/components/StaleSaveDialog.tsx:10-25`, commits `0bc6c9c`, `5e2abb4`
- **Verified by:** `src/model/fileStamps.test.ts`, `src/state/store.staleSave.test.ts` (`writes nothing and asks, instead of raising an error`), `src-tauri/src/project.rs` (`save_round_trip_stale_and_deletion_rules`), `src-tauri/src/authz.rs` (`changed_targets_rule`)
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
- **Evidence:** `src-tauri/src/project.rs` (`project_peek`, `peek`), `src/platform/desktop.ts` (`checkRecents`), `src/platform/recents.ts:16-20`, `src/state/store.close.test.ts:137-175`
- **Verified by:** `src-tauri/src/project.rs` (`peek_reports_existence_and_title`)
- **Status:** Implemented

### REQ-PLT-160 — Persist window state
- **Description:** The system shall persist window size, position, and maximized state across runs, defaulting to 1400×900, and shall reuse a saved position only when it still overlaps a connected display.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/main.rs` (`tauri_plugin_window_state`, `StateFlags::SIZE | POSITION | MAXIMIZED`), `src-tauri/tauri.conf.json` (`app.windows`), commit `6ce60d5` (`electron/main.ts`, removed)
- **Status:** Implemented

### REQ-PLT-170 — Persist appearance settings
- **Description:** The system shall persist locally the theme (defaulting to the operating-system preference), the font scale (clamped to 0.7–2.0), the autosave toggle (off by default), and the pane widths.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/settings.ts`
- **Status:** Implemented

### REQ-PLT-180 — Migrate legacy settings folder
- **Description:** When the application starts with a never-used profile, the system shall copy window state and local storage from a pre-rename "SLR Helper" settings folder if one exists, without overwriting an existing profile and without failing startup on error.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** commit `6ce60d5` (`electron/main.ts`, removed)
- **Status:** Not implemented in the Tauri shell (Electron-only until 2.0.0)

### REQ-PLT-190 — Portable relative PDF paths
- **Description:** The system shall store each paper's PDF path relative to the project file using forward slashes on all platforms.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/paths.rs` (`relative`, `slashed`), `src/platform/adapter.ts:169-175`
- **Verified by:** `src-tauri/src/paths.rs` (`relative_matches_node`, `windows_separators_case_and_drives`)
- **Status:** Implemented

### REQ-PLT-200 — Confine PDF access to the project folder
- **Description:** The system shall serve a paper's PDF only when its resolved real path lies inside the project folder; for a path outside the folder, the system shall ask the user via a native main-process dialog and, on approval, allow that exact path for the current session only.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src-tauri/src/protocol.rs` (`serve`), `src-tauri/src/pdf.rs` (`resolve_project_path`, `pdf_allow_path`), commit `8c52edf`
- **Verified by:** `src-tauri/src/protocol.rs` (`statuses_and_traversal`), `src-tauri/src/pdf.rs` (`project_path_resolution`, `symlink_inside_project_pointing_out_is_an_escape`)
- **Status:** Implemented

### REQ-PLT-210 — Explain blocked PDF loads
- **Description:** When a paper's PDF cannot be loaded, the system shall report the specific reason (path escapes the project, file not found, or no project) instead of a generic load failure.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/pdf.rs` (`pdf_check_path`), `src/platform/desktop.ts` (`getPdfSource`), commit `445a6a5`
- **Status:** Implemented

### REQ-PLT-220 — Recursive PDF folder import
- **Description:** When a folder is picked for PDF import, the system shall collect every `*.pdf` file recursively, matching the extension case-insensitively and skipping unreadable directories.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/pdf.rs` (`collect_pdfs`, `pdf_pick_folder`)
- **Verified by:** `src-tauri/src/pdf.rs` (`folder_walk_finds_pdfs_case_insensitively`)
- **Status:** Implemented

### REQ-PLT-230 — Renderer sandboxing
- **Description:** The system shall give the user-interface webview no Node.js runtime. The webview shall reach native capability only through the commands that the shell registers. The capability file shall grant the webview only the `core:default` permission set.
- **Type:** Non-functional, design constraint (ISO 25010: Security)
- **Evidence:** `src-tauri/src/main.rs` (`generate_handler!`), `src-tauri/capabilities/default.json`, `src/platform/tauri.ts` (`command`, `tauriBridge`)
- **Status:** Implemented

### REQ-PLT-240 — Deny device permissions
- **Description:** The system shall deny every permission request of the WebView (camera, microphone, geolocation, notifications, and the other kinds the platform reports).
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src-tauri/src/main.rs` (`on_permission_request`), commit `6ce60d5` (`electron/main.ts`, removed)
- **Status:** Implemented. Platform limit: on macOS, WKWebView reports only camera and microphone requests to the app. macOS itself blocks geolocation and notifications, because the app has no entitlement or usage description for them.

### REQ-PLT-250 — Route external links to the system browser
- **Description:** The system shall deny in-app window creation and shall hand navigation away from the application document to the default system browser, restricted to the http, https, and mailto schemes.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** commit `6ce60d5` (`electron/main.ts`, removed)
- **Status:** Not implemented in the Tauri shell (Electron-only until 2.0.0)

### REQ-PLT-260 — Restrict export writes
- **Description:** The system shall write text and PDF exports only to destinations picked via an export save dialog in the current session, refusing symlinked targets and reporting failures as results rather than crashes. The system shall embed marks only into a PDF of the open project (inside the project folder or an approved outside path), also when it overwrites the original PDF.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src-tauri/src/pdf.rs` (`export_target`, `write_file`, `text_write`, `project_pdf`, `pdf_embed_marks`)
- **Verified by:** `src-tauri/src/pdf.rs` (`text_write_needs_an_export_dialog_path`, `text_write_refuses_a_symlink`, `embed_reads_only_project_pdfs`)
- **Status:** Implemented

### REQ-PLT-270 — Self-update per bundle type
- **Description:** The system shall offer in-app update download and install for the AppImage, the Windows installer and the macOS app. For the deb and rpm packages, the system shall report self-update as `{ supported: false, manual: true }`, so that their users update through the package manager. The update notice shall show the download and install buttons only when the shell reports self-update as supported, and shall otherwise show the download link.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/update.rs` (`self_update_supported`, `update_check`), `src/platform/adapter.ts` (`checkForNativeUpdate`), commit `9b8eb12`
- **Verified by:** `src-tauri/src/update.rs` (`only_appimage_windows_and_macos_self_update`), `src/state/store.update.test.ts`
- **Status:** Implemented

### REQ-PLT-280 — No unattended updates
- **Description:** The system shall download and install updates only on explicit user actions and shall never update automatically. The system shall take the update feed URL only from `tauri.conf.json` and never from the renderer.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src-tauri/src/update.rs` (`update_check`, `update_download`, `update_install`), `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`)
- **Verified by:** `src-tauri/src/update.rs` (`feed_is_fixed_https_github_and_signed_versions_are_required`)
- **Status:** Implemented

### REQ-PLT-290 — Verify update signatures
- **Description:** The system shall verify the minisign signature of the downloaded update artifact against the `plugins.updater.pubkey` in `tauri.conf.json`, shall require the signed version to match the announced version (`requireSignedVersion`), and shall report a failed verification as `update:error`.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src-tauri/src/update.rs` (`update_download`, `error`), `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, `requireSignedVersion`), commit `742ad60`
- **Verified by:** `src-tauri/src/update.rs` (`feed_is_fixed_https_github_and_signed_versions_are_required`)
- **Status:** Implemented

### REQ-PLT-300 — Startup update check
- **Description:** On startup, the system shall compare the running version against the latest published release using semantic-version ordering, cache the result for 15 minutes, remain silent on any check failure, and offer the installer asset matching the platform and architecture or the release page when none matches.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/version.ts:1-177`, `src/model/version.test.ts`, commit `c6d3689`
- **Status:** Implemented

### REQ-PLT-310 — Application undo via menu
- **Description:** The system shall route the Edit-menu Undo and Redo commands to the application's annotation history rather than native text undo, while keeping cut, copy, paste, and select-all native.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** commit `6ce60d5` (`electron/main.ts`, removed). The renderer still listens for `app:undo` and `app:redo` in `src/hooks/useCloseGuard.ts` (`useCloseGuard`), but the Tauri shell builds no Edit menu. `src/hooks/useKeybindings.ts` (`useKeybindings`) handles Ctrl/Cmd+Z and Ctrl/Cmd+Y.
- **Status:** Not implemented in the Tauri shell (Electron-only until 2.0.0)

### REQ-PLT-320 — Build targets
- **Description:** The system shall build the macOS app and dmg (arm64 and x64), the Windows NSIS installer (x64), and the Linux AppImage, deb and rpm packages (x64). The files shall use the Tauri default names, for example `SaiLoR_<version>_aarch64.dmg`, `SaiLoR_<version>_x64-setup.exe` and `SaiLoR_<version>_amd64.AppImage`. The macOS builds shall require macOS 15 or later. Each build shall include a signed updater artifact, and one `latest.json` feed shall list every platform. The release workflow shall attach these files to a draft release tagged `v<version>`. Only the AppImage, Windows and macOS builds shall update in-app. Users shall update the deb and rpm packages by hand.
- **Type:** Non-functional, design constraint (ISO 25010: Portability — Adaptability)
- **Evidence:** `.github/workflows/release.yml` (jobs `release`, `build`, `check-updater-json`), `src-tauri/tauri.release.conf.json` (`bundle.targets`, `createUpdaterArtifacts`), `src-tauri/tauri.conf.json` (`bundle.macOS.minimumSystemVersion`), `README.md` (release table)
- **Status:** Implemented

### REQ-PLT-330 — Ad-hoc sign unsigned macOS builds
- **Description:** When no Apple signing secrets are set, the release workflow shall ad-hoc sign the macOS app (`APPLE_SIGNING_IDENTITY=-`), so that macOS reports it as unidentified rather than damaged.
- **Type:** Non-functional, design constraint (ISO 25010: Usability — Operability)
- **Evidence:** `.github/workflows/release.yml` (job `build`, step "macOS signing and notarization (optional)")
- **Status:** Implemented

### REQ-PLT-340 — Optional autosave
- **Description:** When autosave is enabled, the system shall save the open project automatically every 5 minutes.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx` (Save menu), `src/state/settings.ts` (`slr.autosave`)
- **Status:** Implemented

### REQ-PLT-350 — Archive releases on Zenodo
- **Description:** When the draft GitHub release is published, the release workflow shall archive it on Zenodo as a new version of the existing SaiLoR record (concept record 23804729), so that all archived releases share one concept DOI. The Zenodo version shall use the release notes as description, the tag as version, and shall contain a source zip of the tagged commit plus every release asset. Files inherited from the previous Zenodo version shall be removed before upload. The step shall not run for tag pushes or manual workflow runs.
- **Type:** Non-functional, design constraint (ISO 25010: Portability — Adaptability)
- **Evidence:** `.github/workflows/release.yml` (job `zenodo`), `README.md` (Zenodo badge)
- **Status:** Implemented
