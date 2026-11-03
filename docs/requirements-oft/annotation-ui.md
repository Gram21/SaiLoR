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

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-ANN-120: Reindex links on instance removal
`req~ann-120~1`

When a repeatable instance is removed, the system shall shift linked-field paths and AI marks of the surviving instances, drop links belonging to the removed instance, and scope the change to the acting seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reindex.test.ts:58-170`, commit `b9afb02`
- **Status:** Implemented

Needs: impl, utest

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

Needs: impl, utest

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

Needs: impl, utest

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

The system shall open the Settings dialog by a click on the SaiLoR title in the toolbar. It shall also open the dialog with Ctrl/Cmd+, unless another dialog is open. On Windows and Linux, the File menu shall have a "Settings…" item. On macOS, the app menu shall have a "Settings…" item with Cmd+,. The menu items shall send the `app:settings` event to the page.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/Toolbar.tsx`, `src/hooks/useKeybindings.ts`, `src/hooks/useCloseGuard.ts`, `src/platform/tauri.ts` (`onOpenSettings`), `src-tauri/src/shell.rs` (`action`, `menu`, `macos_menu`), `src/components/HelpDialog.tsx`
- **Status:** Implemented

Needs: impl

Tags: Functional, Usability

### REQ-UI-110: Language setting
`req~ui-110~1`

The Settings dialog shall have a Language section with one choice per supported language. The supported languages shall be English and German. Each choice shall show the language name in that language. The system shall store the choice in the local storage key `slr.language`. When no valid choice is stored, the system shall use the language of `navigator.language` if it is supported, else English. A change shall apply at once to the open window, without a restart and without a change to the project. The system shall set the `lang` attribute of the document to the active language.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/SettingsDialog.tsx` (`LanguageSection`, `SETTINGS_SECTIONS`), `src/state/settings.ts` (`loadLanguage`, `saveLanguage`), `src/i18n.ts` (`setLanguage`, `useLanguage`)
- **Verified by:** `src/state/settings.test.ts` (`language`), `src/components/SettingsDialog.test.tsx` (`switches the dialog to German and stores the choice`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-120: Translated user interface
`req~ui-120~1`

The system shall take each user-visible text of the renderer from the active language. This includes labels, buttons, titles, tooltips, accessible labels, dialogs, confirmations, status messages, validation messages and the help dialog. The system shall not translate schema field names, project data, AI prompts, requirement IDs, raw output of git or file formats. If the active language has no text for a key, the system shall show the English text. Dates and numbers shall use `Intl` formats of the active language.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/i18n.ts` (`t`, `tp`, `rich`, `useT`), `src/locales/en.json`, `src/locales/de.json`, `src/components/`
- **Verified by:** `src/i18n.test.ts` (`t`, `tp`, `rich`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-UI-130: Complete language files
`req~ui-130~1`

Each language file shall have exactly the keys of the English file. For each key, the text in each language shall have the same `{name}` placeholders and the same markup tags as the English text. An automated test shall fail if a language file has a missing key, an extra key or a different placeholder.

Comment:
- **Type:** Non-functional (ISO 25010: Maintainability: Testability)
- **Evidence:** `src/locales/en.json`, `src/locales/de.json`, `src/i18n.ts` (`MESSAGES`)
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
