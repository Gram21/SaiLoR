# Requirements — Annotation Form, Paper List & PDF Viewing

Requirements for the three-pane annotation workspace: the schema-driven form, the paper
list, the PDF viewer with highlights/notes, evidence linking, reading position, and PDF
export. See the [index](index.md) for the glossary.

---

## Annotation form

### REQ-ANN-10 — Render form from schema
- **Description:** The system shall render an annotation form for the selected paper by recursively traversing the project schema, presenting a schema-shaped empty form for a paper without recorded annotations.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:92-116`, `src/components/AnnotationNode.tsx`
- **Status:** Implemented

### REQ-ANN-20 — Type-specific field controls
- **Description:** The system shall present a checkbox for boolean fields, a numeric input for number fields, a numeric input bounded to 1000–2100 for year fields, a filtering combo box restricted to the defined options for enum fields, and an auto-expanding text area limited to 500 characters for free-text fields.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx:18,135-191,471-513`
- **Status:** Implemented

### REQ-ANN-30 — Conditional field visibility
- **Description:** When a node defines a `visibleIf` reference, the system shall show the node only while the referenced same-level or ancestor field is answered.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:195-211`, `src/components/AnnotationNode.tsx:115-135`, commits `254ad06`, `e1b3dd0`, `a5061b0`
- **Status:** Implemented

### REQ-ANN-40 — Cardinality-controlled instances
- **Description:** The system shall offer adding an instance of a repeatable node while the instance count is below the node's maximum, and removing an instance while the count exceeds the larger of the node's minimum and one.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationNode.tsx:67-93`, `src/model/annotations.ts:127-134`
- **Status:** Implemented

### REQ-ANN-50 — Grab value from PDF selection
- **Description:** When text is selected in the PDF viewer, the system shall offer per string, number, and year field a one-click insertion of the selection, taking the first numeric token for numbers (comma accepted as decimal separator) and a plausible four-digit year for year fields.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx:117-133,154-155,192-201`
- **Status:** Implemented

### REQ-ANN-60 — Field descriptions with links
- **Description:** The system shall show a field's description as a hover tooltip, shall open a persistent popover with selectable text and clickable http/https links on right-click, and shall open a single-link description's link directly on Ctrl/Cmd-click of the field name.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/NodeName.tsx:18-34,83-256`, `src/model/linkify.ts:14-55`, commits `2b66bac`, `4271e2e`
- **Status:** Implemented

### REQ-ANN-70 — Required-field marker
- **Description:** The system shall mark required fields with an asterisk carrying the explanation "Required — this field must be filled in".
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/NodeName.tsx:60-66`
- **Status:** Implemented

### REQ-ANN-80 — Per-paper finished sign-off
- **Description:** The system shall present a permanently visible "Annotation finished" checkbox as the reviewer's own sign-off (labeled "Consolidation finished" on the Consolidation seat), showing a flagged state with explanation when ticked while a required field is empty, and shall hide the checkbox for screening projects and projects configured with `finishCheckbox: false`.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:118-160,235-261`, `src/model/annotationState.ts:79-140`, commits `f58aee5`, `edfc5db`
- **Status:** Implemented

### REQ-ANN-90 — Jump to field
- **Description:** When a field jump is requested from the Validation dialog, the system shall scroll the target field into center view and flash it for 1.5 seconds.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AnnotationPanel.tsx:76-90`, commit `c0a8b15`
- **Status:** Implemented

### REQ-ANN-100 — Link PDF marks to fields as evidence
- **Description:** The system shall provide per field a link popover that lists already-linked PDF marks with unlink actions and a searchable picker of the seat's marks (recent session marks first, then reading order), where selecting a mark links it, clicking its snippet jumps to it in the PDF, and one mark accepts links to multiple fields.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Field.tsx:84-115,208-459`, `src/state/store.marks.test.ts:209-277`, commit `f5b8f6b`
- **Status:** Implemented

### REQ-ANN-110 — Auto-link fresh marks once
- **Description:** When the link popover opens for the last-edited field while a mark created in this session is pending, the system shall link that mark automatically exactly once; the pending offer shall be invalidated by paper or seat switches, instance changes, undo/redo, or touching another mark.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.marks.test.ts:325-457`, commits `861470c`, `e170faa`
- **Status:** Implemented

### REQ-ANN-120 — Reindex links on instance removal
- **Description:** When a repeatable instance is removed, the system shall shift linked-field paths and AI marks of the surviving instances, drop links belonging to the removed instance, and scope the change to the acting seat.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.reindex.test.ts:58-170`, commit `b9afb02`
- **Status:** Implemented

## Paper list

### REQ-LST-10 — List papers with status
- **Description:** The system shall list all papers with title, authors, and a per-paper status indicator, showing a filtered count as "N of M" when a filter or search is active.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:396-451`
- **Status:** Implemented

### REQ-LST-20 — Two-mode search
- **Description:** The system shall provide a paper search with a metadata mode (matching title, authors, DOI, abstract, PDF path, and identifier) and an annotations mode (matching the active seat's recorded values), requiring every whitespace-separated query word to match and ranking results by distinct words matched, then matched characters, then original order.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:187-189,366-394,452-488`
- **Status:** Implemented

### REQ-LST-30 — Five-state annotation indicator
- **Description:** The system shall display per paper one of five annotation states — untouched, partial (with a proportional fill of filled versus counted fields), complete, finished, or flagged — each with a tooltip stating the state and the filled-field count, derived from live data at read time.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:34-107,572-637`, `src/model/annotationState.ts:36-95`
- **Status:** Implemented

### REQ-LST-40 — Annotation progress filter
- **Description:** The system shall provide an annotation filter with the buckets all, open, in-progress (open and touched), finished, and with-issues, and shall display a progress line counting the selected bucket over all papers.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PaperList.tsx:335-363,496-510`, `src/model/annotationState.ts:194-258`, commit `0cb3828`
- **Status:** Implemented

### REQ-LST-50 — Keyboard navigation
- **Description:** The system shall expose the paper list as a listbox with a single roving tab stop where arrow keys move selection through visible rows and Enter or Space selects, and shall additionally step to the previous/next paper in filtered order via Alt+Arrow and the bare `[`/`]` keys outside text inputs and modals.
- **Type:** Functional (ISO 25010: Usability — Accessibility)
- **Evidence:** `src/components/PaperList.tsx:402-440`, `src/hooks/useKeybindings.ts:8-261`, commit `8ef9279`
- **Status:** Implemented

### REQ-LST-60 — Search and completeness performance
- **Description:** The system shall compute the search text and completeness of 2000 papers against a 30-field schema in under 150 milliseconds (best of three runs), and a single field edit shall change only the edited paper's object identity.
- **Type:** Non-functional (ISO 25010: Performance Efficiency)
- **Evidence:** `src/components/PaperList.perf.test.ts:26,70-115`
- **Status:** Implemented

### REQ-LST-70 — Resume where the reviewer left off
- **Description:** When a project reopens, the system shall select the paper, PDF page, and intra-page scroll offset stored at last use (persisted locally per project path, debounced at 500 ms), falling back to the first paper the active seat has not finished; stored positions shall never be written to the project file, leak between projects, or survive the referenced paper's deletion.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:256-313`, `src/state/store.readingPosition.test.ts:73-143`, commits `bb44dc8`, `e8efa2e`
- **Status:** Implemented

## PDF viewer

### REQ-PDF-10 — Render the paper's PDF
- **Description:** The system shall render the selected paper's PDF with all pages mounted, fit to pane width, capping rendering at 5000 pages while displaying the claimed count.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:23,1376-1414,1537-1547`
- **Status:** Implemented

### REQ-PDF-20 — Zoom controls
- **Description:** The system shall zoom the PDF between 0.4× and 3× in 0.2 steps via toolbar buttons, Ctrl/Cmd plus/minus/zero shortcuts, and Ctrl/Cmd+wheel.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:333-335,1694-1706`, `src/components/PdfViewer.tsx:437-443,1286-1297`
- **Status:** Implemented

### REQ-PDF-30 — Page navigation
- **Description:** The system shall provide previous/next page buttons and an editable page input clamped to the valid page range, tracking the current page from the scroll position.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:567-587,621-703,1508-1558`
- **Status:** Implemented

### REQ-PDF-40 — Jump history for internal links
- **Description:** When an internal PDF link jump moves the view, the system shall record the prior position on a back stack and provide back/forward navigation between recorded positions.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:428-435,1076-1099,1484-1507`
- **Status:** Implemented

### REQ-PDF-50 — In-PDF text search
- **Description:** The system shall provide an in-PDF search opened with Ctrl/Cmd+F that matches text across page text layers with a 150 ms input debounce, displays the match count, cycles matches with Enter and Shift+Enter, highlights and centers the active match, and closes with Escape.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:98-136,390-405,1246-1280,1618-1673`, commit `c206c49`
- **Status:** Implemented

### REQ-PDF-60 — Capture normalized text selection
- **Description:** When text is selected in the PDF, the system shall capture the selection normalized to Unicode NFC form for use by field grabbing and highlighting.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:705-717`, commit `d335151`
- **Status:** Implemented

### REQ-PDF-70 — Create highlights from selections
- **Description:** When a non-empty text selection exists, the system shall offer a five-color swatch toolbar near the selection end that creates a highlight of the chosen color and opens its comment popover, with the key `a` applying the first color.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:840-998,1327-1344`, commit `b2e2195`
- **Status:** Implemented

### REQ-PDF-80 — Cross-page highlights
- **Description:** When a selection spans a page boundary, the system shall split the highlight into per-page fragments sharing one group identifier, clipping probable running headers and footers from intermediate boundaries, and shall apply comment, color, link, and delete operations to all fragments together.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:840-998,1784-1806`, commits `0e524d7`, `502efe9`, `bacbaf3`
- **Status:** Implemented

### REQ-PDF-90 — Sticky notes
- **Description:** The system shall provide a note-placement mode in which one click places a note marker at that point and opens its comment popover.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1052-1070,1675-1686`, commit `8cf1ff1`
- **Status:** Implemented

### REQ-PDF-100 — Edit marks via popover
- **Description:** When a mark is clicked, the system shall open a popover offering recoloring among the five palette colors, comment editing, listing and unlinking of linked fields, and deletion with a confirmation when the mark is linked as evidence.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1808-1887`, commit `135a385`
- **Status:** Implemented

### REQ-PDF-110 — Per-seat mark scoping
- **Description:** The system shall store marks per reviewer seat as overlay data with page-fraction coordinates, never writing into the PDF file, so that each seat sees only its own marks and marks stay valid across zoom and resolution changes.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfMarks.ts:1-79`, `src/state/store.ts:928-953`
- **Status:** Implemented

### REQ-PDF-120 — Mark edits are undoable
- **Description:** The system shall record highlight creation, recoloring, deletion, and comment editing in the undo history, coalescing consecutive comment keystrokes into one undo step.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.marks.test.ts:52-323`, commit `316b304`
- **Status:** Implemented

### REQ-PDF-130 — Mark cycling in reading order
- **Description:** The system shall provide previous/next controls that step through the seat's marks in reading order (page, then column, then vertical position), counting a cross-page group once and flashing each visited mark.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:1024-1034,1687-1711`, `src/model/pdfMarks.ts:182-245`, commit `61a2aa4`
- **Status:** Implemented

### REQ-PDF-140 — Selection through marks
- **Description:** The system shall allow text selection by dragging across an existing mark while a plain click on the mark still opens its popover.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:719-788`, commit `d4c20e2`
- **Status:** Implemented

### REQ-PDF-150 — Reference hover previews
- **Description:** When an internal PDF link is hovered, the system shall show a preview image of the destination cropped to the destination entry where detectable, falling back to a page-region crop, capped at 560×240 CSS pixels; external links shall open in the system browser.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PdfViewer.tsx:180-218,1109-1218`, `src/model/refPreview.ts:22-152`, commits `1d07bd3`, `80dece2`
- **Status:** Implemented

### REQ-PDF-160 — Export marks into a PDF
- **Description:** When the export action is triggered with at least one mark, the system shall write the active seat's highlights and notes as standard PDF Highlight and Text annotation objects, either to a new file (default name `<paper>-annotated.pdf`) or, after an explicit warning, over the original file, skipping out-of-range pages instead of failing.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfExport.ts:27-61`, `src/components/ExportPdfDialog.tsx:32-166`, commit `e22c157`
- **Status:** Implemented

### REQ-PDF-170 — Extract PDF metadata heuristically
- **Description:** When paper metadata is missing, the system shall attempt to extract title, authors, and abstract from the PDF, preferring plausibility-checked embedded metadata over first-page layout heuristics, and shall return nothing rather than implausible values.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfMeta.ts:1-120`, `src/model/pdfMeta.test.ts`
- **Status:** Implemented

### REQ-PDF-180 — Extract page-ordered PDF text
- **Description:** The system shall extract PDF text as per-page blocks in reading order, normalized to Unicode NFC, capped at 2000 pages, skipping unreadable pages, and shall flag the result as empty when body text is under 200 non-whitespace characters.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfText.ts:22-152`
- **Status:** Implemented

## Workspace shell

### REQ-UI-10 — Global keyboard shortcuts
- **Description:** The system shall provide keyboard shortcuts for save (Ctrl/Cmd+S), save-as (Ctrl/Cmd+Shift+S), open (Ctrl/Cmd+O), undo/redo, help (F1), PDF zoom, and application font size, suppressing bare-key shortcuts while typing or while a modal is open, and shall document all shortcuts in a Help dialog with mode-specific tables.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/hooks/useKeybindings.ts:8-261`, `src/components/HelpDialog.tsx:10-62`
- **Status:** Implemented

### REQ-UI-20 — Toolbar project controls
- **Description:** The system shall provide a toolbar with an Open menu (file, remote git clone, recents with removal), a Save menu (save, save-as, autosave toggle), a Git button disabled with a reason-specific tooltip when unavailable, Validate, Close, the project name with a dirty indicator and transient saved status, font-size controls, a theme toggle, and Help.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx:99-468`
- **Status:** Implemented

### REQ-UI-30 — Seat switcher in toolbar
- **Description:** When a multi-reviewer project is open, the system shall display a seat switcher in the toolbar, as numbered pills plus a distinct Consolidation control for up to five reviewers and as a labeled dropdown above that, and shall badge the active seat on the annotation panel title.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx:26-32,341-398`, `src/components/AnnotationPanel.tsx:204-212`
- **Status:** Implemented

### REQ-UI-40 — Resizable panes
- **Description:** The system shall let the user resize the three panes via pointer-driven splitters supporting touch input, persisting the widths locally within clamped bounds.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Splitter.tsx:11-44`, `src/state/settings.ts`
- **Status:** Implemented

### REQ-UI-50 — Clipboard fallback
- **Description:** When copying text, the system shall try the asynchronous Clipboard API, fall back to a hidden-textarea copy command, and report failure as a result value rather than an exception.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/clipboard.ts:9-30`
- **Status:** Implemented

### REQ-UI-60 — Surface load and save errors
- **Description:** When a project load or save fails, the system shall display a dismissible full-screen error panel with the message and detail lines.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ErrorPanel.tsx:4-28`
- **Status:** Implemented
