#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle"
OUT_DIR="$ROOT_DIR/builds"
VERSION="$(node -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")"

mkdir -p "$OUT_DIR"

copied=0
copy_if_exists() {
    local src="$1"
    local dest_name="$2"
    if [[ -f "$src" ]]; then
        cp -f "$src" "$OUT_DIR/$dest_name"
        echo "  $dest_name"
        copied=$((copied + 1))
    fi
}

echo "Collecting build artifacts v${VERSION}..."

# Linux
copy_if_exists "$BUNDLE_DIR/deb/blocknet_${VERSION}_amd64.deb"                     "blocknet-amd64-linux-blocknet_${VERSION}_amd64.deb"
copy_if_exists "$BUNDLE_DIR/rpm/blocknet-${VERSION}-1.x86_64.rpm"                  "blocknet-amd64-linux-blocknet_${VERSION}_x86_64.rpm"
copy_if_exists "$BUNDLE_DIR/appimage/blocknet_${VERSION}_amd64.AppImage"            "blocknet-amd64-linux-blocknet_${VERSION}_amd64.AppImage"
copy_if_exists "$BUNDLE_DIR/flatpak/blocknet_${VERSION}_amd64.flatpak"              "blocknet-amd64-linux-blocknet_${VERSION}_amd64.flatpak"

# macOS
copy_if_exists "$BUNDLE_DIR/dmg/blocknet_${VERSION}_aarch64.dmg"                   "blocknet-arm64-darwin-blocknet_${VERSION}_aarch64.dmg"

# Windows
copy_if_exists "$BUNDLE_DIR/nsis/blocknet_${VERSION}_x64-setup.exe"                "blocknet-amd64-windows-blocknet_${VERSION}_amd64.exe"
copy_if_exists "$BUNDLE_DIR/msi/blocknet_${VERSION}_x64_en-US.msi"                 "blocknet-amd64-windows-blocknet_${VERSION}_x64.msi"

if [[ $copied -eq 0 ]]; then
    echo "No artifacts found."
    exit 1
fi

# Checksums
cd "$OUT_DIR"
sha256sum blocknet-* 2>/dev/null | sort > SHA256SUMS.txt

echo ""
echo "SHA256SUMS.txt:"
cat SHA256SUMS.txt
echo ""
echo "Done — $copied artifact(s) in $OUT_DIR"
