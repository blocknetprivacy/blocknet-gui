#![windows_subsystem = "windows"]

use std::sync::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Listener, Manager, RunEvent, State, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;


struct DaemonState {
    child: Mutex<Option<std::process::Child>>,
}

struct TrayState {
    icon: Mutex<Option<TrayIcon>>,
}

struct EventsState {
    worker: Mutex<Option<EventsWorker>>,
}

struct EventsWorker {
    stop: Arc<AtomicBool>,
    handle: tokio::task::JoinHandle<()>,
}

struct ApiPortState {
    port: Mutex<u16>,
}

const GUI_API_PORT_MIN: u16 = 18432;
const GUI_API_PORT_MAX: u16 = 18531;

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
        if cfg!(target_arch = "x86_64") {
            "blocknet-x86_64-apple-darwin"
        } else {
            "blocknet-aarch64-apple-darwin"
        }
    } else if cfg!(target_os = "linux") {
        "blocknet-amd64-linux"
    } else {
        "blocknet-amd64-windows.exe"
    };

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(binary_name));
        candidates.push(resource_dir.join(binary_name));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("binaries").join(binary_name));
            candidates.push(exe_dir.join(binary_name));
            candidates.push(exe_dir.join("../Resources/binaries").join(binary_name));
        }
    }

    // Dev fallback: workspace src-tauri/binaries.
    candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(binary_name));

    let binary_path = candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("Daemon binary not found: {}", binary_name))?;

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

fn kill_listeners_in_gui_port_range() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let binary_names = [
            "blocknet-aarch64-apple-darwin",
            "blocknet-x86_64-apple-darwin",
            "blocknet-amd64-linux",
        ];
        for name in binary_names {
            let cmd = format!("pkill -9 -f '{}' 2>/dev/null || true", name);
            let _ = std::process::Command::new("sh")
                .arg("-c")
                .arg(cmd)
                .status();
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/f", "/im", "blocknet-amd64-windows.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn is_port_in_use(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    std::net::TcpStream::connect_timeout(
        &addr.parse().unwrap(),
        std::time::Duration::from_millis(250),
    )
    .is_ok()
}

fn pick_gui_api_port() -> Result<u16, String> {
    let span = (GUI_API_PORT_MAX - GUI_API_PORT_MIN + 1) as u128;
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Clock error: {}", e))?
        .as_nanos();
    let offset = (seed % span) as u16;

    for i in 0..span as u16 {
        let port = GUI_API_PORT_MIN + ((offset + i) % span as u16);
        if !is_port_in_use(port) {
            return Ok(port);
        }
    }

    Err(format!(
        "No free GUI API port in {}-{}",
        GUI_API_PORT_MIN, GUI_API_PORT_MAX
    ))
}

fn api_base_url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{}{}", port, path)
}

// The port of the daemon *we* started this process-lifetime, or None if we have
// not started one yet. We deliberately do NOT fall back to a shared default such
// as 8332: another blocknet node may be running there (a user's own full node,
// the CLI, an explorer), and addressing it with our cookie token yields 401
// "unauthorized" on every wallet call even though the password is correct.
fn current_api_port(state: &ApiPortState) -> Option<u16> {
    match state.port.lock() {
        Ok(guard) if *guard != 0 => Some(*guard),
        _ => None,
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

fn stop_api_events_inner(state: &EventsState) {
    if let Ok(mut guard) = state.worker.lock() {
        if let Some(worker) = guard.take() {
            worker.stop.store(true, Ordering::Relaxed);
            worker.handle.abort();
        }
    }
}

#[derive(serde::Serialize, Clone)]
struct ApiEventPayload {
    event: String,
    data: serde_json::Value,
}

fn emit_sse_event(app: &AppHandle, event_name: &str, data_buf: &str) {
    let data = serde_json::from_str::<serde_json::Value>(data_buf)
        .unwrap_or_else(|_| serde_json::Value::String(data_buf.to_string()));
    let payload = ApiEventPayload {
        event: if event_name.is_empty() {
            "message".to_string()
        } else {
            event_name.to_string()
        },
        data,
    };
    let _ = app.emit("api-events", payload);
}

async fn sse_loop(app: AppHandle, stop: Arc<AtomicBool>, data_dir: std::path::PathBuf, api_port: u16) {
    let client = reqwest::Client::builder()
        .build();
    let client = match client {
        Ok(c) => c,
        Err(_) => return,
    };

    while !stop.load(Ordering::Relaxed) {
        let token = std::fs::read_to_string(data_dir.join("api.cookie"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if token.is_empty() {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        let response = client
            .get(api_base_url(api_port, "/api/events"))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await;

        let mut resp = match response {
            Ok(r) if r.status().is_success() => r,
            _ => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        let mut stream_buf = String::new();
        let mut current_event = String::new();
        let mut current_data = String::new();

        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }

            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                _ => break,
            };

            stream_buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = stream_buf.find('\n') {
                let mut line = stream_buf[..pos].to_string();
                stream_buf.drain(..=pos);

                if line.ends_with('\r') {
                    line.pop();
                }

                if line.is_empty() {
                    if !current_data.is_empty() {
                        emit_sse_event(&app, &current_event, &current_data);
                    }
                    current_event.clear();
                    current_data.clear();
                    continue;
                }

                if line.starts_with(':') {
                    continue;
                }

                if let Some(rest) = line.strip_prefix("event:") {
                    current_event = rest.trim().to_string();
                    continue;
                }

                if let Some(rest) = line.strip_prefix("data:") {
                    if !current_data.is_empty() {
                        current_data.push('\n');
                    }
                    current_data.push_str(rest.trim());
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

#[tauri::command]
async fn start_api_events(app: AppHandle, state: State<'_, EventsState>, api_state: State<'_, ApiPortState>) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    // No daemon of ours yet: nothing to stream. The caller retries after unlock.
    let api_port = match current_api_port(&api_state) {
        Some(p) => p,
        None => return Ok(()),
    };
    let mut guard = state.worker.lock().map_err(|e| format!("Lock error: {}", e))?;
    if guard.is_some() {
        return Ok(());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = Arc::clone(&stop);
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        sse_loop(app_clone, stop_clone, data_dir, api_port).await;
    });

    *guard = Some(EventsWorker { stop, handle });
    Ok(())
}

#[tauri::command]
async fn stop_api_events(state: State<'_, EventsState>) -> Result<(), String> {
    stop_api_events_inner(&state);
    Ok(())
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

    let mut cmd = std::process::Command::new(&binary_path);
    cmd.arg("--wallet").arg(wallet_path.to_str().unwrap())
        .arg("--data").arg(data_dir.to_str().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn()
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

// Best-effort fetch of the latest checkpoints file from bntpool.com, written
// atomically into the daemon's data dir. Keeps fast-sync evergreen by replacing
// any stale local copy on every launch. Any failure (offline, timeout, bad
// response) is swallowed so it never blocks daemon startup, and the existing
// checkpoints file (if any) is left untouched as a fallback.
async fn refresh_checkpoints(app: &AppHandle, data_dir: &std::path::Path) {
    const MAX_BYTES: usize = 32 << 20; // 32 MiB, matches the daemon's bound
    let url = std::env::var("BLOCKNET_CHECKPOINTS_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://bntpool.com/checkpoints.dat".to_string());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let _ = app.emit("daemon-phase", "Pulling checkpoints from bntpool.com\u{2026}");
    let resp = match client.get(&url).header("Accept", "text/plain").send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return,
    };

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return,
    };

    // Sanity-check the payload before overwriting a working file.
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return;
    }

    let _ = app.emit("daemon-phase", "Writing checkpoints\u{2026}");
    let dest = data_dir.join("checkpoints.dat");
    let tmp = data_dir.join("checkpoints.dat.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() {
        if std::fs::rename(&tmp, &dest).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

// The daemon's own output is the only place its startup failures are spelled
// out: an unreadable chain db, a port already taken, a core too old for the
// stored block format. Discarding it leaves the UI with nothing to report but
// a guess, so keep it next to the data it describes.
fn open_daemon_log(data_dir: &std::path::Path) -> Option<(std::fs::File, std::fs::File)> {
    const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

    let path = data_dir.join("daemon.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let stderr = file.try_clone().ok()?;
    Some((file, stderr))
}

#[tauri::command]
async fn start_daemon(app: AppHandle, state: State<'_, DaemonState>, api_state: State<'_, ApiPortState>) -> Result<(), String> {
    // Kill any existing daemon before starting a new one
    stop_daemon_inner(&state);

    kill_listeners_in_gui_port_range();
    std::thread::sleep(std::time::Duration::from_millis(100));

    let api_port = pick_gui_api_port()?;
    {
        let mut guard = api_state.port.lock().map_err(|e| format!("Lock error: {}", e))?;
        *guard = api_port;
    }

    let (data_dir, wallet_path) = get_paths(&app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    let binary_path = get_binary_path(&app)?;

    // Clean stale cookie
    let _ = std::fs::remove_file(data_dir.join("api.cookie"));

    // Always pull the freshest checkpoints from bntpool.com and drop them into the
    // data dir before the daemon starts, so fast-sync is evergreen. The daemon only
    // downloads checkpoints when the file is missing, so without this an existing
    // (stale) file would pin fast-sync to an old height. On any failure we leave the
    // existing file in place as a fallback.
    refresh_checkpoints(&app, &data_dir).await;

    let mut args = vec![
        "--daemon".to_string(),
        "--api".to_string(), format!("127.0.0.1:{}", api_port),
        "--data".to_string(), data_dir.to_str().unwrap().to_string(),
    ];

    // Pass --wallet so the daemon knows where wallet files live
    // (needed for /api/wallet/import filename resolution)
    args.push("--wallet".to_string());
    args.push(wallet_path.to_str().unwrap().to_string());

    let _ = app.emit("daemon-phase", "Starting core\u{2026}");
    let mut cmd = std::process::Command::new(&binary_path);
    cmd.args(&args);
    match open_daemon_log(&data_dir) {
        Some((out, err)) => {
            cmd.stdout(out).stderr(err);
        }
        None => {
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn()
        .map_err(|e| {
            if check_security_blocked(&binary_path) {
                return "SECURITY_BLOCKED".to_string();
            }
            format!("Failed to spawn daemon: {}", e)
        })?;

    std::thread::sleep(std::time::Duration::from_millis(500));

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
        Ok(Some(_)) => Err("Daemon exited during startup".to_string()),
        Ok(None) => {
            let mut guard = state.child.lock().map_err(|e| format!("Lock error: {}", e))?;
            *guard = Some(child);
            Ok(())
        },
        Err(e) => Err(format!("Failed to check daemon status: {}", e)),
    }
}

#[tauri::command]
async fn check_daemon_ready(app: AppHandle, api_state: State<'_, ApiPortState>) -> Result<bool, String> {
    let data_dir = get_data_dir(&app)?;
    let cookie_path = data_dir.join("api.cookie");

    // Only probe the daemon we started ourselves. Without our own port there is
    // nothing ready — do not fall back to a shared default and risk latching onto
    // an unrelated node (see current_api_port).
    let api_port = match current_api_port(&api_state) {
        Some(p) => p,
        None => return Ok(false),
    };

    if !cookie_path.exists() {
        return Ok(false);
    }

    let token = std::fs::read_to_string(&cookie_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // A busy daemon (chain catch-up, a big db flush) can take a while to answer
    // even a cheap request. Too tight a timeout reads as "not ready", and the
    // caller answers that by killing a perfectly healthy node and starting over.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // Probe an AUTHENTICATED endpoint, not /api/status: /api/status requires no
    // token and answers 200 for anyone, so it cannot tell "our daemon accepts our
    // cookie" from "some other node is listening here". A 401 means the token was
    // rejected (stale cookie or a foreign daemon) — treat that as not-ready so the
    // caller (re)starts our own daemon instead of sending passwords to a node that
    // will reject them with "unauthorized". Any non-401 response means the token
    // was accepted, i.e. the daemon is ours and up (a wallet-not-loaded error is
    // still a "ready" daemon).
    let res = client
        .get(api_base_url(api_port, "/api/wallet/balance"))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    match res {
        Ok(r) => Ok(r.status().as_u16() != 401),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn api_call(
    app: AppHandle,
    api_state: State<'_, ApiPortState>,
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let data_dir = get_data_dir(&app)?;
    let token = std::fs::read_to_string(data_dir.join("api.cookie"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read auth cookie: {}", e))?;

    let client = reqwest::Client::new();
    let api_port = current_api_port(&api_state)
        .ok_or_else(|| "Daemon not started".to_string())?;
    let url = api_base_url(api_port, &path);

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

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            if k.eq_ignore_ascii_case("authorization") {
                continue;
            }
            if k.eq_ignore_ascii_case("content-type") {
                continue;
            }
            req = req.header(k.as_str(), v);
        }
    }

    let res = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(text);
    }

    res.text().await.map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("only https URLs allowed".into());
    }
    let res = reqwest::get(&url)
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
async fn stop_daemon(state: State<'_, DaemonState>) -> Result<(), String> {
    stop_daemon_inner(&state);
    Ok(())
}

#[tauri::command]
async fn reset_blockchain_data(app: AppHandle, state: State<'_, DaemonState>) -> Result<(), String> {
    stop_daemon_inner(&state);
    kill_listeners_in_gui_port_range();
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
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&filename)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file = rx.await
        .map_err(|_| "Dialog cancelled".to_string())?
        .ok_or("No location selected".to_string())?;

    let path = file.as_path()
        .ok_or("Invalid path".to_string())?
        .to_path_buf();

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

// --- Encrypted user-data store ---

const USERDATA_MAGIC: &[u8; 5] = b"BNUD1";

fn userdata_path(app: &AppHandle, wallet: &str) -> Result<std::path::PathBuf, String> {
    if wallet.is_empty() || wallet.contains('/') || wallet.contains('\\') || wallet.contains("..") {
        return Err("Invalid wallet name".to_string());
    }
    let base = wallet.strip_suffix(".dat").unwrap_or(wallet);
    if base.is_empty() {
        return Err("Invalid wallet name".to_string());
    }
    Ok(get_app_dir(app)?.join(format!("{}.userdata", base)))
}

fn derive_userdata_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::Argon2;
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {}", e))?;
    Ok(key)
}

fn encrypt_userdata(password: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use rand::RngCore;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let key_bytes = derive_userdata_key(password, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "encryption failed".to_string())?;
    let mut out = Vec::with_capacity(5 + 16 + 12 + ciphertext.len());
    out.extend_from_slice(USERDATA_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_userdata(password: &str, raw: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    if raw.len() < 5 + 16 + 12 || &raw[0..5] != USERDATA_MAGIC {
        return Err("user data file is corrupt".to_string());
    }
    let salt = &raw[5..21];
    let nonce_bytes = &raw[21..33];
    let ciphertext = &raw[33..];
    let key_bytes = derive_userdata_key(password, salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "decryption failed".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "invalid utf8".to_string())
}

#[tauri::command]
async fn read_user_data(app: AppHandle, wallet: String, password: String) -> Result<String, String> {
    let path = userdata_path(&app, &wallet)?;
    let raw = match std::fs::read(&path) {
        Ok(d) => d,
        Err(_) => return Ok("{}".to_string()),
    };
    decrypt_userdata(&password, &raw)
}

#[tauri::command]
async fn write_user_data(app: AppHandle, wallet: String, password: String, contents: String) -> Result<(), String> {
    let path = userdata_path(&app, &wallet)?;
    let out = encrypt_userdata(&password, contents.as_bytes())?;
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, &out).map_err(|e| format!("write failed: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod userdata_tests {
    use super::{decrypt_userdata, encrypt_userdata, USERDATA_MAGIC};

    #[test]
    fn roundtrip_and_wrong_password() {
        let pw = "correct horse battery staple";
        let plain = r#"{"contacts":[{"name":"mom","address":"bnt1abc"}],"txNotes":{"deadbeef":"rent"}}"#;
        let enc = encrypt_userdata(pw, plain.as_bytes()).unwrap();
        assert!(enc.len() > 33);
        assert_eq!(&enc[0..5], USERDATA_MAGIC);
        assert_ne!(&enc[33..], plain.as_bytes());
        let dec = decrypt_userdata(pw, &enc).unwrap();
        assert_eq!(dec, plain);
        assert!(decrypt_userdata("wrong password", &enc).is_err());
        assert!(decrypt_userdata(pw, b"short").is_err());
    }
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
async fn switch_wallet(app: AppHandle, name: String) -> Result<(), String> {
    // Validate: no path separators, must end in .dat
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".dat") {
        return Err("Invalid wallet name".to_string());
    }
    // Check file exists
    let wallet_path = get_app_dir(&app)?.join(&name);
    if !wallet_path.exists() {
        return Err(format!("Wallet file not found: {}", name));
    }
    // The daemon keeps running: every wallet lives in one directory, so the
    // caller swaps wallets over the API (unload, then load by filename). A
    // restart here would reopen the chain db and resync for nothing.
    set_active_wallet_name(&app, &name)?;
    Ok(())
}

#[tauri::command]
async fn set_active_wallet(app: AppHandle, name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".dat") {
        return Err("Invalid wallet name".to_string());
    }
    set_active_wallet_name(&app, &name)
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
async fn backup_wallet(app: AppHandle, default_name: Option<String>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let src = get_wallet_path(&app)?;
    if !src.exists() {
        return Err("Wallet file not found".to_string());
    }
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "wallet".to_string());
    let default_name = default_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| format!("{}-backup.dat", stem));

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Wallet Files", &["dat"])
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file = rx.await
        .map_err(|_| "Dialog cancelled".to_string())?
        .ok_or("No location selected".to_string())?;

    let dest = file.as_path().ok_or("Invalid path".to_string())?.to_path_buf();

    std::fs::copy(&src, &dest).map_err(|e| format!("Backup failed: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_wallet_version(app: AppHandle) -> Result<String, String> {
    daemon_version_string(&app)
}

fn daemon_version_string(app: &AppHandle) -> Result<String, String> {
    let binary_path = get_binary_path(&app)?;

    let attempts: [&[&str]; 2] = [
        &["--version"],
        &["version"],
    ];

    for args in attempts {
        let mut cmd = std::process::Command::new(&binary_path);
        cmd.args(args);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run daemon version command: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let text = if !stdout.is_empty() { stdout } else { stderr };

        if !text.is_empty() {
            return Ok(text.lines().next().unwrap_or(&text).to_string());
        }
    }

    Err("Unable to read daemon version".to_string())
}

#[tauri::command]
async fn get_daemon_version(app: AppHandle) -> Result<String, String> {
    daemon_version_string(&app)
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

// Returns true if the daemon child process we spawned is still running.
// Used by the frontend to tell "still starting / syncing" apart from "crashed"
// while waiting for the daemon's API to come up.
#[tauri::command]
async fn daemon_alive(state: State<'_, DaemonState>) -> Result<bool, String> {
    let mut guard = state.child.lock().map_err(|e| format!("Lock error: {}", e))?;
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => Ok(false), // process has exited
            Ok(None) => Ok(true),     // still running
            Err(_) => Ok(false),
        },
        None => Ok(false), // no tracked child process
    }
}

#[tauri::command]
fn set_tray_unlocked(unlocked: bool, tray_state: State<'_, TrayState>) -> Result<(), String> {
    let mut guard = tray_state.icon.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_mut() {
        if unlocked {
            tray.set_icon_as_template(false).map_err(|e| format!("Failed to set template mode: {}", e))?;
            let img = tauri::include_image!("icons/tray-icon-unlocked@2x.png");
            tray.set_icon(Some(img)).map_err(|e| format!("Failed to set icon: {}", e))?;
        } else {
            let img = tauri::include_image!("icons/tray-icon@2x.png");
            tray.set_icon(Some(img)).map_err(|e| format!("Failed to set icon: {}", e))?;
            tray.set_icon_as_template(true).map_err(|e| format!("Failed to set template mode: {}", e))?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("single-instance: new invocation with {argv:?}");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .manage(DaemonState { child: Mutex::new(None) })
        .manage(TrayState { icon: Mutex::new(None) })
        .manage(EventsState { worker: Mutex::new(None) })
        .manage(ApiPortState { port: Mutex::new(0) })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                    | tauri_plugin_window_state::StateFlags::POSITION
                    | tauri_plugin_window_state::StateFlags::MAXIMIZED
                    | tauri_plugin_window_state::StateFlags::VISIBLE
                    | tauri_plugin_window_state::StateFlags::FULLSCREEN
            )
            .build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray-icon@2x.png"))
                .icon_as_template(true)
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
                            // Stop SSE events and daemon before exiting
                            stop_api_events_inner(&app.state::<EventsState>());
                            stop_daemon_inner(&app.state::<DaemonState>());
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

            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            #[cfg(not(target_os = "windows"))]
            {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_decorations(true);
                    let _ = w.set_shadow(true);
                }
            }

            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |_event| {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = api;
                    let app = window.app_handle();
                    stop_api_events_inner(&app.state::<EventsState>());
                    stop_daemon_inner(&app.state::<DaemonState>());
                }
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
            set_active_wallet,
            rename_wallet,
            delete_wallet,
            import_wallet_file,
            backup_wallet,
            get_wallet_version,
            get_daemon_version,
            get_app_version,
            daemon_alive,
            set_tray_unlocked,
            start_api_events,
            stop_api_events,
            fetch_url,
            read_user_data,
            write_user_data,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                RunEvent::Exit => {
                    stop_api_events_inner(&app.state::<EventsState>());
                    stop_daemon_inner(&app.state::<DaemonState>());
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });
}
