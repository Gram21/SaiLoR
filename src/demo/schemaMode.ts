import { DEMO_MODE } from './mode'

/**
 * True only in the online demo opened with `?mode=schema`. That demo opens the
 * project editor on a new project, and its save downloads project.json.
 */
export const DEMO_SCHEMA_MODE: boolean = DEMO_MODE && new URLSearchParams(window.location.search).get('mode') === 'schema'
