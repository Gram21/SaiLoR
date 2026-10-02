import '../styles/ai.css'

/** Shown at the top of every AI window: the feature is not final yet. */
export function AiPreviewNotice() {
  return (
    <p className="ai-preview-notice" role="note">
      <strong>Preview feature.</strong> AI support is still in development and may change or behave
      unexpectedly. Check every proposal yourself before you apply it.
    </p>
  )
}
