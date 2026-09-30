import { describe, it, expect } from 'vitest'
import { gitButtonState, aiButtonState } from './Toolbar'
import type { GitProbe, GitRepoInfo } from '../git/types'

const REPO: GitRepoInfo = { root: '/r', relPath: 'p.slr.json', branch: 'main', upstream: 'origin/main', hasHead: true, behind: null, annotationsDir: 'annotations' }
const AVAILABLE: GitProbe = { available: true, version: 'git version 2.43.0', error: '' }
const HINT = 'BROWSER_HINT'

describe('gitButtonState (the toolbar Git button, always shown, disabled with a reason)', () => {
  it('is disabled with the no-project hint on the start screen in Electron', () => {
    const r = gitButtonState(true, AVAILABLE, false, null, false, false, HINT)
    expect(r.disabled).toBe(true)
    expect(r.title).toBe('Open a project in a git repository to use Git.')
  })

  it('is disabled with the browser hint when there is no git at all', () => {
    const r = gitButtonState(false, null, false, null, false, false, HINT)
    expect(r.disabled).toBe(true)
    expect(r.title).toBe(HINT)
  })

  it('is disabled with the probe error when Electron has no git binary, ahead of the no-project hint', () => {
    const r = gitButtonState(true, { available: false, version: '', error: 'git not found' }, false, null, false, false, HINT)
    expect(r.disabled).toBe(true)
    expect(r.title).toBe('git not found')
  })

  it('is disabled but shown when a project is open outside any work tree', () => {
    const r = gitButtonState(true, AVAILABLE, true, null, false, false, HINT)
    expect(r.disabled).toBe(true)
    expect(r.title).toContain("isn't in a git repository")
  })

  it('is enabled when everything lines up', () => {
    const r = gitButtonState(true, AVAILABLE, true, REPO, false, false, HINT)
    expect(r.disabled).toBe(false)
    expect(r.title).toBe('Commit, pull and push this project — main')
  })

  it('falls back to "detached HEAD" when the repo has no current branch', () => {
    const r = gitButtonState(true, AVAILABLE, true, { ...REPO, branch: null }, false, false, HINT)
    expect(r.disabled).toBe(false)
    expect(r.title).toBe('Commit, pull and push this project — detached HEAD')
  })

  it('busy or an open editor disables without rewriting an otherwise-usable tooltip', () => {
    const busy = gitButtonState(true, AVAILABLE, true, REPO, true, false, HINT)
    expect(busy.disabled).toBe(true)
    expect(busy.title).toBe('Commit, pull and push this project — main')

    const editorOpen = gitButtonState(true, AVAILABLE, true, REPO, false, true, HINT)
    expect(editorOpen.disabled).toBe(true)
    expect(editorOpen.title).toBe('Commit, pull and push this project — main')
  })
})

describe('aiButtonState (the toolbar AI button, always shown, disabled with a reason)', () => {
  it('is enabled when everything lines up', () => {
    const r = aiButtonState(true, false, false, false, true, false, false, false)
    expect(r.disabled).toBe(false)
    expect(r.title).toBe('Annotate papers with AI')
  })

  it('is disabled for the Consolidation seat', () => {
    const r = aiButtonState(true, false, true, false, true, false, false, false)
    expect(r.disabled).toBe(true)
    expect(r.title).toContain('Consolidation')
  })

  it('is enabled for a screening project, with its own tooltip', () => {
    const r = aiButtonState(true, true, false, false, true, false, false, false)
    expect(r.disabled).toBe(false)
    expect(r.title).toContain('include/exclude')
  })

  it('still blocks a screening project on Consolidation, no reviewer, or the project opt-out', () => {
    expect(aiButtonState(true, true, true, false, true, false, false, false).disabled).toBe(true)
    expect(aiButtonState(true, true, false, true, true, false, false, false).disabled).toBe(true)
    expect(aiButtonState(true, true, false, false, false, false, false, false).disabled).toBe(true)
  })

  it('is disabled with no reviewer picked in a multi-reviewer project', () => {
    const r = aiButtonState(true, false, false, true, true, false, false, false)
    expect(r.disabled).toBe(true)
    expect(r.title).toContain('Pick a reviewer')
  })

  it("is disabled with the project's own opt-out reason when config.ai is false", () => {
    const r = aiButtonState(true, false, false, false, false, false, false, false)
    expect(r.disabled).toBe(true)
    expect(r.title).toBe('AI is turned off for this project in its settings.')
  })

  it('busy or an open editor disables without rewriting an otherwise-usable tooltip', () => {
    const busy = aiButtonState(true, false, false, false, true, true, false, false)
    expect(busy.disabled).toBe(true)
    expect(busy.title).toBe('Annotate papers with AI')

    const editorOpen = aiButtonState(true, false, false, false, true, false, true, false)
    expect(editorOpen.disabled).toBe(true)
    expect(editorOpen.title).toBe('Annotate papers with AI')
  })

  describe('with an AI seat (REQ-LLM-470): a run writes into the AI seat, not the selected one', () => {
    it('is not disabled for the Consolidation seat', () => {
      const r = aiButtonState(true, false, true, false, true, false, false, true)
      expect(r.disabled).toBe(false)
      expect(r.title).toBe('Annotate papers with AI')
    })

    it('is not disabled with no reviewer picked', () => {
      const r = aiButtonState(true, false, false, true, true, false, false, true)
      expect(r.disabled).toBe(false)
      expect(r.title).toBe('Annotate papers with AI')
    })

    it('is enabled for a screening project on the Consolidation seat, but still not for the project opt-out', () => {
      const screening = aiButtonState(true, true, true, false, true, false, false, true)
      expect(screening.disabled).toBe(false)

      const optedOut = aiButtonState(true, false, false, false, false, false, false, true)
      expect(optedOut.disabled).toBe(true)
    })
  })
})
