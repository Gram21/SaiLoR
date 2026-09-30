# Requirements — LLM-Assisted Annotation

Requirements for the AI-assisted annotation feature, a core feature that proposes
annotation values from a paper's content and that projects can individually opt out of.
See the [index](index.md) for the glossary.

---

### REQ-LLM-10 — Support multiple LLM providers
- **Description:** The system shall send annotation-suggestion requests to any of nine provider APIs: Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, and generic OpenAI-compatible servers.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/providers.ts:55-157`, `src/llm/types.ts:12-21`
- **Status:** Implemented

### REQ-LLM-20 — Fixed base URLs for named providers
- **Description:** The system shall use a fixed base URL for each named provider and shall permit base-URL editing only for the OpenAI-compatible provider type.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/providers.ts:22,60,146`, `src/components/LlmSettingsDialog.tsx:423`
- **Status:** Implemented

### REQ-LLM-30 — Manage a library of named models
- **Description:** The system shall store a library of named LLM models ("AI models"), each consisting of a name, provider, base URL, model, attachment mode, and optional reasoning effort, with create, edit, and delete operations, where delete requires a second confirming activation. This library is configured once (in the "AI models" settings dialog) and is independent of assigning its entries to annotation roles.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/types.ts:27-62`, `src/components/LlmSettingsDialog.tsx:105-110,285-293,378-387`
- **Status:** Implemented

### REQ-LLM-40 — Keep API keys out of the user interface layer
- **Description:** The system shall store API keys only in the main process, expose to the user interface layer only a flag stating whether a key is stored, and substitute the real key for a placeholder immediately before sending a request.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/llm/types.ts:4-10,86`, `electron/main.ts:1417,1447-1450,1536-1539`
- **Status:** Implemented

### REQ-LLM-50 — Encrypt stored API keys
- **Description:** The system shall store API keys encrypted with the operating system's secure storage in a configuration file restricted to owner read/write, and shall refuse to save a key when secure storage is unavailable.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1408-1464`
- **Status:** Implemented

### REQ-LLM-60 — Restrict key transmission
- **Description:** The system shall attach the API key only to requests whose URL uses http or https, matches the configured base URL's protocol and origin, and shall refuse HTTP redirects on key-carrying requests.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/main.ts:1519-1534,1551-1566`
- **Status:** Implemented

### REQ-LLM-70 — Bound LLM call duration
- **Description:** The system shall terminate an LLM request that has not completed within 10 minutes and shall allow the user to abort an in-flight request at any time.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `electron/main.ts:1488-1500,1549`, commit `98796c1`
- **Status:** Implemented

### REQ-LLM-80 — Honor project-level AI opt-out
- **Description:** When a project's configuration sets `ai` to false, the system shall not offer the AI feature for that project.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:683`, `src/components/Toolbar.tsx:96-112,188`, `src/state/aiStore.ts:139`
- **Status:** Implemented

### REQ-LLM-90 — Restrict AI to numbered reviewer seats
- **Description:** The system shall reject AI annotation on the Consolidation seat, and on multi-reviewer projects with no seat selected. Screening projects are no longer rejected: they use their own AI screening flow (REQ-LLM-630), which follows the same seat rules.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:167-169`, `src/state/store.ts:2318-2337`
- **Status:** Implemented

### REQ-LLM-100 — Ask only about unanswered fields
- **Description:** When an AI run starts, the system shall request values only for the currently unanswered fields of each paper it annotates (the current paper alone, or every candidate paper in all-papers mode, each asked only about its own unanswered fields), where a boolean field counts as unanswered unless it is true.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/fields.ts:21-75`, `src/state/aiStore.ts` (`run`, `batchCandidates`)
- **Status:** Implemented

### REQ-LLM-110 — Deliver the paper as text or PDF
- **Description:** The system shall deliver the paper to the provider either as text extracted from the PDF or as the PDF file itself for providers that accept documents (Anthropic, OpenAI, Google, OpenRouter), falling back to extracted text when a PDF-configured target's provider cannot accept documents.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/providers.ts:61-156,230-264`, `src/state/aiStore.ts:375-418`
- **Status:** Implemented

### REQ-LLM-120 — Refuse text delivery of image-only PDFs
- **Description:** When text extraction from the PDF yields no body text, the system shall abort a text-delivery run with an error advising PDF delivery, without sending a request.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:388-400`, `src/model/pdfText.ts:106-152`
- **Status:** Implemented

### REQ-LLM-130 — Anti-hallucination prompt rules
- **Description:** The system shall instruct the model to take values only from the paper, to omit fields it cannot answer, to supply a verbatim supporting quote of at most 200 characters per value, and to copy enum values verbatim.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/prompt.ts:150-165`
- **Status:** Implemented

### REQ-LLM-140 — Flatten schema text in prompts
- **Description:** When embedding schema-supplied names, descriptions, or options in the prompt, the system shall flatten each string to a single line so that project-authored content cannot forge prompt structure.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/llm/prompt.ts:77-93`, commit `30a7ecf`
- **Status:** Implemented

### REQ-LLM-150 — Bind replies to their run
- **Description:** The system shall record the paper, reviewer seat, provider, and model at run start and shall refuse to apply a reply to any paper or seat other than the one it was requested for.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:87,340-347`, `src/state/store.ai.test.ts:431-461`, commit `c56d6ab`
- **Status:** Implemented

### REQ-LLM-160 — Discard superseded runs
- **Description:** When an AI run is cancelled or superseded by a newer run, the system shall discard its answer or error without altering the newer run's state.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:355-482`, commit `e6f534a`
- **Status:** Implemented

### REQ-LLM-170 — Validate every suggestion against the schema
- **Description:** When parsing a model reply, the system shall accept a suggestion only when its value type-checks against the target field's definition, and shall list each rejected suggestion with a reason (unknown field, duplicate, missing value, type mismatch, empty value, disallowed enum value, or implausible year).
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/parse.ts:7-23,256-324`
- **Status:** Implemented

### REQ-LLM-180 — Accept only unambiguous coercions
- **Description:** When a suggested value's type differs from the field type, the system shall coerce only values with a single honest reading (strict decimal string to number, case-insensitive "true"/"false" to boolean, case/whitespace-normalized enum labels) and shall reject anything fuzzier.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/parse.ts:124-183`
- **Status:** Implemented

### REQ-LLM-190 — Tolerant reply extraction
- **Description:** When a model reply wraps its JSON in prose or code fences, the system shall extract the JSON object without failing, and shall report an unparseable reply as an error rather than applying anything.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/parse.ts:28-116`
- **Status:** Implemented

### REQ-LLM-200 — Cap repeatable indices from the model
- **Description:** When a suggestion addresses an instance index of an unbounded repeatable node, the system shall reject indices above 10,000.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src/llm/paths.ts:224-246`, `src/llm/parse.ts:276`
- **Status:** Implemented

### REQ-LLM-210 — Human review before applying
- **Description:** The system shall present accepted suggestions in a review table showing field, value, supporting quote, and confidence — grouped by paper with a header row when more than one paper is being reviewed — with per-row checkboxes and select-all/none, and shall write values only when the user applies the selection. Each row shall also offer an Edit affordance (REQ-LLM-580) and a toggle to show only rows that need attention.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/AiDialog.tsx` (`ReviewTable`), `src/state/aiStore.ts` (`toggleRow`, `setAllRows`, `editRow`, `apply`)
- **Status:** Implemented

### REQ-LLM-220 — Apply as one undo step without overwriting
- **Description:** When applying checked suggestions, the system shall write them as a single undo step across however many papers the run touched, skipping any field the reviewer answered in the meantime and any path that no longer resolves, and shall record no undo entry when nothing was written. A row the reviewer edited (REQ-LLM-580) shall write the edited value, not the model's original proposal.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts` (`applyAiSuggestions`, `applyAiSuggestionsBatch`), `src/state/store.ai.test.ts:142-251`
- **Status:** Implemented

### REQ-LLM-230 — Mark AI-written fields until confirmed
- **Description:** The system shall visually mark each AI-written field, scoped to paper and reviewer seat, until the reviewer interacts with the field, and shall never persist these marks to the project file.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:107-124,2436-2445`, `src/state/store.aimarks.test.ts`
- **Status:** Implemented

### REQ-LLM-240 — Record durable AI-usage disclosure
- **Description:** When an apply changes at least one field, the system shall append a record of provider, model, and timestamp to the paper's AI-usage list in the project file, using the provider and model of the run that produced the answer, together with whichever of the run's mode (prompt/agent), judge provider/model, round count, applied-verdict counts, few-shot example count, edited-row count (REQ-LLM-580), and target reviewer seat are known, omitting any that are not; on load the system shall keep the base record and drop only a malformed optional field. Verdict counts reflect only the suggestions the reviewer actually applied (checked), not every value the agent proposed; `judge`/`rounds` are the judge target/round count actually used for that paper. The field is recorded as AI-assisted regardless of whether the reviewer edited its value before applying.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts:2419-2427`, `src/model/project.ts:37-59,420-452` (`AiUsageRecord.edited`, `parseAiUsage`), `src/state/aiStore.ts` (`apply`, `editRow`, `runJudge`, `roundsByPaper`), `src/state/store.ai.test.ts:364-429`, `src/state/aiStore.judge.test.ts` (disclosure-fields tests), `src/state/aiStore.edit.test.ts`, `src/model/model.test.ts` (edited round-trip), `src/components/AiUsageDisclosure.tsx`
- **Status:** Implemented

### REQ-LLM-250 — List provider models
- **Description:** When a target with a stored key requests its model list, the system shall query the provider's list-models endpoint with provider-specific pagination up to 10 pages, cache the result per target for one hour, and bypass the cache on explicit refresh.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/models.ts:92-174`, `src/state/aiStore.ts:35-46,277-325`
- **Status:** Implemented

### REQ-LLM-260 — Constrain pagination cursors
- **Description:** When following a provider-supplied pagination cursor, the system shall reject cursors that resolve outside the configured base URL's origin.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/llm/models.ts:96-157`
- **Status:** Implemented

### REQ-LLM-270 — Free-text model selection
- **Description:** The system shall accept any typed model name, offer fetched model names as searchable suggestions, and flag a typed name only when a fetched list exists and does not contain it.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/ModelPicker.tsx:16-28,115-118`
- **Status:** Implemented

### REQ-LLM-280 — Per-provider reasoning effort
- **Description:** When a reasoning effort is configured for a model that reports or matches reasoning capability, the system shall translate the effort into the provider's specific request parameter.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/providers.ts:266-366`, `src/llm/models.ts:14-90,246-257`
- **Status:** Implemented

### REQ-LLM-290 — Verify target setup
- **Description:** When "Verify setup" is triggered on a saved target, the system shall send a minimal test request and display the model's reply verbatim on success or the provider's error message on failure, distinguishing a reply truncated by internal reasoning.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:26-32,233-271`, `src/components/LlmSettingsDialog.tsx:239-262,563-588`
- **Status:** Implemented

### REQ-LLM-300 — Report run progress
- **Description:** During an AI run, the system shall display the current phase (setup, reading, calling, parsing, review, applied, or error) with a live elapsed-time counter and a cancel action; when annotating more than one paper it shall also show which paper of how many is in progress and its title, and in agent mode the most recent progress messages for that paper.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`AiPhase`, `run`), `src/components/AiDialog.tsx` (running-phase block)
- **Status:** Implemented

### REQ-LLM-310 — Distinguish truncation from empty answers
- **Description:** When a reply is empty and the provider reports a token-limit finish reason, the system shall report that the model spent its budget on internal reasoning, distinct from the model proposing nothing.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/providers.ts:421-446`, `src/state/aiStore.ts:260-268,431-437`
- **Status:** Implemented

### REQ-LLM-320 — AI entry point in the toolbar
- **Description:** The system shall offer the AI-assisted annotation feature as an always-rendered toolbar button, disabled with an honest reason when no project is open, the project is busy, the project editor is open, the project is a screening project, the Consolidation seat is selected, a multi-reviewer project has no reviewer picked, or the project's configuration turns AI off.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/components/Toolbar.tsx:91-114,354-360`, `src/components/Toolbar.test.ts`
- **Status:** Implemented

### REQ-LLM-330 — Agent-mode tool set
- **Description:** The system shall let the agent-mode model call tools to search the paper's extracted text, read a page range of it, search OpenAlex and Crossref for bibliographic metadata, and fetch a public web page as readable text, validating each tool's arguments and returning an error string instead of throwing on malformed input.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/tools.ts:1-350`, `src/llm/chat.ts:1-330`
- **Status:** Implemented

### REQ-LLM-340 — Verify agent-mode evidence before the judge sees it
- **Description:** Before an agent-mode submission reaches the judge, the system shall validate every value against the schema and, for a paper-sourced value, verify that its evidence quote is found in the extracted paper text (tolerating case, whitespace, hyphenation, ligatures and quote-mark differences), and shall reject a web-sourced value whose declared source URL was not fetched during the run.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/verify.ts:1-140`
- **Status:** Implemented

### REQ-LLM-350 — Bounded judge review loop
- **Description:** In agent mode, the system shall submit new or changed proposed values to a separate judge call that returns an accept/revise/reject verdict with feedback per value plus any target fields the paper answers but the agent left empty, feed that feedback back to the agent for another round, and stop after the judge accepts everything and nothing is missing, after the agent's submission stops changing, or after a bounded number of rounds, whichever comes first.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/agent.ts:1-360`, `src/llm/judge.ts:1-210`
- **Status:** Implemented

### REQ-LLM-360 — Treat fetched web content as untrusted data
- **Description:** When the agent-mode `fetch_url` tool returns a fetched page's text, the system shall wrap it in a clear untrusted-content delimiter and instruct the model, in the system prompt, to treat it only as data to extract from and never as instructions to follow.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `src/llm/tools.ts` (`fetchUrl`), `src/llm/prompt.ts` (`buildAgentSystemPrompt`)
- **Status:** Implemented

### REQ-LLM-370 — Per-run token and call accounting
- **Description:** The system shall accumulate, across every agent- and judge-model call of one agent-mode run, the total input tokens, output tokens, and number of calls, and report them alongside the number of rounds run.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/agent.ts` (`AgentResult.usage`)
- **Status:** Implemented

### REQ-LLM-400 — Restrict agent web access to public hosts
- **Description:** When the AI agent fetches a URL, the system shall allow only `http`/`https` URLs without embedded credentials, resolve the hostname (or literal IP) and refuse the request if any resolved address is loopback, private, link-local, CGNAT, unique-local, multicast, or otherwise non-public, re-check the same rules on each of up to 5 manually-followed redirects, send no cookies or credentials, enforce a 20-second timeout and a 2 MB response body cap, and accept only textual content types.
- **Type:** Non-functional (ISO 25010: Security)
- **Evidence:** `electron/webFetch.ts:1-83`, `electron/main.ts` (`web:fetch`/`web:abort` handlers), `electron/webFetch.test.ts`
- **Status:** Implemented

### REQ-LLM-380 — Switch between prompt and agent mode
- **Description:** The setup screen shall let the user choose between "Prompt" (one request per paper) and "Agent" (tool-using, judge-reviewed) mode, persist the choice like the selected target, and show, next to the switch, an explanation of each mode's behavior and a statement that agent mode takes considerably longer and costs considerably more (typically 5–15 model requests per paper instead of one). In agent mode the system shall extract the paper's text even when the target's delivery setting sends the PDF itself, since the tools and evidence check need it; a scanned PDF under text delivery shall fail with the same error prompt mode gives.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`AiMode`, `setMode`, `runOnePaperAgent`), `src/components/AiDialog.tsx` (`MODE_INFO`)
- **Status:** Implemented

### REQ-LLM-390 — Annotate all papers only after a consequences warning
- **Description:** The setup screen shall state that only the current paper is annotated by default, and shall offer a switch to annotate every eligible paper instead — one with a PDF, not finished for the target seat, and with at least one unanswered field. Turning the switch on shall first show, inline, the number of papers that will be sent, that each paper is a separate request (many per paper in agent mode), that the provider charges the user's API key per request and cost scales with the paper count (higher still in agent mode), a rough time estimate, that every paper's content leaves the machine, and that the run can be cancelled at any time keeping whatever finished; the switch shall take effect only once this is confirmed, and the warning shall stay accurate across a later mode switch. All-papers mode shall also let the reviewer choose how many papers run at once (1-4, default 2, persisted), noting that more at once is faster but reaches the provider's rate limits sooner.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`batchCandidates`, `setAllPapers`, `concurrency`, `setConcurrency`), `src/components/AiDialog.tsx` (`allPapersWarning`, "Papers at once" select)
- **Status:** Implemented

### REQ-LLM-410 — Show judge verdicts and default flagged rows unticked
- **Description:** In agent-mode review, the system shall show each row's judge verdict (accepted, needs revision, or rejected) with its feedback text, and the source URL for a web-sourced value. A row whose verdict is not "accept" shall be unticked by default; every accepted agent-mode row shall be ticked by default. A prompt-mode row is ticked by default unless its reported confidence is below the reviewer-adjustable confidence threshold (REQ-LLM-580), in which case it starts unticked like a classify-mode or cross-check-flagged row; a prompt-mode row with no reported confidence stays ticked.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`run`, row `checked`/`flagged` initialization), `src/components/AiDialog.tsx` (`JudgeCell`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.edit.test.ts`

### REQ-LLM-420 — Report token usage after a run
- **Description:** After a run finishes, the system shall report the total number of model requests and the summed input/output tokens across every paper and every model call of the run (agent and judge calls alike), and shall omit the line when every count is zero.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`usage`, `runOnePaperPrompt`, `runOnePaperAgent`), `src/components/AiDialog.tsx` (`ai-usage`)
- **Status:** Implemented

### REQ-LLM-430 — Cost estimate from user-entered prices
- **Description:** The system shall let the reviewer enter an input and output price (USD per 1M tokens) on an LLM target, with no built-in provider price table, prefilled from the picked model's own reported pricing when available (OpenRouter) and the fields are still empty, and shall estimate a run's token usage and cost range (low/high) from the number of papers, pages per paper (fetched lazily via pdf.js and cached per paper for the session), fields to fill, and mode (prompt or agent, agent accounting for repeated tool-calling requests plus judge calls, split between the agent and judge targets when they differ), reporting no cost when a target has no price entered and labeling the figure a rough estimate.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/cost.ts` (`costOf`, `estimateRun`, `estimateCost`, `estimateCostSplit`), `src/llm/types.ts` (`LlmConfig.inputPrice`/`outputPrice`, `ModelInfo.pricing`), `src/llm/models.ts` (`parseOpenRouterModels`), `src/model/pdfText.ts` (`countPdfPages`), `src/state/aiStore.ts` (`ensurePageCounts`, `pageCounts`), `src/components/AiDialog.tsx` (`estimateLine`), `src/components/LlmSettingsDialog.tsx` (price fields, pricing prefill), `electron/main.ts` (`StoredLlmConfig.inputPrice`/`outputPrice`), `electron/llmConfig.ts` (`validPrice`)
- **Status:** Implemented
- **Tests:** `src/llm/cost.test.ts`, `src/components/LlmSettingsDialog.test.tsx`, `src/components/AiDialog.test.tsx`, `electron/llmConfig.test.ts`

### REQ-LLM-440 — Retry with backoff on rate limits/overload
- **Description:** When a model call fails with HTTP 429, 408, 500, 502, 503, 504, or 529, the system shall retry it with exponential backoff and jitter (capped, bounded number of retries), honoring the provider's `Retry-After` header when present, and shall not retry any other 4xx status; a pending retry wait shall abort immediately when the caller's signal aborts. Every model call an annotation run makes (prompt mode, agent mode, and judge calls) is wrapped this way; "Verify setup" and model listing are not. The system shall show a "Rate-limited, retrying in Ns…" progress notice while a retry is pending.
- **Type:** Non-functional (ISO 25010: Reliability)
- **Evidence:** `src/llm/retry.ts` (`withRetry`, `parseRetryAfter`, `runPool`, `RetryOptions.onRetry`), `electron/main.ts` (`llm:call` handler filling `retryAfterMs` via `parseRetryAfter`), `src/state/aiStore.ts` (`run` wrapping `getPlatform().callLlm` with `withRetry`, `retryNotice`), `src/components/AiDialog.tsx` (`ai-retry` notice)
- **Status:** Implemented
- **Tests:** `src/llm/retry.test.ts` (including `onRetry`), `src/state/aiStore.batch.test.ts`

### REQ-LLM-450 — Few-shot examples from finished papers
- **Description:** The system shall let the reviewer's already-finished papers be shown to the model as worked examples of the review's conventions (granularity, wording, enum choices): each example's title, truncated abstract, and answered fields as path/value lines, explicitly marked as illustration only — not evidence, and not to be copied into the current paper — placed in the prompt after the schema/field sections and before the rules, truncated by dropping whole trailing examples/fields rather than mid-line, and included in the agent's own system prompt only, never the judge's. A setup-screen toggle (off by default, persisted) turns this on and lets the reviewer choose how many examples to offer (1-5, default 2); the source is the Consolidation seat's finished papers in a multi-reviewer project with any finished there, else the current human seat's, ordered most-answered-fields-first, always excluding the AI's own seat and the paper being annotated. The applied count is recorded per paper in the usage disclosure, and the cost estimate accounts for the extra prompt tokens.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/fewshot.ts` (`buildFewShotBlock`, `pickFewShotExamples`, `countAnsweredFields`), `src/llm/prompt.ts` (`buildSystemPrompt`, `buildAgentSystemPrompt`), `src/llm/agent.ts` (`AgentInput.examples`), `src/state/aiStore.ts` (`fewShot`, `fewShotCount`, `fewShotCandidates`, `buildFewShotForPaper`, `fewShotByPaper`), `src/components/AiDialog.tsx` (few-shot toggle and count select, consent line)
- **Status:** Implemented
- **Tests:** `src/llm/fewshot.test.ts`, `src/state/aiStore.fewshot.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-460 — Jump from evidence to the PDF
- **Description:** In the AI review table, an evidence quote sourced from the paper itself (no `source`, or `source === 'paper'`) shall be clickable; a quote whose `source` is a URL shall not. Clicking it shall switch to that row's paper if it isn't already current, ask the PDF viewer to locate and highlight the quote, and hide the AI dialog (without discarding its review state) behind a "Back to AI review" button that restores it. The PDF viewer shall try the quote verbatim, then a lightly normalized form (straight quotes, no line-break hyphenation), then progressively shorter leading word sequences, retrying as pages finish rendering their text layer; if nothing matches within a few seconds it shall show a brief, dismissible notice instead of failing silently.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/store.ts` (`pdfFindRequest`, `requestPdfFind`, `clearPdfFindRequest`), `src/state/aiStore.ts` (`minimized`, `setMinimized`), `src/components/AiDialog.tsx` (`jumpToEvidence`, `isPaperEvidence`), `src/components/PdfViewer.tsx` (`findQuoteRanges`), `src/llm/verify.ts` (`normalize`)
- **Status:** Implemented

### REQ-LLM-470 — AI reviewer seat
- **Description:** In a multi-reviewer project with AI-assisted annotation allowed, the system shall offer a project setting dedicating the last configured reviewer seat to the AI, effective only while at least two reviewers are configured, AI is allowed, (screening projects included, see REQ-LLM-650); applied suggestions written to that seat shall be recorded and compared against the other reviewers exactly like any other seat, and shall never mark the seat's "finished" flag on their own. The system shall label that seat distinctly (e.g. "AI (Reviewer N)") everywhere a reviewer seat is named, and shall let a human reviewer select it to inspect or correct its answers, noting in the annotation panel that its values come from AI runs.
  When the project has an AI seat, every AI run — unanswered-field computation, "annotate all papers" candidates, the applied row's seat, and the apply step itself — targets that seat regardless of which seat the human reviewer currently has selected; the setup screen states this ("Answers go into the AI's own seat: AI (Reviewer N)"). The toolbar AI button is then not disabled for "no reviewer picked" or the Consolidation seat, since the run does not write into whichever of those is merely on screen. Without an AI seat, behavior is unchanged: the run targets whichever seat is currently selected, and both of those toolbar/apply refusals still apply.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts:265-289` (`aiSeatId`, `seatLabel`), `src/state/editorStore.ts`, `src/components/ProjectEditor.tsx`, `src/components/AnnotationPanel.tsx`, `src/components/Toolbar.tsx` (`aiButtonState`'s `hasAiSeat` parameter), `src/state/aiStore.ts` (`targetSeat`, `openDialog`, `batchCandidates`), `src/state/store.ts` (`applyAiSuggestionsBatch`'s AI-seat-only relaxation), `src/git/changes.ts`, `src/git/merge.ts`
- **Status:** Implemented
- **Tests:** `src/components/Toolbar.test.ts`, `src/state/aiStore.batch.test.ts`, `src/state/store.ai.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-480 — Separate judge model
- **Description:** In agent mode's Models section, the system shall let the reviewer pick a judge model independent of the annotator's own model, from the same library of configured models, with "Same as annotator (<name>)" as the first, default option; the choice shall persist per project (falling back to the last global choice, validated against the currently configured models on refresh, falling back to "same as annotator" if the stored choice no longer exists) and shall be passed to the agent run as a distinct judge config. The judge model's own API key shall be checked before the run starts, the same way the annotator model's is. When the picked judge model's provider differs from the annotator's, the run's consent line shall name it too, since the paper's evidence is sent there as well.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:950-954` (`selectJudge`), `src/state/aiStore.ts` (`judgeSelectedId`, `run`'s judge hasKey check, `runJudge`), `src/components/AiDialog.tsx:549-570` (judge `ComboBox` and price hint), `src/components/AiDialog.tsx:610-614` (consent line naming the judge), `src/llm/agent.ts` (`AgentInput.judgeConfig`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.judge.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-490 — Spending cap for all-papers runs
- **Description:** In all-papers mode, when both the agent target and the judge target (or the agent target alone in prompt mode) have prices set, the system shall let the reviewer set an optional spending cap (USD); after each paper the system shall add that paper's estimated cost (agent-portion priced against the agent target, judge-portion — agent mode only — against the judge target) to a running total, and once the total exceeds the cap it shall stop starting new papers while keeping whatever already finished (including any other paper already in flight alongside it, when running at a concurrency above 1), showing "Stopped at the spending limit ($X spent)" in the review screen. The running spend, and the run's actual total cost, shall be shown alongside the existing token-usage reporting whenever prices are known.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts` (`spendCap`, `setSpendCap`, `spentSoFar`, `spendCapHit`, `executeBatch`'s cap check), `src/components/AiDialog.tsx` (spend-cap input, `ai-cap-hit`, `ai-usage` cost line), `src/llm/cost.ts` (`costOf`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.judge.test.ts`

### REQ-LLM-500 — Parallel all-papers runs
- **Description:** In all-papers mode, the system shall run up to a reviewer-chosen number of papers at once (1-4, default 2, persisted), using one shared cancellation per batch run so that cancelling stops every paper still queued while letting any already in flight finish. A paper that errors shall be recorded and the batch shall continue past it, exactly as in the sequential case. While a batch runs, the system shall show how many papers have settled out of the total and the titles of whichever are currently in flight; agent-mode progress messages shall be tagged with which paper they are about, since more than one can be in flight together. A run superseded by a fresh one, or by a resumed continuation, shall never let any of its workers touch the newer run's state — every state write is guarded by the batch's own token, checked immediately before it.
- **Type:** Functional (ISO 25010: Functional Suitability, Performance Efficiency)
- **Evidence:** `src/llm/retry.ts` (`runPool`), `src/state/aiStore.ts` (`concurrency`, `setConcurrency`, `executeBatch`, `inFlightTitles`, `batchDone`), `src/components/AiDialog.tsx` ("Papers at once" select, in-flight progress line)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.resume.test.ts`, `src/state/aiStore.batch.test.ts`, `src/llm/retry.test.ts`

### REQ-LLM-510 — Resume an interrupted all-papers run
- **Description:** After every paper an all-papers batch finishes (successfully or with an error), the system shall persist the batch's progress — mode, targets, the full paper scope, which papers are done, accumulated usage/spend/rows/notes/errors, and per-paper rounds/few-shot counts — keyed by the project's save location (or title, when unsaved) and the target seat; a record whose serialized size would exceed roughly 2 MB shall drop its rows/notes/errors rather than grow unbounded, so a resume from it re-runs the whole original scope instead of just the missing tail. This record shall be cleared when the reviewer applies or discards the batch's results, and replaced outright by a fresh "annotate all papers" run. On opening the AI dialog, if a saved unfinished batch exists for the current project and target seat and its configured target still exists, the setup screen shall offer a banner stating how many of how many papers finished and when, with Resume and Discard actions; the review screen shall offer the same "Continue with the remaining N papers" action after a cancel or a spending-cap stop, before the reviewer has applied or discarded anything. Resuming shall restore the finished rows and continue only the remaining papers that are still candidates (recomputed against the project's current state, so a paper answered or finished by other means meanwhile is skipped) rather than restarting the whole batch.
- **Type:** Functional (ISO 25010: Reliability)
- **Evidence:** `src/state/aiStore.ts` (`PersistedBatch`, `persistBatch`, `readPersistedBatch`, `clearPersistedBatch`, `resumeBatch`, `resumeAvailable`, `discardBatch`, `dismissResume`), `src/components/AiDialog.tsx` (resume banner, "Continue with the remaining N papers")
- **Status:** Implemented
- **Tests:** `src/state/aiStore.resume.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-520 — System One decision models for choice and yes/no fields
- **Description:** For a boolean field or a single-valued enum field (2-255 options), the system shall be able to ask a "System 1" decision model (TypeSafe Jev, or a Jev-compatible local `laya-serve` server) for a typed, calibrated answer instead of a free-text extraction: a boolean question maps to a `noul` (P(true)) answer, an enum question maps to a `choice` answer with per-option probabilities and a confidence. The paper state sent to the model shall be truncated to a bounded size (derived from the model's configured context budget, marked when truncated), and only fields eligible in this way shall be asked. A returned answer below a minimum confidence, or a choice outside the field's options, shall be treated as unanswered rather than applied. The system shall also support cross-checking a generative model's proposed value for a field against System One's own answer for that field (boolean exact match, enum case-insensitive match), where the comparison's confidence always reflects System One's own confidence in its answer regardless of which side it agrees or disagrees with. A "Verify setup" on a System One model shall send one tiny `noul` question and show its `P(true) = 0.xx` reply.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/systemone.ts:20-27` (`systemOneEligible`), `src/llm/systemone.ts:85-145` (`buildSystemOneRequest`), `src/llm/systemone.ts:146-241` (`parseSystemOneResponse`), `src/llm/systemone.ts:249-268` (`SYSTEMONE_VERIFY_ASKED`, `buildSystemOneVerifyRequest`), `src/llm/systemone.ts:270-301` (`compareWithSystemOne`), `src/llm/providers.ts:132-146` (`PROVIDERS.systemone`), `src/components/LlmSettingsDialog.tsx:574-595` (Max input tokens field), `src/state/aiStore.ts:1585-1637` (`runOnePaperClassify`), `src/state/aiStore.ts:1644-1671` (`runCrossCheck`)
- **Status:** Implemented
- **Tests:** `src/llm/systemone.test.ts`, `src/state/aiStore.classify.test.ts`, `src/components/LlmSettingsDialog.test.tsx`

### REQ-LLM-530 — Keyless local targets
- **Description:** For an OpenAI-compatible target (or any future custom-base-URL provider), the system shall let the reviewer mark it as needing no API key. Such a target shall be usable — for a run, for "Verify setup", and as a judge — with no key stored, and the outbound request shall have any header built to carry a key (still containing the unsubstituted key placeholder) dropped rather than sent literally. A target with a stored key shall behave exactly as before regardless of this flag.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/types.ts` (`LlmConfig.noKey`, `isUsable`), `src/components/LlmSettingsDialog.tsx` (no-key checkbox), `electron/main.ts` (`llm:call`, `StoredLlmConfig.noKey`), `electron/llmConfig.ts` (`buildCallHeaders`)
- **Status:** Implemented
- **Tests:** `electron/llmConfig.test.ts`, `src/components/LlmSettingsDialog.test.tsx`

### REQ-LLM-540 — Role-based model assignment remembered per project
- **Description:** The setup screen shall assign library models (REQ-LLM-30) to three roles — Annotator (required), Judge (agent mode only, defaulting to "Same as annotator"), and Cross-check (optional, System-One-only) — rather than picking a single "target" for the whole run. Each role's choice shall be written both to a global fallback key and to a per-project record (keyed by the project's save location or title, and independent for each of these roles); opening the AI dialog shall apply the current project's own remembered role over the global fallback whenever the remembered model still exists among the configured library, and shall fall back to the global choice (or nothing) otherwise. Switching mode to or from Classify shall clear the annotator selection when it belongs to the wrong model family (a System One decision model vs. a chat/agent model), since the two are not interchangeable.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:463-487` (`StoredRoles`, `rolesStorageKey`, `readProjectRoles`, `writeProjectRole`), `src/state/aiStore.ts:889-906` (`openDialog` applying remembered roles), `src/state/aiStore.ts:921-926,950-961` (`selectConfig`, `selectJudge`, `selectCrossCheck` writing both keys), `src/state/aiStore.ts:927-939` (`setMode` clearing a wrong-family annotator), `src/components/AiDialog.tsx:526-591` (Models section: Annotator/Judge/Cross-check pickers)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.roles.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-550 — Classify mode
- **Description:** The setup screen shall offer a third mode, "Classify" (alongside Prompt and Agent), enabled only when at least one System One model is configured. In this mode the system shall send one `/v1/systemone` request per paper covering every unanswered field eligible for a System One answer (REQ-LLM-520); a field ineligible for Classify mode shall be reported as skipped with reason "not handled in Classify mode" rather than asked. Accepted rows shall carry `source: 'system-one'`, a `confidence` equal to the returned probability, and an evidence placeholder ("no quote (System One)") in place of a supporting quote. A row whose confidence is below a reviewer-adjustable threshold (default 0.8) shall start unticked in the review table. Classify mode shall work with all-papers mode, concurrency, the spending cap, resume, and token-usage accounting exactly like the other modes; it shall never also invoke the cross-check role (REQ-LLM-560), since both would ask the same model the same question.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:78` (`AiMode` including `'classify'`), `src/state/aiStore.ts:1585-1637` (`runOnePaperClassify`), `src/state/aiStore.ts:644-651` (dispatch to `runOnePaperClassify` and confidence-threshold row-checking), `src/components/AiDialog.tsx:484-520` (How section's Classify radio, disabled without a System One model), `src/model/project.ts:47` (`AiUsageRecord.mode` extended to include `'classify'`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.classify.test.ts`, `src/components/AiDialog.test.tsx`

### REQ-LLM-560 — System One cross-check
- **Description:** After a prompt- or agent-mode paper's suggestions are in hand, the setup screen shall optionally let the reviewer assign a System One model to a "Cross-check" role; when assigned, the system shall ask that model the same eligible fields the run just proposed values for and compare each via `compareWithSystemOne` (REQ-LLM-520). The review table shall gain a "Cross-check" column showing either agreement (a checkmark with the probability) or disagreement (naming the classifier's own value and its probability); a disagreement at or above the reviewer-adjustable confidence threshold shall start that row unticked. A cross-check call failure shall be recorded as a skipped-reason note tagged "(cross-check)" and shall never fail the paper it was checking. Cross-check's token usage and cost shall be folded into the run's totals. Cross-check is never offered, and never consulted, in Classify mode.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/state/aiStore.ts:1644-1671` (`runCrossCheck`), `src/state/aiStore.ts:668-694` (dispatch, agreement/disagreement row-checking), `src/components/AiDialog.tsx:571-591` (Cross-check role picker), `src/components/AiDialog.tsx:1008,1078-1090` (review table's "Cross-check" column), `src/llm/systemone.ts:270-301` (`compareWithSystemOne`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.classify.test.ts`, `src/llm/systemone.test.ts`

### REQ-LLM-570 — Show the AI-usage disclosure per paper
- **Description:** For the current paper, the annotation panel header shall show a compact, unobtrusive disclosure line ("✦ AI-assisted (N×)") whenever `Paper.aiUsage` has at least one record relevant to the current seat — a record with no `reviewer` field, or one whose `reviewer` matches the current seat; the Consolidation seat shall see every record regardless of `reviewer`. The line shall be absent when there is nothing relevant to disclose. It shall expand (native `<details>`) into one line per record: applied-at date/time, mode (rendered as-is for any string, so a future mode value degrades gracefully rather than breaking), provider · model, judge provider · model (agent mode only), rounds, verdict counts, number of few-shot examples used, and the seat (via `seatLabel`) — so a reviewer or consolidator can see how a paper's values were produced. Provider ids shall be rendered through `PROVIDERS`' display labels where the id is recognized, else shown as the raw id.
- **Type:** Functional (ISO 25010: Functional Suitability, Usability — Operability)
- **Evidence:** `src/components/AiUsageDisclosure.tsx`, `src/components/AnnotationPanel.tsx` (`relevantAiUsage`)
- **Status:** Implemented
- **Tests:** `src/components/AiUsageDisclosure.test.tsx`, `src/components/AnnotationPanel.test.tsx`

### REQ-LLM-580 — Edit proposals before applying
- **Description:** In the review table, each row shall offer an Edit affordance that reveals an input matching the field's type (free text, number, year, boolean checkbox, or an enum dropdown built from the field's options), validated with the same coercion rules `parseAnswer` applies to a model's own answer (`coerce` in `src/llm/parse.ts`, shared rather than duplicated); an invalid edit shows the rejection reason inline and leaves the row unedited. Saving a valid edit ticks the row, marks it `edited`, and keeps the original AI-proposed value visible next to the edited one ("AI proposed: X"); Cancel discards the in-progress edit. Applying an edited row writes the edited value, not the model's, but still records the field as AI-assisted (REQ-LLM-240) and counts it in the usage record's `edited` total.
  A row whose confidence is below the existing confidence threshold (Options; previously used only for Classify mode and cross-check) shall start unticked in prompt mode too, same as it already does in Classify mode; a row with no reported confidence stays ticked. Whichever reason a row started unticked for (low confidence, a non-accept judge verdict, or a confident cross-check disagreement) is remembered as `flagged`, independent of the reviewer later re-ticking it. The review header states how many rows started unticked and why, and offers a "Show only rows that need attention" toggle that filters the table to rows that are still unticked or were flagged.
- **Type:** Functional (ISO 25010: Functional Suitability, Usability — Operability)
- **Evidence:** `src/llm/parse.ts` (`coerce`, exported), `src/state/aiStore.ts` (`ReviewRow.edited`/`editedValue`/`flagged`, `editRow`, `apply`, prompt-mode `rowChecked`), `src/components/AiDialog.tsx` (`EditControl`, `ReviewTable`'s edit UI, attention-only filter and header note), `src/model/project.ts` (`AiUsageRecord.edited`), `src/components/AiUsageDisclosure.tsx`
- **Status:** Implemented
- **Tests:** `src/state/aiStore.edit.test.ts`, `src/components/AiDialog.test.tsx`, `src/components/AiUsageDisclosure.test.tsx`, `src/model/model.test.ts`

### REQ-LLM-590 — Skip one paper during an all-papers run
- **Description:** While an all-papers batch is running, each in-flight paper's title shall be shown with its own Skip action that aborts only that paper's model calls (a per-paper `AbortController` layered on the batch's own, so the rest of the batch — including any other paper already in flight — is unaffected) and records it in a distinct "skipped" list rather than as an error. A skipped paper is not added to the batch's `doneIds`, so it remains a candidate for a later "annotate all papers" run or for resuming the same batch (REQ-LLM-510), same as a paper that was still in flight when the whole batch was cancelled. Skipping one paper never counts as a failure and never aborts the batch's own cancellation signal.
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/state/aiStore.ts` (`skipPaper`, `paperControllers`, `combinedSignal`, `PaperSkip`, `skippedPapers`, `executeBatch`'s per-paper controller and catch-block skip branch), `src/components/AiDialog.tsx` (per-in-flight-paper Skip button, `SkippedPapers`)
- **Status:** Implemented
- **Tests:** `src/state/aiStore.edit.test.ts`

### REQ-LLM-600 — Collect schema remarks and per-field outcomes as feedback
- **Description:** In the same run (no extra LLM call), the model may optionally report up to 5 `schema_remarks` (`path`, `issue`, `suggestion`) where a field's name, description or options were ambiguous, contradictory or incomplete; the prompt, recheck and agent prompts state this rule, and agent mode's `submit_annotations` carries the array (the last submission's remarks are kept). Remarks are parsed tolerantly (`parseSchemaRemarks`): only paths that resolve in the schema or are known field names survive, text is flattened to one line and capped at 300 characters, and parsing never fails because of them. `buildRunFeedback` aggregates what happened to the proposals per field (applied, unticked, edited, left empty, rejected, judge verdicts, cross-check disagreements, up to 10 truncated edits, remarks deduplicated with counts), sorted most troublesome first, with no paper text or evidence quotes. `feedbackFileName` yields a filesystem-safe name; `hasFeedbackWorthSaving` is false for runs of clean applies without remarks. The AI dialog saves the aggregate as a JSON file per run (REQ-LLM-680); the remarks travel with the run state per paper (fill, agent and re-check replies).
- **Type:** Functional (ISO 25010: Functional Suitability, Maintainability)
- **Evidence:** `src/llm/types.ts` (`SchemaRemark`), `src/llm/parse.ts` (`parseSchemaRemarks`), `src/llm/prompt.ts` (`SCHEMA_REMARKS_RULE`), `src/llm/tools.ts` (`submit_annotations`, `parseSubmitArgs`), `src/llm/agent.ts`, `src/llm/feedback.ts`, `src/state/aiStore.ts` (`remarks`, `writeFeedback`)
- **Status:** Implemented
- **Tests:** `src/llm/feedback.test.ts`, `src/llm/parse.test.ts`, `src/llm/tools.test.ts`, `src/llm/agent.test.ts`, `src/llm/prompt.remarks.test.ts`

### REQ-LLM-610 — Re-check already-filled fields
- **Description:** An optional mode shall let the AI double-check values a reviewer already entered. `answeredFields` lists the filled fields (the complement of `unansweredFields`; booleans count only when true). The model returns one verdict per field: `agree`, `disagree` (requires a `proposed` value valid for the field and a verbatim supporting quote) or `unsure` (the safe default); it must never disagree from outside knowledge. `parseRecheckReply` accepts only asked paths, drops duplicates, and downgrades a `disagree` with no quote, an invalid `proposed`, or a `proposed` equal to the current value to `unsure` with the reason noted. A disagreement is only a proposal; it is never applied without the reviewer's approval. The dialog exposes this as an opt-in option (REQ-LLM-660).
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/llm/recheck.ts`, `src/llm/fields.ts` (`fieldTargets`), `src/state/aiStore.ts` (`runOnePaperPrompt`)
- **Status:** Implemented
- **Tests:** `src/llm/recheck.test.ts`

### REQ-LLM-620 — Provider-native web search (optional, agent mode)
- **Description:** `AgentInput.webSearch` (default off) shall, when the annotator's provider has `supportsWebSearch`, enable that provider's built-in web search in every agent request, in addition to the function tools; unsupported providers ignore the flag. Per-provider decisions (docs checked 2026-09): Anthropic supported via server tool `web_search_20250305` with `max_uses: 5` (basic version, no code-execution sidecar; https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool); OpenRouter supported via plugin `{id:'web', max_results:5}`, citations as `url_citation` annotations (https://openrouter.ai/docs/guides/features/plugins/web-search); Google not supported — `google_search` combined with function calling is documented only for Gemini 3 in the Interactions API, not the `generateContent` path used here (https://ai.google.dev/gemini-api/docs/tool-combination); OpenAI not supported — the `web_search` tool needs the Responses API, Chat Completions offers only dedicated search models (https://developers.openai.com/api/docs/guides/tools-web-search), a known ceiling; groq, mistral, deepseek, xai, openai-compatible, System One have no equivalent. The response parser shall report `webSearches`, `citations` (all result/citation URLs) and `paused` (Anthropic `pause_turn`); a paused turn shall be replayed verbatim (`ChatMessage.raw`, including encrypted search content) and continued within the existing iteration budget. `AgentResult.usage.webSearches` shall count searches and an agent event "Searching the web…" shall be emitted. A web-sourced value's `source` shall be a URL in fetched ∪ search-result URLs (compared without fragment/trailing slash), else it fails the deterministic check; a value backed only by a search result cannot have its quote checked, so it shall carry `Suggestion.webUnverified` and the judge shall be told to judge it conservatively (`revise` if not corroborated by the paper). The agent prompt gains a web-search rule only when the flag is on. `estimateRun` accepts `webSearch` (documented heuristic: input +10%/+30%, +1/+3 requests) and `WEB_SEARCH_NOTE` states that searches are billed on top of tokens. The dialog exposes the flag (REQ-LLM-670).
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/llm/chat.ts` (`buildChatRequest` `webSearch`, `parseChatResponse`), `src/llm/providers.ts` (`supportsWebSearch`), `src/llm/agent.ts` (`AgentInput.webSearch`, pause handling, `searchResultUrls`), `src/llm/verify.ts` (`normalizeUrl`, `checkSubmission`), `src/llm/judge.ts` (`JudgeProposal.webUnverified`), `src/llm/prompt.ts` (`buildAgentSystemPrompt`), `src/llm/cost.ts` (`WEB_SEARCH_NOTE`), `src/state/aiStore.ts` (`runOnePaperAgent`)
- **Status:** Implemented
- **Tests:** `src/llm/websearch.test.ts`

### REQ-LLM-630 — AI-assisted screening proposals
- **Description:** In a screening project the toolbar AI button shall open a separate AI screening dialog (own store, `useAiScreeningStore`), subject to the usual disabling rules (no project, Consolidation seat without an AI seat, no reviewer picked, project opt-out). Scope is the current paper (default) or, after a consequences warning (N papers, one request per paper, cost on the user's API key scales with N, data leaves the machine, cancel any time and keep finished papers), every paper that has a title and no decision in the target seat. Two engines: Prompt (a chat model; one request per paper) and Classify (a System One model; one request with a choice question for the decision and one for the exclusion reason); System One models are offered only for Classify, chat models only for Prompt. The paper is judged from its abstract; when there is none, from the first pages of its PDF text (at most 6000 characters); with neither it is skipped with the note "no abstract". The system prompt carries the review's protocol (research questions and criteria/notes), the allowed decisions and exclusion reasons (flattened to one line each against prompt injection, REQ-LLM-140), and rules: decide only from the given title/abstract/metadata, never exclude for missing information (the config has no "unsure" decision, so Include is the lenient choice), the reason must be one of the configured reasons, quote at most 200 characters verbatim, and give a confidence between 0 and 1; paper text appears only in the user message. The reply `{"decision","reason","justification","evidence","confidence"}` is validated against the configuration: an unknown decision, or an Exclude without a configured reason, is rejected and listed as a failed paper. Concurrency (1-4, default 2, `slr.llm.screening.concurrency`), cancel (finished papers go to review), per-paper errors and token usage follow the annotation batch. Apply (`applyAiScreeningBatch`) writes decision and reason only into papers still undecided in the target seat, never overwrites a human decision, marks the fields as AI-written, appends an `aiUsage` record with `mode: 'screening'` per changed paper, is one undo step, does nothing (no undo entry) when nothing is written, and does not advance the selected paper. A run is void when the dialog closes or the project is replaced. Ceilings: no resume, spend cap or agent mode.
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/llm/screeningAi.ts`, `src/state/aiScreeningStore.ts`, `src/components/AiScreeningDialog.tsx`, `src/components/Toolbar.tsx` (`aiButtonState`), `src/state/store.ts` (`applyAiScreeningBatch`), `src/model/project.ts` (`AiUsageRecord.mode`)
- **Status:** Implemented
- **Tests:** `src/llm/screeningAi.test.ts`, `src/state/aiScreeningStore.test.ts`, `src/components/AiScreeningDialog.test.tsx`, `src/components/Toolbar.test.ts`, `src/model/model.test.ts`

### REQ-LLM-640 — Conservative default ticks for screening proposals
- **Description:** Because a wrongly excluded paper silently leaves the review, the screening review table shall never pre-tick an Exclude proposal, and shall pre-tick an Include proposal only when its confidence is at least the threshold (Options, default 0.8, `slr.llm.screening.threshold`); a proposal without a confidence starts unticked. The review step explains this, offers Select all / Select none, and shows the proposed decision, reason, justification, evidence quote, confidence and engine per paper.
- **Type:** Functional (ISO 25010: Functional Suitability, Safety)
- **Evidence:** `src/state/aiScreeningStore.ts` (`defaultChecked`), `src/components/AiScreeningDialog.tsx`
- **Status:** Implemented
- **Tests:** `src/state/aiScreeningStore.test.ts`, `src/components/AiScreeningDialog.test.tsx`

### REQ-LLM-650 — AI seat in screening projects
- **Description:** `aiSeatId` shall no longer exclude screening projects: with `aiSeat`, AI allowed and at least 2 reviewers, the last seat is the AI's in a screening project too, labelled "AI (Reviewer N)". AI screening runs write into that seat regardless of the selected one; without an AI seat they write into the human seat selected when the dialog opened, and multi-reviewer projects require one to be picked. The project editor shows the "Allow AI-assisted screening" and AI-seat toggles for screening drafts. `applyAiSuggestionsBatch` still refuses screening projects.
- **Type:** Functional (ISO 25010: Functional Suitability)
- **Evidence:** `src/model/project.ts` (`aiSeatId`), `src/components/ProjectEditor.tsx`, `src/state/aiScreeningStore.ts` (`openDialog`), `src/state/store.ts` (`applyAiScreeningBatch`)
- **Status:** Implemented
- **Tests:** `src/model/model.test.ts`, `src/components/ProjectEditor.test.tsx`, `src/state/aiScreeningStore.test.ts`

### REQ-LLM-660 — Opt-in re-check of filled fields
- **Description:** The AI dialog's Options shall offer "Also re-check fields I've already filled" (Prompt mode only; disabled with a hint in Agent and Classify mode, and leaving Prompt mode clears it). It is off every time the dialog opens and is never persisted, so it can never become a default. When on, each paper gets one extra model call over `answeredFields` of the target seat's tree (the AI seat when there is one), skipped for a paper with no answered field; the normal fill call is skipped for a paper with no unanswered field or, in an all-papers run, a finished one. Batch candidates then include papers with any unanswered or answered field, finished papers included, and the all-papers warning says so ("including papers you marked finished"). Few-shot examples are passed to the re-check prompt; retry, abort, skip, spend cap, concurrency and resume (the re-check rows and flag are persisted with the batch) apply to the extra call; tokens and cost include it, and the estimate adds one prompt-style request per paper. A failed re-check after a successful fill is recorded as a note ("(re-check)") instead of failing the paper. The review shows a separate "Re-check of existing answers" section: only `disagree` outcomes are actionable (field, current value, AI proposal, reason, evidence quote that jumps to the PDF, confidence), and their tick boxes start unticked because a replacement overwrites a human answer; agree/unsure outcomes are listed compactly in a collapsed "N answers confirmed, M unsure". `applyAiSuggestionsBatch` accepts `replacements` per item, written in the same single undo step as the fills, only when the field still equals the value the AI checked (else counted as skipped), setting the AI mark; the result reports `replaced`, the applied screen says "replaced N answers", and the usage record gets `rechecked` (shown as "N replaced"). Ceiling: proposed replacements cannot be edited in the table.
- **Type:** Functional (ISO 25010: Functional Suitability, Safety)
- **Evidence:** `src/state/aiStore.ts` (`recheck`, `RecheckRow`, `batchCandidates`, `runOnePaperPrompt`, `toggleRecheckRow`, `apply`), `src/state/store.ts` (`applyAiSuggestionsBatch` `replacements`), `src/components/AiDialog.tsx` (`RecheckSection`, options), `src/model/project.ts` (`AiUsageRecord.rechecked`), `src/components/AiUsageDisclosure.tsx`
- **Status:** Implemented
- **Tests:** `src/state/aiStore.recheck.test.ts`, `src/components/AiDialog.test.tsx`, `src/components/AiUsageDisclosure.test.tsx`, `src/model/model.test.ts`

### REQ-LLM-670 — Optional provider web search in agent mode
- **Description:** In Agent mode the Options shall offer "Let the model search the web" (default off, persisted as `slr.llm.websearch`), enabled only when the annotator's provider has `supportsWebSearch`; otherwise a disabled row explains that the provider has no built-in web search (supported: Anthropic, OpenRouter). It shows `WEB_SEARCH_NOTE`, the consent line adds that search queries chosen by the model are handled by the provider, the flag is passed to `runAgent` and to `estimateRun`. The number of searches per paper is kept, shown in the run's usage line, and recorded as `webSearches` in the usage record (shown as "N web searches"). Rows whose suggestion is `webUnverified` show a "web · quote unchecked" badge next to their source URL and start unticked (flagged), so they appear in the "needs attention" filter and header note.
- **Type:** Functional (ISO 25010: Functional Suitability, Safety)
- **Evidence:** `src/state/aiStore.ts` (`webSearch`, `executeBatch` agent branch), `src/components/AiDialog.tsx`, `src/model/project.ts` (`AiUsageRecord.webSearches`), `src/components/AiUsageDisclosure.tsx`
- **Status:** Implemented
- **Tests:** `src/state/aiStore.recheck.test.ts`, `src/components/AiDialog.test.tsx`, `src/components/AiUsageDisclosure.test.tsx`, `src/model/model.test.ts`

### REQ-LLM-680 — Schema feedback saved to the feedback folder
- **Description:** The Options shall offer "Save feedback about the annotation schema" (default on, persisted as `slr.llm.feedback`), effective only in the desktop app for a project that has a saved path (otherwise shown disabled with the reason). Once per review, when it ends — on Apply, and on Discard or closing the unapplied review (unapplied proposals are feedback too) — the system builds per-field feedback with `buildRunFeedback` from the run's rows (applied, unticked, edited with AI/final value, left empty, rejected, judge verdict, cross-check outcome, confidence; re-check disagreements as edited when replaced, else unticked) and the per-paper schema remarks, and, if `hasFeedbackWorthSaving`, writes it via `writeFeedback` to `annotations/feedback/run-<timestamp>-<id>.json`. The file holds field paths, truncated values, counts and remarks only — no evidence quotes and no paper text. A guard prevents a second write for the same run; a project switch never writes into the new project. A failure never blocks Apply or Discard and shows "Couldn't save feedback: …" on the applied screen; success shows "Feedback saved to <path>". The write does not mark the project dirty (it is not part of the project file); the git panel lists the file as a plain file.
- **Type:** Functional (ISO 25010: Functional Suitability, Reliability)
- **Evidence:** `src/state/aiStore.ts` (`saveFeedback`, `writeFeedback`, `feedbackHandled`), `src/llm/feedback.ts`, `src/platform/adapter.ts` (`writeFeedback`), `src/components/AiDialog.tsx`
- **Status:** Implemented
- **Tests:** `src/state/aiStore.recheck.test.ts`, `src/llm/feedback.test.ts`, `electron/feedback.test.ts`
