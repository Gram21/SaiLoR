# Requirements — Screening

Requirements for the title/abstract and full-text screening workflow. See the
[index](index.md) for the glossary (project, seat, reviewer, consolidated tree, undo step).

---

### REQ-SCR-10 — Identify screening projects by configuration
- **Description:** When a project's configuration contains a `screening` object with a list of exclusion reasons, the system shall treat the project as a screening project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts` (`isScreening`), `src/screening/schema.test.ts` ("is true when config.screening is set")
- **Status:** Implemented

### REQ-SCR-20 — Derive fixed screening schema
- **Description:** When loading a screening project, the system shall derive the annotation schema as exactly two string fields in order: `Decision` (enum with options `Include` and `Exclude`) and `Reason` (enum with the configured exclusion reasons as options), ignoring any authored schema in the file.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts:32-72`, `src/screening/schema.test.ts` ("derives exactly Decision and Reason, in that order")
- **Status:** Implemented

### REQ-SCR-30 — Seed default exclusion reasons
- **Description:** When creating a new screening project, the system shall seed the exclusion-reason list with eight default reasons including an "Other" entry.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts:38-47`, `src/screening/schema.test.ts:79`
- **Status:** Implemented

### REQ-SCR-40 — Normalize reasons on load
- **Description:** When loading a screening project, the system shall trim whitespace from each exclusion reason, drop blank entries, and remove duplicate entries.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`parseScreening`), `openwiki/workflows/screening.md` ("Derived schema")
- **Status:** Implemented

### REQ-SCR-50 — Reject screening projects without reasons
- **Description:** When a screening project's exclusion-reason list is empty after normalization, the system shall reject the project at load with a project-load error.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`parseScreening`), `src/state/editorStore.screening.test.ts:128`
- **Status:** Implemented

### REQ-SCR-60 — Tri-state screening status
- **Description:** The system shall classify each paper's screening status per seat as exactly one of `included`, `excluded`, or `undecided`, where a missing, malformed, or unrecognized decision value is classified as `undecided`.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/status.ts:15-20`, `src/screening/status.test.ts:26-34`
- **Status:** Implemented

### REQ-SCR-70 — Record screening decision per seat
- **Description:** When a reviewer seat is active, the system shall record a screening decision into that seat's annotation tree (the consolidated tree for single-reviewer projects or the Consolidation seat, the numbered reviewer's tree otherwise).
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`setScreeningDecision` describe block)
- **Status:** Implemented

### REQ-SCR-80 — Refuse decisions without a seat
- **Description:** When a multi-reviewer screening project has no reviewer seat selected, the system shall reject decision input and display a prompt to pick a reviewer instead of the decision controls.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:40-49`, `src/state/store.screening.test.ts`
- **Status:** Implemented

### REQ-SCR-90 — Clear reason when decision leaves Exclude
- **Description:** When a paper's decision changes from `Exclude` to any other state, the system shall clear the recorded exclusion reason within the same undo step.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("clears the reason in the same undo step")
- **Status:** Implemented

### REQ-SCR-100 — Exclude-with-reason as single undo step
- **Description:** When a decision and an exclusion reason are entered in one action, the system shall record both as a single undo step.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("writes decision and reason together in one undo step")
- **Status:** Implemented

### REQ-SCR-110 — Auto-advance after deciding
- **Description:** When a paper transitions from `undecided` to a decided status, the system shall move the paper selection to the next undecided paper in list order without wrapping past the last paper.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("advances to the next undecided paper", "stops at the last paper rather than wrapping")
- **Status:** Implemented

### REQ-SCR-120 — Toggle decision back to undecided
- **Description:** When the currently active decision button is activated again, the system shall reset the paper's decision to `undecided`.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx` (`decide()`)
- **Status:** Implemented

### REQ-SCR-130 — Restrict reason entry to excluded papers
- **Description:** The system shall accept an exclusion reason only for a paper whose current decision is `Exclude`, and shall present the reason input as disabled otherwise.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`setScreeningReason` describe block), `src/components/ScreeningPanel.tsx` (`disabled={status !== 'excluded'}`)
- **Status:** Implemented

### REQ-SCR-140 — Screening keyboard shortcuts
- **Description:** When no text input is focused and no modal dialog is open, the system shall map the key `I` to Include, `E` to Exclude, `U` to clear to undecided, and the keys `1` through `9` to Exclude with the corresponding configured exclusion reason in a single keypress.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useKeybindings.ts`, `openwiki/workflows/screening.md` ("Decision writes and auto-advance")
- **Status:** Implemented

### REQ-SCR-150 — Reject AI suggestions in screening projects
- **Description:** When a project is a screening project, the system shall reject the application of AI annotation suggestions without modifying any data.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("refuses and fills nothing")
- **Status:** Implemented

### REQ-SCR-160 — Adopt unanimous screening values
- **Description:** When the Consolidation seat triggers "Adopt all", the system shall copy, for every paper, each value (decision or reason) that all numbered reviewers recorded identically into the consolidated tree as one undo step, skipping papers with reviewer disagreement and papers the Consolidation seat already answered.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`adoptAllUnanimousScreening` describe block)
- **Status:** Implemented

### REQ-SCR-170 — Pending-unanimous notice
- **Description:** When the Consolidation seat is active and at least one unanimous reviewer value is not yet adopted, the system shall display a notice with the count and an "Adopt all" action.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:118-128`, `src/screening/counts.ts:97-121`
- **Status:** Implemented

### REQ-SCR-180 — Per-seat screening counts
- **Description:** The system shall compute the counts of total, included, excluded, and undecided papers over the annotation tree of the currently active seat.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:14-88`, `src/screening/counts.test.ts:96` ("counts differ per seat")
- **Status:** Implemented

### REQ-SCR-190 — Report all configured reasons in the summary
- **Description:** When computing the per-reason exclusion tally, the system shall include every configured exclusion reason as a distinct entry, including reasons with a count of zero.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:31-36`, `src/screening/counts.test.ts:74`
- **Status:** Implemented

### REQ-SCR-200 — Separate bucket for unknown reasons
- **Description:** When an excluded paper records a blank or unconfigured exclusion reason, the system shall count that paper in a dedicated "excluded without reason" bucket rather than under any configured reason.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:37-58`, `src/screening/counts.test.ts:82-91`
- **Status:** Implemented

### REQ-SCR-210 — Screening summary display
- **Description:** When the screening summary is opened, the system shall display the four headline counts (total, included, excluded, undecided), a per-reason table, an "unknown reason" row when its count is non-zero, and the name of the seat being counted.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningSummary.tsx`
- **Status:** Implemented

### REQ-SCR-220 — Live progress line
- **Description:** The system shall display in the screening panel a live progress line stating the number of screened papers out of the total, plus included, excluded, and remaining counts.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:171-176`
- **Status:** Implemented

### REQ-SCR-230 — Validate excluded-without-reason
- **Description:** When validation runs on a screening project, the system shall report an issue for each seat's paper that is excluded without a recorded exclusion reason.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/validate.ts:27-61`, `src/screening/validate.test.ts:54`
- **Status:** Implemented

### REQ-SCR-240 — Validate reason-without-exclusion
- **Description:** When validation runs on a screening project, the system shall report an issue for each seat's paper that records an exclusion reason while its decision is not `Exclude`.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/validate.ts:27-61`, `src/screening/validate.test.ts:61`
- **Status:** Implemented

### REQ-SCR-250 — Manage exclusion reasons as ordered list
- **Description:** The system shall provide editing of the exclusion-reason list as an ordered flat list with add, remove, move-up, and move-down operations.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx`
- **Status:** Implemented

### REQ-SCR-260 — Migrate papers on reason rename
- **Description:** When an exclusion reason that is recorded by at least one paper is renamed, the system shall offer to rewrite the affected papers' recorded reason to the new label, and shall leave the recorded reasons unchanged when the offer is declined.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx:39-67`, `src/screening/reasonUsage.ts:78-119`
- **Status:** Implemented

### REQ-SCR-270 — Confirm reason removal in use
- **Description:** When an exclusion reason that is recorded by at least one paper is removed, the system shall request confirmation stating that affected papers keep their excluded state but lose the reason.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx:69-88`
- **Status:** Implemented

### REQ-SCR-280 — Abstract-based screening view
- **Description:** When a screening project is open, the system shall display for the selected paper a record view with title, authors, venue, year, DOI, and abstract in place of the PDF viewer, with an action to switch to the PDF viewer when the paper has a PDF path.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningRecord.tsx`
- **Status:** Implemented

### REQ-SCR-290 — Auto-extract missing abstracts
- **Description:** When a paper without an abstract but with a PDF path is selected in a screening project, the system shall attempt to extract the abstract from the PDF and, on success, store it with a marker that it was extracted from the PDF.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screeningAbstract.test.ts` ("extraction fires on selection, not on opening the PDF")
- **Status:** Implemented

### REQ-SCR-300 — Caution notice for extracted abstracts
- **Description:** When a displayed abstract was extracted from a PDF, the system shall display a notice stating that the abstract may be incomplete or wrong.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningRecord.tsx:44-49`
- **Status:** Implemented

### REQ-SCR-310 — Never overwrite manual abstracts
- **Description:** When an abstract extraction completes after the reviewer has entered an abstract manually for the same paper, the system shall discard the extraction result.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screeningAbstract.test.ts` (race-safety tests)
- **Status:** Implemented

### REQ-SCR-320 — Import screening results into a new project
- **Description:** When a screening project file is selected as an import source, the system shall carry included papers, never carry excluded papers, and carry undecided papers unless the reviewer explicitly chooses to leave them out, based on the source's consolidated tree.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningImportDialog.tsx`, `src/state/editorStore.screening.test.ts:196-226`
- **Status:** Implemented

### REQ-SCR-330 — Reject non-screening import sources
- **Description:** When the file selected for a screening import is not a screening project, the system shall reject the import with an error message.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:233`
- **Status:** Implemented

### REQ-SCR-340 — Strip decisions on carry-over
- **Description:** When carrying papers from a screening import, the system shall retain paper metadata (title, authors, DOI, abstract, PDF path) and shall discard annotations, per-reviewer trees, equal-marks, and AI-usage records.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:196,328,382`
- **Status:** Implemented

### REQ-SCR-350 — Choose target project kind on import
- **Description:** When starting a new project from a screening import, the system shall offer a choice between an annotation project (default) and a second screening project whose reason list is seeded from the source's reasons.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:244-264`
- **Status:** Implemented

### REQ-SCR-360 — Record import provenance
- **Description:** When a project is created from a screening import, the system shall record provenance containing the source file name, the import timestamp, and the counts of included, undecided, excluded, and carried papers, and this record shall persist through save and load.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:336-423`
- **Status:** Implemented

### REQ-SCR-370 — Prevent paper-ID collisions on import
- **Description:** When assigning identifiers to carried papers, the system shall not reuse any paper identifier present in the source project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:525`
- **Status:** Implemented

### REQ-SCR-380 — Distinct screening annotation file prefix
- **Description:** The system shall store screening projects' per-paper annotation files under the prefixes `screening-<n>.json` and `screening-consolidated.json`, distinct from annotation projects' `reviewer-<n>.json` and `consolidated.json`, so both project kinds can share one directory.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/ownAnnotationPath.ts`, commit `c4d8e7d`, `openwiki/workflows/screening.md` ("On-disk layout")
- **Status:** Implemented
