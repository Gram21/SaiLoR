# Requirements: Annotation Form, Paper List & PDF Viewing

Requirements for the three-pane annotation workspace: the schema-driven form, the paper
list, the PDF viewer with highlights/notes, evidence linking, reading position, and PDF
export. See the [index](../requirements/index.md) for the glossary.

---

## Annotation form

### REQ-ANN-10: Render form from schema
`req~ann-10~1`

The system shall render an annotation form for the selected paper by recursively traversing the project schema, presenting a schema-shaped empty form for a paper without recorded annotations.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:92-116`, `src/components/AnnotationNode.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-20: Type-specific field controls
`req~ann-20~1`

The system shall present a checkbox for boolean fields, a numeric input for number fields, a numeric input bounded to 1000–2100 for year fields, a filtering combo box restricted to the defined options for enum fields, and an auto-expanding text area limited to 500 characters for free-text fields.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx` (`Field`, `StringField`, `parseNumber`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-30: Conditional field visibility
`req~ann-30~1`

When a node defines a `visibleIf` gate, the system shall show the node only while the gate holds: each condition is satisfied when the referenced field is answered, or: where the condition lists `equals` values: when that field holds one of them, the field being resolved as a same-level sibling, else an ancestor, else an absolute path walked from the paper's root tree taking the first entry of every repeatable node along it; entries are combined with AND (`mode: "all"`) or OR (`mode: "any"`), an entry may itself be a nested group with its own mode, and a condition whose field is found nowhere is treated as satisfied.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:216-287`, `src/model/model.test.ts:645-948`, `src/components/AnnotationNode.tsx:115-140`, `src/components/AnnotationPanel.tsx:264-270`, commits `254ad06`, `e1b3dd0`, `a5061b0`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-ANN-40: Cardinality-controlled instances
`req~ann-40~1`

The system shall offer adding an instance of a repeatable node while the instance count is below the node's maximum, and removing an instance while the count exceeds the larger of the node's minimum and one.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationNode.tsx:67-93`, `src/model/annotations.ts:127-134`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-50: Grab value from PDF selection
`req~ann-50~1`

When text is selected in the PDF viewer, the system shall offer per string, number, and year field a one-click insertion of the selection, taking the first numeric token for numbers (comma accepted as decimal separator) and a plausible four-digit year for year fields.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx:117-133,154-155,192-201`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-60: Field descriptions with links
`req~ann-60~1`

The system shall show a field's description as a hover tooltip, shall open a persistent popover with selectable text and clickable http/https links on right-click, and shall open a single-link description's link directly on Ctrl/Cmd-click of the field name.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/NodeName.tsx:18-34,83-256`, `src/model/linkify.ts:14-55`, commits `2b66bac`, `4271e2e`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-70: Required-field marker
`req~ann-70~1`

The system shall mark required fields with an asterisk carrying the explanation "Required: this field must be filled in".

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/NodeName.tsx:60-66`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-80: Per-paper finished sign-off
`req~ann-80~1`

The system shall present a permanently visible "Annotation finished" checkbox as the reviewer's own sign-off (labeled "Consolidation finished" on the Consolidation seat), showing a flagged state with explanation when ticked while a required field is empty, and shall hide the checkbox for screening projects and projects configured with `finishCheckbox: false`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:118-160,235-261`, `src/model/annotationState.ts:79-140`, commits `f58aee5`, `edfc5db`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-90: Jump to field
`req~ann-90~1`

When a field jump is requested from the Validation dialog, the system shall scroll the target field into center view and flash it for 4 seconds.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:76-90`, commit `c0a8b15`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-100: Link PDF marks to fields as evidence
`req~ann-100~1`

The system shall provide per field a link popover that lists already-linked PDF marks with unlink actions and a searchable picker of the seat's marks (recent session marks first, then reading order), where selecting a mark links it, clicking its snippet jumps to it in the PDF, and one mark accepts links to multiple fields.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx:84-115,208-459`, `src/state/store.marks.test.ts:209-277`, commit `f5b8f6b`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-ANN-110: Auto-link fresh marks once
`req~ann-110~1`

When the link popover opens for the last-edited field while a mark created in this session is pending, the system shall link that mark automatically exactly once; the pending offer shall be invalidated by paper or seat switches, instance changes, undo/redo, or touching another mark.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.marks.test.ts:325-457`, commits `861470c`, `e170faa`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-ANN-120: Reindex links on instance removal
`req~ann-120~1`

When a repeatable instance is removed, the system shall shift linked-field paths and AI marks of the surviving instances, drop links belonging to the removed instance, and scope the change to the acting seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reindex.test.ts:58-170`, commit `b9afb02`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-ANN-130: Three-section validation view
`req~ann-130~1`

The system shall split the Validation dialog into "Current paper" (always expanded, showing that paper's issues or "No problems"), "Other papers" (collapsed by default, header showing the combined problem count across those papers), and "Not started yet" (collapsed by default), each of the latter two independently expandable by clicking its header.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ValidationDialog.tsx:339-450`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-140: Filter papers within a validation section
`req~ann-140~1`

The system shall provide, for the "Other papers" and "Not started yet" sections, a text filter matching against paper title with a clear button and a case-sensitivity toggle, matching the paper list's own search controls.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ValidationDialog.tsx:13-17,67-117,366-372,427-433`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-150: Per-paper issue collapse in "Other papers"
`req~ann-150~1`

The system shall list each paper in "Other papers" collapsed to its title and problem count, expanding to show its issues when the paper row is clicked.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ValidationDialog.tsx:254-261,376-405`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-160: Jump to paper without closing Validation
`req~ann-160~1`

When a paper is jumped to via a paper row's jump control (Validation dialog or the "back"/"forward" navigation described in REQ-ANN-170), the system shall select that paper without closing the dialog; when an issue itself is clicked, the system shall additionally close the dialog.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ValidationDialog.tsx:220-252`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-170: Back/forward paper history in Validation
`req~ann-170~1`

The system shall record, in the Validation dialog, every paper jumped to as a browser-style history stack, provide back and forward controls (each disabled: but still hoverable with a tooltip naming why: when nothing lies in that direction) to step through it, and truncate any forward entries when a fresh jump is made from a position earlier than the end of the stack.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ValidationDialog.tsx:185-242,296-321`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-ANN-180: Confirm each metadata correction
`req~ann-180~1`

When the metadata correction mode is not `off`, the toolbar shall open a Metadata dialog. In a numbered human seat, the dialog shall show the current paper as an entry with editable title, authors, year and DOI. After "Check PDFs", the dialog shall add one entry per proposal (REQ-DAT-470). For each of these entries, the reviewer shall be able to edit the values, save the entry into the annotation file, skip the entry for this session or ignore a proposal permanently. "Save all" shall save every proposal at once. The update of the project file shall be a separate step (REQ-CON-530). Each confirmation shall be one undo step. The system shall change no paper without one of these confirmations.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/MetadataDialog.tsx` (`MetadataDialog`), `src/components/Toolbar.tsx`, `src/state/store.ts` (`applyMetadataEdits`)
- **Verified by:** `src/components/MetadataDialog.test.tsx` (`MetadataDialog`), `src/state/store.metadata.test.ts` (`applyMetadataEdits`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-ANN-200: Confirm each new PDF file
`req~ann-200~1`

When a scan finds new PDF files (REQ-DAT-540), the system shall show a dialog with one entry per file. Each entry shall show the proposed title, authors, year and DOI, and the source of each value (REQ-DAT-550). The user shall be able to edit each value. A value the user did not edit shall be added as found. The user shall be able to add the entry, skip the entry or ignore the file. "Add all" shall add each entry at once. A skipped file shall stay in the dialog as "Not added", and the next scan shall offer the file again. An ignored file shall go into the root key `ignoredPdfs`, and later scans shall not offer it. The system shall write only confirmed papers. Each confirmation shall be one undo step. A read-only project shall not change.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/PdfFolderDialog.tsx` (`PdfFolderDialog`), `src/state/store.ts` (`addPdfPapers`, `ignorePdfs`)
- **Verified by:** `src/components/PdfFolderDialog.test.tsx` (`PdfFolderDialog`), `src/state/store.pdfFolder.test.ts` (`addPdfPapers`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-ANN-210: Scan the PDF folder on open, on focus and on request
`req~ann-210~1`

When the project sets a PDF folder, the system shall scan it when the project opens and when the window gets the focus. The toolbar shall show a "Rescan" button that starts a scan and opens the dialog. An automatic scan shall open the dialog only when it finds a new file that the dialog did not show before in this session. The system shall not use a file watcher.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/App.tsx`, `src/components/Toolbar.tsx`, `src/state/store.ts` (`scanPdfFolder`)
- **Verified by:** `src/state/store.pdfFolder.test.ts` (`scanPdfFolder`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

## Paper list

### REQ-LST-10: List papers with status
`req~lst-10~1`

The system shall list all papers with title, authors, and a per-paper status indicator, showing a filtered count as "N of M" when a filter or search is active.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:396-451`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-LST-20: Two-mode search
`req~lst-20~1`

The system shall provide a paper search with a metadata mode (matching title, authors, DOI, abstract, PDF path, and identifier) and an annotations mode (matching the active seat's recorded values), requiring every whitespace-separated query word to match and ranking results by distinct words matched, then matched characters, then original order.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:187-189,366-394,452-488`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-LST-25: Case-sensitive paper search toggle
`req~lst-25~1`

The system shall provide an "Aa" toggle on the paper search box that switches word matching from case-insensitive (default) to exact-case, applying to whichever search mode (metadata or annotations) is active, and shall reset to case-insensitive when a different project is opened.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:187-192,269,281,324,378,391,484-496`, commit `f3eea85`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-LST-30: Five-state annotation indicator
`req~lst-30~1`

The system shall display per paper one of five annotation states: untouched, partial (with a proportional fill of filled versus counted fields), complete, finished, or flagged: each with a tooltip stating the state and the filled-field count, derived from live data at read time.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx` (`dotStateLabel`, `paperAnnotationState`), `src/model/annotationState.ts:36-95`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-LST-40: Annotation progress filter
`req~lst-40~1`

The system shall provide an annotation filter with the buckets all, open, in-progress (open and touched), finished, and with-issues, and shall display a progress line counting the selected bucket over all papers.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:335-363,496-510`, `src/model/annotationState.ts` (`annotationFiltersFor`, `matchesFilter`), commit `0cb3828`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-LST-50: Keyboard navigation
`req~lst-50~1`

The system shall expose the paper list as a listbox with a single roving tab stop where arrow keys move selection through visible rows and Enter or Space selects, and shall additionally step to the previous/next paper in filtered order via Alt+Arrow and the bare `[`/`]` keys outside text inputs and modals.

Comment:
- **Type:** Functional (ISO 25010: Usability: Accessibility)
- **Evidence:** `src/components/PaperList.tsx:402-440`, `src/hooks/useKeybindings.ts` (`useKeybindings`, `stepPaper`, `isEditable`), commit `8ef9279`
- **Status:** Implemented

Needs: impl

Tags: Functional, Usability_Accessibility

### REQ-LST-60: Search and completeness performance
`req~lst-60~1`

The system shall compute the search text and completeness of 2000 papers against a 30-field schema in under 150 milliseconds (best of three runs), and a single field edit shall change only the edited paper's object identity.

Comment:
- **Type:** Non-functional (ISO 25010: Performance Efficiency)
- **Evidence:** `src/components/PaperList.perf.test.ts:26,70-115`
- **Status:** Implemented

Needs: utest

Tags: NonFunctional, Performance_Efficiency

### REQ-LST-70: Resume where the reviewer left off
`req~lst-70~1`

When a project reopens, the system shall select the paper, PDF page, and intra-page scroll offset stored at last use (persisted locally per project path, debounced at 500 ms), falling back to the first paper the active seat has not finished; stored positions shall never be written to the project file, leak between projects, or survive the referenced paper's deletion.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:256-313`, `src/state/store.readingPosition.test.ts:73-143`, commits `bb44dc8`, `e8efa2e`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-LST-80: Mark corrected metadata in the paper list
`req~lst-80~1`

The paper list and the annotation panel header shall show the corrected title and authors of the active seat. With one reviewer, the active seat shall be seat 1. The paper list shall show a badge on each paper with a corrected field. The badge tooltip shall name the corrected fields.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/metadata.ts` (`effectiveMetadata`, `editedFields`, `metadataSeatKey`), `src/components/PaperList.tsx`, `src/components/AnnotationPanel.tsx`
- **Verified by:** `src/model/metadata.test.ts` (`editedFields`), `src/components/MetadataDialog.test.tsx` (`paper list badge`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-LST-90: Mark a missing PDF file in the paper list
`req~lst-90~1`

After a scan, the paper list shall show the badge "missing" on each paper whose PDF file the system cannot find. The system shall keep the paper and its annotations.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/pdfFolder.ts` (`missingPaperIds`), `src/state/store.ts` (`scanPdfFolder`), `src/components/PaperList.tsx`
- **Verified by:** `src/model/pdfFolder.test.ts` (`missingPaperIds`), `src/state/store.pdfFolder.test.ts` (`scanPdfFolder`), `src/components/PdfFolderDialog.test.tsx` (`PaperList missing PDF badge`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

## PDF viewer

### REQ-PDF-10: Render the paper's PDF
`req~pdf-10~1`

The system shall render the selected paper's PDF with all pages mounted, fit to pane width, capping rendering at 5000 pages while displaying the claimed count.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:23,1376-1414,1537-1547`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-20: Zoom controls
`req~pdf-20~1`

The system shall zoom the PDF between 0.4× and 3× in 0.2 steps via toolbar buttons, Ctrl/Cmd plus/minus/zero shortcuts, and Ctrl/Cmd+wheel.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:333-335,1694-1706`, `src/components/PdfViewer.tsx:437-443,1286-1297`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-30: Page navigation
`req~pdf-30~1`

The system shall provide previous/next page buttons and an editable page input clamped to the valid page range, tracking the current page from the scroll position.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:567-587,621-703,1508-1558`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-40: Jump history for internal links
`req~pdf-40~1`

When an internal PDF link jump moves the view, the system shall record the prior position on a back stack and provide back/forward navigation between recorded positions.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:428-435,1076-1099,1484-1507`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-50: In-PDF text search
`req~pdf-50~1`

The system shall provide an in-PDF search opened with Ctrl/Cmd+F that matches text across page text layers with a 150 ms input debounce, displays the match count, cycles matches with Enter and Shift+Enter, highlights and centers the active match, and closes with Escape.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:98-136,390-405,1246-1280,1618-1673`, commit `c206c49`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-55: Case-sensitive in-PDF search toggle
`req~pdf-55~1`

The system shall provide an "Aa" toggle on the in-PDF search box that switches text-layer matching from case-insensitive (default) to exact-case.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:100,393,1359,1363,1646-1659`, commit `f3eea85`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-60: Capture normalized text selection
`req~pdf-60~1`

When text is selected in the PDF, the system shall capture the selection normalized to Unicode NFC form for use by field grabbing and highlighting.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:705-717`, commit `d335151`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-70: Create highlights from selections
`req~pdf-70~1`

When a non-empty text selection exists, the system shall offer a five-color swatch toolbar near the selection end that creates a highlight of the chosen color and opens its comment popover, with the key `a` applying the first color.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:840-998,1327-1344`, commit `b2e2195`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-80: Cross-page highlights
`req~pdf-80~1`

When a selection spans a page boundary, the system shall split the highlight into per-page fragments sharing one group identifier, clipping probable running headers and footers from intermediate boundaries, and shall apply comment, color, link, and delete operations to all fragments together.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:840-998,1784-1806`, commits `0e524d7`, `502efe9`, `bacbaf3`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-90: Sticky notes
`req~pdf-90~1`

The system shall provide a note-placement mode in which one click places a note marker at that point and opens its comment popover.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1052-1070,1675-1686`, commit `8cf1ff1`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-100: Edit marks via popover
`req~pdf-100~1`

When a mark is clicked, the system shall open a popover offering recoloring among the five palette colors, comment editing, listing and unlinking of linked fields, and deletion with a confirmation when the mark is linked as evidence.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1808-1887`, commit `135a385`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-110: Per-seat mark scoping
`req~pdf-110~1`

The system shall store marks per reviewer seat as overlay data with page-fraction coordinates, never writing into the PDF file, so that each seat sees only its own marks and marks stay valid across zoom and resolution changes.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfMarks.ts:1-79`, `src/state/store.ts:928-953`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-120: Mark edits are undoable
`req~pdf-120~1`

The system shall record highlight creation, recoloring, deletion, and comment editing in the undo history, coalescing consecutive comment keystrokes into one undo step.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.marks.test.ts:52-323`, commit `316b304`
- **Status:** Implemented

Needs: utest

Tags: Functional, Functional_Suitability

### REQ-PDF-130: Mark cycling in reading order
`req~pdf-130~1`

The system shall provide previous/next controls that step through the seat's marks in reading order (page, then column, then vertical position), counting a cross-page group once and flashing each visited mark.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1024-1034,1687-1711`, `src/model/pdfMarks.ts` (`sortMarksForCycling`, `columnOf`), commit `61a2aa4`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-140: Selection through marks
`req~pdf-140~1`

The system shall allow text selection by dragging across an existing mark while a plain click on the mark still opens its popover.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:719-788`, commit `d4c20e2`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-150: Reference hover previews
`req~pdf-150~1`

When an internal PDF link is hovered, the system shall show a preview image of the destination cropped to the destination entry where detectable, falling back to a page-region crop, capped at 560×240 CSS pixels; external links shall open in the system browser.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:180-218,1109-1218`, `src/model/refPreview.ts:22-152`, commits `1d07bd3`, `80dece2`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-160: Export marks into a PDF
`req~pdf-160~1`

When the export action is triggered with at least one mark, the system shall write the active seat's highlights and notes as standard PDF Highlight and Text annotation objects, either to a new file (default name `<paper>-annotated.pdf`) or, after an explicit warning, over the original file, skipping out-of-range pages instead of failing.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfExport.ts:27-61`, `src/components/ExportPdfDialog.tsx:32-166`, commit `e22c157`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-PDF-170: Extract PDF metadata heuristically
`req~pdf-170~1`

When paper metadata is missing, the system shall attempt to extract title, authors, and abstract from the PDF, preferring plausibility-checked embedded metadata over first-page layout heuristics, and shall return nothing rather than implausible values.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfMeta.ts:1-120`, `src/model/pdfMeta.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-PDF-180: Extract page-ordered PDF text
`req~pdf-180~1`

The system shall extract PDF text as per-page blocks in reading order, normalized to Unicode NFC, capped at 2000 pages, skipping unreadable pages, and shall flag the result as empty when body text is under 200 non-whitespace characters.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfText.ts:22-152`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

## Workspace shell

### REQ-PDF-185: Show the screeners' highlights
`req~pdf-185~1`

When a project was started from a screening project that still sits next to it, and the screening project holds PDF highlights or notes for the current paper (matched by paper identifier, by the identifier the import assigned, or by DOI or title), the annotation panel shall offer a "Show markings from screening" checkbox with their count, and only then; when ticked, the viewer shall draw every screening seat's highlights and notes read-only and visually distinct from the user's own, naming on hover the seat that made each. Only a plain file name in the project's own directory shall be read as the screening project.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/screeningMarks.ts`, `src-tauri/src/project.rs` (`project_screening_source`), `src/state/store.ts` (`loadScreeningMarks`), `src/components/AnnotationPanel.tsx`, `src/components/PdfViewer.tsx`, commit `780f1d1`
- **Verified by:** `src/model/screeningMarks.test.ts`, `src/state/store.screeningMarks.test.ts`, `src/components/AnnotationPanel.test.tsx` (`offers the box only on a paper the screening marked`), `src-tauri/src/project.rs` (`screening_source_reads_only_a_plain_sibling`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-PDF-190: Single-page view
`req~pdf-190~1`

The PDF toolbar shall have a page-icon toggle next to the zoom controls. If the toggle is on, the viewer shall show only the current page, fitted to the pane at zoom 100 %. The mouse wheel shall flip to the next page when the page is at its bottom edge and to the previous page when it is at its top edge. If the page is zoomed in and can scroll, the wheel shall scroll inside the page first. The system shall keep the setting in the local storage of the application.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/PdfViewer.tsx` (`PdfViewer`), `src/locales/en.json` (`pdf.singlePage`)
- **Verified by:** `src/components/PdfViewer.chrome.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-10: Global keyboard shortcuts
`req~ui-10~1`

The system shall provide keyboard shortcuts for save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), open (Ctrl/Cmd+O), undo/redo, help (F1), settings (Ctrl/Cmd+,), PDF zoom, and application font size, suppressing bare-key shortcuts while typing or while a modal is open, and shall document all shortcuts in a Help dialog with mode-specific tables.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useKeybindings.ts` (`useKeybindings`, `stepPaper`, `isEditable`), `src/components/HelpDialog.tsx:10-62`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-20: Toolbar project controls
`req~ui-20~1`

The system shall provide a toolbar with, on the left, a Close project icon button left of the app title (always present so the title does not shift; hidden and disabled without a project; tooltip and accessible name "Close project"), an Open menu (file, remote git clone, recents with removal), a Save menu (save, save-as, autosave toggle) and a Git button disabled with a reason-specific tooltip when unavailable; on the right, a transient saved status, status badges (stashed, behind, unreadable files), a "Review tools" group holding Validate and AI, font-size controls, a theme toggle, Settings, and Help. Toolbar buttons shall use a borderless ghost style with a hover tint.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx` (`Toolbar`, `requestCloseProject`)
- **Verified by:** `src/components/Toolbar.test.tsx` (`always renders Close project to keep the layout stable, hidden and disabled without a project`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-UI-25: Project in the window title
`req~ui-25~1`

The system shall show the open project's title (else its file name) in the native window title as "<project> - SaiLoR", shall prefix "● " while the project has unsaved changes, and shall show "SaiLoR" when no project is open.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useWindowTitle.ts`, `src/platform/tauri.ts` (`setWindowTitle`), `src-tauri/capabilities/default.json`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-30: Seat switcher in toolbar
`req~ui-30~1`

When a multi-reviewer project is open, the system shall display a seat switcher in the toolbar, as numbered pills plus a distinct Consolidation control for up to five reviewers and as a labeled dropdown above that, and shall badge the active seat on the annotation panel title.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx:26-32,341-398`, `src/components/AnnotationPanel.tsx:204-212`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-40: Resizable panes
`req~ui-40~1`

The system shall let the user resize the three panes via pointer-driven splitters supporting touch input, persisting the widths locally within clamped bounds.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Splitter.tsx:11-44`, `src/state/settings.ts`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-50: Clipboard fallback
`req~ui-50~1`

When copying text, the system shall try the asynchronous Clipboard API, fall back to a hidden-textarea copy command, and report failure as a result value rather than an exception.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/clipboard.ts:9-30`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-60: Surface load and save errors
`req~ui-60~1`

When a project load or save fails, the system shall display a dismissible full-screen error panel with the message and detail lines.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ErrorPanel.tsx:4-28`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-UI-70: Button tooltips
`req~ui-70~1`

The system shall give every button throughout the application (toolbar, dialogs, prompts, and inline controls) a descriptive mouse-over tooltip stating the action it performs; where a button's state or availability is dynamic, the tooltip shall reflect that state, and a disabled button shall state the reason it is disabled.

Comment:
- **Type:** Non-functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx`, `src/App.tsx`, and every dialog/prompt component under `src/components/`
- **Status:** Implemented

Needs: impl

Tags: NonFunctional, Usability

### REQ-UI-80: View-only mode
`req~ui-80~1`

The toolbar shall offer a "View only" checkbox for every open project, independent of the number of reviewers. While it is checked, the system shall ignore every action that changes annotations, marks, finished flags, screening decisions, consolidation results or undo history, whether it comes from the form, the PDF viewer, a keyboard shortcut or an AI run. The annotation form, the screening panel, the PDF highlight, note, recolor, comment, unlink and delete controls, the consolidation resolve dialog and the AI button shall be disabled or hidden. On the Consolidation seat the automatic reviewer comparison (matching, adoption of unanimous values, update prompt) shall not run; only the stored consolidation is shown. Navigation, reading and seat switching shall stay available. The setting applies to the session only and is off after a restart.

Comment:
- **Type:** Functional (ISO 25010: Usability / Security: Integrity)
- **Evidence:** `src/state/store.ts` (`readOnly`, `setReadOnly`), `src/components/Toolbar.tsx`, `src/components/AnnotationPanel.tsx`, `src/components/ScreeningPanel.tsx`, `src/components/PdfViewer.tsx`, `src/hooks/useConsolidationAlignment.ts`, `src/state/store.readOnly.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability, Security_Integrity

### REQ-UI-90: Settings dialog
`req~ui-90~1`

The system shall show user settings in one Settings dialog. The dialog shall have a General section, a Language section (REQ-UI-110), an AI section and a Git section. The General section shall set the theme, the app font size and autosave. These values shall persist in the same local storage keys as the toolbar controls. The AI section shall open the existing AI models dialog for providers, API keys and local models. The Git section shall show the detected git version or the reason git is not available. Project settings shall stay in the project file. The dialog shall move focus into itself and keep Tab and Shift+Tab inside. Escape, the close button and a click outside the dialog shall close it. When the dialog closes, focus shall go back to the previous element. Each section and control shall have an accessible label.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/SettingsDialog.tsx` (`SettingsDialog`, `SETTINGS_SECTIONS`), `src/state/store.ts` (`userSettingsOpen`, `setUserSettingsOpen`), `src/state/settings.ts`, `src/components/SettingsDialog.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-100: Open the Settings dialog
`req~ui-100~1`

The system shall open the Settings dialog by a click on the SaiLoR title in the toolbar. The title shall look like a button: it shall show a sliders icon, a chevron and a hover state. It shall also open the dialog with Ctrl/Cmd+, unless another dialog is open. On Windows and Linux, the File menu shall have a "Settings…" item. On macOS, the app menu shall have a "Settings…" item with Cmd+,. The menu items shall send the `app:settings` event to the page.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx`, `src/hooks/useKeybindings.ts`, `src/hooks/useCloseGuard.ts`, `src/platform/tauri.ts` (`onOpenSettings`), `src-tauri/src/shell.rs` (`action`, `menu`, `macos_menu`), `src/components/HelpDialog.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Usability

### REQ-UI-110: Language setting
`req~ui-110~1`

The Settings dialog shall have a Language section with one choice per supported language. The supported languages shall be English, German, Chinese (Simplified), Persian, Spanish, French, Italian, Portuguese and Japanese. Each choice shall show the language name in that language. The system shall store the choice in the local storage key `slr.language`. When no valid choice is stored, the system shall use the language of `navigator.language` if it is supported, else English. A change shall apply at once to the open window, without a restart and without a change to the project. The system shall set the `lang` attribute of the document to the active language. REQ-UI-140 sets the text direction.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/SettingsDialog.tsx` (`LanguageSection`, `SETTINGS_SECTIONS`), `src/state/settings.ts` (`loadLanguage`, `saveLanguage`), `src/i18n.ts` (`setLanguage`, `useLanguage`)
- **Verified by:** `src/state/settings.test.ts` (`language`), `src/components/SettingsDialog.test.tsx` (`switches the dialog to German and stores the choice`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-120: Translated user interface
`req~ui-120~1`

The system shall take each user-visible text of the renderer from the active language. This includes labels, buttons, titles, tooltips, accessible labels, dialogs, confirmations, status messages, validation messages and the help dialog. The system shall not translate schema field names, project data, AI prompts, requirement IDs, raw output of git or file formats. If the active language has no text for a key, the system shall show the English text. For a count, the system shall use the plural form of the active language. If the language has no text for that form, the system shall use the `_other` text. Dates and numbers shall use `Intl` formats of the active language.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/i18n.ts` (`t`, `tp`, `rich`, `useT`), `src/locales/en.json`, `src/components/`
- **Verified by:** `src/i18n.test.ts` (`t`, `tp`, `rich`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-130: Complete language files
`req~ui-130~1`

Each language file shall have exactly the keys of the English file. For each key, the text in each language shall have the same `{name}` placeholders and the same markup tags as the English text. An automated test shall fail if a language file has a missing key, an extra key or a different placeholder.

Comment:
- **Type:** Non-functional (ISO 25010: Maintainability: Testability)
- **Evidence:** `src/locales/en.json`, `src/i18n.ts` (`MESSAGES`)
- **Verified by:** `src/i18n.test.ts` (`language files`)
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Maintainability_Testability

### REQ-UI-140: Right-to-left layout
`req~ui-140~1`

When the active language is written right to left, the system shall set the `dir` attribute of the document to `rtl`. For all other languages, it shall set `dir` to `ltr`. Persian is the only right-to-left language. In a right-to-left layout, the panes, toolbars, menus and dialogs shall be mirrored. A drag on a pane divider shall move the divider with the pointer. Code, keyboard keys and the PDF pages shall stay left to right.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/i18n.ts` (`applyToDocument`), `src/components/Splitter.tsx` (`offsetFromStart`), `src/App.tsx`, `src/styles/index.css`
- **Verified by:** `src/i18n.test.ts` (`sets the text direction of the document from the language`), `src/components/Splitter.test.tsx` (`offsetFromStart`)
- **Status:** Implemented. The mirrored layout was checked only in jsdom, not in the desktop WebViews.

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-150: Open the Settings dialog from the help
`req~ui-150~1`

The Help dialog shall have an "Open settings" button. The button shall close the Help dialog and open the Settings dialog. On Windows and Linux, the Help menu shall have a "Settings…" item. On macOS, the Help menu shall also have a "Settings…" item. These Help menu items shall have no keyboard shortcut. They shall send the `app:settings` event to the page, as in REQ-UI-100.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/HelpDialog.tsx` (`HelpDialog`), `src-tauri/src/shell.rs` (`action`, `menu`, `macos_menu`)
- **Verified by:** `src/components/HelpDialog.test.tsx`, `src-tauri/src/shell.rs` (`help_menus_open_settings_without_a_shortcut`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-160: Show project entries only with a project
`req~ui-160~1`

The toolbar shall show the Save menu, the Graph menu, the Git button and the Validate button only when a project is open. The toolbar shall have no knowledge graph button. The Graph menu shall sit on the left of the toolbar, after the Save menu. The Graph menu shall have the items "Explore knowledge graph" and "Knowledge graph", in this order. The "Knowledge graph" item shall open the export dialog of REQ-DAT-520. The Save menu shall have the same "Knowledge graph" item.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx` (`Toolbar`)
- **Verified by:** `src/components/Toolbar.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-170: Hide AI entries when AI is off
`req~ui-170~1`

If no open project turns AI on, the system shall show no AI entry. The toolbar shall have no AI button. The Settings dialog shall have no AI section. The project editor shall have no prompt override section. The Consolidation overview shall have no AI evaluation button. When the project turns AI on, the Consolidation overview shall show the "AI evaluation" button, and the system shall show the other entries again.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx` (`Toolbar`), `src/components/SettingsDialog.tsx` (`SettingsDialog`), `src/components/ProjectEditor.tsx`, `src/components/ConsolidationOverview.tsx` (`ConsolidationOverview`)
- **Verified by:** `src/components/Toolbar.test.tsx`, `src/components/SettingsDialog.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-180: Keep focus inside open dialogs
`req~ui-180~1`

The system shall build every dialog and prompt from one shared frame. The frame shall mark the dialog as modal. When the user presses Tab on the last control, focus shall move to the first control. When the user presses Shift+Tab on the first control, focus shall move to the last control. A click on the overlay shall call the close handler of the dialog. A click inside the dialog shall not close it.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Modal.tsx` (`Modal`)
- **Verified by:** `src/components/Modal.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-190: Knowledge graph view
`req~ui-190~1`

The Result view menu (REQ-UI-270) shall have an "Explore knowledge graph" item as its first item. The item shall open the result view on the "Knowledge graph" tab. The view shall show the papers, authors, venues, keywords and answers of the knowledge graph of REQ-DAT-480 and REQ-DAT-490 as nodes and edges in a force layout on a canvas. The user shall pan the graph with a drag on the background. The user shall zoom with the mouse wheel and with the "Zoom in", "Zoom out" and "Reset view" buttons. "Reset view" shall fit all placed nodes into the canvas. The user shall move a node with a drag. A click on a node shall select it. When the pointer is on a node, the canvas shall show the type and label of the node as a tooltip. A double-click on a node shall add its neighbours to the view. The side panel shall show the label, type, DOI, year and values of the selected node and list its neighbours. The "Show neighbours" button shall add the neighbours of the selected node to the view. A "Nodes" button shall open a foldout drawer on the start side of the canvas. The drawer shall be closed at first. The drawer shall list every shown node as a button, as an accessible alternative to the canvas. The node list and the neighbour list shall show 200 entries at first. A "Show more" button shall add the next 200 entries. A click on a listed node shall select it and center the view on it. If the project has more than one reviewer, the view shall have a seat selector. The selector shall list every reviewer seat and, if one paper or more has a consolidated answer, the "Consolidation". The consolidation shall be selected at first if it exists. At the top end of the graph area, the view shall have a "Download" button that saves the graph as an image (REQ-UI-260). The view shall have an "Export…" button that opens the export dialog of REQ-DAT-520. Escape shall close the view when the export dialog is not open. A click on the overlay shall not close the view.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/GraphView.tsx` (`GraphView`), `src/components/Toolbar.tsx` (`Toolbar`), `src/styles/index.css` (`.graph-view`)
- **Verified by:** `src/components/GraphView.test.tsx`, `src/components/Toolbar.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-200: Knowledge graph query
`req~ui-200~1`

The knowledge graph view shall have a query box. The view shall apply the query when the user presses Enter or the "Show" button. A query shall be a list of terms separated by spaces. A node shall match a query when it matches every term. Text comparison shall ignore case. A word or a "quoted phrase" shall match a node whose label, DOI, year, abstract or answer value contains the text. `type:T` shall match nodes of type T, where T is `paper`, `author`, `venue`, `keyword`, `choice` or `answer`. `paper:X`, `author:X`, `venue:X`, `keyword:X`, `choice:X` and `answer:X` shall match nodes of that type whose text contains X. `field:F` shall match nodes that have an answer for field F. `F=V` and `F:V` shall match nodes that have the answer V for field F. A field name shall match the full field path or its last path segment. A `-` before a term shall exclude the nodes that match the term. `depth:N` shall set the neighbour depth of REQ-UI-210 from 0 to 3. The default depth shall be 1. A larger N shall count as 3. A paper and an answer group shall also match the answers below them, nested answers included. An empty query shall match every node. The view shall show the query syntax below the query box.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/graphQuery.ts` (`parseQuery`, `indexGraph`), `src/components/GraphView.tsx` (`GraphView`)
- **Verified by:** `src/model/graphQuery.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-210: Knowledge graph sub-graph and performance
`req~ui-210~1`

The view shall show the nodes that match the query of REQ-UI-200 and their neighbours up to the query depth, in both edge directions. The view shall show only the edges between shown nodes. The view shall mark the matching nodes. The view shall have no node limit. Neighbours that the user adds with REQ-UI-190 shall stay in the view until the next query. If no node matches, the view shall show "No node matches the query." The view shall draw only the nodes and edges in the visible area of the canvas. The view shall draw node labels only at a zoom of 0.6 or more and only when 2000 or fewer nodes are visible. The view shall calculate the force layout in a background worker. The worker shall send the node positions while the layout runs. The worker shall stop when the layout is stable. For more than 1000 nodes, the layout shall use fewer steps and a coarser force approximation. The view shall draw a new frame only when the positions or the view change. The automated benchmarks shall use generated graphs with 10 000 and 50 000 nodes. For 50 000 nodes, the benchmarks shall prepare one frame in less than 1 second, calculate one layout step in less than 1.5 seconds and find the node at the pointer in less than 1 millisecond on average.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Performance Efficiency)
- **Evidence:** `src/model/graphQuery.ts` (`selectSubgraph`, `neighbours`), `src/model/graphLayout.ts` (`createLayout`, `layoutHost`, `layoutSettings`), `src/model/graphLayout.worker.ts`, `src/components/graphCanvas.ts` (`cull`, `drawScene`, `hitTest`), `src/components/GraphView.tsx` (`GraphView`)
- **Verified by:** `src/model/graphQuery.test.ts`, `src/model/graphLayout.test.ts`, `src/components/graphCanvas.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Performance_Efficiency

### REQ-UI-220: Knowledge graph relations
`req~ui-220~1`

The knowledge graph view shall draw each edge type with its own colour and line style: answer (solid), authored by (dashed), published in (dotted), keyword (dash-dot) and cites (long dash). The view shall draw solid lines at a zoom below 0.3. At a zoom of 0.8 or more, the view shall draw an arrowhead at the target end of each visible edge. When the pointer is on an edge and not on a node, the canvas shall show the edge type, the source label and the target label as a tooltip. When a node is selected, the view shall draw its edges and its neighbours strong and dim the other nodes and edges. The view shall have a "Relations" legend with one checkbox per edge type. A cleared checkbox shall hide the edges of that type. Hidden edges shall not show a tooltip and shall not count for the selection highlight. The view shall draw all edges of one type in one path. The view shall read the edge colours again when the theme changes. The automated benchmarks of REQ-UI-210 shall use all edge types. For 50 000 nodes, they shall draw a zoomed-in frame with arrowheads and a selection in less than 500 milliseconds, select a node in less than 100 milliseconds and find the edge at the pointer in less than 25 milliseconds on average.

Comment:
- **Type:** Functional (ISO 25010: Usability, Performance Efficiency)
- **Evidence:** `src/components/graphCanvas.ts` (`buildScene`, `drawScene`, `selectNode`, `edgeAt`), `src/components/GraphView.tsx` (`GraphView`), `src/styles/index.css` (`.graph-legend`)
- **Verified by:** `src/components/graphCanvas.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability, Performance_Efficiency

### REQ-UI-230: Knowledge graph Cypher query
`req~ui-230~1`

A query that starts with `MATCH` in any letter case shall run as a read-only Cypher query. All other queries shall run as REQ-UI-200 queries. A Cypher query shall have one or more `MATCH` clauses, each with an optional `WHERE`, then one `RETURN` and an optional `LIMIT`. A `MATCH` pattern shall support node variables, the node labels `Paper`, `Author`, `Venue`, `Keyword`, `Choice` and `Answer`, inline properties `{key: value}`, the relationship types `authoredBy`, `publishedIn`, `hasKeyword`, `cites` and `hasAnswer` with `|` alternatives, the directions `->`, `<-` and `-`, and variable lengths `*`, `*N`, `*N..M` and `*..M`. Labels and types shall ignore letter case and underscores. One `MATCH` clause shall use each relationship at most once. Different `MATCH` clauses can use the same relationship. `WHERE` shall support `=`, `<>`, `<`, `<=`, `>`, `>=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`, parentheses, strings, numbers, lists, `true`, `false` and `null`, with Cypher null logic. Text comparisons shall be case-sensitive. A node shall have the properties `id`, `type`, `label`, `field`, `doi`, `year`, `abstract` and its answer values by field name. A relationship shall have the properties `type` and `field`. `RETURN` shall support variables, properties, literals, `count(*)`, `DISTINCT` and `AS`. `count(*)` shall group the rows by the other columns. The view shall show the nodes and relationships of all matches and mark the returned nodes. The side panel shall show the row count and a table of the first 200 rows. If the query has an error, the view shall show the reason and the position of the error and keep the previous result. The view shall show an example query below the query box. The help text shall state that a bare `*` means 1 to 3 steps, that one `MATCH` clause uses each relationship at most once and that text comparisons are case-sensitive.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/graphCypher.ts` (`isCypher`, `parseCypher`, `runCypher`, `cypherSubgraph`, `formatValue`), `src/components/GraphView.tsx` (`GraphView`), `src/styles/index.css` (`.graph-results`, `.graph-error`), `src/locales/en.json` (`graphView.cypherHelp`)
- **Verified by:** `src/model/graphCypher.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-240: Knowledge graph Cypher limits and safety
`req~ui-240~1`

A Cypher query shall only read the graph. `CREATE`, `MERGE`, `DELETE`, `DETACH`, `SET`, `REMOVE`, `OPTIONAL`, `WITH`, `UNWIND`, `CALL`, `ORDER`, `SKIP`, `UNION`, `LOAD` and `FOREACH` shall give the error "is not supported". Functions other than `count(*)` shall give an error. Unknown labels, relationship types and variables shall give an error. A query shall have at most 4000 characters. A query shall nest at most 32 expressions and have at most 32 patterns and relationships. A variable-length relationship shall have at most 3 steps. A bare `*` shall mean 1 to 3 steps. A result shall have at most 10 000 rows. A query shall stop after 2 000 000 steps of work. A query that stops at a row or work limit shall show that the result is incomplete. The lexer shall run in linear time. Property names such as `__proto__` and `constructor` shall read only the own answer values of a node. The automated benchmarks shall use a generated graph with 150 000 nodes and 600 000 relationships. On this graph, they shall run a label filter in less than 1 second, a one-step join in less than 3 seconds, a count grouped by year in less than 5 seconds and a query that reaches the work limit in less than 5 seconds.

Comment:
- **Type:** Non-functional (ISO 25010: Security, Performance Efficiency)
- **Evidence:** `src/model/graphCypher.ts` (`parseCypher`, `runCypher`, `MAX_INPUT`, `MAX_NESTING`, `MAX_HOPS`, `MAX_ROWS`, `MAX_WORK`)
- **Verified by:** `src/model/graphCypher.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Security, Performance_Efficiency

### REQ-UI-250: Knowledge graph Cypher query in a background worker
`req~ui-250~1`

A Cypher query of REQ-UI-230 shall run in a background worker and not on the main thread. If the platform has no worker, the query shall run in the same code on the main thread. The view shall copy the graph to the worker and index it there only once per graph, not once per query. The worker shall apply the row and work limits of REQ-UI-240. While a query runs, the status line shall show "Running the query…" and the view shall stay usable. A new query, a text query or closing the view shall stop the running query, and the view shall ignore its result. If a query runs longer than 20 seconds, the view shall stop the worker and show an error with the time limit. If the worker fails, the view shall show the reason as an error. After a stop or an error, the next query shall start a new worker. The automated benchmarks shall copy and index the graph of REQ-UI-240 in the worker code in less than 20 seconds.

Comment:
- **Type:** Non-functional (ISO 25010: Performance Efficiency, Usability)
- **Evidence:** `src/model/graphCypher.ts` (`cypherHost`), `src/model/graphCypher.worker.ts`, `src/components/GraphView.tsx` (`startCypherWorker`, `GraphView`, `CYPHER_TIMEOUT_MS`)
- **Verified by:** `src/model/graphCypher.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Performance_Efficiency, Usability

### REQ-UI-260: Knowledge graph image download
`req~ui-260~1`

The view shall have a "Download" button at the top end of the graph area. The button shall open a panel in which the user selects the image format, SVG or PNG, and the area, "Visible section" or "Whole graph, including the part not visible". The visible section shall be the current view of the canvas. The whole graph shall contain every placed node of the shown sub-graph, at a scale of 1 or less and with at most 8192 pixels on the longest side. The image shall show the shown nodes and the edge types that are not hidden, and so respect the current query and filter, or the whole graph if there is no filter. The image shall not show the hover and the selection. The system shall save the image through the save dialog of the system and show the saved path or the error. The system shall write the image only to a path that the save dialog returned (REQ-PLT-260).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/graphImage.ts` (`imageFrame`, `sceneToSvg`, `sceneToPng`), `src/components/GraphDownload.tsx` (`GraphDownload`), `src/components/GraphView.tsx` (`GraphView`), `src-tauri/src/pdf.rs` (`export_write_bytes`)
- **Verified by:** `src/components/graphImage.test.ts`, `src/components/GraphView.test.tsx`, `src-tauri/src/pdf.rs` (`export_write_bytes_needs_a_picked_path`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-270: Result view menu and tabs
`req~ui-270~1`

The toolbar shall have a "Result view" menu. The menu shall have the items "Explore knowledge graph" and "Create diagrams", in this order. The menu shall not have the graph export; the Save menu has it (REQ-DAT-520). "Explore knowledge graph" shall open the result view on the "Knowledge graph" tab (REQ-UI-190). "Create diagrams" shall open the result view on the "Diagrams" tab (REQ-UI-280). The result view shall be one dialog named "Result view" with the tabs "Knowledge graph" and "Diagrams" in a tab list. The user shall switch the tab without closing the dialog. The dialog shall have a "Close" button. The knowledge graph tab shall have an "Export…" button in its toolbar that opens the export dialog of REQ-DAT-520.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx` (`Toolbar`), `src/components/ResultView.tsx` (`ResultView`), `src/styles/index.css` (`.result-head`, `.result-tabs`), `src/locales/en.json` (`toolbar.graphMenu`, `resultView.*`)
- **Verified by:** `src/components/Toolbar.test.tsx`, `src/components/DiagramView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-280: Diagram view and settings
`req~ui-280~1`

The "Diagrams" tab shall show a settings panel and a live preview of the diagram. If the project has more than one reviewer, the panel shall have a seat selector like REQ-UI-190. The panel shall let the user select the chart type, "Bar", "Stacked bar", "Line", "Pie" or "Heat map", the dimension counted on the x axis, an optional dimension that splits the papers into series ("No split" at first), the order "By name or number" or "By paper count", the largest number of categories and series, and whether papers without a value count as one category. A dimension shall be the year, venue, author or keyword of a paper, or any field of the annotation schema, shown by its schema path. The panel shall let the user set the title, the x axis label, the y axis label, the palette, the colour of each series, whether the legend and the value labels show, and the width and height of the diagram. The panel shall have a "Reset settings" button for all settings. The preview shall update after each change of a setting. Escape shall close the view. If no paper has a value, the view shall show a message and disable the export.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/DiagramView.tsx` (`DiagramView`), `src/model/diagram.ts` (`DiagramConfig`, `DEFAULT_CONFIG`, `schemaDimensions`), `src/locales/en.json` (`diagram.*`)
- **Verified by:** `src/components/DiagramView.test.tsx`, `src/model/diagram.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-290: Diagram data aggregation
`req~ui-290~1`

The system shall read the values of a dimension from the knowledge graph of REQ-DAT-480 for the selected seat. The system shall count each paper once per category. A paper with several values for the x dimension shall count in each category. A paper without a value shall be left out, or counted as "(none)" if the user selects this. If the number of categories or series is more than the limit, the system shall keep the biggest ones and merge the rest into "Other". Categories shall sort in natural order, with numbers by value, or by count in descending order. A line chart shall always use the natural order.

Comment:
- **Type:** Functional (ISO 25010: Functional Correctness)
- **Evidence:** `src/model/diagram.ts` (`paperValues`, `aggregate`)
- **Verified by:** `src/model/diagram.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Correctness

### REQ-UI-300: Diagram rendering
`req~ui-300~1`

The system shall render a diagram as one standalone, well-formed XML SVG document with a white background, the title, the axis labels, a grid with ticks of 1, 2 or 5 times a power of ten, the legend, value labels and a tooltip with the count for each mark. The system shall escape all text from the user and from the project. Series without a chosen colour shall use the palette in order. The palettes shall be colour-blind safe. The preview shall show the SVG as an image and not insert it into the page.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Security)
- **Evidence:** `src/model/diagramSvg.ts` (`renderDiagram`, `niceStep`, `seriesColor`), `src/components/DiagramView.tsx` (`DiagramView`)
- **Verified by:** `src/model/diagram.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Security

### REQ-UI-310: Diagram creation in a background worker
`req~ui-310~1`

The system shall build the graph, aggregate the data and render the SVG in a background worker and not on the main thread. If the platform has no worker, the system shall run the same code on the main thread. The view shall copy the project to the worker without abstracts, annotations and reviews, once per project and seat. The view shall wait 120 milliseconds after the last setting change before it asks for a new diagram. The view shall ignore the result of an older request. While the worker runs, the status line shall show "Creating the diagram…". If the worker fails, the view shall show the reason as an error.

Comment:
- **Type:** Non-functional (ISO 25010: Performance Efficiency)
- **Evidence:** `src/model/diagram.ts` (`diagramHost`, `slimProject`), `src/model/diagram.worker.ts`, `src/components/DiagramView.tsx` (`DiagramView`)
- **Verified by:** `src/model/diagram.test.ts`, `src/components/DiagramView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Performance_Efficiency

### REQ-UI-320: Diagram export
`req~ui-320~1`

The view shall have the buttons "SVG", "PNG" and "PDF". Each button shall save the shown diagram through the save dialog of the system and show the saved path or the error. SVG shall save the SVG document as text. PNG shall save a raster image at twice the diagram size. PDF shall save one page that has the size of the diagram. The page shall hold vector graphics and text (REQ-UI-370). If the PDF needs a font for characters outside Helvetica, the system shall first ask the user whether to embed a font or to save SVG instead (REQ-UI-370). The system shall write the file only to a path that the save dialog returned (REQ-PLT-260). The system shall make the raster images on the main thread from the SVG. The export section shall stay at the bottom of the settings panel, inside a frame with an accent border that sets it apart from the other sections. The buttons "SVG", "PNG" and "PDF" shall be in one row and the button "CSV" (REQ-UI-340) shall be in a second row. All four buttons shall have the same style.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/DiagramView.tsx` (`DiagramView`), `src/components/diagramExport.ts` (`svgToPng`, `svgToPdf`), `src/model/imagePdf.ts` (`imagePdf`), `src-tauri/src/pdf.rs` (`text_export_extension`)
- **Verified by:** `src/components/DiagramView.test.tsx`, `src/model/diagram.test.ts` (`imagePdf`), `src-tauri/src/pdf.rs` (`text_export_extension_allows_known_extensions`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-330: Diagram filter, bar direction and shares
`req~ui-330~1`

The "Diagrams" tab shall let the user count only some papers. The user shall select a dimension and enter a text, "Only papers where [dimension] contains [text]". The system shall count a paper only if one of its values for that dimension contains the text, ignoring case and surrounding spaces. An empty text or "No filter" shall count all papers. For the chart types "Bar" and "Stacked bar" the panel shall have a "Horizontal bars" option that draws the bars from the left with the category names at the left. For the chart type "Stacked bar" the panel shall have a "Show shares of 100 %" option that scales each bar to 100 % and shows percentages in the axis, the value labels and the tooltips. The panel shall keep all settings when the user switches to the "Knowledge graph" tab and back.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/diagram.ts` (`aggregate`, `DiagramConfig`), `src/model/diagramSvg.ts` (`renderDiagram`), `src/components/DiagramView.tsx` (`DiagramView`), `src/components/ResultView.tsx` (`ResultView`), `src/locales/en.json` (`diagram.filter`, `diagram.horizontal`, `diagram.percent`)
- **Verified by:** `src/model/diagram.test.ts`, `src/components/DiagramView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-340: Diagram data table and CSV
`req~ui-340~1`

The "Diagrams" tab shall show the counts of the diagram in a table that the user can open under the preview, with one row per category and one column per series. The table shall be a text alternative to the image. The panel shall have a "CSV" button that saves the same counts as a CSV file through the save dialog of the system (REQ-PLT-260). The CSV file shall have a header row and shall neutralise cells that start with a formula character like REQ-DAT-510.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/diagram.ts` (`diagramCsv`, `DiagramReply`), `src/components/DiagramView.tsx` (`DiagramView`), `src/locales/en.json` (`diagram.table`, `diagram.export.csv`)
- **Verified by:** `src/model/diagram.test.ts`, `src/components/DiagramView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-350: Knowledge graph shortcuts
`req~ui-350~1`

If the selected node of the knowledge graph is a paper, the detail panel shall have an "Open paper" button. The button shall select that paper in the annotation view and close the result view. If a Cypher query shows a result table, the panel shall have a "Save table as CSV" button that saves the columns and rows through the save dialog of the system (REQ-PLT-260), with the cell rules of REQ-DAT-510.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/GraphView.tsx` (`GraphView`), `src/model/graph.ts` (`csv`), `src/locales/en.json` (`graphView.openPaper`, `graphView.cypher.saveCsv`)
- **Verified by:** `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-360: Knowledge graph statistics
`req~ui-360~1`

The detail panel of the knowledge graph shall have a collapsible "Statistics" section. The section shall show, for the nodes and edges that the graph shows, the number of nodes, the number of edges, the average degree, the number of connected components and the size of the largest component. The section shall list the five nodes with the highest degree. A click on a listed node shall select that node in the graph. The system shall ignore edges to unknown nodes.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/model/graphStats.ts` (`graphStats`), `src/components/GraphView.tsx` (`GraphView`), `src/locales/en.json` (`graphView.stats`)
- **Verified by:** `src/model/graphStats.test.ts`, `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-UI-370: Vector PDF export of diagrams
`req~ui-370~1`

The PDF button of the diagram view shall save a PDF with vector graphics and text that the user can select and zoom without loss. The system shall draw the SVG shapes (rectangle, line, polyline, circle, path, text) with the PDF fonts Helvetica and Helvetica-Bold. The PDF shall never hold a raster image. If the diagram has a character that Helvetica lacks, the system shall ask the user before it saves: "Embed a font, or save as SVG instead?" If the user chooses to embed, the system shall embed one TrueType system font that holds all these characters and set the text that needs it in this font. The system shall embed only the glyphs that the diagram uses, so the font adds only a few kilobytes to the PDF. The system shall add a ToUnicode map for the embedded font, so that the user can select, copy and search this text. The system shall set every character of the Windows-1252 (WinAnsi) set in Helvetica or Helvetica-Bold without an embedded font. The system shall not offer a font that forbids embedding in its licence. If no font can be embedded, the dialog shall offer only SVG and shall state the reason: the characters need text shaping (for example Arabic, Hebrew or Indic scripts), the computer has no usable font, or no installed font holds all the characters. Cancel shall save nothing.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Portability)
- **Evidence:** `src/model/vectorPdf.ts` (`svgToVectorPdf`, `nonWinAnsiChars`), `src/model/ttf.ts` (`parseTrueType`, `subsetTrueType`), `src/model/imagePdf.ts` (`pdfDocument`), `src/components/diagramExport.ts` (`svgToPdf`, `findPdfFont`), `src/components/PdfFontDialog.tsx`
- **Verified by:** `src/model/vectorPdf.test.ts`, `src/model/ttf.test.ts`, `src/components/diagramExport.test.ts`, `src/components/PdfFontDialog.test.tsx`, `src/components/DiagramView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Portability

### REQ-UI-380: Result view settings kept across sessions
`req~ui-380~1`

The system shall store the diagram settings and the knowledge graph filters (edge types and node types) in the local storage of the application. At the next start the result view shall use the stored values. The system shall check each stored value and use the default for a value that is invalid or broken. If the stored settings name a field that the schema of the open project lacks, the diagram view shall use the default for that field.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/state/resultSettings.ts`, `src/components/ResultView.tsx`, `src/components/DiagramView.tsx`, `src/components/GraphView.tsx`
- **Verified by:** `src/state/resultSettings.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-390: Knowledge graph node-type filter
`req~ui-390~1`

The detail panel of the knowledge graph shall have a "Node types" list with one check box for each node type in the graph. If the user clears a box, the graph shall hide the nodes of that type and the edges of those nodes. The statistics (REQ-UI-360) shall count only the shown nodes and edges.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/GraphView.tsx` (`GraphView`), `src/model/graph.ts` (`NODE_TYPES`), `src/locales/en.json` (`graphView.nodeTypes`)
- **Verified by:** `src/components/GraphView.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability
