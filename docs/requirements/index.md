# SaiLoR — Software Requirements

Requirements reverse-engineered from the implemented codebase (source, tests, docs, and
commit history) as of 2026-08-27 (v1.8.1). Every requirement documents behavior that is
actually implemented; each entry cites its evidence. IDs are numbered in steps of ten per
category so requirements can be inserted without renumbering.

## Files

| File | Prefix(es) | Scope |
|---|---|---|
| [data-model.md](data-model.md) | REQ-DAT, REQ-EDT | Project JSON format, schema rules, annotation trees, validation, completeness, duplicate detection, reference import, project editor |
| [annotation-ui.md](annotation-ui.md) | REQ-ANN, REQ-LST, REQ-PDF, REQ-UI | Annotation form, paper list, PDF viewer, highlights/notes, evidence linking, reading position, PDF export, workspace shell |
| [screening.md](screening.md) | REQ-SCR | Title/abstract and full-text screening: decisions, exclusion reasons, counts, import hand-off |
| [consolidation.md](consolidation.md) | REQ-CON | Reviewer seats, alignment of repeated entries, disagreement detection, unanimous adoption, agreement metrics, disagreement export |
| [git-integration.md](git-integration.md) | REQ-GIT | Clone, status/commit, pull/merge, branches, history, git security gates |
| [llm-annotation.md](llm-annotation.md) | REQ-LLM | LLM providers, key handling, prompt/response validation, suggestion review, AI-usage disclosure |
| [platform.md](platform.md) | REQ-PLT | Desktop shell, open/save, unsaved-changes protection, recents, settings, PDF access control, self-update, build targets |
| [traceability.md](traceability.md) | — | Requirements-to-code traceability matrix with link-recovery method and coverage statistics |

## Glossary

| Term | Meaning |
|---|---|
| **Project** | One SaiLoR review: a `project.json` (metadata, schema, papers) plus a sibling `annotations/` folder with per-paper, per-seat files. |
| **Schema** | The nested, cardinality-controlled taxonomy of annotation nodes defined in the project configuration. |
| **Node / field** | A schema entry; a *field* is a node with a value type (string, number, boolean, year); a *group* has only children. |
| **Repeatable node** | A node whose `max` is null or greater than 1; each occurrence is an *instance* (or *entry*). |
| **Annotation tree** | The nested value structure mirroring the schema in which one seat's answers for one paper are stored. |
| **Seat** | The acting identity in a session: a numbered reviewer (1..N) or Consolidation. |
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

## Coverage summary

| Category | Requirements |
|---|---|
| Data model & editor (DAT/EDT) | 47 |
| Annotation UI, paper list, PDF (ANN/LST/PDF/UI) | 43 |
| Screening (SCR) | 38 |
| Consolidation (CON) | 40 |
| Git integration (GIT) | 39 |
| LLM annotation (LLM) | 31 |
| Platform & shell (PLT) | 34 |
| **Total** | **272** |

## Method & evidence notes

- Sources analyzed: `README.md`, `docs/annotation-schema.md`, the `openwiki/` developer wiki
  (verified 2026-08-26 against source), the full `src/` tree with its extensive unit tests,
  `electron/`, `e2e/` Playwright specs, integration tests, and 393 commits of history.
- Test names and assertions were treated as primary evidence of intended behavior; commit
  hashes are cited where a feature's introduction pins the requirement.
- Every requirement's **Type** field states Functional/Non-functional plus the ISO/IEC 25010
  quality characteristic (2011 edition names: Functional Suitability, Performance Efficiency,
  Compatibility, Usability, Reliability, Security, Maintainability, Portability), with the
  sub-characteristic added where it disambiguates. Functional requirements fall under
  Functional Suitability; design constraints are labeled as such in addition.
- Thin-evidence areas deliberately not turned into requirements: exact visual styling,
  internal performance optimizations without a tested threshold, and the discontinued
  browser/Docker deployment (documented only as the REQ-PLT-10 refusal behavior).
- One known, documented limitation is captured inside the consolidation evidence rather
  than as a requirement: project-wide agreement statistics can misread unaligned papers;
  the implemented mitigation is the REQ-CON-330 warning.
