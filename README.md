<p align="center">
  <img src="build/icon.png" alt="SaiLoR" width="128" height="128">
</p>

<h1 align="center">SaiLoR</h1>

<p align="center">
  <a href="https://doi.org/10.5281/zenodo.23804729"><img src="https://zenodo.org/badge/DOI/10.5281/zenodo.23804729.svg" alt="DOI"></a>
</p>

A tool to assist reviewers during **Systematic Literature Reviews (SLR)** — the letters are in the
name: **S**ai**L**o**R**. Open a project file (`project.json`) that holds both an annotation schema
(a nested, cardinality-controlled taxonomy) and the papers to annotate. Read each paper's PDF, fill in typed
annotation fields — optionally grabbing values straight from selected PDF text — and save the
annotations into the `annotations/` folder next to the project file.

SaiLoR is a **desktop app** ([Tauri](https://v2.tauri.app/)) — fully local, opens local PDF files, native Open/Save
dialogs.

<p align="center">
  <img src="docs/screenshots/annotate.png" alt="The three-pane annotation view: papers, the PDF, and the annotation form" width="900">
</p>

> 📖 For a feature-by-feature walkthrough with screenshots — including warnings worth reading before
> you rely on this for real review data — see the [user guide](https://github.com/Gram21/SaiLoR/wiki/User-Guide).

Project website with an overview and a first-project walkthrough: https://gram21.github.io/SaiLoR/

## Quick start

Either [install a release](#installing-a-release) or [clone this repository and run the tool with npm](#run-the-development-variant-with-npm).

### Installing a release

Grab the file for your system from the [releases page](https://github.com/Gram21/SaiLoR/releases):

| System | File |
|---|---|
| macOS 15 or later, Apple Silicon | `SaiLoR_<version>_aarch64.dmg` |
| macOS 15 or later, Intel | `SaiLoR_<version>_x64.dmg` |
| Windows | `SaiLoR_<version>_x64-setup.exe` |
| Linux | `SaiLoR_<version>_amd64.AppImage`, `.deb` or `.rpm` |

The app requires macOS 15 (Sequoia) or later.

The macOS, Windows and Linux AppImage builds update in the app. The Linux `.deb` and `.rpm`
packages do not. Install a new `.deb` or `.rpm` by hand, or through your package manager.

> **The releases are not signed** with an Apple or Microsoft code-signing certificate —
> paying for one is not worth it for a research tool. Both systems will therefore warn you
> the first time you open the app. The steps below are how you tell them to go ahead; you
> only need to do it once.

> **Upgrading from SaiLoR 1.x?** Read [Upgrading from 1.x](#upgrading-from-1x) before you install 2.0.

#### macOS

1. Open the `.dmg` and drag **SaiLoR** into your **Applications** folder.
2. Open the app. macOS blocks it, saying it *"cannot be opened because Apple cannot check
   it for malicious software"*. Click **Done**.
3. Open **System Settings** → **Privacy & Security**, and scroll down to the **Security**
   section. You'll see a note that *"SaiLoR" was blocked to protect your Mac*.
4. Click **Open Anyway**, then confirm with **Open Anyway** and enter your login password.

The app opens normally from then on. (The **Open Anyway** button only appears for about an
hour after you tried to open the app — if it's gone, just try opening the app again.)

Note that on current macOS versions the old right-click → **Open** shortcut no longer works
for apps like this — the *Privacy & Security* route above is the way.

<details>
<summary>If macOS says the app is <em>"damaged and can't be opened"</em></summary>

That message means the download's quarantine flag is set on an app macOS can't verify —
**the app is not actually corrupt**. It affects builds from before v0.1.0's signing fix.
Either grab a newer release, or clear the flag once:

```bash
xattr -cr "/Applications/SaiLoR.app"
```
</details>

#### Windows

1. Run `SaiLoR_<version>_x64-setup.exe`.
2. Windows SmartScreen shows *"Windows protected your PC"*. Click **More info**, then
   **Run anyway**.
3. Follow the installer.

#### Linux

The AppImage is a single self-contained file — no installation needed. Make it executable
and run it:

```bash
chmod +x "SaiLoR_<version>_amd64.AppImage"
./"SaiLoR_<version>_amd64.AppImage"
```

If it fails to start, your distribution may be missing FUSE (`sudo apt install libfuse2`
on Debian/Ubuntu), or you can extract and run it with `--appimage-extract-and-run`.

### Upgrading from 1.x

Use this section if you used SaiLoR 1.x. SaiLoR 2.0 uses the Tauri shell, a new app identifier and new installer names.

- **Install 2.0 by hand.** Use this step on Windows, on Linux (AppImage) and on macOS.
  The 1.x app does not update to 2.0.
  1. Download the 2.0 installer for your system from the [releases page](https://github.com/Gram21/SaiLoR/releases).
  2. Install 2.0.
  3. Remove the 1.x app.
- **Keep your project files.** Project files do not change. Open them in 2.0 as before.
- **Keep your data folder.** The first start of 2.0 moves `<config dir>/SaiLoR` to `~/.sailor`. The folder holds your AI provider settings and local AI models. On Windows, the new folder is hidden.

  **Warning:** Do not delete the `~/.sailor` folder. Deleting it removes your AI provider settings and local AI models.
- **Enter this data again.** These items do not carry over from 1.x:
  - **Recent projects.** The list starts empty. It fills again as you open projects.
  - **UI settings.** The theme, font size and pane widths reset to their defaults.
  - **API keys.** 1.x keys cannot be read by 2.0. Enter each key again in the AI settings. A provider that needs no key needs no action.
  - **Window size.** The window opens at 1400 by 900 pixels.
- **Check your system.**
  - macOS 15 (Sequoia) or later is required. 2.0 does not support macOS 14 or earlier.
  - Linux: the AppImage updates in the app. The `.deb` and `.rpm` packages do not. Update them by hand or with your package manager.
  - Windows and macOS: 2.0 updates in the app.
- **Allow the first launch.**
  - macOS: **Warning:** macOS blocks the first launch of 2.0. Follow the steps in [macOS](#macos).
  - Windows: SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

### Run the development variant with npm

Clone the repository and move into it:

```bash
git clone https://github.com/Gram21/SaiLoR.git
cd SaiLoR
```

Install the build prerequisites (Node.js, Rust and the system libraries) once. See
[docs/building.md](docs/building.md). Then start the app:

```bash
make setup     # install prerequisites, asks before each installation
make install   # install Node dependencies
make dev       # start the desktop app with hot reload
```

## Project file format

> 📖 For a full authoring guide with many examples, see
> [docs/annotation-schema.md](docs/annotation-schema.md). The summary below is the quick reference.

A project is a `project.json` file next to an `annotations/` folder, not a single JSON file. This is
what lets two reviewers working on different papers — or different reviewer slots of the same paper —
never collide in git: each lives in its own file, so ordinary git tracking/diffing/merging handles
them independently instead of everyone fighting over one big file. (Opening a project still saved in
the old, pre-v1.3 single-file shape works unchanged — it just migrates to this layout automatically
the next time it's saved, with no explicit step.)

```
my-review/
├── project.json          # schema, protocol, screening config, and paper METADATA only — no answers
└── annotations/
    └── <paperId>/
        ├── consolidated.json   The single/consolidated annotation tree, plus aiUsage + equal
        └── reviewer-<n>.json   Each independent reviewer's own tree (multi-reviewer only)
```

Each of those files also carries that seat's `"finished": true` once its holder ticks the sign-off box
in the panel — **Annotation finished** for a reviewer, **Consolidation finished** in the Consolidation
seat, which signs off `consolidated.json` the same way. The declaration lives next to the answers it is
about, so it merges as independently as they do.

Files under `annotations/` are created **lazily** — only once a reviewer has actually written
something for that paper — and deleted again if it's cleared back to empty. A screening project names
these `screening-consolidated.json` / `screening-<n>.json` instead, so the two kinds of per-paper
decision are distinguishable at a glance.

The name `feedback` is reserved inside `annotations/`: `annotations/feedback/*.json` holds AI schema-feedback
files (not papers, never pruned by a save; commit them like any other file). A paper cannot use `feedback` as its id.

`project.json` itself:

```jsonc
{
  "version": 1,
  "config": {
    "schema": [
      { "name": "Relevant", "type": "boolean" },        // leaf field
      { "name": "Study Type", "type": "string",
        "options": ["Case study", "Experiment", "Survey"] },  // enum dropdown

      { "name": "Publication Year", "type": "year" },   // number, bounded to a plausible pub. year
      {
        "name": "Findings", "min": 1, "max": null,       // group, repeatable (unbounded)
        "children": [
          { "name": "Claim", "type": "string" },
          { "name": "Evidence", "type": "string" },
          { "name": "Confidence", "type": "number" }
        ]
      }
    ],
    "reviewers": 2,                 // optional, 1–10 (default 1) — see below
    "finishCheckbox": false,        // optional (default true) — see "Marking papers finished"
    "screening": { "reasons": ["Wrong topic", "Duplicate"] }  // optional — see "Screening" below;
                                     // when present, "schema" above is ignored and derived from this
  },
  "papers": [
    {
      "id": "paper-a",
      "title": "…",
      "authors": ["…"],
      "doi": "10.1000/xyz",         // optional
      "year": 2024,                 // optional
      "venue": "…",                 // optional — journal/conference name
      "abstract": "…",              // optional — what screening reads when there is no PDF yet
      "pdf": "pdfs/paper-a.pdf"     // path relative to this JSON file; "" is only valid in a screening project
    }
  ]
}
```

The app assembles `project.json` and every paper's `annotations/` files into the same logical shape
you'd get from the pre-v1.3 single-file format when it loads a project — the split only changes what's
on disk, not how the app (or its own load/save/git internals) reasons about a project in memory.

**Annotation nodes** (`config.schema[]`):

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Display label (required). Sibling names must be unique.                 |
| `type`        | `string` \| `number` \| `boolean` \| `year`. Omit for a group (name-only) node. `year` is a number bounded to a plausible publication year (~1000–2100). |
| `children`    | Sub-taxonomy. A node may have `type`, `children`, or both.              |
| `min`         | Minimum occurrences (default `1`).                                      |
| `max`         | Maximum occurrences: a number, or `null` for unbounded (default `1`).   |
| `options`     | Array of strings on a `string` field → a filterable enum dropdown.      |
| `description` | Optional tooltip.                                                       |

**Annotation data** mirrors the schema: at each level a map keyed by node name, where every key
holds an array of instances (bounded by `min`/`max`). Each instance carries a `value` (for fields)
and/or nested `children`. Saving prunes trailing empty optional instances and leaves `config`
untouched. Unknown top-level and per-paper fields are preserved verbatim.

> ⚠️ **`config` itself is rebuilt from scratch on every save** — any key you hand-add under it
> (`config.schema`, `config.reviewers`, …) is silently dropped the next time anyone saves. If you
> need to record something the app doesn't have a field for, use a **top-level** key instead
> (`{"version": 1, "myNotes": "…", "config": {...}, "papers": [...]}` keeps `myNotes` forever) — or,
> for a review's own protocol, the dedicated `protocol` key described next. See
> [Things to know](https://github.com/Gram21/SaiLoR/wiki/Guide-Things-To-Know) for this and a few other easy-to-miss traps.

Two optional top-level keys exist specifically to be safe from that `config` rebuild:

- **`protocol`** — the review's own protocol (research questions, search strings, databases searched,
  search date, notes), authored from the project editor's *Review protocol* section.
- **`schemaInfo`** — a free-text, schema-wide comment authored from the project editor's *Schema
  info* section, shown to reviewers via an ⓘ button on the annotation panel (opens automatically the
  first time a project with one is loaded).
- **`provenance`** — a read-only record of where a project came from, written automatically when it
  was built via *New from screening…*: the source project, when, and how many papers were carried
  over versus left behind.

## Using the app

- **Open ▾ menu** — open a project file, or reopen one of the last 5 recent projects.
- **Save ▾ menu** — Save or Save as…, with their shortcuts shown next to each item.
- **Graph ▾ menu** — **Explore knowledge graph** opens the graph view.
  **Knowledge graph** exports the papers, metadata and answers as a graph file. The **Save ▾** menu has the same export item. See [Knowledge graph](#knowledge-graph).
- **? (Help)** — opens a dialog describing the workflow and listing all keyboard shortcuts.
- **Left pane** — collapsible list of papers (toggle with the ☰ button). A completeness dot next to
  each paper fills in proportionally as fields are completed (a fraction of required fields if any
  are marked required, otherwise of all fields). The fill is progress and the color is state: amber
  while the paper is still yours to finish, **green** once you tick the **Annotation finished**
  checkbox in the annotation panel, **red** if that box is ticked while a field the schema marks
  `required` is still empty — so "done" is always something a reviewer said, not something the form
  inferred, and a mark that contradicts the data says so instead of going quiet. (A schema that
  requires nothing never goes red, and a Yes/No answer is never a hole.) Set
  `config.finishCheckbox: false` to drop the sign-off step: papers then count as finished as soon as
  the schema is fulfilled, and no paper can be *With issues*. A dropdown under the search box filters
  the list into *Open* (anything not finished), *In progress* (the started subset — anything with at
  least one annotation, still not finished), *Finished*, and *With issues*, and counts the selected
  bucket (`finished: 5/100`). Every seat gets this, the **Consolidation** seat included — there the dot
  tracks the consolidated record and the checkbox reads *Consolidation finished*, while "has every
  reviewer answered this paper yet" moves into the dot's tooltip and a second counter
  (`finished: 5/100 · 82/100 ready`). In a **screening project** the dot becomes a tri-state marker
  (included / excluded / undecided) with its own filter instead, and there is no checkbox; see
  [Screening](#screening).
- **Search** — the box above the paper list matches title, authors, DOI, abstract, the PDF's file
  name, and the paper's own id by default. Click the **META**/**TAGS** trigger on its right edge to
  switch to searching your own recorded annotation content instead.
- **Resizable panes** — drag the borders between the three panes to resize them; the widths are
  remembered.
- **Middle pane** — the paper's PDF, rendered with a selectable text layer. In a screening project
  this defaults to the title/abstract record instead, with a one-click swap to the PDF.
- **Right pane** — the annotation form, laid out by the taxonomy. Repeatable nodes show **+ Add**
  (up to `max`) and a remove (**×**) control (down to `min`). In a screening project this is the
  Include/Exclude decision instead — see [Screening](#screening).
- **Grab from PDF** — select text in the PDF, then click the **⧉** button next to a string/number
  field to insert it (numeric fields extract the first number).
- **Highlighting, sticky notes, and PDF export** — select text to highlight it, or drop a sticky
  note anywhere on the page, each with its own comment. ‹ › buttons jump between every mark on the
  paper. Marks are your own (per reviewer) and stored separately from the PDF itself, so two
  reviewers marking up the same file never conflict in git — export them into a real, standalone
  annotated PDF when you want to share one outside SaiLoR.
- **Linking a mark to a field** — the **🔗** button next to every field lets you attach one or more
  highlights/notes as evidence for that value ("why I picked this"), searchable when there are many.
  Clicking a mark jumps to it in the PDF without linking it, so you can confirm which one it is first.
- **Adding papers** — in the project editor: pick individual PDFs, a whole folder of them, or import a
  BibTeX/RIS/CSL-JSON reference export. Importing flags probable duplicates (fuzzy title match, or a
  matching normalized title with similar authors) against papers already in the project and against
  other entries in the same batch; each flagged pair needs an explicit **Duplicate**/**Different**
  decision before the import proceeds — nothing is silently merged or silently added twice.
- **Reviewer switch** — on multi-reviewer projects only, centred in the toolbar: pick whether you are
  Reviewer 1…N or Consolidation. See [Working with several reviewers](#working-with-several-reviewers).
- **Theme** — toggle light/dark for the app with the ☾/☀ button (top right). The choice is
  remembered. The PDF paper is always rendered on a normal white background, regardless of theme.
- **Font size** — the `A− A A+` buttons (or the shortcuts below) scale the app's text. This affects
  the app chrome only, not the rendered PDF. The chosen size is remembered.
- **Settings** — open with `Ctrl/Cmd + ,` or click the SaiLoR title. Set the theme, font size,
  autosave, the interface language (9 languages) and the AI models. See
  [Settings](user-guide/getting-started.md#settings).
- **View only** — tick it in the toolbar to read a project without changing it.
- **Metadata corrections** — correct a paper's title, authors, year and DOI per seat. See
  [Correcting paper metadata](user-guide/getting-started.md#correcting-paper-metadata).
- **PDF folder** — SaiLoR finds new PDFs in the project's PDF folder and offers to add them. See
  [Adding new PDFs from a folder](user-guide/getting-started.md#adding-new-pdfs-from-a-folder).
- **AI annotation** — a model proposes answers, and you check each one before you apply it. See
  [Annotating with AI](user-guide/getting-started.md#annotating-with-ai).
- **Strict mode** — assign papers to named persons and lock finished work. See
  [Strict mode](user-guide/project-editor.md#strict-mode).

### Keyboard shortcuts

| Shortcut                | Action                         |
| ----------------------- | ------------------------------ |
| `Ctrl/Cmd + O`          | Open a project file            |
| `Ctrl/Cmd + S`          | Save                           |
| `Ctrl/Cmd + Shift + S`  | Save as…                       |
| `Ctrl/Cmd + Z`          | Undo annotation change         |
| `Ctrl/Cmd + Shift + Z` / `Ctrl + Y` | Redo annotation change |
| `Ctrl/Cmd + +` / `-` / `0` | Zoom the PDF in / out / reset |
| `Ctrl/Cmd + Shift + +` / `-` / `0` | App font size larger / smaller / reset |
| `Alt + ↓` or `]`        | Next paper                     |
| `Alt + ↑` or `[`        | Previous paper                 |
| `F1`                    | Open help                      |
| `Ctrl/Cmd + ,`          | Open settings                  |
| `Ctrl/Cmd + C/V/X/Z`    | Native copy/paste/…            |
| `I` / `E` / `U`         | Screening only: include / exclude / un-decide |
| `1`–`9`                 | Screening only: exclude with the Nth configured reason |

## Working with several reviewers

An SLR is normally annotated by two or more people **independently**, then reconciled. Set
`config.reviewers` to a number from 2 to 10 (the *New / Edit annotation JSON* screen has a field for
it) and the project works that way.

- **Everyone annotates on their own.** Each reviewer's answers live in their own tree
  (`paper.reviews["1"]`, `"2"`, …). You see and edit only your own — nobody is anchored by what
  someone else already wrote. **Validate** and the paper list's progress dots follow whoever you are.
- **Every reviewer's tree is there from the start** — one full empty entry per field, not a missing
  key — so a reviewer's first real answer changes a value on a line that was already there, rather
  than adding one. That is what makes `git diff`/`git merge` actually usable if reviewers keep their
  own copies and merge them later. A file saved before this existed, or edited by hand, is fixed up
  the next time it's opened (and saved back, if there's somewhere to save it).
- **Pick who you are first.** Opening the project asks: it explains how multi-review works and has
  you choose a seat, because an answer nobody can be attributed to is worse than no answer. The
  choice is remembered per project (so it asks once) and you can switch from the toolbar — it sits in
  the middle, becoming a dropdown above five reviewers.
- **Consolidation can start before everyone finishes.** The seat is always available; it is the
  individual papers that wait. A paper not yet annotated by every reviewer shows as not ready in the
  list and keeps its **⇄** buttons disabled — an absent reviewer's empty column would read as "they
  found nothing" rather than "they haven't looked yet".
- **Consolidation is the reconciling pass**, not one more opinion. Take that seat and every field
  gets a **⇄** compare button showing every reviewer's answer side by side, flagging whether they
  agree, and letting you click one to adopt it. What Consolidation records is `paper.annotations` —
  the project's **final result**, and what an export or analysis would read.
- **What everyone already agreed on is filled in for you**, with a light-blue border until you click
  it. Only case and stray whitespace are forgiven — a near-miss in wording, or a field one reviewer
  left blank, stays your call. It leaves your attention for the fields that actually differ.
- **⚠ Disagreements** lists every field the reviewers answered differently, across the whole project.
  Click one to jump straight to it.
- **⚖ Agreement** reports **Cohen's κ**, **Fleiss' κ** and **Krippendorff's α** — tick any
  combination. A coefficient that cannot honestly be computed for your project is greyed out and says
  why on hover (Cohen's compares exactly two reviewers; Fleiss' needs everyone to have rated
  everything; α copes with both).
- **"These answers mean the same thing"** — reviewers write *RCT* and *randomized controlled trial*
  and mean one thing. Tick it in the compare popup and the app treats it as agreement from then on:
  in the badge, in the disagreement list, and in the statistics. Without it, agreement is understated,
  so it is worth doing before you quote a κ. Ticking it settles *that* they agreed — click one of the
  answers as well, to record *what*. Try to leave without doing so and the app asks first, then undoes
  the tick rather than let the field count as settled while holding nothing.
- **Repeatable groups are lined up for you.** Opening a paper as Consolidation adds as many entries
  as the busiest reviewer recorded, and works out *which of each reviewer's entries are the same
  entry* — two people rarely list the same three findings in the same order. Your Finding #2 is then
  everyone's Finding #2, so ⇄ compares answers that are genuinely about the same thing rather than
  reporting a disagreement that was only a difference of ordering. Matching is on what the entries
  say, so wording need not be identical. It changes the file (a single `Ctrl/Cmd + Z` undoes it), and
  a group you have already answered is left alone rather than reordered underneath you.
- **Lowering the reviewer count later doesn't erase anyone's work** — it just becomes unreachable
  (no seat, excluded from Consolidation) until you raise the count again. See §9 of the schema guide.
- **Two different people must not pick the same seat.** When [Git](#git) is available, SaiLoR records
  your git identity (name/email) the first time you claim a seat, and warns before letting a different
  identity take an already-claimed one. That protection only exists once git is in use and a seat has
  actually been claimed with it on — agree out of band who is Reviewer 1, Reviewer 2, … regardless.

Each seat of each paper has its own file under `annotations/`, so reviewers on different papers or
seats do not write the same file. SaiLoR has **no file locking**. Instead, a save stops when a file
that it would overwrite changed on disk since you opened or last saved the project. You then choose
**Overwrite with my version**, **Keep theirs, drop my changes to these files**, **Combine both** (a
field-by-field merge) or **Not now**. This check sees only what has reached your disk: copies sent
by email, or a synced folder that has not synced yet, can still diverge. For independent copies, see
[Git](#git) below. It reconciles the copies field by field instead of overwriting them.

> 📖 Full details, including the exact file shape, are in
> [§9 of the schema guide](docs/annotation-schema.md#9-multiple-reviewers--consolidation).

## Screening

Before an SLR annotates anything, it usually **screens** a large batch of candidate papers down to
the ones worth reading in full — a fast, low-effort pass typically done on title and abstract alone.
A project can be set to this mode instead of authoring a schema: tick **Screening** in *New / Edit
annotation JSON*, and the whole "build a schema" section is replaced by a short list of exclusion
reasons.

- **One decision per paper: Include or Exclude.** This is deliberately a **two-option choice, not a
  checkbox** — the app has no way to represent an unanswered boolean (an unticked box always reads as
  a real "no" everywhere else in this app), and screening needs "not screened yet" to be a state of
  its own. That third state is what the progress count, the PRISMA-style totals below, and *New from
  screening…* (see below) all depend on.
- **The exclusion reasons are fixed up front**, the way a review protocol pre-registers its exclusion
  criteria, rather than free text — that is what makes the per-reason counts in the summary add up to
  something a PRISMA flow diagram can report. Reviewers pick one from the list when they exclude a
  paper; it has no meaning otherwise.
- **A fast keyboard flow.** Press `I` to include or `E` to exclude the paper on screen, `U` to
  un-decide; a digit `1`–`9` excludes with the corresponding configured reason in one keystroke.
  Deciding a paper for the first time moves on to the next undecided one automatically, so screening
  reads as read-decide-read; going back to fix an earlier call never jumps you away from it again.
- **◧ Summary** reports progress and the include/exclude/undecided totals, plus how many papers were
  excluded for each reason.
- **The middle pane defaults to the title and abstract** rather than the PDF — that is what a
  screening decision is normally made from, and a screening paper may have no PDF attached at all
  (`"pdf": ""`). One click swaps to the actual PDF when you need it.
- **A missing abstract is extracted from the PDF automatically**, as soon as you select the paper —
  it appears in the abstract view without you opening the PDF at all, which is the point: the abstract
  is what you screen from. It uses a basic text heuristic (find the "Abstract" heading, follow that
  column to the next section), the same one that pre-fills title/authors when a PDF is added while
  building the project. It is a guess, not a fact: an extracted abstract carries a clearly labelled,
  permanent warning wherever it's shown, telling you to check the PDF directly if in doubt. It never
  runs when a real abstract is already there, and never overwrites one.
- **It reuses the multi-reviewer/Consolidation machinery wholesale**: two reviewers screen
  independently, Consolidation reconciles them, and **⚖ Agreement** reports κ over the include/exclude
  decision specifically — the statistic a screening phase actually reports. Where every reviewer
  agreed, Consolidation's **Adopt all** takes every one of those decisions at once.

**Starting the next phase from a screening project.** Once screening is done, **New from
screening…** (on the start screen) builds what comes next from the screening JSON, offering a choice
of target:

- **An annotation project** — the usual next step. Every paper **not explicitly excluded** is carried
  over — included papers always, and undecided ones by default (dropping a paper nobody actually
  excluded would silently shrink the review; you can choose to leave them out in the confirmation
  dialog instead). Title, authors, DOI, abstract, year, venue, and the PDF reference all carry over.
- **A second screening project** — for a full-text pass after the title/abstract pass, reusing the
  *same* exclusion-reason vocabulary as the first pass (editable before saving, if the second pass
  needs different reasons), so the two passes report comparable per-reason counts.

The new project's JSON is saved **next to the screening JSON** by default, so every paper's relative
PDF path keeps resolving without being rewritten, and its project editor shows a read-only
**provenance** note recording which screening project it came from, when, and how many papers were
carried over versus left behind. For a multi-reviewer screening project, "included" reads the
**consolidated** decision — the one that ships — never an individual reviewer's own opinion.

> 📖 Full details, including the derived schema's exact shape, are in
> [§10 of the schema guide](docs/annotation-schema.md#10-screening-projects).

## Knowledge graph

The **Graph ▾** menu in the toolbar has two items. The **Save ▾** menu also has **Knowledge graph**.

| Item | Action |
|---|---|
| **Explore knowledge graph** | Opens the graph view. The view shows the same graph as the export. |
| **Knowledge graph** | Exports the graph as JSON-LD, RDF Turtle, GraphML or two CSV files (nodes and edges). |

With more than one reviewer, the view and the export have a seat selector. The selector lists every reviewer seat
and **Consolidation** once one paper has a consolidated answer. The consolidation is selected at first.
The **⤓ Download** button at the top right of the graph area saves the graph as SVG or PNG. The user selects the visible
section or the whole graph. The image shows the current filter. In the online demo, the image is not saved.

The graph has these node types:

| Node type | Made from |
|---|---|
| `Paper` | Each paper. |
| `Author` | Each author. Names that differ only in letter case or spaces become one node. |
| `Venue` | The venue of a paper. |
| `Keyword` | Each entry of the paper's `keywords` field. A `;` or `,` separates two keywords. |
| `Choice` | Each value of a choice field. A choice field is a `string` field with `options`, or a `boolean` field. |
| `Answer` | Each filled entry of a group (a schema node with children). |

Other answers are values of the paper node or of the entry node. The graph ignores a `false`
answer, an empty answer and a field that `visibleIf` hides.

The edges connect the nodes:

| Edge type | Name in the view | Line style | From → to |
|---|---|---|---|
| `hasAnswer` | answer | solid | Paper or entry → `Choice` or `Answer` |
| `authoredBy` | authored by | dashed | Paper → author |
| `publishedIn` | published in | dotted | Paper → venue |
| `hasKeyword` | keyword | dash-dot | Paper → keyword |
| `cites` | cites | long dash | Paper → paper. The paper's `references` or `cites` field names the id or DOI of the other paper. |

With one reviewer, the graph uses the answers of that reviewer. With more reviewers, the graph uses
the consolidated answers if one paper or more has a consolidated answer. Otherwise, select the seat
in the view.

### Use the graph view

- Drag the background to move the graph.
- Turn the mouse wheel to zoom. You can also use **Zoom in**, **Zoom out** and **Reset view**.
  **Reset view** fits all nodes into the view.
- Drag a node to move it. Click a node to select it.
- Double-click a node to add its neighbours. The **Show neighbours** button in the side panel does
  the same.
- The side panel shows the type, DOI, year and values of the selected node, and its neighbours.
- The **Nodes** button opens a drawer that lists every shown node as a button. The drawer is closed
  when the view opens. Use this list as a keyboard alternative to the canvas. Each list shows 200
  entries first. **Show more** adds the next 200 entries.
- The selected node, its edges and its neighbours stay strong. The other nodes and edges become dim.
- The **Relations** legend has one checkbox per edge type. Clear a checkbox to hide the edges of
  that type.
- Point at a node or an edge to see a tooltip.
- **Export…** opens the export dialog. Press `Escape` to close the view.

The view has no node limit. It draws only the nodes and edges in the visible area. It draws the
node labels at a zoom of 0.6 or more, if 2000 or fewer nodes are visible. It draws arrowheads at a
zoom of 0.8 or more. A background worker calculates the layout and stops when the layout is stable.

### Text query

Type a query into the query box. Then press `Enter` or click **Show**. The view shows the matching
nodes and their neighbours. A node matches when it matches every term. Letter case does not matter.

| Term | Matches |
|---|---|
| `word` or `"a phrase"` | Nodes whose label, DOI, year, abstract or answer value contains the text. |
| `type:T` | Nodes of type `T`: `paper`, `author`, `venue`, `keyword`, `choice` or `answer`. |
| `author:X` | Author nodes that contain `X`. `paper:`, `venue:`, `keyword:`, `choice:` and `answer:` work the same way. |
| `field:F` | Nodes that have an answer for field `F`. |
| `F=V` or `F:V` | Nodes that have the answer `V` for field `F`. `V` must be the whole answer. |
| `-term` | Removes the nodes that match `term`. |
| `depth:N` | Shows the neighbours up to `N` steps away, from 0 to 3. The default is 1. |

Example: `type:paper Method=Survey -author:smith depth:2`

- `F` matches the full field path, for example `Tool/Name`, or its last part, for example `Name`.
- A field name in a text query cannot contain spaces. For such a field, use a Cypher query.
- A paper and an entry also match the answers below them.
- An empty query shows every node.

### Cypher query

A query that starts with `MATCH` runs as a read-only [Cypher](https://opencypher.org/) query.
SaiLoR supports a subset of Cypher. Letter case of `MATCH` does not matter.

```cypher
MATCH (p:Paper)-[:authoredBy]->(a:Author) WHERE a.label CONTAINS 'Turing' RETURN p, a
```

| Part | Supported |
|---|---|
| Clauses | One or more `MATCH`, each with an optional `WHERE`. Then one `RETURN` and an optional `LIMIT`. |
| Node labels | `Paper`, `Author`, `Venue`, `Keyword`, `Choice`, `Answer` |
| Relationship types | `authoredBy`, `publishedIn`, `hasKeyword`, `cites`, `hasAnswer`, alternatives with `\|` |
| Directions | `->`, `<-`, `-` |
| Variable length | `*`, `*N`, `*N..M`, `*..M` |
| Inline properties | `{key: value}` |
| `WHERE` | `=`, `<>`, `<`, `<=`, `>`, `>=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`, parentheses |
| Values | Strings, numbers, lists, `true`, `false`, `null` |
| `RETURN` | Variables, properties, values, `count(*)`, `DISTINCT`, `AS` |
| Node properties | `id`, `type`, `label`, `field`, `doi`, `year`, `abstract`, and each answer by field path |
| Relationship properties | `type`, `field` |

Rules:

- Labels and relationship types ignore letter case and underscores.
- Text comparisons are case-sensitive. This is different from the text query.
- A bare `*` means 1 to 3 steps.
- One `MATCH` clause uses each relationship at most once. Different `MATCH` clauses can use the
  same relationship.
- `count(*)` groups the rows by the other columns.
- `null` follows the Cypher rules. For example, `null = null` is not true.
- Put a field path with `/` or spaces in backticks, for example ``a.`Tool/Name` ``.

These parts give an error: `CREATE`, `MERGE`, `DELETE`, `DETACH`, `SET`, `REMOVE`, `OPTIONAL`,
`WITH`, `UNWIND`, `CALL`, `ORDER`, `SKIP`, `UNION`, `LOAD`, `FOREACH` and all functions except
`count(*)`. Unknown labels, relationship types and variables also give an error.

The graph shows the nodes and relationships of all matches and marks the returned nodes. The side
panel shows the row count and a table of the first 200 rows. If the query has an error, the view
shows the reason and its position. The previous result stays.

A background worker runs the query, so the view stays usable. The status line shows "Running the
query…". A new query or closing the view stops the running query.

| Limit | Value |
|---|---|
| Query length | 4000 characters |
| Nesting | 32 nested expressions, 32 patterns and relationships |
| Variable-length steps | 3 |
| Result rows | 10 000 |
| Work | 2 000 000 steps |
| Run time | 20 seconds |

If a query stops at the row limit or the work limit, the view tells you that the result is not
complete. If a query runs longer than 20 seconds, SaiLoR stops it and shows an error.

## Opening a large project

SaiLoR opens a project in the split layout (`project.json` and `annotations/`) in two steps:

1. SaiLoR reads `project.json` and shows all papers with their metadata.
2. SaiLoR reads the files under `annotations/` in batches of 2000 papers.

While the papers load, the paper list shows the progress, for example
`Loading papers: 12,000 / 50,000`. Open and annotate each paper that has loaded. If the project
opens on its first unfinished paper, SaiLoR selects that paper when its batch has loaded.

These features read all papers. They stay disabled until the last paper has loaded:

- **Save** and **Save as…**
- **Validate** and **AI**
- both items of the **Graph ▾** menu
- **Rescan** (the PDF folder scan) and **Git**
- **☰ Overview** and **⚠ Disagreements** in the annotation panel
- **◧ Summary**, **⚖ Agreement**, **⚠ Disagreements** and **Adopt all** in a screening project

Each disabled control tells you why in its tooltip. SaiLoR also refuses the automatic save and
the save on close until the last paper has loaded.

If a batch cannot be read, the project stays open with the papers that have loaded and with your
edits. SaiLoR shows the error. The paper list shows where the load stopped and a **Retry** button.
Click **Retry** to read the failed batch again.

**Warning:** Saving stays blocked until every paper has loaded. If you close the project before
then, you lose your unsaved edits.

If you close the project during the load, SaiLoR stops the load.

A project in the legacy single-file layout opens in one step. SaiLoR must read and parse that file
as a whole, so batches do not make the first view faster. To open a large legacy project in
batches, save it once. The save writes the split layout.

## Saving

Writes `project.json` and the changed files under `annotations/` to the opened project's folder;
**Save as** opens a native dialog to pick a new location.

## Git

> Git support runs your own `git` binary, so it can use your real `~/.gitconfig`, your credential
> helper, and your SSH agent. If `git` is not on your `PATH`, *Import from remote git…* and the
> toolbar's **Git** button appear greyed out with git's own error explaining why.

**Import from remote git…** — on the start screen and in the toolbar's *Open* ▾ menu. Paste a repository URL,
pick a folder, and confirm; the app then clones it. A clone of a repository full of PDFs can take a
while, so you get a spinner and an elapsed-seconds line rather than a frozen-looking window. If it
fails, you get git's **exact** error message and land back on the same form with what you typed still
in it. On success you pick which project JSON to open, and the file picker already starts inside the
folder that was just cloned.

**The Git button** appears in the toolbar whenever the open project's folder sits inside a git
repository. It opens a panel with:

- **A branch switcher** in the header — a dropdown of local branches, plus **+ New branch…** to
  create one at the current commit and switch to it right away, and **- Delete branch…** to remove
  one (git itself refuses if it isn't fully merged, no force option here). Switching with nothing
  uncommitted is a plain checkout. With uncommitted changes to the project, it asks: commit first
  (cancels the switch for now), carry the changes into the new branch (merging field by field, same
  engine as Pull below), or cancel. A branch just created shares its parent's commit, so carrying
  changes into one can never itself produce a conflict.
- **Field-level review of the project's own changes** — instead of one whole-file checkbox, every
  changed field (across `project.json` and every file under `annotations/`) gets its own row ("Field:
  was *this*, now *that*") with three choices: **Use** (commit the new value), **Ignore** (leave it as
  an uncommitted local change, offered again next time), or **Discard** (revert it to the committed
  value — nothing actually happens until you press **Commit** or **Discard all**, never the moment you
  mark it). **Use all / Ignore all / Discard all** apply one disposition to everything at once.
  Any change to a file *outside* the project (a PDF you added, say) still shows as a plain whole-file
  checkbox, now with its own small **↺** to revert (tracked) or delete (untracked) that one file —
  refused for a rename or an unresolved conflict rather than guessed at.
- a commit message box and a **Commit** button (which relabels to **Discard all** and turns red if
  nothing is left marked *Use*),
- **Pull** and **Push**.

A quieter **Merge branch…** text button sits in the panel's header, next to the close button — kept
out of the primary commit/pull/push row since merging is a rare, deliberate action. It opens a small
dialog — pick a branch (local or remote-tracking, e.g. `origin/side`;
picking a remote one fetches first), see it spelled out plainly ("Merge *branch* into the current
branch *yours*"), confirm — and it merges through the same field-by-field engine as Pull:
already-up-to-date, fast-forward, a clean merge commit right away, or the same conflict dialog. It's a
separate button rather than folded into Pull/Push because merging another branch in is a deliberate,
occasional action, not something reached for every session. Unlike a branch switch, merging never
moves you off your branch, so there is no stash to unwind — a cancelled merge is a plain
`git merge --abort`.

**History…**, beside it, lists the commits that touched the open project's own file — not the whole
repository — newest first, capped at the latest 250. Expanding a commit computes the same
field-by-field "Was/Now" diff the commit review above uses, against that commit's parent, read-only
and fetched lazily (one commit at a time, never the whole list up front). A commit with no parent
says so instead of trying to diff nothing; one where the schema/protocol/etc. changed says so instead
of a diff it cannot honestly produce.

**Pull merges annotations field by field, not line by line.** A field only *you* changed keeps your
value. A field only the *remote* changed takes theirs. Only a field you **both** changed — to
different things — is a real conflict, and those are the only ones you are ever asked about: conflicts
are grouped by paper, one collapsible section per paper that collapses automatically once every
conflict inside it is decided, with your value on the left, the remote's on the right, and an editable
final value in the middle (with a button on each side to just take that side). **Use all mine / Use
all remote** resolve every remaining conflict at once toward one side. Nothing is committed until
every conflict has been answered. This is why an empty, all-`null`/`false` field is written into every paper and
every reviewer's tree from the start (see [§9 of the schema guide](docs/annotation-schema.md#9-multiple-reviewers--consolidation))
— it is what makes a plain `git diff` of one reviewer's work legible on its own, and it is also why
SaiLoR's own merge doesn't need git's line-based merge to succeed: it reads the three revisions of the
file and reconciles them as data, not as text.

**Credentials.** SaiLoR never asks for your password and never stores one — it runs your own git, so
your credential helper and SSH agent do the authenticating, exactly as they would from a terminal. If
git would need to prompt at a terminal for something (a username typed interactively, for example) —
there isn't one here — the operation fails with git's own message telling you what to fix, rather than
hanging.

**What it will not do:**

- Merge a conflict outside the project (a PDF, a `.gitignore`, …) — SaiLoR only knows how to merge
  the project's own files; anything else is left for you to resolve with git, and the merge (or, for
  a branch switch, the whole attempt) is aborted cleanly rather than half-done.
- Merge two copies of the project whose **annotation schema** was changed on both sides, differently —
  the schema decides the shape of every tree, so there is no field-level answer; the pull (or the
  merge, or the branch-switch merge) refuses and tells you why.
- Delete a paper the remote deleted if you have annotated it since — it is kept, and you are told.
- Delete a remote branch, or force-delete a local one that isn't fully merged — both are left to a
  terminal.
- Revert a rename or an unresolved merge conflict via the whole-file ↺ — same reasoning as above.

Live clone progress with a cancel button is not part of this either.

**Sharing a folder between two SaiLoR projects** (e.g. "Start full-text screening" saving the new
project next to the screening one it came from) is supported deliberately, since the two use
different annotation-file names for the same paper — but a *second* project of the same kind in
that folder is not: a branch switch or merge treats an unrecognized file under `annotations/` the
same as any other file it doesn't know how to handle (refuses cleanly), and Save As refuses outright
if the destination already holds another project sharing paper IDs and file names, rather than let
the two start silently overwriting each other.

## Building & testing

Run `make help` for all targets. The main ones:

```bash
make dev               # start the desktop app (Tauri) with hot reload
make build             # release installer for this OS into src-tauri/target/release/bundle/
make test              # renderer (vitest) and Rust unit tests
make test-integration  # real-component end-to-end scenarios
make check             # type check, lint and all unit tests
make probe             # CI probe app (e2e/ page, probe commands)
```

`npm run build` writes the renderer into `dist/`. The Tauri build embeds it. Opening `dist/` in a
browser shows the "use the desktop app" notice.

Every CI job is a script, so you can run it locally or port it to another CI provider. The workflow
`.github/workflows/ci.yml` only installs toolchains and calls these scripts:

| Job | Script | Make target |
|---|---|---|
| Renderer: typecheck, wiki links, tests, build | `scripts/ci.sh` | `make ci` |
| Rust lint: fmt, clippy | `scripts/ci/rust.sh` | `make ci-rust` |
| Requirement trace (needs Java 17+) | `scripts/ci/trace.sh` | `make ci-trace` |
| Rust tests, installer bundle, probe run | `scripts/ci/bundle.sh` | `make ci-bundle` |
| Tauri e2e (needs `tauri-driver`) | `scripts/ci/e2e.sh` | `make ci-e2e` |

`scripts/ci/linux-deps.sh` installs the Linux system libraries. `make ci-all` runs every job except e2e.

Three layers of tests, by what each one can actually catch:

- **`npm test`** — plain vitest, no rendering. ~3400 tests of pure logic: schema resolution, project
  load/normalize/serialize, the three-way merge, git output parsing, and so on. Fast, runs on every
  PR via `scripts/ci.sh`.
- **`npm run test:integration`** (`src/test/integration/`) — jsdom + React Testing Library. Each test
  walks one full use case through the *real* rendered components with real clicks/typing/DOM events —
  `getPlatform()` is the only thing mocked, and even that mock's `GitPlatform` shells out to a real
  `git` binary against a real scratch repository, so a git-shaped assertion is checked against real
  git output, not a stub. Covers: authoring a schema → annotating a PDF (highlight/note/comment/field
  value) → committing
  ([`annotationWorkflow.integration.test.tsx`](src/test/integration/annotationWorkflow.integration.test.tsx));
  two reviewers disagreeing → Consolidation reconciling them → a real merge conflict on the same field
  ([`consolidationAndMerge.integration.test.tsx`](src/test/integration/consolidationAndMerge.integration.test.tsx));
  switching branches with an uncommitted change that the target branch also touched — a real
  `stash`-carry-over into a real conflict, resolved without committing
  ([`branchSwitch.integration.test.tsx`](src/test/integration/branchSwitch.integration.test.tsx)); and
  screening decisions converted into a new annotation project, including the real id-collision
  renaming
  ([`screeningImport.integration.test.tsx`](src/test/integration/screeningImport.integration.test.tsx));
  a `git pull` against a real remote (a bare repo standing in for "origin"), diverged by a real
  push from a second clone, resolved through the same merge dialog
  ([`pull.integration.test.tsx`](src/test/integration/pull.integration.test.tsx)); and discarding an
  uncommitted field-level change back to its last-committed value through the real field review,
  which never touches git history at all (`writeWorking`, not a commit) — the one test where
  `headContent`/`workingContent` are real rather than stubbed to `null`, since that's what's needed
  to populate field review in the first place
  ([`discard.integration.test.tsx`](src/test/integration/discard.integration.test.tsx)).
  More files cover the split of the shared annotations folder, the background fetch policy, the
  `samples/git-scenarios` build, the PDF reading position and stash operations.
  Slower than the unit suite (real scratch repos per test). It runs in `scripts/ci.sh` on every
  push.
- **`e2e/probe.test.mjs`** — the one thing jsdom structurally can't reach: the real Tauri app.
  `make probe` builds the app with a probe page (`e2e/`) and the `probe` cargo feature. CI starts it
  on every OS, and drives it with `tauri-driver` (WebDriver) on Linux and Windows. Release builds do
  not contain the probe commands.

### Mutation tests

Mutation tests check that the unit tests find wrong code. StrykerJS changes the code in small ways
(for example `<` to `<=`) and runs the unit tests. A change that no test finds is a "survived"
mutant. `stryker.config.json` sets the files to change: `src/model/` and the pure `src/llm/` modules.

1. Run `npm run test:mutation`. A full run takes more than one hour.
2. Open `.cache/stryker/mutation.html` to see the survived mutants. The JSON report is
   `.cache/stryker/mutation.json`.
3. Add a test that fails for each important survived mutant.

To check one file, run `npx stryker run --mutate src/model/year.ts`. Later runs only test changed
code (incremental mode). `vitest.mutation.config.ts` leaves out the performance tests
(`*.perf.test.*`), because their time limits fail under Stryker. CI does not run mutation tests. To
run them on GitHub, start the manual workflow `.github/workflows/mutation.yml`. The workflow uploads
the reports as the artifact `mutation-report`.

## Deployment

`make build` runs `tauri build` and writes native installers to `src-tauri/target/release/bundle/`.
Build each OS on that OS. See [docs/building.md](docs/building.md). The desktop app reads local PDF
files directly, so no server is involved.

To release, set the version in `package.json` and push the tag `v<version>`. The
[release workflow](.github/workflows/release.yml) builds every OS and attaches the installers,
signed updater files and `latest.json` to a draft release. Publish the draft to archive it on
Zenodo. Setup of the signing key and secrets: [docs/tauri-migration.md](docs/tauri-migration.md),
section 16.

## Developing with Docker

If you'd rather not install Node and Rust locally, build the Linux bundles in a container:

```bash
make docker-linux
```

[`Dockerfile.tauri-linux`](Dockerfile.tauri-linux) is an Ubuntu 22.04 image. It writes the
AppImage, `.deb` and `.rpm` into `./src-tauri/target/release/bundle/`. The bundles are unsigned and
have no updater files. macOS and Windows installers must be built on their native OS.

## Architecture

- `src/model/` — schema types + zod validation, project load/normalize/serialize (including the
  `project.json` + `annotations/` split and legacy-format migration), annotation instance-tree
  helpers, and the knowledge graph (`graph.ts`, the text query in `graphQuery.ts`, the Cypher subset
  in `graphCypher.ts`, the force layout in `graphLayout.ts`; the last two run in workers)
  (unit-tested).
- `src/screening/` — the derived screening schema, tri-state decision/reason reading, PRISMA-style
  counts, and the two cross-field validation rules screening needs (unit-tested).
- `src/platform/` — a `PlatformAdapter` seam; `desktop.ts` (native dialogs, fs, `slr-file://`
  protocol) runs on the Tauri bridge in `tauri.ts` and is the only real implementation —
  `unsupported.ts` stands in for every other runtime, showing the "use the desktop app" notice.
- `src/git/` — field-level change detection and three-way merge of the project (`changes.ts`,
  `merge.ts`, shared by both a pull and a carry-changes-over branch switch), plus git URL parsing and
  raw command output handling; the command side lives in `src-tauri/src/git.rs` since only the
  desktop app can spawn `git`.
- `src/llm/` — the AI-annotation layer: prompt, provider request/response shapes, field paths, and
  the parser that validates every proposal against the schema before a reviewer ever sees it.
- `src/state/store.ts` — Zustand + immer store (`src/state/aiStore.ts` for the AI flow,
  `src/state/gitStore.ts` for git).
- `src/components/` — Toolbar, PaperList, PdfViewer, AnnotationPanel/Node/Field, AiDialog,
  GraphView (canvas drawing in `graphCanvas.ts`).
- `src-tauri/` — the Rust shell (Tauri v2): window, menu, dialog/fs commands, path authorization,
  PDF protocol, git, AI calls with keychain-held keys, local runtime and updater.

## Citation

Cite SaiLoR with the data in [`CITATION.cff`](CITATION.cff). Use the version that you used. Use the DOI of that version.
After the technical report is released, cite the report.

<!-- TODO(before release): The DOI badge is the Zenodo concept DOI (latest version). Use the version DOI for a fixed release. -->
