#!/usr/bin/env bash
# Install build prerequisites for SaiLoR on macOS and Linux.
# Every install step asks first. Nothing changes without a "y".
set -u

NODE_MIN=22

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

confirm() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# choose "question" "label 1" "cmd 1" "label 2" "cmd 2" ...
# Prints the options, runs the command the user picks, or skips.
choose() {
  local question="$1"; shift
  local labels=() cmds=() i reply
  while [ $# -ge 2 ]; do labels+=("$1"); cmds+=("$2"); shift 2; done
  say ""
  say "$question"
  for i in "${!labels[@]}"; do say "  $((i + 1))) ${labels[$i]}"; done
  say "  s) Skip"
  read -r -p "Choice: " reply
  if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "${#cmds[@]}" ]; then
    say "Running: ${cmds[$((reply - 1))]}"
    bash -c "${cmds[$((reply - 1))]}"
  else
    say "Skipped."
  fi
}

node_ok() {
  have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MIN" ]
}

OS="$(uname -s)"
say "Detected OS: $OS"
say "This script checks: build tools, Node.js >= $NODE_MIN, Rust, Tauri system libraries."

PM=""
case "$OS" in
  Darwin)
    if ! xcode-select -p >/dev/null 2>&1; then
      choose "Xcode Command Line Tools are missing." \
        "Install with xcode-select (opens a dialog)" "xcode-select --install"
    else
      say "OK: Xcode Command Line Tools"
    fi
    have brew && PM=brew
    if [ -z "$PM" ]; then
      say "Homebrew not found. It is optional. Node and Rust can use other methods."
      choose "Install Homebrew?" \
        "Official installer (https://brew.sh)" \
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      have brew && PM=brew
    fi
    ;;
  Linux)
    for p in apt-get dnf pacman zypper; do have "$p" && PM="$p" && break; done
    [ -n "$PM" ] && say "Package manager: $PM" || say "No supported package manager found (apt-get, dnf, pacman, zypper)."
    SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
    case "$PM" in
      apt-get)
        PKGS="build-essential curl wget file pkg-config libssl-dev libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev patchelf"
        CHECK='dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1 && have cc'
        INSTALL="$SUDO apt-get update && $SUDO apt-get install -y $PKGS" ;;
      dnf)
        PKGS="webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel patchelf"
        CHECK='rpm -q webkit2gtk4.1-devel >/dev/null 2>&1 && have cc'
        INSTALL="$SUDO dnf group install -y c-development && $SUDO dnf install -y $PKGS" ;;
      pacman)
        PKGS="webkit2gtk-4.1 base-devel curl wget file openssl xdotool libayatana-appindicator librsvg patchelf"
        CHECK='pacman -Q webkit2gtk-4.1 >/dev/null 2>&1 && have cc'
        INSTALL="$SUDO pacman -S --needed $PKGS" ;;
      zypper)
        PKGS="webkit2gtk3-devel libopenssl-devel curl wget file libappindicator3-1 librsvg-devel xdotool-devel patchelf"
        CHECK='rpm -q webkit2gtk3-devel >/dev/null 2>&1 && have cc'
        INSTALL="$SUDO zypper install -y -t pattern devel_basis && $SUDO zypper install -y $PKGS" ;;
      *) CHECK="" ;;
    esac
    if [ -n "$PM" ]; then
      if eval "$CHECK"; then
        say "OK: Tauri system libraries"
      else
        say "Missing Tauri system libraries. Packages: $PKGS"
        choose "Install them with $PM? (needs sudo)" "$PM: $PKGS" "$INSTALL"
      fi
    else
      say "Install the Tauri Linux libraries by hand: https://v2.tauri.app/start/prerequisites/#linux"
    fi
    ;;
  *)
    say "Unsupported OS: $OS. On Windows, run scripts/setup.ps1."
    exit 1 ;;
esac

if node_ok; then
  say "OK: Node.js $(node -v)"
else
  say "Node.js >= $NODE_MIN not found."
  opts=()
  [ "$PM" = brew ] && opts+=("Homebrew: brew install node@$NODE_MIN" "brew install node@$NODE_MIN && brew link --overwrite node@$NODE_MIN")
  [ "$PM" = apt-get ] && opts+=("apt (NodeSource $NODE_MIN.x, runs a remote script as root)" "curl -fsSL https://deb.nodesource.com/setup_$NODE_MIN.x | sudo -E bash - && sudo apt-get install -y nodejs")
  [ "$PM" = dnf ] && opts+=("dnf: nodejs (version depends on distro)" "sudo dnf install -y nodejs")
  [ "$PM" = pacman ] && opts+=("pacman: nodejs-lts-jod" "sudo pacman -S --needed nodejs-lts-jod npm")
  [ "$PM" = zypper ] && opts+=("zypper: nodejs$NODE_MIN" "sudo zypper install -y nodejs$NODE_MIN")
  opts+=("fnm (Node version manager, user-local)" "curl -fsSL https://fnm.vercel.app/install | bash && \"\$HOME/.local/share/fnm/fnm\" install $NODE_MIN")
  opts+=("nvm (Node version manager, user-local)" "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . \"\$HOME/.nvm/nvm.sh\" && nvm install $NODE_MIN")
  choose "How to install Node.js $NODE_MIN?" "${opts[@]}"
  say "Open a new shell afterwards so PATH updates apply."
fi

if have rustc && have cargo; then
  say "OK: $(rustc --version)"
else
  say "Rust not found."
  opts=("rustup official installer (https://rustup.rs, user-local, recommended)" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh")
  [ "$PM" = brew ] && opts+=("Homebrew: brew install rustup, then rustup-init" "brew install rustup && rustup-init")
  choose "How to install Rust?" "${opts[@]}"
  say "Open a new shell afterwards so PATH updates apply."
fi

if have node && [ -f package.json ] && [ ! -d node_modules ]; then
  confirm "Install npm dependencies now (npm ci)?" && npm ci
fi

say ""
say "Done. Run 'make check' to verify the setup."
