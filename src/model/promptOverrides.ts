import { t } from '../i18n'
import type { ResolvedDef } from './schema'
export interface PromptOverrides {
  role?: string
  fieldHelp?: Record<string, string>
  examples?: string
}

export const PROMPT_OVERRIDE_LIMITS = { role: 1000, fieldHelp: 2000, fieldHelpKey: 500, examples: 8000 } as const

const KEYS = new Set(['role', 'fieldHelp', 'examples'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// [impl->req~llm-791~1]
export function parsePromptOverrides(raw: unknown): { overrides?: PromptOverrides; problems: string[] } {
  const problems: string[] = []
  if (raw === undefined) return { problems }
  if (!isRecord(raw)) return { problems: [t('promptOverrides.problem.type')] }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) problems.push(t('promptOverrides.problem.unknownKey', { key }))
  }
  const text = (key: 'role' | 'examples'): string | undefined => {
    const v = raw[key]
    if (v === undefined) return undefined
    if (typeof v !== 'string') {
      problems.push(t('promptOverrides.problem.notText', { key }))
      return undefined
    }
    if (v.length > PROMPT_OVERRIDE_LIMITS[key]) {
      problems.push(t('promptOverrides.problem.tooLong', { key, max: PROMPT_OVERRIDE_LIMITS[key] }))
    }
    return v
  }
  const role = text('role')
  const examples = text('examples')
  const fieldHelp: Record<string, string> = {}
  if (raw.fieldHelp !== undefined) {
    if (!isRecord(raw.fieldHelp)) problems.push(t('promptOverrides.problem.fieldHelpType'))
    else {
      for (const [path, v] of Object.entries(raw.fieldHelp)) {
        const key = `fieldHelp.${path}`
        if (!path.trim() || path.length > PROMPT_OVERRIDE_LIMITS.fieldHelpKey) {
          problems.push(t('promptOverrides.problem.badPath', { path }))
        } else if (typeof v !== 'string') {
          problems.push(t('promptOverrides.problem.notText', { key }))
        } else if (v.length > PROMPT_OVERRIDE_LIMITS.fieldHelp) {
          problems.push(t('promptOverrides.problem.tooLong', { key, max: PROMPT_OVERRIDE_LIMITS.fieldHelp }))
        } else fieldHelp[path] = v
      }
    }
  }
  if (problems.length > 0) return { problems }
  const overrides = cleanPromptOverrides({ role, examples, fieldHelp })
  return overrides ? { overrides, problems } : { problems }
}

// [impl->req~llm-790~1]
export function cleanPromptOverrides(o: PromptOverrides | null | undefined): PromptOverrides | undefined {
  if (!o) return undefined
  const out: PromptOverrides = {}
  if (o.role?.trim()) out.role = o.role.trim()
  if (o.examples?.trim()) out.examples = o.examples.trim()
  const help = Object.entries(o.fieldHelp ?? {}).filter(([, v]) => v.trim())
  if (help.length > 0) out.fieldHelp = Object.fromEntries(help.map(([k, v]) => [k, v.trim()]))
  return Object.keys(out).length > 0 ? out : undefined
}

// [impl->req~llm-793~1]
export function promptOverridesTag(o: PromptOverrides | undefined): string {
  const clean = cleanPromptOverrides(o)
  if (!clean) return ''
  const text = JSON.stringify([clean.role ?? '', clean.examples ?? '', Object.entries(clean.fieldHelp ?? {}).sort()])
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `overrides-${h.toString(36)}`
}

// [impl->req~llm-792~1]
export function applyFieldHelp(schema: ResolvedDef[], help: Record<string, string> | undefined): ResolvedDef[] {
  if (!help || Object.keys(help).length === 0) return schema
  const walk = (defs: ResolvedDef[]): ResolvedDef[] =>
    defs.map((d) => ({
      ...d,
      ...(help[d.id] ? { description: help[d.id] } : {}),
      children: walk(d.children),
    }))
  return walk(schema)
}
