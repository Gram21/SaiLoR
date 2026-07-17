<p align="center">
  <img src="build/icon.png" alt="SaiLoR" width="128" height="128">
</p>

<h1 align="center">SaiLoR</h1>

A tool to assist reviewers during **Systematic Literature Reviews (SLR)** — the letters are in the
name: **S**ai**L**o**R**. Open a single JSON "project" file that holds both an annotation schema
(a nested, cardinality-controlled taxonomy) and the papers to annotate. Read each paper's PDF, fill in typed
annotation fields — optionally grabbing values straight from selected PDF text — and save the
annotations back into the JSON.

The same codebase runs two ways:

- **Desktop app** (Electron) — fully local, opens local PDF files, native Open/Save dialogs.
- **Web app** — a static build you can host on any server (or open locally in a Chromium browser).

<p align="center">
  <img src="docs/screenshots/annotate.png" alt="The three-pane annotation view: papers, the PDF, and the annotation form" width="900">
</p>

## Quick start

```bash
npm install

# Web development (browser):
npm run dev
# then open http://localhost:5173

# Desktop app (Electron) in dev:
npm run dev:electron
```

## Installing a release

Grab the file for your system from the [releases page](https://github.com/Gram21/SaiLoR/releases):

| System | File |
|---|---|
| macOS, Apple Silicon (M1–M4) | `SaiLoR-<version>-macos-arm64.dmg` |
| macOS, Intel | `SaiLoR-<version>-macos-x64.dmg` |
| Windows | `SaiLoR-<version>-windows-x64.exe` |
| Linux | `SaiLoR-<version>-linux-x64.AppImage` |

> **The releases are not signed** with an Apple or Microsoft code-signing certificate —
> paying for one is not worth it for a research tool. Both systems will therefore warn you
> the first time you open the app. The steps below are how you tell them to go ahead; you
> only need to do it once.

> **Upgrading from SLR Helper?** The desktop app's settings — recent projects and window size —
> now live in a `SaiLoR` folder (on macOS, `~/Library/Application Support/SaiLoR`). On first run
> the app migrates the old "SLR Helper" folder automatically, so nothing is lost.

### macOS

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

### Windows

1. Run `SaiLoR-<version>-windows-x64.exe`.
2. Windows SmartScreen shows *"Windows protected your PC"*. Click **More info**, then
   **Run anyway**.
3. Follow the installer.

### Linux

The AppImage is a single self-contained file — no installation needed. Make it executable
and run it:

```bash
chmod +x "SaiLoR-<version>-linux-x64.AppImage"
./"SaiLoR-<version>-linux-x64.AppImage"
```

If it fails to start, your distribution may be missing FUSE (`sudo apt install libfuse2`
on Debian/Ubuntu), or you can extract and run it with `--appimage-extract-and-run`.

## Project file format

> 📖 For a full authoring guide with many examples, see
> [docs/annotation-schema.md](docs/annotation-schema.md). The summary below is the quick reference.

```jsonc
{
  "version": 1,
  "config": {
    "schema": [
      { "name": "Relevant", "type": "boolean" },        // leaf field
      { "name": "Study Type", "type": "string",
        "options": ["Case study", "Experiment", "Survey"] },  // enum dropdown

      { "name": "Year", "type": "number" },
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
    "screening": { "reasons": ["Wrong topic", "Duplicate"] }  // optional — see "Screening" below;
                                     // when present, "schema" above is ignored and derived from this
  },
  "papers": [
    {
      "id": "paper-a",
      "title": "…",
      "authors": ["…"],
      "doi": "10.1000/xyz",         // optional
      "abstract": "…",              // optional — what screening reads when there is no PDF yet
      "pdf": "pdfs/paper-a.pdf",    // path relative to this JSON file; "" is only valid in a screening project
      "annotations": {},            // the final result — written in full (every field, empty) once opened
      "reviews": {}                 // multi-reviewer only: one full empty tree per reviewer "1".."N", same reason
    }
  ]
}
```

**Annotation nodes** (`config.schema[]`):

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Display label (required). Sibling names must be unique.                 |
| `type`        | `string` \| `number` \| `boolean`. Omit for a group (name-only) node.   |
| `children`    | Sub-taxonomy. A node may have `type`, `children`, or both.              |
| `min`         | Minimum occurrences (default `1`).                                      |
| `max`         | Maximum occurrences: a number, or `null` for unbounded (default `1`).   |
| `options`     | Array of strings on a `string` field → a filterable enum dropdown.      |
| `description` | Optional tooltip.                                                       |

**Annotation data** mirrors the schema: at each level a map keyed by node name, where every key
holds an array of instances (bounded by `min`/`max`). Each instance carries a `value` (for fields)
and/or nested `children`. Saving prunes trailing empty optional instances and leaves `config`
untouched. Unknown top-level and per-paper fields are preserved verbatim.

## Using the app

- **Open ▾ menu** — open a project file, or reopen one of the last 5 recent projects. (Recent
  projects require the desktop app or a Chromium browser; other browsers show only "Open file…".)
- **Save ▾ menu** — Save or Save as…, with their shortcuts shown next to each item.
- **? (Help)** — opens a dialog describing the workflow and listing all keyboard shortcuts.
- **Left pane** — collapsible list of papers (toggle with the ☰ button). A green dot marks papers
  that already have annotations — in a **screening project** this becomes a tri-state marker
  (included / excluded / undecided) with a filter above the list instead; see
  [Screening](#screening).
- **Resizable panes** — drag the borders between the three panes to resize them; the widths are
  remembered.
- **Middle pane** — the paper's PDF, rendered with a selectable text layer. In a screening project
  this defaults to the title/abstract record instead, with a one-click swap to the PDF.
- **Right pane** — the annotation form, laid out by the taxonomy. Repeatable nodes show **+ Add**
  (up to `max`) and a remove (**×**) control (down to `min`). In a screening project this is the
  Include/Exclude decision instead — see [Screening](#screening).
- **Grab from PDF** — select text in the PDF, then click the **⧉** button next to a string/number
  field to insert it (numeric fields extract the first number).
- **Reviewer switch** — on multi-reviewer projects only, centred in the toolbar: pick whether you are
  Reviewer 1…N or Consolidation. See [Working with several reviewers](#working-with-several-reviewers).
- **✦ AI** — *not available yet.* An LLM proposes values for the fields that are still empty, for
  you to review before anything is written. The groundwork is in the app but the feature is off in
  this release; it is planned for a future one. See [Annotating with AI](#annotating-with-ai).
- **Theme** — toggle light/dark for the app with the ☾/☀ button (top right). The choice is
  remembered. The PDF paper is always rendered on a normal white background, regardless of theme.
- **Font size** — the `A− A A+` buttons (or the shortcuts below) scale the app's text. This affects
  the app chrome only, not the rendered PDF. The chosen size is remembered.

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
  the project's **final result**, and what an export or analysis would read. (The AI button is not
  offered here: reconciling is a human call on what the reviewers actually said.)
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

It is still **one file, with no locking**: two people saving the same JSON at once will overwrite
each other. Pass it along, or take turns — or see [Git](#git) below, which is built for exactly
this: independent copies, reconciled field by field instead of overwritten.

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
  agreed, Consolidation's **Adopt all** takes every one of those decisions at once. AI-assisted
  screening is not offered: screening decides the review's corpus, which is not a call to hand to a
  model.

**Starting the next phase from a screening project.** Once screening is done, **New from
screening…** (on the start screen) builds the annotation project that follows it: pick the screening
JSON, and every paper **not explicitly excluded** is carried over — included papers always, and
undecided ones by default (dropping a paper nobody actually excluded would silently shrink the
review; you can choose to leave them out in the confirmation dialog instead). Title, authors, DOI,
abstract and the PDF reference all carry over. The new project's JSON is saved **next to the
screening JSON** by default, so every paper's relative PDF path keeps resolving without being
rewritten. For a multi-reviewer screening project, "included" reads the **consolidated** decision —
the one that ships — never an individual reviewer's own opinion.

> 📖 Full details, including the derived schema's exact shape, are in
> [§10 of the schema guide](docs/annotation-schema.md#10-screening-projects).

## Annotating with AI

> 🚧 **Not available yet — planned for a future release.**
> The groundwork described in this section is built into the app, but the feature is **switched off**
> in this release: the **✦ AI** button is not shown, and there is no way to set a provider up or
> start a run. Read this section as a preview of what is coming, and of how it will treat your data
> when it does, rather than as instructions you can follow today.

The **✦ AI** button at the top of the annotation column asks a language model to read the paper you
have open and **propose** values for its annotation fields. It is a first draft, not an answer.

**What it does**

- It only looks at the fields that are **still empty**. Anything you have already filled in is not
  sent as a question and is **never overwritten** — including if you fill a field in while the model
  is still thinking.
- You get a table: the field, the value the model proposes, the **verbatim quote from the paper**
  that supports it, the model's confidence, and a checkbox. Untick anything you don't want.
  **Nothing is written into your project until you press Apply.**
- The whole fill lands as a *single* change: one `Ctrl/Cmd + Z` undoes all of it.
- Proposals that don't fit your schema — a field that doesn't exist, a number that isn't a number, a
  value outside a dropdown's choices — are refused by the app and listed separately, never applied.
- The model is instructed to quote the paper for every value and to **leave a field empty rather
  than guess**. It is still a language model: check the quotes.

<p align="center">
  <img src="docs/screenshots/ai-review.png" alt="The review table: each proposed value with the quote from the paper that supports it, a confidence, and a checkbox" width="820">
</p>

Once applied, every field the model filled keeps a **light-blue border** until you click it (or its
name). That click is you confirming the value — the marks are yours alone: they are never saved into
the project file and are gone when you reopen it.

<p align="center">
  <img src="docs/screenshots/ai-marks.png" alt="Annotation fields filled by the AI, each outlined in light blue until confirmed" width="380">
</p>

**Where it sends your paper**

> ⚠️ **Once enabled, the paper's extracted text will be sent to whichever LLM provider you
> configure.** (Or the PDF file itself, if you set the target up that way.) It will leave your
> machine and go to that provider under that provider's terms. **Don't use it on material you are
> not allowed to share** — papers under a publisher's licence, embargoed manuscripts, anything
> confidential. The dialog names what will be sent and to whom before anything leaves.

There is no built-in provider and no key ships with the app: nothing is sent anywhere until you set
up a target yourself.

**Supported providers** — **Anthropic**, **OpenAI**, **Google (Gemini)**, **OpenRouter**, **Groq**,
**Mistral**, **DeepSeek**, **xAI (Grok)**, or **any OpenAI-compatible endpoint**, including one
running locally (LM Studio, llama.cpp, vLLM, …). A local endpoint is the one setup where the paper
does not leave your machine. Only Anthropic, OpenAI, Google and OpenRouter can take the PDF itself —
the rest always receive the extracted text.

Set one up via **✦ AI → ⚙** (or *Set up an LLM…*): give the target a name, pick the provider, enter
the model name and your API key, and press **Verify setup** to send a one-word test request. On the
desktop the key is stored **encrypted with your operating system's keychain** and is never handed to
the page. In the **browser build** it is stored **unencrypted** in local storage and some providers
refuse calls made directly from a web page — the desktop app is the supported path for this feature.

<p align="center">
  <img src="docs/screenshots/ai-settings.png" alt="Setting up an LLM target: name, provider, base URL, model, API key, and a Verify setup button" width="700">
</p>

<p align="center"><em>Setting up a target — shown in the browser build, which is why it leads with the
key-storage warning. The desktop app stores the key in your OS keychain instead.</em></p>

**Extraction quality is the ceiling.** The paper is sent as text pulled out of the PDF, and that
extraction is only as good as the PDF: two-column papers, tables, figures and formulas come out
imperfectly, and a **scanned** paper yields no text at all (the app stops and tells you, rather than
letting the model invent a paper from its title). The model is told the text may be garbled and to
omit a field rather than reconstruct it — but it is one more reason to read the quote before you
accept a value.

## Saving

- **Desktop**: writes to the opened file's path; **Save as** opens a native dialog.
- **Browser (Chromium)**: uses the File System Access API to save in place / to a new file.
- **Browser (other)**: downloads the updated JSON.

## Git

> **Desktop only, and not by accident.** Git support runs your own `git` binary, so it can use your
> real `~/.gitconfig`, your credential helper, and your SSH agent. A web page cannot spawn a process
> or read a config file — there is no permission that changes that — so there is nothing honest to
> fall back to in the browser build. *Import from git…* and the toolbar's **Git** button still
> appear there, greyed out, rather than vanishing — hover for a note pointing you at the desktop app.
> If `git` is not on your PATH in the desktop app instead, the same controls appear greyed out with
> git's own error explaining why.

**Import from git…** — on the start screen and in the toolbar's *Open* ▾ menu. Paste a repository URL,
pick a folder, and confirm; the app then clones it. A clone of a repository full of PDFs can take a
while, so you get a spinner and an elapsed-seconds line rather than a frozen-looking window. If it
fails, you get git's **exact** error message and land back on the same form with what you typed still
in it. On success you pick which project JSON to open, and the file picker already starts inside the
folder that was just cloned.

**The Git button** appears in the toolbar whenever the open project's JSON file sits inside a git
repository. It opens a panel with:

- your changes and a diff, so you can see what you are about to commit,
- a commit message box and a **Commit** button,
- **Pull** and **Push**.

**Pull merges annotations field by field, not line by line.** A field only *you* changed keeps your
value. A field only the *remote* changed takes theirs. Only a field you **both** changed — to
different things — is a real conflict, and those are the only ones you are ever asked about: a list
with your value on the left, the remote's on the right, and an editable final value in the middle
(with a button on each side to just take that side). Nothing is committed until every conflict in the
list has been answered. This is why an empty, all-`null`/`false` field is written into every paper and
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

- Merge a conflict outside the project JSON (a PDF, a `.gitignore`, …) — SaiLoR only knows how to
  merge the annotation file; anything else is left for you to resolve with git, and the merge is
  aborted cleanly rather than half-done.
- Merge two copies of the project whose **annotation schema** was changed on both sides, differently —
  the schema decides the shape of every tree in the file, so there is no field-level answer; the pull
  refuses and tells you why.
- Delete a paper the remote deleted if you have annotated it since — it is kept, and you are told.

Live clone progress with a cancel button, and branch switching or history browsing, are not part of
this either.

## Building & testing

```bash
npm run build            # static SPA into dist/ (host anywhere)
npm run build:electron   # desktop installers into release/ (via electron-builder)
npm test                 # unit tests (model: schema, normalize, round-trip)
npm run typecheck
```

## Deployment

### A. Browser variant — static hosting

`npm run build` emits a self-contained static site in `dist/`. Serve that folder from any static
host (nginx, Apache, S3/CloudFront, GitHub Pages, …). The build uses a relative base, so it also
works from a subpath.

Place each project JSON next to its `pdfs/` folder on the same host and link to it with
`?project=<url>` — the app fetches the JSON and resolves its PDFs relative to that URL:

```
https://your.host/?project=/reviews/2026/project.json
```

Users can also just click **Open…** in the app to load a local JSON from their own machine.

### B. Browser variant — Docker (recommended for self-hosting)

A multi-stage [`Dockerfile`](Dockerfile) builds the SPA and serves it with nginx; the
[`docker-compose.yml`](docker-compose.yml) wires up the port and the volume of project files.

```bash
# Build and start (serves on http://localhost:8080)
docker compose up -d --build

# Stop
docker compose down
```

By default the bundled example folder [`./samples`](samples) is mounted read-only into the
container and served under the `/projects/` URL namespace, so once the container is up you can
open:

```
http://localhost:8080/?project=/projects/project.example.json
```

To use your own reviews, point the volume in `docker-compose.yml` at your own folder of project
JSONs and their PDFs — whatever folder you mount is served at `/projects/`:

```yaml
volumes:
  - ./my-reviews:/usr/share/nginx/html/projects:ro
```

```
my-reviews/
  my-review.json          # references pdfs/paperX.pdf (paths relative to the JSON)
  pdfs/
    paperX.pdf
```

Open it with `http://localhost:8080/?project=/projects/my-review.json`.

Change the published port by editing the `ports:` mapping in `docker-compose.yml` (default
`8080:80`). To build/run the image without Compose:

```bash
docker build -t sailor .
docker run -d -p 8080:80 -v "$PWD/samples:/usr/share/nginx/html/projects:ro" sailor
```

> The browser variant is read-only on the server: saving happens client-side (File System Access
> API or a download), never written back to the container — hence the read-only mount.

### C. Desktop variant — Electron installers

`npm run build:electron` runs `electron-builder` and produces native installers in `release/`
(the `build` block in [`package.json`](package.json) targets `dmg` on macOS, `nsis` on Windows,
`AppImage` on Linux). Build on (or cross-build for) each target OS as needed. The desktop app reads
local PDF files directly, so no server is involved.

## Developing with Docker

If you'd rather not install Node locally, a separate dev stack in
[`docker-compose.dev.yml`](docker-compose.dev.yml) can run the browser dev server or build the
Electron app in a container. It is **fully separate** from the production `docker-compose.yml`
above — nothing here runs on a plain `docker compose up`, so deployment is never affected. Pick a
target with a Compose **profile**:

```bash
# Browser development — Vite dev server with hot reload on http://localhost:5173
docker compose -f docker-compose.dev.yml --profile browser up --build
# then open http://localhost:5173/?project=/samples/project.example.json

# Build the Electron desktop app — installers are written to ./release/
docker compose -f docker-compose.dev.yml --profile electron run --rm electron
```

- **Browser dev** ([`Dockerfile.dev`](Dockerfile.dev)) bind-mounts the source for hot reload. If
  file edits aren't detected (common on macOS/Windows mounts), prefix the command with
  `VITE_USE_POLLING=1`.
- **Electron build** ([`Dockerfile.electron`](Dockerfile.electron)) is a Debian image that runs
  `electron-builder`. It builds **Linux** installers (AppImage) into `./release/`; macOS/Windows
  installers must be built on their native OS (Windows can be cross-built by basing the image on
  `electronuserland/builder:wine`). Running the Electron GUI inside the container additionally needs
  X11 forwarding — for day-to-day desktop development, run `npm run dev:electron` on the host.

## Architecture

- `src/model/` — schema types + zod validation, project load/normalize/serialize, annotation
  instance-tree helpers (unit-tested).
- `src/screening/` — the derived screening schema, tri-state decision/reason reading, PRISMA-style
  counts, and the two cross-field validation rules screening needs (unit-tested).
- `src/platform/` — a `PlatformAdapter` seam so the UI is identical in Electron and the browser
  (`electron.ts` = IPC + `slr-file://` protocol; `browser.ts` = File System Access API / fetch).
- `src/llm/` — the AI-annotation layer: prompt, provider request/response shapes, field paths, and
  the parser that validates every proposal against the schema before a reviewer ever sees it.
- `src/state/store.ts` — Zustand + immer store (`src/state/aiStore.ts` for the AI flow).
- `src/components/` — Toolbar, PaperList, PdfViewer, AnnotationPanel/Node/Field, AiDialog.
- `electron/` — thin main process (BrowserWindow, Edit-role menu, dialog/fs IPC, PDF protocol) and
  a context-isolated preload.
