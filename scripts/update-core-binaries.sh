#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/src-tauri/binaries"
ANDROID_LIB_DIR="$ROOT_DIR/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
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
AUTH=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
curl -fsSL --retry 3 ${AUTH[@]+"${AUTH[@]}"} "$API_URL" -o "$RELEASE_JSON"

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
MAC_X64_ASSET="blocknet-core-amd64-macos-${VERSION}.zip"
LINUX_ASSET="blocknet-core-amd64-linux-${VERSION}.zip"
WIN_ASSET="blocknet-core-amd64-windows-${VERSION}.zip"
ANDROID_ASSET="blocknet-core-arm64-android-${VERSION}.zip"

MAC_URL="$(extract_asset_url "$MAC_ASSET")"
MAC_X64_URL="$(extract_asset_url "$MAC_X64_ASSET")"
LINUX_URL="$(extract_asset_url "$LINUX_ASSET")"
WIN_URL="$(extract_asset_url "$WIN_ASSET")"
ANDROID_URL="$(extract_asset_url "$ANDROID_ASSET" || true)"

SUMS_URL="$(extract_asset_url "SHA256SUMS.txt" || true)"

if [[ -z "$MAC_URL" || -z "$MAC_X64_URL" || -z "$LINUX_URL" || -z "$WIN_URL" || -z "$SUMS_URL" ]]; then
  echo "Missing required release assets for version ${VERSION}"
  exit 1
fi

SUMS_FILE="$TMP_DIR/SHA256SUMS.txt"
curl -fsSL --retry 3 "$SUMS_URL" -o "$SUMS_FILE"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_sha256() {
  local file_path="$1"
  local zip_name="$2"
  local expected
  expected="$(awk -v n="$zip_name" '{f=$2; sub(/^\*/, "", f)} f == n {print tolower($1); exit}' "$SUMS_FILE")"
  if [[ -z "$expected" ]]; then
    echo "No SHA256 for $zip_name in SHA256SUMS.txt"
    exit 1
  fi
  local actual
  actual="$(sha256_of "$file_path" | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA256 mismatch for $zip_name: expected $expected, got $actual"
    exit 1
  fi
  echo "Verified SHA256 of $zip_name"
}

extract_zip() {
  local zip_path="$1"
  local dest_dir="$2"

  mkdir -p "$dest_dir"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$zip_path" -d "$dest_dir"
  elif command -v 7z >/dev/null 2>&1; then
    7z x -y -o"$dest_dir" "$zip_path" >/dev/null
  elif command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command \
      "Expand-Archive -Force -LiteralPath '$(cygpath -w "$zip_path")' -DestinationPath '$(cygpath -w "$dest_dir")'"
  else
    echo "No unzip, 7z, or powershell available to extract $zip_path"
    exit 1
  fi
}

download_and_install() {
  local url="$1"
  local zip_name="$2"
  local extracted_name="$3"
  local target_name="$4"
  local target_dir="${5:-$BIN_DIR}"
  local target_path="$target_dir/$target_name"

  echo "Downloading $zip_name..."
  curl -fsSL "$url" -o "$TMP_DIR/$zip_name"
  verify_sha256 "$TMP_DIR/$zip_name" "$zip_name"

  extract_zip "$TMP_DIR/$zip_name" "$TMP_DIR/$zip_name.dir"
  local source_path="$TMP_DIR/$zip_name.dir/$extracted_name"
  if [[ ! -f "$source_path" ]]; then
    echo "Expected $extracted_name not found in $zip_name"
    exit 1
  fi

  mkdir -p "$target_dir"
  cp -f "$source_path" "$target_path"
  chmod +x "$target_path"
  echo "Updated $target_name"
}

download_and_install "$MAC_URL" "$MAC_ASSET" "blocknet-core-arm64-macos" "blocknet-aarch64-apple-darwin"
download_and_install "$MAC_X64_URL" "$MAC_X64_ASSET" "blocknet-core-amd64-macos" "blocknet-x86_64-apple-darwin"
download_and_install "$LINUX_URL" "$LINUX_ASSET" "blocknet-core-amd64-linux" "blocknet-amd64-linux"
download_and_install "$WIN_URL" "$WIN_ASSET" "blocknet-core-amd64-windows.exe" "blocknet-amd64-windows.exe"
if [[ -n "$ANDROID_URL" ]]; then
  download_and_install "$ANDROID_URL" "$ANDROID_ASSET" "blocknet-core-arm64-android" "libblocknet_core.so" "$ANDROID_LIB_DIR"
else
  echo "No $ANDROID_ASSET in this release; skipping the Android core"
fi

echo "Core sidecar binaries refreshed in $BIN_DIR"
