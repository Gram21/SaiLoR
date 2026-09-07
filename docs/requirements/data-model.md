# Requirements — Project File, Schema & Data Model

Requirements for the project JSON format, load/save robustness, the annotation schema
and value trees, validation, completeness, duplicate detection, reference import, and
the project editor. See the [index](index.md) for the glossary.

---

## Project file loading

### REQ-DAT-10 — Reject invalid JSON with a message
- **Description:** When a selected project file is not valid JSON, the system shall reject the load with a message stating the file is not valid JSON plus the parser detail.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:663-670`
- **Status:** Implemented

### REQ-DAT-20 — Bound input nesting depth
- **Description:** When a project file contains JSON nested deeper than 200 levels, the system shall reject the load with an explanatory error instead of exhausting the call stack.
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/project.ts:646-706`, `src/model/hostile.test.ts:33-50`, commit `07f1244`
- **Status:** Implemented

### REQ-DAT-30 — Report structural errors per path
- **Description:** When a project file fails structural validation, the system shall report one detail line per violation in `path: message` form.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:693-699`
- **Status:** Implemented

### REQ-DAT-40 — Preserve unknown keys
- **Description:** The system shall preserve unknown root-level and paper-level keys through a load/save round trip.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:195-227`, `src/model/project.ts:304-336,760,868`
- **Status:** Implemented

### REQ-DAT-50 — Reject duplicate paper identifiers
- **Description:** When two papers in a project file share an identifier, the system shall reject the load naming the duplicated identifier.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:729-735`
- **Status:** Implemented

### REQ-DAT-60 — Require paper identity and PDF
- **Description:** The system shall require each paper to have a non-empty identifier and title and, except in screening projects, a non-empty PDF path.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:126-173,241-251`, `src/model/model.test.ts:854`
- **Status:** Implemented

### REQ-DAT-70 — Repair year values structurally
- **Description:** When a paper's year is a number, the system shall accept it only as an integer between 1000 and 2100; when it is a string, the system shall take its first four-digit run subject to the same range; otherwise the system shall treat the year as absent.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/year.ts:18-50`, `src/model/year.test.ts`
- **Status:** Implemented

### REQ-DAT-80 — Degrade malformed sub-records without failing
- **Description:** When hand-editable sub-records (AI usage, equality marks, reviews, provenance, protocol, schema info, alignment, marks) are malformed, the system shall drop the malformed parts and load the rest of the project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:347-571`, `src/model/model.test.ts:525,777-789,1015,1117-1146`
- **Status:** Implemented

### REQ-DAT-90 — Round-trip hostile values safely
- **Description:** The system shall round-trip values containing JSON metacharacters, `__proto__`, lone surrogates, and other unusual strings byte-exactly, without polluting object prototypes.
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/jsonvalues.test.ts:44-83`, commit `6933376`
- **Status:** Implemented

### REQ-DAT-100 — Mark PDF-extracted abstracts
- **Description:** The system shall persist the marker that an abstract came from PDF extraction only while a non-empty abstract exists, and shall never attach it to a typed or imported abstract.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:745-748,828`, `src/model/model.test.ts:902-940`
- **Status:** Implemented

## Annotation schema

### REQ-DAT-110 — Schema node structure
- **Description:** The system shall accept schema nodes with a non-empty name, an optional field type of string, number, boolean, or year, cardinality bounds `min` (integer ≥ 0, default 1) and `max` (integer ≥ 1 or null for unbounded, default 1, at least `min` when finite), optional description, enum options (string fields only), a required flag (typed fields only), a `visibleIf` reference, and children, rejecting unknown node keys and nodes with neither a type nor children.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:24-124`, `src/model/model.test.ts:58-144`
- **Status:** Implemented

### REQ-DAT-120 — Unique sibling names
- **Description:** The system shall reject a schema whose sibling nodes share a name or differ only in surrounding whitespace, and shall reject the node name `__proto__`.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:296-327`, `src/model/model.test.ts:64`
- **Status:** Implemented

### REQ-DAT-130 — Drop required on booleans
- **Description:** When a boolean field is marked required, the system shall drop the flag at schema resolution because an unticked checkbox is the answer false.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:340-345`, `src/model/model.test.ts:130`
- **Status:** Implemented

### REQ-DAT-140 — Restrict visibleIf targets
- **Description:** The system shall honor a `visibleIf` reference only when it names a same-level typed sibling or a typed field on the direct ancestor chain, and shall drop invalid references at schema resolution.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:346-363`, `src/model/model.test.ts:165-235`
- **Status:** Implemented

### REQ-DAT-150 — Bound schema instance fan-out
- **Description:** When a schema's empty tree would materialize more than 100,000 instances, the system shall reject the schema at load.
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/schema.ts:376-420`, `src/model/hostile.test.ts:18-67`
- **Status:** Implemented

## Annotation value trees

### REQ-DAT-160 — Normalize trees on load
- **Description:** When loading an annotation tree, the system shall drop keys not in the schema, pad each node up to the larger of its minimum and one instance, clamp instances above the maximum, and adopt a bare primitive or single object where a list is expected as one entry.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:64-124`, `src/model/model.test.ts:1221`, commit `b12f654`
- **Status:** Implemented

### REQ-DAT-170 — Prune only trailing empties on save
- **Description:** When serializing an annotation tree, the system shall drop only trailing empty instances of a repeatable node, keeping gaps before filled instances because position carries alignment meaning, and shall serialize trees with no filled field as empty objects.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:136-162`, `src/model/project.ts:877-879`, `src/model/model.test.ts:401,678`
- **Status:** Implemented

## Validation

### REQ-DAT-180 — Total, non-throwing validation
- **Description:** When validating a project, the system shall report every finding as an issue with paper, human-readable path, and machine path, and shall convert unexpected data shapes into issues instead of failing.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:14-40,318-337`
- **Status:** Implemented

### REQ-DAT-190 — Required, type, enum, and cardinality checks
- **Description:** The system shall report an issue when a required non-boolean field is empty, when a value's type mismatches its field type (including years outside 1000–2100), when a non-empty enum value is not among the defined options, and when a node's instance count violates its cardinality bounds.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:57-243`, `src/model/validate.test.ts:116-128`
- **Status:** Implemented

### REQ-DAT-200 — Skip hidden fields in validation
- **Description:** When a field or group is hidden by an unanswered `visibleIf` gate, the system shall exclude it from validation.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:206-272`, `src/model/validate.test.ts:137-192`
- **Status:** Implemented

### REQ-DAT-210 — Separate unannotated papers
- **Description:** When validating, the system shall list papers with zero annotations in a separate "not annotated yet" section instead of reporting their fields as missing.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:300-340`, `src/components/ValidationDialog.tsx:146-169`
- **Status:** Implemented

## Completeness & finished state

### REQ-DAT-220 — Completeness over the validated field set
- **Description:** The system shall compute a paper's completeness as filled over counted fields, counting only required fields when the schema marks any field required and all fields otherwise, excluding boolean fields and fields hidden by visibility gates, using the same rule as validation.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/completeness.ts:24-59`, `src/model/completeness.test.ts:89-284`
- **Status:** Implemented

### REQ-DAT-230 — Non-misleading percentage display
- **Description:** When displaying completeness as a percentage, the system shall show exactly 0 and 100 only at the true endpoints and clamp all intermediate ratios to the range 5–99.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/completeness.ts:124-129`, `src/model/completeness.test.ts:300-318`
- **Status:** Implemented

### REQ-DAT-240 — Finished is a human declaration
- **Description:** The system shall store the finished flag as an explicit human declaration, accepting only the literal value true on load, never deriving it from data, and writing it to the file only when set.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:135-152,758,861`
- **Status:** Implemented

### REQ-DAT-250 — Derive finished when the checkbox is disabled
- **Description:** When a project sets `finishCheckbox` to false, the system shall treat a fulfilled schema alone as finished, ignore stored ticks while preserving them in the file, and hide the with-issues filter.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotationState.ts:79-87,205-207`, `src/components/PaperList.finished.test.ts:207-267`
- **Status:** Implemented

## Multi-reviewer data

### REQ-DAT-260 — Independent reviewer trees
- **Description:** The system shall store the consolidated tree under `annotations` and each reviewer's independent tree under `reviews` keyed by reviewer number from 1 to the configured count (an integer from 1 to 10), normalizing each tree against the schema.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:347-391,776`, `src/model/schema.ts:222`, `src/model/model.test.ts:589-663`
- **Status:** Implemented

### REQ-DAT-270 — Pre-create reviewer skeletons
- **Description:** When a multi-reviewer project is saved, the system shall emit a skeleton tree for every configured reviewer so that a first annotation changes an existing file rather than creating one, while single-reviewer projects gain no reviewer trees.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:357-391`, `src/model/model.test.ts:656`
- **Status:** Implemented

### REQ-DAT-280 — Never drop higher-numbered reviewers
- **Description:** When the configured reviewer count is lowered, the system shall keep and continue saving any higher-numbered reviewer's recorded tree.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:369-373,936-951`, `src/model/split.test.ts:97`
- **Status:** Implemented

## Serialization

### REQ-DAT-290 — Deterministic serialization
- **Description:** The system shall serialize projects as two-space-indented JSON with papers in fixed citation-like key order sorted by case-sensitive identifier comparison, writing optional records and non-default configuration values only when present.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:788-829,1111-1140`, commits `c50f28a`, `1382386`
- **Status:** Implemented

### REQ-DAT-300 — Silent shape migration
- **Description:** When an opened file's stored annotation shape differs structurally from what saving would write and a writable file handle exists, the system shall rewrite the file in place without user interaction, and shall not rewrite for key-order or whitespace differences.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:590-636`, `src/state/store.ts:1378-1414`
- **Status:** Implemented

## Duplicate detection

### REQ-DAT-310 — Classify imports in three verdicts
- **Description:** When importing reference records, the system shall classify each record as new, certain duplicate, or probable duplicate, comparing against all existing papers and all earlier records in the same batch.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts:28-39,387-414`, `src/model/duplicates.test.ts:330`
- **Status:** Implemented

### REQ-DAT-320 — Duplicate matching rules
- **Description:** The system shall treat an identical normalized DOI or identical normalized title as a certain duplicate, and a fuzzy whole-title similarity of at least 0.90 — or an equal subtitle-stripped base title with author-surname similarity of at least 0.50 — as a probable duplicate.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts:49-67,315-363`
- **Status:** Implemented

### REQ-DAT-330 — Demote conflicting matches
- **Description:** The system shall demote a non-DOI title match whose years differ by two or more to new, and shall demote an exact-title match with two different DOIs or fully disjoint author sets to probable.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts:118-131,320-347`, `src/model/duplicates.test.ts:73-196,531-560`
- **Status:** Implemented

### REQ-DAT-340 — Human decision on probable duplicates
- **Description:** When probable duplicates exist in an import, the system shall present each with the match reason and both sides' title, authors, and DOI, shall block the import until every probable row is decided, and shall write nothing when the dialog is cancelled.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/DuplicateReviewDialog.tsx:36-213`
- **Status:** Implemented

### REQ-DAT-350 — Merge fills empty fields only
- **Description:** When committing an import, the system shall fill only empty fields of merge targets, with the single exception that a reference-file abstract replaces a PDF-extracted abstract, and shall report counts of updated, unchanged, and added papers.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:423-543`, commit `c1830f9`
- **Status:** Implemented

## Reference import

### REQ-DAT-360 — Parse BibTeX, RIS, and CSL-JSON
- **Description:** The system shall parse reference files in BibTeX, RIS, and CSL-JSON formats, choosing the format by file extension with content sniffing as fallback, skipping malformed or title-less entries individually, and returning an empty list rather than failing on unparseable input.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts:32-71,296-347,505-747`, `src/model/references.test.ts`
- **Status:** Implemented

### REQ-DAT-370 — Convert LaTeX escapes
- **Description:** When parsing BibTeX prose fields, the system shall convert LaTeX accent and letter escapes to their UTF-8 characters and degrade unknown escapes by dropping the backslash, without mangling Windows file paths in path fields.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts:93-190,394-408`, `src/model/references.test.ts:166-262`
- **Status:** Implemented

### REQ-DAT-380 — Extract PDF hints from references
- **Description:** When a reference entry carries a file field or a URL ending in `.pdf`, the system shall extract the PDF file name as a placeholder path for the created paper.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts:426-432,461-484`, `src/state/editorStore.ts:402-419`
- **Status:** Implemented

## Project editor

### REQ-EDT-10 — Validate drafts before save
- **Description:** When saving a project draft, the system shall require at least one named schema node (non-screening) or at least one non-blank exclusion reason (screening), a trimmed identifier and title per paper, a PDF path per paper except in screening drafts, and no duplicate identifiers, reporting each violation as a clickable issue capped at 12 displayed lines.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:614-675`, `src/components/ProjectEditor.tsx:17-21,74-79,259-285`
- **Status:** Implemented

### REQ-EDT-20 — Flag duplicate identifiers while typing
- **Description:** When two paper rows carry the same trimmed identifier, the system shall mark the offending inputs live during editing.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:14-19,54,255-265`, commit `5ac5112`
- **Status:** Implemented

### REQ-EDT-30 — Create papers from PDFs
- **Description:** When PDF files are added, the system shall create one paper per new file with an identifier slugified from the file name (suffix-deduplicated), a title guessed from the file name or PDF metadata, and a project-relative path, skipping PDFs already in the project with a notice.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:300-350,1213-1237`
- **Status:** Implemented

### REQ-EDT-40 — Warn before destroying answers
- **Description:** When a schema field that papers record answers under (or that mark links point at) is renamed, removed, or re-parented, the system shall request confirmation naming the number of affected papers; sibling reordering shall proceed without warning.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaTreeEditor.tsx:124-276`, `src/model/fieldUsage.ts:59-140`, commits `a0034e9`, `638e1b5`
- **Status:** Implemented

### REQ-EDT-50 — Confirm removal of annotated papers
- **Description:** When a paper with recorded annotations is removed in the editor, the system shall request confirmation stating that all reviewers' annotations will be discarded on the next save.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:90-102`
- **Status:** Implemented

### REQ-EDT-60 — Edit schema tree graphically
- **Description:** The system shall provide a drag-and-drop schema tree editor offering group, text, number, year, and yes/no nodes, inline enum options, cardinality inputs with an unbounded toggle, descriptions, a required checkbox for eligible fields, a `visibleIf` selector restricted to legal targets, and refusal of drops into a node's own subtree.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaTreeEditor.tsx:20-26,211-240,285-509`
- **Status:** Implemented

### REQ-EDT-70 — Record the review protocol
- **Description:** The system shall let the user record a review protocol (research questions, search strings, databases, search date, notes) edited one item per line, storing no protocol record when all parts are empty.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ProtocolEditor.tsx:38-132`, `src/model/project.ts:515-534`
- **Status:** Implemented

### REQ-EDT-80 — Show schema info once per load
- **Description:** When a project carries a schema-wide info text, the system shall display it in a dialog automatically once per project load and on demand via an info button, rendering contained URLs as links.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaInfoDialog.tsx:5-63`, commit `8322d10`
- **Status:** Implemented

### REQ-EDT-90 — Reorder papers by drag
- **Description:** The system shall let the user reorder paper rows by dragging a handle, with drop-position indicators.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:43-343`
- **Status:** Implemented
