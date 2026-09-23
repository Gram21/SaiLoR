/**
 * When SaiLoR may fetch on its own, and how quietly.
 *
 * The toolbar's "↓ N to pull" count is only as fresh as the last fetch, so the
 * app fetches in the background — right after a project opens, whenever the
 * Git panel opens, and every {@link BACKGROUND_FETCH_INTERVAL_MS} after that.
 *
 * That crosses a boundary the rest of the git integration is built around (see
 * `GIT_SAFE_CONFIG` in `electron/main.ts`): commands a repository's own config
 * names — an ssh command, a credential helper — are left enabled only because
 * they run on a network action the reviewer asked for, never merely because a
 * folder was opened. A project folder that arrives by zip, USB or shared drive
 * brings its `.git/config` along, and a fetch nobody asked for would run
 * whatever that config says. So a background fetch is refused for a repository
 * whose *own* config names such a command, or pulls in another config file that
 * could (git does not show what an include contains when asked about one file).
 * Those repositories keep the count their local refs give, and fetch when the
 * reviewer presses Pull — exactly as before. Ordinary setups keep credential
 * helpers and ssh settings in the user's global config, and are unaffected.
 *
 * Pure, and in `src/git/`, for the same reason as the rest of this folder: it
 * is a security decision, and `electron/` is outside vitest's scope.
 */

/** How often the background fetch runs while a project in a repository is open. */
export const BACKGROUND_FETCH_INTERVAL_MS = 120_000

/** A background fetch that has not finished by now is abandoned — far shorter
 *  than the fifteen minutes an explicit pull is given, so a stalled network
 *  cannot hold one open across many intervals. */
export const BACKGROUND_FETCH_TIMEOUT_MS = 60_000

/**
 * Repository-local config keys under which git runs a command during a fetch,
 * or which can bring in more config that might: as `git config --get-regexp`
 * matches them, against names git has already lower-cased.
 *
 *  - `core.sshCommand`, `core.gitProxy`, `core.askPass` — run to connect or to
 *    ask for a password.
 *  - `credential.helper` and `credential.<url>.helper` — run to fetch a
 *    password.
 *  - `remote.<name>.uploadpack` / `.receivepack` — for a remote that is a local
 *    path, run on this machine.
 *  - `include.path` / `includeIf.<condition>.path` — pull in a file whose
 *    contents a single-file query cannot see.
 */
export const FETCH_COMMAND_KEYS =
  '^(core\\.(sshcommand|gitproxy|askpass)|credential\\..*helper|remote\\..*\\.(uploadpack|receivepack)|include\\.path|includeif\\..*\\.path)$'

/** Is this repository's own config free of anything a background fetch would
 *  run? `localKeyNames` is `git config --local --name-only --get-regexp`
 *  output for {@link FETCH_COMMAND_KEYS}: one matching name per line. */
export function backgroundFetchAllowed(localKeyNames: string): boolean {
  return localKeyNames.trim() === ''
}

/**
 * Environment for a fetch nobody is watching. It must fail rather than ask:
 * Git Credential Manager would open a login window, ssh or an editor's askpass
 * helper a password dialog — every two minutes, out of nowhere. Terminal
 * prompts are already off for every git call (`GIT_TERMINAL_PROMPT`).
 */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
}
