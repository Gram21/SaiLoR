# SaiLoR — Developer Documentation

**SaiLoR** is a tool for reviewers conducting **Systematic Literature Reviews (SLR)** — the letters
are in the name: **S**ai**L**o**R**. A single JSON "project" file holds both the annotation schema
(a nested, cardinality-controlled taxonomy) and the papers to annotate; the app renders each paper's
PDF beside a form generated from that schema, and writes the annotations back into the same file.

One codebase ships two ways: an **Electron desktop app** and a **static web SPA**. That split is the
thing to understand first — most of the architecture exists to keep the React tree identical across
both, with a `PlatformAdapter` seam absorbing everything that differs (file dialogs, PDF loading,
where an API key can safely live).

This wiki is the **developer** documentation. If you are here to *use* SaiLoR — installing a release,
authoring a project file, annotating with AI — start with the
[README](https://github.com/Gram21/SaiLoR#readme) instead.

## Contents

| Page | What it covers |
|---|---|
| **[Quickstart](quickstart)** | What SaiLoR is, the tech stack, the commands you actually need, and the repository layout. **Start here.** |
| **[Architecture](architecture)** | The `PlatformAdapter` seam, the Zustand stores and undo/redo, the component tree, the Electron main process, and the `src/llm` layer behind AI-assisted annotation. |
| **[Data Model](data-model)** | The project file format, the in-memory types, and the load → normalize → edit → prune → serialize lifecycle that keeps a hand-edited JSON safe. |
| **[Operations](operations)** | Developing, building, testing, CI, releasing the desktop installers, deployment (static / Docker / Electron), and how these wiki pages are kept in sync. |

## How this wiki is maintained

**Do not treat this wiki as the original.** These pages live in
[`openwiki/`](https://github.com/Gram21/SaiLoR/tree/main/openwiki) in the main repository and are
mirrored here by a GitHub Action; the folder is the source of truth, and publishing *replaces* the
wiki rather than merging into it.

Editing a page here is still fine: a second Action imports wiki edits back into `openwiki/` and
commits them to `main`, so the two do not drift. See
[Operations → Wiki sync](operations#wiki-sync) for the mechanics — including
why the two Actions cannot trigger each other in a loop.
