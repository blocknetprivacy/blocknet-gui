#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/src-tauri/binaries"
API_BASE="https://api.github.com/repos/blocknetprivacy/core/releases"
PINNED_VERSION="${BLOCKNET_CORE_VERSION:-}"
if [[ -z "$PINNED_VERSION" && -f "$ROOT_DIR/VERSION" ]]; then
  PINNED_VERSION="$(tr -d '\r\n[:space:]' < "$ROOT_DIR/VERSION")"
fi
if [[ -n "$PINNED_VERSION" ]]; then
  API_URL="$API_BASE/tags/v${PINNED_VERSION}"
else
  API_URL="$API_BASE/latest"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$BIN_DIR"

echo "Fetching Blocknet core release metadata..."
RELEASE_JSON="$TMP_DIR/release.json"
curl -fsSL "$API_URL" -o "$RELEASE_JSON"

extract_asset_url() {
  local asset_name="$1"
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const assetName = process.argv[2];
    const asset = (data.assets || []).find(a => a.name === assetName);
    if (!asset || !asset.browser_download_url) process.exit(1);
    process.stdout.write(asset.browser_download_url);
  " "$RELEASE_JSON" "$asset_name"
}

TAG_NAME="$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(data.tag_name || '');" "$RELEASE_JSON")"
if [[ -z "$TAG_NAME" ]]; then
  echo "Unable to determine latest release tag from $API_URL"
  exit 1
fi

VERSION="${TAG_NAME#v}"
if [[ -n "$PINNED_VERSION" ]]; then
  echo "Pinned core release: $TAG_NAME"
else
  echo "Latest core release: $TAG_NAME"
fi

MAC_ASSET="blocknet-core-arm64-macos-${VERSION}.zip"
LINUX_ASSET="blocknet-core-amd64-linux-${VERSION}.zip"
WIN_ASSET="blocknet-core-amd64-windows-${VERSION}.zip"

MAC_URL="$(extract_asset_url "$MAC_ASSET")"
LINUX_URL="$(extract_asset_url "$LINUX_ASSET")"
WIN_URL="$(extract_asset_url "$WIN_ASSET")"

if [[ -z "$MAC_URL" || -z "$LINUX_URL" || -z "$WIN_URL" ]]; then
  echo "Missing required release assets for version ${VERSION}"
  exit 1
fi

download_and_install() {
  local url="$1"
  local zip_name="$2"
  local extracted_name="$3"
  local target_name="$4"
  local target_path="$BIN_DIR/$target_name"

  echo "Downloading $zip_name..."
  curl -fsSL "$url" -o "$TMP_DIR/$zip_name"

  unzip -q -o "$TMP_DIR/$zip_name" -d "$TMP_DIR/$zip_name.dir"
  local source_path="$TMP_DIR/$zip_name.dir/$extracted_name"
  if [[ ! -f "$source_path" ]]; then
    echo "Expected $extracted_name not found in $zip_name"
    exit 1
  fi

  cp -f "$source_path" "$target_path"
  chmod +x "$target_path"
  echo "Updated $target_name"
}

download_and_install "$MAC_URL" "$MAC_ASSET" "blocknet-core-arm64-macos" "blocknet-aarch64-apple-darwin"
download_and_install "$LINUX_URL" "$LINUX_ASSET" "blocknet-core-amd64-linux" "blocknet-amd64-linux"
download_and_install "$WIN_URL" "$WIN_ASSET" "blocknet-core-amd64-windows.exe" "blocknet-amd64-windows.exe"

echo "Core sidecar binaries refreshed in $BIN_DIR"
