# Requirements ↔ Code Traceability Matrix

Traceability link recovery for all requirements in this folder, produced during the
same reverse-engineering pass that authored them (2026-08-27, source state of SaiLoR
v1.8.1, main at `2c4f30e`). Links point from each requirement to the artifacts that
realize and verify it.

## How the links were recovered

The requirements were reverse-engineered bottom-up, so every link below is a
*recovered* trace, not an authored one. Four recovery techniques were used, in
descending order of evidential weight:

1. **Test-to-requirement mining** — unit/integration/e2e test names and assertions
   were read as executable specifications (e.g. `store.screening.test.ts`
   "clears the reason in the same undo step" ⇒ REQ-SCR-90). Where a test pins the
   behavior, it appears in the *Verified by* column; these are the strongest links.
2. **Static source inspection** — the implementing modules, components, and Electron
   main-process handlers were read directly; file-and-line references were captured
   at reading time. These populate the *Implemented in* column.
3. **Commit-history mining** — `git log` was searched for the feature/fix commits
   that introduced or pinned a behavior; hashes appear in the *History* column and
   date the requirement's origin.
4. **Documentation cross-checking** — README, `docs/annotation-schema.md`, and the
   `openwiki/` developer wiki (itself source-verified 2026-08-26) were used to
   confirm intent where code alone was ambiguous; they appear in the *Docs* column.

Line numbers are a snapshot of the analyzed revision and will drift; module paths
and test names are the durable part of each link. A requirement with an empty
*Verified by* cell has no automated check — behavior was confirmed by source
inspection only.

## Link semantics

| Column | Meaning |
|---|---|
| **Implemented in** | Source artifacts realizing the behavior (renderer `src/`, main process `electron/`, build `scripts/`, config) |
| **Verified by** | Tests exercising the behavior (Vitest unit/integration, Playwright e2e) |
| **History** | Commits that introduced or pinned the behavior |
| **Docs** | Human-written documentation asserting the behavior |


## Data model & project editor ([data-model.md](data-model.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-DAT-10 | Reject invalid JSON with a message | `src/model/project.ts:663-670` | — | — | — |
| REQ-DAT-20 | Bound input nesting depth | `src/model/project.ts:646-706` | `src/model/hostile.test.ts:33-50` | commit `07f1244` | — |
| REQ-DAT-30 | Report structural errors per path | `src/model/project.ts:693-699` | — | — | — |
| REQ-DAT-40 | Preserve unknown keys | `src/model/schema.ts:195-227`<br>`src/model/project.ts:304-336, 760,868` | — | — | — |
| REQ-DAT-50 | Reject duplicate paper identifiers | `src/model/project.ts:729-735` | — | — | — |
| REQ-DAT-60 | Require paper identity and PDF | `src/model/schema.ts:126-173,241-251` | `src/model/model.test.ts:854` | — | — |
| REQ-DAT-70 | Repair year values structurally | `src/model/year.ts:18-50` | `src/model/year.test.ts` | — | — |
| REQ-DAT-80 | Degrade malformed sub-records without failing | `src/model/project.ts:347-571` | `src/model/model.test.ts:525, 777-789, 1015,1117-1146` | — | — |
| REQ-DAT-90 | Round-trip hostile values safely | — | `src/model/jsonvalues.test.ts:44-83` | commit `6933376` | — |
| REQ-DAT-100 | Mark PDF-extracted abstracts | `src/model/project.ts:745-748,828` | `src/model/model.test.ts:902-940` | — | — |
| REQ-DAT-110 | Schema node structure | `src/model/schema.ts:24-124` | `src/model/model.test.ts:58-144` | — | — |
| REQ-DAT-120 | Unique sibling names | `src/model/schema.ts:296-327` | `src/model/model.test.ts:64` | — | — |
| REQ-DAT-130 | Drop required on booleans | `src/model/schema.ts:340-345` | `src/model/model.test.ts:130` | — | — |
| REQ-DAT-140 | Restrict visibleIf targets | `src/model/schema.ts:346-363` | `src/model/model.test.ts:165-235` | — | — |
| REQ-DAT-150 | Bound schema instance fan-out | `src/model/schema.ts:376-420` | `src/model/hostile.test.ts:18-67` | — | — |
| REQ-DAT-160 | Normalize trees on load | `src/model/annotations.ts:64-124` | `src/model/model.test.ts:1221` | commit `b12f654` | — |
| REQ-DAT-170 | Prune only trailing empties on save | `src/model/annotations.ts:136-162`<br>`src/model/project.ts:877-879` | `src/model/model.test.ts:401,678` | — | — |
| REQ-DAT-180 | Total, non-throwing validation | `src/model/validate.ts:14-40,318-337` | — | — | — |
| REQ-DAT-190 | Required, type, enum, and cardinality checks | `src/model/validate.ts:57-243` | `src/model/validate.test.ts:116-128` | — | — |
| REQ-DAT-200 | Skip hidden fields in validation | `src/model/validate.ts:206-272` | `src/model/validate.test.ts:137-192` | — | — |
| REQ-DAT-210 | Separate unannotated papers | `src/model/validate.ts:300-340`<br>`src/components/ValidationDialog.tsx:146-169` | — | — | — |
| REQ-DAT-220 | Completeness over the validated field set | `src/model/completeness.ts:24-59` | `src/model/completeness.test.ts:89-284` | — | — |
| REQ-DAT-230 | Non-misleading percentage display | `src/model/completeness.ts:124-129` | `src/model/completeness.test.ts:300-318` | — | — |
| REQ-DAT-240 | Finished is a human declaration | `src/model/project.ts:135-152, 758,861` | — | — | — |
| REQ-DAT-250 | Derive finished when the checkbox is disabled | `src/model/annotationState.ts:79-87,205-207` | `src/components/PaperList.finished.test.ts:207-267` | — | — |
| REQ-DAT-260 | Independent reviewer trees | `src/model/project.ts:347-391,776`<br>`src/model/schema.ts:222` | `src/model/model.test.ts:589-663` | — | — |
| REQ-DAT-270 | Pre-create reviewer skeletons | `src/model/project.ts:357-391` | `src/model/model.test.ts:656` | — | — |
| REQ-DAT-280 | Never drop higher-numbered reviewers | `src/model/project.ts:369-373,936-951` | `src/model/split.test.ts:97` | — | — |
| REQ-DAT-290 | Deterministic serialization | `src/model/project.ts:788-829,1111-1140` | — | commits `c50f28a`<br>`1382386` | — |
| REQ-DAT-300 | Silent shape migration | `src/model/project.ts:590-636`<br>`src/state/store.ts:1378-1414` | — | — | — |
| REQ-DAT-310 | Classify imports in three verdicts | `src/model/duplicates.ts:28-39,387-414` | `src/model/duplicates.test.ts:330` | — | — |
| REQ-DAT-320 | Duplicate matching rules | `src/model/duplicates.ts:49-67,315-363` | — | — | — |
| REQ-DAT-330 | Demote conflicting matches | `src/model/duplicates.ts:118-131,320-347` | `src/model/duplicates.test.ts:73-196,531-560` | — | — |
| REQ-DAT-340 | Human decision on probable duplicates | `src/components/DuplicateReviewDialog.tsx:36-213` | — | — | — |
| REQ-DAT-350 | Merge fills empty fields only | `src/state/editorStore.ts:423-543` | — | commit `c1830f9` | — |
| REQ-DAT-360 | Parse BibTeX, RIS, and CSL-JSON | `src/model/references.ts:32-71, 296-347,505-747` | `src/model/references.test.ts` | — | — |
| REQ-DAT-370 | Convert LaTeX escapes | `src/model/references.ts:93-190,394-408` | `src/model/references.test.ts:166-262` | — | — |
| REQ-DAT-380 | Extract PDF hints from references | `src/model/references.ts:426-432,461-484`<br>`src/state/editorStore.ts:402-419` | — | — | — |
| REQ-EDT-10 | Validate drafts before save | `src/state/editorStore.ts:614-675`<br>`src/components/ProjectEditor.tsx:17-21, 74-79,259-285` | — | — | — |
| REQ-EDT-20 | Flag duplicate identifiers while typing | `src/components/PapersEditor.tsx:14-19, 54,255-265` | — | commit `5ac5112` | — |
| REQ-EDT-30 | Create papers from PDFs | `src/state/editorStore.ts:300-350,1213-1237` | — | — | — |
| REQ-EDT-40 | Warn before destroying answers | `src/components/SchemaTreeEditor.tsx:124-276`<br>`src/model/fieldUsage.ts:59-140` | — | commits `a0034e9`<br>`638e1b5` | — |
| REQ-EDT-50 | Confirm removal of annotated papers | `src/components/PapersEditor.tsx:90-102` | — | — | — |
| REQ-EDT-60 | Edit schema tree graphically | `src/components/SchemaTreeEditor.tsx:20-26, 211-240,285-509` | — | — | — |
| REQ-EDT-70 | Record the review protocol | `src/components/ProtocolEditor.tsx:38-132`<br>`src/model/project.ts:515-534` | — | — | — |
| REQ-EDT-80 | Show schema info once per load | `src/components/SchemaInfoDialog.tsx:5-63` | — | commit `8322d10` | — |
| REQ-EDT-90 | Reorder papers by drag | `src/components/PapersEditor.tsx:43-343` | — | — | — |

## Annotation form, paper list & PDF ([annotation-ui.md](annotation-ui.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-ANN-10 | Render form from schema | `src/components/AnnotationPanel.tsx:92-116`<br>`src/components/AnnotationNode.tsx` | — | — | — |
| REQ-ANN-20 | Type-specific field controls | `src/components/Field.tsx:18, 135-191,471-513` | — | — | — |
| REQ-ANN-30 | Conditional field visibility | `src/model/annotations.ts:195-211`<br>`src/components/AnnotationNode.tsx:115-135` | — | commits `254ad06`<br>`e1b3dd0`<br>`a5061b0` | — |
| REQ-ANN-40 | Cardinality-controlled instances | `src/components/AnnotationNode.tsx:67-93`<br>`src/model/annotations.ts:127-134` | — | — | — |
| REQ-ANN-50 | Grab value from PDF selection | `src/components/Field.tsx:117-133, 154-155,192-201` | — | — | — |
| REQ-ANN-60 | Field descriptions with links | `src/components/NodeName.tsx:18-34,83-256`<br>`src/model/linkify.ts:14-55` | — | commits `2b66bac`<br>`4271e2e` | — |
| REQ-ANN-70 | Required-field marker | `src/components/NodeName.tsx:60-66` | — | — | — |
| REQ-ANN-80 | Per-paper finished sign-off | `src/components/AnnotationPanel.tsx:118-160,235-261`<br>`src/model/annotationState.ts:79-140` | — | commits `f58aee5`<br>`edfc5db` | — |
| REQ-ANN-90 | Jump to field | `src/components/AnnotationPanel.tsx:76-90` | — | commit `c0a8b15` | — |
| REQ-ANN-100 | Link PDF marks to fields as evidence | `src/components/Field.tsx:84-115,208-459` | `src/state/store.marks.test.ts:209-277` | commit `f5b8f6b` | — |
| REQ-ANN-110 | Auto-link fresh marks once | — | `src/state/store.marks.test.ts:325-457` | commits `861470c`<br>`e170faa` | — |
| REQ-ANN-120 | Reindex links on instance removal | — | `src/state/store.reindex.test.ts:58-170` | commit `b9afb02` | — |
| REQ-LST-10 | List papers with status | `src/components/PaperList.tsx:396-451` | — | — | — |
| REQ-LST-20 | Two-mode search | `src/components/PaperList.tsx:187-189, 366-394,452-488` | — | — | — |
| REQ-LST-30 | Five-state annotation indicator | `src/components/PaperList.tsx:34-107,572-637`<br>`src/model/annotationState.ts:36-95` | — | — | — |
| REQ-LST-40 | Annotation progress filter | `src/components/PaperList.tsx:335-363,496-510`<br>`src/model/annotationState.ts:194-258` | — | commit `0cb3828` | — |
| REQ-LST-50 | Keyboard navigation | `src/components/PaperList.tsx:402-440`<br>`src/hooks/useKeybindings.ts:8-261` | — | commit `8ef9279` | — |
| REQ-LST-60 | Search and completeness performance | — | `src/components/PaperList.perf.test.ts:26,70-115` | — | — |
| REQ-LST-70 | Resume where the reviewer left off | `src/state/store.ts:256-313` | `src/state/store.readingPosition.test.ts:73-143` | commits `bb44dc8`<br>`e8efa2e` | — |
| REQ-PDF-10 | Render the paper's PDF | `src/components/PdfViewer.tsx:23, 1376-1414,1537-1547` | — | — | — |
| REQ-PDF-20 | Zoom controls | `src/state/store.ts:333-335,1694-1706`<br>`src/components/PdfViewer.tsx:437-443,1286-1297` | — | — | — |
| REQ-PDF-30 | Page navigation | `src/components/PdfViewer.tsx:567-587, 621-703,1508-1558` | — | — | — |
| REQ-PDF-40 | Jump history for internal links | `src/components/PdfViewer.tsx:428-435, 1076-1099,1484-1507` | — | — | — |
| REQ-PDF-50 | In-PDF text search | `src/components/PdfViewer.tsx:98-136, 390-405, 1246-1280,1618-1673` | — | commit `c206c49` | — |
| REQ-PDF-60 | Capture normalized text selection | `src/components/PdfViewer.tsx:705-717` | — | commit `d335151` | — |
| REQ-PDF-70 | Create highlights from selections | `src/components/PdfViewer.tsx:840-998,1327-1344` | — | commit `b2e2195` | — |
| REQ-PDF-80 | Cross-page highlights | `src/components/PdfViewer.tsx:840-998,1784-1806` | — | commits `0e524d7`<br>`502efe9`<br>`bacbaf3` | — |
| REQ-PDF-90 | Sticky notes | `src/components/PdfViewer.tsx:1052-1070,1675-1686` | — | commit `8cf1ff1` | — |
| REQ-PDF-100 | Edit marks via popover | `src/components/PdfViewer.tsx:1808-1887` | — | commit `135a385` | — |
| REQ-PDF-110 | Per-seat mark scoping | `src/model/pdfMarks.ts:1-79`<br>`src/state/store.ts:928-953` | — | — | — |
| REQ-PDF-120 | Mark edits are undoable | — | `src/state/store.marks.test.ts:52-323` | commit `316b304` | — |
| REQ-PDF-130 | Mark cycling in reading order | `src/components/PdfViewer.tsx:1024-1034,1687-1711`<br>`src/model/pdfMarks.ts:182-245` | — | commit `61a2aa4` | — |
| REQ-PDF-140 | Selection through marks | `src/components/PdfViewer.tsx:719-788` | — | commit `d4c20e2` | — |
| REQ-PDF-150 | Reference hover previews | `src/components/PdfViewer.tsx:180-218,1109-1218`<br>`src/model/refPreview.ts:22-152` | — | commits `1d07bd3`<br>`80dece2` | — |
| REQ-PDF-160 | Export marks into a PDF | `src/model/pdfExport.ts:27-61`<br>`src/components/ExportPdfDialog.tsx:32-166` | — | commit `e22c157` | — |
| REQ-PDF-170 | Extract PDF metadata heuristically | `src/model/pdfMeta.ts:1-120` | `src/model/pdfMeta.test.ts` | — | — |
| REQ-PDF-180 | Extract page-ordered PDF text | `src/model/pdfText.ts:22-152` | — | — | — |
| REQ-UI-10 | Global keyboard shortcuts | `src/hooks/useKeybindings.ts:8-261`<br>`src/components/HelpDialog.tsx:10-62` | — | — | — |
| REQ-UI-20 | Toolbar project controls | `src/components/Toolbar.tsx:99-468` | — | — | — |
| REQ-UI-30 | Seat switcher in toolbar | `src/components/Toolbar.tsx:26-32,341-398`<br>`src/components/AnnotationPanel.tsx:204-212` | — | — | — |
| REQ-UI-40 | Resizable panes | `src/components/Splitter.tsx:11-44`<br>`src/state/settings.ts` | — | — | — |
| REQ-UI-50 | Clipboard fallback | `src/clipboard.ts:9-30` | — | — | — |
| REQ-UI-60 | Surface load and save errors | `src/components/ErrorPanel.tsx:4-28` | — | — | — |

## Screening ([screening.md](screening.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-SCR-10 | Identify screening projects by configuration | `src/screening/schema.ts` (`isScreening`) | `src/screening/schema.test.ts` ("is true when config.screening is set") | — | — |
| REQ-SCR-20 | Derive fixed screening schema | `src/screening/schema.ts:32-72` | `src/screening/schema.test.ts` ("derives exactly Decision and Reason, in that order") | — | — |
| REQ-SCR-30 | Seed default exclusion reasons | `src/screening/schema.ts:38-47` | `src/screening/schema.test.ts:79` | — | — |
| REQ-SCR-40 | Normalize reasons on load | `src/model/project.ts` (`parseScreening`) | — | — | `openwiki/workflows/screening.md` ("Derived schema") |
| REQ-SCR-50 | Reject screening projects without reasons | `src/model/project.ts` (`parseScreening`) | `src/state/editorStore.screening.test.ts:128` | — | — |
| REQ-SCR-60 | Tri-state screening status | `src/screening/status.ts:15-20` | `src/screening/status.test.ts:26-34` | — | — |
| REQ-SCR-70 | Record screening decision per seat | — | `src/state/store.screening.test.ts` (`setScreeningDecision` describe block) | — | — |
| REQ-SCR-80 | Refuse decisions without a seat | `src/components/ScreeningPanel.tsx:40-49` | `src/state/store.screening.test.ts` | — | — |
| REQ-SCR-90 | Clear reason when decision leaves Exclude | — | `src/state/store.screening.test.ts` ("clears the reason in the same undo step") | — | — |
| REQ-SCR-100 | Exclude-with-reason as single undo step | — | `src/state/store.screening.test.ts` ("writes decision and reason together in one undo step") | — | — |
| REQ-SCR-110 | Auto-advance after deciding | — | `src/state/store.screening.test.ts` ("advances to the next undecided paper", "stops at the last paper rather than wrapping") | — | — |
| REQ-SCR-120 | Toggle decision back to undecided | `src/components/ScreeningPanel.tsx` (`decide()`) | — | — | — |
| REQ-SCR-130 | Restrict reason entry to excluded papers | `src/components/ScreeningPanel.tsx` (`disabled={status !== 'excluded'}`) | `src/state/store.screening.test.ts` (`setScreeningReason` describe block) | — | — |
| REQ-SCR-140 | Screening keyboard shortcuts | `src/hooks/useKeybindings.ts` | — | — | `openwiki/workflows/screening.md` ("Decision writes and auto-advance") |
| REQ-SCR-150 | Reject AI suggestions in screening projects | — | `src/state/store.screening.test.ts` ("refuses and fills nothing") | — | — |
| REQ-SCR-160 | Adopt unanimous screening values | — | `src/state/store.screening.test.ts` (`adoptAllUnanimousScreening` describe block) | — | — |
| REQ-SCR-170 | Pending-unanimous notice | `src/components/ScreeningPanel.tsx:118-128`<br>`src/screening/counts.ts:97-121` | — | — | — |
| REQ-SCR-180 | Per-seat screening counts | `src/screening/counts.ts:14-88` | `src/screening/counts.test.ts:96` ("counts differ per seat") | — | — |
| REQ-SCR-190 | Report all configured reasons in the summary | `src/screening/counts.ts:31-36` | `src/screening/counts.test.ts:74` | — | — |
| REQ-SCR-200 | Separate bucket for unknown reasons | `src/screening/counts.ts:37-58` | `src/screening/counts.test.ts:82-91` | — | — |
| REQ-SCR-210 | Screening summary display | `src/components/ScreeningSummary.tsx` | — | — | — |
| REQ-SCR-220 | Live progress line | `src/components/ScreeningPanel.tsx:171-176` | — | — | — |
| REQ-SCR-230 | Validate excluded-without-reason | `src/screening/validate.ts:27-61` | `src/screening/validate.test.ts:54` | — | — |
| REQ-SCR-240 | Validate reason-without-exclusion | `src/screening/validate.ts:27-61` | `src/screening/validate.test.ts:61` | — | — |
| REQ-SCR-250 | Manage exclusion reasons as ordered list | `src/components/ScreeningReasonsEditor.tsx` | — | — | — |
| REQ-SCR-260 | Migrate papers on reason rename | `src/components/ScreeningReasonsEditor.tsx:39-67`<br>`src/screening/reasonUsage.ts:78-119` | — | — | — |
| REQ-SCR-270 | Confirm reason removal in use | `src/components/ScreeningReasonsEditor.tsx:69-88` | — | — | — |
| REQ-SCR-280 | Abstract-based screening view | `src/components/ScreeningRecord.tsx` | — | — | — |
| REQ-SCR-290 | Auto-extract missing abstracts | — | `src/state/store.screeningAbstract.test.ts` ("extraction fires on selection, not on opening the PDF") | — | — |
| REQ-SCR-300 | Caution notice for extracted abstracts | `src/components/ScreeningRecord.tsx:44-49` | — | — | — |
| REQ-SCR-310 | Never overwrite manual abstracts | — | `src/state/store.screeningAbstract.test.ts` (race-safety tests) | — | — |
| REQ-SCR-320 | Import screening results into a new project | `src/components/ScreeningImportDialog.tsx` | `src/state/editorStore.screening.test.ts:196-226` | — | — |
| REQ-SCR-330 | Reject non-screening import sources | — | `src/state/editorStore.screening.test.ts:233` | — | — |
| REQ-SCR-340 | Strip decisions on carry-over | — | `src/state/editorStore.screening.test.ts:196, 328,382` | — | — |
| REQ-SCR-350 | Choose target project kind on import | — | `src/state/editorStore.screening.test.ts:244-264` | — | — |
| REQ-SCR-360 | Record import provenance | — | `src/state/editorStore.screening.test.ts:336-423` | — | — |
| REQ-SCR-370 | Prevent paper-ID collisions on import | — | `src/state/editorStore.screening.test.ts:525` | — | — |
| REQ-SCR-380 | Distinct screening annotation file prefix | `src/git/ownAnnotationPath.ts` | — | commit `c4d8e7d` | `openwiki/workflows/screening.md` ("On-disk layout") |

## Consolidation & agreement ([consolidation.md](consolidation.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-CON-10 | Isolate reviewer seats | `src/components/ReviewerPrompt.tsx:50-54` | `src/state/store.reviewers.test.ts:149` | — | — |
| REQ-CON-20 | Mandatory seat selection | `src/components/ReviewerPrompt.tsx:20-43` | `src/state/store.reviewers.test.ts:119-135` | — | — |
| REQ-CON-30 | Persist seat choice locally | `src/components/ReviewerPrompt.tsx:56-58` | `src/state/store.reviewers.test.ts:410-457` | — | — |
| REQ-CON-40 | Discard stale seat choices | — | `src/state/store.reviewers.test.ts:410-457` | — | — |
| REQ-CON-50 | Seat switch outside undo history | — | `src/state/store.reviewers.test.ts:387-398,544-566` | — | — |
| REQ-CON-60 | Consolidation seat writes shipping tree | — | `src/state/store.reviewers.test.ts:328` | — | — |
| REQ-CON-70 | Show per-paper readiness | `src/consolidate/readiness.ts:24-39`<br>`src/components/ReviewerPrompt.tsx:84-101` | — | — | — |
| REQ-CON-80 | Optimal matching of repeated entries | `src/consolidate/align.ts:114-174`<br>`src/consolidate/assign.ts:24-50` | — | — | — |
| REQ-CON-90 | Hierarchical alignment | `src/consolidate/align.ts:32-37,302-309` | — | — | — |
| REQ-CON-100 | Deterministic multi-reviewer alignment | `src/consolidate/align.ts:222-262` | — | — | — |
| REQ-CON-110 | Similarity threshold for merging | `src/consolidate/align.ts:70-111,277-299` (`MIN_MATCH_SCORE`) | — | — | — |
| REQ-CON-120 | Persist only slot membership | `src/consolidate/apply.ts:20-38` | — | — | — |
| REQ-CON-130 | Grow-only consolidated tree on alignment | `src/consolidate/apply.ts:74-113` | `src/state/store.align.test.ts:124-302` | — | — |
| REQ-CON-140 | Alignment as single undo step | — | `src/state/store.align.test.ts:144-219` | — | — |
| REQ-CON-150 | Freeze answered alignments | `src/consolidate/readiness.ts:52-54` | `src/state/store.align.test.ts:228` | — | — |
| REQ-CON-160 | Widen frozen alignments for late reviewers | `src/consolidate/align.ts:427-563` (`widenAlignment`) | `src/state/store.reviewers.test.ts:305` | — | — |
| REQ-CON-170 | Evidence-weighted similarity | `src/consolidate/similarity.ts:18-53` | — | — | — |
| REQ-CON-180 | Type-aware value comparison | `src/consolidate/similarity.ts:63-116,230-264` | — | — | — |
| REQ-CON-190 | Detect field disagreements over the alignment | `src/consolidate/disagreements.ts:19-131` | — | — | — |
| REQ-CON-200 | Normalize answers for agreement | `src/consolidate/disagreements.ts:72-79,199-210` | — | commit `88b0394` | — |
| REQ-CON-210 | Ignore skeleton boolean answers | `src/consolidate/disagreements.ts:119-121,186-198` | — | commit `60c9d48` | — |
| REQ-CON-220 | Flag one-sided entries | `src/consolidate/disagreements.ts:44-53,148-179` | — | commits `5927055`<br>`137ab4a` | — |
| REQ-CON-230 | Single field-status rule | `src/components/ConsolidationVerdicts.ts:21-43`<br>`src/components/DisagreementOverview.tsx:47-60` | — | — | — |
| REQ-CON-240 | Auto-fill unanimous values | `src/consolidate/unanimous.ts:54-135` | `src/state/store.align.test.ts:361-426` | — | — |
| REQ-CON-250 | Mark auto-filled values | `src/consolidate/unanimous.ts:15-18` | `src/state/store.batch-unanimous.test.ts:297` | — | — |
| REQ-CON-260 | Batch unanimous adoption | `src/components/ConsolidationOverview.tsx:113-143` | `src/state/store.batch-unanimous.test.ts:169-412` | — | — |
| REQ-CON-270 | Compute Cohen's kappa | `src/consolidate/metrics.ts:95-163` | — | — | — |
| REQ-CON-280 | Compute Fleiss' kappa | `src/consolidate/metrics.ts:181-269` | — | — | — |
| REQ-CON-290 | Compute Krippendorff's alpha | `src/consolidate/metrics.ts:282-388` | — | — | — |
| REQ-CON-300 | Report degenerate metric cases | `src/consolidate/metrics.ts:63-83, 150-153, 250-252,371-373` | — | — | — |
| REQ-CON-310 | Per-field agreement breakdown | `src/consolidate/agreement.ts:18-40,100-105`<br>`src/components/AgreementDialog.tsx:44-56,246-304` | — | — | — |
| REQ-CON-320 | Screening agreement on decision only | `src/consolidate/agreement.ts:71-80` | — | — | — |
| REQ-CON-330 | Warn on unaligned papers in agreement | `src/components/AgreementDialog.tsx:94-235`<br>`src/consolidate/readiness.ts:79-100` | — | — | — |
| REQ-CON-340 | Side-by-side answer comparison | `src/components/ConsolidationDialog.tsx:116-134` | — | — | — |
| REQ-CON-350 | Adopt a reviewer's answer | `src/components/ConsolidationDialog.tsx:157-248` | — | — | — |
| REQ-CON-360 | Mark answers as equivalent | `src/components/ConsolidationDialog.tsx:136-150` | `src/state/store.reviewers.test.ts:347-376` | — | — |
| REQ-CON-370 | Guard stranded equivalence marks | `src/components/ConsolidationDialog.tsx:27-33, 97-110,251-268` | — | commit `01cb118` | — |
| REQ-CON-380 | Export disagreements per paper | `src/consolidate/exportDisagreements.ts:13-34` | — | — | — |
| REQ-CON-390 | Export disagreements project-wide | `src/consolidate/exportDisagreements.ts:36-51`<br>`src/components/ConsolidationOverview.tsx:86-89` | — | commit `9125ee0` | — |
| REQ-CON-400 | Disable AI suggestions for Consolidation seat | — | `src/state/store.align.test.ts:442-464` | — | — |

## Git integration ([git-integration.md](git-integration.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-GIT-10 | Use the user's installed git | `electron/main.ts:1761`<br>`src/git/types.ts:28-34` | — | — | — |
| REQ-GIT-20 | Confine git execution to the main process | `src/git/types.ts:1-6,155-166`<br>`electron/main.ts:1761-2604` | — | — | — |
| REQ-GIT-30 | Neutralize hostile repository configuration | `electron/main.ts:1668,1696` (`GIT_SAFE_CONFIG`) | — | — | — |
| REQ-GIT-40 | Disable interactive git prompts | `electron/main.ts:1618` (`gitEnv`) | — | — | — |
| REQ-GIT-50 | Bound git command duration | `electron/main.ts:1597, 1692, 1782, 2200, 2317,2340` | — | — | — |
| REQ-GIT-60 | Validate clone URLs | `src/git/url.ts:17-38` | `src/git/url.test.ts` | — | — |
| REQ-GIT-70 | Validate repository-relative paths | `src/git/relpath.ts:15-52`<br>`electron/main.ts:1729` | — | — | — |
| REQ-GIT-80 | Validate ref names | `src/git/ref.ts:21-60`<br>`electron/main.ts:1742, 2331,2345` | — | — | — |
| REQ-GIT-90 | Restrict operations to session-known roots | `electron/main.ts:1753-1756` | — | — | — |
| REQ-GIT-100 | Clone a project repository | `electron/main.ts:1768-1791`<br>`src/state/gitStore.ts:731-790`<br>`src/components/GitCloneDialog.tsx` | — | — | — |
| REQ-GIT-110 | Detect repository context on open | `electron/main.ts:1802-1819`<br>`src/git/deriveGitInfo.ts:33` | — | — | — |
| REQ-GIT-120 | Show working-tree status and diff | `electron/main.ts:1823`<br>`src/git/output.ts:12-74` | — | — | — |
| REQ-GIT-130 | Field-level review of project changes | `src/git/changes.ts:21-471`<br>`src/state/gitStore.ts:583` | `gitStore.test.ts:389-495` | — | — |
| REQ-GIT-140 | Whole-file fallback for structural changes | `src/git/changes.ts:239` | `gitStore.test.ts:414` | — | — |
| REQ-GIT-150 | Commit a subset of field changes | `electron/main.ts:2029-2078` (`git:commitPartial`) | `gitStore.test.ts:497-587,646-712` | — | — |
| REQ-GIT-160 | Confirm mixed discard commits | — | `src/components/GitDialog.test.ts:4-55` | commit `6285ce4` | — |
| REQ-GIT-170 | Pathspec-limited commits | `electron/main.ts:2170-2189` | — | — | — |
| REQ-GIT-180 | Amend previous commit | `electron/main.ts:2191` | `gitStore.test.ts:589-636` | commit `a7b594f` | — |
| REQ-GIT-190 | Protect project files from whole-file discard | `electron/main.ts:2129-2168`<br>`src/components/GitDialog.tsx:416-421` | — | — | — |
| REQ-GIT-200 | Refuse writes on stale snapshots | `src/state/gitStore.ts:650-687` | `gitStore.test.ts:568,714` | — | — |
| REQ-GIT-210 | Block merges over unsaved changes | `src/state/gitStore.ts:439` | `gitStore.test.ts:368, 815,954` | commit `909f674` | — |
| REQ-GIT-220 | Pull as classified upstream merge | `electron/main.ts:2304-2329`<br>`src/git/types.ts:111-136`<br>`src/state/gitStore.ts:1086-1112` | — | — | — |
| REQ-GIT-230 | Abort merges touching foreign files | `electron/main.ts` (`beginMergeInto`)<br>`src/git/ownAnnotationPath.ts:47-64` | `gitStore.test.ts:1032` | — | — |
| REQ-GIT-240 | Field-level three-way merge | `src/git/merge.ts:109,982` | `src/git/merge.test.ts` | — | — |
| REQ-GIT-250 | Refuse structure-reshaping merges | `src/git/merge.ts:833-843,982-989` | `gitStore.test.ts:340` | — | — |
| REQ-GIT-260 | Refuse merges dropping answered fields | `src/git/merge.ts:942` (`schemaRemovalRefusal`) | — | — | — |
| REQ-GIT-270 | Preserve repeatable entries in merges | `src/git/merge.ts:207, 279,352` | — | commit `7130d4c` | — |
| REQ-GIT-280 | Keep changed papers over deletion | `src/git/merge.ts:77, 794,813` | — | — | — |
| REQ-GIT-290 | Auto-finish conflict-free merges | `src/state/gitStore.ts:376,548` | `gitStore.test.ts:308,325` | — | — |
| REQ-GIT-300 | Interactive conflict resolution | `src/state/gitStore.ts:1303-1337`<br>`src/git/merge.ts:1280`<br>`src/components/GitMergeDialog.tsx` | — | — | — |
| REQ-GIT-310 | Scope bulk resolution to own seat | — | `src/components/GitMergeDialog.test.ts:5-15`<br>`gitStore.test.ts:730-792` | — | — |
| REQ-GIT-320 | Manual push only | `electron/main.ts:2196-2200` | `e2e/gitPush.spec.ts` | — | — |
| REQ-GIT-330 | Merge any branch | `electron/main.ts:2329-2345` | `gitStore.test.ts:953-1085` | commit `fa15e8b` | — |
| REQ-GIT-340 | Create and switch branches | `electron/main.ts:2447,2470` | `gitStore.test.ts:795-809,1088-1153` | — | — |
| REQ-GIT-350 | Carry uncommitted changes across branch switch | `electron/main.ts:2503-2604` | `gitStore.test.ts:829-951` | commit `8eb8ed8` | — |
| REQ-GIT-360 | Safe branch deletion | `electron/main.ts:2460` | `gitStore.test.ts:1155-1196` | — | — |
| REQ-GIT-370 | Project-scoped history | `electron/main.ts:1954-1991`<br>`src/components/GitHistoryDialog.tsx:30-137` | — | commit `f6af7fe` | — |
| REQ-GIT-380 | Concurrent multi-file project reads | `src/git/concurrentRead.ts:20` | — | commits `18d6bf9`<br>`63e7bc7` | — |
| REQ-GIT-390 | Report git failures as messages | `src/git/types.ts:20-26`<br>`src/git/output.ts:138` | — | — | — |

## LLM-assisted annotation ([llm-annotation.md](llm-annotation.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-LLM-10 | Support multiple LLM providers | `src/llm/providers.ts:55-157`<br>`src/llm/types.ts:12-21` | — | — | — |
| REQ-LLM-20 | Fixed base URLs for named providers | `src/llm/providers.ts:22, 60,146`<br>`src/components/LlmSettingsDialog.tsx:423` | — | — | — |
| REQ-LLM-30 | Manage multiple named targets | `src/llm/types.ts:27-46`<br>`src/components/LlmSettingsDialog.tsx:102-106,264-276` | — | — | — |
| REQ-LLM-40 | Keep API keys out of the user interface layer | `src/llm/types.ts:4-10,86`<br>`electron/main.ts:1417, 1447-1450,1536-1539` | — | — | — |
| REQ-LLM-50 | Encrypt stored API keys | `electron/main.ts:1408-1464` | — | — | — |
| REQ-LLM-60 | Restrict key transmission | `electron/main.ts:1519-1534,1551-1566` | — | — | — |
| REQ-LLM-70 | Bound LLM call duration | `electron/main.ts:1488-1500,1549` | — | commit `98796c1` | — |
| REQ-LLM-80 | Honor project-level AI opt-out | `src/model/project.ts:771`<br>`src/components/AnnotationPanel.tsx:23-25,161`<br>`src/state/aiStore.ts:164-166` | — | — | — |
| REQ-LLM-90 | Restrict AI to numbered reviewer seats | `src/state/aiStore.ts:167-169`<br>`src/state/store.ts:2318-2337` | — | — | — |
| REQ-LLM-100 | Ask only about unanswered fields | `src/llm/fields.ts:21-75`<br>`src/state/aiStore.ts:185` | — | — | — |
| REQ-LLM-110 | Deliver the paper as text or PDF | `src/llm/providers.ts:61-156,230-264`<br>`src/state/aiStore.ts:375-418` | — | — | — |
| REQ-LLM-120 | Refuse text delivery of image-only PDFs | `src/state/aiStore.ts:388-400`<br>`src/model/pdfText.ts:106-152` | — | — | — |
| REQ-LLM-130 | Anti-hallucination prompt rules | `src/llm/prompt.ts:150-165` | — | — | — |
| REQ-LLM-140 | Flatten schema text in prompts | `src/llm/prompt.ts:77-93` | — | commit `30a7ecf` | — |
| REQ-LLM-150 | Bind replies to their run | `src/state/aiStore.ts:87,340-347` | `src/state/store.ai.test.ts:431-461` | commit `c56d6ab` | — |
| REQ-LLM-160 | Discard superseded runs | `src/state/aiStore.ts:355-482` | — | commit `e6f534a` | — |
| REQ-LLM-170 | Validate every suggestion against the schema | `src/llm/parse.ts:7-23,256-324` | — | — | — |
| REQ-LLM-180 | Accept only unambiguous coercions | `src/llm/parse.ts:124-183` | — | — | — |
| REQ-LLM-190 | Tolerant reply extraction | `src/llm/parse.ts:28-116` | — | — | — |
| REQ-LLM-200 | Cap repeatable indices from the model | `src/llm/paths.ts:224-246`<br>`src/llm/parse.ts:276` | — | — | — |
| REQ-LLM-210 | Human review before applying | `src/components/AiDialog.tsx:14-18,242-336`<br>`src/state/aiStore.ts:447-454` | — | — | — |
| REQ-LLM-220 | Apply as one undo step without overwriting | `src/state/store.ts:2364-2432` | `src/state/store.ai.test.ts:142-251` | — | — |
| REQ-LLM-230 | Mark AI-written fields until confirmed | `src/state/store.ts:107-124,2436-2445` | `src/state/store.aimarks.test.ts` | — | — |
| REQ-LLM-240 | Record durable AI-usage disclosure | `src/state/store.ts:2419-2427`<br>`src/model/project.ts:416-436` | `src/state/store.ai.test.ts:364-429` | — | — |
| REQ-LLM-250 | List provider models | `src/llm/models.ts:92-174`<br>`src/state/aiStore.ts:35-46,277-325` | — | — | — |
| REQ-LLM-260 | Constrain pagination cursors | `src/llm/models.ts:96-157` | — | — | — |
| REQ-LLM-270 | Free-text model selection | `src/components/ModelPicker.tsx:16-28,115-118` | — | — | — |
| REQ-LLM-280 | Per-provider reasoning effort | `src/llm/providers.ts:266-366`<br>`src/llm/models.ts:14-90,246-257` | — | — | — |
| REQ-LLM-290 | Verify target setup | `src/state/aiStore.ts:26-32,233-271`<br>`src/components/LlmSettingsDialog.tsx:239-262,563-588` | — | — | — |
| REQ-LLM-300 | Report run progress | `src/state/aiStore.ts:48-56,361-363`<br>`src/components/AiDialog.tsx:220-240` | — | — | — |
| REQ-LLM-310 | Distinguish truncation from empty answers | `src/llm/providers.ts:421-446`<br>`src/state/aiStore.ts:260-268,431-437` | — | — | — |

## Platform & desktop shell ([platform.md](platform.md))

| ID | Requirement | Implemented in | Verified by | History | Docs |
|---|---|---|---|---|---|
| REQ-PLT-10 | Desktop-only operation | `src/platform/unsupported.ts:4-28`<br>`src/platform/index.ts:10-23` | — | commit `7fbaa84` | — |
| REQ-PLT-20 | Open projects via native dialog | `electron/main.ts:659-670` | — | — | — |
| REQ-PLT-30 | Restrict saves to session-authorized paths | `electron/main.ts:657-807` | `e2e/openSaveProject.spec.ts:45-95` | — | — |
| REQ-PLT-40 | Split project storage | `electron/main.ts:504-651,761-797`<br>`src/model/project.ts:881-1029` | `e2e/openSaveProject.spec.ts:129` | commit `7fbaa84` | — |
| REQ-PLT-50 | Migrate single-file projects | `electron/main.ts:517-524,637-651`<br>`src/model/project.ts:1036-1109` | — | — | — |
| REQ-PLT-60 | Tolerate corrupt annotation files | `electron/main.ts:585-631` | — | — | — |
| REQ-PLT-70 | Refuse symlinked and escaping write targets | `electron/main.ts:695-709,772-795` | — | — | — |
| REQ-PLT-80 | Save As with path rebasing | `electron/main.ts:822-831,1332-1339` | `src/state/store.saveas.test.ts:79-133` | — | — |
| REQ-PLT-90 | Refuse sibling-project collisions | `electron/main.ts:850-883` | `src/state/store.saveas.test.ts:134-152` | commit `a7c5153` | — |
| REQ-PLT-100 | Prompt on close with unsaved changes | `electron/main.ts:290-326,1372-1381` | `src/state/store.close.test.ts:59-135` | — | — |
| REQ-PLT-110 | Keep project open on failed save | — | `src/state/store.close.test.ts:59-252` | — | — |
| REQ-PLT-120 | Guard reload shortcuts | `electron/main.ts:338-353,474-491` | — | — | — |
| REQ-PLT-130 | Preserve newer changes during save | — | `src/state/store.save.test.ts:52-86` | commit `7f96e40` | — |
| REQ-PLT-140 | Recent projects list | `src/platform/recents.ts:7-69` | `src/platform/recents.test.ts` | — | — |
| REQ-PLT-150 | Re-check recents on display | `electron/main.ts:956-975`<br>`src/platform/recents.ts:16-20` | `src/state/store.close.test.ts:137-175` | — | — |
| REQ-PLT-160 | Persist window state | `electron/main.ts:138-203,269-282` | — | — | — |
| REQ-PLT-170 | Persist appearance settings | `src/state/settings.ts` | — | — | — |
| REQ-PLT-180 | Migrate legacy settings folder | `electron/main.ts:91-134` | — | — | `README.md` ("Upgrading from SLR Helper?") |
| REQ-PLT-190 | Portable relative PDF paths | `electron/main.ts:1323-1328`<br>`src/platform/adapter.ts:169-175` | — | — | — |
| REQ-PLT-200 | Confine PDF access to the project folder | `electron/main.ts:361-410,1002-1026` | — | commit `8c52edf` | — |
| REQ-PLT-210 | Explain blocked PDF loads | `electron/main.ts:991-1000`<br>`src/platform/electron.ts:249-295` | — | commit `445a6a5` | — |
| REQ-PLT-220 | Recursive PDF folder import | `electron/main.ts:904-933` | — | — | — |
| REQ-PLT-230 | Renderer sandboxing | `electron/main.ts:244-249`<br>`electron/preload.ts:7` | — | — | — |
| REQ-PLT-240 | Deny device permissions | `electron/main.ts:1389-1394` | — | — | — |
| REQ-PLT-250 | Route external links to the system browser | `electron/main.ts:205-224,254-266` | — | — | — |
| REQ-PLT-260 | Restrict export writes | `electron/main.ts:1146-1221` | — | — | — |
| REQ-PLT-270 | Self-update on Windows and Linux only | `electron/main.ts:1223-1321`<br>`src/platform/adapter.ts:291-316` | — | commit `9b8eb12` | — |
| REQ-PLT-280 | No unattended updates | `electron/main.ts:1235-1237` | — | — | — |
| REQ-PLT-290 | Verify update-feed signatures | `electron/main.ts:1254-1316`<br>`src/model/updateSignature.ts:28-59` | — | commit `742ad60` | — |
| REQ-PLT-300 | Startup update check | `src/model/version.ts:1-177` | `src/model/version.test.ts` | commit `c6d3689` | — |
| REQ-PLT-310 | Application undo via menu | `electron/main.ts:447-469`<br>`electron/preload.ts:62-69` | — | — | — |
| REQ-PLT-320 | Build targets | `package.json:51-117` | — | — | `README.md` (release table) |
| REQ-PLT-330 | Ad-hoc sign unsigned macOS builds | `scripts/afterPack.cjs` | — | commit `3850b55` | — |
| REQ-PLT-340 | Optional autosave | `src/components/Toolbar.tsx` (Save menu)<br>`src/state/settings.ts` (`slr.autosave`) | — | — | — |

## Coverage statistics

| Metric | Count | Share |
|---|---|---|
| Requirements traced | 272 | 100% |
| With at least one verifying test | 105 | 38% |
| With an introducing/pinning commit | 57 | 20% |
| With a documentation link | 5 | 1% |
| Source-inspection only | 124 | 45% |

