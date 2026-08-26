### [SaiLoR — Developer Documentation](Home)

**[Quickstart](quickstart)**
- [What is SaiLoR?](quickstart#what-is-sailor)
- [Tech Stack](quickstart#tech-stack)
- [Quick Commands](quickstart#quick-commands)
- [Repository Layout](quickstart#repository-layout)

**[Architecture](architecture)**
- [Platform Adapter](architecture#platform-adapter-pattern)
- [State Management](architecture#state-management)
- [Component Tree](architecture#component-tree)
- [Git](architecture#git)
- [Electron Main Process](architecture#electron-main-process)

**[Testing Strategy](testing)**
- [The three test tiers](testing#the-three-test-tiers)
- [CI gating](testing#ci-gating)

**Concepts**
- **[Annotation Schema and Validation](Concepts-Annotation-Schema)**
  - [Field types](Concepts-Annotation-Schema#field-types)
  - [Validation: the schema walk](Concepts-Annotation-Schema#validation-the-schema-walk)
- **[Project Data Model](Concepts-Data-Model)**
  - [On-disk layout](Concepts-Data-Model#on-disk-layout)
  - [In-memory types](Concepts-Data-Model#in-memory-types)
  - [Lifecycle](Concepts-Data-Model#the-load--normalize--edit--prune--serialize-lifecycle)

**Operations**
- **[Build, CI, and Release](Operations-Build-Release)**
  - [Build pipeline](Operations-Build-Release#build-pipeline)
  - [Release signing](Operations-Build-Release#release-signing-ed25519-feed-signature)
  - [Wiki sync mechanics](Operations-Build-Release#wiki-sync-mechanics)
- **[Electron Main Process and IPC](Operations-Electron-Shell)**
  - [Trust boundary](Operations-Electron-Shell#trust-boundary-and-the-allowlist-discipline)
  - [The `slr-file://` protocol](Operations-Electron-Shell#the-slr-file-protocol)
  - [Self-update](Operations-Electron-Shell#self-update-update)

**Workflows**
- **[Multi-Reviewer Consolidation](Workflows-Consolidation)**
  - [Entry matching](Workflows-Consolidation#the-core-problem-entry-matching)
- **[Git Integration](Workflows-Git-Integration)**
  - [Security gates](Workflows-Git-Integration#security-gates-input-never-chooses-argv)
- **[AI-Assisted Annotation](Workflows-LLM-Annotation)**
  - [End-to-end flow](Workflows-LLM-Annotation#end-to-end-flow)
- **[PDF Viewer and Marks](Workflows-PDF-Viewing)**
  - [Mark lifecycle](Workflows-PDF-Viewing#mark-lifecycle)
- **[Screening Mode](Workflows-Screening)**
  - [What makes it a distinct mode](Workflows-Screening#what-makes-it-a-distinct-mode)
