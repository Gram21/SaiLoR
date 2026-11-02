#!/bin/sh
# Starts a virtual X display, a window manager, VNC and noVNC, then SaiLoR.
# The container stops when SaiLoR exits.
#
# Environment:
#   SCREEN_RESOLUTION  Size of the virtual screen, WIDTHxHEIGHT (default 1440x900).
#   VNC_PASSWORD       VNC password. VNC uses 8 characters at most.
#   VNC_LISTEN_ALL     1 to accept raw VNC clients on port 5900 from outside the container.
#                      Requires VNC_PASSWORD.
set -eu

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
RES="${SCREEN_RESOLUTION:-1440x900}"
pids=""

if ! printf '%s' "$RES" | grep -Eq '^[0-9]{3,5}x[0-9]{3,5}$'; then
  echo "SCREEN_RESOLUTION must look like 1440x900." >&2
  exit 2
fi
if [ "${VNC_LISTEN_ALL:-0}" = 1 ] && [ -z "${VNC_PASSWORD:-}" ]; then
  echo "VNC_LISTEN_ALL=1 requires VNC_PASSWORD." >&2
  exit 2
fi

# shellcheck disable=SC2329 # called through trap
cleanup() {
  trap - EXIT INT TERM
  for p in $pids; do
    kill "$p" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${RES}x24" -nolisten tcp &
pids="$pids $!"
i=0
until [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvfb did not start." >&2
    exit 1
  fi
  sleep 0.1
done

openbox --sm-disable &
pids="$pids $!"

if [ -n "${VNC_PASSWORD:-}" ]; then
  passdir="$(mktemp -d)"
  x11vnc -storepasswd "$VNC_PASSWORD" "$passdir/passwd" >/dev/null
  set -- -rfbauth "$passdir/passwd"
else
  echo "warning: VNC_PASSWORD is not set. Anyone who can reach port 6080 sees the desktop." >&2
  set -- -nopw
fi
if [ "${VNC_LISTEN_ALL:-0}" != 1 ]; then
  set -- -localhost "$@"
fi
x11vnc -display "$DISPLAY" -rfbport 5900 -forever -shared -noxdamage "$@" &
pids="$pids $!"

websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &
pids="$pids $!"

dbus-run-session -- /opt/sailor/sailor &
app=$!
pids="$pids $app"
status=0
wait "$app" || status=$?
exit "$status"
