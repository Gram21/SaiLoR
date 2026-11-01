import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const setWindowTitle = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({ kind: 'browser', getRecents: () => [], rememberProject: () => {}, setWindowTitle }),
}))

const { useStore } = await import('../state/store')
const { useWindowTitle, windowTitle } = await import('./useWindowTitle')

const json = (title?: string) =>
  JSON.stringify({
    version: 1,
    ...(title ? { title } : {}),
    config: { schema: [{ name: 'Field', type: 'string' }] },
    papers: [{ id: 'p1', title: 'Paper One', authors: [], pdf: 'p1.pdf', annotations: {} }],
  })

describe('windowTitle', () => {
  it('names the app alone with no project open', () => {
    expect(windowTitle(null, false)).toBe('SaiLoR')
  })

  it('puts the project first and marks unsaved changes', () => {
    expect(windowTitle('Review', false)).toBe('Review - SaiLoR')
    expect(windowTitle('Review', true)).toBe('● Review - SaiLoR')
  })
})

describe('useWindowTitle', () => {
  beforeEach(() => {
    setWindowTitle.mockClear()
    useStore.getState().closeProject()
  })

  it('follows open, unsaved changes and close', () => {
    renderHook(() => useWindowTitle())
    expect(setWindowTitle).toHaveBeenLastCalledWith('SaiLoR')

    act(() => useStore.getState().loadFromText(json('My review'), null, 'review.json'))
    expect(setWindowTitle).toHaveBeenLastCalledWith('My review - SaiLoR')

    act(() => useStore.setState({ dirty: true }))
    expect(setWindowTitle).toHaveBeenLastCalledWith('● My review - SaiLoR')

    act(() => useStore.getState().closeProject())
    expect(setWindowTitle).toHaveBeenLastCalledWith('SaiLoR')
  })

  it('falls back to the file name when the project has no title', () => {
    renderHook(() => useWindowTitle())
    act(() => useStore.getState().loadFromText(json(), null, 'review.json'))
    expect(setWindowTitle).toHaveBeenLastCalledWith('review.json - SaiLoR')
  })
})
