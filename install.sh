#!/usr/bin/env bash
# Browy installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash
#
# What it does:
#   1. Detects platform (darwin-x64, darwin-arm64, linux-x64, linux-arm64)
#   2. Downloads the matching Browy-<version>-<target>.tar.gz from GitHub Releases
#   3. Extracts to ~/.browy/app/  (includes the browser extension)
#   4. Runs the bundled install-host to register the native messaging manifest
#      for Chrome, Edge, and Brave.
#   5. Opens the extension folder + chrome://extensions so you can Load unpacked.
#
# Override version: BROWY_VERSION=0.2.1 curl ... | bash
# Override repo:    BROWY_REPO=youruser/yourfork curl ... | bash
# Test/local mode:  BROWY_LOCAL_TARBALL=/path/to/Browy-x.tar.gz bash install.sh
# Skip browser open: BROWY_NO_OPEN=1 curl ... | bash

set -euo pipefail

REPO="${BROWY_REPO:-browyhq/browy}"
INSTALL_DIR="${BROWY_INSTALL_DIR:-$HOME/.browy/app}"

# 1. Detect target
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s-$uname_m" in
  Darwin-arm64)        TARGET="darwin-arm64" ;;
  Darwin-x86_64)       TARGET="darwin-x64" ;;
  Linux-x86_64)        TARGET="linux-x64" ;;
  Linux-aarch64)       TARGET="linux-arm64" ;;
  Linux-arm64)         TARGET="linux-arm64" ;;
  *)
    echo "Browy: unsupported platform: $uname_s-$uname_m" >&2
    echo "Supported: macOS (Intel/Apple Silicon), Linux (x86_64/arm64)" >&2
    exit 1
    ;;
esac
echo "Browy: detected $TARGET"

# 2. Resolve version (default: latest release tag)
if [ -z "${BROWY_VERSION:-}" ]; then
  echo "Browy: looking up latest release..."
  if command -v curl >/dev/null 2>&1; then
    BROWY_VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')"
  else
    echo "Browy: need curl to resolve version. Install curl or pass BROWY_VERSION=..." >&2
    exit 1
  fi
  if [ -z "$BROWY_VERSION" ]; then
    echo "Browy: failed to resolve latest version. Pass BROWY_VERSION=x.y.z explicitly." >&2
    exit 1
  fi
fi
echo "Browy: version $BROWY_VERSION"

# 3. Download tarball (or use local for testing)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/browy.tar.gz"

if [ -n "${BROWY_LOCAL_TARBALL:-}" ]; then
  echo "Browy: using local tarball $BROWY_LOCAL_TARBALL"
  cp "$BROWY_LOCAL_TARBALL" "$TARBALL"
else
  URL="https://github.com/$REPO/releases/download/v$BROWY_VERSION/Browy-$BROWY_VERSION-$TARGET.tar.gz"
  echo "Browy: downloading $URL"
  curl -fSL --progress-bar -o "$TARBALL" "$URL"
fi

# 4. Stop any running native host so we can overwrite the binary on Linux
#    (macOS/Linux happily replace open files; this is belt-and-braces).
pkill -f "browy.*native-host" 2>/dev/null || true

# 5. Wipe previous install and extract
mkdir -p "$INSTALL_DIR"
# Only wipe known subdirs so we don't nuke a user-placed file by mistake
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/extension" \
       "$INSTALL_DIR/node" "$INSTALL_DIR/package.json" "$INSTALL_DIR/package-lock.json" \
       "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh" "$INSTALL_DIR/README.txt"

echo "Browy: extracting to $INSTALL_DIR"
tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1

# 6. Register native host for installed browsers
echo "Browy: registering native messaging host..."
"$INSTALL_DIR/node" "$INSTALL_DIR/dist/cli-bin.js" install-host

# 7. Copy the extension to ~/Downloads so the user can Load unpacked from a
#    folder they can actually find. Refreshed every install so it stays in
#    sync with the host. Chrome's unpacked-extension entry points at THIS path.
DOWNLOADS_DIR="$HOME/Downloads"
if command -v xdg-user-dir >/dev/null 2>&1; then
  _xdg="$(xdg-user-dir DOWNLOAD 2>/dev/null || true)"
  [ -n "$_xdg" ] && DOWNLOADS_DIR="$_xdg"
fi
mkdir -p "$DOWNLOADS_DIR"
EXT_DIR="$DOWNLOADS_DIR/Browy-Extension"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -R "$INSTALL_DIR/extension/." "$EXT_DIR/"

# 8. Done
echo ""
echo "✓ Browy $BROWY_VERSION installed to $INSTALL_DIR"
echo ""
echo "To finish setup, load the extension into Chrome / Edge / Brave:"
echo "  1. Open chrome://extensions"
echo "  2. Enable 'Developer mode' (top-right)"
echo "  3. Click 'Load unpacked' and select:"
echo "     $EXT_DIR"
echo "  4. Pin Browy and click it to open the side panel"
echo ""
echo "To uninstall:  $INSTALL_DIR/uninstall.sh && rm -rf $INSTALL_DIR $EXT_DIR"

# 9. Optionally open the folder + chrome://extensions for the user.
if [ -z "${BROWY_NO_OPEN:-}" ] && [ -d "$EXT_DIR" ]; then
  if [ "$uname_s" = "Darwin" ]; then
    open "$EXT_DIR" 2>/dev/null || true
    open "chrome://extensions" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$EXT_DIR" >/dev/null 2>&1 || true
    xdg-open "chrome://extensions" >/dev/null 2>&1 || true
  fi
fi
