#!/bin/sh
set -eu

REPO="dittofleet/weblab"
DEST="${WEBLAB_INSTALL_DIR:-$HOME/.local/bin}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "weblab runs on macOS." >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="weblab-darwin-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

mkdir -p "$DEST"
# Staged inside the destination so the install is a same-filesystem
# rename. Downloading to $TMPDIR would make the final step a copy over the
# live binary, which an interruption could leave truncated.
TMP=$(mktemp "$DEST/.weblab.XXXXXX")
trap 'rm -f "$TMP"' EXIT

echo "Downloading $URL..." >&2
curl -fsSL "$URL" -o "$TMP"
chmod 755 "$TMP"
mv "$TMP" "$DEST/weblab"
echo "Installed weblab to $DEST/weblab" >&2

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not in \$PATH. Add it to your shell profile to use weblab." >&2 ;;
esac
