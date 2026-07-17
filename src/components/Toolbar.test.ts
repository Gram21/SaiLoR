import { describe, it, expect } from 'vitest'
import { nextTitleClickState, gitButtonState, UNLOCK_CLICK_COUNT, UNLOCK_CLICK_WINDOW_MS } from './Toolbar'
import type { TitleClickState } from './Toolbar'
import type { GitProbe, GitRepoInfo } from '../git/types'

const START: TitleClickState = { count: 0, last: 0 }

describe('nextTitleClickState (the hidden AI-unlock gesture)', () => {
  it('does not unlock before the threshold', () => {
    let s = START
    for (let i = 1; i < UNLOCK_CLICK_COUNT; i++) {
      const r = nextTitleClickState(s, i * 100) // well within the window
      expect(r.unlocked).toBe(false)
      expect(r.state.count).toBe(i)
      s = r.state
    }
  })

  it('unlocks on exactly the threshold-th click within the window', () => {
    let s = START
    let last: ReturnType<typeof nextTitleClickState> | undefined
    for (let i = 1; i <= UNLOCK_CLICK_COUNT; i++) {
      last = nextTitleClickState(s, i * 100)
      s = last.state
    }
    expect(last!.unlocked).toBe(true)
    // Resets so a stray extra click afterwards starts a fresh run, not an
    // immediate re-unlock (harmless either way, but this is the intent).
    expect(last!.state.count).toBe(0)
  })

  it('a pause longer than the window restarts the count from 1', () => {
    let s = nextTitleClickState(START, 0).state
    // Three quick clicks…
    s = nextTitleClickState(s, 100).state
    s = nextTitleClickState(s, 200).state
    expect(s.count).toBe(3)
    // …then a long pause — the next click is click 1 of a new run, not 4.
    const r = nextTitleClickState(s, 200 + UNLOCK_CLICK_WINDOW_MS + 1)
    expect(r.state.count).toBe(1)
    expect(r.unlocked).toBe(false)
  })

  it('a click exactly at the window boundary still counts as the same run', () => {
    const s = nextTitleClickState(START, 1000).state
    const r = nextTitleClickState(s, 1000 + UNLOCK_CLICK_WINDOW_MS) // <=, not <
    expect(r.state.count).toBe(2)
  })

  it('never unlocks on fewer than the threshold, however many separate slow runs happen', () => {
    // Simulates idle clicking spread across a long session: each run resets
    // before reaching the threshold, so the count never silently accumulates.
    let s = START
    let anyUnlock = false
    for (let run = 0; run < 20; run++) {
      for (let click = 0; click < UNLOCK_CLICK_COUNT - 1; click++) {
        const r = nextTitleClickState(s, run * 100_000 + click * 50)
        anyUnlock = anyUnlock || r.unlocked
        s = r.state
      }
    }
    expect(anyUnlock).toBe(false)
  })
})

const REPO: GitRepoInfo = { root: '/r', relPath: 'p.slr.json', branch: 'main', upstream: 'origin/main', hasHead: true }
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
