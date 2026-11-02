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

## Run the app in a container (Linux only)

Use this to run SaiLoR in a browser tab. The container starts the app on a virtual display.
You need Docker only. Node.js and Rust are not needed.

### Start the app

1. Run `make docker-gui`. The first run builds the image. This takes a long time.
2. Open `http://localhost:6080` in a browser.
3. In SaiLoR, open a project from the `/data` folder.
4. Close SaiLoR to stop the container.

Warning: Create the `projects` folder before you run the container. Docker creates a missing folder as root.
Then SaiLoR cannot save files on Linux. The `make docker-gui` target creates the folder for you.

To run without `make`, use these commands:

```sh
docker build -f Dockerfile.tauri-linux-gui -t sailor-gui .
mkdir -p projects
docker run --rm -p 127.0.0.1:6080:6080 -v "$PWD/projects:/data" -v sailor-home:/home/sailor sailor-gui
```

### Settings

| Setting | Default | How to change it |
| --- | --- | --- |
| Project folder | `./projects` on the host, `/data` in the container | Change the left side of the `-v` option |
| App settings | Named volume `sailor-home` | Remove the volume to reset the settings |
| Screen size | `1440x900` | Set `SCREEN_RESOLUTION`, for example `SCREEN_RESOLUTION=1920x1080 make docker-gui` |
| VNC password | Not set | Set `VNC_PASSWORD`, for example `VNC_PASSWORD=secret12 make docker-gui` |
| Browser address | `http://localhost:6080` | Port `6080` is bound to `127.0.0.1` only |

Caution: The VNC protocol uses the first 8 characters of the password only.

### Use a VNC client

Use a VNC client if noVNC is too slow. Port 5900 accepts VNC clients only with a password.

1. Start the container with a password and the listen option:

   ```sh
   docker run --rm -p 127.0.0.1:6080:6080 -p 127.0.0.1:5900:5900 \
     -e VNC_PASSWORD=secret12 -e VNC_LISTEN_ALL=1 \
     -v "$PWD/projects:/data" -v sailor-home:/home/sailor sailor-gui
   ```

2. Connect the VNC client to `localhost:5900`.

Caution: The container refuses to start with `VNC_LISTEN_ALL=1` and no `VNC_PASSWORD`.

### Limits

- The container uses software rendering. Screen updates can be slow.
- File dialogs use the GTK dialogs in the virtual display. They show only the container file system.
  Files outside `/data` and `sailor-home` are not visible.
- The image contains Git and the SSH client. Local Git actions work on projects in `/data`.
  The image marks every folder as a safe Git directory, so mounted projects work with any owner.
- The container has no Git credentials. To push or pull over SSH, add `-v "$HOME/.ssh:/home/sailor/.ssh:ro"` to the run command.
  For HTTPS remotes, push and pull from the host instead.
- The container stores AI settings in `/home/sailor/.sailor`. The `sailor-home` volume keeps them.
- The container does not update SaiLoR. Build a new image for a new version.
- The container has no system keychain. SaiLoR cannot save LLM API keys.
  Targets that need no key still work. Use the desktop builds for API keys.
- The image uses the CPU architecture of your Docker host.

Caution: Do not publish ports 6080 or 5900 to a network interface. Keep them bound to `127.0.0.1`.
Anyone who reaches these ports can view and control the desktop.
Set a `VNC_PASSWORD` before you use a VNC client.

## Common problems

- If `make dev` fails with a missing library on Linux, run `make setup` again.
- If the build runs out of disk space, run `make clean`.
