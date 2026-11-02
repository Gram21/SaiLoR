# Technical report

This folder holds the technical report about SaiLoR.
The authors plan to publish the report on arXiv when version 2.0.0 is released.

## Audience and scope

- Primary audience: software engineering researchers who run systematic literature reviews (SLRs).
- Core idea: support SLRs in a systematic way with one tool.
- Tool description: from the user's view. Describe features, not internals.
- Architecture: describe only the major decisions (for example, the move from Electron to Tauri, git as sync layer).
- Requirements: explain that SaiLoR has requirements linked to code, tests and docs.

## Layout

| Path | Content |
|---|---|
| `main.tex` | Root document. Uses the IEEE template (`IEEEtran`, conference mode). |
| `sections/*.tex` | One file per section. |
| `acronyms.tex` | Acronyms and their macros, for example `\SLR` and `\LLM`. Use the macros. Do not type an acronym by hand. |
| `figures.tex` | One macro per screenshot. Change the macro to swap a screenshot. |
| `trace_stats.py` | Counts the requirements and their trace links in `docs/requirements/`. Run `python3 technical-report/trace_stats.py` from the repository root. |
| `references.bib` | Bibliography. |
| `figures/` | Figures. Link screenshots from `../user-guide/screenshots/`. |
| `Makefile` | `make` builds `SaiLoR-technical-report.pdf` with `latexmk`. |
| `.gitignore` | Ignores LaTeX build artifacts. Only `SaiLoR-technical-report.pdf` stays tracked. |
| `WRITING_STYLE.md` | Local style guide. Never commit this file. Read it before you write text. |

## Section plan

| # | Section | Content | Screenshots |
|---|---|---|---|
| 1 | Introduction | SLR pain points, goal, contributions | `annotate-overview` |
| 2 | Background and related work | SLR process, existing tools, gaps | none |
| 3 | Approach | Systematic support along the SLR phases | none |
| 4 | The tool | Features by phase (see below) | many |
| 5 | Architecture decisions | Local-first, git sync, Tauri, security model | none |
| 6 | Requirements and traceability | Requirement files, IDs, links to code and tests | none |
| 7 | Discussion and limitations | Threats, scope, future work | none |
| 8 | Conclusion | Summary, availability, license | none |

Section 4 feature map (screenshots are in `user-guide/screenshots/`):

| Feature | Screenshot |
|---|---|
| Project setup and schema editor | `start-screen`, `project-editor-schema`, `project-editor-protocol` |
| Paper search and import | `paper-search`, `duplicate-review-dialog` |
| Screening | `screening-record`, `screening-summary`, `screening-reasons-editor` |
| Annotation and evidence in PDF | `annotate-overview`, `grab-from-pdf-selection`, `completeness-dots` |
| AI-assisted annotation | `reviewer-prompt` |
| Multiple reviewers and consolidation | `consolidation-view`, `consolidation-compare-popup`, `disagreements-dialog`, `agreement-dialog` |
| Git collaboration | `git-field-review`, `git-merge-conflicts` |
| Validation | `validate-dialog` |

## Phases

1. **Skeleton.** Create this folder. Done.
2. **Fix claims.** Collect facts for each section from `docs/requirements/` and `user-guide/`. Count requirements, tests and links with `trace_stats.py`. Done.
3. **Related work.** Survey SLR tools and write section 2 with citations in `references.bib`. Done. Two summaries have a `% TODO verify` comment.
4. **Screenshots.** Retake screenshots on the Tauri build of 2.0.0. Store them in `figures/`. Open. The figures still show version 1.x.
5. **Release data.** After the 2.0.0 release, add the version, the download link and the Zenodo DOI. Partly done. The version DOI, the final installer sizes and the final test counts are `\todo` items.
6. **Write the paper.** Write all sections from the outlines. Check each claim against the code. Draft done.
7. **Review and submit.** Run an internal review. Fix the findings. Upload the source to arXiv.

Each phase ends when its listed output exists and a co-author has reviewed it.
