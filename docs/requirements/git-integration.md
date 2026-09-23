# Requirements — Git Integration

Requirements for sharing projects between reviewers via git: clone, status/commit,
pull/merge, branches, stashes, history, repository setup, and the security gates around
git execution.
See the [index](index.md) for the glossary.

---

### REQ-GIT-10 — Use the user's installed git
- **Description:** The system shall execute git operations through the git binary installed on the user's machine, detected at project open via a version probe.
- **Type:** Functional, design constraint: external git binary (ISO 25010: Compatibility — Interoperability)
- **Evidence:** `electron/main.ts:1761`, `src/git/types.ts:28-34`
- **Status:** Implemented

### REQ-GIT-20 — Confine git execution to the main process
- **Description:** The system shall execute git and access the repository filesystem only in the desktop application's main process, transferring raw command output to the user interface layer for parsing.
- **Type:** Non-functional, architecture constraint (ISO 25010: Security)
- **Evidence:** `src/git/types.ts:1-6,155-166`, `electron/main.ts:1761-2604`
- **Status:** Implemented

### REQ-GIT-30 — Neutralize hostile repository configuration
- **Description:** When invoking git, the system shall override repository-local configuration for hooks, filesystem monitor, pager, editor, alternate-refs command, pack-objects hook, and the `ext` protocol so that a received repository's configuration cannot execute code.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1668,1696` (`GIT_SAFE_CONFIG`)
- **Status:** Implemented

### REQ-GIT-40 — Disable interactive git prompts
- **Description:** When invoking git, the system shall disable terminal credential prompts and editor invocation, so that authentication flows only through the user's configured credential helpers or SSH agent.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1618` (`gitEnv`)
- **Status:** Implemented

### REQ-GIT-50 — Bound git command duration
- **Description:** The system shall terminate a git command that has not completed within a configured timeout, with network operations (clone, fetch, push, pull) allowed 900 seconds.
- **Type:** Non-functional (ISO 25010: Performance Efficiency, Reliability)
- **Evidence:** `electron/main.ts:1597,1692,1782,2200,2317,2340`
- **Status:** Implemented

### REQ-GIT-60 — Validate clone URLs
- **Description:** When a repository URL is entered for cloning, the system shall accept only the https, http, ssh, git, git+ssh, and file transports, scp-style remotes, and absolute local paths, and shall reject remote-helper prefixes, leading dashes, and control characters.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/git/url.ts:17-38`, `src/git/url.test.ts`
- **Status:** Implemented

### REQ-GIT-70 — Validate repository-relative paths
- **Description:** When the user-interface layer supplies a repository-relative path, the system shall reject paths that are empty, absolute, contain parent-directory traversal, contain control characters, or contain a `.git` component.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/git/relpath.ts:15-52`, `electron/main.ts:1729`
- **Status:** Implemented

### REQ-GIT-80 — Validate ref names
- **Description:** When the user-interface layer supplies a git ref name, the system shall reject names that are empty, begin with a dash, contain control characters, or contain git revision-syntax characters, and shall verify that the ref resolves to a commit before use.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/git/ref.ts:21-60`, `electron/main.ts:1742,2331,2345`
- **Status:** Implemented

### REQ-GIT-90 — Restrict operations to session-known roots
- **Description:** The system shall execute repository operations only against repository roots that were established in the current session via project open or clone.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1753-1756`
- **Status:** Implemented

### REQ-GIT-100 — Clone a project repository
- **Description:** When a valid repository URL and a destination folder are provided, the system shall clone the repository, display elapsed time during the clone, and offer selection of a project file inside the clone for opening.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1768-1791`, `src/state/gitStore.ts:731-790`, `src/components/GitCloneDialog.tsx`
- **Status:** Implemented

### REQ-GIT-110 — Detect repository context on open
- **Description:** When a project is opened, the system shall determine whether the project lies in a git work tree and derive the repository root, the project's repository-relative path, the current branch, the upstream branch, and — without fetching — the number of commits the upstream is ahead as of the last fetch.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1993`, `src/git/deriveGitInfo.ts:47-57`, commit `a068166`
- **Verified by:** `src/git/deriveGitInfo.test.ts`
- **Status:** Implemented

### REQ-GIT-120 — Show working-tree status and diff
- **Description:** When the Git panel is opened, the system shall display the parsed working-tree status and the diff against HEAD, truncating diff text beyond 200,000 characters with a truncation indicator.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1823`, `src/git/output.ts:12-74`
- **Status:** Implemented

### REQ-GIT-130 — Field-level review of project changes
- **Description:** When the project's own files have uncommitted changes and no structural difference exists, the system shall present each changed annotation field as a row with its previous and current value and a per-row disposition of Use, Ignore, or Discard, defaulting to Use.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/changes.ts:21-471`, `src/state/gitStore.ts:583`, `gitStore.test.ts:389-495`
- **Status:** Implemented

### REQ-GIT-140 — Whole-file fallback for structural changes
- **Description:** When project changes include structural differences (schema, reviewer count, screening configuration, version, title, provenance, or protocol), the system shall replace the field-level review with a whole-file commit option.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/changes.ts:239`, `gitStore.test.ts:414`
- **Status:** Implemented

### REQ-GIT-150 — Commit a subset of field changes
- **Description:** When a commit is made with a mix of dispositions, the system shall commit exactly the rows marked Use, keep rows marked Ignore in the working tree for later, and remove rows marked Discard from the working file, restoring the working content even when the commit fails.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2029-2078` (`git:commitPartial`), `gitStore.test.ts:497-587,646-712`
- **Status:** Implemented

### REQ-GIT-160 — Confirm mixed discard commits
- **Description:** When a commit includes at least one Discard row together with Use rows, the system shall request confirmation naming the values that will be reverted or deleted.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/GitDialog.test.ts:4-55`, commit `6285ce4`
- **Status:** Implemented

### REQ-GIT-170 — Stage only the project's own files
- **Description:** When committing a field-level review or completing a merge, the system shall stage and commit only the project file, the paths the user selected, and the changed files under the annotations directory that belong to the project — listing untracked files individually so that a paper's first annotation file is included — and shall never stage a sibling project's files; commits shall be pathspec-limited so separately staged work is not disturbed.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2227-2238,2262,2768`, `src/git/ownAnnotationPath.ts:82-95`, commits `2d0d9e0`, `52ce0b7`
- **Verified by:** `src/git/ownAnnotationPath.test.ts` (`ownAnnotationPathsIn`, `ownAnnotationPathsIn needs files, not collapsed folders`)
- **Status:** Implemented

### REQ-GIT-180 — Amend previous commit
- **Description:** When the amend option is selected, the system shall amend the previous commit and prefill an empty commit message with the previous commit's message without overwriting typed text.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2191`, `gitStore.test.ts:589-636`, commit `a7b594f`
- **Status:** Implemented

### REQ-GIT-190 — Protect project files from whole-file discard
- **Description:** The system shall reject a whole-file discard targeting the project's own file or any file under its annotations directory, enforced in the main process.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2129-2168`, `src/components/GitDialog.tsx:416-421`
- **Status:** Implemented

### REQ-GIT-200 — Refuse writes on stale snapshots
- **Description:** When the working file on disk no longer matches the field-review snapshot at commit or discard time, the system shall refuse the write and refresh the review.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/gitStore.ts:650-687`, `gitStore.test.ts:568,714`
- **Status:** Implemented

### REQ-GIT-210 — Block merges over unsaved changes
- **Description:** When the in-memory project has unsaved annotation changes, the system shall refuse pull, merge, and branch-switch operations.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/gitStore.ts:439`, `gitStore.test.ts:368,815,954`, commit `909f674`
- **Status:** Implemented

### REQ-GIT-215 — Block merges over uncommitted annotation files
- **Description:** When a pull or merge is started while tracked files have uncommitted changes, or while an untracked file exists in the project's annotations directory, the system shall refuse it and name the files; untracked files elsewhere in the repository shall not block it.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/relpath.ts:70-77`, `electron/main.ts:2475-2478`, commit `ae0e23c`
- **Verified by:** `src/git/relpath.test.ts` (`mergeBlockingPaths`)
- **Status:** Implemented

### REQ-GIT-220 — Pull as classified upstream merge
- **Description:** When Pull is triggered, the system shall fetch the upstream and classify the result as up-to-date, fast-forwarded, or requiring a merge, and shall report a missing upstream as an error naming the branch.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2304-2329`, `src/git/types.ts:111-136`, `src/state/gitStore.ts:1086-1112`
- **Status:** Implemented

### REQ-GIT-230 — Abort merges touching foreign files
- **Description:** When a merge produces an unmerged path outside the project's own file family, the system shall abort the merge and restore the pre-merge state.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts` (`beginMergeInto`), `src/git/ownAnnotationPath.ts:47-64`, `gitStore.test.ts:1032`
- **Status:** Implemented

### REQ-GIT-240 — Field-level three-way merge
- **Description:** When merging conflicting project versions, the system shall merge at annotation-field granularity from the common base, where a side that did not change a value away from the base does not determine the result.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:109,982`, `src/git/merge.test.ts`
- **Status:** Implemented

### REQ-GIT-250 — Merge project settings part by part
- **Description:** When the two sides of a merge both changed a project-level setting differently, the system shall present it as a conflict row instead of refusing: the reviewer count as an editable number, the AI and finished-checkbox switches as booleans, each review-protocol entry as editable text, and the screening setup, provenance, and unknown root or paper keys as a choice between the two sides, a screening choice carrying its derived schema; only a differing file format version shall refuse the merge.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:423-448,1183-1352,1409-1516`, commit `543cb13`
- **Verified by:** `src/git/merge.test.ts` (`asks for the reviewer count when both sides changed it, differently`, `asks per protocol entry when both sides edited it differently — never half-drops an authored one`)
- **Status:** Implemented

### REQ-GIT-255 — Merge the schema node by node
- **Description:** When merging, the system shall combine the annotation schemas node by node, identifying a node by its name within its parent: nodes one side added shall be kept, nodes one side removed while the other left them unchanged shall be removed, a node removed on one side and changed on the other shall be offered as keep-or-remove, and each property both sides changed differently shall be a conflict row (description, required, minimum, maximum, and fixed choices editable; kind of answer and visibility condition chosen by side); before writing a resolved merge the system shall verify that the result loads and otherwise write nothing and say why.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:878-896,905-1005,1009-1014,1027-1061,1370-1377`, `src/state/gitStore.ts:408`, `src/state/store.ts:1654`, commit `543cb13`
- **Verified by:** `src/git/merge.test.ts` (`mergeProjects — schema, node by node`, `mergeResultProblem`, `combines a schema both sides extended, node by node`), `src/state/gitStore.test.ts` (`a schema both sides extended merges node by node instead of aborting`)
- **Status:** Implemented

### REQ-GIT-256 — Merge across schema versions
- **Description:** When merging, the system shall combine both sides' schema histories and apply to each side the renames and moves it has not seen before merging, so an edit under a field's old name merges into the field the other side renamed; the merged schema version shall be the side's version that already includes the other's, or a new version descending from both.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:1379,1397`, commit `40e0668`
- **Verified by:** `src/git/merge.test.ts` (`merges an edit made under the old name into the field the other side renamed`, `gives a merge of two new versions a version descending from both`)
- **Status:** Implemented

### REQ-GIT-257 — Ask about conflicting renames
- **Description:** When both sides of a merge renamed or moved the same schema node to different places since the merge base, the system shall present one conflict row offering either side's name, merge both sides' answers under the chosen name, and record the chosen move in the merged schema version so that files later arriving from either branch are read under that name.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:1476-1501,1045`, commit `c9c982f`
- **Verified by:** `src/git/merge.test.ts` (`mergeProjects — a field renamed differently on each side`)
- **Status:** Implemented

### REQ-GIT-260 — Keep answers under removed schema fields
- **Description:** When a merge removes a schema field that holds recorded answers on either side, the system shall keep those answers as hidden answers (REQ-DAT-165) and add a merge note naming the field and the answer count.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:1144-1176`, commit `543cb13`
- **Verified by:** `src/git/merge.test.ts` (`keeps answers under a field the remote removed, hidden, and says so`)
- **Status:** Implemented

### REQ-GIT-270 — Preserve repeatable entries in merges
- **Description:** When both merge sides added entries to a repeatable node, the system shall keep both sides' additions; when one side shrank a node the other side edited at or beyond the dropped index, the system shall refuse the merge.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:207,279,352`, commit `7130d4c`
- **Status:** Implemented

### REQ-GIT-280 — Keep changed papers over deletion
- **Description:** When a paper is deleted on one merge side and changed on the other, the system shall keep the paper and note the retention; deletion shall take effect only when the keeping side left the paper untouched.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:77,794,813`
- **Status:** Implemented

### REQ-GIT-290 — Auto-finish conflict-free merges
- **Description:** When a merge produces zero user-facing conflicts, the system shall complete the merge commit without opening a resolution dialog.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/gitStore.ts:376,548`, `gitStore.test.ts:308,325`
- **Status:** Implemented

### REQ-GIT-300 — Interactive conflict resolution
- **Description:** When a merge produces conflicts, the system shall present each conflicting field with both sides' values, allow per-field or bulk resolution, default unresolved conflicts to the local side, and exit only via Finish or an explicit Cancel that aborts the merge.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/gitStore.ts:1303-1337`, `src/git/merge.ts:1280`, `src/components/GitMergeDialog.tsx`
- **Status:** Implemented

### REQ-GIT-310 — Scope bulk resolution to own seat
- **Description:** When bulk conflict resolution is applied, the system shall exclude conflicts inside other reviewers' annotation trees from the bulk action.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/GitMergeDialog.test.ts:5-15`, `gitStore.test.ts:730-792`
- **Status:** Implemented

### REQ-GIT-320 — Manual push only
- **Description:** The system shall push commits to the remote only when the user triggers Push, and shall never push automatically.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2196-2200`, `e2e/gitPush.spec.ts`
- **Status:** Implemented

### REQ-GIT-330 — Merge any branch
- **Description:** When a local or remote-tracking branch is selected for merging, the system shall merge it into the current branch using the same classification, refusal, and resolution flow as Pull, fetching first only for remote-tracking refs.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2329-2345`, `gitStore.test.ts:953-1085`, commit `fa15e8b`
- **Status:** Implemented

### REQ-GIT-340 — Create and switch branches
- **Description:** The system shall create a new branch at HEAD on request and switch between local branches, treating a switch to the current branch as a no-op.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2447,2470`, `gitStore.test.ts:795-809,1088-1153`
- **Status:** Implemented

### REQ-GIT-350 — Carry uncommitted changes across branch switch
- **Description:** When switching branches with uncommitted project changes, the system shall offer carrying the changes over, committing first, or cancelling; a carry-over shall stash only the project's own files — a paper's first annotation file included — refuse when unrelated files are dirty, and resolve differences via the three-way merge flow, restoring the source branch and stash on cancel. The carry-over stash shall be located by its message rather than its position, and when it cannot be restored the system shall report that the changes are kept as a stash and where to restore them.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2899,3007,3017`, `src/git/stashOps.ts:167-169,172-176,180-184`, `src/state/gitStore.ts:1766`, commits `8eb8ed8`, `52ce0b7`, `e6444c1`, `e23ab84`
- **Verified by:** `gitStore.test.ts:829-951`, `src/state/gitStore.test.ts` (`a carry-over that cannot be put back is never silent`), `src/test/integration/stashOps.integration.test.tsx` (`the branch-switch carry-over is found by name, not by position`)
- **Status:** Implemented

### REQ-GIT-360 — Safe branch deletion
- **Description:** When a local branch is deleted, the system shall use only the merged-branch deletion mode and surface git's not-fully-merged refusal as an error, and shall not delete remote branches.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2460`, `gitStore.test.ts:1155-1196`
- **Status:** Implemented

### REQ-GIT-370 — Project-scoped history
- **Description:** When the history view is opened, the system shall list commits touching the project file and its annotations directory, capped at 250 commits with a truncation indicator, and shall expand each commit on demand into a field-level read-only diff against its parent.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1954-1991`, `src/components/GitHistoryDialog.tsx:30-137`, commit `f6af7fe`
- **Status:** Implemented

### REQ-GIT-380 — Concurrent multi-file project reads
- **Description:** When reading a project's split files from a revision or from disk, the system shall issue the per-file reads concurrently and reassemble results by index so that completion order cannot mismatch file and content.
- **Type:** Non-functional (ISO 25010: Performance Efficiency)
- **Evidence:** `src/git/concurrentRead.ts:20`, commits `18d6bf9`, `63e7bc7`
- **Status:** Implemented

### REQ-GIT-390 — Report git failures as messages
- **Description:** When a git command fails, the system shall display the command's error output as a message rather than terminating the operation flow abnormally.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/types.ts:20-26`, `src/git/output.ts:138`
- **Status:** Implemented

### REQ-GIT-400 — Refuse commits on a detached HEAD
- **Description:** When a commit is requested while HEAD is not on a branch, the system shall refuse it with an explanation of how to check out a branch and shall create no commit; a repository with no commits yet shall not be treated as detached.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `electron/main.ts:2418-2432,2435`, commit `39fcad1`
- **Status:** Implemented

### REQ-GIT-410 — Git rules for annotation data
- **Description:** When a project lies in a git repository, the system shall maintain, in the `.gitattributes` and `.gitignore` next to the project file, a delimited block that normalizes JSON line endings to LF, disables git's line merge for JSON, and ignores operating-system metadata files, preserving all content outside the block and never ignoring PDF files.
- **Type:** Non-functional (ISO 25010: Compatibility — Interoperability)
- **Evidence:** `src/git/repoSetup.ts:40-52,55-64,83-105`, `electron/main.ts:2668-2676,2678`, commit `b5cfee0`
- **Verified by:** `src/git/repoSetup.test.ts`
- **Status:** Implemented

### REQ-GIT-411 — Consent and commit for repository rules
- **Description:** When the repository rules of REQ-GIT-410 are missing, the system shall add them without asking if neither file has content of its own and otherwise only after the user consents, shall commit the change with SaiLoR as author and the user as committer, and shall announce the commit in a transient notice that dismisses itself on success and remains until closed on failure.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/repoSetup.ts:118-130,135`, `src/state/gitStore.ts:773,794`, `electron/main.ts:2688`, `src/components/RepoSetupPrompt.tsx`, `src/components/RepoSetupToast.tsx`, commits `b5cfee0`, `0c92b1a`
- **Verified by:** `src/git/repoSetup.test.ts` (`planRepoSetup`), `src/components/RepoSetupToast.test.tsx`
- **Status:** Implemented

### REQ-GIT-420 — Show unpulled work
- **Description:** When the current branch is known, as of the last fetch, to be behind its upstream, the system shall show the number of commits to pull in the toolbar and open the Git panel when it is activated, and shall show nothing when the count is zero or unknown; the count shall be refreshed after each background fetch (REQ-GIT-425).
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx:354`, `src/state/gitStore.ts:199`, commits `b5cfee0`, `51a424d`
- **Verified by:** `src/components/Toolbar.test.tsx` (`unpulled work and repository setup are visible in the toolbar`)
- **Status:** Implemented

### REQ-GIT-425 — Background fetch
- **Description:** While a project in a repository with an upstream is open, the system shall fetch when the repository is detected, whenever the Git panel opens, and every two minutes, without prompting for credentials and abandoning a fetch after 60 seconds; it shall not start one while a git operation the user began is running or another background fetch is in progress, shall make pull, merge, and push wait for a running background fetch, and shall not fetch in the background at all when the repository's own configuration names a command a fetch would run or includes another configuration file.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/git/fetchPolicy.ts:26,31,47,53-55,63-68`, `electron/main.ts:2736`, `src/state/gitStore.ts:457,912`, `src/hooks/useUpstreamPolling.ts:19-29`, commit `51a424d`
- **Verified by:** `src/test/integration/fetchPolicy.integration.test.tsx`, `src/state/gitStore.test.ts` (`keeping the unpulled count fresh`), `src/hooks/useUpstreamPolling.test.tsx`
- **Status:** Implemented

### REQ-GIT-430 — List stashed changes
- **Description:** The system shall list every stash in the repository in the Git panel, newest first, with its origin (a branch-switch carry-over, the Git panel, or elsewhere), branch, and date, expanding the list whenever it is non-empty, and shall show in the toolbar the number of stashes the application created while any exist.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/stash.ts:60-80,84-90`, `src/components/GitStashSection.tsx`, `src/components/Toolbar.tsx:339`, commit `e6444c1`
- **Verified by:** `src/git/stash.test.ts`, `src/components/GitStashSection.test.tsx`
- **Status:** Implemented

### REQ-GIT-440 — Stash the project's own changes
- **Description:** When the user stashes changes, the system shall stash only the project file and the project's own annotation files, untracked files included, shall refuse while the in-memory project has unsaved changes, and shall reload the project from disk afterwards.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/stashOps.ts:51-62`, `src/state/gitStore.ts:833`, `electron/main.ts:3037`, commit `e6444c1`
- **Verified by:** `src/test/integration/stashOps.integration.test.tsx` (`pushStash`), `src/state/gitStore.test.ts` (`stashed changes`)
- **Status:** Implemented

### REQ-GIT-450 — All-or-nothing stash restore
- **Description:** When a stash is restored, the system shall apply it only onto a tree without uncommitted tracked changes or untracked annotation files, shall remove the stash on success, and — when it does not apply cleanly — shall return every file to its state before the attempt, keep the stash, and report that nothing was changed.
- **Type:** Non-functional (ISO 25010: Reliability — Recoverability)
- **Evidence:** `src/git/stashOps.ts:85-109,122-128`, `src/state/gitStore.ts:846`, commit `e6444c1`
- **Verified by:** `src/test/integration/stashOps.integration.test.tsx` (`restoreStash`, incl. `rolls a conflicting restore all the way back, keeping the stash`)
- **Status:** Implemented

### REQ-GIT-460 — Restore a stash on a new branch
- **Description:** When the user restores a stash on a new branch, the system shall create a uniquely named branch at the commit the stash was taken from, apply the stash there, and remove it, refusing under the same conditions as REQ-GIT-450.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/stashOps.ts:147-157`, `src/git/stash.ts:93-102`, `src/state/gitStore.ts:884`, commit `e6444c1`
- **Verified by:** `src/test/integration/stashOps.integration.test.tsx` (`branchFromStash`), `src/state/gitStore.test.ts` (`restores onto a branch that does not already exist`)
- **Status:** Implemented

### REQ-GIT-470 — Confirm stash deletion
- **Description:** When a stash is deleted, the system shall request confirmation stating that its changes will be lost for good, and shall keep the stash when declined.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/GitStashSection.tsx:38`, `src/git/stashOps.ts:131-135`, commit `e6444c1`
- **Verified by:** `src/components/GitStashSection.test.tsx`
- **Status:** Implemented

### REQ-GIT-480 — Identify stashes by commit
- **Description:** The system shall identify a stash across the user-interface boundary by its commit identifier and resolve it to its current reflog position at the moment of each operation.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src/git/stashOps.ts:35-37`, `electron/main.ts:3028-3030`, commit `e6444c1`
- **Verified by:** `src/test/integration/stashOps.integration.test.tsx` (`finds the right stash by sha after others have been pushed on top`)
- **Status:** Implemented

### REQ-GIT-490 — Disclose changes committed without a review row
- **Description:** When a field-level review contains papers whose finished flags, PDF marks, entry matching, AI-usage records, or unrecognized keys changed, the system shall state in the review how many papers are affected and that those changes are committed regardless of the per-row dispositions.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/changes.ts:73-82,86-94`, `src/components/GitDialog.tsx:344`, commit `9187091`
- **Verified by:** `src/git/changes.test.ts` (`papersWithBookkeepingChanges`)
- **Status:** Implemented

### REQ-GIT-500 — Carry hidden answers through merges
- **Description:** When merging, the system shall carry answers held under nodes the schema no longer describes (REQ-DAT-165) through to the result, keep the local side where both sides hold different ones under the same node, and add a merge note naming the node and paper in that case.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:179-186,340`, commits `0e185f2`, `264d6b0`
- **Verified by:** `src/git/merge.test.ts` (`mergeProjects — answers under a field the schema no longer has`)
- **Status:** Implemented

### REQ-GIT-510 — Warn about a paper already read in the same seat
- **Description:** When the active seat's file for the current paper was last committed, outside merge commits, by a git identity other than the local one, the system shall show a non-blocking notice naming that person; it shall say nothing for other seats, other papers, the user's own earlier commits, or when no local identity is configured.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2633`, `src/git/seatOwner.ts:71-94,120-133`, `src/components/SeatConflictNotice.tsx`, commit `c83daba`
- **Verified by:** `src/git/seatOwner.test.ts`, `src/components/SeatConflictNotice.test.tsx`
- **Status:** Implemented

