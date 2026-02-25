#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const versionFileOnly = args.has('--version-file-only');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function parseVersion(text) {
  const match = String(text || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function getDaemonBinaryPath() {
  const fromEnv = process.env.BLOCKNET_BIN;
  const candidates = [
    fromEnv,
    path.join(root, 'blocknet'),
    path.join(root, 'src-tauri', 'binaries', 'blocknet-aarch64-apple-darwin'),
    path.join(root, 'src-tauri', 'binaries', 'blocknet-amd64-linux'),
    path.join(root, 'src-tauri', 'binaries', 'blocknet-amd64-windows.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('No daemon binary found. Set BLOCKNET_BIN or place binaries in src-tauri/binaries.');
}

function readDaemonVersion(binaryPath) {
  const attempts = [['--version'], ['version']];
  let output = '';

  for (const attempt of attempts) {
    try {
      output = execFileSync(binaryPath, attempt, { encoding: 'utf8' });
    } catch (error) {
      output = String((error.stdout || '') + (error.stderr || ''));
    }

    if (output && output.trim()) break;
  }

  const version = parseVersion(output);
  if (!version) {
    throw new Error('Unable to parse daemon version from output: ' + output);
  }
  return version;
}

function updateCargoTomlVersion(filePath, version) {
  const original = fs.readFileSync(filePath, 'utf8');
  const currentMatch = original.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!currentMatch) {
    throw new Error('Failed to locate [package] version in src-tauri/Cargo.toml');
  }
  if (currentMatch[1] === version) {
    return;
  }

  const updated = original.replace(
    /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`
  );
  fs.writeFileSync(filePath, updated);
}

function assertEqual(label, actual, expected) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label} mismatch: expected ${expected}, found ${actual}`);
  }
}

function main() {
  const binaryPath = getDaemonBinaryPath();
  const daemonVersion = readDaemonVersion(binaryPath);
  const versionPath = path.join(root, 'VERSION');

  if (checkOnly) {
    const fileVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '';
    assertEqual('VERSION', fileVersion, daemonVersion);

    const pkg = readJson(path.join(root, 'package.json'));
    assertEqual('package.json version', pkg.version, daemonVersion);

    const tauri = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
    assertEqual('tauri.conf.json version', tauri.version, daemonVersion);

    const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    const cargoMatch = cargoToml.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
    assertEqual('Cargo.toml [package] version', cargoMatch ? cargoMatch[1] : '', daemonVersion);

    process.stdout.write(daemonVersion + '\n');
    return;
  }

  fs.writeFileSync(versionPath, daemonVersion + '\n');
  if (versionFileOnly) {
    process.stdout.write(daemonVersion + '\n');
    return;
  }

  const pkgPath = path.join(root, 'package.json');
  const tauriPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');

  const pkg = readJson(pkgPath);
  pkg.version = daemonVersion;
  writeJson(pkgPath, pkg);

  const tauri = readJson(tauriPath);
  tauri.version = daemonVersion;
  writeJson(tauriPath, tauri);

  updateCargoTomlVersion(cargoPath, daemonVersion);

  process.stdout.write(daemonVersion + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error.message || error) + '\n');
  process.exit(1);
}
