#!/usr/bin/env bash
# Install the Chat Memory Window *server plugin* into a SillyTavern installation.
#
# The frontend half of the extension is installed from the SillyTavern UI
# (Extensions -> Install extension). This script only handles the server plugin,
# which must live in <SillyTavern>/plugins/ and needs enableServerPlugins: true.
#
# Usage:
#   bash install-plugin.sh [path-to-SillyTavern]
#
# If the path is omitted, common install locations are probed, including
# ~/SillyTavern (Termux / Android) and ./SillyTavern.

set -euo pipefail

REPO_URL="${CMW_REPO_URL:-https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git}"
PLUGIN_NAME="chat-memory-window"

info() { printf '\033[36m[info]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

is_sillytavern_root() {
    [ -n "${1:-}" ] && [ -f "$1/server.js" ] && [ -f "$1/public/script.js" ]
}

find_sillytavern() {
    if [ -n "${1:-}" ]; then
        is_sillytavern_root "$1" || die "Not a SillyTavern root (missing server.js / public/script.js): $1"
        printf '%s' "$1"
        return 0
    fi

    local candidate
    for candidate in \
        "$PWD" \
        "$PWD/SillyTavern" \
        "$HOME/SillyTavern" \
        "$HOME/sillytavern" \
        "$HOME/SillyTavern-release" \
        "/opt/SillyTavern" \
        "/usr/local/SillyTavern"; do
        if is_sillytavern_root "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

command -v git >/dev/null 2>&1 || die "git is required but was not found in PATH."

ST_ROOT="$(find_sillytavern "${1:-}")" || die "Could not locate SillyTavern. Pass its path explicitly: bash install-plugin.sh /path/to/SillyTavern"
ST_ROOT="$(cd "$ST_ROOT" && pwd)"
info "SillyTavern root: $ST_ROOT"

PLUGIN_DIR="$ST_ROOT/plugins/$PLUGIN_NAME"
mkdir -p "$ST_ROOT/plugins"

if [ -d "$PLUGIN_DIR/.git" ]; then
    info "Existing plugin checkout found, updating..."
    git -C "$PLUGIN_DIR" pull --ff-only
elif [ -e "$PLUGIN_DIR" ]; then
    warn "$PLUGIN_DIR already exists but is not a git checkout."
    warn "Move it aside and re-run if you want the script to manage it."
else
    info "Cloning server plugin into plugins/$PLUGIN_NAME ..."
    git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
fi

# The plugin directory must expose an entry file for the ST plugin loader.
if [ ! -f "$PLUGIN_DIR/index.mjs" ]; then
    die "index.mjs not found in $PLUGIN_DIR - the checkout looks incomplete."
fi

CONFIG="$ST_ROOT/config.yaml"
if [ -f "$CONFIG" ]; then
    if grep -Eq '^[[:space:]]*enableServerPlugins:[[:space:]]*true[[:space:]]*$' "$CONFIG"; then
        info "enableServerPlugins is already true in config.yaml."
    else
        warn "enableServerPlugins is NOT enabled in $CONFIG"
        warn "Set it to 'true' (config.yaml: enableServerPlugins: true) or the plugin will not load."
    fi
else
    warn "config.yaml not found at $CONFIG - make sure enableServerPlugins is true."
fi

cat <<EOF

Server plugin installed at:
  $PLUGIN_DIR

Next steps:
  1. Make sure config.yaml has: enableServerPlugins: true
  2. Fully restart SillyTavern (server plugins load only at startup).
  3. Hard-refresh the browser (Ctrl + Shift + R), then enable the extension
     in the chat-memory-window settings panel.

Frontend half (if you have not done it yet):
  SillyTavern -> Extensions -> Install extension ->
  $REPO_URL
EOF
