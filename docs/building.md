# Build SaiLoR from source

SaiLoR uses Tauri v2. Build each OS on that OS.

## Quick start

1. Run `make setup`. The script asks before each installation.
2. Run `make check` to verify the setup.
3. Run `make dev` to start the app.
4. Run `make build` to create installers for your OS.

## Prerequisites

| OS | Required |
| --- | --- |
| macOS 15 or later | Xcode Command Line Tools, Node.js 22 or later, Rust |
| Windows 10 or later | MSVC Build Tools (C++ workload), WebView2, Node.js 22 or later, Rust |
| Linux | webkit2gtk 4.1 and related libraries, Node.js 22 or later, Rust |

Run `make setup` to install these. See <https://v2.tauri.app/start/prerequisites/> for details.

## Installer output

Find installers in `src-tauri/target/release/bundle/`.

| OS | Formats |
| --- | --- |
| macOS | `.app`, `.dmg` |
| Windows | NSIS `.exe` |
| Linux | AppImage, `.deb`, `.rpm` |

## Build in Docker (Linux only)

Run `make docker-linux`. The command builds the Linux bundles in an Ubuntu 22.04 container.
You need no local Node.js or Rust.

Caution: Docker cannot build the macOS bundles. Apple licence terms require Apple hardware.
Docker cannot reliably build the Windows installer either. Use a native Windows machine or CI.
The Docker build makes unsigned bundles without updater files. The `release` workflow builds all platforms on native runners.

## Common problems

- If `make dev` fails with a missing library on Linux, run `make setup` again.
- If the build runs out of disk space, run `make clean`.
