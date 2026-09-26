import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../platform', () => ({ getPlatform: () => ({ kind: 'browser', getRecents: () => [], getGit: () => null }) }))

const { useGitStore } = await import('../state/gitStore')
const { useUpstreamPolling } = await import('./useUpstreamPolling')

/**
 * The unpulled count is only as fresh as the last fetch, so a repository with
 * an upstream is fetched every two minutes for as long as it is open.
 */
describe('useUpstreamPolling', () => {
  let calls = 0
  const repo = (upstream: string | null) => ({
    root: '/repo',
    relPath: 'x.json',
    branch: 'main',
    upstream,
    hasHead: true,
    annotationsDir: 'annotations',
    behind: null,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    calls = 0
    useGitStore.setState({
      repo: repo('origin/main'),
      refreshUpstream: async () => {
        calls++
      },
    })
  })
  afterEach(() => vi.useRealTimers())

  it('refreshes every two minutes', () => {
    renderHook(() => useUpstreamPolling())
    act(() => vi.advanceTimersByTime(119_000))
    expect(calls).toBe(0)
    act(() => vi.advanceTimersByTime(1_000))
    expect(calls).toBe(1)
    act(() => vi.advanceTimersByTime(240_000))
    expect(calls).toBe(3)
  })

  it('stops when the project closes', () => {
    const { unmount } = renderHook(() => useUpstreamPolling())
    unmount()
    act(() => vi.advanceTimersByTime(600_000))
    expect(calls).toBe(0)
  })

  it('does not run without an upstream to compare against', () => {
    useGitStore.setState({ repo: repo(null) })
    renderHook(() => useUpstreamPolling())
    act(() => vi.advanceTimersByTime(600_000))
    expect(calls).toBe(0)
  })

  it('keeps its rhythm when the project merely reloads', () => {
    // `repo` is replaced on every reload; restarting the timer each time would
    // keep pushing the next fetch back.
    renderHook(() => useUpstreamPolling())
    act(() => vi.advanceTimersByTime(90_000))
    act(() => useGitStore.setState({ repo: repo('origin/main') }))
    act(() => vi.advanceTimersByTime(30_000))
    expect(calls).toBe(1)
  })
})
