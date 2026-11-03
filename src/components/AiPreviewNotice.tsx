// [impl->req~llm-750~1]
import { useT } from '../i18n'
import '../styles/ai.css'

/** Shown at the top of every AI window: the feature is not final yet. */
export function AiPreviewNotice() {
  const t = useT()
  return (
    <p className="ai-preview-notice" role="note">
      <strong>{t('ai.preview.title')}</strong> {t('ai.preview.text')}
    </p>
  )
}
