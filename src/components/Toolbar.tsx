import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { useAiStore } from '../state/aiStore'
import { useAiScreeningStore } from '../state/aiScreeningStore'
import { useEditorStore } from '../state/editorStore'
import { useGitStore } from '../state/gitStore'
import { CONSOLIDATION_SEAT } from '../git/seatOwner'
import { getPlatform } from '../platform'
import { Dropdown, type MenuItem } from './Dropdown'
import { SidebarToggle } from './SidebarToggle'
import type { GitProbe, GitRepoInfo } from '../git/types'
import { aiSeatId, seatLabel } from '../model/project'

/** Shown on every git entry point in the browser build, where `getGit()` is
 *  always `null` (see `PlatformAdapter.getGit()` and architecture.md's "Git"
 *  section for why: no process spawn, no SSH agent, no credential helper —
 *  a browser page cannot reach any of what git support needs, permission
 *  prompt or not). Shown as a disabled control's tooltip, not by hiding the
 *  control — a reviewer who reaches for it should learn why it doesn't work
 *  and what to do instead, not wonder whether they misremembered it existing. */
const GIT_BROWSER_DISABLED_HINT = 'Git support is disabled in the browser version. Use the SaiLoR desktop app if you need it.'
/** Electron, no project open (the start screen): git acts on the open
 *  project's file, so there is nothing to act on yet. */
const GIT_NO_PROJECT_HINT = 'Open a project in a git repository to use Git.'
/** Electron, a project is open but its file is not inside a git work tree:
 *  there is nothing to commit, pull or push. */
const GIT_NO_REPO_HINT = "This project isn't in a git repository — there's nothing to commit, pull or push."

/** Above this many reviewers the pill row would crowd the toolbar, so the
 * switch becomes a dropdown instead. At or below it, pills stay — a row of
 * up to 5 numbers plus Consolidation is still scannable at a glance. */
export const REVIEWER_DROPDOWN_THRESHOLD = 5

export interface GitButtonState {
  disabled: boolean
  title: string
}

/**
 * The Git toolbar button's disabled state and tooltip. Pulled out on its own
 * so the precedence of *why it's off* is a rule worth testing without a DOM.
 * The button is always rendered (like Validate and Close beside it, and like
 * every git entry point in the browser), so this only ever decides
 * usable-or-not, mirroring the "Import from remote git…" item's own
 * precedence — the sibling entry point — so the two can't drift.
 */
export function gitButtonState(
  git: boolean, // getPlatform().getGit() !== null: Electron has git, the browser never does
  probe: GitProbe | null, // Electron-only "is a git binary actually here" check
  project: boolean, // a project is open
  repo: GitRepoInfo | null, // the open project's file sits inside a work tree
  busy: boolean,
  editorOpen: boolean,
  browserHint: string, // GIT_BROWSER_DISABLED_HINT, passed in to keep this free of module constants
): GitButtonState {
  const probeUnavailable = probe !== null && !probe.available
  // Structural reasons pick the tooltip; the transient ones (busy/editorOpen)
  // only disable — they must not rewrite the tooltip out from under a button
  // that is otherwise perfectly usable, matching Validate/Close.
  const title = !git
    ? browserHint
    : probeUnavailable
      ? probe!.error
      : !project
        ? GIT_NO_PROJECT_HINT
        : !repo
          ? GIT_NO_REPO_HINT
          : `Commit, pull and push this project — ${repo.branch ?? 'detached HEAD'}`
  const disabled = !git || probeUnavailable || !project || !repo || busy || editorOpen
  return { disabled, title }
}

export interface AiButtonState {
  disabled: boolean
  title: string
}

const AI_NO_PROJECT_HINT = 'Open a project to annotate with AI.'
const AI_CONSOLIDATION_HINT =
  'AI has no place in Consolidation — it reconciles what the reviewers already said, not a fresh opinion.'
const AI_REVIEWER_UNSET_HINT = 'Pick a reviewer first — there is nothing to annotate as "the reviewer" yet'
const AI_PROJECT_DISABLED_HINT = 'AI is turned off for this project in its settings.'
const AI_ENABLED_HINT = 'Annotate papers with AI'
const AI_SCREENING_ENABLED_HINT = 'Propose include/exclude decisions with AI'

/**
 * The toolbar AI button's disabled state and tooltip — same shape and same
 * reasoning as `gitButtonState`: always rendered, disabled-with-a-reason
 * rather than hidden. Structural reasons (no project, Consolidation, no
 * reviewer picked, project opted out) pick the tooltip; `busy`/`editorOpen`
 * only disable, matching Validate/Close.
 *
 * With an AI seat (REQ-LLM-470), a run never writes into whichever seat is
 * currently selected — it always writes into the AI's own seat instead — so
 * neither "no reviewer picked" nor "on the Consolidation seat" blocks it.
 */
export function aiButtonState(
  project: boolean,
  screening: boolean,
  isConsolidation: boolean,
  reviewerUnset: boolean,
  aiEnabled: boolean,
  busy: boolean,
  editorOpen: boolean,
  hasAiSeat: boolean,
): AiButtonState {
  const blockConsolidation = isConsolidation && !hasAiSeat
  const blockReviewerUnset = reviewerUnset && !hasAiSeat
  const title = !project
    ? AI_NO_PROJECT_HINT
    : blockConsolidation
      ? AI_CONSOLIDATION_HINT
      : blockReviewerUnset
        ? AI_REVIEWER_UNSET_HINT
        : !aiEnabled
          ? AI_PROJECT_DISABLED_HINT
          : screening
            ? AI_SCREENING_ENABLED_HINT
            : AI_ENABLED_HINT
  const disabled = !project || blockConsolidation || blockReviewerUnset || !aiEnabled || busy || editorOpen
  return { disabled, title }
}

/** Top bar: file/Git on the left, the reviewer seat in the middle, then project status, review tools (Validate, AI), appearance controls and help. */
export function Toolbar() {
  const requestOpenProject = useStore((s) => s.requestOpenProject)
  const requestOpenRecent = useStore((s) => s.requestOpenRecent)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
  const autosaveEnabled = useStore((s) => s.autosaveEnabled)
  const setAutosaveEnabled = useStore((s) => s.setAutosaveEnabled)
  const lastSavedAt = useStore((s) => s.lastSavedAt)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const runValidation = useStore((s) => s.runValidation)
  const requestCloseProject = useStore((s) => s.requestCloseProject)
  const editorOpen = useEditorStore((s) => s.open)
  const project = useStore((s) => s.project)
  const projectName = useStore((s) => s.projectName)
  const dirty = useStore((s) => s.dirty)
  const busy = useStore((s) => s.busy)
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const increaseFont = useStore((s) => s.increaseFont)
  const decreaseFont = useStore((s) => s.decreaseFont)
  const resetFont = useStore((s) => s.resetFont)
  const recents = useStore((s) => s.recents)
  const forgetRecent = useStore((s) => s.forgetRecent)
  const projectTitle = useStore((s) => s.projectTitle)
  const saveHandle = useStore((s) => s.saveHandle)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)
  const readOnly = useStore((s) => s.readOnly)
  const setReadOnly = useStore((s) => s.setReadOnly)
  const corruptFiles = useStore((s) => s.corruptFiles)
  const showCorruptFiles = useStore((s) => s.showCorruptFiles)
  const openAnnotationAi = useAiStore((s) => s.openDialog)
  const openScreeningAi = useAiScreeningStore((s) => s.openDialog)
  const openAiDialog = project?.screening ? openScreeningAi : openAnnotationAi

  // Git support is Electron-only: `getGit()` is null in the browser (no local
  // git to reach at all). The entry points stay visible there too, disabled
  // with `GIT_BROWSER_DISABLED_HINT` rather than hidden — see that constant.
  // `probe` is the separate, narrower case of "this machine has no git
  // installed" (Electron, but nothing to reach), which dims the control the
  // same way with `gitProbe.error` as the hint instead.
  const git = getPlatform().getGit()
  const gitProbe = useGitStore((s) => s.probe)
  const gitRepo = useGitStore((s) => s.repo)
  const behind = useGitStore((s) => s.behind)
  const ownStashes = useGitStore((s) => s.stashes.filter((e) => e.origin !== 'other').length)
  const openClone = useGitStore((s) => s.openClone)
  const openGitPanel = useGitStore((s) => s.openPanel)
  const gitBtn = gitButtonState(!!git, gitProbe, !!project, gitRepo, busy, editorOpen, GIT_BROWSER_DISABLED_HINT)

  // A transient "Saved" confirmation, shown a few seconds after every
  // successful save (manual or autosaved) and then hidden again — `dirty`
  // going false is silent otherwise, and an autosave in particular has no
  // other feedback at all.
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (lastSavedAt === null) return
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 2500)
    return () => clearTimeout(t)
  }, [lastSavedAt])

  const modKey = getPlatform().kind !== 'browser' && isMac() ? '⌘' : 'Ctrl'

  const reviewerCount = project?.reviewers ?? 1
  const showReviewerSwitch = !!project && reviewerCount > 1
  const reviewerUnset = showReviewerSwitch && currentReviewer === null
  const reviewerIds = Array.from({ length: reviewerCount }, (_, i) => String(i + 1))
  const useReviewerDropdown = reviewerCount > REVIEWER_DROPDOWN_THRESHOLD
  const aiBtn = aiButtonState(
    !!project,
    !!project?.screening,
    currentReviewer === CONSOLIDATION_SEAT,
    reviewerUnset,
    project?.aiEnabled ?? false,
    busy,
    editorOpen,
    !!project && aiSeatId(project) !== null,
  )

  // The closed dropdown must still read "you are Reviewer 3" — a caret alone
  // would defeat the point of showing the active seat at all.
  const reviewerDropdownLabel = reviewerUnset
    ? 'Pick a reviewer'
    : currentReviewer === 'consolidation'
      ? 'Consolidation'
      : project
        ? seatLabel(project, currentReviewer!)
        : `Reviewer ${currentReviewer}`

  const reviewerMenuItems: MenuItem[] = [
    ...reviewerIds.map<MenuItem>((rid) => ({
      type: 'item',
      label: (
        <span
          className={`reviewer-menu-label${currentReviewer === rid ? ' is-current' : ''}`}
        >
          {currentReviewer === rid ? '✓ ' : ''}
          {project ? seatLabel(project, rid) : `Reviewer ${rid}`}
        </span>
      ),
      hint: `${project ? seatLabel(project, rid) : `Reviewer ${rid}`} — annotate independently; only you see this until Consolidation`,
      disabled: busy,
      onSelect: () => selectReviewer(rid),
    })),
    { type: 'separator' },
    {
      type: 'item',
      // A different *kind* of seat, not "reviewer N+1" — kept visually
      // distinct here too via its own label class, same as the pill form.
      label: (
        <span
          className={`reviewer-menu-label reviewer-menu-consolidation${
            currentReviewer === 'consolidation' ? ' is-current' : ''
          }`}
        >
          {currentReviewer === 'consolidation' ? '✓ ' : ''}Consolidation
        </span>
      ),
      hint: "Consolidation — compare every reviewer's answers and record the final, agreed result. This is what the project's saved output actually contains.",
      disabled: busy,
      onSelect: () => selectReviewer(CONSOLIDATION_SEAT),
    },
  ]

  const openItems: MenuItem[] = [
    { type: 'item', label: 'Open file…', shortcut: `${modKey}+O`, onSelect: () => requestOpenProject() },
    {
      type: 'item',
      label: 'Import from remote git…',
      hint: !git
        ? GIT_BROWSER_DISABLED_HINT
        : gitProbe && !gitProbe.available
          ? gitProbe.error
          : 'Clone a repository and open a project from it',
      disabled: !git || busy || (gitProbe !== null && !gitProbe.available),
      onSelect: () => openClone(),
    },
    {
      type: 'item',
      label: 'Close project',
      hint: 'Close this project and return to the start screen',
      disabled: !project || busy || editorOpen,
      onSelect: requestCloseProject,
    },
    { type: 'separator' },
    { type: 'header', label: 'Recent projects' },
    ...(recents.length > 0
      ? recents.map<MenuItem>((r) => {
          const label = r.title || r.name
          const where = r.path ?? r.name
          // Only an explicit false disables it; undefined = not checked yet.
          const missing = r.available === false
          return {
            type: 'item',
            // The title when the project sets one, else the bare file name.
            label: missing ? `${label} (not found)` : label,
            // The path on hover is what tells two same-named projects apart.
            hint: missing ? `Not found — ${where}` : `${label}\n${where}`,
            disabled: missing,
            onSelect: () => requestOpenRecent(r.id),
            onRemove: () => forgetRecent(r.id),
            removeTitle: 'Remove from recent projects',
          }
        })
      : [{ type: 'item', label: 'No recent files', disabled: true, onSelect: () => {} } as MenuItem]),
  ]

  const saveItems: MenuItem[] = [
    { type: 'item', label: 'Save', shortcut: `${modKey}+S`, disabled: !project, onSelect: () => void save() },
    {
      type: 'item',
      label: 'Save as…',
      shortcut: `${modKey}+Shift+S`,
      disabled: !project,
      onSelect: () => void saveAs(),
    },
    { type: 'separator' },
    {
      type: 'item',
      label: `${autosaveEnabled ? '✓ ' : ''}Autosave every 5 minutes`,
      hint: autosaveEnabled
        ? 'Unsaved changes are saved automatically every 5 minutes. Click to turn off.'
        : 'Automatically save unsaved changes every 5 minutes, in addition to Ctrl+S.',
      onSelect: () => setAutosaveEnabled(!autosaveEnabled),
    },
  ]

  return (
    <header className="toolbar">
      {/* Three tracks (left / center / right) so the reviewer switch can sit
          truly centered on the toolbar itself rather than merely between its
          neighbors — see `.toolbar` in index.css. Both flanking tracks are
          always rendered, even with nothing to put in the center, so the
          grid's column assignment never shifts. */}
      <div className="toolbar-left">
        {/* While the list is open its own header owns the toggle; once collapsed
            the button has to live out here, or there'd be no way to bring it back.
            The slot is always in the layout — hiding it rather than removing it
            keeps the title from shifting sideways as the sidebar is toggled. */}
        <span
          className={`toolbar-toggle-slot${sidebarCollapsed ? '' : ' is-hidden'}`}
          aria-hidden={!sidebarCollapsed}
        >
          <SidebarToggle />
        </span>

        <span className="app-title">
          SaiLoR
        </span>

        <div className="toolbar-actions">
          <Dropdown label="Open" title="Open a project" disabled={busy} items={openItems} />
          <Dropdown label="Save" title="Save the project" disabled={busy} items={saveItems} />
          <span className="toolbar-sep" aria-hidden="true" />
          {/* Always rendered, disabled with an honest reason rather than hidden —
              the browser (no local git at all), Electron with no git binary, the
              start screen with no project yet, and a project outside a work tree
              all read as a dimmed button with a tooltip, never a hole in the
              toolbar. `gitButtonState` owns the precedence. */}
          <button
            type="button"
            className="tb-btn"
            title={gitBtn.title}
            onClick={() => void openGitPanel()}
            disabled={gitBtn.disabled}
          >
            <Icon name="git" />
            Git
          </button>
        </div>
      </div>

      <div className="toolbar-center">
        {/* Only a multi-reviewer project shows this — a single-reviewer one has
            nobody to switch between. Which "seat" is active must be unmistakable,
            since it decides which tree every edit lands in. Past
            `REVIEWER_DROPDOWN_THRESHOLD` reviewers the pill row would crowd the
            toolbar, so it becomes a dropdown — but the closed trigger still names
            the active seat, or the whole point of an at-a-glance seat is lost. */}
        {showReviewerSwitch &&
          !editorOpen &&
          (useReviewerDropdown ? (
            <div
              className={`reviewer-dropdown${reviewerUnset ? ' unselected' : ''}`}
              role="group"
              aria-label="Reviewer"
            >
              {reviewerUnset && <span className="reviewer-switch-prompt">Pick a reviewer:</span>}
              <Dropdown
                className={`reviewer-dropdown-trigger${
                  currentReviewer === 'consolidation' ? ' is-consolidation' : ''
                }`}
                label={reviewerDropdownLabel}
                title={reviewerUnset ? undefined : 'Switch reviewer'}
                disabled={busy}
                items={reviewerMenuItems}
              />
            </div>
          ) : (
            <div
              className={`reviewer-switch${reviewerUnset ? ' unselected' : ''}`}
              role="group"
              aria-label="Reviewer"
            >
              {reviewerUnset && <span className="reviewer-switch-prompt">Pick a reviewer:</span>}
              {reviewerIds.map((rid) => (
                <button
                  key={rid}
                  type="button"
                  className={`reviewer-btn${currentReviewer === rid ? ' active' : ''}`}
                  title={`${project ? seatLabel(project, rid) : `Reviewer ${rid}`} — annotate independently; only you see this until Consolidation`}
                  disabled={busy}
                  onClick={() => selectReviewer(rid)}
                >
                  {rid}
                </button>
              ))}
              <button
                type="button"
                className={`reviewer-btn reviewer-btn-consolidation${
                  currentReviewer === 'consolidation' ? ' active' : ''
                }`}
                title="Consolidation — compare every reviewer's answers and record the final, agreed result. This is what the project's saved output actually contains."
                disabled={busy}
                onClick={() => selectReviewer(CONSOLIDATION_SEAT)}
              >
                Consolidation
              </button>
            </div>
          ))}
        {project && !editorOpen && (
          <label
            className="read-only-toggle"
            title="View-only mode: look at the annotations without being able to change anything"
          >
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            View only
          </label>
        )}
      </div>

      <div className="toolbar-right">
        {/* The file name sits just left of the view controls; both are pushed
            to the right edge by `.toolbar-right`'s own flex layout. */}
        <div className="toolbar-status">
          {project && (
            // The project's own title when it has one; the path on hover locates it.
            <span className="project-name" title={saveHandle?.path ?? projectName}>
              {projectTitle || projectName || 'untitled'}
              {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
            </span>
          )}
          {/* Always in the layout (even empty) so its appearance doesn't shift
              the project name sideways; `aria-live` carries it to a screen
              reader the same moment it becomes visible. */}
          <span className="save-status" role="status" aria-live="polite">
            {showSaved ? 'Saved' : ''}
          </span>
        </div>

        {/* Parked work nobody remembers is lost work. Only SaiLoR's own
            stashes count here — a carry-over that did not come back, or one
            made from the Git panel — since a stash somebody made in a
            terminal is their own git business and would only nag. */}
        {ownStashes > 0 && !editorOpen && (
          <button
            type="button"
            className="toolbar-notice"
            title="Changes parked in a stash — open Git to restore or delete them"
            onClick={() => void openGitPanel()}
            disabled={gitBtn.disabled}
          >
            {ownStashes} stashed
          </button>
        )}
        {/* The repository already knows this, and until now only said so
            inside one confirm dialog in the schema editor. "Behind" is as of
            the last fetch, so it can report work waiting but never that
            there is none — hence no "up to date" counterpart. */}
        {behind !== null && behind > 0 && !editorOpen && (
          <button
            type="button"
            className="toolbar-warning"
            title="Someone has pushed work you have not pulled yet — open Git to pull it"
            onClick={() => void openGitPanel()}
            disabled={gitBtn.disabled}
          >
            ↓ {behind} to pull
          </button>
        )}
        {/* Stays for as long as the project is open. The load-time banner is
            dismissible, and a reviewer who clicks it away otherwise has no
            way left to learn the project is still missing somebody's work —
            which reads on every screen as that reviewer having done none. */}
        {corruptFiles.length > 0 && !editorOpen && (
          <button
            type="button"
            className="toolbar-warning"
            title={`${corruptFiles.length === 1 ? 'One annotation file' : `${corruptFiles.length} annotation files`} could not be read — click for the list`}
            onClick={showCorruptFiles}
          >
            ⚠ {corruptFiles.length} unreadable
          </button>
        )}

        {/* Review tools: what you do to the annotations, as opposed to the
            file/Git group on the left that gets a project open and saved.
            Both are always rendered, disabled with an honest reason rather
            than hidden; `aiButtonState` owns the AI precedence, and a paper
            with no PDF is not one of those reasons — the dialog itself
            handles that case once opened. */}
        <div className="toolbar-tools" role="group" aria-label="Review tools">
          <button
            type="button"
            className="tb-btn"
            title={
              reviewerUnset
                ? 'Pick a reviewer first — there is nothing to validate as "the reviewer" yet'
                : "Check every paper's annotations against the schema"
            }
            onClick={runValidation}
            // Validation is about the annotations, so it means nothing while the
            // project editor is open, or before a reviewer has been picked.
            disabled={!project || busy || editorOpen || reviewerUnset}
          >
            <Icon name="check" />
            Validate
          </button>
          {project?.aiEnabled && (
            <button
              type="button"
              className="tb-btn tb-btn-ai"
              title={readOnly ? 'View-only mode — switch it off to run the AI' : aiBtn.title}
              onClick={() => void openAiDialog()}
              disabled={aiBtn.disabled || readOnly}
            >
              <Icon name="spark" />
              AI
            </button>
          )}
        </div>

        <div className="toolbar-view">
          <div className="font-controls" role="group" aria-label="Font size">
            <button
              type="button"
              className="icon-btn"
              title={`Decrease app font size (${modKey}+Shift+-)`}
              onClick={decreaseFont}
            >
              A−
            </button>
            <button
              type="button"
              className="icon-btn"
              title={`Reset app font size (${modKey}+Shift+0)`}
              onClick={resetFont}
            >
              A
            </button>
            <button
              type="button"
              className="icon-btn"
              title={`Increase app font size (${modKey}+Shift++)`}
              onClick={increaseFont}
            >
              A+
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Help (F1)"
            aria-label="Help"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
        </div>
      </div>
    </header>
  )
}

const ICON_PATHS = {
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  check: 'M20 6 9 17l-5-5',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
}

function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg
      className="tb-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}
