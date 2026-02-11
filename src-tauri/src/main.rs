#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};


struct DaemonState {
    child: Mutex<Option<std::process::Child>>,
}

struct TrayState {
    icon: Mutex<Option<TrayIcon>>,
}

impl Drop for DaemonState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn get_binary_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let binary_name = if cfg!(target_os = "macos") {
        "blocknet-aarch64-apple-darwin"
    } else if cfg!(target_os = "linux") {
        "blocknet-amd64-linux"
    } else {
        "blocknet-amd64-windows.exe"
    };

    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let binary_path = resource_dir.join("binaries").join(binary_name);

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(target_os = "windows")]
    {
        let zone_id = format!("{}:Zone.Identifier", binary_path.display());
        let _ = std::fs::remove_file(&zone_id);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&binary_path) {
            let mut perms = metadata.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(perms.mode() | 0o755);
                let _ = std::fs::set_permissions(&binary_path, perms);
            }
        }
    }

    Ok(binary_path)
}

fn check_security_blocked(binary_path: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(binary_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = binary_path;
        false
    }
}

fn get_app_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

fn get_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(get_app_dir(app)?.join("data"))
}

fn get_active_wallet_name(app: &AppHandle) -> Result<String, String> {
    let config_path = get_app_dir(app)?.join("active_wallet");
    match std::fs::read_to_string(&config_path) {
        Ok(name) => {
            let name = name.trim().to_string();
            if name.is_empty() { Ok("wallet.dat".to_string()) } else { Ok(name) }
        }
        Err(_) => Ok("wallet.dat".to_string()),
    }
}

fn set_active_wallet_name(app: &AppHandle, name: &str) -> Result<(), String> {
    let app_dir = get_app_dir(app)?;
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app dir: {}", e))?;
    std::fs::write(app_dir.join("active_wallet"), name)
        .map_err(|e| format!("Failed to write active wallet config: {}", e))
}

fn get_wallet_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let name = get_active_wallet_name(app)?;
    Ok(get_app_dir(app)?.join(&name))
}

// Compat shim used by commands that need (data_dir, wallet_path)
fn get_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    Ok((get_data_dir(app)?, get_wallet_path(app)?))
}

fn kill_port_8332() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg("pids=$(lsof -ti tcp:8332 2>/dev/null); if [ -n \"$pids\" ]; then kill -9 $pids; fi")
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :8332') do taskkill /PID %a /F"])
            .status();
    }
}

fn stop_daemon_inner(state: &DaemonState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
async fn wallet_exists(app: AppHandle) -> Result<bool, String> {
    let wallet_path = get_wallet_path(&app)?;
    Ok(wallet_path.exists())
}

#[tauri::command]
async fn create_wallet(app: AppHandle, password: String) -> Result<(), String> {
    use std::io::Write;

    let (data_dir, wallet_path) = get_paths(&app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    let binary_path = get_binary_path(&app)?;

    let mut child = std::process::Command::new(&binary_path)
        .arg("--wallet").arg(wallet_path.to_str().unwrap())
        .arg("--data").arg(data_dir.to_str().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if check_security_blocked(&binary_path) {
                return "SECURITY_BLOCKED".to_string();
            }
            format!("Failed to spawn: {}", e)
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(format!("{}\n{}\n", password, password).as_bytes())
            .map_err(|e| format!("Failed to write password: {}", e))?;
        stdin.flush().map_err(|e| format!("Failed to flush: {}", e))?;
    }

    std::thread::sleep(std::time::Duration::from_secs(3));
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
async fn start_daemon(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    let (data_dir, wallet_path) = get_paths(&app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    let binary_path = get_binary_path(&app)?;

    // Clean stale cookie
    let _ = std::fs::remove_file(data_dir.join("api.cookie"));

    let mut args = vec![
        "--daemon".to_string(),
        "--api".to_string(), "127.0.0.1:8332".to_string(),
        "--data".to_string(), data_dir.to_str().unwrap().to_string(),
    ];

    // Pass --wallet so the daemon knows where wallet files live
    // (needed for /api/wallet/import filename resolution)
    args.push("--wallet".to_string());
    args.push(wallet_path.to_str().unwrap().to_string());

    let mut child = std::process::Command::new(&binary_path)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            if check_security_blocked(&binary_path) {
                return "SECURITY_BLOCKED".to_string();
            }
            format!("Failed to spawn daemon: {}", e)
        })?;

    std::thread::sleep(std::time::Duration::from_secs(2));

    match child.try_wait() {
        Ok(Some(status)) if !status.success() => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if status.signal() == Some(9) && check_security_blocked(&binary_path) {
                    return Err("SECURITY_BLOCKED".to_string());
                }
            }
            if check_security_blocked(&binary_path) {
                return Err("SECURITY_BLOCKED".to_string());
            }
            Err(format!("Daemon exited with code: {}", status))
        },
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            let mut guard = state.child.lock().map_err(|e| format!("Lock error: {}", e))?;
            *guard = Some(child);
            Ok(())
        },
        Err(e) => Err(format!("Failed to check daemon status: {}", e)),
    }
}

#[tauri::command]
async fn check_daemon_ready(app: AppHandle) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    let cookie_path = data_dir.join("api.cookie");

    if !cookie_path.exists() {
        return Ok(false);
    }

    let token = std::fs::read_to_string(&cookie_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let res = client
        .get("http://127.0.0.1:8332/api/status")
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => Ok(true),
        _ => {
            // Stale cookie from a previous run ; clean it up
            let _ = std::fs::remove_file(&cookie_path);
            Ok(false)
        }
    }
}

#[tauri::command]
async fn api_call(app: AppHandle, method: String, path: String, body: Option<String>) -> Result<String, String> {
    let data_dir = get_data_dir(&app)?;
    let token = std::fs::read_to_string(data_dir.join("api.cookie"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read auth cookie: {}", e))?;

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:8332{}", path);

    let mut req = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    req = req.header("Authorization", format!("Bearer {}", token));

    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }

    let res = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(text);
    }

    res.text().await.map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
async fn stop_daemon(state: State<'_, DaemonState>) -> Result<(), String> {
    stop_daemon_inner(&state);
    Ok(())
}

#[tauri::command]
async fn reset_blockchain_data(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    stop_daemon_inner(&state);
    kill_port_8332();
    std::thread::sleep(std::time::Duration::from_millis(500));

    let data_dir = get_data_dir(&app)?;
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir)
            .map_err(|e| format!("Failed to remove data dir: {}", e))?;
    }
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to recreate data dir: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn save_file(app: AppHandle, filename: String, contents: String) -> Result<String, String> {
    let downloads = if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        dirs_next::download_dir()
            .or_else(|| dirs_next::home_dir().map(|h| h.join("Downloads")))
    } else {
        dirs_next::download_dir()
    };
    let dir = downloads.unwrap_or_else(|| {
        app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    });
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(&filename);
    std::fs::write(&path, &contents).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

// --- Wallet management ---

#[tauri::command]
async fn list_wallets(app: AppHandle) -> Result<Vec<String>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut wallets = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&app_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".dat") && entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                wallets.push(name);
            }
        }
    }
    wallets.sort();
    Ok(wallets)
}

#[tauri::command]
async fn get_active_wallet(app: AppHandle) -> Result<String, String> {
    get_active_wallet_name(&app)
}

#[tauri::command]
async fn get_wallet_path_cmd(app: AppHandle) -> Result<String, String> {
    let p = get_wallet_path(&app)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
async fn switch_wallet(app: AppHandle, state: State<'_, DaemonState>, name: String) -> Result<(), String> {
    // Validate: no path separators, must end in .dat
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".dat") {
        return Err("Invalid wallet name".to_string());
    }
    // Check file exists
    let wallet_path = get_app_dir(&app)?.join(&name);
    if !wallet_path.exists() {
        return Err(format!("Wallet file not found: {}", name));
    }
    // Stop current daemon
    stop_daemon_inner(&state);
    kill_port_8332();
    std::thread::sleep(std::time::Duration::from_millis(500));
    // Update active wallet
    set_active_wallet_name(&app, &name)?;
    Ok(())
}

#[tauri::command]
async fn rename_wallet(app: AppHandle, old_name: String, new_name: String) -> Result<(), String> {
    for n in [&old_name, &new_name] {
        if n.contains('/') || n.contains('\\') || n.contains("..") || !n.ends_with(".dat") {
            return Err("Invalid wallet name".to_string());
        }
    }
    let app_dir = get_app_dir(&app)?;
    let old_path = app_dir.join(&old_name);
    let new_path = app_dir.join(&new_name);
    if !old_path.exists() {
        return Err(format!("Wallet file not found: {}", old_name));
    }
    if new_path.exists() {
        return Err(format!("A wallet named {} already exists", new_name));
    }
    std::fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Rename failed: {}", e))?;
    // If the renamed wallet was the active one, update the active reference
    let active = get_active_wallet_name(&app)?;
    if active == old_name {
        set_active_wallet_name(&app, &new_name)?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_wallet(app: AppHandle, name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".dat") {
        return Err("Invalid wallet name".to_string());
    }
    let active = get_active_wallet_name(&app)?;
    if name == active {
        return Err("Cannot delete the active wallet".to_string());
    }
    let path = get_app_dir(&app)?.join(&name);
    if !path.exists() {
        return Err(format!("Wallet file not found: {}", name));
    }
    std::fs::remove_file(&path)
        .map_err(|e| format!("Delete failed: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn import_wallet_file(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("Wallet Files", &["dat"])
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file = rx.await
        .map_err(|_| "Dialog cancelled".to_string())?
        .ok_or("No file selected".to_string())?;

    let source = file.as_path()
        .ok_or("Invalid file path".to_string())?;

    let filename = source.file_name()
        .ok_or("Invalid filename".to_string())?
        .to_string_lossy()
        .to_string();

    let filename = if filename.ends_with(".dat") {
        filename
    } else {
        format!("{}.dat", filename)
    };

    let app_dir = get_app_dir(&app)?;
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app dir: {}", e))?;
    let dest = app_dir.join(&filename);

    if dest.exists() {
        return Err(format!("A wallet named {} already exists", filename));
    }

    std::fs::copy(source, &dest)
        .map_err(|e| format!("Failed to copy wallet file: {}", e))?;

    Ok(filename)
}

#[tauri::command]
fn set_tray_unlocked(unlocked: bool, tray_state: State<'_, TrayState>) -> Result<(), String> {
    let mut guard = tray_state.icon.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_mut() {
        let img = if unlocked {
            tauri::include_image!("icons/squircle.png")
        } else {
            tauri::include_image!("icons/icon-black.png")
        };
        tray.set_icon_as_template(true).map_err(|e| format!("Failed to set template mode: {}", e))?;
        tray.set_icon(Some(img)).map_err(|e| format!("Failed to set icon: {}", e))?;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .manage(DaemonState { child: Mutex::new(None) })
        .manage(TrayState { icon: Mutex::new(None) })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray-icon@2x.png"))
                .tooltip("blocknet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            if let Ok(mut tray_guard) = app.state::<TrayState>().icon.lock() {
                *tray_guard = Some(_tray);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            wallet_exists,
            create_wallet,
            start_daemon,
            check_daemon_ready,
            api_call,
            stop_daemon,
            reset_blockchain_data,
            save_file,
            open_file,
            list_wallets,
            get_active_wallet,
            get_wallet_path_cmd,
            switch_wallet,
            rename_wallet,
            delete_wallet,
            import_wallet_file,
            set_tray_unlocked,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
