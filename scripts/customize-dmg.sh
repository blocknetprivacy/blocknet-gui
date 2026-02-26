#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
    echo "DMG customization is macOS-only, skipping."
    exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTRUCTIONS_SRC="$ROOT_DIR/scripts/dmg-install-instructions.txt"

OUT_DMG="${1:-}"
APP_PATH="${2:-$ROOT_DIR/src-tauri/target/release/bundle/macos/blocknet.app}"

if [[ -z "$OUT_DMG" ]]; then
  OUT_DMG="$(ls -t "$ROOT_DIR"/src-tauri/target/release/bundle/dmg/blocknet_*_aarch64.dmg 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$OUT_DMG" ]]; then
  echo "Could not determine output DMG path."
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found: $APP_PATH"
  exit 1
fi

if [[ ! -f "$INSTRUCTIONS_SRC" ]]; then
  echo "Instructions file not found: $INSTRUCTIONS_SRC"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

STAGE_DIR="$TMP_DIR/dmg-root"
mkdir -p "$STAGE_DIR"

cp -R "$APP_PATH" "$STAGE_DIR/blocknet.app"
ln -s /Applications "$STAGE_DIR/Applications"
cp "$INSTRUCTIONS_SRC" "$STAGE_DIR/INSTALL INSTRUCTIONS.txt"

mkdir -p "$(dirname "$OUT_DMG")"
hdiutil create -volname "Blocknet" -srcfolder "$STAGE_DIR" -ov -format UDZO "$OUT_DMG" >/dev/null

echo "Created DMG with installer instructions:"
echo "  $OUT_DMG"
