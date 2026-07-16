import { useRef } from 'react'
import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { getPlatform } from '../platform'
import { Dropdown, type MenuItem } from './Dropdown'
import { SidebarToggle } from './SidebarToggle'

/** Clicks this close together count as the same run; a pause starts over. */
export const UNLOCK_CLICK_WINDOW_MS = 2500
/** How many clicks on the app title unlock AI use for the session. */
export const UNLOCK_CLICK_COUNT = 12
/** Above this many reviewers the pill row would crowd the toolbar, so the
 * switch becomes a dropdown instead. At or below it, pills stay — a row of
 * up to 5 numbers plus Consolidation is still scannable at a glance. */
export const REVIEWER_DROPDOWN_THRESHOLD = 5

/** A run of clicks, tracked as a plain object so the logic below stays pure. */
export interface TitleClickState {
  count: number
  last: number
}

/**
 * The pure core of the hidden AI-unlock gesture: click `UNLOCK_CLICK_COUNT`
 * times on the app title within `UNLOCK_CLICK_WINDOW_MS` of each other. Kept
 * free of React/`Date.now()` so the "N clicks within a window" rule is testable
 * on its own — the component only supplies `now` and holds the running state.
 */
export function nextTitleClickState(
  prev: TitleClickState,
  now: number,
  windowMs: number = UNLOCK_CLICK_WINDOW_MS,
  threshold: number = UNLOCK_CLICK_COUNT,
): { state: TitleClickState; unlocked: boolean } {
  const count = now - prev.last <= windowMs ? prev.count + 1 : 1
  if (count >= threshold) {
    return { state: { count: 0, last: now }, unlocked: true }
  }
  return { state: { count, last: now }, unlocked: false }
}

/** Top bar: Open / Save menus, appearance controls, help, and the dirty indicator. */
export function Toolbar() {
  const openProject = useStore((s) => s.openProject)
  const openRecent = useStore((s) => s.openRecent)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
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
  const unlockAi = useStore((s) => s.unlockAi)
  const currentReviewer = useStore((s) => s.currentReviewer)
  const selectReviewer = useStore((s) => s.selectReviewer)

  // A ref, not state: counting must not trigger a render, or the title (and
  // anything watching it) would visibly react to being clicked before the
  // gesture is even complete. See the title span below — it stays exactly
  // as plain as it looks for click 1 through `UNLOCK_CLICK_COUNT`.
  const titleClicks = useRef<TitleClickState>({ count: 0, last: 0 })
  const onTitleClick = () => {
    const { state, unlocked } = nextTitleClickState(titleClicks.current, Date.now())
    titleClicks.current = state
    if (unlocked) unlockAi()
  }

  const modKey = getPlatform().kind === 'electron' && isMac() ? '⌘' : 'Ctrl'

  const reviewerCount = project?.reviewers ?? 1
  const showReviewerSwitch = !!project && reviewerCount > 1
  const reviewerUnset = showReviewerSwitch && currentReviewer === null
  const reviewerIds = Array.from({ length: reviewerCount }, (_, i) => String(i + 1))
  const useReviewerDropdown = reviewerCount > REVIEWER_DROPDOWN_THRESHOLD

  // The closed dropdown must still read "you are Reviewer 3" — a caret alone
  // would defeat the point of showing the active seat at all.
  const reviewerDropdownLabel = reviewerUnset
    ? 'Pick a reviewer'
    : currentReviewer === 'consolidation'
      ? 'Consolidation'
      : `Reviewer ${currentReviewer}`

  const reviewerMenuItems: MenuItem[] = [
    ...reviewerIds.map<MenuItem>((rid) => ({
      type: 'item',
      label: (
        <span className={`reviewer-menu-label${currentReviewer === rid ? ' is-current' : ''}`}>
          {currentReviewer === rid ? '✓ ' : ''}Reviewer {rid}
        </span>
      ),
      hint: `Reviewer ${rid} — annotate independently; only you see this until Consolidation`,
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
      onSelect: () => selectReviewer('consolidation'),
    },
  ]

  const openItems: MenuItem[] = [
    { type: 'item', label: 'Open file…', shortcut: `${modKey}+O`, onSelect: () => void openProject() },
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
            onSelect: () => void openRecent(r.id),
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

        <span className="app-title" onClick={onTitleClick}>
          SaiLoR
        </span>

        <div className="toolbar-actions">
          <Dropdown label="Open" title="Open a project" disabled={busy} items={openItems} />
          <Dropdown label="Save" title="Save the project" disabled={busy} items={saveItems} />
          <button
            type="button"
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
            Validate
          </button>
          <button
            type="button"
            title="Close this project and return to the start screen"
            onClick={requestCloseProject}
            disabled={!project || busy || editorOpen}
          >
            Close
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
                  title={`Reviewer ${rid} — annotate independently; only you see this until Consolidation`}
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
                onClick={() => selectReviewer('consolidation')}
              >
                Consolidation
              </button>
            </div>
          ))}
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

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}
