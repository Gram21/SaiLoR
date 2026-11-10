# Graph Report - slr-helper  (2026-11-10)

## Corpus Check
- Large corpus: 766 files · ~1,116,699 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 4992 nodes · 16049 edges · 171 communities (147 shown, 24 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 363 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Rust Project Core
- Rust Docs/Builders
- Test Fixtures & Libs
- Prompt Overrides & Fewshot
- Agent Deps & LLM Plan
- Run Feedback
- Chat Requests & Models
- Git Repo Setup
- App Shell & Dialogs
- Graph Canvas
- Rust Project Model
- Annotation Panel & AI Disclosure
- Rust IO & Paths
- Ollama & Base URLs
- Rust LLM HTTP
- Merge Logic
- AI Eval & Export Dialogs
- Hostile-input Tests
- Chat Response Parsing
- Split Rows & Metadata
- Diagram View
- PaperList Test Helpers
- Cypher Worker
- CI Scripts
- Paper List
- Token Budget
- Close Guard
- Papers Editor
- AI Dialog
- Screening Panel
- Agent Runner
- Desktop Adapter & PDFs
- Git Branch/Pull Ops
- Diagram Export
- Tauri Menu
- IP/Host Validation
- Dialog Close (Rust)
- Session & Commits
- Toolbar & Zustand
- Legacy Project Split
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160
- Community 161
- Community 164

## God Nodes (most connected - your core abstractions)
1. `t()` - 283 edges
2. `useStore` - 242 edges
3. `useT()` - 198 edges
4. `Session` - 115 edges
5. `loadProject()` - 102 edges
6. `SlrBridge` - 101 edges
7. `useEditorStore` - 87 edges
8. `Modal()` - 77 edges
9. `SaveHandle` - 77 edges
10. `useAiStore` - 77 edges

## Surprising Connections (you probably didn't know these)
- `known()` --calls--> `normalize()`  [INFERRED]
  src-tauri/src/annotations.rs → src-tauri/src/paths.rs
- `move_dir()` --calls--> `paper_ids()`  [INFERRED]
  src-tauri/src/annotations.rs → src-tauri/src/project.rs
- `shared()` --calls--> `normalize()`  [INFERRED]
  src-tauri/src/annotations.rs → src-tauri/src/paths.rs
- `shared()` --calls--> `paper_ids()`  [INFERRED]
  src-tauri/src/annotations.rs → src-tauri/src/project.rs
- `split()` --calls--> `normalize()`  [INFERRED]
  src-tauri/src/annotations.rs → src-tauri/src/paths.rs

## Import Cycles
- 2-file cycle: `src/model/diagram.ts -> src/model/diagramSvg.ts -> src/model/diagram.ts`
- 2-file cycle: `src/model/metadata.ts -> src/model/project.ts -> src/model/metadata.ts`

## Communities (171 total, 24 thin omitted)

### Community 0 - "Rust Project Core"
Cohesion: 0.05
Nodes (103): ALLOWED_SCHEMES, annotation_authors_parser(), annotations_rel_dir(), apply_managed_block(), ATTRIBUTES_BODY, BACKGROUND_FETCH_TIMEOUT, BACKUP_REFS, BACKUPS_KEPT (+95 more)

### Community 1 - "Rust Docs/Builders"
Cohesion: 0.05
Nodes (72): add_annot(), annotation(), collect_pdfs(), colors_dates_and_text_match_pdf_lib(), embed(), embed_marks(), embed_never_changes_an_approved_pdf_outside_the_project(), embed_reads_only_project_pdfs() (+64 more)

### Community 2 - "Test Fixtures & Libs"
Cohesion: 0.04
Nodes (27): USAGE, writes, project, ConflictDialogLabels, aiSeatConflict, labels, DemoBanner(), saved (+19 more)

### Community 3 - "Prompt Overrides & Fewshot"
Cohesion: 0.06
Nodes (73): fieldPaths(), AgentInput, answeredLines(), assemble(), buildFewShotBlock(), countAnsweredFields(), exampleLines(), FewShotExample (+65 more)

### Community 4 - "Agent Deps & LLM Plan"
Cohesion: 0.03
Nodes (42): AgentDeps, SystemOnePlan, LlmHttpRequest, LlmHttpResponse, collapseWhitespace(), DEFAULT_MAX_PAGES, extractPdfText(), linesFromItems() (+34 more)

### Community 5 - "Run Feedback"
Cohesion: 0.05
Nodes (84): buildRunFeedback(), feedbackFileName(), FeedbackRow, FieldFeedback, hasFeedbackWorthSaving(), RunFeedback, RunFeedbackInput, show() (+76 more)

### Community 6 - "Chat Requests & Models"
Cohesion: 0.06
Nodes (71): ModelPickerProps, ANTHROPIC_WEB_SEARCH, anthropicMessages(), buildChatRequest(), ChatMessage, ChatResponse, ChatRole, ChatUsage (+63 more)

### Community 7 - "Git Repo Setup"
Cohesion: 0.03
Nodes (6): CloneOutcome, GitRun, RepoSetupStatus, SplitProject, ProjectFileEntry, SlrBridge

### Community 8 - "App Shell & Dialogs"
Cohesion: 0.09
Nodes (50): App(), AgreementDialog(), PerFieldTable(), BranchSwitchPrompt(), ClosePrompt(), AutoGrowText(), ConflictResolutionDialog(), ConflictRow() (+42 more)

### Community 9 - "Graph Canvas"
Cohesion: 0.07
Nodes (61): addEdge(), ARROW_ZOOM, buildScene(), cull(), DASH, DASH_ZOOM, drawScene(), EDGE_DASH (+53 more)

### Community 10 - "Rust Project Model"
Cohesion: 0.08
Nodes (62): Head, normalize(), annotations_folder_for(), batches_follow_links_only_inside_the_annotations_folder(), batches_use_the_papers_and_folder_listed_when_opened(), DEFAULT_ANNOTATIONS_DIR, deletable(), FEEDBACK_DIR (+54 more)

### Community 11 - "Annotation Panel & AI Disclosure"
Cohesion: 0.08
Nodes (53): AiUsageDisclosure(), providerLabel(), AnnotationPanel(), PersonPicker(), ReviewerPrompt(), ScreeningRecord(), SeatConflictNotice(), SettingsDialog() (+45 more)

### Community 12 - "Rust IO & Paths"
Cohesion: 0.08
Nodes (52): annotations_dir_users(), base_name(), collide_needs_same_kind_and_a_shared_paper(), colliding(), files_collide(), folder_ok(), is_screening(), known() (+44 more)

### Community 13 - "Ollama & Base URLs"
Cohesion: 0.09
Nodes (59): base_url_refuses_link_local(), base_urls(), capabilities_of(), check_base_url(), client(), context_of(), delete(), discover() (+51 more)

### Community 14 - "Rust LLM HTTP"
Cohesion: 0.07
Nodes (50): API_KEY_SENTINEL, build_call_headers(), call(), call_can_be_aborted(), call_can_be_aborted_while_the_local_model_starts(), call_headers(), call_pins_the_origin_and_splices_the_key(), CallRequest (+42 more)

### Community 15 - "Merge Logic"
Cohesion: 0.07
Nodes (67): applyOne(), applyResolutions(), applySchemaRow(), arrOf(), atHistory(), canonicalPaper(), changedFromBase(), collectRemovedDefs() (+59 more)

### Community 16 - "AI Eval & Export Dialogs"
Cohesion: 0.07
Nodes (52): ContextFields(), Target, hostedPreset(), HostedSystemOnePanel(), JEV_URL, CLOUD_PROVIDERS, GUIDED, isLoopback() (+44 more)

### Community 17 - "Hostile-input Tests"
Cohesion: 0.06
Nodes (52): mergeResultProblem(), NASTY, reopen(), comparePapers(), exceedsDepth(), extractExtra(), hasContent(), KNOWN_PAPER_KEYS (+44 more)

### Community 18 - "Chat Response Parsing"
Cohesion: 0.06
Nodes (59): RFC-9110, parseChatResponse(), safeParseArgs(), tokens(), uniqueCitations(), extractError(), extractText(), textOfParts() (+51 more)

### Community 19 - "Split Rows & Metadata"
Cohesion: 0.04
Nodes (58): Props, SplitRow, MetadataValues, PdfProposal, PdfMark, AiUsageRecord, ScreeningMark, UnannotatedPaper (+50 more)

### Community 20 - "Diagram View"
Cohesion: 0.07
Nodes (55): DiagramView(), FORMATS, Section(), Shown, FontChoice, ResultView(), TABS, aggregate() (+47 more)

### Community 21 - "PaperList Test Helpers"
Cohesion: 0.06
Nodes (46): emptyTree(), filledTree(), loadOnePaper(), makePaper(), schema, SCHEMA, SCHEMA_DEFS, screeningTree() (+38 more)

### Community 22 - "Cypher Worker"
Cohesion: 0.06
Nodes (55): CypherWorker, startCypherWorker(), Params, GraphEdgeType, byType(), byTypeCache, Chain, CMP (+47 more)

### Community 23 - "CI Scripts"
Cohesion: 0.05
Nodes (24): makefile, workflow, GitStatus, examples, page, PanelState, nodeFs, fakeGit (+16 more)

### Community 24 - "Paper List"
Cohesion: 0.08
Nodes (50): project(), SCHEMA, dotStateLabel(), FILTER_KEY, FULL, PARTIAL, project(), SCHEMA (+42 more)

### Community 25 - "Token Budget"
Cohesion: 0.06
Nodes (45): chatInputBudget(), estimateTokens(), fitPaperText(), FittedText, findCatalogEntry(), LOCAL_MODEL_CATALOG, LocalModelEntry, requireAvailableEntry() (+37 more)

### Community 26 - "Close Guard"
Cohesion: 0.05
Nodes (24): Pull, tauriWindow, useCloseGuard(), LocalServerInfo, OllamaRunning, PullProgress, WebFetchResult, SharedAnnotations (+16 more)

### Community 27 - "Papers Editor"
Cohesion: 0.08
Nodes (41): DropPosition, DropTarget, duplicatePaperIds(), idProblemLabel(), PaperFields(), PaperFieldsProps, PapersEditor(), rowClass() (+33 more)

### Community 28 - "AI Dialog"
Cohesion: 0.11
Nodes (47): AiDialog(), allPapersWarning(), confidenceLabel(), deliveryOf(), EditControl(), estimateLine(), isPaperEvidence(), JudgeCell() (+39 more)

### Community 29 - "Screening Panel"
Cohesion: 0.10
Nodes (37): AnnotationValueTree, Project, seatTree(), countPendingUnanimous(), pendingUnanimous(), pendingUnanimousDecisions(), ScreeningCounts, screeningCounts() (+29 more)

### Community 30 - "Agent Runner"
Cohesion: 0.08
Nodes (46): abortError(), AgentEvent, describeToolCall(), fieldSignature(), runAgent(), callTool(), runAgentTurn(), safeJson() (+38 more)

### Community 31 - "Desktop Adapter & PDFs"
Cohesion: 0.06
Nodes (18): PdfSource, PickedPdf, OpenedHead, baseName(), DesktopAdapter, noteOpened(), noteWritten(), withBaselineDropped() (+10 more)

### Community 32 - "Git Branch/Pull Ops"
Cohesion: 0.04
Nodes (41): BranchSwitchStart, LogBeginResult, LogRevisionFetch, MergeStart, PullStart, beginBranchSwitchResult, beginMergeCalls, beginMergeResult (+33 more)

### Community 33 - "Diagram Export"
Cohesion: 0.08
Nodes (38): deflate(), DiagramFormat, findPdfFont(), FontSearch, measureText(), raster(), svgToPdf(), svgToPng() (+30 more)

### Community 34 - "Tauri Menu"
Cohesion: 0.07
Nodes (36): app_set_language(), app_urls_stay_in_the_window(), build_menu(), copy_never_overwrites_and_skips_missing(), copy_new(), data_dir_moves_once_and_never_overwrites(), DE, ES (+28 more)

### Community 35 - "IP/Host Validation"
Cohesion: 0.08
Nodes (33): ACCEPT, blocked_addresses(), blocked_hostnames(), body_is_capped(), charset(), check_public_host(), client(), content_types() (+25 more)

### Community 36 - "Dialog Close (Rust)"
Cohesion: 0.08
Nodes (33): app_reload(), app_save_complete(), ask_user(), CANCEL, Choice, choice(), Cancel, Discard (+25 more)

### Community 37 - "Session & Commits"
Cohesion: 0.13
Nodes (43): Session, add_and_commit(), annotation_authors(), apply_repo_setup(), as_run(), assert_ref(), assert_rel_path(), assert_root() (+35 more)

### Community 38 - "Toolbar & Zustand"
Cohesion: 0.07
Nodes (38): DispositionButtonsProps, ResultTab, SidebarToggle(), AiButtonState, aiButtonState(), GitButtonState, gitButtonState(), Icon() (+30 more)

### Community 39 - "Legacy Project Split"
Cohesion: 0.07
Nodes (34): assembleLegacyProjectJson(), isDeletableAnnotationText(), isLegacyProjectShape(), parseMarksFileName(), Entry, sampleSchema, assembler(), isScreening() (+26 more)

### Community 40 - "Community 40"
Cohesion: 0.09
Nodes (40): AgentResult, asArray(), coerce(), Coerced, extractObject(), isPlainObject(), matchBraces(), parseSchemaRemarks() (+32 more)

### Community 41 - "Community 41"
Cohesion: 0.07
Nodes (28): COMBO_MENU_MAX_HEIGHT, ComboBoxProps, ComboOption, measureWidestLabel(), AiSection(), GeneralSection(), LanguageSection(), SETTINGS_SECTIONS (+20 more)

### Community 42 - "Community 42"
Cohesion: 0.09
Nodes (35): agreementVerdict(), closingWouldStrand(), ConsolidationDialog(), paperVerdicts(), walk(), disagreementsOf(), SCHEMA, SCHEMA_DEFS (+27 more)

### Community 43 - "Community 43"
Cohesion: 0.07
Nodes (34): bool, def(), num, text, goodFields, paper, schema, submitResponse() (+26 more)

### Community 44 - "Community 44"
Cohesion: 0.10
Nodes (39): ExportGraphDialog(), Format, FORMATS, GraphSeatSelect(), buildGraph(), byCodeUnit(), collapse(), compact() (+31 more)

### Community 45 - "Community 45"
Cohesion: 0.09
Nodes (42): DupVerdict, KNOWN_ROOT_KEYS, pdfHintFileName(), RefEntry, amendVersion(), newSchemaVersionId(), bulkAssign(), applySnapshot() (+34 more)

### Community 46 - "Community 46"
Cohesion: 0.07
Nodes (25): SchemaPreview(), draftNodes(), mockPlatform, parseProvenance(), parseSchemaInfo(), gateOn(), parseStrictConfig(), OpenedProject (+17 more)

### Community 47 - "Community 47"
Cohesion: 0.12
Nodes (39): SchemaNodeRowProps, addEntryAt(), buildTargets(), canMoveEntry(), ConditionGroup(), ConditionRow(), describeCondition(), describeEntry() (+31 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (31): UnanimousFill, RawSeg, dropDuplicateSuggestions(), duplicateIndexes(), duplicateOnWrite(), entryKey(), subtreeKey(), raw (+23 more)

### Community 49 - "Community 49"
Cohesion: 0.12
Nodes (40): blocking(), git_annotation_authors(), git_apply_repo_setup(), git_background_fetch(), git_branch_create(), git_branch_delete(), git_branch_switch_abort(), git_branch_switch_begin() (+32 more)

### Community 50 - "Community 50"
Cohesion: 0.07
Nodes (34): allowed_download_url(), assets(), CANCELLED, CLEF, COMMUNITY, CREATE_NO_WINDOW, DATA_DIR_NAME, download_hosts() (+26 more)

### Community 51 - "Community 51"
Cohesion: 0.11
Nodes (37): badYear(), Draft, Entry, fromDraft(), Kind, MetadataDialog(), shown(), toDraft() (+29 more)

### Community 54 - "Community 54"
Cohesion: 0.05
Nodes (18): SaveHandle, LOCATION, mockPlatform, mockPlatform, splitCalls, mockPlatform, rect, schema (+10 more)

### Community 55 - "Community 55"
Cohesion: 0.05
Nodes (19): RecentEntry, existing, mockPlatform, PROJECT, recents, mockPlatform, schema, twoPaperProject (+11 more)

### Community 56 - "Community 56"
Cohesion: 0.12
Nodes (29): parsePorcelain(), mergeBlockingPaths(), BRANCH_SWITCH_STASH_MESSAGE, MANUAL_STASH_PREFIX, parseStashList(), STASH_LIST_FORMAT, stashBranchName(), StashEntry (+21 more)

### Community 57 - "Community 57"
Cohesion: 0.10
Nodes (23): applySplit(), fit(), Known, known(), linkFit(), planSplit(), SplitFile, SplitFs (+15 more)

### Community 58 - "Community 58"
Cohesion: 0.13
Nodes (31): Checked, capabilitiesOf(), computeNumCtx(), contextOf(), drainNdjson(), estimateKvBytes(), estimateTokens(), gpuStatus() (+23 more)

### Community 59 - "Community 59"
Cohesion: 0.11
Nodes (30): badYear(), confirmed(), Draft, PdfFolderDialog(), open(), papers(), st(), toDraft() (+22 more)

### Community 60 - "Community 60"
Cohesion: 0.06
Nodes (9): mockPlatform, PROJECT, mockPlatform, saveLlmConfig, LlmConfig, mockPlatform, stored, mockPlatform (+1 more)

### Community 61 - "Community 61"
Cohesion: 0.12
Nodes (31): classifyImport(), classifyPair(), diceOfSets(), DupReason, DupRecord, DupTarget, foldDiacritics(), fuzzyScoreAtLeast() (+23 more)

### Community 62 - "Community 62"
Cohesion: 0.09
Nodes (15): llm_abort(), abort(), abort_and_timeout(), Flight, IN_FLIGHT, NO_REDIRECT, response(), serve() (+7 more)

### Community 63 - "Community 63"
Cohesion: 0.14
Nodes (29): AnnotationFormContext, AnnotationFormWrites, AnnotationNode(), AnnotationNodeProps, Props, useConsolidationFieldStatus(), Field(), FieldLinkPopover() (+21 more)

### Community 64 - "Community 64"
Cohesion: 0.13
Nodes (30): appendRis(), cleanBibPathSegment(), cleanBibValue(), collapseSpace(), detectFormat(), endsInBareAnd(), extractBibFileHint(), finalizeRis() (+22 more)

### Community 65 - "Community 65"
Cohesion: 0.11
Nodes (24): Graph, GraphNode, GraphNodeType, NodePat, Fact, fieldMatches(), GraphIndex, indexGraph() (+16 more)

### Community 66 - "Community 66"
Cohesion: 0.20
Nodes (23): METRICS, MetricSpec, perFieldTsv(), COHEN, AgreementInput, agreementInput(), entryUnits(), FieldAgreement (+15 more)

### Community 67 - "Community 67"
Cohesion: 0.12
Nodes (17): project, consolidatedFiles, DEMO_FILE_NAME, DEMO_PDF_FILES, demoPdfUrl(), demoProjectText(), seatFiles, DEMO_NO_PDF (+9 more)

### Community 68 - "Community 68"
Cohesion: 0.15
Nodes (28): CATALOG, catalog_matches_the_renderer(), data_dir(), disk_free(), emitter(), Entry, entry(), find_entry() (+20 more)

### Community 69 - "Community 69"
Cohesion: 0.17
Nodes (24): AlignedSlot, alignLevel(), alignList(), compareReviewerIds(), contentKey(), contentOrder(), hasAnythingToMatch(), instanceSim() (+16 more)

### Community 70 - "Community 70"
Cohesion: 0.15
Nodes (23): applyFontScale(), applyTheme(), clampFont(), FONT_MAX, FONT_MIN, FONT_STEP, isLanguage(), loadAutosaveEnabled() (+15 more)

### Community 71 - "Community 71"
Cohesion: 0.25
Nodes (28): assert_openable(), bare_pair(), branch_switch_begin_abort_finish(), clone_pair(), commit_all(), commit_partial_restores_working_and_write_working(), configure(), contents() (+20 more)

### Community 72 - "Community 72"
Cohesion: 0.19
Nodes (17): copyText(), AiEvaluationDialog(), ConsolidationOverview(), DisagreementPaper, ConsolidationFieldStatus, consolidationFieldStatus(), ConsolidationVerdictsContext, emptyVerdicts (+9 more)

### Community 73 - "Community 73"
Cohesion: 0.16
Nodes (18): AnswerBearingPaper, asTree(), countLinksUsingField(), countPapersUsingField(), linkMatchesPath(), marksOf(), treesOf(), treeUsesPath() (+10 more)

### Community 74 - "Community 74"
Cohesion: 0.11
Nodes (20): MetadataEditMode, ProjectProtocol, ProjectProvenance, ScreeningConfig, SchemaHistoryEntry, StrictConfig, ProjectLocation, EditorSnapshot (+12 more)

### Community 75 - "Community 75"
Cohesion: 0.08
Nodes (24): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+16 more)

### Community 76 - "Community 76"
Cohesion: 0.18
Nodes (19): kill(), launch(), LaunchError, local_logs(), lock(), probe_route(), Running, running() (+11 more)

### Community 77 - "Community 77"
Cohesion: 0.15
Nodes (23): digests_and_tags(), display(), extract(), find_binary(), find_system(), get_json(), includes_route(), install_into() (+15 more)

### Community 78 - "Community 78"
Cohesion: 0.11
Nodes (17): ConflictResolutionState, ConflictRowProps, FieldConflict, MergeNote, MergeOutcome, Resolutions, paper(), PaperOpts (+9 more)

### Community 79 - "Community 79"
Cohesion: 0.13
Nodes (19): answerParts(), DropTarget, EMPTY_PATH, kindLabels(), SchemaNodeRow(), toInt(), GateActions, GateDropTarget (+11 more)

### Community 80 - "Community 80"
Cohesion: 0.12
Nodes (19): AGENT_REQUESTS_PER_PAPER, CLASSIFY_OUTPUT_TOKENS_PER_FIELD, CLASSIFY_OVERHEAD_TOKENS, costOf(), estimateCost(), estimateCostSplit(), estimateRun(), EstimateRunInput (+11 more)

### Community 81 - "Community 81"
Cohesion: 0.24
Nodes (20): backends(), disk_free(), Gpu, gpu(), HardwareInfo, has_word(), local_probe(), named() (+12 more)

### Community 82 - "Community 82"
Cohesion: 0.16
Nodes (9): error(), only_appimage_windows_and_macos_self_update(), Pending, percent(), percent_needs_a_known_total_and_caps_at_100(), self_update_supported(), update_check(), update_download() (+1 more)

### Community 83 - "Community 83"
Cohesion: 0.13
Nodes (15): clearHighlights(), dedupeOverlappingRects(), destinationPoint(), findMatches(), findQuoteRanges(), LinkPreviewImage, MarkOpenEvent, MarkOverlayItem() (+7 more)

### Community 84 - "Community 84"
Cohesion: 0.20
Nodes (13): abstractFromLines(), cleanTitle(), extractPdfMeta(), findDoi(), isPlausibleTitle(), joinWrappedLines(), Line, looksLikeName() (+5 more)

### Community 85 - "Community 85"
Cohesion: 0.20
Nodes (15): backslash_is_a_plain_character_on_posix(), paths_absolute(), paths_rebase(), paths_relative(), paths_sibling(), rebase_and_absolute(), relative(), relative_matches_node() (+7 more)

### Community 86 - "Community 86"
Cohesion: 0.11
Nodes (6): ctx, FakeWorker, listed(), nodeList(), PointerEventPolyfill, saved

### Community 87 - "Community 87"
Cohesion: 0.22
Nodes (11): content_problem(), feedback_dir_for(), FeedbackFile, file_name_problem(), list_feedback(), MAX_FEEDBACK_BYTES, name_and_content_rules(), project_list_feedback() (+3 more)

### Community 88 - "Community 88"
Cohesion: 0.16
Nodes (17): abstractFromPdfLabel(), applyField(), applyFieldWithBundle(), arrOf(), BOOKKEEPING_FIELDS, composeContents(), containerAt(), detectFieldChanges() (+9 more)

### Community 89 - "Community 89"
Cohesion: 0.32
Nodes (18): annotateHelp(), annotateKeys(), commonFaqs(), editorHelp(), editorKeys(), Faq(), HelpDialog(), HelpSection (+10 more)

### Community 90 - "Community 90"
Cohesion: 0.19
Nodes (13): alignableNodes(), consolidationMark(), consolidatorHasAnswered(), digest(), markParts(), needsAlignment(), needsAlignmentCount(), agreed (+5 more)

### Community 91 - "Community 91"
Cohesion: 0.13
Nodes (12): makePaper(), SCHEMA, SCHEMA_DEFS, splitPaper(), tree(), verdictOf(), PaperOpts, project() (+4 more)

### Community 92 - "Community 92"
Cohesion: 0.12
Nodes (10): ALL_TARGETS, bodyOf(), FIELDS, localRuntime, mockPlatform, nextPdfText, PROJECT, SCHEMA (+2 more)

### Community 93 - "Community 93"
Cohesion: 0.15
Nodes (14): CLAIMS, DEFS, finding(), KINDS, NOTES, paper(), pick(), randomStudy() (+6 more)

### Community 95 - "Community 95"
Cohesion: 0.24
Nodes (13): CommitMessageField(), DispositionButtons(), FieldChangeRow(), GitDialog(), isProjectOwnPath(), mixedDiscardConfirmMessage(), PaperChangeRow(), formatDate() (+5 more)

### Community 96 - "Community 96"
Cohesion: 0.20
Nodes (13): GraphQueryBox(), Props, isCypher(), BUILT_IN_PROPS, CYPHER_WORDS, cypherProps(), EDGE_TYPES, NODE_LABELS (+5 more)

### Community 97 - "Community 97"
Cohesion: 0.17
Nodes (14): canonical(), canonicalNode(), CLAIMS, DEFS, entryKey(), finding(), KINDS, NOTES (+6 more)

### Community 98 - "Community 98"
Cohesion: 0.22
Nodes (8): cooled(), createLayout(), LayoutFrame, layoutHost(), LayoutMessage, layoutSettings(), LayoutStart, handle

### Community 99 - "Community 99"
Cohesion: 0.22
Nodes (9): DEMO_MODE, DEMO_SCHEMA_MODE, DEMO_BACK_LABEL, DEMO_BACK_URL, DEMO_READ_ON_ARXIV, DEMO_RELEASES_URL, DEMO_SCHEMA_NOTICE, DEMO_START (+1 more)

### Community 100 - "Community 100"
Cohesion: 0.21
Nodes (12): capDiff(), CommitRecord, DiffLine, diffLines(), gitErrorText(), isUnmergedCode(), listed(), MAX_DIFF_CHARS (+4 more)

### Community 101 - "Community 101"
Cohesion: 0.17
Nodes (11): Allow, content_range_starts_at(), Download, download_verified(), Emit, get(), host_of(), LOOPBACK (+3 more)

### Community 102 - "Community 102"
Cohesion: 0.26
Nodes (11): CHECK_INTERVAL_MS, comparePre(), fetchLatestRelease(), isHttps(), isNewerVersion(), NEW_ISSUE_URL, parts(), pickInstaller() (+3 more)

### Community 103 - "Community 103"
Cohesion: 0.24
Nodes (12): ann(), apply(), claimOf(), evidence(), findings(), loadAiSeatProject(), mockPlatform, paperById() (+4 more)

### Community 104 - "Community 104"
Cohesion: 0.14
Nodes (8): batchGates, BIG, config, mockPlatform, OTHER, saveGates, saves, SMALL

### Community 105 - "Community 105"
Cohesion: 0.14
Nodes (7): handle, mockPlatform, project, renderedPages, schema, StubResizeObserver, textLayerCallbacks

### Community 106 - "Community 106"
Cohesion: 0.31
Nodes (7): openConsolidation(), st(), HANDLE, mockPlatform, paper(), projectText(), written

### Community 107 - "Community 107"
Cohesion: 0.32
Nodes (11): blank(), computeStringSimilarity(), levenshtein(), levenshteinRatio(), NO_EVIDENCE, normalizeText(), Sim, stringSimilarity() (+3 more)

### Community 108 - "Community 108"
Cohesion: 0.22
Nodes (11): ai(), calls, CHAT, configs, mockPlatform, openAll(), openOne(), project() (+3 more)

### Community 109 - "Community 109"
Cohesion: 0.19
Nodes (10): ai(), CHECK, FILL, HANDLE, mockLlm(), mockPlatform, PROJECT, reply() (+2 more)

### Community 110 - "Community 110"
Cohesion: 0.17
Nodes (13): Action, action(), About, CloseWindow, Emit, Fullscreen, Github, Minimize (+5 more)

### Community 111 - "Community 111"
Cohesion: 0.17
Nodes (5): fakePage1Annotations, fakePdfDoc, GENERIC_RECT, mockPlatform, MockResizeObserver

### Community 112 - "Community 112"
Cohesion: 0.18
Nodes (5): screeningProjectJson(), tree(), readAllConcurrently(), changedTargets(), StampedTarget

### Community 113 - "Community 113"
Cohesion: 0.27
Nodes (10): detectEntryBox(), detectNumericCitation(), EntryBox, findNumericReference(), Line, PreviewTextItem, runExtent(), runText() (+2 more)

### Community 114 - "Community 114"
Cohesion: 0.22
Nodes (6): app_set_dirty(), main(), os_info(), probe_auto(), focus_main(), State

### Community 115 - "Community 115"
Cohesion: 0.18
Nodes (5): StaleSaveError, clash, lastSaved(), mockPlatform, written

### Community 116 - "Community 116"
Cohesion: 0.20
Nodes (6): batchKey(), mockPlatform, nextPdfText, PROJECT, runAgentMock, st()

### Community 117 - "Community 117"
Cohesion: 0.20
Nodes (7): config, gate, head, mockPlatform, only(), papers, readPapers

### Community 118 - "Community 118"
Cohesion: 0.24
Nodes (9): claimsOf(), findingCE(), findingCM(), mockPlatform, st(), swappedProject(), swappedSchema, trapProject() (+1 more)

### Community 119 - "Community 119"
Cohesion: 0.22
Nodes (5): require, LOCATION, mockPlatform, picked, require

### Community 120 - "Community 120"
Cohesion: 0.22
Nodes (8): BASE, HW, localRuntime(), MODEL_PLAN, ollamaPlatform(), platform, RT_PLAN, saveLlmConfig

### Community 121 - "Community 121"
Cohesion: 0.20
Nodes (3): mockPlatform, MockResizeObserver, rect

### Community 122 - "Community 122"
Cohesion: 0.36
Nodes (9): BackIcon(), ForwardIcon(), IssueList(), JumpButton(), KIND_KEY, matchesQuery(), PaperFilter(), TargetIcon() (+1 more)

### Community 123 - "Community 123"
Cohesion: 0.31
Nodes (8): applyManagedBlock(), ATTRIBUTES_BODY, IGNORE_BODY, ManagedFileUpdate, planRepoSetup(), RepoSetupPlan, SETUP_AUTHOR, SETUP_COMMIT_MESSAGE

### Community 124 - "Community 124"
Cohesion: 0.22
Nodes (8): PdfMeta, PdfFolderScan, handle, meta, mockPlatform, open(), scan, st()

### Community 125 - "Community 125"
Cohesion: 0.27
Nodes (8): apply(), isMarked(), marks(), mockPlatform, PROJECT, saved, st(), TEST_USAGE

### Community 126 - "Community 126"
Cohesion: 0.22
Nodes (6): claimsOf(), mockPlatform, schema, st(), swapped, TEST_USAGE

### Community 127 - "Community 127"
Cohesion: 0.25
Nodes (8): client(), download_can_be_cancelled(), download_verifies_resumes_and_refuses(), fetch(), local_cancel(), Progress, temp_dir(), builder()

### Community 129 - "Community 129"
Cohesion: 0.50
Nodes (5): DescriptionPopover(), findSingleLink(), NodeName(), LinkifySegment, linkifyText()

### Community 130 - "Community 130"
Cohesion: 0.22
Nodes (3): mockPlatform, MockResizeObserver, zeroRect

### Community 131 - "Community 131"
Cohesion: 0.39
Nodes (7): agreedValue(), fillsOf(), setup(), SIMPLE, tidy(), unanimousFills(), walk()

### Community 132 - "Community 132"
Cohesion: 0.31
Nodes (7): BACKGROUND_FETCH_INTERVAL_MS, BACKGROUND_FETCH_TIMEOUT_MS, backgroundFetchAllowed(), FETCH_COMMAND_KEYS, NON_INTERACTIVE_ENV, git(), localCommandKeys()

### Community 134 - "Community 134"
Cohesion: 0.32
Nodes (5): deriveGitInfo(), GitInfoInputs, GitInfoResult, out(), fail

### Community 135 - "Community 135"
Cohesion: 0.29
Nodes (6): config, handle, mockPlatform, onDisk, relevant(), st()

### Community 136 - "Community 136"
Cohesion: 0.43
Nodes (3): pump(), ring_log_keeps_the_last_lines(), RingLog

### Community 137 - "Community 137"
Cohesion: 0.33
Nodes (3): load(), mockPlatform, st()

### Community 138 - "Community 138"
Cohesion: 0.52
Nodes (5): annotatedFileName(), PdfRectPoints, rectToPdfPoints(), rectToQuadPoints(), MarkRect

### Community 139 - "Community 139"
Cohesion: 0.33
Nodes (5): es(), mockPlatform, PROJECT, saved, uidOf()

### Community 140 - "Community 140"
Cohesion: 0.33
Nodes (5): defOf(), mockPlatform, rect, schema, st()

### Community 141 - "Community 141"
Cohesion: 0.29
Nodes (4): collisionCalls, folderUsers, mockPlatform, PROJECT

### Community 142 - "Community 142"
Cohesion: 0.47
Nodes (4): fiveStateProject(), projectJson(), SCHEMA, twoModeProject()

### Community 144 - "Community 144"
Cohesion: 0.33
Nodes (5): mockPlatform, reset(), compactVisibleIf(), cleanVisibleIf(), toAnnotationDefs()

### Community 145 - "Community 145"
Cohesion: 0.33
Nodes (4): ANNA, AXEL, mockPlatform, PROJECT

### Community 147 - "Community 147"
Cohesion: 0.33
Nodes (3): FixturePaper, LOCATION, mockPlatform

### Community 149 - "Community 149"
Cohesion: 0.40
Nodes (4): equalOf(), mockPlatform, schema, st()

### Community 154 - "Community 154"
Cohesion: 0.70
Nodes (3): hasControlChar(), RefProblem, refProblem()

### Community 155 - "Community 155"
Cohesion: 0.60
Nodes (4): findings(), PROJECT, st(), studyType()

### Community 157 - "Community 157"
Cohesion: 0.40
Nodes (5): build_server_args(), digits(), explain_start_failure(), parse_server_log(), server_flags_and_logs()

### Community 158 - "Community 158"
Cohesion: 0.50
Nodes (3): CFG, mockPlatform, PROJECT

### Community 159 - "Community 159"
Cohesion: 0.83
Nodes (3): openOnStudyType(), projectJson(), st()

## Knowledge Gaps
- **21 isolated node(s):** `sailor`, `Save`, `Discard`, `Cancel`, `Stay` (+16 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1486 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `t()` connect `AI Dialog` to `Community 129`, `Prompt Overrides & Fewshot`, `Run Feedback`, `Community 135`, `App Shell & Dialogs`, `Graph Canvas`, `Annotation Panel & AI Disclosure`, `Merge Logic`, `AI Eval & Export Dialogs`, `Hostile-input Tests`, `Chat Response Parsing`, `Split Rows & Metadata`, `Diagram View`, `Paper List`, `Token Budget`, `Papers Editor`, `Screening Panel`, `Toolbar & Zustand`, `Community 41`, `Community 42`, `Community 43`, `Community 44`, `Community 45`, `Community 46`, `Community 47`, `Community 48`, `Community 51`, `Community 56`, `Community 57`, `Community 59`, `Community 61`, `Community 63`, `Community 66`, `Community 67`, `Community 72`, `Community 79`, `Community 88`, `Community 89`, `Community 95`, `Community 96`, `Community 100`, `Community 122`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **What connects `sailor`, `Save`, `Discard` to the rest of the system?**
  _21 weakly-connected nodes found - possible missing edges._
- **Should `Rust Project Core` be split into smaller, more focused modules?**
  _Cohesion score 0.04500381388253242 - nodes in this community are weakly interconnected._
- **Why does `SlrBridge` connect `Git Repo Setup` to `Git Branch/Pull Ops`, `Agent Deps & LLM Plan`, `Community 100`, `Toolbar & Zustand`, `Legacy Project Split`, `Community 146`, `Community 52`, `Community 56`, `Close Guard`, `Community 60`, `Community 94`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `Rust Docs/Builders` be split into smaller, more focused modules?**
  _Cohesion score 0.05215419501133787 - nodes in this community are weakly interconnected._
- **Why does `GitPlatform` connect `Community 52` to `Git Branch/Pull Ops`, `Test Fixtures & Libs`, `Toolbar & Zustand`, `CI Scripts`, `Community 56`, `Close Guard`, `Desktop Adapter & PDFs`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Should `Test Fixtures & Libs` be split into smaller, more focused modules?**
  _Cohesion score 0.04151404151404151 - nodes in this community are weakly interconnected._