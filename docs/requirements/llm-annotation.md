# Requirements — LLM-Assisted Annotation

Requirements for the optional AI feature that proposes annotation values from a paper's
content. See the [index](index.md) for the glossary.

---

### REQ-LLM-10 — Support multiple LLM providers
- **Description:** The system shall send annotation-suggestion requests to any of nine provider APIs: Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, and generic OpenAI-compatible servers.
- **Type:** Functional
- **Evidence:** `src/llm/providers.ts:55-157`, `src/llm/types.ts:12-21`
- **Status:** Implemented

### REQ-LLM-20 — Fixed base URLs for named providers
- **Description:** The system shall use a fixed base URL for each named provider and shall permit base-URL editing only for the OpenAI-compatible provider type.
- **Type:** Functional
- **Evidence:** `src/llm/providers.ts:22,60,146`, `src/components/LlmSettingsDialog.tsx:423`
- **Status:** Implemented

### REQ-LLM-30 — Manage multiple named targets
- **Description:** The system shall store multiple named LLM targets, each consisting of a name, provider, base URL, model, attachment mode, and optional reasoning effort, with create, edit, and delete operations, where delete requires a second confirming activation.
- **Type:** Functional
- **Evidence:** `src/llm/types.ts:27-46`, `src/components/LlmSettingsDialog.tsx:102-106,264-276`
- **Status:** Implemented

### REQ-LLM-40 — Keep API keys out of the user interface layer
- **Description:** The system shall store API keys only in the main process, expose to the user interface layer only a flag stating whether a key is stored, and substitute the real key for a placeholder immediately before sending a request.
- **Type:** Non-functional (security)
- **Evidence:** `src/llm/types.ts:4-10,86`, `electron/main.ts:1417,1447-1450,1536-1539`
- **Status:** Implemented

### REQ-LLM-50 — Encrypt stored API keys
- **Description:** The system shall store API keys encrypted with the operating system's secure storage in a configuration file restricted to owner read/write, and shall refuse to save a key when secure storage is unavailable.
- **Type:** Non-functional (security)
- **Evidence:** `electron/main.ts:1408-1464`
- **Status:** Implemented

### REQ-LLM-60 — Restrict key transmission
- **Description:** The system shall attach the API key only to requests whose URL uses http or https, matches the configured base URL's protocol and origin, and shall refuse HTTP redirects on key-carrying requests.
- **Type:** Non-functional (security)
- **Evidence:** `electron/main.ts:1519-1534,1551-1566`
- **Status:** Implemented

### REQ-LLM-70 — Bound LLM call duration
- **Description:** The system shall terminate an LLM request that has not completed within 10 minutes and shall allow the user to abort an in-flight request at any time.
- **Type:** Non-functional (robustness)
- **Evidence:** `electron/main.ts:1488-1500,1549`, commit `98796c1`
- **Status:** Implemented

### REQ-LLM-80 — Honor project-level AI opt-out
- **Description:** When a project's configuration sets `ai` to false, the system shall not offer the AI feature for that project.
- **Type:** Functional
- **Evidence:** `src/model/project.ts:771`, `src/components/AnnotationPanel.tsx:23-25,161`, `src/state/aiStore.ts:164-166`
- **Status:** Implemented

### REQ-LLM-90 — Restrict AI to numbered reviewer seats
- **Description:** The system shall reject AI annotation on the Consolidation seat, on multi-reviewer projects with no seat selected, and on screening projects.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:167-169`, `src/state/store.ts:2318-2337`
- **Status:** Implemented

### REQ-LLM-100 — Ask only about unanswered fields
- **Description:** When an AI run starts, the system shall request values only for the currently unanswered fields of the current paper, where a boolean field counts as unanswered unless it is true.
- **Type:** Functional
- **Evidence:** `src/llm/fields.ts:21-75`, `src/state/aiStore.ts:185`
- **Status:** Implemented

### REQ-LLM-110 — Deliver the paper as text or PDF
- **Description:** The system shall deliver the paper to the provider either as text extracted from the PDF or as the PDF file itself for providers that accept documents (Anthropic, OpenAI, Google, OpenRouter), falling back to extracted text when a PDF-configured target's provider cannot accept documents.
- **Type:** Functional
- **Evidence:** `src/llm/providers.ts:61-156,230-264`, `src/state/aiStore.ts:375-418`
- **Status:** Implemented

### REQ-LLM-120 — Refuse text delivery of image-only PDFs
- **Description:** When text extraction from the PDF yields no body text, the system shall abort a text-delivery run with an error advising PDF delivery, without sending a request.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:388-400`, `src/model/pdfText.ts:106-152`
- **Status:** Implemented

### REQ-LLM-130 — Anti-hallucination prompt rules
- **Description:** The system shall instruct the model to take values only from the paper, to omit fields it cannot answer, to supply a verbatim supporting quote of at most 200 characters per value, and to copy enum values verbatim.
- **Type:** Functional
- **Evidence:** `src/llm/prompt.ts:150-165`
- **Status:** Implemented

### REQ-LLM-140 — Flatten schema text in prompts
- **Description:** When embedding schema-supplied names, descriptions, or options in the prompt, the system shall flatten each string to a single line so that project-authored content cannot forge prompt structure.
- **Type:** Non-functional (security)
- **Evidence:** `src/llm/prompt.ts:77-93`, commit `30a7ecf`
- **Status:** Implemented

### REQ-LLM-150 — Bind replies to their run
- **Description:** The system shall record the paper, reviewer seat, provider, and model at run start and shall refuse to apply a reply to any paper or seat other than the one it was requested for.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:87,340-347`, `src/state/store.ai.test.ts:431-461`, commit `c56d6ab`
- **Status:** Implemented

### REQ-LLM-160 — Discard superseded runs
- **Description:** When an AI run is cancelled or superseded by a newer run, the system shall discard its answer or error without altering the newer run's state.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:355-482`, commit `e6f534a`
- **Status:** Implemented

### REQ-LLM-170 — Validate every suggestion against the schema
- **Description:** When parsing a model reply, the system shall accept a suggestion only when its value type-checks against the target field's definition, and shall list each rejected suggestion with a reason (unknown field, duplicate, missing value, type mismatch, empty value, disallowed enum value, or implausible year).
- **Type:** Functional
- **Evidence:** `src/llm/parse.ts:7-23,256-324`
- **Status:** Implemented

### REQ-LLM-180 — Accept only unambiguous coercions
- **Description:** When a suggested value's type differs from the field type, the system shall coerce only values with a single honest reading (strict decimal string to number, case-insensitive "true"/"false" to boolean, case/whitespace-normalized enum labels) and shall reject anything fuzzier.
- **Type:** Functional
- **Evidence:** `src/llm/parse.ts:124-183`
- **Status:** Implemented

### REQ-LLM-190 — Tolerant reply extraction
- **Description:** When a model reply wraps its JSON in prose or code fences, the system shall extract the JSON object without failing, and shall report an unparseable reply as an error rather than applying anything.
- **Type:** Functional
- **Evidence:** `src/llm/parse.ts:28-116`
- **Status:** Implemented

### REQ-LLM-200 — Cap repeatable indices from the model
- **Description:** When a suggestion addresses an instance index of an unbounded repeatable node, the system shall reject indices above 10,000.
- **Type:** Non-functional (robustness)
- **Evidence:** `src/llm/paths.ts:224-246`, `src/llm/parse.ts:276`
- **Status:** Implemented

### REQ-LLM-210 — Human review before applying
- **Description:** The system shall present accepted suggestions in a review table showing field, value, supporting quote, and confidence, with per-row checkboxes and select-all/none, and shall write values only when the user applies the selection.
- **Type:** Functional
- **Evidence:** `src/components/AiDialog.tsx:14-18,242-336`, `src/state/aiStore.ts:447-454`
- **Status:** Implemented

### REQ-LLM-220 — Apply as one undo step without overwriting
- **Description:** When applying checked suggestions, the system shall write them as a single undo step, skipping any field the reviewer answered in the meantime and any path that no longer resolves, and shall record no undo entry when nothing was written.
- **Type:** Functional
- **Evidence:** `src/state/store.ts:2364-2432`, `src/state/store.ai.test.ts:142-251`
- **Status:** Implemented

### REQ-LLM-230 — Mark AI-written fields until confirmed
- **Description:** The system shall visually mark each AI-written field, scoped to paper and reviewer seat, until the reviewer interacts with the field, and shall never persist these marks to the project file.
- **Type:** Functional
- **Evidence:** `src/state/store.ts:107-124,2436-2445`, `src/state/store.aimarks.test.ts`
- **Status:** Implemented

### REQ-LLM-240 — Record durable AI-usage disclosure
- **Description:** When an apply changes at least one field, the system shall append a record of provider, model, and timestamp to the paper's AI-usage list in the project file, using the provider and model of the run that produced the answer.
- **Type:** Functional
- **Evidence:** `src/state/store.ts:2419-2427`, `src/model/project.ts:416-436`, `src/state/store.ai.test.ts:364-429`
- **Status:** Implemented

### REQ-LLM-250 — List provider models
- **Description:** When a target with a stored key requests its model list, the system shall query the provider's list-models endpoint with provider-specific pagination up to 10 pages, cache the result per target for one hour, and bypass the cache on explicit refresh.
- **Type:** Functional
- **Evidence:** `src/llm/models.ts:92-174`, `src/state/aiStore.ts:35-46,277-325`
- **Status:** Implemented

### REQ-LLM-260 — Constrain pagination cursors
- **Description:** When following a provider-supplied pagination cursor, the system shall reject cursors that resolve outside the configured base URL's origin.
- **Type:** Non-functional (security)
- **Evidence:** `src/llm/models.ts:96-157`
- **Status:** Implemented

### REQ-LLM-270 — Free-text model selection
- **Description:** The system shall accept any typed model name, offer fetched model names as searchable suggestions, and flag a typed name only when a fetched list exists and does not contain it.
- **Type:** Functional
- **Evidence:** `src/components/ModelPicker.tsx:16-28,115-118`
- **Status:** Implemented

### REQ-LLM-280 — Per-provider reasoning effort
- **Description:** When a reasoning effort is configured for a model that reports or matches reasoning capability, the system shall translate the effort into the provider's specific request parameter.
- **Type:** Functional
- **Evidence:** `src/llm/providers.ts:266-366`, `src/llm/models.ts:14-90,246-257`
- **Status:** Implemented

### REQ-LLM-290 — Verify target setup
- **Description:** When "Verify setup" is triggered on a saved target, the system shall send a minimal test request and display the model's reply verbatim on success or the provider's error message on failure, distinguishing a reply truncated by internal reasoning.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:26-32,233-271`, `src/components/LlmSettingsDialog.tsx:239-262,563-588`
- **Status:** Implemented

### REQ-LLM-300 — Report run progress
- **Description:** During an AI run, the system shall display the current phase (setup, reading, calling, parsing, review, applied, or error) with a live elapsed-time counter and a cancel action.
- **Type:** Functional
- **Evidence:** `src/state/aiStore.ts:48-56,361-363`, `src/components/AiDialog.tsx:220-240`
- **Status:** Implemented

### REQ-LLM-310 — Distinguish truncation from empty answers
- **Description:** When a reply is empty and the provider reports a token-limit finish reason, the system shall report that the model spent its budget on internal reasoning, distinct from the model proposing nothing.
- **Type:** Functional
- **Evidence:** `src/llm/providers.ts:421-446`, `src/state/aiStore.ts:260-268,431-437`
- **Status:** Implemented
