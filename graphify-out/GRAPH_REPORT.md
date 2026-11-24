# Graph Report - slr-helper  (2026-11-24)

## Corpus Check
- 695 files · ~1,125,009 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 147 file(s) not represented in the graph (top: .toml 107, (none) 12, .tex 11)

## Summary
- 7535 nodes · 21535 edges · 275 communities (230 shown, 45 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 2910 edges (avg confidence: 0.94)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b4394c2b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- git.rs
- Rust Docs/Builders
- Test Fixtures & Libs
- parse.ts
- Agent Deps & LLM Plan
- Run Feedback
- Chat Requests & Models
- Git Repo Setup
- useT
- graphCanvas.ts
- Rust Project Model
- Consolidation & agreement ([consolidation.md](consolidation.md))
- Rust IO & Paths
- Ollama & Base URLs
- Rust LLM HTTP
- Merge Logic
- LlmSettingsDialog.tsx
- model/project.ts
- Chat Response Parsing
- annotations.ts
- Diagram View
- dependencies
- Cypher Worker
- consolidationAndMerge.integration.test.tsx
- PaperList.tsx
- Token Budget
- splitProjectFiles
- metadata.ts
- sh
- Screening Panel
- agent.ts
- desktop.ts
- Git Branch/Pull Ops
- Diagram Export
- Tauri Menu
- IP/Host Validation
- Dialog Close (Rust)
- quickstart.md
- gitStore.ts
- tauri.ts
- settings.ts
- i18n.ts
- graphSuggest.ts
- model/schema.ts
- Data model & project editor ([data-model.md](data-model.md))
- editorStore.ts
- Project editor
- VisibleIfDialog.tsx
- Task Routing
- Requirements: LLM-Assisted Annotation
- localruntime.rs
- graphQuery.ts
- GitPlatform
- PlatformAdapter
- oftlib.py
- ConsolidationOverview.tsx
- stashOps.ts
- applySplit
- ollama.ts
- pdfFolder.ts
- Git
- duplicates.ts
- net.rs
- GraphView.tsx
- references.ts
- NodeName.tsx
- agreement.property.test.ts
- annotationState
- Requirements: LLM-Assisted Annotation
- align.ts
- Requirements: Git Integration
- builder.ts
- readiness.ts
- pdfMarks.ts
- Requirements: Git Integration
- tauri.conf.json
- architecture.js
- Requirements: Platform, Desktop Shell & File Handling
- merge.test.ts
- ProjectEditor.tsx
- AiDialog.tsx
- hardware.rs
- update.rs
- refPreview.ts
- Project editor
- feedback.rs
- GraphView.test.tsx
- refProblem
- text.ts
- hasAnnotations
- store.ts
- Annotation Schema and Validation
- Requirements: Platform, Desktop Shell & File Handling
- SeatConflictNotice.tsx
- schemaVersion.ts
- Requirements: Multi-Reviewer Consolidation & Agreement
- Stage
- clone
- aiStore.recheck.test.ts
- Requirements: Multi-Reviewer Consolidation & Agreement
- LLM-assisted annotation ([llm-annotation.md](llm-annotation.md))
- ConflictResolutionDialog.tsx
- version.ts
- store.ai.test.ts
- store.saveRace.test.ts
- pdfReadingPosition.integration.test.tsx
- PaperList
- Screening
- aiScreeningStore.test.ts
- Requirements: Screening
- Action
- PdfViewer.linkPreview.test.tsx
- 3. Defining the annotation schema
- Requirements: Screening
- manager
- Workspace shell
- Authoring a SaiLoR project file
- progressiveLoad.test.ts
- store.batch-unanimous.test.ts
- repoSetup.ts
- LlmSettingsDialog.local.test.tsx
- PdfViewer.marks.test.tsx
- deploy
- check-site-links.js
- steps
- store.aimarks.test.ts
- store.align.test.ts
- HelpDialog.tsx
- ValidationDialog.tsx
- PDF viewer
- MockResizeObserver
- with
- Working with several reviewers
- MockResizeObserver
- LocalRuntimeApi
- store.resyncDirty.test.ts
- Scenarios
- PdfViewer.demo.test.tsx
- completeness.test.ts
- editorStore.schemaVersion.test.ts
- adapter.ts
- Git Integration
- Annotation value trees
- steps
- steps
- Getting started
- protocol.rs
- PDF viewer
- MemoryStorage
- store.equality.test.ts
- steps
- scenarios.ts
- Annotation form
- align.property.test.ts
- launch
- 18. Port leftovers (renderer, exports, git cap)
- Annotation form
- Workspace shell
- compilerOptions
- tauri-linux-gui
- sailor
- SaiLoR User Guide
- Project file loading
- editorStore.realPdf.test.ts
- compilerOptions
- TODO: Capture the report screenshots
- Build SaiLoR from source
- run
- Git support
- Setting up a project
- Evaluation: Move from Electron to Tauri
- tauri-build
- env
- package.json
- 20. Phase 6 cutover
- stryker.config.json
- ci.yml
- jobs
- openwiki.yml
- scripts
- DuplicateReviewDialog.tsx
- streamPapers
- release.yml
- localCatalog.ts
- build
- with
- fieldUsage.ts
- PdfMark
- Project file loading
- graph.ts
- steps
- Build, CI, and Release
- Things to know
- with
- Annotation value trees
- fetchPolicy.ts
- demoAdapter.ts
- store.reindex.test.ts
- wiki-assets/Home.md
- env
- PdfViewer
- Component Tree
- The managed runtime lifecycle
- OpenFastTrace migration scripts
- SaiLoR: Software Requirements
- SaiLoR — Quickstart
- check-wiki-links.js
- useCloseGuard
- updates
- jobs
- checksums
- release
- Online Demo and Project Site
- Testing Strategy
- README.md
- setup.sh script
- PDF Viewer and Marks
- build_menu
- vite.config.ts
- Paper list
- 9. Multiple reviewers & Consolidation
- fileStamps.ts
- Annotation schema
- Annotation schema
- Validation
- openwiki/index.md
- DemoBanner
- bundle.sh
- store.readingPosition.test.ts
- AGENTS.md
- gui-entrypoint.sh
- Multi-reviewer data
- Multi-reviewer data
- Requirements ↔ Code Traceability Matrix
- steps
- The PdfViewer component
- site.js
- reader
- CLAUDE.md
- Platform & desktop shell ([platform.md](platform.md))
- self-hosted-runner
- ci.sh
- tsconfig.json
- .hadolint.yaml
- PdfViewer.tsx
- Validation
- ciScripts.test.ts
- StubResizeObserver
- audit.sh
- e2e.sh
- lint.sh
- linux-deps.sh
- pages.sh
- rust.sh
- sbom.sh
- trace.sh
- @vitejs/plugin-react
- Technical report

## God Nodes (most connected - your core abstractions)
1. `t()` - 289 edges
2. `vitest` - 278 edges
3. `useStore` - 244 edges
4. `useT()` - 204 edges
5. `loadProject()` - 140 edges
6. `Session` - 115 edges
7. `SlrBridge` - 111 edges
8. `Requirements: LLM-Assisted Annotation` - 105 edges
9. `Requirements: LLM-Assisted Annotation` - 105 edges
10. `useEditorStore` - 93 edges

## Surprising Connections (you probably didn't know these)
- `REQ-ANN-180: Confirm each metadata correction` --references--> `MetadataDialog()`  [INFERRED]
  docs/requirements-oft/annotation-ui.md → src/components/MetadataDialog.tsx
- `REQ-ANN-200: Confirm each new PDF file` --references--> `PdfFolderDialog()`  [INFERRED]
  docs/requirements-oft/annotation-ui.md → src/components/PdfFolderDialog.tsx
- `REQ-LST-90: Mark a missing PDF file in the paper list` --references--> `missingPaperIds()`  [INFERRED]
  docs/requirements-oft/annotation-ui.md → src/model/pdfFolder.ts
- `REQ-PDF-190: Single-page view` --references--> `PdfViewer()`  [INFERRED]
  docs/requirements-oft/annotation-ui.md → src/components/PdfViewer.tsx
- `REQ-UI-20: Toolbar project controls` --references--> `Toolbar()`  [INFERRED]
  docs/requirements-oft/annotation-ui.md → src/components/Toolbar.tsx

## Import Cycles
- 2-file cycle: `src/model/diagram.ts -> src/model/diagramSvg.ts -> src/model/diagram.ts`
- 2-file cycle: `src/model/metadata.ts -> src/model/project.ts -> src/model/metadata.ts`

## Communities (275 total, 45 thin omitted)

### Community 0 - "git.rs"
Cohesion: 0.04
Nodes (170): add_and_commit(), ALLOWED_SCHEMES, annotation_authors(), annotation_authors_parser(), annotations_rel_dir(), apply_repo_setup(), as_run(), assert_inside_root() (+162 more)

### Community 1 - "Rust Docs/Builders"
Cohesion: 0.08
Nodes (61): Session, add_annot(), annotation(), collect_pdfs(), colors_dates_and_text_match_pdf_lib(), embed(), embed_marks(), embed_never_changes_an_approved_pdf_outside_the_project() (+53 more)

### Community 2 - "Test Fixtures & Libs"
Cohesion: 0.02
Nodes (66): @testing-library/jest-dom, @testing-library/react, @testing-library/user-event, vitest, mockPlatform, PROJECT, USAGE, writes (+58 more)

### Community 3 - "parse.ts"
Cohesion: 0.06
Nodes (56): Why a misbehaving model cannot corrupt a project, AI-Assisted Annotation, End-to-end flow, Extension points, Paths and field selection, Provider-native web search, Response parsing, The apply step, marks, and disclosure (+48 more)

### Community 4 - "Agent Deps & LLM Plan"
Cohesion: 0.02
Nodes (60): mockPlatform, saveLlmConfig, LlmConfig, LlmHttpRequest, LlmHttpResponse, DEFAULT_MAX_PAGES, PdfText, mockPlatform (+52 more)

### Community 5 - "Run Feedback"
Cohesion: 0.05
Nodes (83): REQ-LLM-100: Ask only about unanswered fields, REQ-LLM-390: Annotate all papers only after a consequences warning, REQ-LLM-420: Report token usage after a run, REQ-LLM-600: Collect schema remarks and per-field outcomes as feedback, REQ-LLM-610: Re-check already-filled fields, REQ-LLM-660: Opt-in re-check of filled fields, REQ-LLM-680: Schema feedback saved to the feedback folder, REQ-LLM-100: Ask only about unanswered fields (+75 more)

### Community 6 - "Chat Requests & Models"
Cohesion: 0.05
Nodes (70): REQ-LLM-720: Ollama native chat with explicit context, REQ-LLM-720: Ollama native chat with explicit context, AI-assisted annotation (`src/llm`), Availability is gated twice, and defaults to off, Model listing and reasoning effort, The modules, Why the call goes through the Rust shell, The provider abstraction (+62 more)

### Community 7 - "Git Repo Setup"
Cohesion: 0.02
Nodes (20): LLM targets and API-key handling (`llm.rs`), Migration context, Network plumbing (`net.rs`) and the web-fetch SSRF guard (`webfetch.rs`), Other shell behavior (`shell.rs`), Self-update (`update.rs`), Tauri Shell, IPC and Self-Update, Tests, The command registry (`main.rs`) (+12 more)

### Community 8 - "useT"
Cohesion: 0.09
Nodes (54): App Initialization (`src/App.tsx`), Hooks, react, App(), AgreementDialog(), PerFieldTable(), AiEvaluationDialog(), BranchSwitchPrompt() (+46 more)

### Community 9 - "graphCanvas.ts"
Cohesion: 0.08
Nodes (42): addEdge(), ARROW_ZOOM, buildScene(), DASH, DASH_ZOOM, EDGE_DASH, EDGE_INDEX, EDGE_TYPES (+34 more)

### Community 10 - "Rust Project Model"
Cohesion: 0.08
Nodes (66): Head, within(), batches_follow_links_only_inside_the_annotations_folder(), batches_use_the_papers_and_folder_listed_when_opened(), DEFAULT_ANNOTATIONS_DIR, deletable(), FEEDBACK_DIR, file() (+58 more)

### Community 11 - "Consolidation & agreement ([consolidation.md](consolidation.md))"
Cohesion: 0.14
Nodes (36): REQ-LST-50: Keyboard navigation, REQ-UI-10: Global keyboard shortcuts, REQ-CON-460: Show only assigned papers, REQ-CON-500: Gate consolidation until all persons finish, REQ-CON-510: Override the consolidation gate, REQ-CON-540: Lock finished work at the next save, REQ-CON-560: Refuse edits of locked work in the store, REQ-LST-50: Keyboard navigation (+28 more)

### Community 12 - "Rust IO & Paths"
Cohesion: 0.07
Nodes (55): annotations_dir_users(), base_name(), collide_needs_same_kind_and_a_shared_paper(), colliding(), files_collide(), folder_ok(), is_screening(), known() (+47 more)

### Community 13 - "Ollama & Base URLs"
Cohesion: 0.09
Nodes (59): base_url_refuses_link_local(), base_urls(), capabilities_of(), check_base_url(), client(), context_of(), delete(), discover() (+51 more)

### Community 14 - "Rust LLM HTTP"
Cohesion: 0.07
Nodes (51): API_KEY_SENTINEL, build_call_headers(), call(), call_can_be_aborted(), call_can_be_aborted_while_the_local_model_starts(), call_headers(), call_pins_the_origin_and_splices_the_key(), CallRequest (+43 more)

### Community 15 - "Merge Logic"
Cohesion: 0.07
Nodes (75): REQ-GIT-580: Merge and commit metadata corrections, REQ-GIT-590: Keep finished work locked in a merge, REQ-GIT-600: Merge papers by PDF hash, REQ-GIT-580: Merge and commit metadata corrections, REQ-GIT-590: Keep finished work locked in a merge, REQ-GIT-600: Merge papers by PDF hash, The merge (`src/git/merge.ts`), The field-level three-way merge (`src/git/merge.ts`) (+67 more)

### Community 16 - "LlmSettingsDialog.tsx"
Cohesion: 0.07
Nodes (54): REQ-LLM-732: Explicit context window per model, REQ-LLM-732: Explicit context window per model, The UI, Guided setup panels, ContextFields(), hostedPreset(), HostedSystemOnePanel(), JEV_URL (+46 more)

### Community 17 - "model/project.ts"
Cohesion: 0.03
Nodes (107): REQ-EDT-110: Store strict mode settings, REQ-LLM-240: Record durable AI-usage disclosure, REQ-EDT-110: Store strict mode settings, REQ-LLM-240: Record durable AI-usage disclosure, AI is not offered for screening, on the same precedent as Consolidation, AI marks, AI usage disclosure (`Paper.aiUsage`), Screening (+99 more)

### Community 18 - "Chat Response Parsing"
Cohesion: 0.05
Nodes (82): RFC-9110, REQ-LLM-440: Retry with backoff on rate limits/overload, REQ-LLM-500: Parallel all-papers runs, REQ-LLM-530: Keyless local targets, REQ-LLM-640: Conservative default ticks for screening proposals, REQ-LLM-740: Trim the paper to each model's input window, REQ-LLM-741: Never apply results from truncated input, REQ-LLM-440: Retry with backoff on rate limits/overload (+74 more)

### Community 19 - "annotations.ts"
Cohesion: 0.06
Nodes (45): Reference import, REQ-DAT-370: Convert LaTeX escapes, REQ-DAT-380: Extract PDF hints from references, REQ-DAT-400: Unique option for repeatable schema nodes, REQ-DAT-410: Refuse duplicate entries on edit and AI suggestion, REQ-DAT-420: Report duplicates in validation and consolidation, Reference import, REQ-DAT-370: Convert LaTeX escapes (+37 more)

### Community 20 - "Diagram View"
Cohesion: 0.05
Nodes (75): REQ-UI-270: Result view menu and tabs, REQ-UI-280: Diagram view and settings, REQ-UI-290: Diagram data aggregation, REQ-UI-300: Diagram rendering, REQ-UI-310: Diagram creation in a background worker, REQ-UI-330: Diagram filter, bar direction and shares, REQ-UI-340: Diagram data table and CSV, REQ-UI-270: Result view menu and tabs (+67 more)

### Community 21 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, d3-force@3.0.0, d3-quadtree@3.0.1, immer@^10.1.1, react@^19.1.0, react-dom@^19.1.0, react-pdf@^9.2.1, zod@^4.6.7 (+5 more)

### Community 22 - "Cypher Worker"
Cohesion: 0.07
Nodes (51): REQ-UI-240: Knowledge graph Cypher limits and safety, REQ-UI-240: Knowledge graph Cypher limits and safety, Params, GraphEdgeType, byType(), byTypeCache, Chain, CMP (+43 more)

### Community 23 - "consolidationAndMerge.integration.test.tsx"
Cohesion: 0.04
Nodes (52): 15. Phase 3 progress, app, The module layout, Output parsing (`src/git/output.ts`), AiButtonState, GitButtonState, AVAILABLE, REPO (+44 more)

### Community 24 - "PaperList.tsx"
Cohesion: 0.14
Nodes (21): REQ-LST-40: Annotation progress filter, REQ-LST-40: Annotation progress filter, FILTER_KEY, FULL, PARTIAL, project(), SCHEMA, state() (+13 more)

### Community 25 - "Token Budget"
Cohesion: 0.06
Nodes (63): REQ-LLM-380: Switch between prompt and agent mode, REQ-LLM-520: System One decision models for choice and yes/no fields, REQ-LLM-550: Classify mode, REQ-LLM-560: System One cross-check, REQ-LLM-711: System One question packing and label budgets, REQ-LLM-712: Page-aware paper fitting for small contexts, REQ-LLM-713: Hosted Clef via Cloudflare Workers AI, REQ-LLM-742: Report what the model could not handle (fields, state mode) (+55 more)

### Community 26 - "splitProjectFiles"
Cohesion: 0.06
Nodes (55): REQ-DAT-172: Highlight file names by project kind, REQ-DAT-172: Highlight file names by project kind, REQ-PLT-136: Resolve a save that met changed files, REQ-PLT-459: Load project files off the main thread, REQ-PLT-61: Never delete unparseable annotation files, REQ-PLT-136: Resolve a save that met changed files, REQ-PLT-459: Load project files off the main thread, REQ-PLT-61: Never delete unparseable annotation files (+47 more)

### Community 27 - "metadata.ts"
Cohesion: 0.10
Nodes (48): REQ-LST-80: Mark corrected metadata in the paper list, REQ-CON-530: Consolidate metadata corrections, Metadata correction, REQ-DAT-430: Metadata correction mode, REQ-DAT-440: Stable paper identifier on metadata correction, REQ-DAT-450: Write agreed corrections into the project file, REQ-DAT-460: Write corrections into the annotation file, REQ-LST-80: Mark corrected metadata in the paper list (+40 more)

### Community 28 - "sh"
Cohesion: 0.24
Nodes (28): assert_openable(), bare_pair(), branch_switch_begin_abort_finish(), clone_pair(), commit_all(), commit_partial_restores_working_and_write_working(), configure(), contents() (+20 more)

### Community 29 - "Screening Panel"
Cohesion: 0.06
Nodes (53): Auto-advance: one rule, forward-only, Importing from a screening project, Counts and PRISMA totals, Decision writes and auto-advance, Focused tests, Reason usage tracking, Screening Mode, ScreeningImportDialog (pre-commit summary) (+45 more)

### Community 30 - "agent.ts"
Cohesion: 0.03
Nodes (99): REQ-LLM-350: Bounded judge review loop, REQ-LLM-360: Treat fetched web content as untrusted data, REQ-LLM-620: Provider-native web search (optional, agent mode), REQ-LLM-833: Limit the URLs the agent fetches, REQ-LLM-350: Bounded judge review loop, REQ-LLM-360: Treat fetched web content as untrusted data, REQ-LLM-620: Provider-native web search (optional, agent mode), REQ-LLM-833: Limit the URLs the agent fetches (+91 more)

### Community 31 - "desktop.ts"
Cohesion: 0.04
Nodes (32): mockPlatform, PdfSource, SharedAnnotations, OpenedHead, MAX_RECENTS, pushRecent(), readRecents(), RecentEntry (+24 more)

### Community 32 - "Git Branch/Pull Ops"
Cohesion: 0.05
Nodes (36): beginBranchSwitchResult, beginMergeCalls, beginMergeResult, beginPullResult, branchesResult, branchSwitchAbortCalls, branchSwitchAbortResult, branchSwitchFinishCalls (+28 more)

### Community 33 - "Diagram Export"
Cohesion: 0.09
Nodes (42): REQ-UI-320: Diagram export, REQ-UI-370: Vector PDF export of diagrams, REQ-UI-320: Diagram export, REQ-UI-370: Vector PDF export of diagrams, Characters outside WinAnsi, Export, deflate(), findPdfFont() (+34 more)

### Community 34 - "Tauri Menu"
Cohesion: 0.08
Nodes (30): app_urls_stay_in_the_window(), copy_never_overwrites_and_skips_missing(), copy_new(), data_dir_moves_once_and_never_overwrites(), DE, ES, FA, FR (+22 more)

### Community 35 - "IP/Host Validation"
Cohesion: 0.07
Nodes (35): response(), ACCEPT, blocked_addresses(), blocked_hostnames(), body_is_capped(), charset(), check_public_host(), client() (+27 more)

### Community 36 - "Dialog Close (Rust)"
Cohesion: 0.08
Nodes (33): app_reload(), app_save_complete(), ask_user(), CANCEL, Choice, choice(), Cancel, Discard (+25 more)

### Community 38 - "gitStore.ts"
Cohesion: 0.09
Nodes (46): Commit history, Field-level commit review, UI components, GitCloneDialog(), CommitMessageField(), DispositionButtons(), DispositionButtonsProps, FieldChangeRow() (+38 more)

### Community 39 - "tauri.ts"
Cohesion: 0.12
Nodes (18): REQ-PLT-230: Renderer sandboxing, REQ-PLT-230: Renderer sandboxing, @tauri-apps/api@^2.12.4, @tauri-apps/api, RawProject, call(), command(), Fn (+10 more)

### Community 40 - "settings.ts"
Cohesion: 0.13
Nodes (26): REQ-PLT-450: Open the demo in English, REQ-PLT-450: Open the demo in English, Key Actions, Settings & Theming (`src/state/settings.ts`), applyFontScale(), applyTheme(), clampFont(), FONT_MAX (+18 more)

### Community 41 - "i18n.ts"
Cohesion: 0.07
Nodes (29): REQ-UI-110: Language setting, REQ-UI-140: Right-to-left layout, REQ-UI-110: Language setting, REQ-UI-140: Right-to-left layout, AiSection(), GeneralSection(), LanguageSection(), SETTINGS_SECTIONS (+21 more)

### Community 42 - "graphSuggest.ts"
Cohesion: 0.13
Nodes (19): REQ-UI-400: Knowledge graph query box, REQ-UI-400: Knowledge graph query box, GraphQueryBox(), Props, GraphQueryHelp(), CypherWorker, CypherRequest, isCypher() (+11 more)

### Community 43 - "model/schema.ts"
Cohesion: 0.04
Nodes (125): AnnotationNode (recursive renderer), Reused verbatim, and the one thing that had to be scoped, Semantic equality (`Paper.equal`), How a reference resolves, Annotation value tree, Disagreement export, Extension points and invariants, Resolution UI flow (+117 more)

### Community 44 - "Data model & project editor ([data-model.md](data-model.md))"
Cohesion: 0.07
Nodes (54): Knowledge graph export, REQ-DAT-500: Graph export formats, REQ-DAT-510: Escape values in the graph export, REQ-DAT-520: Graph export dialog, REQ-LLM-470: AI reviewer seat, Knowledge graph export, REQ-DAT-500: Graph export formats, REQ-DAT-510: Escape values in the graph export (+46 more)

### Community 45 - "editorStore.ts"
Cohesion: 0.04
Nodes (96): REQ-EDT-100: Unique toggle and compare-by picker, REQ-EDT-41: Move answers with a renamed or moved field, REQ-EDT-100: Unique toggle and compare-by picker, REQ-EDT-41: Move answers with a renamed or moved field, Duplicate detection at import (`src/model/duplicates.ts`), Project editor, Pending moves: what happens to answers under an edited schema, The schema editor and its draft lifecycle (+88 more)

### Community 46 - "Project editor"
Cohesion: 0.03
Nodes (79): Project editor, REQ-DAT-290: Deterministic serialization, REQ-DAT-300: No writes on open, REQ-EDT-10: Validate drafts before save, REQ-EDT-120: Validate strict mode settings on load, REQ-EDT-130: Manage persons in the project editor, REQ-EDT-140: Assign papers to persons, REQ-EDT-150: Assign persons in bulk (+71 more)

### Community 47 - "VisibleIfDialog.tsx"
Cohesion: 0.12
Nodes (42): Editing a gate: the VisibleIfDialog, DropTarget, addEntryAt(), buildTargets(), canMoveEntry(), ConditionGroup(), ConditionRow(), describeCondition() (+34 more)

### Community 48 - "Task Routing"
Cohesion: 0.15
Nodes (20): Architecture, Architecture Diagram, C4: Container, C4: System Context, createUnsupportedAdapter (`src/platform/unsupported.ts`), Overview, Platform Adapter Pattern, State Management (+12 more)

### Community 49 - "Requirements: LLM-Assisted Annotation"
Cohesion: 0.03
Nodes (91): REQ-LLM-10: Support multiple LLM providers, REQ-LLM-110: Deliver the paper as text or PDF, REQ-LLM-120: Refuse text delivery of image-only PDFs, REQ-LLM-130: Anti-hallucination prompt rules, REQ-LLM-140: Flatten schema text in prompts, REQ-LLM-150: Bind replies to their run, REQ-LLM-160: Discard superseded runs, REQ-LLM-170: Validate every suggestion against the schema (+83 more)

### Community 50 - "localruntime.rs"
Cohesion: 0.04
Nodes (108): Allow, allowed_download_url(), assets(), build_server_args(), CANCELLED, CATALOG, catalog_matches_the_renderer(), CLEF (+100 more)

### Community 51 - "graphQuery.ts"
Cohesion: 0.14
Nodes (16): Graph, GraphNode, GraphNodeType, NodePat, Fact, fieldMatches(), GraphIndex, GraphQuery (+8 more)

### Community 52 - "GitPlatform"
Cohesion: 0.06
Nodes (6): Testing, Layer 2 — Integration suite, The Rust shell in `src-tauri/src/git.rs`, Building & testing, Mutation tests, GitPlatform

### Community 54 - "oftlib.py"
Cohesion: 0.07
Nodes (31): convert(), fix_links(), needs(), render(), tags(), apply(), main(), plan() (+23 more)

### Community 55 - "ConsolidationOverview.tsx"
Cohesion: 0.14
Nodes (18): REQ-UI-170: Hide AI entries when AI is off, REQ-UI-90: Settings dialog, REQ-UI-170: Hide AI entries when AI is off, REQ-UI-90: Settings dialog, Agreement and the disagreement overview, copyText(), ConsolidationOverview(), DisagreementPaper (+10 more)

### Community 56 - "stashOps.ts"
Cohesion: 0.16
Nodes (24): Git integration ([git-integration.md](git-integration.md)), MANUAL_STASH_PREFIX, parseStashList(), STASH_LIST_FORMAT, branchFromStash(), carryOverStashRef(), dropCarryOverStash(), dropStash() (+16 more)

### Community 57 - "applySplit"
Cohesion: 0.13
Nodes (15): 19.1 Behavior, 19.2 Differences from Electron, 19.3 Verification and gaps, 19. Remaining project channels, applySplit(), fit(), Known, known() (+7 more)

### Community 58 - "ollama.ts"
Cohesion: 0.08
Nodes (59): REQ-LLM-721: Detect silent input truncation, REQ-LLM-722: Local server discovery and model listing, REQ-LLM-723: Curated local model shortlist with consent sizes, REQ-LLM-721: Detect silent input truncation, REQ-LLM-722: Local server discovery and model listing, REQ-LLM-723: Curated local model shortlist with consent sizes, Model discovery, Base-URL and tag validation (+51 more)

### Community 59 - "pdfFolder.ts"
Cohesion: 0.10
Nodes (37): PDF folder watch, REQ-DAT-530: PDF folder setting, REQ-DAT-540: Find new PDF files by file hash, REQ-DAT-550: Propose metadata for a new PDF file, REQ-DAT-560: Crossref lookup setting, REQ-DAT-570: Keep papers and identifiers on a scan, PDF folder watch, REQ-DAT-530: PDF folder setting (+29 more)

### Community 60 - "Git"
Cohesion: 0.14
Nodes (15): REQ-GIT-170: Stage only the project's own files, REQ-GIT-170: Stage only the project's own files, Git, Merging another branch, Not weakening git, only removing what cannot work here, Rejected: streamed clone progress and a cancel button, Renderer-named paths are allowlisted to what a dialog actually produced, State management: `gitStore` (+7 more)

### Community 61 - "duplicates.ts"
Cohesion: 0.07
Nodes (52): REQ-CON-180: Type-aware value comparison, Duplicate detection, REQ-DAT-310: Classify imports in three verdicts, REQ-DAT-320: Duplicate matching rules, REQ-DAT-330: Demote conflicting matches, REQ-DAT-340: Human decision on probable duplicates, REQ-DAT-350: Merge fills empty fields only, REQ-CON-180: Type-aware value comparison (+44 more)

### Community 62 - "net.rs"
Cohesion: 0.09
Nodes (15): llm_abort(), client(), abort(), abort_and_timeout(), builder(), Flight, IN_FLIGHT, NO_REDIRECT (+7 more)

### Community 63 - "GraphView.tsx"
Cohesion: 0.07
Nodes (62): REQ-UI-200: Knowledge graph query, REQ-UI-210: Knowledge graph sub-graph and performance, REQ-UI-220: Knowledge graph relations, REQ-UI-250: Knowledge graph Cypher query in a background worker, REQ-UI-260: Knowledge graph image download, REQ-UI-350: Knowledge graph shortcuts, REQ-UI-360: Knowledge graph statistics, REQ-UI-200: Knowledge graph query (+54 more)

### Community 64 - "references.ts"
Cohesion: 0.13
Nodes (34): REQ-DAT-360: Parse BibTeX, RIS, and CSL-JSON, REQ-DAT-360: Parse BibTeX, RIS, and CSL-JSON, Reference-file parsing (`src/model/references.ts`), appendRis(), cleanBibPathSegment(), cleanBibValue(), collapseSpace(), detectFormat() (+26 more)

### Community 65 - "NodeName.tsx"
Cohesion: 0.42
Nodes (6): Annotation names and descriptions, DescriptionPopover(), findSingleLink(), NodeName(), LinkifySegment, linkifyText()

### Community 66 - "agreement.property.test.ts"
Cohesion: 0.11
Nodes (39): REQ-CON-290: Compute Krippendorff's alpha, REQ-CON-300: Report degenerate metric cases, REQ-CON-290: Compute Krippendorff's alpha, REQ-CON-300: Report degenerate metric cases, Inter-rater agreement statistics, METRICS, MetricSpec, perFieldTsv() (+31 more)

### Community 67 - "annotationState"
Cohesion: 0.12
Nodes (17): Completeness & finished state, REQ-DAT-220: Completeness over the validated field set, REQ-DAT-230: Non-misleading percentage display, REQ-DAT-240: Finished is a human declaration, REQ-DAT-250: Derive finished when the checkbox is disabled, Completeness & finished state, REQ-DAT-220: Completeness over the validated field set, REQ-DAT-230: Non-misleading percentage display (+9 more)

### Community 68 - "Requirements: LLM-Assisted Annotation"
Cohesion: 0.03
Nodes (62): REQ-LLM-300: Report run progress, REQ-LLM-10: Support multiple LLM providers, REQ-LLM-110: Deliver the paper as text or PDF, REQ-LLM-120: Refuse text delivery of image-only PDFs, REQ-LLM-130: Anti-hallucination prompt rules, REQ-LLM-140: Flatten schema text in prompts, REQ-LLM-150: Bind replies to their run, REQ-LLM-160: Discard superseded runs (+54 more)

### Community 69 - "align.ts"
Cohesion: 0.10
Nodes (44): REQ-CON-410: Align repeated entries independent of entry order, REQ-CON-410: Align repeated entries independent of entry order, Matching the reviewers' repeated entries (`src/consolidate/`), Freezing and widening, Similarity, Stored alignment and persistence, The alignment pipeline, The core problem: entry matching (+36 more)

### Community 70 - "Requirements: Git Integration"
Cohesion: 0.03
Nodes (60): REQ-GIT-100: Clone a project repository, REQ-GIT-10: Use the user's installed git, REQ-GIT-110: Detect repository context on open, REQ-GIT-120: Show working-tree status and diff, REQ-GIT-130: Field-level review of project changes, REQ-GIT-140: Whole-file fallback for structural changes, REQ-GIT-150: Commit a subset of field changes, REQ-GIT-160: Confirm mixed discard commits (+52 more)

### Community 71 - "builder.ts"
Cohesion: 0.15
Nodes (14): The git-scenario rig, ANNA, BEN, buildScenario(), EPOCH, Person, Scenario, args (+6 more)

### Community 72 - "readiness.ts"
Cohesion: 0.08
Nodes (33): REQ-CON-255: Run the automatic steps only once per state of the reviews, REQ-CON-255: Run the automatic steps only once per state of the reviews, `align.ts` is a structural no-op here, and needs no guard, Batch-adopting across the whole project (`adoptAllUnanimousAnnotations`), Multiple reviewers & Consolidation, Per-field verdict coloring (`ConsolidationVerdicts`), Readiness: what Consolidation can act on (`readiness.ts`), Unanimous answers are adopted (`adoptUnanimousValues`) (+25 more)

### Community 73 - "pdfMarks.ts"
Cohesion: 0.35
Nodes (8): Defensive parsing and merge, marksOf(), isLinkedField(), isMarkRect(), MARK_COLORS, parseLinkedFields(), parseMarks(), parseReviewMarks()

### Community 74 - "Requirements: Git Integration"
Cohesion: 0.03
Nodes (63): REQ-GIT-490: Disclose changes committed without a review row, REQ-GIT-100: Clone a project repository, REQ-GIT-10: Use the user's installed git, REQ-GIT-110: Detect repository context on open, REQ-GIT-120: Show working-tree status and diff, REQ-GIT-130: Field-level review of project changes, REQ-GIT-140: Whole-file fallback for structural changes, REQ-GIT-150: Commit a subset of field changes (+55 more)

### Community 75 - "tauri.conf.json"
Cohesion: 0.08
Nodes (24): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+16 more)

### Community 76 - "architecture.js"
Cohesion: 0.26
Nodes (20): addEdge(), anchor(), build(), chip(), detail(), edgePath(), el(), flowNodes() (+12 more)

### Community 77 - "Requirements: Platform, Desktop Shell & File Handling"
Cohesion: 0.04
Nodes (54): REQ-PLT-10: Desktop-only operation, REQ-PLT-110: Keep project open on failed save, REQ-PLT-11: Single application instance, REQ-PLT-130: Preserve newer changes during save, REQ-PLT-135: Stop saving over externally changed files, REQ-PLT-140: Recent projects list, REQ-PLT-150: Re-check recents on display, REQ-PLT-160: Persist window state (+46 more)

### Community 78 - "merge.test.ts"
Cohesion: 0.10
Nodes (19): REQ-GIT-255: Merge the schema node by node, REQ-GIT-255: Merge the schema node by node, ConflictResolutionState, ConflictRowProps, FieldConflict, MergeNote, MergeOutcome, mergeResultProblem() (+11 more)

### Community 79 - "ProjectEditor.tsx"
Cohesion: 0.08
Nodes (45): REQ-DAT-390: Reserved feedback folder in the annotations folder, REQ-EDT-46: Own annotations folder for a project started from screening, REQ-DAT-390: Reserved feedback folder in the annotations folder, REQ-EDT-46: Own annotations folder for a project started from screening, Sibling projects sharing a folder, `Paper`, The annotations folder (shared-folder rules), DropPosition (+37 more)

### Community 80 - "AiDialog.tsx"
Cohesion: 0.07
Nodes (49): REQ-UI-120: Translated user interface, REQ-LLM-210: Human review before applying, REQ-LLM-410: Show judge verdicts and default flagged rows unticked, REQ-LLM-580: Edit proposals before applying, REQ-LLM-743: Agent mode requires a large context window, REQ-UI-120: Translated user interface, REQ-LLM-210: Human review before applying, REQ-LLM-410: Show judge verdicts and default flagged rows unticked (+41 more)

### Community 81 - "hardware.rs"
Cohesion: 0.24
Nodes (20): backends(), disk_free(), Gpu, gpu(), HardwareInfo, has_word(), local_probe(), named() (+12 more)

### Community 82 - "update.rs"
Cohesion: 0.16
Nodes (9): error(), only_appimage_windows_and_macos_self_update(), Pending, percent(), percent_needs_a_known_total_and_caps_at_100(), self_update_supported(), update_check(), update_download() (+1 more)

### Community 83 - "refPreview.ts"
Cohesion: 0.23
Nodes (12): Internal-link hover previews, destinationPoint(), detectEntryBox(), detectNumericCitation(), EntryBox, findNumericReference(), Line, PreviewTextItem (+4 more)

### Community 84 - "Project editor"
Cohesion: 0.20
Nodes (17): REQ-DAT-470: Propose corrections from the PDF files, REQ-DAT-470: Propose corrections from the PDF files, A missing abstract is extracted from the PDF, and flagged durably, PDF metadata extraction, abstractFromLines(), cleanTitle(), extractPdfMeta(), findDoi() (+9 more)

### Community 85 - "feedback.rs"
Cohesion: 0.17
Nodes (20): backslash_is_a_plain_character_on_posix(), dir_of(), normalize(), paths_absolute(), paths_rebase(), paths_relative(), paths_sibling(), rebase_and_absolute() (+12 more)

### Community 86 - "GraphView.test.tsx"
Cohesion: 0.11
Nodes (6): ctx, FakeWorker, listed(), nodeList(), PointerEventPolyfill, saved

### Community 87 - "refProblem"
Cohesion: 0.22
Nodes (12): 4. The hard part: shared TypeScript, Build Configuration, Deleting a branch, The renderer never names an argv, Security gates: input never chooses argv, hasControlChar(), RefProblem, refProblem() (+4 more)

### Community 88 - "text.ts"
Cohesion: 0.20
Nodes (10): REQ-PLT-453: Show a neutral notice for a demo paper without a PDF, REQ-PLT-453: Show a neutral notice for a demo paper without a PDF, DEMO_MODE, DEMO_SCHEMA_MODE, DEMO_BACK_LABEL, DEMO_BACK_URL, DEMO_RELEASES_URL, DEMO_SCHEMA_NOTICE (+2 more)

### Community 89 - "hasAnnotations"
Cohesion: 0.24
Nodes (13): Completeness dot, Why `Decision` is a two-option enum, not a boolean, Completeness and the paper-list dot, paperCompleteness(), SCHEMA, annotationText(), hasAnnotations(), isEmptyInstance() (+5 more)

### Community 90 - "store.ts"
Cohesion: 0.04
Nodes (63): Picking a seat (`ReviewerPrompt`), State Shape, tauriWindow, SplitRow, PdfMark, ScreeningMark, Person, UnannotatedPaper (+55 more)

### Community 91 - "Annotation Schema and Validation"
Cohesion: 0.24
Nodes (13): Annotation Schema and Validation, Field types, Resolution: structural rules, The authoring type and the resolved type, Visibility gates (`visibleIf`), Where this fits, Zod validation of the raw JSON, assertInstanceBudget() (+5 more)

### Community 92 - "Requirements: Platform, Desktop Shell & File Handling"
Cohesion: 0.04
Nodes (54): REQ-PLT-10: Desktop-only operation, REQ-PLT-110: Keep project open on failed save, REQ-PLT-11: Single application instance, REQ-PLT-130: Preserve newer changes during save, REQ-PLT-135: Stop saving over externally changed files, REQ-PLT-140: Recent projects list, REQ-PLT-150: Re-check recents on display, REQ-PLT-160: Persist window state (+46 more)

### Community 93 - "SeatConflictNotice.tsx"
Cohesion: 0.19
Nodes (15): REQ-CON-550: Show locked work read-only, REQ-CON-550: Show locked work read-only, AiUsageDisclosure(), AnnotationPanel(), SeatConflictNotice(), StrictLockBanner(), CONSOLIDATION_SEAT, GitIdentity (+7 more)

### Community 94 - "schemaVersion.ts"
Cohesion: 0.18
Nodes (24): REQ-DAT-167: Carry answers across renames and moves, REQ-DAT-167: Carry answers across renames and moves, Where the draft's moves become version history, Schema versions: renames and moves, atHistory(), mergedSchemaVersion(), withMoves(), absorbedInto() (+16 more)

### Community 95 - "Requirements: Multi-Reviewer Consolidation & Agreement"
Cohesion: 0.04
Nodes (50): REQ-CON-100: Deterministic multi-reviewer alignment, REQ-CON-10: Isolate reviewer seats, REQ-CON-110: Similarity threshold for merging, REQ-CON-115: Compare single entries of a repeatable field regardless of similarity, REQ-CON-120: Persist only slot membership, REQ-CON-130: Grow-only consolidated tree on alignment, REQ-CON-140: Alignment as single undo step, REQ-CON-150: Freeze answered alignments (+42 more)

### Community 96 - "Stage"
Cohesion: 0.23
Nodes (3): review(), start(), Stage

### Community 97 - "clone"
Cohesion: 0.18
Nodes (15): apply_managed_block(), clone(), is_word(), js_trim(), Managed, managed_block_converges(), plan_repo_setup(), rel_path_problem() (+7 more)

### Community 98 - "aiStore.recheck.test.ts"
Cohesion: 0.19
Nodes (10): ai(), CHECK, FILL, HANDLE, mockLlm(), mockPlatform, PROJECT, reply() (+2 more)

### Community 99 - "Requirements: Multi-Reviewer Consolidation & Agreement"
Cohesion: 0.04
Nodes (50): REQ-CON-100: Deterministic multi-reviewer alignment, REQ-CON-10: Isolate reviewer seats, REQ-CON-110: Similarity threshold for merging, REQ-CON-115: Compare single entries of a repeatable field regardless of similarity, REQ-CON-120: Persist only slot membership, REQ-CON-130: Grow-only consolidated tree on alignment, REQ-CON-140: Alignment as single undo step, REQ-CON-150: Freeze answered alignments (+42 more)

### Community 100 - "LLM-assisted annotation ([llm-annotation.md](llm-annotation.md))"
Cohesion: 0.10
Nodes (43): REQ-LLM-450: Few-shot examples from finished papers, REQ-LLM-460: Jump from evidence to the PDF, REQ-LLM-510: Resume an interrupted all-papers run, REQ-LLM-540: Role-based model assignment remembered per project, REQ-LLM-590: Skip one paper during an all-papers run, REQ-LLM-450: Few-shot examples from finished papers, REQ-LLM-460: Jump from evidence to the PDF, REQ-LLM-510: Resume an interrupted all-papers run (+35 more)

### Community 101 - "ConflictResolutionDialog.tsx"
Cohesion: 0.10
Nodes (32): REQ-ANN-20: Type-specific field controls, REQ-ANN-20: Type-specific field controls, Field component, react-dom, AnnotationNode(), COMBO_MENU_MAX_HEIGHT, ComboBox(), ComboBoxProps (+24 more)

### Community 102 - "version.ts"
Cohesion: 0.26
Nodes (12): Update check, CHECK_INTERVAL_MS, comparePre(), fetchLatestRelease(), isHttps(), isNewerVersion(), NEW_ISSUE_URL, parts() (+4 more)

### Community 103 - "store.ai.test.ts"
Cohesion: 0.24
Nodes (12): ann(), apply(), claimOf(), evidence(), findings(), loadAiSeatProject(), mockPlatform, paperById() (+4 more)

### Community 104 - "store.saveRace.test.ts"
Cohesion: 0.14
Nodes (8): batchGates, BIG, config, mockPlatform, OTHER, saveGates, saves, SMALL

### Community 105 - "pdfReadingPosition.integration.test.tsx"
Cohesion: 0.14
Nodes (7): handle, mockPlatform, project, renderedPages, schema, StubResizeObserver, textLayerCallbacks

### Community 106 - "PaperList"
Cohesion: 0.33
Nodes (12): The paper-list dot in Consolidation: progress and sign-off, readiness in the tooltip, `completenessApplies` gate, Paper list: tri-state marker and status filter, paperIsMarkedDone(), PaperList(), PaperRow, paperScreeningStatus(), readyToConsolidate() (+4 more)

### Community 107 - "Screening"
Cohesion: 0.22
Nodes (9): AI proposals, Excluding, with a reason, Renaming a reason, Screening, Several reviewers, Starting the next phase from a screening project, The fast keyboard flow, The summary (+1 more)

### Community 108 - "aiScreeningStore.test.ts"
Cohesion: 0.22
Nodes (11): ai(), calls, CHAT, configs, mockPlatform, openAll(), openOne(), project() (+3 more)

### Community 109 - "Requirements: Screening"
Cohesion: 0.05
Nodes (40): REQ-SCR-100: Exclude-with-reason as single undo step, REQ-SCR-10: Identify screening projects by configuration, REQ-SCR-110: Auto-advance after deciding, REQ-SCR-120: Toggle decision back to undecided, REQ-SCR-130: Restrict reason entry to excluded papers, REQ-SCR-140: Screening keyboard shortcuts, REQ-SCR-150: Reject AI suggestions in screening projects, REQ-SCR-160: Adopt unanimous screening values (+32 more)

### Community 110 - "Action"
Cohesion: 0.17
Nodes (13): Action, action(), About, CloseWindow, Emit, Fullscreen, Github, Minimize (+5 more)

### Community 111 - "PdfViewer.linkPreview.test.tsx"
Cohesion: 0.17
Nodes (5): fakePage1Annotations, fakePdfDoc, GENERIC_RECT, mockPlatform, MockResizeObserver

### Community 112 - "3. Defining the annotation schema"
Cohesion: 0.18
Nodes (11): 3.1 Simple fields (string, number, boolean, year), 3.2 Enum fields: constraining a string to a set of options, 3.3 Groups and nested taxonomies, 3.4 Cardinality: `min` and `max`, 3.5 Repeatable groups (multiple parallel sub‑trees), 3.6 Conditional visibility: `visibleIf`, 3. Defining the annotation schema, Combining conditions: AND / OR (+3 more)

### Community 113 - "Requirements: Screening"
Cohesion: 0.05
Nodes (40): REQ-SCR-100: Exclude-with-reason as single undo step, REQ-SCR-10: Identify screening projects by configuration, REQ-SCR-110: Auto-advance after deciding, REQ-SCR-120: Toggle decision back to undecided, REQ-SCR-130: Restrict reason entry to excluded papers, REQ-SCR-140: Screening keyboard shortcuts, REQ-SCR-150: Reject AI suggestions in screening projects, REQ-SCR-160: Adopt unanimous screening values (+32 more)

### Community 114 - "manager"
Cohesion: 0.20
Nodes (6): app_set_dirty(), main(), os_info(), probe_auto(), focus_main(), State

### Community 115 - "Workspace shell"
Cohesion: 0.10
Nodes (20): REQ-PDF-185: Show the screeners' highlights, REQ-PDF-190: Single-page view, REQ-UI-100: Open the Settings dialog, REQ-UI-130: Complete language files, REQ-UI-150: Open the Settings dialog from the help, REQ-UI-160: Show project entries only with a project, REQ-UI-180: Keep focus inside open dialogs, REQ-UI-190: Knowledge graph view (+12 more)

### Community 116 - "Authoring a SaiLoR project file"
Cohesion: 0.10
Nodes (20): 10. Screening projects, 1. Overview, 2. File structure at a glance, 4. Defining the papers, 5. What the file looks like after annotating, 6. A complete example, 7. Opening a project, 8. Validation & common mistakes (+12 more)

### Community 117 - "progressiveLoad.test.ts"
Cohesion: 0.20
Nodes (8): config, gate, head, mockPlatform, only(), papers, readPapers, release()

### Community 118 - "store.batch-unanimous.test.ts"
Cohesion: 0.24
Nodes (9): claimsOf(), findingCE(), findingCM(), mockPlatform, st(), swappedProject(), swappedSchema, trapProject() (+1 more)

### Community 119 - "repoSetup.ts"
Cohesion: 0.24
Nodes (10): REQ-GIT-411: Consent and commit for repository rules, REQ-GIT-411: Consent and commit for repository rules, applyManagedBlock(), ATTRIBUTES_BODY, IGNORE_BODY, ManagedFileUpdate, planRepoSetup(), RepoSetupPlan (+2 more)

### Community 120 - "LlmSettingsDialog.local.test.tsx"
Cohesion: 0.22
Nodes (8): BASE, HW, localRuntime(), MODEL_PLAN, ollamaPlatform(), platform, RT_PLAN, saveLlmConfig

### Community 121 - "PdfViewer.marks.test.tsx"
Cohesion: 0.20
Nodes (3): mockPlatform, MockResizeObserver, rect

### Community 122 - "deploy"
Cohesion: 0.06
Nodes (34): runs-on, steps, timeout-minutes, concurrency, cancel-in-progress, group, environment, needs (+26 more)

### Community 123 - "check-site-links.js"
Cohesion: 0.22
Nodes (8): attributeValues(), demoDir, errors, htmlFiles(), idCache, idsOf(), pages, root

### Community 124 - "steps"
Cohesion: 0.07
Nodes (28): concurrency, cancel-in-progress, group, BASE, jobs, links, runs-on, steps (+20 more)

### Community 125 - "store.aimarks.test.ts"
Cohesion: 0.27
Nodes (8): apply(), isMarked(), marks(), mockPlatform, PROJECT, saved, st(), TEST_USAGE

### Community 126 - "store.align.test.ts"
Cohesion: 0.22
Nodes (6): claimsOf(), mockPlatform, schema, st(), swapped, TEST_USAGE

### Community 127 - "HelpDialog.tsx"
Cohesion: 0.33
Nodes (15): annotateHelp(), annotateKeys(), commonFaqs(), editorHelp(), editorKeys(), Faq(), HelpSection, mod() (+7 more)

### Community 128 - "ValidationDialog.tsx"
Cohesion: 0.36
Nodes (9): BackIcon(), ForwardIcon(), IssueList(), JumpButton(), KIND_KEY, matchesQuery(), PaperFilter(), TargetIcon() (+1 more)

### Community 129 - "PDF viewer"
Cohesion: 0.11
Nodes (19): PDF viewer, REQ-PDF-100: Edit marks via popover, REQ-PDF-10: Render the paper's PDF, REQ-PDF-110: Per-seat mark scoping, REQ-PDF-120: Mark edits are undoable, REQ-PDF-140: Selection through marks, REQ-PDF-150: Reference hover previews, REQ-PDF-160: Export marks into a PDF (+11 more)

### Community 131 - "with"
Cohesion: 0.07
Nodes (27): runs-on, steps, timeout-minutes, concurrency, cancel-in-progress, group, jobs, compile (+19 more)

### Community 132 - "Working with several reviewers"
Cohesion: 0.25
Nodes (8): AI evaluation, Consolidation, ⚠ Disagreements and ⚖ Agreement, Metadata corrections in Consolidation, Picking a seat, Reviewer-seat identity, Strict mode, Working with several reviewers

### Community 135 - "store.resyncDirty.test.ts"
Cohesion: 0.29
Nodes (6): config, handle, mockPlatform, onDisk, relevant(), st()

### Community 136 - "Scenarios"
Cohesion: 0.08
Nodes (23): `conflict-markers`, `conflicting-renames`, `detached-head`, `disjoint-reviewers`, Git scenarios, `rename-vs-edit`, `repo-setup-existing`, `repo-setup-fresh` (+15 more)

### Community 137 - "PdfViewer.demo.test.tsx"
Cohesion: 0.33
Nodes (3): load(), mockPlatform, st()

### Community 138 - "completeness.test.ts"
Cohesion: 0.20
Nodes (9): completenessPercent(), BOOLEAN_ONLY, DEEP, MIN_ZERO, MIXED_REQUIRED, project(), REPEAT_UNBOUNDED, SIMPLE (+1 more)

### Community 139 - "editorStore.schemaVersion.test.ts"
Cohesion: 0.33
Nodes (5): es(), mockPlatform, PROJECT, saved, uidOf()

### Community 140 - "adapter.ts"
Cohesion: 0.02
Nodes (67): `slr-file://` serving (`protocol.rs`), The security model: `authz.rs` and the `slr-file` protocol, Pull, LocalServerInfo, OllamaRunning, PullProgress, OsInfo, PdfFolderScan (+59 more)

### Community 141 - "Git Integration"
Cohesion: 0.13
Nodes (13): REQ-GIT-550: Show a dry-run summary before a merge, REQ-GIT-550: Show a dry-run summary before a merge, Concurrent reads: `readAllConcurrently`, Git Integration, Merge preview, backup refs and Undo last merge, Tests that matter, The `gitStore` state machine (`src/state/gitStore.ts`), The pull / merge / branch-switch conflict-resolution flow (+5 more)

### Community 142 - "Annotation value trees"
Cohesion: 0.29
Nodes (7): Annotation value trees, REQ-DAT-160: Normalize trees on load, REQ-DAT-165: Preserve answers hidden by schema changes, REQ-DAT-166: Schema version, REQ-DAT-168: Report files of an unknown schema version, REQ-DAT-169: Annotations folder confined to the project directory, REQ-DAT-170: Prune only trailing empties on save

### Community 143 - "steps"
Cohesion: 0.09
Nodes (22): concurrency, cancel-in-progress, group, GH_TOKEN, jobs, publish, name, on (+14 more)

### Community 144 - "steps"
Cohesion: 0.09
Nodes (21): concurrency, cancel-in-progress, group, GH_TOKEN, if, runs-on, steps, jobs (+13 more)

### Community 145 - "Getting started"
Cohesion: 0.09
Nodes (22): Adding new PDFs from a folder, Annotating with AI, Changing the language, Correcting paper metadata, Creating diagrams, Exploring the knowledge graph, Filtering by annotation state, Finding a paper (+14 more)

### Community 146 - "protocol.rs"
Cohesion: 0.20
Nodes (10): get(), parse_range(), plus_in_query_is_a_space_like_url_search_params(), preflight(), ranges(), respond(), serve(), setup() (+2 more)

### Community 147 - "PDF viewer"
Cohesion: 0.10
Nodes (20): PDF viewer, REQ-PDF-100: Edit marks via popover, REQ-PDF-10: Render the paper's PDF, REQ-PDF-110: Per-seat mark scoping, REQ-PDF-120: Mark edits are undoable, REQ-PDF-140: Selection through marks, REQ-PDF-150: Reference hover previews, REQ-PDF-160: Export marks into a PDF (+12 more)

### Community 149 - "store.equality.test.ts"
Cohesion: 0.40
Nodes (4): equalOf(), mockPlatform, schema, st()

### Community 150 - "steps"
Cohesion: 0.10
Nodes (20): jobs, mutation, runs-on, steps, timeout-minutes, name, on, workflow_dispatch (+12 more)

### Community 151 - "scenarios.ts"
Cohesion: 0.14
Nodes (18): answers(), assert(), AUTHORS, PaperAnswers, PaperId, PAPERS, PROJECT, pullOutcome() (+10 more)

### Community 152 - "Annotation form"
Cohesion: 0.10
Nodes (20): Annotation form, REQ-ANN-100: Link PDF marks to fields as evidence, REQ-ANN-10: Render form from schema, REQ-ANN-110: Auto-link fresh marks once, REQ-ANN-120: Reindex links on instance removal, REQ-ANN-130: Three-section validation view, REQ-ANN-140: Filter papers within a validation section, REQ-ANN-150: Per-paper issue collapse in "Other papers" (+12 more)

### Community 153 - "align.property.test.ts"
Cohesion: 0.18
Nodes (13): canonical(), canonicalNode(), CLAIMS, DEFS, entryKey(), finding(), KINDS, NOTES (+5 more)

### Community 154 - "launch"
Cohesion: 0.13
Nodes (22): endpoint(), is_root(), local_logs(), local_status(), lock(), probe_route(), pump(), ring_log_keeps_the_last_lines() (+14 more)

### Community 155 - "18. Port leftovers (renderer, exports, git cap)"
Cohesion: 0.25
Nodes (8): 18.1 Project and revision assembly, 18.2 Exports, 18.3 Git output cap, 18.4 Desktop shell detection, 18.5 Update UI, 18.6 Close guard, 18.7 Verification and gaps, 18. Port leftovers (renderer, exports, git cap)

### Community 156 - "Annotation form"
Cohesion: 0.10
Nodes (20): Annotation form, REQ-ANN-100: Link PDF marks to fields as evidence, REQ-ANN-10: Render form from schema, REQ-ANN-110: Auto-link fresh marks once, REQ-ANN-120: Reindex links on instance removal, REQ-ANN-130: Three-section validation view, REQ-ANN-140: Filter papers within a validation section, REQ-ANN-150: Per-paper issue collapse in "Other papers" (+12 more)

### Community 157 - "Workspace shell"
Cohesion: 0.10
Nodes (20): REQ-PDF-185: Show the screeners' highlights, REQ-PDF-190: Single-page view, REQ-UI-100: Open the Settings dialog, REQ-UI-130: Complete language files, REQ-UI-150: Open the Settings dialog from the help, REQ-UI-160: Show project entries only with a project, REQ-UI-180: Keep focus inside open dialogs, REQ-UI-190: Knowledge graph view (+12 more)

### Community 158 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, jsx, lib, module, moduleDetection, moduleResolution, noEmit (+11 more)

### Community 159 - "tauri-linux-gui"
Cohesion: 0.12
Nodes (18): context, dockerfile, SCREEN_RESOLUTION, VNC_PASSWORD, services, tauri-linux, tauri-linux-gui, build (+10 more)

### Community 171 - "SaiLoR User Guide"
Cohesion: 0.29
Nodes (7): Before you start, Desktop app and online demo, Getting help inside the app, Guide contents, License, Quick start, SaiLoR User Guide

### Community 172 - "Project file loading"
Cohesion: 0.18
Nodes (11): Project file loading, REQ-DAT-100: Mark PDF-extracted abstracts, REQ-DAT-10: Reject invalid JSON with a message, REQ-DAT-20: Bound input nesting depth, REQ-DAT-30: Report structural errors per path, REQ-DAT-40: Preserve unknown keys, REQ-DAT-50: Reject duplicate paper identifiers, REQ-DAT-60: Require paper identity and PDF (+3 more)

### Community 173 - "editorStore.realPdf.test.ts"
Cohesion: 0.15
Nodes (8): App(), Opened, react-pdf, require, LOCATION, mockPlatform, picked, require

### Community 174 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, lib, module, moduleDetection, moduleResolution, noEmit, noFallthroughCasesInSwitch (+9 more)

### Community 175 - "TODO: Capture the report screenshots"
Cohesion: 0.12
Nodes (16): 0. Status, 1. Prepare the build, 2. Figure list, 3.1 `figures/annotate-overview.png`, 3.2 `figures/project-editor-schema.png`, 3.3 `figures/screening-record.png`, 3.4 `figures/consolidation-compare-popup.png`, 3.5 `figures/git-merge-conflicts.png` (+8 more)

### Community 176 - "Build SaiLoR from source"
Cohesion: 0.12
Nodes (14): Build in Docker (Linux only), Build SaiLoR from source, Build the online demo, Common problems, Installer output, Limits, Prerequisites, Preview the project website (+6 more)

### Community 177 - "run"
Cohesion: 0.23
Nodes (16): steps, REPORT, rust, steps, runs-on, steps, timeout-minutes, env (+8 more)

### Community 178 - "Git support"
Cohesion: 0.12
Nodes (16): Before and after a merge, Cloning a repository, Commit history, Credentials, Field-level commit review, Git support, How the project's own settings are merged, Merging another branch (+8 more)

### Community 179 - "Setting up a project"
Cohesion: 0.12
Nodes (16): Adding papers, Building the schema, Duplicate detection, Paper ids, Project settings, Provenance, Saving, Schema info (+8 more)

### Community 180 - "Evaluation: Move from Electron to Tauri"
Cohesion: 0.05
Nodes (38): 10. Facts to verify before deciding, 11.1 tauri-driver e2e spike results (2026-11-01), 11. Phase 0 spike results (2026-11-01), 12. Decisions, 13. Phase 2 progress, 14. Phase 4 progress (AI), 16.1 Updater, 16.2 Release workflow (+30 more)

### Community 181 - "tauri-build"
Cohesion: 0.15
Nodes (15): run, tauri-build, tauri-e2e, os, shell, fail-fast, matrix, defaults (+7 more)

### Community 182 - "env"
Cohesion: 0.13
Nodes (15): APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_ID, APPLE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID, GITHUB_TOKEN, ID (+7 more)

### Community 183 - "package.json"
Cohesion: 0.07
Nodes (35): allowScripts, esbuild@0.25.12, author, description, devDependencies, jsdom@^25.0.1, @stryker-mutator/core@10.1.1, @stryker-mutator/vitest-runner@10.1.1 (+27 more)

### Community 184 - "20. Phase 6 cutover"
Cohesion: 0.22
Nodes (8): 20.1 Removed, 20.2 App identity, 20.3 Probe build, 20.4 Renderer, 20.5 Workflows, 20.6 Not done, 20.7 Window title and Close project button, 20. Phase 6 cutover

### Community 185 - "stryker.config.json"
Cohesion: 0.13
Nodes (14): cleanTempDir, htmlReporter, fileName, incremental, incrementalFile, jsonReporter, fileName, mutate (+6 more)

### Community 186 - "ci.yml"
Cohesion: 0.14
Nodes (13): concurrency, cancel-in-progress, group, name, on, pull_request, push, workflow_dispatch (+5 more)

### Community 187 - "jobs"
Cohesion: 0.14
Nodes (14): runs-on, steps, timeout-minutes, runs-on, timeout-minutes, jobs, audit, build (+6 more)

### Community 188 - "openwiki.yml"
Cohesion: 0.14
Nodes (13): jobs, update, name, on, schedule, workflow_dispatch, permissions, contents (+5 more)

### Community 189 - "scripts"
Cohesion: 0.14
Nodes (14): scripts, build, build:demo, check:site, check:wiki, dev, preview, scenario (+6 more)

### Community 190 - "DuplicateReviewDialog.tsx"
Cohesion: 0.32
Nodes (6): DuplicateRow(), formatValue(), reasonLabel(), TargetInfo, targetOf(), DuplicateDecision

### Community 191 - "streamPapers"
Cohesion: 0.19
Nodes (12): REQ-PLT-440: Open a project in two steps, REQ-PLT-442: Do not save a project that is still loading, REQ-PLT-443: Show the load progress and wait with whole-project features, REQ-PLT-440: Open a project in two steps, REQ-PLT-442: Do not save a project that is still loading, REQ-PLT-443: Show the load progress and wait with whole-project features, Flow, Progressive Project Loading (+4 more)

### Community 192 - "release.yml"
Cohesion: 0.15
Nodes (12): concurrency, cancel-in-progress, group, name, on, push, release, workflow_dispatch (+4 more)

### Community 193 - "localCatalog.ts"
Cohesion: 0.39
Nodes (5): findCatalogEntry(), LOCAL_MODEL_CATALOG, LocalModelEntry, requireAvailableEntry(), RUNTIME_LICENSE_NOTE

### Community 194 - "build"
Cohesion: 0.17
Nodes (12): defaults, needs, runs-on, strategy, run, os, target, build (+4 more)

### Community 195 - "with"
Cohesion: 0.17
Nodes (12): with, args, cache, key, node-version, releaseId, subject-path, targets (+4 more)

### Community 196 - "fieldUsage.ts"
Cohesion: 0.27
Nodes (5): AnswerBearingPaper, asTree(), linkMatchesPath(), treesOf(), treeUsesPath()

### Community 197 - "PdfMark"
Cohesion: 0.29
Nodes (8): Screening highlights carried into the next project, classifyImport(), counterpart(), record(), screeningMarksByPaper(), screeningSeatLabel(), annotation(), screening

### Community 198 - "Project file loading"
Cohesion: 0.18
Nodes (11): Project file loading, REQ-DAT-100: Mark PDF-extracted abstracts, REQ-DAT-10: Reject invalid JSON with a message, REQ-DAT-20: Bound input nesting depth, REQ-DAT-30: Report structural errors per path, REQ-DAT-40: Preserve unknown keys, REQ-DAT-50: Reject duplicate paper identifiers, REQ-DAT-60: Require paper identity and PDF (+3 more)

### Community 199 - "graph.ts"
Cohesion: 0.10
Nodes (36): REQ-UI-230: Knowledge graph Cypher query, REQ-DAT-480: Build the knowledge graph, REQ-DAT-490: Source of the graph data, REQ-UI-230: Knowledge graph Cypher query, REQ-DAT-480: Build the knowledge graph, REQ-DAT-490: Source of the graph data, Build the graph, Cypher query (+28 more)

### Community 200 - "steps"
Cohesion: 0.31
Nodes (11): steps, steps, steps, steps, id, if, name, run (+3 more)

### Community 201 - "Build, CI, and Release"
Cohesion: 0.14
Nodes (14): Build, CI, and Release, Build pipeline, CI: `.github/workflows/ci.yml`, Generation, Linux Docker build, Loop prevention, Makefile targets, Mirroring (publish ↔ import) (+6 more)

### Community 202 - "Things to know"
Cohesion: 0.18
Nodes (11): A smaller one: a Yes/No field can never be reported as missing, AI proposals can be wrong, Discard in the git commit review is real the moment you press the button, Hand-editing config in the JSON silently deletes your changes, No file locking between people sharing one folder, PDF paths are relative to the JSON file, Renaming, moving, or removing a schema field, Strict mode does not protect the data (+3 more)

### Community 203 - "with"
Cohesion: 0.20
Nodes (10): with, cache, components, if-no-files-found, name, node-version, path, tool (+2 more)

### Community 204 - "Annotation value trees"
Cohesion: 0.29
Nodes (7): Annotation value trees, REQ-DAT-160: Normalize trees on load, REQ-DAT-165: Preserve answers hidden by schema changes, REQ-DAT-166: Schema version, REQ-DAT-168: Report files of an unknown schema version, REQ-DAT-169: Annotations folder confined to the project directory, REQ-DAT-170: Prune only trailing empties on save

### Community 205 - "fetchPolicy.ts"
Cohesion: 0.29
Nodes (6): The repository's own config is not trusted (`safe_config`), BACKGROUND_FETCH_INTERVAL_MS, BACKGROUND_FETCH_TIMEOUT_MS, backgroundFetchAllowed(), FETCH_COMMAND_KEYS, NON_INTERACTIVE_ENV

### Community 206 - "demoAdapter.ts"
Cohesion: 0.11
Nodes (21): REQ-PLT-445: Open a bundled demo project at start, REQ-PLT-454: Bundle a PDF for every demo paper, REQ-PLT-456: Open a schema editor demo that saves by download, REQ-PLT-445: Open a bundled demo project at start, REQ-PLT-454: Bundle a PDF for every demo paper, REQ-PLT-456: Open a schema editor demo that saves by download, consolidatedFiles, DEMO_FILE_NAME (+13 more)

### Community 207 - "store.reindex.test.ts"
Cohesion: 0.33
Nodes (5): defOf(), mockPlatform, rect, schema, st()

### Community 208 - "wiki-assets/Home.md"
Cohesion: 0.22
Nodes (6): 📘 [Development documentation](Development), SaiLoR Wiki, 📗 [User guide](User-Guide), [SaiLoR — Developer Documentation](Home), [User Guide](User-Guide), [🏠 Wiki home](Home)

### Community 209 - "env"
Cohesion: 0.22
Nodes (9): env, CONCEPT_RECID, GH_REPO, GH_TOKEN, RELEASE_BODY, RELEASE_NAME, TAG, ZENODO_TOKEN (+1 more)

### Community 210 - "PdfViewer"
Cohesion: 0.35
Nodes (12): REQ-PDF-130: Mark cycling in reading order, REQ-PDF-130: Mark cycling in reading order, PdfViewer, Field-linking, Reading order: `sortMarksForCycling`, FieldLinkPopover(), columnOf(), dedupeMarkGroups() (+4 more)

### Community 211 - "Component Tree"
Cohesion: 0.29
Nodes (7): Component Tree, Dropdown component, In-app self-update (tauri-plugin-updater), PaperList search modes, Validation, paperMetadataHaystack(), paperMetadataRaw()

### Community 212 - "The managed runtime lifecycle"
Cohesion: 0.14
Nodes (13): Downloads: resume, cancel, stall, Hardware probing and backend choice, Local Models and Ollama, Model plan and install, Runtime discovery (`local_runtime`), Runtime plan and install, Server manager, Tests (+5 more)

### Community 213 - "OpenFastTrace migration scripts"
Cohesion: 0.25
Nodes (7): Conversion rules, Files, OpenFastTrace migration scripts, Procedure, Proposed text for AGENTS.md, Tag rules, The `make trace` target

### Community 214 - "SaiLoR: Software Requirements"
Cohesion: 0.40
Nodes (5): Coverage summary, Files, Glossary, Method & evidence notes, SaiLoR: Software Requirements

### Community 215 - "SaiLoR — Quickstart"
Cohesion: 0.29
Nodes (7): How a call crosses the seam, On-disk layout, Quick Commands, Repository Layout, SaiLoR — Quickstart, Tech Stack, What is SaiLoR?

### Community 216 - "check-wiki-links.js"
Cohesion: 0.38
Nodes (6): allProblems, checkDir(), results, slug(), stripFrontmatter(), SUBWIKI_PAGES

### Community 217 - "useCloseGuard"
Cohesion: 0.29
Nodes (7): REQ-PLT-100: Prompt on close with unsaved changes, REQ-PLT-310: Application undo via menu, REQ-PLT-370: Menu bar on Windows and Linux, REQ-PLT-100: Prompt on close with unsaved changes, REQ-PLT-310: Application undo via menu, REQ-PLT-370: Menu bar on Windows and Linux, useCloseGuard()

### Community 218 - "updates"
Cohesion: 0.29
Nodes (6): interval, updates, directory, package-ecosystem, schedule, version

### Community 219 - "jobs"
Cohesion: 0.29
Nodes (7): needs, runs-on, jobs, check-updater-json, zenodo, if, runs-on

### Community 220 - "checksums"
Cohesion: 0.29
Nodes (7): needs, permissions, runs-on, timeout-minutes, checksums, attestations, id-token

### Community 221 - "release"
Cohesion: 0.29
Nodes (7): release, id, tag, environment, if, outputs, runs-on

### Community 222 - "Online Demo and Project Site"
Cohesion: 0.29
Nodes (7): Citation on the site, Demo content, Online Demo and Project Site, Site and Pages deploy, Tests and requirements, The compile-time demo switch, The demo adapter

### Community 223 - "Testing Strategy"
Cohesion: 0.18
Nodes (11): CI gating, `ci.yml` — eight jobs, Layer 3 — Rust unit tests, Layer 4 — The e2e probe, `release.yml` — not a test gate, Requirement tracing and mutation testing, `scripts/ci.sh` — the provider-agnostic renderer pipeline, Testing Strategy (+3 more)

### Community 224 - "README.md"
Cohesion: 0.10
Nodes (20): Architecture, Citation, Deployment, Developing with Docker, Diagrams, Git, Installing a release, Keyboard shortcuts (+12 more)

### Community 225 - "setup.sh script"
Cohesion: 0.62
Nodes (6): confirm(), node_ok(), say(), setup.sh script, choose(), have()

### Community 226 - "PDF Viewer and Marks"
Cohesion: 0.14
Nodes (17): Demo notice, Mark export, Mark lifecycle, PDF marks, PDF Viewer and Marks, Per-session escape approval, Reading-position persistence, Supporting modules (+9 more)

### Community 227 - "build_menu"
Cohesion: 0.33
Nodes (6): app_set_language(), build_menu(), every_menu_label_has_an_entry_in_every_language(), macos_menu(), menu(), tr()

### Community 229 - "Paper list"
Cohesion: 0.11
Nodes (18): Paper list, REQ-LST-10: List papers with status, REQ-LST-20: Two-mode search, REQ-LST-25: Case-sensitive paper search toggle, REQ-LST-30: Five-state annotation indicator, REQ-LST-60: Search and completeness performance, REQ-LST-70: Resume where the reviewer left off, REQ-LST-90: Mark a missing PDF file in the paper list (+10 more)

### Community 230 - "9. Multiple reviewers & Consolidation"
Cohesion: 0.33
Nodes (6): 9. Multiple reviewers & Consolidation, Lowering the reviewer count, Setting it up, Strict mode, Validating, What changes

### Community 232 - "Annotation schema"
Cohesion: 0.33
Nodes (6): Annotation schema, REQ-DAT-110: Schema node structure, REQ-DAT-120: Unique sibling names, REQ-DAT-130: Drop required on booleans, REQ-DAT-140: Restrict visibleIf targets and values, REQ-DAT-150: Bound schema instance fan-out

### Community 233 - "Annotation schema"
Cohesion: 0.33
Nodes (6): Annotation schema, REQ-DAT-110: Schema node structure, REQ-DAT-120: Unique sibling names, REQ-DAT-130: Drop required on booleans, REQ-DAT-140: Restrict visibleIf targets and values, REQ-DAT-150: Bound schema instance fan-out

### Community 234 - "Validation"
Cohesion: 0.33
Nodes (6): REQ-DAT-180: Total, non-throwing validation, REQ-DAT-190: Required, type, enum, and cardinality checks, REQ-DAT-200: Skip hidden fields in validation, REQ-DAT-210: Separate unannotated papers, REQ-DAT-215: Report hidden answers in validation, Validation

### Community 236 - "DemoBanner"
Cohesion: 0.40
Nodes (5): REQ-PLT-448: Show a demo notice with a download link, REQ-PLT-455: Link the demo back to the project page, REQ-PLT-448: Show a demo notice with a download link, REQ-PLT-455: Link the demo back to the project page, DemoBanner()

### Community 237 - "bundle.sh"
Cohesion: 0.50
Nodes (4): SAILOR_PROBE_PROJECT, SAILOR_PROBE_REPORT, bundle.sh script, step()

### Community 238 - "store.readingPosition.test.ts"
Cohesion: 0.33
Nodes (3): mockPlatform, schema, twoPaperProject

### Community 239 - "AGENTS.md"
Cohesion: 0.50
Nodes (3): Caveman mode, OpenWiki, Requirements docs

### Community 241 - "Multi-reviewer data"
Cohesion: 0.40
Nodes (5): Multi-reviewer data, REQ-DAT-260: Independent reviewer trees, REQ-DAT-270: Pre-create reviewer skeletons, REQ-DAT-280: Never drop higher-numbered reviewers, REQ-DAT-285: AI reviewer seat is the last configured seat

### Community 242 - "Multi-reviewer data"
Cohesion: 0.40
Nodes (5): Multi-reviewer data, REQ-DAT-260: Independent reviewer trees, REQ-DAT-270: Pre-create reviewer skeletons, REQ-DAT-280: Never drop higher-numbered reviewers, REQ-DAT-285: AI reviewer seat is the last configured seat

### Community 243 - "Requirements ↔ Code Traceability Matrix"
Cohesion: 0.40
Nodes (5): Coverage statistics, How the links were recovered, Link semantics, Requirements ↔ Code Traceability Matrix, Screening ([screening.md](screening.md))

### Community 245 - "steps"
Cohesion: 0.50
Nodes (4): runs-on, steps, timeout-minutes, cargo-audit

### Community 246 - "The PdfViewer component"
Cohesion: 0.50
Nodes (4): Navigation and current-page tracking, Rendering and zoom, Single-page view, The PdfViewer component

### Community 251 - "Platform & desktop shell ([platform.md](platform.md))"
Cohesion: 0.26
Nodes (8): REQ-PLT-270: Self-update per bundle type, REQ-PLT-41: Write only changed files, REQ-PLT-270: Self-update per bundle type, REQ-PLT-41: Write only changed files, Platform & desktop shell ([platform.md](platform.md)), noteOpened(), noteWritten(), withBaselineDropped()

### Community 256 - "PdfViewer.tsx"
Cohesion: 0.14
Nodes (14): Text-selection capture for field-grabbing, clearHighlights(), dedupeOverlappingRects(), LinkPreviewImage, MarkOpenEvent, MarkOverlayItem(), markTooltipCoords(), markVerticallyVisible() (+6 more)

### Community 257 - "Validation"
Cohesion: 0.33
Nodes (6): REQ-DAT-180: Total, non-throwing validation, REQ-DAT-190: Required, type, enum, and cardinality checks, REQ-DAT-200: Skip hidden fields in validation, REQ-DAT-210: Separate unannotated papers, REQ-DAT-215: Report hidden answers in validation, Validation

### Community 271 - "@vitejs/plugin-react"
Cohesion: 0.33
Nodes (4): vite@^6.0.7, @vitejs/plugin-react@^4.3.4, vite, @vitejs/plugin-react

### Community 273 - "Technical report"
Cohesion: 0.22
Nodes (6): Files, Audience and scope, Layout, Phases, Section plan, Technical report

## Knowledge Gaps
- **24 isolated node(s):** `About`, `CloseWindow`, `Fullscreen`, `Github`, `Minimize` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 2812 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **45 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `jobs` connect `jobs` to `release.yml`, `build`, `checksums`, `release`?**
  _High betweenness centrality (0.213) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `t()` (e.g. with `REQ-UI-120: Translated user interface` and `REQ-UI-120: Translated user interface`) actually correct?**
  _`t()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `About`, `CloseWindow`, `Fullscreen` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `git.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.04306698002350176 - nodes in this community are weakly interconnected._
- **Why does `with` connect `with` to `steps`?**
  _High betweenness centrality (0.207) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `useT()` (e.g. with `REQ-UI-120: Translated user interface` and `REQ-UI-120: Translated user interface`) actually correct?**
  _`useT()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Should `Rust Docs/Builders` be split into smaller, more focused modules?**
  _Cohesion score 0.07559107559107558 - nodes in this community are weakly interconnected._