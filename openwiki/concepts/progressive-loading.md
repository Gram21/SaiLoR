---
type: concept
title: Progressive Project Loading
description: How SaiLoR opens large split projects as a head plus batches of paper files, the loadState and generation guards in the Zustand store, retry on a failed batch, and why saving and whole-project features wait until loading ends.
tags: [loading, performance, store, tauri, persistence]
sources:
  - id: openwiki-source-5e350144821ef45403557db2
    resource: repo://src-tauri/src/project.rs
  - id: openwiki-source-d1afade4641722495f434a61
    resource: repo://src/platform/desktop.ts
  - id: openwiki-source-176d32cd8ce02636461bc29b
    resource: repo://src/platform/offMain.ts
  - id: openwiki-source-eaa560a5d319edfbd4aad953
    resource: repo://src/platform/projectJobs.ts
  - id: openwiki-source-6caeef66ec21bf4ae91fe55c
    resource: repo://src/platform/tauri.ts
  - id: openwiki-source-89409d7a9c0280067e058c1a
    resource: repo://src/state/store.ts
generated: { by: "claude-code", at: "2026-11-07T10:50:01.257Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-07T10:50:01.257Z
---

# Progressive Project Loading

A split project (see [Data Model](data-model.md)) can list thousands of papers, each with its own
annotation files. Reading all of them before the first paint made big projects slow to open. SaiLoR 2.0
therefore opens a project in two stages: a **head** (`project.json` with every paper's metadata but no
answers) and then the paper files in **batches** that the renderer requests one after another.

## Flow

1. **Rust `open`** (`src-tauri/src/project.rs`) reads only the head. It records the project as known to
   the session and caches a `Head` (the annotations folder name and the set of paper ids that
   `project.json` listed). A legacy single-file project has no head to stream and loads whole.
2. **`DesktopAdapter.openProject`** (`src/platform/desktop.ts`) returns the head text plus a
   `readPapers(ids)` function. It parses the head in a worker (`head` job) and passes the result on as
   `OpenedProject.project`, so the store does not parse it again. It seeds the save baseline
   (`lastWritten`) from the head and tracks the papers still to be read in `streaming`.
3. **Rust `read_papers`** serves one batch. It refuses a project that was not opened this session and
   reads only ids the head listed, so a renderer cannot name other folders. Links are followed only
   inside the annotations folder.
4. **`streamPapers`** (`src/state/store.ts`) walks the ids in batches of `PAPER_BATCH` (250, small so
   the progress count keeps moving). After each
   batch it appends the papers to `project.papers` (and to every undo/redo snapshot, so an undo does not
   drop them), updates `loadProgress`, and yields to the event loop with `setTimeout(0)` so the UI can
   render between batches.
5. When the last batch lands, `loadState` becomes `ready`, `loadProgress` clears, and the PDF folder scan
   starts.

## Off the main thread

The main thread only moves data. `offMain` (`src/platform/offMain.ts`) posts a job to
`projectJobs.worker.ts`, which calls `runJob` (`src/platform/projectJobs.ts`). The jobs are `open`,
`read`, `head` and `parse`. `TauriAdapter` (`src/platform/tauri.ts`) uses `open` and `read` to assemble
the raw split files with `assembler` (`src/platform/assemble.ts`), and `DesktopAdapter` uses `head` and
`parse` to run `loadProject` and parse each batch. The worker keeps the files of each open session and
drops old sessions; `read` for an unknown session throws "The project is no longer open." Where `Worker`
is undefined (vitest with jsdom), `offMain` runs the job inline. If the `head` job fails, the store falls
back to `loadProject(text)` so the user gets the normal load error.

## State and guards

| State | Meaning |
|---|---|
| `loadState` | `idle`, `loading`, or `ready`. Only `loading` blocks features. |
| `loadProgress` | `{ loaded, total }` while loading, otherwise `null`. |
| `loadFailed` | Message of a batch that could not be read; loading waits until `retryLoad`. |
| `projectGeneration` | Counter bumped when another project replaces or closes this one. |

- **Generation guard.** `streamPapers` copies `projectGeneration` at the start and re-checks it after every
  await. If the user opened or closed another project meanwhile, the stream stops and returns `null`
  instead of writing papers into the wrong project.
- **Landing paper.** A head has no answers, so "open on the first unfinished paper" cannot be decided
  from it. `loadFromText` stores the intent in `landOnFirstUnfinished`, and each batch checks for the
  first unfinished paper (or the remembered one) until one is found.
- **Failed batch.** A read error keeps the project open with the papers loaded so far, sets `loadFailed`
  and a load error, and parks the loop on `wakeLoad`. `retryLoad`, close, or replace resumes it.
- **Save protection.** While `loadState` is `loading`, `stillLoading()` refuses whole-project actions
  (save, runs over every paper, PDF folder linking) with a message, because a save now would drop the
  unread papers. The adapter enforces the same rule: `saveProject` throws "The project is still loading"
  while `streaming` holds the project's path. Resync from disk also returns early while loading.

## Tests and requirements

The behaviour is traced to `REQ-PLT-440` to `REQ-PLT-443` and `REQ-PLT-459` in `docs/requirements/`. `src/state/progressiveLoad.test.ts` `src/platform/projectJobs.test.ts` and the adapter tests cover batching, the generation guard, retry, and the save refusal; Rust unit tests in
`project.rs` cover that batches read only listed papers, use the folder and papers listed at open time,
and follow links only inside the annotations folder.
