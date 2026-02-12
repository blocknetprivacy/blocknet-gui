<p align="center">
  <img src="blocknet.png" width="128" height="128" alt="Blocknet">
</p>

<h1 align="center">Blocknet Wallet</h1>

<p align="center">
  A private, self-contained desktop wallet for the Blocknet blockchain.<br>
  Built with <a href="https://v2.tauri.app">Tauri v2</a>. No CDNs. No telemetry. No remote calls.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.1-aaff00?style=flat-square&labelColor=000">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-aaff00?style=flat-square&labelColor=000">
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-aaff00?style=flat-square&labelColor=000">
</p>

---

## Download

Grab the latest release for your platform from [Releases](https://github.com/blocknetprivacy/blocknet-tauri/releases).

| Platform | File | Architecture |
|---|---|---|
| macOS | `.dmg` | Apple Silicon (arm64) |
| Linux | `.deb`, `.AppImage` | x86_64 |
| Windows | `.exe` (NSIS installer) | x86_64 |

### Verify checksums

Every release includes a `SHA256SUMS.txt`. After downloading, verify your file:

```bash
# macOS / Linux
sha256sum -c SHA256SUMS.txt

# or check a single file
sha256sum blocknet-arm64-darwin-blocknet_0.3.1_aarch64.dmg
```

On Windows (PowerShell):

```powershell
Get-FileHash .\blocknet-amd64-windows-blocknet_0.3.1_x64-setup.exe -Algorithm SHA256
```

Compare the output against the hash in `SHA256SUMS.txt`.

---

## Platform Notes

### macOS ; "damaged" or unidentified developer warning

This app is not notarized with Apple. macOS will quarantine it on first launch. To fix this, open Terminal and run:

```bash
xattr -cr /Applications/blocknet.app
```

Then open the app normally. You only need to do this once.

### Windows ; antivirus false positives

Windows Defender, Bitdefender, and other antivirus software may flag the installer or the bundled blockchain daemon as suspicious. This is a **false positive** ; it happens because:

- The binaries are not signed with an EV code signing certificate
- The bundled daemon (`blocknet-amd64-windows.exe`) is a cryptocurrency node, which heuristic scanners often flag by default
- NSIS installers from unsigned publishers are commonly flagged

To proceed:

- **Windows Defender**: Click "More info" then "Run anyway"
- **Bitdefender**: Add an exception for the install directory, or temporarily disable Advanced Threat Defense during installation
- **Other AV**: Add the Blocknet install folder to your exclusions list

The source code is public and the binaries are built in CI from this repo ; you can verify the build yourself.

### Linux

No special steps. Install the `.deb` or run the `.AppImage` directly:

```bash
# Debian/Ubuntu
sudo dpkg -i blocknet-amd64-linux-blocknet_0.3.1_amd64.deb

# AppImage
chmod +x blocknet-amd64-linux-blocknet_0.3.1_amd64.AppImage
./blocknet-amd64-linux-blocknet_0.3.1_amd64.AppImage
```

---

## Privacy

This wallet makes **zero** network requests to external services. There are no analytics, no CDNs, no Google Fonts, no remote scripts.

The only network activity is local HTTP JSON API communication between the wallet UI and the bundled Blocknet daemon on `127.0.0.1`. The daemon itself communicates with the Blocknet peer-to-peer network, that's it.

---

## Build from Source

Requires [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs), and platform-specific dependencies.

### macOS

```bash
npm install
mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp blocknet.png blocknet.svg ui/
npx tauri build --config '{"bundle":{"targets":["app"],"resources":["binaries/blocknet-aarch64-apple-darwin"]}}'
```

### Linux

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
npm install
mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp blocknet.png blocknet.svg ui/
npx tauri build --config '{"bundle":{"targets":["deb","appimage"],"resources":["binaries/blocknet-amd64-linux"]}}'
```

### Windows

Requires [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload.

```bash
npm install
mkdir -p ui && cp index.html main.js qr.js styles.css ui/ && cp -r icons ui/ && cp blocknet.png blocknet.svg ui/
npx tauri build --config '{"bundle":{"targets":["nsis"],"resources":["binaries/blocknet-amd64-windows.exe"]}}'
```

### Development

```bash
npm install
npm run dev
```

---

## License

[BSD-3-Clause](LICENSE) ; Copyright 2026 Blocknet Privacy
