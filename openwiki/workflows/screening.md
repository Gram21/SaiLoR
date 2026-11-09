---
type: workflow
title: Screening Mode
description: The screening workflow — a fast Include/Exclude decision per paper before annotation begins — covering the derived two-node schema, the tri-state status read, PRISMA-style counts, cross-field validation, the screening UI panels, the on-disk screening-* filename prefix, the screening highlights carried into the next project, and importing a screening project into an annotation project.
tags: [screening, workflow, prisma, schema, validation, multi-reviewer]
sources:
  - id: openwiki-source-5e350144821ef45403557db2
    resource: repo://src-tauri/src/project.rs
  - id: openwiki-source-54631e6ebf1d3b815c4a5eed
    resource: repo://src/App.tsx
  - id: openwiki-source-57771ec2f8e2fcc75b7e3567
    resource: repo://src/components/AnnotationPanel.tsx
  - id: openwiki-source-8274b48e7dac031772eea062
    resource: repo://src/components/ConsolidationDialog.tsx
  - id: openwiki-source-4599b619fa759e59c83c5e95
    resource: repo://src/components/PaperList.tsx
  - id: openwiki-source-5ad199ba542ff21b3fc608a3
    resource: repo://src/components/PdfViewer.tsx
  - id: openwiki-source-770a5cff3dc7490c2df0d1ab
    resource: repo://src/components/ProjectEditor.tsx
  - id: openwiki-source-d960f15fbc4ca05bd459823b
    resource: repo://src/components/ScreeningImportDialog.tsx
  - id: openwiki-source-43dac0cae806474a160d5b4b
    resource: repo://src/components/ScreeningPanel.tsx
  - id: openwiki-source-9e7bc818aa92a7e05b33441a
    resource: repo://src/components/ScreeningReasonsEditor.tsx
  - id: openwiki-source-dab0c45065e1ef471ffadf12
    resource: repo://src/components/ScreeningRecord.tsx
  - id: openwiki-source-f8cbacea70b4828f54b5d7ab
    resource: repo://src/components/ScreeningSummary.tsx
  - id: openwiki-source-d284db292c5d5d9e3292e37d
    resource: repo://src/consolidate/agreement.ts
  - id: openwiki-source-2e4cee0e79365b1e9129226b
    resource: repo://src/consolidate/unanimous.ts
  - id: openwiki-source-c85a074faabee3af51b3db68
    resource: repo://src/git/ownAnnotationPath.ts
  - id: openwiki-source-5ac51bca8e99f7c8930be1b1
    resource: repo://src/hooks/useKeybindings.ts
  - id: openwiki-source-8cea3d31e78ed048bd98459e
    resource: repo://src/model/annotationState.ts
  - id: openwiki-source-68e9e61da0efb614946dda70
    resource: repo://src/model/project.ts
  - id: openwiki-source-a0459bce65b7490683280544
    resource: repo://src/model/schema.ts
  - id: openwiki-source-75a678397757a635cb1544f6
    resource: repo://src/model/screeningMarks.test.ts
  - id: openwiki-source-6f6097db1395bf290c1b787f
    resource: repo://src/model/screeningMarks.ts
  - id: openwiki-source-1e07552900756183b8f9bb84
    resource: repo://src/model/seatTree.ts
  - id: openwiki-source-bddbb7f6aca9d2392d629f42
    resource: repo://src/platform/assemble.ts
  - id: openwiki-source-5f3156110d9aafbc8e103762
    resource: repo://src/screening/counts.ts
  - id: openwiki-source-bb661fe9e76765e4c890ce71
    resource: repo://src/screening/reasonUsage.ts
  - id: openwiki-source-c0a5a9016440eaf62ed2a380
    resource: repo://src/screening/schema.ts
  - id: openwiki-source-479c74ae5cbf30b0a06174a1
    resource: repo://src/screening/status.ts
  - id: openwiki-source-fa765b0e395ba25b6016d05a
    resource: repo://src/screening/validate.ts
  - id: openwiki-source-f222dc1d70cd27df6524150a
    resource: repo://src/state/editorStore.ts
  - id: openwiki-source-9de36eae273aef15cabd4bdf
    resource: repo://src/state/store.screening.test.ts
  - id: openwiki-source-ef7081db6ccf2fcb18d86368
    resource: repo://src/state/store.screeningAbstract.test.ts
  - id: openwiki-source-89409d7a9c0280067e058c1a
    resource: repo://src/state/store.ts
generated: { by: "claude-code", at: "2026-11-07T10:50:01.257Z" }
verified:
  - by: openwiki/0.7.3
    at: 2026-11-09T08:29:20.744Z
---

# Screening Mode

Screening is an alternative project mode for the title-and-abstract (or full-text) triage step of a
systematic review: reviewers make a fast **Include / Exclude** decision per paper, recording an
exclusion *reason* when they exclude, before any structured annotation begins. It is *not* the
annotation workflow with a boolean field bolted on — it is a distinct mode that reuses the same
multi-reviewer, consolidation, and validation machinery as annotation but replaces the authored
schema with a fixed two-node one derived from a pre-registered list of exclusion reasons.

The switch is one field: `Project.screening` (`ScreeningConfig | null`). When it is non-null the
project is a screening project, `isScreening(project)` returns true, and the whole UI swaps from the
annotation surface to the screening surface. The project editor exposes it as a single checkbox
("This is a screening project"), which writes `config.screening` into the JSON.

## What makes it a distinct mode

A screening project differs from an annotation project in six coupled ways:

1. **The schema is derived, not authored.** `config.screening.reasons` (the exclusion reasons) is the
   only authorable part of the schema; the rest is fixed (see [Derived schema](#derived-schema)).
2. **`Project.screening` is set.** This single presence flag is the predicate every caller uses
   (`isScreening`).
3. **On-disk files use the `screening-*` prefix** instead of `reviewer-<n>.json` /
   `consolidated.json` / `marks-*.json` (see [On-disk layout](#on-disk-layout)).
4. **The UI swaps panels.** `App.tsx` renders `ScreeningRecord` + `ScreeningPanel` instead of
   `PdfViewer` + `AnnotationPanel`, and `ScreeningReasonsEditor` replaces `SchemaTreeEditor` in the
   project editor. The paper list swaps its completeness dot for a tri-state marker and its filter
   dropdown for a four-button segmented control.
5. **Decisions are imported into a new project.** A "New from screening…" / "Import from screening…"
   flow partitions the source screening project and carries the included (and, by default, the
   undecided) papers into a fresh annotation or second-screening project, recording provenance for a
   PRISMA flow diagram.
6. **The AI flow is a proposal flow, not a fill flow.** The toolbar's AI button opens the screening
   proposal dialog instead of the annotation fill dialog — see [AI-Assisted Screening](ai-screening.md).

```mermaid
flowchart TB
    subgraph ScreeningProject["Screening project (Project.screening set)"]
        Schema["Derived two-node schema<br/>Decision: Include/Exclude<br/>Reason: from config.screening.reasons"]
        Decisions["Per-paper decisions<br/>screening-1.json ... screening-consolidated.json"]
        Counts["PRISMA counts<br/>included / excluded / undecided + by-reason"]
    end
    Start["New from screening..."]
    Import["Import from screening..."]
    Dialog["ScreeningImportDialog<br/>pre-commit summary"]
    Target["New or open project<br/>(annotation OR second screening)"]
    Provenance["ProjectProvenance<br/>kind: screening-import<br/>counts: included/undecided/excluded/carried"]
    Marks["Screening highlights<br/>screeningMarks by paper id"]

    Schema --> Decisions
    Decisions --> Counts
    Start --> Dialog
    Import --> Dialog
    Dialog -->|resolve| Target
    Target --> Provenance
    Provenance --> Marks
```

A screening project carrying the included papers forward into the next phase of the review, with the
excluded papers dropped and the undecided papers carried by default.

Related reading: [Multi-Reviewer Consolidation](consolidation.md) (the seat model screening reuses),
[PDF Viewer and Marks](pdf-viewing.md) (the marks model the screening highlights ride on),
[Annotation Schema](../concepts/annotation-schema.md), and [Data Model](../concepts/data-model.md).

## Derived schema

The schema for a screening project is *never read from the file*. `loadProject` derives it fresh on
every load from `config.screening.reasons`, so a hand-edited reason list can never disagree with the
dropdown the reviewer sees. `serializeProject` writes the derived schema back out so the file stays
self-describing for anything reading it without SaiLoR.

`src/screening/schema.ts` defines the fixed shape:

- `SCREENING_DECISION = 'Decision'` — a two-option string enum (`Include` / `Exclude`), **not** a
  boolean checkbox. This is a hard constraint of the codebase, not a stylistic choice: the
  `isEmptyValue` / `isUnanswered` / `hasAnnotations` machinery treats a boolean as "empty" until it
  is `true`, so an "Exclude" checkbox could not distinguish "I decided to include this" from "I have
  not looked at this yet" — both would read as `false`. Screening is exactly the phase where that
  distinction *is* the output (the progress count, the PRISMA numbers, and which papers survive an
  import all depend on it). A checkbox would also break every module this feature exists to reuse:
  `hasAnnotations` would call an included paper unannotated, `readyToConsolidate` would say a paper
  both reviewers *included* is not ready, `unanimousFills` would refuse to adopt a unanimous
  "include", and kappa would only ever see the excluded papers. A two-option enum gets the tri-state
  for free and keeps every one of them correct with no change.
- `SCREENING_REASON = 'Reason'` — a string whose options are a copy of `config.screening.reasons`.
- `DEFAULT_SCREENING_REASONS` — the reasons seeded when the editor's screening checkbox is turned on
  (`Not peer-reviewed`, `Wrong topic`, …, `Other`). "Other" is included on purpose: a closed enum
  needs an authored escape hatch, not a magic one.
- `screeningSchemaDefs(config)` returns the two `AnnotationDef`s; `loadProject` runs them through
  `resolveSchema` exactly as an authored schema would be.
- `isScreening(project)` — the one predicate every caller uses: `!!project?.screening`.

`ScreeningConfig` (in `model/schema.ts`) is `{ reasons: string[] }` and is the *only* authorable
setting. On load, `parseScreening` trims, dedupes, and drops blank entries, requiring at least one
reason or throwing a `ProjectLoadError` — a broken reasons list cannot be degraded past, because the
reasons *are* the schema. The zod `superRefine` on the project schema accordingly lets a screening
project omit `config.schema` entirely (everyone else must supply a non-empty one), and skips the
"each paper needs a `pdf` path" rule there too, since screening is normally done on a
reference-manager export with no PDFs at all.

## The tri-state status read

`src/screening/status.ts` is the read every count, validation rule, and the import flow depend on:

- `screeningStatus(tree)` → `'included' | 'excluded' | 'undecided'`. A null/missing tree, a missing
  node, or anything that is not exactly `Include`/`Exclude` reads as **`undecided`** — the
  conservative direction. A status the function cannot make sense of is "not screened", never
  "excluded", which is what `partitionScreeningPapers` relies on to never silently drop a paper it
  merely couldn't parse.
- `screeningReason(tree)` → `string | null`. Only meaningful when the status is `excluded`; callers
  must check. A stray `Reason` on an included/undecided paper (a hand-edited file, or a decision
  walked back without clearing the reason) is not this function's business to interpret.

```mermaid
stateDiagram-v2
    [*] --> undecided
    undecided --> included: set Decision = Include
    undecided --> excluded: set Decision = Exclude
    excluded --> undecided: clear Decision (u)
    excluded --> excluded: set Reason (1-9)
    included --> undecided: clear Decision (u)
    included --> excluded: set Decision = Exclude
    excluded --> included: set Decision = Include
```

The decision can move freely between the three states; the reason is only meaningful and editable
while excluded.

## Counts and PRISMA totals

`src/screening/counts.ts` produces the numbers a screening review must report. It is deliberately
store-free: it imports the shared `seatTree` (`src/model/seatTree.ts`), which the store's
`currentTree` also builds on (single-reviewer reads `paper.annotations`; Consolidation reads
`paper.annotations`; a numbered reviewer reads `paper.reviews[n]`; `null` reads nothing), so the module
stays independently testable, never creates a reviewer's tree, and cannot drift from the store's routing.

`screeningCounts(project, currentReviewer)` returns `ScreeningCounts`:

- `total`, `included`, `excluded`, `undecided` — the include/exclude/pending headline a PRISMA flow
  diagram needs.
- `byReason` — every configured reason is a key, **including the ones nobody used**: PRISMA reports
  the pre-registered list in full, and a reason that eliminated nothing is a finding, not an absence.
  Built with `Object.create(null)` so a hand-edited reason of `"constructor"` or `"__proto__"` cannot
  collide with `Object.prototype` and book a paper against an inherited member.
- `excludedWithoutReason` — excluded papers whose reason is blank or not one of the configured ones.
  Its own bucket rather than folded into a reason nobody picked: the number is only honest if it says
  what it does not know.

### Two pending-unanimous counts

Multi-reviewer screening has two *deliberately separate* "pending unanimous" counts, because they
answer different questions:

- `pendingUnanimous(project)` — papers holding *anything* every numbered reviewer recorded
  identically that Consolidation has not adopted yet (a decision, a reason, or both). Drives the
  notice next to the **Adopt all** button in `ScreeningPanel`, and that button adopts everything
  unanimous — so the count must reflect any pending fill, not just decisions. (Counting only decisions
  made two reviewers who both excluded for the same reason, where the consolidator set the decision
  by hand but left the reason blank, produce a reason fill and no decision fill — no notice, nothing
  offering to adopt the reason, and the paper booked as excluded-without-a-reason permanently.)
- `pendingUnanimousDecisions(project)` — papers that are still undecided *and* whose reviewers all
  chose the same decision. The screening-import dialog speaks specifically about papers "not yet
  screened" with no final decision, so a paper that already has a decision and merely lacks a
  unanimous *reason* must not be counted there — the sentence would be false, promising that adopting
  changes an inclusion count that is already settled.

Both are zero for a single-reviewer project and delegate to `unanimousFills`
(`consolidate/unanimous.ts`), the same "what did every reviewer agree on" routine the annotation
consolidation path uses. The underlying constraint is why screening can adopt a whole project in one
synchronous pass: `adoptUnanimousValues` reads every reviewer at a fixed index, which is only
meaningful once repeatable entries are aligned, and a screening schema has no repeatable node to
align. The same rule scales the agreement statistic: `agreementInput` (`consolidate/agreement.ts`)
restricts a screening project to the `Decision` field only — the exclusion reason is a different
question, and one only defined on the papers both reviewers excluded — so **⚖ Agreement** on a
screening project reports κ over the include/exclude decision specifically.

## Reason usage tracking

`src/screening/reasonUsage.ts` answers the two questions the reasons editor needs to guard a rename:
how many papers use a reason, and rewrite it across all of them. Renaming or removing an exclusion
reason in the editor orphans every paper that recorded the old label — the PRISMA counts then can't
attribute it (it lands in `excludedWithoutReason`) — so the editor warns rather than letting that
happen silently.

A multi-reviewer paper carries a reason in more than one place: its consolidated `annotations` tree
and each reviewer's own tree. The module is generic over a `ReasonBearingPaper` shape (the editor
keeps reviewer trees under `extra.reviews` rather than the typed `Paper`), so both are checked from
the raw shape.

- `countPapersUsingReason(papers, reason)` — how many papers record `reason` in any of their
  screening trees. `''` never matches (an unset reason is not "using" anything).
- `renameReasonInPapers(papers, from, to)` — rewrites `from` → `to` in every screening tree of every
  paper, immutably. Papers and trees that don't reference `from` keep their identity (both the array
  and unchanged element objects), so a caller's dirty-tracking only marks what actually changed and
  `=== papers` reliably means "no-op".

## Validation

`src/screening/validate.ts` enforces the two cross-field rules the schema language cannot express.
The screening UI makes both unreachable (the Reason control disables itself unless the decision is
Exclude, and `setScreeningDecision` clears the reason on any non-Exclude decision), but a
hand-edited file can still hold either, and both corrupt the PRISMA counts silently if nobody says
so.

`screeningIssues(project, currentReviewer)` produces `ValidationIssue[]` with `kind: 'screening'`:

1. **Exclude requires a reason** — `status === 'excluded' && !reason` →
   *"Excluded, but no exclusion reason is recorded."*
2. **Include must not have a reason** — `status !== 'excluded' && reason` →
   *"An exclusion reason is recorded, but this paper is not excluded."*

It uses the same `seatTree` routing as the counts module. A malformed tree is reported as no issues
rather than throwing (it reads as `undecided`, which is never a violation). Issues carry
`canonicalPath: ''` because screening has no annotation-panel field to jump to (its schema is
derived, not authored) — `ValidationDialog` falls back to a paper-only jump. The store's
`runValidation` action appends these to the ordinary schema validation issues over the *original*
project, since `screeningIssues` reads decision and reason together rather than a single remapped
tree.

## The screening UI

`App.tsx` swaps the middle and right panes based on `project.screening`: when it is set, the middle
pane is `ScreeningRecord` (unless `screeningShowPdf` is on) and the right pane is `ScreeningPanel`.

### ScreeningRecord (middle pane)

`src/components/ScreeningRecord.tsx` is the default surface shown *instead of* `PdfViewer`.
Screening is normally a title + abstract decision by protocol, and the PDF is often entirely absent
(a fresh reference-manager export), so this is the default rather than `PdfViewer` nested inside it.
It shows the paper's title, authors, venue/year, DOI, and abstract, plus a "Read the PDF" button
(only when `paper.pdf` is non-empty) that flips `screeningShowPdf` to reveal the untouched
`PdfViewer`. `PdfViewer` itself is not modified and is reachable with one click.

It also surfaces an **abstract-extracted** notice: if `paper.abstractFromPdf` is set, the abstract
was extracted automatically from the PDF text and may be incomplete or wrong. The store's
`extractScreeningAbstract` reads the PDF (outside `PdfViewer`'s own rendering) to populate a missing
abstract — fired by `selectPaper` and by `loadFromText` for the landing paper, never by the PDF
toggle. A per-paper session marker (`screeningAbstractReads`: `'reading'` while in flight, `'none'`
once a read found nothing) stops a PDF with no recognisable abstract from being re-fetched on every
reselect, while a successful read leaves no entry — `paper.abstract` itself is the guard, so an
undo that removes the abstract lets re-selecting extract again. Staleness is keyed on
`projectGeneration` (bumped only when the open project is replaced or closed, never on an ordinary
edit), so a late result is still written after the reviewer moves on. The write deliberately pushes
no undo entry: a passive background fill must not make Ctrl+Z after a decision silently remove the
abstract instead.

### ScreeningPanel (right pane)

`src/components/ScreeningPanel.tsx` is the decision control, rendered by `App.tsx` instead of
`AnnotationPanel` whenever `project.screening` is set. It reuses the same withheld-form /
reviewer-badge / Consolidation-tools shapes `AnnotationPanel` established, but the body is the
two-button decision control rather than a rendered schema tree.

- Two buttons: **✓ Include** (shortcut `I`) and **✕ Exclude** (shortcut `E`). Pressing the active
  decision again clears it (toggles back to undecided via `setScreeningDecision(null)`). When
  undecided, a hint reads *"Not screened yet. Press I to include, E to exclude."*
- A **Reason** `ComboBox`, disabled unless the status is `excluded`. When disabled, a hint explains
  the `1`–`9` shortcuts exclude with that reason in one press. When excluded, the reason list is the
  project's `screening.reasons`. Both controls carry the AI-fill mark (`useAiMark`), so a proposal
  applied by the AI screen shows its light-blue border until the reviewer interacts with it.
- A **Summary** button opens the PRISMA-style counts modal. In the Consolidation seat, two more
  buttons appear on the same row: **⚖ Agreement** (inter-rater agreement on the include/exclude
  decision) and **⚠ Disagreements** (list every paper where reviewers disagree).
- A **pending-unanimous notice** appears only in the Consolidation seat when `pendingUnanimous > 0`,
  with an **Adopt all** button that calls `adoptAllUnanimousScreening`.
- A **progress line**: *"{included + excluded} of {total} screened — {included} included,
  {excluded} excluded, {undecided} left."*

The same withheld-form rule as `AnnotationPanel` applies: an edit made with no reviewer picked (in a
multi-reviewer project) would be unattributed, so the panel shows a "pick a reviewer" message
instead. The whole body is wrapped in a read-only fieldset, so `readOnly` disables every control.

### Paper list: tri-state marker and status filter

The paper list swaps its five-state completeness dot for a screening-specific marker
(`status-dot screening-<status>`) driven by `paperScreeningStatus` — a numbered reviewer's own
decision, or Consolidation's shipped result. Readiness (has every reviewer screened this yet?) moves
into the marker's tooltip rather than the marker itself, because with one decision per paper
"the final decision so far" is the more useful fact. `completenessApplies` returns false for a
screening project, so the "Annotation finished" checkbox, the completeness fill, and the annotation
state filter all step aside together. In their place the list shows a four-button segmented control
(All / Undecided / Included / Excluded) writing `screeningFilter`, and the header's progress line
reads *"N of M screened"*.

### ScreeningSummary (PRISMA counts modal)

`src/components/ScreeningSummary.tsx` is a modal following the `ValidationDialog` pattern
(`.modal-overlay` → `.modal` → `.modal-head` + `.modal-body`, Escape-to-close, backdrop click). It
shows the headline `total`/`included`/`excluded`/`undecided` numbers and a per-reason table (every
configured reason, plus a "no reason recorded / not one of the configured reasons" row for
`excludedWithoutReason` when non-zero). It labels which seat it is counting — "this project's
decisions" (single-reviewer), "Reviewer N's own decisions", "the consolidated result", or "no
reviewer (pick one above)".

### ScreeningImportDialog (pre-commit summary)

`src/components/ScreeningImportDialog.tsx` is shown after picking a screening project via "New from
screening…" or "Import from screening…", *before anything is written*. It renders a
`ScreeningImportDraft` held in the editor store:

- how many papers are included (always carried over), excluded (never carried over, with a per-reason
  breakdown), and not-screened-yet (carried over **by default** — dropping them would silently remove
  papers from a systematic review, which this dialog is what makes explicit rather than silent, with a
  "leave them out" escape hatch).
- when `reviewers > 1` and `pendingUnanimousCount > 0`, a notice that those not-yet-screened papers
  were decided the same way by every reviewer but Consolidation has not adopted them yet, advising
  the reviewer to open as Consolidation and use **Adopt all** first if they want them counted as
  included.
- for `target: 'start'`, a radio choosing whether the new project is an **annotation** project
  (extract data) or a **screening** project (screen again, e.g. on full text — gets its own
  exclusion-reason list seeded from the source's reasons and editable before save).

Three actions: **Cancel**, **Leave out the N not-screened-yet papers**, and **Import M papers** (the
included plus the undecided). `resolveScreeningImport('include-undecided' | 'skip-undecided' |
'cancel')` commits or aborts.

### ScreeningReasonsEditor

`src/components/ScreeningReasonsEditor.tsx` replaces `SchemaTreeEditor` in the project editor
whenever screening is on — there is no schema to build, only this short, ordered list of exclusion
reasons. The order matters: the reviewer's `1`–`9` keys exclude with the corresponding reason in one
press, so common reasons should be near the top.

- **Rename on blur**: if a committed rename moves away from a reason papers still record, the editor
  offers (via `window.confirm`) to carry those decisions to the new label by calling
  `migrateScreeningReason` (which uses `renameReasonInPapers`). An empty new label has nothing to
  migrate *to*, so it only warns (`window.alert`).
- **Remove**: removing a reason papers still record orphans those decisions the same way an empty
  rename does, so it warns the same way (no new label to migrate to — only remove-anyway vs keep).
- Add / move-up / move-down reorder the list.

## Decision writes and auto-advance

The store (`src/state/store.ts`) owns the decision writes, so the panel's buttons and the
keybindings cannot drift apart:

- `setScreeningDecision(decision, reason?)` — writes `Decision` and, in the same mutation, the
  `Reason`: clears it on any non-Exclude decision; writes the supplied reason when excluding with a
  reason (the `1`–`9` shortcuts pass it here so the exclusion and its reason are one undo step). A
  second call would land on whatever paper auto-advance just moved to, not this one, so both are
  written here. Reading whether the seat was undecided *before* mutating decides auto-advance. The
  write itself is refused in read-only mode and when a multi-reviewer project has no seat picked.
- **Auto-advance**: when the decision was undecided and the new decision is non-null, selection
  advances to the next undecided paper after the current one (stopping at the end rather than
  wrapping). This is the store's responsibility, so buttons and keystrokes agree. Because auto-advance
  routes through `selectPaper`, the abstract-extraction read fires for the paper it lands on too.
- `setScreeningReason(reason)` — only meaningful once the seat's own decision is Exclude; otherwise
  it is a no-op. Delegates to `setFieldValue` for the routing, coalescing, undo, and dirty-flagging
  it already does.
- `adoptAllUnanimousScreening()` — iterates every paper and calls `adoptUnanimousValues`, coalescing
  into one undo step, returning the count of papers filled. Synchronous (screening has no repeatable
  node, unlike the annotation path's `adoptAllUnanimousAnnotations`, which must align each paper
  before reading it and therefore yields between papers).

Keybindings (`src/hooks/useKeybindings.ts`) are bare letters/numbers only (a modifier means
something else) and never while typing in a field or while a modal is open (a DOM check for
`.modal-overlay`, `.error-overlay`, and `.menu` covers every dialog and open dropdown, so pressing
`3` inside the Help dialog can't silently exclude the hidden paper). `I`/`E`/`U` set
Include/Exclude/undecided; `1`–`9` exclude with the Nth configured reason (a digit past the end of
the list is left to the browser — there is no reason to write).

## On-disk layout

A screening project uses the same split storage as an annotation project (`project.json` meta plus a
per-paper `annotations/<paperId>/` folder, one file per reviewer plus a consolidated file), but with
a different prefix so the two kinds of per-paper data are distinguishable at a glance:

- reviewer files: `screening-<n>.json` (not `reviewer-<n>.json`)
- consolidated file: `screening-consolidated.json` (not `consolidated.json`)
- PDF-highlight files: `screening-marks-<n>.json` / `screening-marks-consolidated.json` (not
  `marks-<n>.json` / `marks-consolidated.json`)

`splitProjectFiles` picks the reviewer and consolidated names from `project.screening`, and
`marksFileName` the marks name from the same flag. `ownAnnotationPathMatcher`
(`src/git/ownAnnotationPath.ts`) builds its regex from the same flag (`screening` /
`screening-consolidated` / `screening-marks` versus `reviewer` / `consolidated` / `marks`), so a
screening project only claims `screening-*` files and vice versa. This is what lets a legitimate
screening-to-full-text sibling relationship keep working without the two projects' per-paper files
colliding, and `filesCollide` (`model/annotationsDir.ts`) reaches the same verdict: only a project
of the *same kind* that lists one of the same papers can collide.

Two compatibility notes keep older files readable:

- A screening project's highlight files from before they had their own name are still recognised by
  `parseMarksFileName` as `legacy`. Both read paths (`assembler` in `platform/assemble.ts`, which `assembleProject` in `platform/tauri.ts` wraps, and
  `projectFromFiles` in the model layer) process legacy files first so a file under the kind's own
  name wins; `assembleProject` additionally drops a legacy `marks-*.json` when an *annotation*
  sibling sharing the folder lists the same paper id, so the two kinds never fight over one file.
- The split-planning path (`model/annotationSplit.ts`) recognises both name families separately, so
  a shared folder can be split by kind as well as by paper id.

## Import flow and provenance

"New from screening…" (`startFromScreening`, on the start screen) and "Import from screening…"
(`importFromScreening`, in the papers editor of an open draft) both pick and parse a screening
project via `pickScreeningProject` (which refuses a project whose `screening` is null with a
"not a screening project" error), partition it, and set a `screeningImport` draft in the editor
store.

`partitionScreeningPapers` reads each paper's *consolidated* `annotations` tree (the one that ships,
in both single- and multi-reviewer cases — reading `reviews` here would import an individual
reviewer's opinion, not the project's result) and splits into:

- `included` — `Decision === 'Include'`, always carried.
- `undecided` — no decision (or an unrecognized one), carried unless the reviewer explicitly leaves
  them out.
- `excludedCount` / `excludedByReason` — never carried; the per-reason tally is shown for context.

`resolveScreeningImport` then writes the carried papers into either a new project (`target: 'start'`)
or the already-open session (`target: 'import'`, blocked when the open project is itself a screening
project — the two-pass workflow is served by `startFromScreening`'s independent second project, and
unblocking in-place import is a separate feature). Three properties of the write matter:

- **Sibling-location default.** For `target: 'start'` the suggested save location is a sibling of the
  screening JSON (`siblingProjectLocation`), named `<source>-annotation.json` for the annotation
  target or `<source>-fulltext.json` for a second screening pass — "-fulltext", not "-screening",
  because it names the workflow (the second pass *is* the full-text screen), not the data shape. A
  sibling shares the source's directory, so every carried paper's relative `pdf` still resolves
  without being rewritten; if the platform cannot offer a sibling the ordinary save dialog takes over.
  The new project also gets its *own* annotations folder (`defaultSplitDirName(location.name)`, e.g.
  `screening-annotations`), so it and the source never need telling apart even if a paper id they
  share is added later.
- **Absolute PDF sources.** Every carried row gets a real absolute `sourcePath` resolved from the
  screening file's directory, so a later "Change…" (which only re-derives `pdf` for rows with a
  `sourcePath`) still works. For `target: 'import'` the relative `pdf` is *rebased* against the
  already-open project's own location (the source's directory is irrelevant there); for
  `target: 'start'` it never rebases — the sibling default makes the verbatim path correct by
  construction.
- **Id dedup.** A `target: 'start'` project shares the source's directory and annotations folder,
  so a carried id equal to any source paper's id is renamed (`p1` → `p1-2`, then `p1-3`, …) rather
  than allowed to overwrite the source's recorded decision or marks. The import path into an open
  session instead skips papers already present (by DOI, then normalized title — passing the row's
  whole identity, so a merely same-titled paper is not silently dropped) and dedups ids against both
  the open project and the source.

For a second-screening target, the new project inherits the source's reviewer count (dual screening
is a PRISMA-reportable design property, and resetting it to 1 would silently turn dual screening
into single; the annotation target keeps its own default of 1) and seeds its reason list from the
source's own reasons — the pre-registered protocol's vocabulary — rather than the generic defaults.
Carried decisions are never carried: every row arrives `undecided`, so a full-text decision is not
anchored by the title/abstract one. `aiEnabled` starts false, like any new project.

The resulting project records a `ProjectProvenance` with `kind: 'screening-import'`, the source file
name (never its path — these files are committed to git and shared, and an absolute path would leak
the author's filesystem into every clone; the source's title when it had one), the import time, and
a `counts` snapshot (`included`/`undecided`/`excluded`/`carried`) — a snapshot, not a cache: screening
continues in the source after the import, so nothing there is derivable from either file later,
which is exactly why it is stored. `carried` is the number PRISMA's flow diagram wants, and the
census records the undecided papers it counts even when they were left out. Provenance is not part
of the undo snapshot, so undoing a later edit cannot take it away.

## Screening highlights carried into the next project

A screening project's PDF highlights do not stop mattering when the project is imported — they are
often the only record of *why* a screener excluded a paper. `src/model/screeningMarks.ts` collects
them for the importing project so its annotators can see what the screeners marked.

`screeningMarksByPaper(project, screening)` walks the new project's papers and, for each one, finds
its screening counterpart:

1. by the paper's own id, then by that id with a numeric suffix stripped (the id the import gave a
   paper whose id the screening project already used — `p1` → `p1-2`);
2. otherwise as the import itself matches duplicates: DOI, or title with authors and year
   (`classifyImport`, accepting only a *certain* existing-paper match).

The matched paper's marks are collected seat by seat — its consolidated `marks` first, then each
reviewer's `reviewMarks` in seat order — each tagged with its seat, so the consumer can say who made
it (`screeningSeatLabel`: "Screening, consolidated" / "Screening, Reviewer N"). Papers with no
counterpart or no marks are simply absent from the record.

The store picks these up on open: `loadScreeningMarks` runs after `openProject`/`openRecent`, and
only for a project whose `provenance.kind === 'screening-import'` and which is not itself a
screening project (and which has a saved path). It is cleared on `closeProject`/`loadFromText`, so a
project opened later never inherits another's highlights. The Rust side
(`project:screeningSource`) reads the source sibling named in the provenance *only* when it is a
plain `.json` file name — no path separators, no dotfile, not the project's own file, not a symlink
— and only for a project opened this session; the provenance is part of the file and therefore
untrusted input, so it never becomes a file-system probe. An unreadable or missing screening source
just leaves the highlights absent, never an error.

The annotation project then consumes them in two places: `AnnotationPanel` shows a "Show markings
from screening (N)" checkbox, but only on a paper the screening actually marked — an option with
nothing behind it would only puzzle — and `PdfViewer` renders the ticked marks as a read-only
overlay (no popover to open; dragging across one still selects text). The highlights are display
data only: nothing can edit them from the annotation project, since they live in the screening
project's own `screening-marks-*.json` files.

## Focused tests

- `src/screening/*.test.ts` — the pure core: derived schema shape and `isScreening`; tri-state
  status reads; `screeningCounts` totals, `byReason` coverage, and `excludedWithoutReason`;
  `pendingUnanimous` vs `pendingUnanimousDecisions`; the two validation rules and malformed-tree
  tolerance; reason counting/rewriting and identity preservation.
- `src/state/store.screening.test.ts` — the write surface: per-seat tree routing, one-undo-step
  decision+reason writes, the reason-clearing rule, auto-advance (including "never wraps" and
  "never on re-decide"), `setScreeningReason`'s no-op guard, `applyAiSuggestions` refusing a
  screening project, and `adoptAllUnanimousScreening`'s counts and single undo step.
- `src/state/store.screeningAbstract.test.ts` — `extractScreeningAbstract` firing on selection and
  project load (never on the PDF toggle), its guards, and the dirty/undo bookkeeping.
- `src/state/store.screeningMarks.test.ts` — highlights loaded by the importing project's paper ids,
  skipped when the project was not started from screening, absent when the source is gone.
- `src/state/editorStore.screening.test.ts` — the import flow end to end: partitioning (an
  unrecognized decision rides with undecided), the carried/dropped census, provenance, the
  annotation-vs-screening target's filename/reviewer-count/reason-seeding defaults, id dedup, and
  the `importFromScreening` pdf-rebase regression.
- `src/test/integration/screeningImport.integration.test.tsx` — the whole workflow against a real
  filesystem: real decisions through `ScreeningPanel`, then `startFromScreening` →
  `ScreeningImportDialog` → `resolveScreeningImport`, and a saved annotation project beside the
  screening JSON with its own annotations folder.
- `src/model/screeningMarks.test.ts` — counterpart matching by id, import-suffixed id, and DOI; and
  the seat ordering of collected marks.
- `src/components/AnnotationPanel.test.tsx` — the "Show markings from screening" checkbox appears
  only where there are marks behind it.
- `src/platform/tauri.test.ts` / `src/git/ownAnnotationPath.test.ts` / `src/model/annotationsDir.test.ts`
  — the `screening-*` name families on both sides of the read/write path.
