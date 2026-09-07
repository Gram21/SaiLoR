# Requirements — Git Integration

Requirements for sharing projects between reviewers via git: clone, status/commit,
pull/merge, branches, history, and the security gates around git execution.
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
- **Description:** When a project is opened, the system shall determine whether the project lies in a git work tree and derive the repository root, the project's repository-relative path, the current branch, and the upstream branch.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:1802-1819`, `src/git/deriveGitInfo.ts:33`
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

### REQ-GIT-170 — Pathspec-limited commits
- **Description:** When committing, the system shall limit the commit to the files under review so that separately staged work is not disturbed.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2170-2189`
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

### REQ-GIT-250 — Refuse structure-reshaping merges
- **Description:** When the two sides of a merge differ in schema, reviewer count, screening configuration, version, provenance, protocol, or root-level extra keys, the system shall refuse the merge with a per-key reason.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:833-843,982-989`, `gitStore.test.ts:340`
- **Status:** Implemented

### REQ-GIT-260 — Refuse merges dropping answered fields
- **Description:** When a merge side removes a schema field that carries recorded answers on the other side, the system shall refuse the merge naming the field and the answer count.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/merge.ts:942` (`schemaRemovalRefusal`)
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
- **Description:** When switching branches with uncommitted project changes, the system shall offer carrying the changes over, committing first, or cancelling; a carry-over shall stash only the project's own files, refuse when unrelated files are dirty, and resolve differences via the three-way merge flow, restoring the source branch and stash on cancel.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `electron/main.ts:2503-2604`, `gitStore.test.ts:829-951`, commit `8eb8ed8`
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
