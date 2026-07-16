import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = getPlatform().kind === 'electron' && isMac ? '⌘' : 'Ctrl'

/** Shortcuts while annotating a project. */
const ANNOTATE_KEYS: Array<[string, string]> = [
  [`${MOD}+O`, 'Open a project file'],
  [`${MOD}+S`, 'Save'],
  [`${MOD}+Shift+S`, 'Save as…'],
  [`${MOD}+Z`, 'Undo annotation change'],
  [`${MOD}+Shift+Z`, 'Redo annotation change'],
  [`${MOD}+F`, 'Search within the PDF'],
  [`${MOD} + / ${MOD} -`, 'Zoom the PDF in / out'],
  [`${MOD}+0`, 'Reset PDF zoom'],
  ['Alt+↓  /  ]', 'Next paper'],
  ['Alt+↑  /  [', 'Previous paper'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  [`${MOD}+C / V / X`, 'Copy / paste / cut (native)'],
  ['F1', 'Open this help'],
]

/** Shortcuts on the start screen, before anything is open. */
const START_KEYS: Array<[string, string]> = [
  [`${MOD}+O`, 'Open a project file'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  ['F1', 'Open this help'],
]

/** Shortcuts while building or editing the annotation JSON. */
const EDITOR_KEYS: Array<[string, string]> = [
  [`${MOD}+S`, 'Save the JSON (stay in the editor)'],
  [`${MOD}+Shift+S`, 'Save to a new location'],
  [`${MOD}+Z`, 'Undo a schema or paper change'],
  [`${MOD}+Shift+Z`, 'Redo'],
  [`${MOD}+Shift + / -`, 'App font size larger / smaller'],
  [`${MOD}+Shift+0`, 'Reset app font size'],
  [`${MOD}+C / V / X`, 'Copy / paste / cut (native)'],
  ['F1', 'Open this help'],
]

function ShortcutTable({ keys }: { keys: Array<[string, string]> }) {
  return (
    <table className="help-keys">
      <tbody>
        {keys.map(([combo, desc]) => (
          <tr key={combo}>
            <td>
              <kbd>{combo}</kbd>
            </td>
            <td>{desc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * One entry in the help. The table of contents is generated from these rather
 * than hand-written beside them, so a section can never be added, renamed or
 * dropped without the contents following it.
 */
interface HelpSection {
  id: string
  title: string
  body: ReactNode
}

/** One question/answer pair. Rendered as a `<details>` so the FAQ stays skimmable. */
function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="help-faq">
      <summary>{q}</summary>
      <div className="help-faq-body">{children}</div>
    </details>
  )
}

/** Answers that hold on every screen, so all three modes list them. */
function commonFaqs(): ReactNode {
  return (
    <>
      <Faq q="Where is my data? Does anything leave my computer?">
        <p>
          Your review is the project JSON file on your own disk, next to its PDFs — the app has no
          account, no server, and no sync. The one exception is <strong>AI-assisted annotation</strong>:
          if you use it, the paper's text and your schema are sent to the AI provider you configured.
          Nothing else is ever transmitted, and the AI dialog names the provider before it sends.
        </p>
      </Faq>
      <Faq q="Can two people review the same project at once?">
        <p>
          Not on the same file at the same time — the app has no locking, so two people saving the
          same JSON will overwrite each other. What it does support is{' '}
          <strong>multiple reviewers within one file</strong>: set the reviewer count when you build
          the schema, and each reviewer's answers are kept separately (see{' '}
          <em>Working with several reviewers</em>). Pass the file along, or take turns.
        </p>
      </Faq>
      <Faq q="I moved the JSON and now the PDFs don't load.">
        <p>
          PDFs are referenced <strong>relative to the JSON file</strong>, so the PDFs need to travel
          with it. Moving the JSON with <em>Save as…</em> re-derives the references for you; moving it
          in Finder/Explorer does not. In the browser you'll also be asked once per session to point
          at the folder that holds them.
        </p>
      </Faq>
      <Faq q="Why did my Findings get reordered — and why is my project suddenly unsaved?">
        <p>
          Opening a paper as <strong>Consolidation</strong> lines the reviewers up: it works out which
          of each reviewer's repeated entries are the same entry and puts them in the same order, so
          that everyone's <em>Finding #2</em> means one finding. Without that, comparing #2 against #2
          would pit unrelated findings against each other and report a disagreement that was really
          just a difference of ordering.
        </p>
        <p>
          Because that changes the file, it counts as an unsaved change — and it is a single{' '}
          <strong>Undo</strong> away if you would rather keep the original order. Your own values are
          never altered, only their order, and a gap can appear where you recorded nothing for an
          entry the others did. Once you have answered a group in Consolidation, it is left alone.
        </p>
      </Faq>
      <Faq q="Is my work saved automatically?">
        <p>
          No. A dot next to the project name means unsaved changes — press <strong>{MOD}+S</strong>.
          The app asks before you close or quit with unsaved work.
        </p>
      </Faq>
    </>
  )
}

/** Help for the start screen — nothing is open yet, so describe the tool itself. */
function startHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: (
      <>
        <p>
          SaiLoR supports <strong>Systematic Literature Reviews</strong>. Everything for a review
          lives in a single <strong>project JSON file</strong>, which holds two things: an{' '}
          <strong>annotation schema</strong> — the fields you want to extract from every paper — and
          the <strong>list of papers</strong>, each pointing at its PDF.
        </p>
        <p>
          While reviewing, the app shows the paper's PDF next to a form built from your schema. You
          fill the fields in (grabbing text straight from the PDF if you like), and the answers are
          saved back into the same JSON file — ready to hand to a co-reviewer or analyse later.
        </p>
      </>
    ),
    sections: [
      {
        id: 'options',
        title: 'Your options from here',
        body: (
          <ul>
            <li>
              <strong>Open project…</strong> — open an existing project JSON and start annotating. If
              you've opened projects before, they're listed underneath for one click, each with a{' '}
              <em>✎</em> to jump straight into editing its schema.
            </li>
            <li>
              <strong>New annotation JSON…</strong> — start a review from scratch. You choose where
              the JSON should live, define the annotation schema (the fields, their types, whether
              they repeat or nest), and attach the PDFs to review.
            </li>
            <li>
              <strong>Edit annotation JSON…</strong> — open an existing project and change its schema
              or its list of papers. Annotations already filled in are preserved.
            </li>
          </ul>
        ),
      },
      {
        id: 'which',
        title: 'Which one do I want?',
        body: (
          <p>
            If somebody handed you a project file, use <em>Open project…</em>. If you're setting up a
            new review, use <em>New annotation JSON…</em> — you can always come back and adjust the
            schema later with <em>Edit annotation JSON…</em>.
          </p>
        ),
      },
      {
        id: 'faq',
        title: 'FAQ',
        body: (
          <>
            <Faq q="What exactly is a “project”?">
              <p>
                One JSON file. It carries the schema, the paper list, and every answer anybody has
                filled in. There is no database and no hidden state — copy that file (and its PDFs)
                and you have copied the whole review.
              </p>
            </Faq>
            <Faq q="Do I need to write JSON by hand?">
              <p>
                No. <em>New annotation JSON…</em> builds it for you. The format is documented if you
                want to hand-edit or generate it, and the app reads hand-edited files defensively —
                but nothing here requires it.
              </p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      { id: 'shortcuts', title: 'Keyboard shortcuts', body: <ShortcutTable keys={START_KEYS} /> },
    ],
  }
}

/** Help for the annotation view. */
function annotateHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: (
      <p>
        You have a project open: read each paper's PDF in the middle and fill in the annotation
        fields on the right. Everything is saved back into the project JSON you opened.
      </p>
    ),
    sections: [
      {
        id: 'workflow',
        title: 'Basic workflow',
        body: (
          <ul>
            <li>
              <strong>Open</strong> a project via the <em>Open ▾</em> menu — pick a file or a recent
              project. To create or change a project's schema, use <em>New annotation JSON…</em> /{' '}
              <em>Edit annotation JSON…</em> on the start screen.
            </li>
            <li>
              <strong>Pick a paper</strong> from the left list. A green dot marks papers that already
              have annotations. The button in the list's header hides it to make room for the paper;
              once hidden, the same button in the top bar brings it back.
            </li>
            <li>
              <strong>Read the PDF</strong> in the middle pane; its text is selectable. Use{' '}
              <strong>{MOD}+F</strong> to search within it. After following an internal link (e.g. a
              reference), the <em>↩ / ↪</em> buttons jump back to where you were and forward again.
            </li>
            <li>
              <strong>Annotate</strong> on the right. Repeatable entries show <em>+ Add</em> and a
              remove (<em>×</em>) control. Use the <em>⧉</em> button next to a field to insert the
              text currently selected in the PDF.
            </li>
            <li>
              <strong>Validate</strong> checks your annotations against the schema: required fields
              that are still empty, values of the wrong type, and values outside a dropdown's
              choices. Required fields are marked with a red <em>*</em>.
            </li>
            <li>
              <strong>Save</strong> via the <em>Save ▾</em> menu (or {MOD}+S). "Save as…" writes to a
              new file, and the PDF references are re-derived so they still resolve from there.
            </li>
          </ul>
        ),
      },
      {
        id: 'searching',
        title: 'Finding a paper',
        body: (
          <>
            <p>
              The box above the paper list searches <strong>title, authors, and DOI</strong> — the{' '}
              <em>META</em> trigger inside its right-hand edge. Click it to switch to <em>TAGS</em>,
              which searches the <strong>annotation content</strong> you have already recorded
              instead — for answering "which papers did I mark as X". The trigger is highlighted
              while annotation search is on, so you can always tell which mode you are in.
            </p>
            <p>
              Annotation search looks at the answers of whoever you are currently reviewing as, so in
              a multi-reviewer project it finds <em>your</em> work, not somebody else's.
            </p>
          </>
        ),
      },
      {
        id: 'reviewers',
        title: 'Working with several reviewers',
        body: (
          <>
            <p>
              A project can be set up so that <strong>several reviewers annotate it independently</strong>{' '}
              — the usual way to keep an SLR honest. If it is, the top bar lets you say who you are.
              Each reviewer sees and fills in <strong>only their own answers</strong>; nobody is
              influenced by what anyone else recorded.
            </p>
            <p>
              Besides the numbered reviewers there is one extra role, <strong>Consolidation</strong>.
              That is not "one more reviewer" — it is the pass where the disagreements get settled.
              In Consolidation, each field gets a compare button that shows{' '}
              <strong>every reviewer's answer side by side</strong>, flags whether they agree, and
              lets you click one to adopt it. What Consolidation records is the project's{' '}
              <strong>final result</strong> — the answers an analysis or export would use.
            </p>
            <p>
              Where <strong>every reviewer gave the same answer</strong>, Consolidation fills it in
              for you and marks it with a{' '}
              <strong>light-blue border</strong> until you click it — there is nothing to reconcile
              when everyone already agrees, and copying those across by hand is exactly the task
              during which a real disagreement further down gets missed. Only case and stray spaces
              are forgiven, never near-misses: if the wording genuinely differs, the call stays
              yours. A field one reviewer left blank is not agreement either, however the others
              answered.
            </p>
            <p>
              For fields and groups that can be added several times — Findings, say — Consolidation
              does two things for you as you open a paper. It adds{' '}
              <strong>as many entries as the busiest reviewer recorded</strong>, so you are not
              counting anyone's work by hand. And it works out{' '}
              <strong>which of each reviewer's entries are the same entry</strong>, since two people
              listing the same three findings rarely list them in the same order. Your Finding #2 is
              then everyone's Finding #2, and the compare button lines up answers that are genuinely
              about the same thing instead of reporting a disagreement that was only a difference of
              ordering. Entries are matched on what they say, so wording need not match exactly;
              once you have answered a group, it is left alone rather than re-ordered underneath you.
            </p>
            <p>
              Until you pick who you are, the form stays hidden: an answer that isn't attributable to
              a reviewer is worse than no answer.
            </p>
          </>
        ),
      },
      {
        id: 'ai',
        title: 'Annotating with AI',
        body: (
          <>
            <p>
              The <strong>✦ AI</strong> button above the annotation fields asks a language model to
              read the open paper and <strong>propose</strong> values for it. Only the fields that are{' '}
              <strong>still empty</strong> are proposed — what you have already filled in is never
              overwritten.
            </p>
            <p>
              You see every proposal first: the field, the value, the quote from the paper that
              supports it, and a checkbox. Untick what you don't want;{' '}
              <strong>nothing is written until you press Apply</strong>. The whole fill counts as one
              change, so <strong>{MOD}+Z</strong> undoes it in a single step. Fields the AI filled
              keep a blue border until you look at them.
            </p>
            <p>
              To send the paper, the text is extracted from its PDF and sent to the AI provider you
              set up under <em>✦ AI → ⚙</em> — so don't use it on papers you may not share. The
              dialog names the provider before anything is sent, and treat the proposals as a draft:
              check the quotes.
            </p>
            <p>
              Every AI-assisted fill you apply is <strong>recorded in the saved file</strong>: which
              provider and model, and when. That disclosure stays with the project so a co-reviewer
              can see where AI was involved.
            </p>
          </>
        ),
      },
      {
        id: 'faq',
        title: 'FAQ',
        body: (
          <>
            <Faq q="Validate says nothing is wrong, but I know papers are empty.">
              <p>
                Papers with <strong>no annotations at all</strong> are skipped rather than reported —
                an untouched paper would otherwise fail every required field at once and bury the
                real problems. They are listed separately, under <em>Not annotated yet</em>, so you
                can still see them.
              </p>
            </Faq>
            <Faq q="Why isn't my required Yes/no field flagged as missing?">
              <p>
                A <em>Yes/no</em> field always counts as answered: an unticked box is a real answer
                (<em>no</em>), and the file cannot tell "not answered" apart from "answered no". If
                you need a true third state, use a <em>Text</em> field with fixed choices instead.
              </p>
            </Faq>
            <Faq q="Can I change the schema after people have annotated?">
              <p>
                Yes — <em>Edit annotation JSON…</em> on the start screen. Existing answers are
                preserved. Renaming or removing a field drops the answers stored under it, so treat
                that as destructive.
              </p>
            </Faq>
            <Faq q="The AI proposed a value that isn't in the paper.">
              <p>
                That is exactly what the quote column is for — every proposal must cite the passage
                it came from, and one that can't be traced to the paper should be unticked. Nothing
                is written until you press Apply. This is why the tool proposes rather than fills.
              </p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      { id: 'shortcuts', title: 'Keyboard shortcuts', body: <ShortcutTable keys={ANNOTATE_KEYS} /> },
    ],
  }
}

/** Help for the project editor (schema + papers). */
function editorHelp(): { lead: ReactNode; sections: HelpSection[] } {
  return {
    lead: (
      <p>
        This is where you define a project: the <strong>annotation schema</strong> (the fields
        reviewers fill in for every paper) and the <strong>PDFs</strong> to annotate. It writes the
        project JSON that the annotation view then opens.
      </p>
    ),
    sections: [
      {
        id: 'location',
        title: 'Where the JSON lives',
        body: (
          <p>
            The location is chosen up front and shown at the top — use <em>Change…</em> to move it.
            PDFs are referenced <strong>relative to the JSON file</strong>, so if you move the JSON
            the references are re-derived for you.
          </p>
        ),
      },
      {
        id: 'schema',
        title: 'Building the schema',
        body: (
          <ul>
            <li>
              <strong>Add a field</strong> with <em>+ Add field</em>, or nest one under another with{' '}
              <em>+ Child</em>. Each field has a name, a type, and an optional description shown on
              hover while annotating.
            </li>
            <li>
              <strong>Type:</strong> <em>Text</em>, <em>Number</em>, <em>Yes/no</em>, or{' '}
              <em>Group</em> — a group holds no value of its own and just contains nested fields.
            </li>
            <li>
              <strong>Repeats:</strong> <em>min</em> and <em>max</em> control how many times a field
              can occur. Tick <em>∞</em> for an unbounded number — the annotator then gets{' '}
              <em>+ Add</em> to create as many entries as needed.
            </li>
            <li>
              <strong>Fixed choices:</strong> on a <em>Text</em> field, add options to turn it into a
              dropdown. With no options it stays free text.
            </li>
            <li>
              <strong>Reorder and nest by dragging</strong> a row's <em>⠿</em> handle: drop near a
              row's top or bottom edge to place it before or after, or drop in the middle of a row to
              nest it inside that row.
            </li>
          </ul>
        ),
      },
      {
        id: 'reviewers',
        title: 'Setting up several reviewers',
        body: (
          <p>
            Turn on multiple reviewers and give a count to have the project annotated{' '}
            <strong>independently</strong> by that many people — each sees only their own answers.
            On top of the number you choose, the project always gets one extra{' '}
            <strong>Consolidation</strong> role: whoever takes it compares everyone's answers field
            by field and records the final, agreed result, which is what the project's output
            actually contains. So "2 reviewers" means two independent passes plus a consolidation
            pass.
          </p>
        ),
      },
      {
        id: 'papers',
        title: 'Adding papers',
        body: (
          <>
            <p>There are three ways to get papers into a project, and they mix freely:</p>
            <ul>
              <li>
                <strong>+ Add PDFs…</strong> — pick one or more PDFs.
              </li>
              <li>
                <strong>+ Add folder…</strong> — take every PDF in a folder at once, including
                sub-folders.
              </li>
              <li>
                <strong>Import references…</strong> — read a <strong>BibTeX</strong> (<code>.bib</code>),{' '}
                <strong>RIS</strong> (<code>.ris</code>) or <strong>CSL-JSON</strong> export from a
                reference manager such as Zotero, Mendeley or JabRef. This brings in titles, authors
                and DOIs; you still attach the PDFs themselves.
              </li>
            </ul>
            <p>
              A paper already in the project is never added twice. Importing references matches
              against what is already there — by DOI, otherwise by title — and fills in the gaps of a
              matching paper instead of duplicating it.
            </p>
            <p>
              Newly added papers are <strong>marked with a blue border</strong>, because their title
              and authors are a <em>best-effort guess</em> read out of the PDF or the reference file.
              Check them; the mark clears as soon as you click into the row. Every field stays
              editable, and rows can be dragged to reorder.
            </p>
          </>
        ),
      },
      {
        id: 'saving',
        title: 'Saving',
        body: (
          <p>
            <strong>Save JSON</strong> writes the file and leaves you here to keep working.{' '}
            <strong>Save JSON &amp; Begin Annotating</strong> writes it and opens it for review. Both
            check the project first and tell you what to fix if something is off.
          </p>
        ),
      },
      {
        id: 'faq',
        title: 'FAQ',
        body: (
          <>
            <Faq q="An imported reference has no PDF. Is that a problem?">
              <p>
                It is flagged, and you should fix it before annotating: a paper needs a PDF to
                review. Importing a bibliography only brings the <em>metadata</em> — attach the file
                with <em>+ Add PDFs…</em> or by typing the path into the row.
              </p>
            </Faq>
            <Faq q="The title or authors came out wrong.">
              <p>
                They are extracted heuristically — from the PDF's own metadata and layout, or from
                the reference file — and papers vary wildly. That is exactly why new rows are marked
                for review. Just type over anything that is wrong; nothing is locked.
              </p>
            </Faq>
            <Faq q="Can I reuse one schema across several reviews?">
              <p>
                Yes — copy the project JSON, then use <em>Edit annotation JSON…</em> to swap the
                papers out. The schema and the paper list are independent parts of the same file.
              </p>
            </Faq>
            <Faq q="What happens to answers if I rename a field?">
              <p>
                Answers are stored under the field's <em>name</em>, so renaming one orphans what was
                recorded under the old name and it is dropped on save. Decide names before people
                start annotating where you can.
              </p>
            </Faq>
            {commonFaqs()}
          </>
        ),
      },
      { id: 'shortcuts', title: 'Keyboard shortcuts', body: <ShortcutTable keys={EDITOR_KEYS} /> },
    ],
  }
}

/** Sections every mode shares, appended after the mode-specific ones. */
function sharedSections(): HelpSection[] {
  return [
    {
      id: 'appearance',
      title: 'Appearance',
      body: (
        <p>
          Toggle light/dark with the ☾/☀ button and scale the app text with the <em>A− A A+</em>{' '}
          buttons. These affect the app only — the PDF paper stays white and normal-sized.
        </p>
      ),
    },
    {
      id: 'license',
      title: 'License',
      body: (
        <p>
          SaiLoR is free software, released under the{' '}
          <strong>GNU General Public License v3.0</strong> (GPL-3.0). You may use, study, share, and
          modify it under the terms of that license; it comes with no warranty. The full license text
          is in the <code>LICENSE</code> file distributed with the app, and online at{' '}
          <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">
            gnu.org/licenses/gpl-3.0
          </a>
          .
        </p>
      ),
    },
  ]
}

/** Modal explaining the current mode and listing its keyboard shortcuts. */
export function HelpDialog() {
  const open = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  // The help must describe the screen the user is actually looking at: the
  // editor, an open project, or the start screen with neither.
  const editing = useEditorStore((s) => s.open)
  const hasProject = useStore((s) => s.project !== null)
  const mode = editing ? 'editor' : hasProject ? 'annotate' : 'start'
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHelpOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setHelpOpen])

  if (!open) return null

  const { lead, sections: modeSections } =
    mode === 'editor' ? editorHelp() : mode === 'annotate' ? annotateHelp() : startHelp()
  const sections = [...modeSections, ...sharedSections()]

  // Scroll the modal's own body rather than the page: an `href="#id"` would
  // navigate the SPA (and do nothing at all under file:// in the packaged app).
  // Instant, not smooth — matching the PDF pane's link jumps, and because a
  // smooth scroll inside this container was observed to silently do nothing.
  const jumpTo = (id: string) => {
    bodyRef.current?.querySelector(`#help-${id}`)?.scrollIntoView({ block: 'start' })
  }
  // Back to the contents at the top, which is the only thing worth returning
  // to — set scrollTop rather than scrolling the lead into view, so this can
  // never be a no-op when the body happens to already be near the top.
  const jumpToTop = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  return (
    <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
      <div
        className="modal help-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <strong>
            SaiLoR — Help{' '}
            <span className="help-mode">
              {mode === 'editor'
                ? 'Editing the annotation JSON'
                : mode === 'annotate'
                  ? 'Annotating'
                  : 'Getting started'}
            </span>
          </strong>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setHelpOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body" ref={bodyRef}>
          <div className="help-lead">{lead}</div>

          <nav className="help-toc" aria-label="Help contents">
            <span className="help-toc-title">On this page</span>
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <button type="button" className="help-toc-link" onClick={() => jumpTo(s.id)}>
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {sections.map((s) => (
            <section key={s.id}>
              <h3 id={`help-${s.id}`}>{s.title}</h3>
              {s.body}
              {/* Every section is a plausible place to have finished reading,
                  and the contents are only at the top. */}
              <div className="help-top-row">
                <button type="button" className="help-top-link" onClick={jumpToTop}>
                  ↑ Back to top
                </button>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
