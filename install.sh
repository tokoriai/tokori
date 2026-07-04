#!/usr/bin/env bash
# Tokori one-line installer for Linux.
#
# Usage (default — pick the best installer for this system):
#   curl -fsSL https://tokori.ai/install.sh | bash
#
# Pin a version:
#   curl -fsSL https://tokori.ai/install.sh | TOKORI_VERSION=v0.1.1 bash
#
# Force a format (one of: deb, rpm, appimage):
#   curl -fsSL https://tokori.ai/install.sh | TOKORI_FORMAT=appimage bash
#
# Use a fork:
#   curl -fsSL https://tokori.ai/install.sh | TOKORI_REPO=you/tokori bash

set -euo pipefail

REPO="${TOKORI_REPO:-tokoriai/tokori}"
VERSION="${TOKORI_VERSION:-latest}"
FORMAT="${TOKORI_FORMAT:-auto}"

err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

case "$(uname -s)" in
  Linux) : ;;
  *) err "This script is for Linux. On macOS/Windows download from https://tokori.ai/download" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) err "arm64 Linux builds aren't published yet — build from source: https://tokori.ai/docs/guides/build-from-source" ;;
  *) err "Unsupported architecture: $(uname -m)" ;;
esac

for cmd in curl; do
  command -v "$cmd" >/dev/null || err "Missing required command: $cmd"
done

if [ "$FORMAT" = "auto" ]; then
  if command -v apt >/dev/null && command -v sudo >/dev/null; then
    FORMAT=deb
  elif { command -v dnf >/dev/null || command -v zypper >/dev/null; } && command -v sudo >/dev/null; then
    FORMAT=rpm
  else
    # Arch (no apt/dnf) and everything else get the portable AppImage —
    # Arch users who want a managed install should use the AUR package
    # (`yay -S tokori-bin`); see the install guide.
    FORMAT=appimage
  fi
fi

# Resolve which release to pull. The GitHub redirect for /releases/latest/...
# only works once a non-draft release exists, so we hit the API for both
# `latest` and pinned versions — it's one extra request and avoids surprises.
api_url() {
  if [ "$VERSION" = "latest" ]; then
    echo "https://api.github.com/repos/${REPO}/releases/latest"
  else
    echo "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
  fi
}

info "Fetching release metadata from ${REPO}@${VERSION}"
RELEASE_JSON="$(curl -fsSL "$(api_url)")" || err "Could not fetch release info — check the version exists at https://github.com/${REPO}/releases"

# Pick the asset URL by suffix without pulling in jq.
asset_url_by_suffix() {
  local suffix="$1"
  printf '%s\n' "$RELEASE_JSON" \
    | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | grep -oE 'https?://[^"]+' \
    | grep -E "${suffix}$" \
    | head -n1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$FORMAT" in
  deb)
    URL="$(asset_url_by_suffix "_${ARCH}\\.deb")"
    [ -n "$URL" ] || err "No .deb asset found in this release"
    OUT="${TMP}/tokori.deb"
    info "Downloading $(basename "$URL")"
    curl -fL --progress-bar -o "$OUT" "$URL"
    info "Installing with apt (you'll be asked for sudo)"
    sudo apt install -y "$OUT"
    ok "Installed — launch from your app menu or run: tokori"
    ;;

  rpm)
    # Tauri names the rpm with the rpm arch token (x86_64), not amd64.
    URL="$(asset_url_by_suffix "x86_64\\.rpm")"
    [ -n "$URL" ] || err "No .rpm asset found in this release"
    OUT="${TMP}/tokori.rpm"
    info "Downloading $(basename "$URL")"
    curl -fL --progress-bar -o "$OUT" "$URL"
    info "Installing (you'll be asked for sudo)"
    if command -v dnf >/dev/null; then
      sudo dnf install -y "$OUT"
    elif command -v zypper >/dev/null; then
      sudo zypper install -y --allow-unsigned-rpm "$OUT"
    else
      sudo rpm -i "$OUT"
    fi
    ok "Installed — launch from your app menu or run: tokori"
    ;;

  appimage)
    URL="$(asset_url_by_suffix "_${ARCH}\\.AppImage")"
    [ -n "$URL" ] || err "No .AppImage asset found in this release"
    DEST_DIR="${TOKORI_INSTALL_DIR:-$HOME/.local/bin}"
    mkdir -p "$DEST_DIR"
    DEST="${DEST_DIR}/tokori"
    info "Downloading $(basename "$URL") to ${DEST}"
    curl -fL --progress-bar -o "$DEST" "$URL"
    chmod +x "$DEST"
    if ! printf '%s' "$PATH" | tr ':' '\n' | grep -Fxq "$DEST_DIR"; then
      printf '\033[33m!\033[0m %s is not on your PATH. Add this to your shell rc:\n    export PATH="%s:$PATH"\n' "$DEST_DIR" "$DEST_DIR"
    fi
    ok "Installed — run: tokori"
    ;;

  *)
    err "Unknown TOKORI_FORMAT: ${FORMAT} (expected: deb, rpm, appimage, or auto)"
    ;;
esac
