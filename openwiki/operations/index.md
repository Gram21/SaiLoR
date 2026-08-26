# Files

- [Build, CI, and Release](build-release.md) - The Vite + vite-plugin-electron build pipeline, the provider-agnostic CI/electron-builder packaging scripts, GitHub Actions workflows, Ed25519 release signing, Docker Electron builds, and wiki sync mechanics.
- [Electron Main Process and IPC](electron-shell.md) - The Electron desktop shell — the main process that owns all filesystem/git/LLM access, the preload `window.slr` bridge, the CORS-enabled path-traversal-guarded `slr-file://` protocol, IPC handler groups, the self-update pipeline, and quit/unsaved-changes coordination.
