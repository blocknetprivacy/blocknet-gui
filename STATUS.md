# Blocknet Wallet - Project Summary

## Status: ✅ Initial Setup Complete, Compiling...

### What's Been Done

1. **Project Structure**
   - Tauri v2 application initialized
   - Vanilla JS frontend (no framework)
   - Rust backend with daemon management
   - Sidecar binary configuration

2. **Files Created**
   - `index.html` - Main HTML with splash screen and dashboard placeholder
   - `styles.css` - Dark theme styling matching your website (#af0 accent, #0a0a0a background)
   - `main.js` - Frontend logic for splash fade and daemon detection
   - `src-tauri/src/main.rs` - Rust backend with daemon spawning
   - `src-tauri/Cargo.toml` - Rust dependencies
   - `src-tauri/tauri.conf.json` - Tauri configuration
   - `setup.sh` - Helper script to copy blocknet binary

3. **Splash Screen Implementation**
   - Pure #AF0 background (lime green)
   - Centered blocknet.png logo
   - No text, no loading bar (as requested)
   - 1-second linear opacity fade on completion
   - Auto-removes from DOM 2 seconds after fade completes

4. **Daemon Management**
   - Binary copied from `/Users/dh/Projects/blocknet/blocknet`
   - Spawns with args: `--daemon --wallet wallet.dat --data ./data`
   - Frontend polls for `api.cookie` file every 500ms
   - Max timeout: 30 seconds
   - On success: triggers splash fade

### Current Compilation

The app is currently compiling Rust dependencies (399 total packages). This will take 3-5 minutes on first run.

### Next Steps (After Compilation)

1. Test the splash screen → dashboard transition
2. Verify daemon starts correctly
3. Verify api.cookie detection works
4. Begin implementing Dashboard view with:
   - Balance display
   - Node status
   - Quick stats grid

### File Locations

- App data directory: `~/Library/Application Support/com.blocknet.wallet/` (macOS)
- Wallet file: `{app_data}/wallet.dat`
- Data directory: `{app_data}/data/`
- API cookie: `{app_data}/data/api.cookie`

### To Run

```bash
npm run dev
```

This starts:
1. Python HTTP server on port 1420 (serves frontend files)
2. Tauri dev build (compiles Rust, launches window)
3. Daemon binary in background

