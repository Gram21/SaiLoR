import { describe, it, expect } from 'vitest'
import { useAiStore } from './aiStore'
import { useStore } from './store'

describe('AI dialog and project lifecycle', () => {
  it('closes (and so cancels) the AI dialog when the project is closed', () => {
    useAiStore.setState({ open: true, phase: 'calling' })
    useStore.getState().closeProject()
    expect(useAiStore.getState().open).toBe(false)
  })
})
