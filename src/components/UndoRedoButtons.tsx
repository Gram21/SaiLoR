import { useStore } from '../state/store'
import { useEditorStore } from '../state/editorStore'
import { useT } from '../i18n'
import { getPlatform } from '../platform'

const PATHS = {
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11'],
  redo: ['m15 14 5-5-5-5', 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13'],
}

function HistoryIcon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

function modKey(t: ReturnType<typeof useT>): string {
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  return getPlatform().kind !== 'browser' && mac ? '⌘' : t('toolbar.key.ctrl')
}

/** Undo/redo for whatever the keyboard shortcut would act on: the project
 *  editor's draft while it is open, the annotation history otherwise. */
export function UndoRedoButtons({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const editing = useEditorStore((s) => s.open)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const editorCanUndo = useEditorStore((s) => s.past.length > 0)
  const editorCanRedo = useEditorStore((s) => s.future.length > 0)
  const history = () => (editing ? useEditorStore.getState() : useStore.getState())
  const mod = modKey(t)
  return (
    <div className="font-controls" role="group" aria-label={t('toolbar.history.group')}>
      <button
        type="button"
        className="icon-btn"
        title={t('toolbar.undo.title', { mod })}
        aria-label={t('toolbar.undo.label')}
        onClick={() => history().undo()}
        disabled={disabled || !(editing ? editorCanUndo : canUndo)}
      >
        <HistoryIcon name="undo" />
      </button>
      <button
        type="button"
        className="icon-btn"
        title={t('toolbar.redo.title', { mod })}
        aria-label={t('toolbar.redo.label')}
        onClick={() => history().redo()}
        disabled={disabled || !(editing ? editorCanRedo : canRedo)}
      >
        <HistoryIcon name="redo" />
      </button>
    </div>
  )
}
