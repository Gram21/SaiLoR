/**
 * Copy to the clipboard, tolerating environments where the async Clipboard
 * API is unavailable or denied (no secure context, no permission granted) —
 * the legacy `execCommand('copy')` route still works in those, run against a
 * throwaway off-screen textarea. Resolves `false` rather than throwing when
 * both routes fail, so the caller can simply skip the "Copied" confirmation
 * instead of surfacing an error for what is a convenience button.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy route below.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
