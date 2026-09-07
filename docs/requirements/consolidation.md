# Requirements — Multi-Reviewer Consolidation & Agreement

Requirements for reviewer seats, alignment of repeated entries, disagreement detection,
unanimous adoption, agreement metrics, and disagreement export. See the [index](index.md)
for the glossary.

---

### REQ-CON-10 — Isolate reviewer seats
- **Description:** When a numbered reviewer seat is active in a multi-reviewer project, the system shall write annotation edits only into that reviewer's own annotation tree, leaving other reviewers' trees and the consolidated tree unchanged.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reviewers.test.ts:149`, `src/components/ReviewerPrompt.tsx:50-54`
- **Status:** Implemented

### REQ-CON-20 — Mandatory seat selection
- **Description:** When a multi-reviewer project is opened without a stored seat choice, the system shall display a non-dismissable prompt requiring selection of a numbered reviewer or the Consolidation seat before any annotation input is accepted.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ReviewerPrompt.tsx:20-43`, `src/state/store.reviewers.test.ts:119-135`
- **Status:** Implemented

### REQ-CON-30 — Persist seat choice locally
- **Description:** The system shall persist the selected reviewer seat per project on the local machine, keyed by the project's file path, and shall not store the seat choice in the project file.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reviewers.test.ts:410-457`, `src/components/ReviewerPrompt.tsx:56-58`
- **Status:** Implemented

### REQ-CON-40 — Discard stale seat choices
- **Description:** When a stored seat number exceeds the project's current reviewer count, the system shall ignore the stored choice and prompt for a new seat selection.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reviewers.test.ts:410-457`
- **Status:** Implemented

### REQ-CON-50 — Seat switch outside undo history
- **Description:** When the reviewer seat changes, the system shall neither mark the project dirty nor record an undo step, and shall terminate undo coalescing so that a single undo cannot combine edits from different seats.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reviewers.test.ts:387-398,544-566`
- **Status:** Implemented

### REQ-CON-60 — Consolidation seat writes shipping tree
- **Description:** When the Consolidation seat is active, the system shall write edits into the consolidated annotation tree.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reviewers.test.ts:328`
- **Status:** Implemented

### REQ-CON-70 — Show per-paper readiness
- **Description:** The system shall present a paper as consolidation-ready only when every numbered reviewer has recorded at least one annotation on that paper, and shall display the count of ready papers on the Consolidation seat selector.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/readiness.ts:24-39`, `src/components/ReviewerPrompt.tsx:84-101`
- **Status:** Implemented

### REQ-CON-80 — Optimal matching of repeated entries
- **Description:** When aligning repeated schema entries recorded by different reviewers, the system shall match entries into shared slots using a maximum-total-weight assignment over pairwise similarity scores.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/align.ts:114-174`, `src/consolidate/assign.ts:24-50`
- **Status:** Implemented

### REQ-CON-90 — Hierarchical alignment
- **Description:** When aligning nested repeated groups, the system shall match child entries only within an already-matched parent slot, so that alignments never cross parent boundaries.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/align.ts:32-37,302-309`
- **Status:** Implemented

### REQ-CON-100 — Deterministic multi-reviewer alignment
- **Description:** When aligning entries from more than two reviewers, the system shall anchor slots on the reviewer with the most entries and fold in the remaining reviewers in a fixed order (entry count descending, then reviewer number), so that identical input always produces the identical alignment.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/align.ts:222-262`
- **Status:** Implemented

### REQ-CON-110 — Similarity threshold for merging
- **Description:** When two reviewers' entries have a similarity score of 0.5 or lower, the system shall place them in separate slots instead of merging them.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/align.ts:70-111,277-299` (`MIN_MATCH_SCORE`)
- **Status:** Implemented

### REQ-CON-120 — Persist only slot membership
- **Description:** When storing an alignment, the system shall persist only slot membership, and shall re-derive agreement and evidence scores on demand.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/apply.ts:20-38`
- **Status:** Implemented

### REQ-CON-130 — Grow-only consolidated tree on alignment
- **Description:** When applying an alignment, the system shall grow the consolidated tree to one entry per slot, bounded by the schema node's maximum cardinality, without deleting existing consolidated entries and without modifying any reviewer's tree.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/apply.ts:74-113`, `src/state/store.align.test.ts:124-302`
- **Status:** Implemented

### REQ-CON-140 — Alignment as single undo step
- **Description:** When an alignment run changes the project, the system shall mark the project dirty and record the run as exactly one undo entry; when the alignment is already current, the system shall record no undo entry.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.align.test.ts:144-219`
- **Status:** Implemented

### REQ-CON-150 — Freeze answered alignments
- **Description:** When the Consolidation seat has recorded any answer under a schema node for a paper, the system shall not re-match that node's alignment for that paper.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/readiness.ts:52-54`, `src/state/store.align.test.ts:228`
- **Status:** Implemented

### REQ-CON-160 — Widen frozen alignments for late reviewers
- **Description:** When a reviewer absent from every slot of a frozen node later records entries, the system shall fold that reviewer's entries into the existing slots by the standard matching rules without moving existing slot members.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/align.ts:427-563` (`widenAlignment`), `src/state/store.reviewers.test.ts:305`
- **Status:** Implemented

### REQ-CON-170 — Evidence-weighted similarity
- **Description:** When comparing two entries, the system shall compute a similarity score weighted by the number of comparable answered fields, where fields left blank by either side contribute no weight.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/similarity.ts:18-53`
- **Status:** Implemented

### REQ-CON-180 — Type-aware value comparison
- **Description:** When comparing field values, the system shall compare free text by the maximum of a Levenshtein ratio and a token Dice coefficient after normalization, enum labels by exact normalized equality, years by exact equality, numbers by relative closeness, and boolean pairs only when at least one side is true.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/similarity.ts:63-116,230-264`
- **Status:** Implemented

### REQ-CON-190 — Detect field disagreements over the alignment
- **Description:** When computing per-field verdicts for a paper, the system shall compare reviewer answers through the stored alignment so that the same slot index refers to the same matched entry across reviewers.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/disagreements.ts:19-131`
- **Status:** Implemented

### REQ-CON-200 — Normalize answers for agreement
- **Description:** When deciding whether reviewer answers agree, the system shall compare values after trimming, lowercasing, and collapsing whitespace, so that case and whitespace differences do not count as disagreement.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/disagreements.ts:72-79,199-210`, commit `88b0394`
- **Status:** Implemented

### REQ-CON-210 — Ignore skeleton boolean answers
- **Description:** When counting boolean answers, the system shall count a `false` value as an answer only from a reviewer who has recorded at least one annotation on that paper.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/disagreements.ts:119-121,186-198`, commit `60c9d48`
- **Status:** Implemented

### REQ-CON-220 — Flag one-sided entries
- **Description:** When a repeated entry was recorded by only some of two or more participating reviewers, the system shall flag its fields as one-sided disagreements while excluding them from the agreement statistics.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/disagreements.ts:44-53,148-179`, commits `5927055`, `137ab4a`
- **Status:** Implemented

### REQ-CON-230 — Single field-status rule
- **Description:** The system shall classify each field for a paper as `agree` (all configured reviewers answered identically), `disagree` (one-sided with an answer, conflicting answers, or answered-versus-blank), or unclassified, and shall use this classification consistently for field border colors, both overview dialogs, and the disagreement export filter.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ConsolidationVerdicts.ts:21-43`, `src/components/DisagreementOverview.tsx:47-60`
- **Status:** Implemented

### REQ-CON-240 — Auto-fill unanimous values
- **Description:** When running unanimous adoption, the system shall fill a consolidated field only when at least two reviewers exist, every reviewer answered that field, and all answers are equal after normalization, writing the lowest-numbered reviewer's trimmed wording into fields the consolidator has not answered.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/unanimous.ts:54-135`, `src/state/store.align.test.ts:361-426`
- **Status:** Implemented

### REQ-CON-250 — Mark auto-filled values
- **Description:** When a consolidated field is filled by unanimous adoption, the system shall mark the field with the machine-fill marker so that its origin is visible.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/unanimous.ts:15-18`, `src/state/store.batch-unanimous.test.ts:297`
- **Status:** Implemented

### REQ-CON-260 — Batch unanimous adoption
- **Description:** When "Adopt all unanimous" is triggered, the system shall process the whole project paper by paper, aligning then adopting per paper, skipping papers whose alignable nodes the consolidator already answered, recording the whole run as one undo entry, reporting live progress, refusing a second concurrent run, and stopping on project close or undo.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.batch-unanimous.test.ts:169-412`, `src/components/ConsolidationOverview.tsx:113-143`
- **Status:** Implemented

### REQ-CON-270 — Compute Cohen's kappa
- **Description:** When exactly two reviewers have co-rated at least two units, the system shall compute Cohen's kappa over the co-rated units with marginals restricted to those units.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/metrics.ts:95-163`
- **Status:** Implemented

### REQ-CON-280 — Compute Fleiss' kappa
- **Description:** When two or more reviewers have each rated every unit and at least two units exist, the system shall compute Fleiss' kappa; otherwise the system shall report the metric as inapplicable with a reason.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/metrics.ts:181-269`
- **Status:** Implemented

### REQ-CON-290 — Compute Krippendorff's alpha
- **Description:** When two or more reviewers and at least two pairable units exist, the system shall compute nominal Krippendorff's alpha via a coincidence matrix, tolerating missing ratings and skipping units with fewer than two ratings.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/metrics.ts:282-388`
- **Status:** Implemented

### REQ-CON-300 — Report degenerate metric cases
- **Description:** When all ratings fall in a single category so that chance agreement equals one, the system shall report each affected coefficient as undefined with an explanatory note instead of a numeric value.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/metrics.ts:63-83,150-153,250-252,371-373`
- **Status:** Implemented

### REQ-CON-310 — Per-field agreement breakdown
- **Description:** When displaying agreement, the system shall additionally report each coefficient per schema field, pooling repeated instances within a field and preserving schema order, with the table copyable as tab-separated values.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/agreement.ts:18-40,100-105`, `src/components/AgreementDialog.tsx:44-56,246-304`
- **Status:** Implemented

### REQ-CON-320 — Screening agreement on decision only
- **Description:** When computing agreement for a screening project, the system shall include only the include/exclude decision and shall exclude the exclusion-reason field from the unit set.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/agreement.ts:71-80`
- **Status:** Implemented

### REQ-CON-330 — Warn on unaligned papers in agreement
- **Description:** When at least one paper needs alignment, the system shall display a warning in the Agreement dialog with an action that runs the batch alignment/adoption before the statistics are relied on.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AgreementDialog.tsx:94-235`, `src/consolidate/readiness.ts:79-100`
- **Status:** Implemented

### REQ-CON-340 — Side-by-side answer comparison
- **Description:** When a compared field is opened from the disagreement overview, the system shall display every reviewer's answer for the aligned entry side by side with an agree/disagree badge.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ConsolidationDialog.tsx:116-134`
- **Status:** Implemented

### REQ-CON-350 — Adopt a reviewer's answer
- **Description:** When the consolidator selects a reviewer's answer in the comparison view, the system shall write that value into the consolidated tree as one undo step.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ConsolidationDialog.tsx:157-248`
- **Status:** Implemented

### REQ-CON-360 — Mark answers as equivalent
- **Description:** When at least two differing answers exist for a non-decision field, the system shall offer a per-field equivalence mark that causes the differing answers to count as agreement.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ConsolidationDialog.tsx:136-150`, `src/state/store.reviewers.test.ts:347-376`
- **Status:** Implemented

### REQ-CON-370 — Guard stranded equivalence marks
- **Description:** When the comparison view is closed while a field is marked equivalent but has no consolidated value, the system shall require either entering a value or explicitly closing with the mark removed.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ConsolidationDialog.tsx:27-33,97-110,251-268`, commit `01cb118`
- **Status:** Implemented

### REQ-CON-380 — Export disagreements per paper
- **Description:** When a paper's disagreements are exported, the system shall produce text containing the paper identifier, authors, title, and for each disagreeing field its display path and each answering reviewer's formatted value.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/exportDisagreements.ts:13-34`
- **Status:** Implemented

### REQ-CON-390 — Export disagreements project-wide
- **Description:** When the project-wide disagreement export is triggered, the system shall concatenate, in paper order, the per-paper export text of every paper with at least one disagreement, offering the result via clipboard copy or a text-file save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/consolidate/exportDisagreements.ts:36-51`, `src/components/ConsolidationOverview.tsx:86-89`, commit `9125ee0`
- **Status:** Implemented

### REQ-CON-400 — Disable AI suggestions for Consolidation seat
- **Description:** When the Consolidation seat is active, the system shall disable the AI-suggestion feature while keeping it available to numbered reviewer seats.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.align.test.ts:442-464`
- **Status:** Implemented
