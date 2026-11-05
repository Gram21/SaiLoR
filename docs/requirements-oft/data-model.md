# Requirements: Project File, Schema & Data Model

Requirements for the project JSON format, load/save robustness, the annotation schema
and value trees, validation, completeness, duplicate detection, reference import, and
the project editor. See the [index](../requirements/index.md) for the glossary.

---

## Project file loading

### REQ-DAT-10: Reject invalid JSON with a message
`req~dat-10~1`

When a selected project file is not valid JSON, the system shall reject the load with a message stating the file is not valid JSON plus the parser detail.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:663-670`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-20: Bound input nesting depth
`req~dat-20~1`

When a project file contains JSON nested deeper than 200 levels, the system shall reject the load with an explanatory error instead of exhausting the call stack.

Comment:
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/project.ts:646-706`, `src/model/hostile.test.ts:33-50`, commit `07f1244`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Reliability, Security

### REQ-DAT-30: Report structural errors per path
`req~dat-30~1`

When a project file fails structural validation, the system shall report one detail line per violation in `path: message` form.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:693-699`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-40: Preserve unknown keys
`req~dat-40~1`

The system shall preserve unknown root-level and paper-level keys through a load/save round trip.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:195-227`, `src/model/project.ts:304-336,760,868`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-50: Reject duplicate paper identifiers
`req~dat-50~1`

When two papers in a project file share an identifier, the system shall reject the load naming the duplicated identifier.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:729-735`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-60: Require paper identity and PDF
`req~dat-60~1`

The system shall require each paper to have a non-empty identifier and title and, except in screening projects, a non-empty PDF path.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:126-173,241-251`, `src/model/model.test.ts:854`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-70: Repair year values structurally
`req~dat-70~1`

When a paper's year is a number, the system shall accept it only as an integer between 1000 and 2100; when it is a string, the system shall take its first four-digit run subject to the same range; otherwise the system shall treat the year as absent.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/year.ts:18-50`, `src/model/year.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-80: Degrade malformed sub-records without failing
`req~dat-80~1`

When hand-editable sub-records (AI usage, equality marks, reviews, provenance, protocol, schema info, alignment, marks) are malformed, the system shall drop the malformed parts and load the rest of the project.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:347-571`, `src/model/model.test.ts:525,777-789,1015,1117-1146`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-90: Round-trip hostile values safely
`req~dat-90~1`

The system shall round-trip values containing JSON metacharacters, `__proto__`, lone surrogates, and other unusual strings byte-exactly, without polluting object prototypes.

Comment:
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/jsonvalues.test.ts:44-83`, commit `6933376`
- **Status:** Implemented

Needs: utest

Tags: NonFunctional, Reliability, Security

### REQ-DAT-100: Mark PDF-extracted abstracts
`req~dat-100~1`

The system shall persist the marker that an abstract came from PDF extraction only while a non-empty abstract exists, and shall never attach it to a typed or imported abstract.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:745-748,828`, `src/model/model.test.ts:902-940`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Annotation schema

### REQ-DAT-110: Schema node structure
`req~dat-110~1`

The system shall accept schema nodes with a non-empty name, an optional field type of string, number, boolean, or year, cardinality bounds `min` (integer ≥ 0, default 1) and `max` (integer ≥ 1 or null for unbounded, default 1, at least `min` when finite), optional description, enum options (string fields only), a required flag (typed fields only), a `visibleIf` gate (either a bare field name or an object with a `mode` of `all`/`any` and a non-empty list of entries, each a `{ field, equals? }` condition or a nested group of the same shape), and children, rejecting unknown node keys and nodes with neither a type nor children.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:26-195`, `src/model/model.test.ts:58-144`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-120: Unique sibling names
`req~dat-120~1`

The system shall reject a schema whose sibling nodes share a name or differ only in surrounding whitespace, and shall reject the node name `__proto__`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:296-327`, `src/model/model.test.ts:64`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-130: Drop required on booleans
`req~dat-130~1`

When a boolean field is marked required, the system shall drop the flag at schema resolution because an unticked checkbox is the answer false.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:340-345`, `src/model/model.test.ts:130`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-140: Restrict visibleIf targets and values
`req~dat-140~1`

The system shall normalize every `visibleIf` gate at schema resolution: expanding the bare-name form into a single `all` condition and recursing into nested groups: and shall resolve each condition's `field` as a same-level typed sibling, else a typed field on the direct ancestor chain, else a slash-joined absolute path from the schema root, dropping the condition when it resolves to the gated node itself, to anything in the gated node's own subtree, to a group, or to nothing; then any group left empty, and, once none is left, the whole gate. An `equals` shall be honored only on a boolean field (its `true`/`false`) or a string field with non-empty `options` (values among those options); values the target cannot hold, and any `equals` on a free-text, number, or year field, shall be dropped so that the condition degrades to "is it answered".

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts:346-443`, `src/model/model.test.ts:171-623`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-150: Bound schema instance fan-out
`req~dat-150~1`

When a schema's empty tree would materialize more than 100,000 instances, the system shall reject the schema at load.

Comment:
- **Type:** Non-functional (ISO 25010: Reliability, Security)
- **Evidence:** `src/model/schema.ts:376-420`, `src/model/hostile.test.ts:18-67`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Reliability, Security

## Annotation value trees

### REQ-DAT-160: Normalize trees on load
`req~dat-160~1`

When loading an annotation tree, the system shall carry keys the schema does not describe through unchanged as hidden answers (see REQ-DAT-165), pad each node up to the larger of its minimum and one instance, clamp instances above the maximum, and adopt a bare primitive or single object where a list is expected as one entry.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:125-147,149-174`, commits `b12f654`, `0e185f2`
- **Verified by:** `src/model/model.test.ts` (`normalize` describe block)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-165: Preserve answers hidden by schema changes
`req~dat-165~1`

When an annotation tree holds recorded answers under a node the current schema no longer describes: at any level, including beneath a node that lost some or all of its children: the system shall keep those answers verbatim through load, save, and merge, shall keep the file holding them even when no current-schema field is answered, and shall present them again once a node of that name returns to the schema; unanswered placeholder instances shall not be kept as hidden answers.

Comment:
- **Type:** Non-functional (ISO 25010: Reliability: Recoverability)
- **Evidence:** `src/model/annotations.ts:74-89,192-211,346-348,359-361,369-386`, `src/model/project.ts:713-718,723-725`, commits `0e185f2`, `edeae38`
- **Verified by:** `src/model/split.test.ts` (`a schema field removed while others still have answers under it`, `a schema node that loses every child`), `src/model/model.test.ts` (`normalize` describe block)
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Reliability_Recoverability

### REQ-DAT-166: Schema version
`req~dat-166~1`

The system shall give every saved schema change a schema version identifier recorded in the project file together with a history of versions, each naming the version(s) it replaced, its time, and the renames and moves it made; and shall record in every annotation and mark file the schema version it was written under.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schemaVersion.ts:80-92`, `src/model/project.ts:595,680,848,1048`, commit `40e0668`
- **Verified by:** `src/model/schemaVersion.test.ts` (`stamps every file it writes, and reading its own text back moves nothing again`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-167: Carry answers across renames and moves
`req~dat-167~1`

When reading an annotation or mark file written under an older schema version, or under none, the system shall apply the renames and moves recorded since that version to its answers and field links; a move that would pass through a repeated entry, or land on answers already there, shall leave the answers where they were.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schemaVersion.ts:138-155,201-245`, commit `40e0668`
- **Verified by:** `src/model/schemaVersion.test.ts` (`moveInTree`, `pendingMoves`, `carries the answers across the renames made since`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-168: Report files of an unknown schema version
`req~dat-168~1`

When an annotation or mark file names a schema version the project history does not contain, the system shall read it without migration and report it in validation as written under an unknown schema version.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schemaVersion.ts:138-155`, `src/model/validate.ts:378`, commit `40e0668`
- **Verified by:** `src/model/schemaVersion.test.ts` (`leaves a file of an unknown version alone, and says so`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-169: Annotations folder confined to the project directory
`req~dat-169~1`

The system shall keep a project's annotation files in the folder its project file names as `annotationsDir`, defaulting to `annotations`, and shall accept only a plain folder name directly inside the project file's directory: names containing a separator, `..`, a drive or device designation, a leading dot, or characters not allowed in Windows file names shall be refused and the default used, and a folder that is a symbolic link or resolves outside the project directory shall not be read or written.

Comment:
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/model/annotationsDir.ts`, `src-tauri/src/project.rs` (`annotations_dir_ok`, `annotations_dir_for`), `src/git/relpath.ts`, commit `c1b40ec`
- **Verified by:** `src/model/annotationsDir.test.ts`, `src/state/editorStore.annotationsDir.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Security

### REQ-DAT-172: Highlight file names by project kind
`req~dat-172~1`

The system shall store a screening project's PDF highlights as `screening-marks-<n>.json` and `screening-marks-consolidated.json`, and an annotation project's as `marks-<n>.json` and `marks-consolidated.json`, so that a screening project and an annotation project never write a file of the same name; a screening project's highlight files written under the older `marks-*` names shall be read only when no file under the new name exists for that seat and no annotation project sharing its annotations folder lists that paper.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`marksFileName`, `parseMarksFileName`), `src-tauri/src/project.rs` (`read_project`, `safe_read`), `src/platform/tauri.ts` (`assembleProject`), `src/model/annotationsDir.ts` (`filesCollide`), commit `6eb9027`
- **Verified by:** `src/model/annotationsDir.test.ts` (`highlight file names`, `filesCollide`), `src/model/split.test.ts`, `src/git/ownAnnotationPath.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-170: Prune only trailing empties on save
`req~dat-170~1`

When serializing an annotation tree, the system shall drop only trailing empty instances of a repeatable node, keeping gaps before filled instances because position carries alignment meaning, and shall serialize trees with no filled field as empty objects.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotations.ts:136-162`, `src/model/project.ts:877-879`, `src/model/model.test.ts:401,678`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Validation

### REQ-DAT-180: Total, non-throwing validation
`req~dat-180~1`

When validating a project, the system shall report every finding as an issue with paper, human-readable path, and machine path, and shall convert unexpected data shapes into issues instead of failing.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:14-40,318-337`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-190: Required, type, enum, and cardinality checks
`req~dat-190~1`

The system shall report an issue when a required non-boolean field is empty, when a value's type mismatches its field type (including years outside 1000–2100), when a non-empty enum value is not among the defined options, and when a node's instance count violates its cardinality bounds.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:57-243`, `src/model/validate.test.ts:116-128`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-200: Skip hidden fields in validation
`req~dat-200~1`

When a field or group is hidden by an unsatisfied `visibleIf` gate: whether the gate asks for any answer or for specific values: the system shall exclude it from validation.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:206-280`, `src/model/validate.test.ts:137-284`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-210: Separate unannotated papers
`req~dat-210~1`

When validating, the system shall list papers with zero annotations in a separate "Not started yet" section instead of reporting their fields as missing.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:300-340`, `src/components/ValidationDialog.tsx:411-450`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-215: Report hidden answers in validation
`req~dat-215~1`

When validating a project, the system shall report each paper that holds answers under nodes the schema no longer describes, naming the nodes (up to five, with a count of any remainder), including papers with no answer the current schema can see.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts:342`, `src/model/annotations.ts:369-386`, `src/components/ValidationDialog.tsx:11`, commit `264d6b0`
- **Verified by:** `src/model/validate.test.ts` (`answers hidden by a schema change are reported`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Completeness & finished state

### REQ-DAT-220: Completeness over the validated field set
`req~dat-220~1`

The system shall compute a paper's completeness as filled over counted fields, counting only required fields when the schema marks any field required and all fields otherwise, excluding boolean fields and fields hidden by visibility gates, using the same rule as validation.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/completeness.ts:24-59`, `src/model/completeness.test.ts:89-351`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-230: Non-misleading percentage display
`req~dat-230~1`

When displaying completeness as a percentage, the system shall show exactly 0 and 100 only at the true endpoints and clamp all intermediate ratios to the range 5–99.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/completeness.ts:124-129`, `src/model/completeness.test.ts:300-318`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-240: Finished is a human declaration
`req~dat-240~1`

The system shall store the finished flag as an explicit human declaration, accepting only the literal value true on load, never deriving it from data, and writing it to the file only when set.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:135-152,758,861`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-250: Derive finished when the checkbox is disabled
`req~dat-250~1`

When a project sets `finishCheckbox` to false, the system shall treat a fulfilled schema alone as finished, ignore stored ticks while preserving them in the file, and hide the with-issues filter.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/annotationState.ts` (`annotationState`, `annotationStateFor`), `src/components/PaperList.finished.test.ts:207-267`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Multi-reviewer data

### REQ-DAT-260: Independent reviewer trees
`req~dat-260~1`

The system shall store the consolidated tree under `annotations` and each reviewer's independent tree under `reviews` keyed by reviewer number from 1 to the configured count (an integer from 1 to 10), normalizing each tree against the schema.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:347-391,776`, `src/model/schema.ts:222`, `src/model/model.test.ts:589-663`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-270: Pre-create reviewer skeletons
`req~dat-270~1`

When a multi-reviewer project is saved, the system shall emit a skeleton tree for every configured reviewer so that a first annotation changes an existing file rather than creating one, while single-reviewer projects gain no reviewer trees.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:357-391`, `src/model/model.test.ts:656`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-280: Never drop higher-numbered reviewers
`req~dat-280~1`

When the configured reviewer count is lowered, the system shall keep and continue saving any higher-numbered reviewer's recorded tree.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:369-373,936-951`, `src/model/split.test.ts:97`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-285: AI reviewer seat is the last configured seat
`req~dat-285~1`

The system shall accept an optional `config.aiSeat` boolean (default false, written only when true) naming that the AI occupies the last configured reviewer seat (`config.reviewers`), computing this seat's id rather than storing it separately, and shall treat it as effective only when AI-assisted annotation is allowed, at least two reviewers are configured, and the project is not a screening project; the value shall be kept verbatim outside that window rather than cleared. The system shall include it in git change detection and three-way merge, mirroring how `config.ai` is handled, with its own conflict row on disagreement.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:225-289`, `src/model/schema.ts`, `src/git/changes.ts:259`, `src/git/merge.ts:1287-1298,1417-1418,1597-1601`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

## Serialization

### REQ-DAT-290: Deterministic serialization
`req~dat-290~1`

The system shall serialize projects as two-space-indented JSON with papers in fixed citation-like key order sorted by case-sensitive identifier comparison, writing optional records and non-default configuration values only when present.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:788-829,1111-1140`, commits `c50f28a`, `1382386`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-300: No writes on open
`req~dat-300~1`

When a project is opened, the system shall not write to any of its files, even when the stored shape of its annotation trees differs from what saving would write; the normalized shape shall be held in memory and reach disk only through a save.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:1330`, commit `27bf461`
- **Verified by:** `src/state/store.save.test.ts` (`opening a project never writes to disk by itself`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Duplicate detection

### REQ-DAT-310: Classify imports in three verdicts
`req~dat-310~1`

When importing reference records, the system shall classify each record as new, certain duplicate, or probable duplicate, comparing against all existing papers and all earlier records in the same batch.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts` (`classifyImport`, `classifyPair`), `src/model/duplicates.test.ts:330`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-320: Duplicate matching rules
`req~dat-320~1`

The system shall treat an identical normalized DOI or identical normalized title as a certain duplicate, and a fuzzy whole-title similarity of at least 0.90: or an equal subtitle-stripped base title with author-surname similarity of at least 0.50: as a probable duplicate.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts` (`normalizeTitleForMatch`, `normalizeDoi`, `fuzzyScoreAtLeast`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-330: Demote conflicting matches
`req~dat-330~1`

The system shall demote a non-DOI title match whose years differ by two or more to new, and shall demote an exact-title match with two different DOIs or fully disjoint author sets to probable.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/duplicates.ts` (`classifyPair`, `rank`), `src/model/duplicates.test.ts:73-196,531-560`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-340: Human decision on probable duplicates
`req~dat-340~1`

When probable duplicates exist in an import, the system shall present each with the match reason and both sides' title, authors, and DOI, shall block the import until every probable row is decided, and shall write nothing when the dialog is cancelled.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/DuplicateReviewDialog.tsx:36-213`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-350: Merge fills empty fields only
`req~dat-350~1`

When committing an import, the system shall fill only empty fields of merge targets, with the single exception that a reference-file abstract replaces a PDF-extracted abstract, and shall report counts of updated, unchanged, and added papers.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:423-543`, commit `c1830f9`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

## Reference import

### REQ-DAT-360: Parse BibTeX, RIS, and CSL-JSON
`req~dat-360~1`

The system shall parse reference files in BibTeX, RIS, and CSL-JSON formats, choosing the format by file extension with content sniffing as fallback, skipping malformed or title-less entries individually, and returning an empty list rather than failing on unparseable input.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts` (`parseReferences`, `parseBibtex`, `parseRis`, `parseCslJson`), `src/model/references.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-370: Convert LaTeX escapes
`req~dat-370~1`

When parsing BibTeX prose fields, the system shall convert LaTeX accent and letter escapes to their UTF-8 characters and degrade unknown escapes by dropping the backslash, without mangling Windows file paths in path fields.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts:93-190,394-408`, `src/model/references.test.ts:166-262`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-380: Extract PDF hints from references
`req~dat-380~1`

When a reference entry carries a file field or a URL ending in `.pdf`, the system shall extract the PDF file name as a placeholder path for the created paper.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/references.ts:426-432,461-484`, `src/state/editorStore.ts:402-419`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-DAT-390: Reserved feedback folder in the annotations folder
`req~dat-390~1`

The system shall reserve the name `feedback` inside the annotations folder for AI schema-feedback JSON files: it shall never load that folder as a paper, never prune, overwrite or delete it when saving, and move it along with the annotations folder; it shall refuse `feedback` (in any letter case) as a paper identifier or annotations folder name; and it shall write a feedback file only through a dedicated call that accepts a plain `*.json` file name and a JSON-object content of at most 1 MB, refuses a symbolic-linked or escaping folder, and never overwrites an existing file. Git treats the files as ordinary project files (shown and committed as plain changes, never parsed as annotations or offered for field review, and left in place across a branch switch).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/paperId.ts` (`FEEDBACK_DIR`), `src/model/annotationsDir.ts` (`isFeedbackPath`), `src-tauri/src/feedback.rs` (`write_feedback`, `list_feedback`, `project_write_feedback`, `project_list_feedback`), `src-tauri/src/project.rs` (`write_project_files`), `src-tauri/src/git.rs` (`branch_switch_begin`), `src/git/relpath.ts` (`mergeBlockingPaths`)
- **Verified by:** `src-tauri/src/feedback.rs` (`name_and_content_rules`, `write_never_overwrites_and_lists_sorted`), `src/model/annotationsDir.test.ts` (reserved feedback folder)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-400: Unique option for repeatable schema nodes
`req~dat-400~1`

The system shall accept `unique: true` on a repeatable schema node (`max` above 1 or `null`) and an optional `uniqueBy` list of direct child names on a unique node with children. The system shall compare free text trimmed, with collapsed spaces and case-insensitive, and all other values exactly. The system shall never compare empty entries. Without `uniqueBy`, all child fields decide equality. The system shall reject `unique` on a non-repeatable node, `uniqueBy` without `unique` or without children, and unknown `uniqueBy` names, with a message that names the node path.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schema.ts` (`assertUniqueOptions`), `src/model/unique.ts` (`entryKey`, `duplicateIndexes`), `src/model/project.ts` (`dehydrateSchema`)
- **Verified by:** `src/model/unique.test.ts` (`unique schema option`, `duplicateIndexes`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-410: Refuse duplicate entries on edit and AI suggestion
`req~dat-410~1`

When an edit in the annotation form would make an entry of a unique node equal to another entry, the system shall refuse the write and show an inline hint that names the other entry. An edit that leaves an existing repeat unchanged shall not be refused. When AI suggestions are parsed, applied in a batch, or adopted as unanimous values, the system shall drop each suggestion that repeats an entry or an earlier suggestion, and shall list the dropped suggestion with the reason in the AI notes.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/unique.ts` (`duplicateOnWrite`, `dropDuplicateSuggestions`), `src/state/store.ts` (`setFieldValue`, `applyAiSuggestionsBatch`, `adoptUnanimousValues`), `src/state/aiStore.ts` (`executeBatch`), `src/components/Field.tsx`
- **Verified by:** `src/model/unique.test.ts` (`duplicateOnWrite`, `dropDuplicateSuggestions`), `src/components/Field.test.tsx` (`Field: unique repeatable field`), `src/state/store.ai.test.ts` (`applyAiSuggestionsBatch: unique fields`), `src/state/aiStore.run.test.ts` (`run: unique fields`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-420: Report duplicates in validation and consolidation
`req~dat-420~1`

The system shall report each entry of a unique node that repeats an earlier entry as a "Duplicate entry" validation issue, and shall not delete the entry. When a consolidation value would repeat another entry of a unique node, the system shall refuse it, keep the dialog open, and show a hint.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/validate.ts` (`validateTree`), `src/components/ValidationDialog.tsx`, `src/state/store.ts` (`resolveConsolidationValue`), `src/components/ConsolidationDialog.tsx`
- **Verified by:** `src/model/unique.test.ts` (`validatePaper duplicate issues`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Metadata correction

### REQ-DAT-430: Metadata correction mode
`req~dat-430~1`

The system shall read the optional project key `config.metadataEdit` with the values `off` and `annotation`. The system shall read the old value `project` as `annotation`. An absent or unknown value shall mean `off`. The system shall write the key only when the value is not `off`, so that a project without the key opens and saves unchanged. With `off`, the title, authors, year and DOI of a paper shall stay read-only in the annotation view.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Compatibility)
- **Evidence:** `src/model/metadata.ts` (`parseMetadataEditMode`, `metadataSeatKey`), `src/model/project.ts` (`loadProject`, `serializeProject`, `splitProjectFiles`)
- **Verified by:** `src/model/metadata.test.ts` (`metadata edit mode`, `metadata storage round trip`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Compatibility

### REQ-DAT-440: Stable paper identifier on metadata correction
`req~dat-440~1`

A metadata correction shall change only the title, the authors, the year and the DOI. The system shall never change the paper identifier, the PDF path or the annotations folder of the paper. No dialog shall offer the paper identifier for editing.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/model/metadata.ts` (`applyProjectEdit`, `applySeatEdit`), `src/state/store.ts` (`applyMetadataEdits`), `src/components/MetadataDialog.tsx` (`MetadataDialog`)
- **Verified by:** `src/state/store.metadata.test.ts` (`applyMetadataEdits`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Reliability

### REQ-DAT-450: Write agreed corrections into the project file
`req~dat-450~1`

The system shall write a correction into the paper in the project file only through the confirmed action "Update project metadata" after consolidation (REQ-CON-530). The system shall record the value before the first change of each field in the paper key `metadataOriginal`. When a field returns to its first value, the system shall remove the field from `metadataOriginal`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/metadata.ts` (`applyProjectEdit`), `src/state/store.ts` (`applyMetadataEdits`)
- **Verified by:** `src/model/metadata.test.ts` (`applyProjectEdit`), `src/state/store.metadata.test.ts` (`applyMetadataEdits`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-460: Write corrections into the annotation file
`req~dat-460~1`

With `config.metadataEdit: annotation`, the system shall treat a metadata correction as an annotation. The system shall write a saved correction of a numbered human seat as `metadataOverrides` into the annotation file of that seat, and shall not change the project file. With one reviewer, the system shall write into the annotation file of seat 1. The system shall store only the fields that differ from the project file. An empty input shall mean no override. The system shall not accept a correction in the AI seat or in the Consolidation seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/metadata.ts` (`applySeatEdit`, `metadataSeatKey`), `src/model/project.ts` (`splitProjectFiles`, `assembleLegacyProjectJson`, `loadProject`)
- **Verified by:** `src/model/metadata.test.ts` (`applySeatEdit`, `metadata storage round trip`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-470: Propose corrections from the PDF files
`req~dat-470~1`

On request, the system shall read the title, the authors and the DOI of each paper from its PDF file on the local computer. The system shall propose a correction only for a field that differs from the current value of the seat. The system shall not propose a value that the reviewer ignored before for that field. The system shall not propose a year, and shall not use a network service or an AI model. The system shall not store a proposal until the reviewer saves it into the annotation file (REQ-DAT-460).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfMeta.ts` (`findDoi`, `extractPdfMeta`), `src/model/metadata.ts` (`proposeFromPdf`), `src/state/store.ts` (`scanPdfMetadata`)
- **Verified by:** `src/model/metadata.test.ts` (`proposeFromPdf`), `src/model/pdfMeta.test.ts` (`findDoi`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

## Knowledge graph export

### REQ-DAT-480: Build the knowledge graph
`req~dat-480~1`

The system shall build one graph from the papers and one annotation value tree per paper. The graph shall contain one node for each paper, author, venue and keyword, and one node for each value of a choice field. A choice field is a string field with options or a boolean field. The system shall make one node for each filled entry of a schema node with children. The system shall connect the nodes with the edges `authoredBy`, `publishedIn`, `hasKeyword`, `cites` and `hasAnswer`. Each `hasAnswer` edge shall name the field path. The system shall store other answers as values of the paper node or of the entry node. The system shall merge authors, venues and keywords that differ only in letter case or spaces. The system shall ignore a boolean `false`, an empty answer, a field that `visibleIf` hides, and data that is not in the schema. The system shall read keywords from the paper key `keywords`. The system shall make a `cites` edge only from the paper key `references` or `cites` to a paper of the project, by identifier or by DOI. For the same input, the system shall make the same nodes and edges in the same order.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/graph.ts` (`buildGraph`)
- **Verified by:** `src/model/graph.test.ts` (`buildGraph`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-490: Source of the graph data
`req~dat-490~1`

With one reviewer, the system shall use the annotations of that reviewer. With more reviewers, the system shall use the consolidated annotations if one paper or more has a consolidated answer. Otherwise, the system shall use the annotations of the seat that the user selects. The system shall use the title, the authors, the year, the DOI, the venue and the abstract from the project file only. The system shall not apply the metadata overrides of a seat (REQ-DAT-460).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/graph.ts` (`graphSource`, `graphTrees`)
- **Verified by:** `src/model/graph.test.ts` (`graphSource`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-500: Graph export formats
`req~dat-500~1`

The system shall write the graph as JSON-LD, as RDF Turtle, as GraphML, and as two CSV files: one node list and one edge list. In JSON-LD and Turtle, the system shall describe papers with schema.org and Dublin Core terms. The system shall use the `sailor:` namespace `https://github.com/Gram21/SaiLoR/ns#` for the other node types and for the answer properties. Each field path shall have one property that is a sub-property of `sailor:hasAnswer`. The system shall write the same text for the same graph.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Compatibility)
- **Evidence:** `src/model/graph.ts` (`toJsonLd`, `toTurtle`, `toGraphMl`, `toCsvNodes`, `toCsvEdges`)
- **Verified by:** `src/model/graph.test.ts` (`graph formats`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Compatibility

### REQ-DAT-510: Escape values in the graph export
`req~dat-510~1`

The system shall escape each value for its format. In Turtle, the system shall escape backslashes, quotation marks, line breaks and control characters, and shall percent-encode identifiers in IRIs. In GraphML, the system shall escape the XML special characters and remove characters that XML does not allow. In CSV, the system shall put each cell in quotation marks and double each quotation mark. The system shall add an apostrophe before a CSV cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, so that a spreadsheet does not run the cell as a formula.

Comment:
- **Type:** Functional (ISO 25010: Security, Functional Suitability)
- **Evidence:** `src/model/graph.ts` (`turtleString`, `xmlText`, `csvCell`)
- **Verified by:** `src/model/graph.test.ts` (`graph escaping`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Security, Functional_Suitability

### REQ-DAT-520: Graph export dialog
`req~dat-520~1`

The toolbar shall have a "Knowledge graph" button that opens the export dialog. In the dialog, the user shall select the format. If no consolidated data exists and the project has more than one reviewer, the user shall select the seat. The system shall save each file through the save dialog of the system, with the file extension of the format. For CSV, the system shall ask for the node file first and then for the edge file. The system shall show the path of each saved file or the error.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/ExportGraphDialog.tsx` (`ExportGraphDialog`), `src/components/Toolbar.tsx` (`Toolbar`), `src-tauri/src/pdf.rs` (`text_pick_export_path`, `text_export_extension`)
- **Verified by:** `src/components/ExportGraphDialog.test.tsx` (`ExportGraphDialog`), `src-tauri/src/pdf.rs` (`text_export_extension_allows_known_extensions`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

## PDF folder watch

### REQ-DAT-530: PDF folder setting
`req~dat-530~1`

The system shall read the optional project key `config.pdfFolder`. The value shall be a relative path inside the folder of the project file, with `/` between the folder names. Each folder name shall obey the rules of an annotations folder name (REQ-DAT-165). If the key is absent or not allowed, the system shall not scan a folder. The system shall write the key only when it has a value, so that a project without the key opens and saves unchanged.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Security, Compatibility)
- **Evidence:** `src/model/pdfFolder.ts` (`parsePdfFolder`, `pdfFolderProblem`), `src/model/project.ts` (`loadProject`, `serializeProject`, `splitProjectFiles`)
- **Verified by:** `src/model/pdfFolder.test.ts` (`pdfFolderProblem`, `pdf folder settings round trip`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Security, Compatibility

### REQ-DAT-540: Find new PDF files by file hash
`req~dat-540~1`

A scan shall list each PDF file in the PDF folder and its subfolders. The system shall compare files by their SHA-256 hash, not by their names. A file shall be new when its hash differs from the hash of the PDF file of each paper, from each paper key `pdfSha256` and from each hash in the root key `ignoredPdfs`. Two files with the same hash shall give one new entry. A second scan after the user added a file shall not offer the file again.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/model/pdfFolder.ts` (`newPdfFiles`), `src/state/store.ts` (`scanPdfFolder`)
- **Verified by:** `src/model/pdfFolder.test.ts` (`newPdfFiles`), `src/state/store.pdfFolder.test.ts` (`scanPdfFolder`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Reliability

### REQ-DAT-550: Propose metadata for a new PDF file
`req~dat-550~1`

For each new PDF file, the system shall propose a title, authors, a year and a DOI. The system shall first read the embedded PDF information and the first page (source `pdfinfo`). If the Crossref lookup is on (REQ-DAT-560) and the system found a DOI, a value from Crossref (source `crossref`) shall replace the value from the PDF file. If no source gives a title, the title shall come from the file name (source `filename`). A title from the file name shall flag the entry as "metadata missing". A value that the user changes shall get the source `manual`. The system shall not use an AI model. For an added paper, the system shall write the hash into the paper key `pdfSha256` and the source of each value into the paper key `metadataSource`.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/pdfFolder.ts` (`proposeNewPaper`, `parseCrossrefWork`, `newPaper`), `src/state/store.ts` (`scanPdfFolder`, `addPdfPapers`)
- **Verified by:** `src/model/pdfFolder.test.ts` (`proposeNewPaper`, `parseCrossrefWork`, `newPaper`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-DAT-560: Crossref lookup setting
`req~dat-560~1`

The system shall read the optional project key `config.crossrefLookup`. Only the value `true` shall turn the lookup on. The default shall be off. When the lookup is off, a scan shall not send data to a network service. When the lookup is on, the system shall send only the found DOI to `api.crossref.org`. The system shall write the key only when the lookup is on.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Security)
- **Evidence:** `src/model/pdfFolder.ts` (`crossrefUrl`), `src/model/project.ts` (`loadProject`, `serializeProject`, `splitProjectFiles`), `src/state/store.ts` (`scanPdfFolder`)
- **Verified by:** `src/state/store.pdfFolder.test.ts` (`scanPdfFolder`), `src/model/pdfFolder.test.ts` (`pdf folder settings round trip`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Security

### REQ-DAT-570: Keep papers and identifiers on a scan
`req~dat-570~1`

A scan shall never delete or reorder papers. The system shall add each confirmed paper at the end of the paper list. The identifier of an added paper shall come from its file name, as in the project editor, with a number suffix when the identifier is already in use. The system shall not change the identifier later, except in a merge by hash (REQ-GIT-600).

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/model/pdfFolder.ts` (`newPaper`), `src/state/store.ts` (`addPdfPapers`)
- **Verified by:** `src/model/pdfFolder.test.ts` (`newPaper`), `src/state/store.pdfFolder.test.ts` (`addPdfPapers`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Reliability

## Project editor

### REQ-EDT-10: Validate drafts before save
`req~edt-10~1`

When saving a project draft, the system shall require at least one named schema node (non-screening) or at least one non-blank exclusion reason (screening), a trimmed identifier and title per paper, a PDF path per paper except in screening drafts, every identifier safe as a folder name (REQ-EDT-21), and no two identifiers equal after trimming, case folding, or Unicode normalization, reporting each violation as a clickable issue capped at 12 displayed lines.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:625-636`, `src/model/paperId.ts:43-70,81-83,95-97`, `src/components/ProjectEditor.tsx`, commit `fe92a6e`
- **Verified by:** `src/state/editorStore.test.ts`, duplicate and unsafe identifier cases
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-20: Flag duplicate and unsafe identifiers while typing
`req~edt-20~1`

When two paper rows carry identifiers equal after trimming, case folding, or Unicode normalization, or a row carries an identifier that is unsafe as a folder name, the system shall mark the offending inputs live during editing, stating the reason for an unsafe identifier.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:31-41,52-57`, `src/model/paperId.ts:95-97`, commits `5ac5112`, `fe92a6e`
- **Verified by:** `src/components/PapersEditor.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-21: Portable paper identifiers
`req~edt-21~1`

The system shall treat a paper identifier as unsafe when it is empty, contains a control character or any of `< > : " / \ | ? *`, is `.` or `..`, ends in a dot or a space, or is a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, case-insensitively, with or without an extension), and shall store an edited identifier in Unicode NFC form.

Comment:
- **Type:** Non-functional (ISO 25010: Portability: Adaptability)
- **Evidence:** `src/model/paperId.ts:36,40,43-70,81-83,95-97`, `src/components/PapersEditor.tsx:378`, commit `fe92a6e`
- **Verified by:** `src/model/paperId.test.ts`, `src/components/PapersEditor.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: NonFunctional, Portability_Adaptability

### REQ-EDT-30: Create papers from PDFs
`req~edt-30~1`

When PDF files are added, the system shall create one paper per new file with an identifier slugified from the file name (suffix-deduplicated), a title guessed from the file name or PDF metadata, and a project-relative path, skipping PDFs already in the project with a notice.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:300-350,1213-1237`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-40: Warn before hiding answers
`req~edt-40~1`

When a schema field that papers record answers under (or that mark links point at) is removed, or renamed or re-parented without its answers able to follow (REQ-EDT-41), the system shall request confirmation naming the number of affected papers in the local copy, stating that the answers are kept but hidden until the field returns and that unpulled work is not counted, and: when the branch is known to be behind its upstream: how many commits behind it is; sibling reordering shall proceed without warning.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaTreeEditor.tsx:131,152`, `src/model/fieldUsage.ts:71-74,108-112`, commits `a0034e9`, `638e1b5`, `fa30150`, `a068166`
- **Verified by:** `src/components/SchemaTreeEditor.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-41: Move answers with a renamed or moved field
`req~edt-41~1`

When a schema field that papers record answers under is renamed or moved to another group, the system shall state under the field how many papers are affected and that their answers will move with it on save, and shall offer to keep them hidden instead; when the answers cannot follow because the move passes through a repeated group, it shall say so.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts:368`, `src/components/SchemaTreeEditor.tsx:131,511`, commit `40e0668`
- **Verified by:** `src/state/editorStore.schemaVersion.test.ts` (`pendingSchemaMoves`, `records no move when the reviewer chose to keep the answers hidden`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-42: Fold unpublished schema changes into one version
`req~edt-42~1`

When the schema is saved with changes while the current schema version is not yet in the repository HEAD: or, outside a repository, was created less than six minutes ago: the system shall fold the changes into that version under a new identifier that records the folded one, instead of adding a history entry; otherwise it shall add a new version descending from the current one.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/schemaVersion.ts:109-127`, `src/state/editorStore.ts:636-668`, commit `40e0668`
- **Verified by:** `src/state/editorStore.schemaVersion.test.ts` (`without git, folds an edit made within minutes into the same version`, `in a repository, starts a new version once the current one is committed`), `src/model/schemaVersion.test.ts` (`gives a file stamped with a folded-in version only the moves it has not seen`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-45: Confirm renaming an annotated paper's identifier
`req~edt-45~1`

When the identifier of a paper with recorded annotations is changed and the edit is committed, the system shall request confirmation stating that the paper's annotation folder is named after the identifier and that other reviewers' unpulled work under the old identifier will not follow, and shall restore the previous identifier when declined.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:149`, commit `fa30150`
- **Verified by:** `src/components/PapersEditor.test.tsx`, test `confirm renaming the id of an annotated paper`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-46: Own annotations folder for a project started from screening
`req~edt-46~1`

When a new project is started from a screening project and saved next to it, the system shall rename carried paper identifiers that the screening project already uses and give the new project an annotations folder named after its file, so the two projects never write the same files.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts` (`resolveScreeningImport`), `src/model/annotationsDir.ts` (`defaultSplitDirName`, `sharesPaper`), commit `4e3fa4e`
- **Verified by:** `src/test/integration/screeningImport.integration.test.tsx`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-50: Confirm removal of annotated papers
`req~edt-50~1`

When a paper with recorded annotations is removed in the editor, the system shall request confirmation stating that all reviewers' annotations will be discarded on the next save.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:90-102`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-60: Edit schema tree graphically
`req~edt-60~1`

The system shall provide a drag-and-drop schema tree editor offering group, text, number, year, and yes/no nodes, inline enum options, cardinality inputs with an unbounded toggle, descriptions, a required checkbox for eligible fields, a visibility-gate button that summarizes the node's `visibleIf` and opens a dialog for editing it (the gated node's tree path and type, conditions restricted to legal targets and labelled with each target's level and value kind, an explicit any-answer/specific-value choice per condition, values offered only for yes/no and option-list fields, arbitrarily nested AND/OR groups that can be extended after creation, targets listed same-level first then ancestors then the rest of the schema in document order, per-entry reordering and removal, and drag-and-drop of a condition or a whole group into another group), and refusal of drops into a node's own subtree.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaTreeEditor.tsx:20-26,211-240,285-470`, `src/components/VisibleIfDialog.tsx` (`VisibleIfDialog`, `moveEntryTo`), `src/components/VisibleIfDialog.test.ts`
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-70: Record the review protocol
`req~edt-70~1`

The system shall let the user record a review protocol (research questions, search strings, databases, search date, notes) edited one item per line, storing no protocol record when all parts are empty.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ProtocolEditor.tsx:38-132`, `src/model/project.ts:515-534`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-80: Show schema info once per load
`req~edt-80~1`

When a project carries a schema-wide info text, the system shall display it in a dialog automatically once per project load and on demand via an info button, rendering contained URLs as links.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaInfoDialog.tsx:5-63`, commit `8322d10`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-90: Reorder papers by drag
`req~edt-90~1`

The system shall let the user reorder paper rows by dragging a handle, with drop-position indicators.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/PapersEditor.tsx:43-343`
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-100: Unique toggle and compare-by picker
`req~edt-100~1`

The system shall show a Unique checkbox only on a repeatable schema node. When Unique is set on a node with children, the system shall show one checkbox per child to select the `uniqueBy` fields. The selection shall follow child renames. The system shall save `unique` only on a repeatable node and `uniqueBy` only with at least one selected child.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/SchemaTreeEditor.tsx`, `src/state/editorStore.ts` (`toAnnotationDefs`, `fromAnnotationDefs`)
- **Verified by:** `src/components/SchemaTreeEditor.test.tsx` (`SchemaTreeEditor: unique option`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-110: Store strict mode settings
`req~edt-110~1`

The system shall store strict mode in the optional project keys `config.strict`, `config.persons` and `config.assignments`, write each key only when it holds a value, and open and save a project without these keys unchanged.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Compatibility)
- **Evidence:** `src/model/strict.ts` (`parseStrictConfig`, `strictConfigJson`), `src/model/project.ts` (`loadProject`, `serializeProject`, `splitProjectFiles`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability, Compatibility

### REQ-EDT-120: Validate strict mode settings on load
`req~edt-120~1`

When a project has strict mode keys, the system shall refuse to open the project and list each problem if `config.strict` is not a boolean, a person has an empty or duplicate identifier or name, an assignment names an unknown person, an assignment seat is not a positive whole number, or one paper has the same seat or the same person twice. The system shall ignore assignments for paper identifiers that the project does not contain. The system shall keep assignments for seats above the reviewer count in the file and ignore them until the count is raised again.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/model/strict.ts` (`parseStrictConfig`), `src/state/editorStore.ts` (`validateDraft`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability, Reliability

### REQ-EDT-130: Manage persons in the project editor
`req~edt-130~1`

For an annotation project with more than one reviewer, the project editor shall let the user turn strict mode on and off, add a person, rename a person and remove a person. When a person has finished work on a paper, the system shall refuse to remove that person.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/StrictModeEditor.tsx` (`StrictModeEditor`), `src/state/editorStore.ts` (`setStrictEnabled`, `addPerson`, `renamePerson`, `removePerson`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-140: Assign papers to persons
`req~edt-140~1`

The project editor shall let the user assign a person to each numbered seat of each paper and clear that assignment. The system shall refuse to change an assignment whose work is finished.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/StrictModeEditor.tsx` (`StrictModeEditor`), `src/state/editorStore.ts` (`setAssignment`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-150: Assign persons in bulk
`req~edt-150~1`

When the user requests a bulk assignment of N persons per paper, the system shall fill the free seats of each paper that has no assignment, in turn over the persons (round robin), and shall not use the AI seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/strict.ts` (`bulkAssign`), `src/state/editorStore.ts` (`bulkAssignStrict`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-160: Show work per person
`req~edt-160~1`

The strict mode section of the project editor shall show, for each person, the number of assigned papers and the number of finished papers.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/strict.ts` (`personCounts`), `src/components/StrictModeEditor.tsx` (`StrictModeEditor`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-170: Reopen finished work
`req~edt-170~1`

The project editor shall let the user reopen the finished work of a person on a paper. Reopening shall remove the finished flag and `finishedAt` of that seat on that paper, and shall write `reopenedAt` (ISO time) for that seat.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/StrictModeEditor.tsx` (`StrictModeEditor`), `src/state/editorStore.ts` (`reopenWork`)
- **Status:** Implemented

Needs: impl

Tags: Functional, Functional_Suitability

### REQ-EDT-180: Select the metadata correction mode
`req~edt-180~1`

The project editor shall let the user select the metadata correction mode `off` or `annotation` (REQ-DAT-430). The default shall be `off`. The change shall be part of the editor undo history.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/editorStore.ts` (`setMetadataEdit`, `buildProjectJson`), `src/components/ProjectEditor.tsx`
- **Verified by:** `src/state/editorStore.metadata.test.ts` (`metadata edit setting`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability

### REQ-EDT-200: Set the PDF folder and the Crossref lookup
`req~edt-200~1`

The project editor shall let the user set the PDF folder (REQ-DAT-530) and turn the Crossref lookup on or off (REQ-DAT-560). The Crossref lookup shall be off by default. The editor shall show why a PDF folder is not allowed. Each change shall be part of the editor undo history.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/state/editorStore.ts` (`setPdfFolder`, `setCrossrefLookup`, `buildProjectJson`), `src/components/ProjectEditor.tsx`
- **Verified by:** `src/state/editorStore.pdfFolder.test.ts` (`pdf folder settings`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-EDT-300: Organize the project editor in tabs
`req~edt-300~1`

The project editor shall show its sections in the tabs Schema, Papers, Settings and Preview. The tabs shall use the ARIA roles `tablist`, `tab` and `tabpanel`. The arrow keys, Home and End shall move between the tabs. In a right-to-left locale, the arrow keys shall be swapped. The selected tab shall be UI state only. A change of tab shall not change, discard or save the draft. A "Paper N" issue shall open the Papers tab and go to that paper. A screening draft shall not show the Preview tab.

Comment:
- **Type:** Functional (ISO 25010: Usability)
- **Evidence:** `src/components/ProjectEditor.tsx` (`onTabKey`, `tabPanel`, `jumpToPaper`), `src/styles/editor.css`
- **Verified by:** `src/components/ProjectEditor.test.tsx` (`ProjectEditor: tabs`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Usability

### REQ-EDT-310: Preview the draft schema as an annotation form
`req~edt-310~1`

The Preview tab shall show the annotation form for the draft schema. It shall use the same annotation components as the annotation panel. The form shall show the first paper of the draft, and the user shall be able to select a different paper. `visibleIf` conditions, adding and removing instances and validation hints shall work as in the annotation panel. The tab shall show a banner that says nothing is saved. The answers shall be kept in local state only. They shall be discarded when the user leaves the tab or closes the editor. The preview shall not change the project store, the undo history, the annotation files, the dirty flag, the autosave or Git.

Comment:
- **Type:** Functional (ISO 25010: Functional Suitability, Usability)
- **Evidence:** `src/components/SchemaPreview.tsx` (`SchemaPreview`, `PreviewForm`), `src/components/AnnotationFormContext.ts`, `src/components/AnnotationNode.tsx`, `src/components/Field.tsx`
- **Verified by:** `src/components/SchemaPreview.test.tsx` (`SchemaPreview: the draft schema as a throwaway annotation form`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Functional_Suitability, Usability

### REQ-EDT-320: Show the schema problems instead of the preview
`req~edt-320~1`

If the draft schema is not valid, the Preview tab shall list the problems and shall not show the form.

Comment:
- **Type:** Functional (ISO 25010: Reliability, Usability)
- **Evidence:** `src/components/SchemaPreview.tsx` (`SchemaPreview`), `src/state/editorStore.ts` (`validateDraft`)
- **Verified by:** `src/components/SchemaPreview.test.tsx` (`lists the problems instead of the form when the draft schema is invalid`)
- **Status:** Implemented

Needs: impl, utest

Tags: Functional, Reliability, Usability
