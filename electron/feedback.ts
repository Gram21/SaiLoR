import path from 'node:path'
import { FEEDBACK_DIR } from '../src/model/annotationsDir'

/**
 * Pure checks for writing AI schema-feedback files into
 * `<annotationsDir>/feedback/`. The renderer is not fully trusted, so the file
 * name and content are validated here before main touches the disk. Lives
 * outside `main.ts` so it is unit-testable.
 */

export const MAX_FEEDBACK_BYTES = 1024 * 1024

// Plain name only: no separators, no leading dot, always `.json`.
const FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,114}\.json$/

/** Why `fileName` cannot be a feedback file, or `null` when it can. */
export function feedbackFileNameProblem(fileName: unknown): string | null {
  if (typeof fileName !== 'string' || !FILE_NAME_RE.test(fileName)) {
    return 'Feedback file names are letters, digits, "." "_" "-" (up to 120 characters), must not start with a dot, and end in .json.'
  }
  return null
}

/** Why `content` cannot be a feedback file (a JSON object, at most 1 MB), or `null`. */
export function feedbackContentProblem(content: unknown): string | null {
  if (typeof content !== 'string') return 'Feedback content must be a string.'
  if (Buffer.byteLength(content, 'utf-8') > MAX_FEEDBACK_BYTES) return 'Feedback content is larger than 1 MB.'
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'Feedback content is not valid JSON.'
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? null
    : 'Feedback content must be a JSON object.'
}

/** Absolute path of the feedback folder under `annotationsDir`. */
export function feedbackDirIn(annotationsDir: string): string {
  return path.join(annotationsDir, FEEDBACK_DIR)
}

/** Absolute target for `fileName` in the feedback folder; throws on a bad name. */
export function feedbackTarget(annotationsDir: string, fileName: string): string {
  const problem = feedbackFileNameProblem(fileName)
  if (problem) throw new Error(problem)
  const dir = feedbackDirIn(annotationsDir)
  const target = path.join(dir, fileName)
  if (path.dirname(target) !== dir) throw new Error(`Refusing a feedback path outside the feedback folder: "${fileName}"`)
  return target
}
