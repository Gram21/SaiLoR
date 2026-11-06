# SaiLoR: Software Requirements

Requirements reverse-engineered from the implemented codebase (source, tests, docs, and
commit history) as of 2026-08-27 (v1.8.1), with incremental updates through 2026-09-07
(main at `8b93cbe`) and 2026-09-23 (source at `51a424d`, the git-hardening work) for
behavior changed since. Every requirement documents behavior that
is actually implemented; each entry cites its evidence. IDs are numbered in steps of ten
per category so requirements can be inserted without renumbering.

## Files

| File | Prefix(es) | Scope |
|---|---|---|
| [data-model.md](data-model.md) | REQ-DAT, REQ-EDT | Project JSON format, schema rules, annotation trees, validation, completeness, duplicate detection, reference import, project editor |
| [annotation-ui.md](annotation-ui.md) | REQ-ANN, REQ-LST, REQ-PDF, REQ-UI | Annotation form, paper list, PDF viewer, highlights/notes, evidence linking, reading position, PDF export, workspace shell |
| [screening.md](screening.md) | REQ-SCR | Title/abstract and full-text screening: decisions, exclusion reasons, counts, import hand-off |
| [consolidation.md](consolidation.md) | REQ-CON | Reviewer seats, alignment of repeated entries, disagreement detection, unanimous adoption, agreement metrics, disagreement export |
| [git-integration.md](git-integration.md) | REQ-GIT | Clone, status/commit, pull/merge, branches, stashes, history, repository setup, seat-collision warnings, git security gates |
| [llm-annotation.md](llm-annotation.md) | REQ-LLM | LLM providers, key handling, prompt/response validation, suggestion review, AI-usage disclosure |
| [platform.md](platform.md) | REQ-PLT | Desktop shell, open/save, unsaved-changes protection, recents, settings, PDF access control, self-update, build targets, Zenodo archiving |
| [traceability.md](traceability.md) | — | Requirements-to-code traceability matrix with link-recovery method and coverage statistics |

## Glossary

| Term | Meaning |
|---|---|
| **Project** | One SaiLoR review: a `project.json` (metadata, schema, papers) plus a sibling `annotations/` folder with per-paper, per-seat files. |
| **Schema** | The nested, cardinality-controlled taxonomy of annotation nodes defined in the project configuration. |
| **Node / field** | A schema entry; a *field* is a node with a value type (string, number, boolean, year); a *group* has only children. |
| **Repeatable node** | A node whose `max` is null or greater than 1; each occurrence is an *instance* (or *entry*). |
| **Annotation tree** | The nested value structure mirroring the schema in which one seat's answers for one paper are stored. |
| **Seat** | The acting identity in a session: a numbered reviewer (1..N) or Consolidation. A seat is a role per paper, not a person: when papers are divided among more reviewers than there are seats, different people hold the same seat on different papers. |
| **Consolidated tree** | The tree the Consolidation seat writes; the project's shipping answers. |
| **Consolidator** | The person acting in the Consolidation seat. |
| **Alignment** | The stored matching of different reviewers' repeatable entries into shared slots. |
| **Slot** | One matched position in an alignment holding at most one entry per reviewer. |
| **Mark** | A per-seat PDF overlay annotation: a highlight or a sticky note, optionally commented and linked to fields as evidence. |
| **Screening project** | A project whose configuration defines exclusion reasons; its schema is the fixed Decision/Reason pair. |
| **Dirty** | The in-memory project differs from the file on disk. |
| **Undo step** | One entry in the application's undo history; one Ctrl/Cmd+Z reverts it entirely. |
| **Normalization (of values)** | Trimming, lowercasing, and whitespace-collapsing applied before equality comparison. |
| **Target (LLM)** | A saved LLM configuration: name, provider, base URL, model, attachment mode, optional reasoning effort, and a stored key. |
| **Project's own files** | `project.json` plus the files under its `annotations/` folder matching the project's paper identifiers and file-name family. |
| **Family (project kind)** | Screening versus annotation projects, distinguished by their annotation file-name prefixes. |
| **Hidden answer** | A recorded answer stored under a schema node the current schema no longer describes (after a field was removed, renamed, or lost its children). Kept in the files and shown again when the node returns; see REQ-DAT-165. |
| **Stash** | Uncommitted changes that git has parked outside the working tree. |
| **Carry-over** | The stash SaiLoR creates to move uncommitted project changes across a branch switch. |
| **Managed block** | The delimited section of a `.gitattributes` or `.gitignore` that SaiLoR maintains; content outside it belongs to the user and is never changed. |
| **Strict mode** | An optional project setting that limits each person to the papers and seats assigned to that person. It is a workflow aid, not a security control. |
| **Person** | A named member of the review team in strict mode. A person is different from a seat: one person can hold different seats on different papers. |
| **Assignment** | The link from a paper and a numbered seat to one person in strict mode. |

## Coverage summary

| Category | Requirements |
|---|---|
| Data model & editor (DAT/EDT) | 92 |
| Annotation UI, paper list, PDF (ANN/LST/PDF/UI) | 68 |
| Screening (SCR) | 39 |
| Consolidation (CON) | 61 |
| Git integration (GIT) | 66 |
| LLM annotation (LLM) | 103 |
| Platform & shell (PLT) | 52 |
| **Total** | **481** |

## Method & evidence notes

- Sources analyzed: `README.md`, `docs/annotation-schema.md`, the `openwiki/` developer wiki
  (verified 2026-08-26 against source), the full `src/` tree with its extensive unit tests,
  `electron/`, `e2e/` Playwright specs, integration tests, and 393 commits of history.
  `electron/` and the `e2e/` Playwright specs were the sources before 2.0.0. Since 2.0.0,
  the Tauri shell in `src-tauri/` replaces `electron/`. The Playwright specs are removed.
- Test names and assertions were treated as primary evidence of intended behavior; commit
  hashes are cited where a feature's introduction pins the requirement.
- Every requirement's **Type** field states Functional/Non-functional plus the ISO/IEC 25010
  quality characteristic (2011 edition names: Functional Suitability, Performance Efficiency,
  Compatibility, Usability, Reliability, Security, Maintainability, Portability), with the
  sub-characteristic added where it disambiguates. Functional requirements fall under
  Functional Suitability; design constraints are labeled as such in addition.
- Thin-evidence areas deliberately not turned into requirements: exact visual styling,
  internal performance optimizations without a tested threshold, and the discontinued
  browser deployment (documented only as the REQ-PLT-10 refusal behavior).
  The Linux container with a browser view is covered by REQ-PLT-380.
- One known, documented limitation is captured inside the consolidation evidence rather
  than as a requirement: project-wide agreement statistics can misread unaligned papers;
  the implemented mitigation is the REQ-CON-330 warning.
- **Update of 2026-09-23 (git hardening).** 24 requirements added and 11 revised to match
  behavior changed on the `fix/dont-rewrite-untouched-annotations` branch. Revised
  requirements keep their IDs and are rewritten in place where their behavior changed:
  REQ-DAT-160 (unknown tree keys are now kept rather than dropped), REQ-DAT-300 (a project
  is no longer rewritten when opened), REQ-EDT-10/20/40, REQ-CON-30/40, REQ-PLT-62, and
  REQ-GIT-110/170/350. Evidence line ranges for these entries were resolved from the source
  symbols in the source rather than transcribed, and every cited test name was checked to
  exist. The coverage table above was recounted from the requirement files; it had fallen
  behind before this update (it read 277 while the files held 285).
- **Docs links after the wiki refresh (`a6f883f`).** The requirements added on 2026-09-23
  link the `openwiki/` and `user-guide/` sections describing them, all except REQ-GIT-500
  (merging hidden answers), which neither describes. The wiki pages' prose was corrected by
  hand where it contradicted the source (repository setup, background fetch, seat memory);
  their OpenWiki claim files were not regenerated.
- **Save conflicts (2026-09-23, source at `5e2abb4`).** REQ-PLT-135 revised (a stopped save
  now asks instead of failing) and REQ-PLT-136 added for the three ways to resolve it.
- **Project-file merge (source at `543cb13`).** REQ-GIT-250 and REQ-GIT-260 rewritten (project
  settings and removed schema fields no longer refuse a merge) and REQ-GIT-255 added for the
  node-by-node schema merge.
- **Schema versions (source at `40e0668`).** REQ-DAT-166–168, REQ-EDT-41–42, REQ-PLT-43 and
  REQ-GIT-256 added; REQ-EDT-40 narrowed to the changes whose answers cannot follow. REQ-GIT-257
  added for conflicting renames (source at `c9c982f`).
- **Annotations folders (source at `c1b40ec`).** REQ-DAT-169, REQ-PLT-95 and REQ-PLT-96 added; REQ-PLT-90
  rewritten (a shared folder is avoided or split rather than only refused at Save As).
- **Git scenarios (source at `47fb3f9`).** REQ-GIT-520 added for the reproducible scenarios in
  `samples/git-scenarios/`.
- **Screening beside annotation.** REQ-PLT-90 and REQ-PLT-95 narrowed to projects that share a paper
  identifier; REQ-EDT-46 added for the folder a project started from screening gets.
- **Highlight file names (source at `6eb9027`).** REQ-DAT-172 added; REQ-PLT-90 and REQ-PLT-95 narrowed
  to projects of the same kind.
- **Screening highlights (source at `780f1d1`).** REQ-PDF-185 added.
- **Update of 2026-11-02 (release/2.0.0 at `96c4ec3`).** Stale line ranges replaced with symbol names,
  Electron-era paths removed, and test links added for REQ-LLM-40, REQ-LLM-80, REQ-UI-20, REQ-GIT-90,
  REQ-GIT-120, REQ-GIT-220, REQ-GIT-380 and REQ-GIT-400. REQ-GIT-530 (git output cap) and REQ-PLT-360
  (update install refused with unsaved changes) added. Coverage counts recounted with `trace_stats.py`.
- **Strict mode with persons (2026-11-03).** REQ-EDT-110 to REQ-EDT-170 added for the strict mode settings,
  their validation and the person management in the project editor. REQ-CON-450 to REQ-CON-520 added for the
  person dialog, the paper and seat limits, Finish and the consolidation gate.
- **Languages (2026-11-03).** REQ-UI-110 to REQ-UI-130 and REQ-PLT-400 added for the language setting, the
  translated interface, the complete language files and the translated native menus. REQ-UI-90 revised for the
  Language section. The coverage counts above were not recounted.
- **More languages (2026-11-03).** REQ-UI-110 revised for Chinese (Simplified), Persian, Spanish, French,
  Italian, Portuguese and Japanese. REQ-UI-120 revised for plural forms. REQ-UI-130 and REQ-PLT-400 revised
  for all language files and menu tables. REQ-UI-140 added for the right-to-left layout of Persian. The
  coverage counts above were not recounted.
- **Metadata correction (2026-11-05).** REQ-DAT-430 to REQ-DAT-470 and REQ-EDT-180 added for the
  `config.metadataEdit` mode, the stable paper identifier, the two storage targets and the PDF proposals.
  REQ-ANN-180 and REQ-LST-80 added for the Metadata dialog and the paper list badge. REQ-CON-530 added for
  the consolidation of metadata overrides. REQ-GIT-580 added for the merge and commit of the overrides.
  The coverage counts above were recounted with `trace_stats.py`.
- **Metadata as annotation (2026-11-05).** REQ-DAT-430, REQ-DAT-440, REQ-DAT-450, REQ-DAT-460, REQ-DAT-470,
  REQ-EDT-180, REQ-ANN-180, REQ-LST-80 and REQ-CON-530 revised. A correction is now an annotation in the seat file.
  Only the confirmed update after consolidation writes into `project.json`. The mode `project` reads as `annotation`.
  REQ-GIT-580 revised for the conflict row of `config.metadataEdit`. The requirement count did not change.
- **PDF folder watch (2026-11-05).** REQ-DAT-530 to REQ-DAT-570 and REQ-EDT-200 added for the
  `config.pdfFolder` and `config.crossrefLookup` settings, the scan by file hash and the proposals.
  REQ-ANN-200, REQ-ANN-210 and REQ-LST-90 added for the confirmation dialog, the scan triggers and the
  "missing" badge. REQ-GIT-600 added for the merge by PDF hash. REQ-PLT-420 added for the desktop scan.
  The coverage counts above were not recounted.
- **Settings in the help (2026-11-05).** REQ-UI-150 added for the "Settings…" item in the Help menus and
  the "Open settings" button in the Help dialog. The coverage counts above were not recounted.
- **Toolbar rework (2026-11-05).** REQ-UI-160 and REQ-UI-170 added for the project-only toolbar entries, the Export menu
  and the hidden AI entries. REQ-LLM-830 and REQ-DAT-490 moved their entry point. The coverage counts above were not recounted.
- **Editor tabs and preview (2026-11-05).** REQ-EDT-300 to REQ-EDT-320 added for the project editor tabs,
  the preview of the draft schema and the list of schema problems. The coverage counts above were not recounted.
- **AI evaluation (2026-11-05).** REQ-LLM-820 to REQ-LLM-832 added for the per-field comparison of the
  AI seat with the consolidated answers, the AI evaluation dialog, its CSV export and its empty state. The coverage counts above include them.
- **AI prompt overrides (2026-11-05).** REQ-LLM-790 to REQ-LLM-795 added for the project-level role, field help and examples of the AI prompt. The coverage counts above include them.
- **CI scripts (2026-11-05).** REQ-PLT-430 added: every CI job runs from a script. The coverage counts above include it.
- **Knowledge graph view (2026-11-06).** REQ-UI-190 to REQ-UI-210 added for the knowledge graph view in the Export menu,
  its query syntax and the sub-graph limit. The coverage counts above were not recounted.
