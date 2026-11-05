# Requirements: Screening

Requirements for the title/abstract and full-text screening workflow. See the
[index](../requirements/index.md) for the glossary (project, seat, reviewer, consolidated tree, undo step).

---

### REQ-SCR-10: Identify screening projects by configuration
`req~scr-10~1`

When a project's configuration contains a `screening` object with a list of exclusion reasons, the system shall treat the project as a screening project.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts` (`isScreening`), `src/screening/schema.test.ts` ("is true when config.screening is set")
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-20: Derive fixed screening schema
`req~scr-20~1`

When loading a screening project, the system shall derive the annotation schema as exactly two string fields in order: `Decision` (enum with options `Include` and `Exclude`) and `Reason` (enum with the configured exclusion reasons as options), ignoring any authored schema in the file.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts:32-72`, `src/screening/schema.test.ts` ("derives exactly Decision and Reason, in that order")
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-30: Seed default exclusion reasons
`req~scr-30~1`

When creating a new screening project, the system shall seed the exclusion-reason list with eight default reasons including an "Other" entry.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/schema.ts:38-47`, `src/screening/schema.test.ts:79`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-40: Normalize reasons on load
`req~scr-40~1`

When loading a screening project, the system shall trim whitespace from each exclusion reason, drop blank entries, and remove duplicate entries.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`parseScreening`), `openwiki/workflows/screening.md` ("Derived schema")
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-50: Reject screening projects without reasons
`req~scr-50~1`

When a screening project's exclusion-reason list is empty after normalization, the system shall reject the project at load with a project-load error.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`parseScreening`), `src/state/editorStore.screening.test.ts:128`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-60: Tri-state screening status
`req~scr-60~1`

The system shall classify each paper's screening status per seat as exactly one of `included`, `excluded`, or `undecided`, where a missing, malformed, or unrecognized decision value is classified as `undecided`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/status.ts:15-20`, `src/screening/status.test.ts:26-34`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-70: Record screening decision per seat
`req~scr-70~1`

When a reviewer seat is active, the system shall record a screening decision into that seat's annotation tree (the consolidated tree for single-reviewer projects or the Consolidation seat, the numbered reviewer's tree otherwise).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`setScreeningDecision` describe block)
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-80: Refuse decisions without a seat
`req~scr-80~1`

When a multi-reviewer screening project has no reviewer seat selected, the system shall reject decision input and display a prompt to pick a reviewer instead of the decision controls.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:40-49`, `src/state/store.screening.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-90: Clear reason when decision leaves Exclude
`req~scr-90~1`

When a paper's decision changes from `Exclude` to any other state, the system shall clear the recorded exclusion reason within the same undo step.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("clears the reason in the same undo step")
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-100: Exclude-with-reason as single undo step
`req~scr-100~1`

When a decision and an exclusion reason are entered in one action, the system shall record both as a single undo step.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("writes decision and reason together in one undo step")
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-110: Auto-advance after deciding
`req~scr-110~1`

When a paper transitions from `undecided` to a decided status, the system shall move the paper selection to the next undecided paper in list order without wrapping past the last paper.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("advances to the next undecided paper", "stops at the last paper rather than wrapping")
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-120: Toggle decision back to undecided
`req~scr-120~1`

When the currently active decision button is activated again, the system shall reset the paper's decision to `undecided`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx` (`decide()`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-130: Restrict reason entry to excluded papers
`req~scr-130~1`

The system shall accept an exclusion reason only for a paper whose current decision is `Exclude`, and shall present the reason input as disabled otherwise.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`setScreeningReason` describe block), `src/components/ScreeningPanel.tsx`, attribute `disabled={status !== 'excluded'}`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-140: Screening keyboard shortcuts
`req~scr-140~1`

When no text input is focused and no modal dialog is open, the system shall map the key `I` to Include, `E` to Exclude, `U` to clear to undecided, and the keys `1` through `9` to Exclude with the corresponding configured exclusion reason in a single keypress.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useKeybindings.ts`, `openwiki/workflows/screening.md` ("Decision writes and auto-advance")
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-150: Reject AI suggestions in screening projects
`req~scr-150~1`

When a project is a screening project, the system shall reject the application of AI annotation suggestions without modifying any data.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` ("refuses and fills nothing")
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-160: Adopt unanimous screening values
`req~scr-160~1`

When the Consolidation seat triggers "Adopt all", the system shall copy, for every paper, each value (decision or reason) that all numbered reviewers recorded identically into the consolidated tree as one undo step, skipping papers with reviewer disagreement and papers the Consolidation seat already answered.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screening.test.ts` (`adoptAllUnanimousScreening` describe block)
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-170: Pending-unanimous notice
`req~scr-170~1`

When the Consolidation seat is active and at least one unanimous reviewer value is not yet adopted, the system shall display a notice with the count and an "Adopt all" action.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:118-128`, `src/screening/counts.ts:97-121`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-180: Per-seat screening counts
`req~scr-180~1`

The system shall compute the counts of total, included, excluded, and undecided papers over the annotation tree of the currently active seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:14-88`, `src/screening/counts.test.ts:96` ("counts differ per seat")
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-190: Report all configured reasons in the summary
`req~scr-190~1`

When computing the per-reason exclusion tally, the system shall include every configured exclusion reason as a distinct entry, including reasons with a count of zero.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:31-36`, `src/screening/counts.test.ts:74`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-200: Separate bucket for unknown reasons
`req~scr-200~1`

When an excluded paper records a blank or unconfigured exclusion reason, the system shall count that paper in a dedicated "excluded without reason" bucket rather than under any configured reason.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/counts.ts:37-58`, `src/screening/counts.test.ts:82-91`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-210: Screening summary display
`req~scr-210~1`

When the screening summary is opened, the system shall display the four headline counts (total, included, excluded, undecided), a per-reason table, an "unknown reason" row when its count is non-zero, and the name of the seat being counted.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningSummary.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-220: Live progress line
`req~scr-220~1`

The system shall display in the screening panel a live progress line stating the number of screened papers out of the total, plus included, excluded, and remaining counts.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningPanel.tsx:171-176`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-230: Validate excluded-without-reason
`req~scr-230~1`

When validation runs on a screening project, the system shall report an issue for each seat's paper that is excluded without a recorded exclusion reason.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/validate.ts:27-61`, `src/screening/validate.test.ts:54`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-240: Validate reason-without-exclusion
`req~scr-240~1`

When validation runs on a screening project, the system shall report an issue for each seat's paper that records an exclusion reason while its decision is not `Exclude`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/screening/validate.ts:27-61`, `src/screening/validate.test.ts:61`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-250: Manage exclusion reasons as ordered list
`req~scr-250~1`

The system shall provide editing of the exclusion-reason list as an ordered flat list with add, remove, move-up, and move-down operations.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-260: Migrate papers on reason rename
`req~scr-260~1`

When an exclusion reason that is recorded by at least one paper is renamed, the system shall offer to rewrite the affected papers' recorded reason to the new label, and shall leave the recorded reasons unchanged when the offer is declined.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx:39-67`, `src/screening/reasonUsage.ts:78-119`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-270: Confirm reason removal in use
`req~scr-270~1`

When an exclusion reason that is recorded by at least one paper is removed, the system shall request confirmation stating that affected papers keep their excluded state but lose the reason.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningReasonsEditor.tsx:69-88`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-280: Abstract-based screening view
`req~scr-280~1`

When a screening project is open, the system shall display for the selected paper a record view with title, authors, venue, year, DOI, and abstract in place of the PDF viewer, with an action to switch to the PDF viewer when the paper has a PDF path.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningRecord.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-290: Auto-extract missing abstracts
`req~scr-290~1`

When a paper without an abstract but with a PDF path is selected in a screening project, the system shall attempt to extract the abstract from the PDF and, on success, store it with a marker that it was extracted from the PDF.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screeningAbstract.test.ts` ("extraction fires on selection, not on opening the PDF")
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-300: Caution notice for extracted abstracts
`req~scr-300~1`

When a displayed abstract was extracted from a PDF, the system shall display a notice stating that the abstract may be incomplete or wrong.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningRecord.tsx:44-49`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-310: Never overwrite manual abstracts
`req~scr-310~1`

When an abstract extraction completes after the reviewer has entered an abstract manually for the same paper, the system shall discard the extraction result.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.screeningAbstract.test.ts`, race-safety tests
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-320: Import screening results into a new project
`req~scr-320~1`

When a screening project file is selected as an import source, the system shall carry included papers, never carry excluded papers, and carry undecided papers unless the reviewer explicitly chooses to leave them out, based on the source's consolidated tree.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ScreeningImportDialog.tsx`, `src/state/editorStore.screening.test.ts:196-226`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-SCR-330: Reject non-screening import sources
`req~scr-330~1`

When the file selected for a screening import is not a screening project, the system shall reject the import with an error message.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:233`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-340: Strip decisions on carry-over
`req~scr-340~1`

When carrying papers from a screening import, the system shall retain paper metadata (title, authors, DOI, abstract, PDF path) and shall discard annotations, per-reviewer trees, equal-marks, and AI-usage records.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:196,328,382`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-350: Choose target project kind on import
`req~scr-350~1`

When starting a new project from a screening import, the system shall offer a choice between an annotation project (default) and a second screening project whose reason list is seeded from the source's reasons.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:244-264`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-360: Record import provenance
`req~scr-360~1`

When a project is created from a screening import, the system shall record provenance containing the source file name, the import timestamp, and the counts of included, undecided, excluded, and carried papers, and this record shall persist through save and load.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:336-423`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-370: Prevent paper-ID collisions on import
`req~scr-370~1`

When assigning identifiers to carried papers, the system shall not reuse any paper identifier present in the source project.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.screening.test.ts:525`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-SCR-380: Distinct screening annotation file prefix
`req~scr-380~1`

The system shall store screening projects' per-paper annotation files under the prefixes `screening-<n>.json` and `screening-consolidated.json`, distinct from annotation projects' `reviewer-<n>.json` and `consolidated.json`, so both project kinds can share one directory.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/git/ownAnnotationPath.ts`, commit `c4d8e7d`, `openwiki/workflows/screening.md` ("On-disk layout")
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-SCR-390: AI-assisted screening
`req~scr-390~1`

The system shall let a reviewer (or the project's AI seat) ask an LLM for Include/Exclude proposals with a reason, reviewed and applied by a human, as specified in REQ-LLM-630, REQ-LLM-640 and REQ-LLM-650. Proposals only ever fill undecided papers.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiScreeningStore.ts`, `src/components/AiScreeningDialog.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability
