import { describe, it, expect, vi } from 'vitest'
import type { SaveHandle } from '../platform/adapter'

/**
 * Bug: the native quit dialog's Save button and (on macOS/Chromium, where a
 * `<button>` click never moves focus) the editor's own Save/Save & Annotate
 * buttons used to call `save()`/`saveAndAnnotate()` directly, skipping the
 * `commitFocusedEdit()` call that only `useKeybindings.ts`'s Ctrl+S branch
 * made. That call exists to force a focused schema-field rename input to
 * blur, which fires `commitRename`'s confirm-before-you-lose-answers warning
 * (see `SchemaTreeEditor.tsx`) — bypassing it lets a rename the reviewer
 * never confirmed (or actively declined) reach disk, orphaning every
 * reviewer's answers under the old field name.
 *
 * `commitFocusedEdit` now lives inside `editorStore.save()` itself (and
 * `saveAs()` reaches it by calling `save()`), so every entry point shares one
 * guard. This exercises it directly against a real DOM node (jsdom), so it is
 * a genuine behavioural check rather than a mock of the fix.
 */
const mockPlatform = {
  kind: 'electron' as const,
  getOsInfo: () => null,
  getRecents: () => [],
  rememberProject: () => {},
  forgetRecent: () => [],
  checkRecents: async (e: unknown[]) => e,
  openProject: async () => ({
    text: PROJECT,
    handle: { kind: 'electron' as const, path: '/reviews/a/review.json' },
    name: 'review.json',
  }),
  openRecent: async () => null,
  saveProject: async (_t: string, h: SaveHandle) => h,
  pickProjectLocation: async () => null,
  rebasePdfPaths: async (paths: string[]) => paths,
  relativePdfPaths: async () => [],
  getPdfSource: async () => ({ url: '' }),
  pickPdfs: async () => [],
  listLlmConfigs: async () => [],
  saveLlmConfig: async () => [],
  deleteLlmConfig: async () => [],
  callLlm: async () => ({ ok: true, status: 200, body: '{}' }),
}
vi.mock('../platform', () => ({ getPlatform: () => mockPlatform }))

const { useEditorStore } = await import('./editorStore')
const es = () => useEditorStore.getState()

const PROJECT = JSON.stringify({
  version: 1,
  config: { schema: [{ name: 'Relevant', type: 'boolean' }] },
  papers: [
    { id: 'a', title: 'A', authors: [], pdf: 'pdfs/a.pdf', annotations: { Relevant: [{ value: false }] } },
  ],
})

describe('editorStore.save() commits the focused field before reading the draft', () => {
  it('blurs an in-progress edit (firing its blur-guard) as part of save, not just the Ctrl+S handler', async () => {
    await es().startEdit()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    let blurred = false
    input.addEventListener('blur', () => {
      blurred = true
    })

    expect(await es().save()).toBe(true)

    expect(blurred).toBe(true)
    expect(document.activeElement).not.toBe(input)
    document.body.removeChild(input)
  })
})
