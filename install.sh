#!/bin/sh
set -eu

REPO="dittofleet/weblab"
DEST="${WEBLAB_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=weblab-darwin-arm64 ;;
  Darwin-x86_64) ASSET=weblab-darwin-x64 ;;
  Linux-x86_64) ASSET=weblab-linux-x64 ;;
  *) echo "weblab runs on macOS, and on Linux on x86_64." >&2; exit 1 ;;
esac

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
