#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname)" != "Linux" ]]; then
    echo "Flatpak build is Linux-only, skipping."
    exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLATPAK_DIR="$ROOT_DIR/flatpak"
STAGE_DIR="$FLATPAK_DIR/stage"
BUILD_DIR="$FLATPAK_DIR/build-dir"
REPO_DIR="$FLATPAK_DIR/repo"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/flatpak"
VERSION="$(node -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")"
BUNDLE_OUT="$BUNDLE_DIR/blocknet_${VERSION}_amd64.flatpak"
RUNTIME_VERSION="48"

# --- Prerequisites ---

if command -v flatpak-builder &>/dev/null; then
    FLATPAK_BUILDER="flatpak-builder"
elif flatpak info org.flatpak.Builder &>/dev/null 2>&1; then
    FLATPAK_BUILDER="flatpak run org.flatpak.Builder"
else
    echo "flatpak-builder not found."
    echo "Install with: sudo pacman -S flatpak-builder"
    echo "    or: flatpak install flathub org.flatpak.Builder"
    exit 1
fi

if ! flatpak info org.gnome.Platform//$RUNTIME_VERSION &>/dev/null 2>&1; then
    echo "Installing GNOME Platform $RUNTIME_VERSION runtime..."
    flatpak install --noninteractive flathub \
        org.gnome.Platform//$RUNTIME_VERSION \
        org.gnome.Sdk//$RUNTIME_VERSION 2>/dev/null || \
    flatpak install --user --noninteractive flathub \
        org.gnome.Platform//$RUNTIME_VERSION \
        org.gnome.Sdk//$RUNTIME_VERSION
fi

# --- Stage files ---

mkdir -p "$STAGE_DIR"
cp -f "$ROOT_DIR/src-tauri/target/release/blocknet-wallet"  "$STAGE_DIR/blocknet-wallet"
cp -f "$ROOT_DIR/src-tauri/binaries/blocknet-amd64-linux"   "$STAGE_DIR/blocknet-amd64-linux"
cp -f "$ROOT_DIR/src-tauri/icons/128x128.png"               "$STAGE_DIR/128x128.png"
cp -f "$ROOT_DIR/src-tauri/icons/128x128@2x.png"            "$STAGE_DIR/128x128@2x.png"
chmod +x "$STAGE_DIR/blocknet-wallet" "$STAGE_DIR/blocknet-amd64-linux"

# --- Build ---

mkdir -p "$BUNDLE_DIR"

echo "Building Flatpak..."
$FLATPAK_BUILDER \
    --force-clean \
    --repo="$REPO_DIR" \
    "$BUILD_DIR" \
    "$FLATPAK_DIR/com.blocknet.wallet.yml"

echo "Exporting .flatpak bundle..."
flatpak build-bundle \
    "$REPO_DIR" \
    "$BUNDLE_OUT" \
    com.blocknet.wallet \
    --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

echo "Flatpak bundle: $BUNDLE_OUT"
