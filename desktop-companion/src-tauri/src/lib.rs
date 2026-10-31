use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child as NativeChild, Command},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use ed25519_dalek::SigningKey;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use keyring::Entry;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rand_core::OsRng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use uuid::Uuid;

mod input_targeting;
use input_targeting::EditableTargetIdentity;

const VAULT_SERVICE: &str = "com.rubminds.backroom.desktop";
const MAX_DRAFT_CHARS: usize = 4_000;
const MAX_TERMINAL_INPUT: usize = 4_000;
const MAX_INPUT_EVENTS_PER_SECOND: usize = 120;
const MAX_ACTIVE_DESKTOP_PROCESSES: usize = 24;
const MAX_ACTIVE_TERMINALS: usize = 4;
const MAX_NATIVE_APPROVALS_PER_MINUTE: usize = 10;

fn vault_entry(name: &str) -> Result<Entry, String> {
    let permitted = matches!(name, "device-id" | "device-token" | "device-private-key" | "device-room-id" | "supabase-auth-session");
    if !permitted {
        return Err("Credential name is not permitted".into());
    }
    Entry::new(VAULT_SERVICE, name).map_err(|_| "OS credential store is unavailable".into())
}

fn vault_get(name: &str) -> Result<Option<String>, String> {
    let entry = vault_entry(name)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the OS credential store".into()),
    }
}

fn vault_set(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 32_768 || value.chars().any(char::is_control) {
        return Err("Invalid credential value".into());
    }
    vault_entry(name)?
        .set_password(value)
        .map_err(|_| "Could not save to the OS credential store".into())
}

fn vault_delete(name: &str) -> Result<(), String> {
    match vault_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the OS credential".into()),
    }
}

fn clear_device_credentials() -> Result<(), String> {
    for name in ["device-token", "device-id", "device-private-key", "device-room-id"] {
        vault_delete(name)?;
    }
    Ok(())
}

// This confirmation is a native OS dialog, not HTML rendered in the companion
// WebView. Sensitive Tauri commands enforce it themselves so an IPC caller
// cannot bypass the local approval screen with a direct invoke() call.
async fn require_native_confirmation(app: AppHandle, title: &str, message: &str) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(message.to_string())
        .title(title.to_string())
        .buttons(MessageDialogButtons::YesNo)
        .show(move |approved| { let _ = sender.send(approved); });
    let approved = receiver.await
        .map_err(|_| "The operating-system approval dialog closed unexpectedly".to_string())?;
    if approved { Ok(()) } else { Err("Action denied in the operating-system confirmation dialog".into()) }
}

fn random_identity() -> Result<(String, String), String> {
    let device_id = match vault_get("device-id")? {
        Some(value) if Uuid::parse_str(&value).is_ok() => value,
        _ => {
            let value = Uuid::new_v4().to_string();
            vault_set("device-id", &value)?;
            value
        }
    };

    let signing_key = match vault_get("device-private-key")? {
        Some(encoded) => {
            let bytes = hex::decode(encoded).map_err(|_| "Stored device identity is corrupt".to_string())?;
            let array: [u8; 32] = bytes.try_into().map_err(|_| "Stored device identity is corrupt".to_string())?;
            SigningKey::from_bytes(&array)
        }
        None => {
            let key = SigningKey::generate(&mut OsRng);
            vault_set("device-private-key", &hex::encode(key.to_bytes()))?;
            key
        }
    };
    Ok((device_id, hex::encode(signing_key.verifying_key().to_bytes())))
}

#[tauri::command]
fn secure_auth_get() -> Result<Option<String>, String> {
    vault_get("supabase-auth-session")
}

#[tauri::command]
fn secure_auth_set(value: String) -> Result<(), String> {
    vault_set("supabase-auth-session", &value)
}

#[tauri::command]
fn secure_auth_delete() -> Result<(), String> {
    vault_delete("supabase-auth-session")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: String,
    device_public_key: String,
    platform: &'static str,
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    { "windows" }
    #[cfg(target_os = "macos")]
    { "macos" }
    #[cfg(target_os = "linux")]
    { "linux" }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    { "unsupported" }
}

#[tauri::command]
fn device_identity() -> Result<DeviceIdentity, String> {
    let (device_id, device_public_key) = random_identity()?;
    Ok(DeviceIdentity { device_id, device_public_key, platform: current_platform() })
}

fn validate_supabase_config(url: &str, publishable_key: &str, access_token: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "Invalid Supabase project URL".to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let has_credentials = !parsed.username().is_empty() || parsed.password().is_some();
    let has_extra_url_parts = parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some();
    let local_dev = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
        && parsed.port().is_some();
    let supabase_project = parsed.scheme() == "https"
        && (host.ends_with(".supabase.co") || host.ends_with(".supabase.in"))
        && parsed.port().map(|port| port == 443).unwrap_or(true);
    if has_credentials || has_extra_url_parts || (!local_dev && !supabase_project) {
        return Err("Only a valid HTTPS Supabase project URL is allowed (localhost is debug-only)".into());
    }
    if publishable_key.trim().len() < 20 || publishable_key.contains(char::is_whitespace) ||
       access_token.len() < 80 || access_token.contains(char::is_whitespace) {
        return Err("A valid signed-in Rub Minds session is required".into());
    }
    Ok(parsed.origin().ascii_serialization().trim_end_matches('/').to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceArgs {
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    room_id: String,
    device_label: String,
    os_version: String,
    app_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationSummary {
    device_id: String,
    room_id: String,
    status: String,
    credential_saved_to_os_store: bool,
}

#[tauri::command]
async fn register_desktop_device(app: AppHandle, args: RegisterDeviceArgs) -> Result<RegistrationSummary, String> {
    require_native_confirmation(&app, "Connect this computer to Rub Minds?", &format!(
        "Register this computer as a Backroom device for group {}. The selected application inventory will share labels and executable fingerprints, not file contents or application sessions.", args.room_id
    ))?;
    let base = validate_supabase_config(&args.supabase_url, &args.publishable_key, &args.access_token)?;
    if Uuid::parse_str(&args.room_id).is_err() || args.device_label.trim().is_empty() ||
       args.device_label.len() > 80 || args.os_version.len() > 40 ||
       args.app_version.trim().is_empty() || args.app_version.len() > 40 {
        return Err("Invalid device or group details".into());
    }
    if vault_get("device-token")?.is_some() {
        return Err("This computer already has a registered device credential. Revoke that device before registering it again.".into());
    }
    let (device_id, device_public_key) = random_identity()?;
    let client = Client::builder().timeout(Duration::from_secs(25)).build()
        .map_err(|_| "Could not initialize secure network transport".to_string())?;
    let response = client
        .post(format!("{base}/functions/v1/backroom-device"))
        .header("apikey", args.publishable_key.trim())
        .bearer_auth(&args.access_token)
        .json(&json!({
            "action": "desktop/register",
            "deviceId": device_id,
            "roomId": args.room_id,
            "deviceLabel": args.device_label.trim(),
            "platform": current_platform(),
            "osVersion": args.os_version,
            "appVersion": args.app_version.trim(),
            "devicePublicKey": device_public_key
        }))
        .send().await.map_err(|_| "Could not connect to Rub Minds. Check your internet connection.".to_string())?;
    let status = response.status();
    let body: Value = response.json().await
        .map_err(|_| "Rub Minds returned an invalid registration response".to_string())?;
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = body.get("reason").and_then(Value::as_str).unwrap_or("desktop_registration_failed");
        return Err(match reason {
            "room_owner_required" => "You must own this Rub Minds group to register this computer.".into(),
            "device_limit_reached" => "This account has reached its registered desktop device limit.".into(),
            "desktop_registration_conflict" => "This computer is already registered. Revoke the existing device first.".into(),
            "owner_auth_required" => "Your Rub Minds session expired. Sign in again.".into(),
            _ => "Rub Minds could not register this computer.".into(),
        });
    }
    let returned_id = body.get("deviceId").and_then(Value::as_str).unwrap_or_default();
    let token = body.get("deviceToken").and_then(Value::as_str).unwrap_or_default();
    let registered_status = body.get("status").and_then(Value::as_str).unwrap_or_default();
    if returned_id != device_id || registered_status != "active" ||
       token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Registration response failed local integrity checks".into());
    }
    // Persist the room binding before the bearer. Neither value is ever returned
    // to JavaScript; if the OS credential store fails, revoke the server row so
    // a successful HTTP registration cannot become an unreachable orphan device.
    let persistence = vault_set("device-room-id", &args.room_id)
        .and_then(|_| vault_set("device-token", &token.to_ascii_lowercase()));
    if let Err(storage_error) = persistence {
        let rollback = client
            .post(format!("{base}/functions/v1/backroom-device"))
            .header("apikey", args.publishable_key.trim())
            .bearer_auth(&args.access_token)
            .json(&json!({"action":"owner/revoke","roomId":args.room_id,"deviceId":device_id}))
            .send().await;
        let rollback_confirmed = match rollback {
            Ok(response) if response.status().is_success() => {
                response.json::<Value>().await
                    .map(|body| body.get("ok").and_then(Value::as_bool)==Some(true) &&
                        body.get("status").and_then(Value::as_str)==Some("revoked"))
                    .unwrap_or(false)
            }
            _ => false,
        };
        let _ = vault_delete("device-token");
        let _ = vault_delete("device-room-id");
        return Err(if rollback_confirmed {
            format!("The OS credential store could not save this computer's device token; the server registration was rolled back. {storage_error}")
        } else {
            "The OS credential store could not save the device token and server-side rollback was not confirmed. This device registration may still exist; revoke it from the Backroom device list before trying again.".into()
        });
    }
    Ok(RegistrationSummary {
        device_id,
        room_id: args.room_id,
        status: "active".into(),
        credential_saved_to_os_store: true,
    })
}

#[tauri::command]
async fn revoke_desktop_device(
    state: State<'_, AppState>,
    supabase_url: String,
    publishable_key: String,
    access_token: String,
    room_id: String,
) -> Result<(), String> {
    let device_id = vault_get("device-id")?.ok_or("This computer has no saved device identity")?;
    if vault_get("device-token")?.is_none() {
        return Err("This computer is not registered".into());
    }
    let base = validate_supabase_config(&supabase_url, &publishable_key, &access_token)?;
    if Uuid::parse_str(&room_id).is_err() || Uuid::parse_str(&device_id).is_err() {
        return Err("Invalid group or device identity".into());
    }
    let response = Client::builder().timeout(Duration::from_secs(25)).build()
        .map_err(|_| "Could not initialize secure network transport".to_string())?
        .post(format!("{base}/functions/v1/backroom-device"))
        .header("apikey", publishable_key.trim())
        .bearer_auth(&access_token)
        .json(&json!({"action":"owner/revoke","roomId":room_id,"deviceId":device_id}))
        .send().await.map_err(|_| "Could not reach Rub Minds to revoke this computer".to_string())?;
    let status = response.status();
    let body: Value = response.json().await
        .map_err(|_| "Rub Minds returned an invalid revocation response".to_string())?;
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) ||
       body.get("status").and_then(Value::as_str) != Some("revoked") {
        return Err("Rub Minds did not confirm computer revocation. The device credential remains stored.".into());
    }
    emergency_stop(state)?;
    clear_device_credentials()?;
    Ok(())
}

#[tauri::command]
async fn sync_desktop_app_inventory(
    app: AppHandle,
    supabase_url: String,
    publishable_key: String,
) -> Result<usize, String> {
    // Inventory originates exclusively from the native, locally approved app
    // registry. The WebView cannot submit or substitute arbitrary app records.
    let apps = load_apps(&app)?;
    if apps.len() > 100 {
        return Err("Select no more than 100 desktop applications".into());
    }
    let mut seen = std::collections::HashSet::new();
    for app in &apps {
        if Uuid::parse_str(&app.id).is_err() || app.label.trim().is_empty() ||
           app.label.len() > 120 || app.sha256.len() != 64 ||
           !app.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) ||
           !seen.insert(app.id.clone()) {
            return Err("Invalid locally approved desktop application inventory".into());
        }
    }
    let token = vault_get("device-token")?.ok_or("This computer is not registered")?;
    let base = validate_supabase_config(&supabase_url, &publishable_key, &"x".repeat(100))?;
    let payload = apps.iter().map(|app| json!({
        "appId":app.id,"label":app.label,"sha256":app.sha256.to_ascii_lowercase()
    })).collect::<Vec<_>>();
    let response = Client::builder().timeout(Duration::from_secs(25)).build()
        .map_err(|_| "Could not initialize secure network transport".to_string())?
        .post(format!("{base}/functions/v1/backroom-device"))
        .header("apikey", publishable_key.trim())
        .bearer_auth(token)
        .json(&json!({"action":"desktop/inventory","apps":payload}))
        .send().await.map_err(|_| "Could not sync the selected app inventory".to_string())?;
    let status = response.status();
    let body: Value = response.json().await
        .map_err(|_| "Rub Minds returned an invalid app inventory response".to_string())?;
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Rub Minds rejected the selected app inventory. Reconnect this computer and retry.".into());
    }
    Ok(body.get("synced").and_then(Value::as_u64).unwrap_or(0) as usize)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatus {
    status: String,
    device_id: String,
    room_id: String,
    app_discovery: bool,
    live_screen: bool,
    desktop_control: bool,
    terminal_control: bool,
}

#[tauri::command]
async fn desktop_device_status(
    state: State<'_, AppState>,
    supabase_url: String,
    publishable_key: String,
) -> Result<DeviceStatus, String> {
    let token = vault_get("device-token")?.ok_or("This computer is not registered")?;
    let device_id = vault_get("device-id")?.ok_or("This computer has no saved identity")?;
    let room_id = vault_get("device-room-id")?.unwrap_or_default();
    let base = validate_supabase_config(&supabase_url, &publishable_key, &"x".repeat(100))?;
    let client = Client::builder().timeout(Duration::from_secs(10)).build()
        .map_err(|_| "Could not initialize secure network transport".to_string())?;
    let response = client
        .post(format!("{base}/functions/v1/backroom-device"))
        .header("apikey", publishable_key.trim())
        .bearer_auth(token)
        .json(&json!({"action":"device/status"}))
        .send().await.map_err(|_| "Could not reach Rub Minds".to_string())?;
    let http_status = response.status();
    let body: Value = response.json().await.map_err(|_| "Invalid device status response".to_string())?;
    let revoked = body.get("status").and_then(Value::as_str) == Some("revoked")
        || (http_status.as_u16() == 401
            && body.get("reason").and_then(Value::as_str) == Some("device_auth_invalid"));
    if revoked {
        // A remote revocation is authoritative: close native processes and discard
        // the stale device identity so this computer can be enrolled again.
        emergency_stop(state)?;
        clear_device_credentials()?;
        return Ok(DeviceStatus {
            status: "revoked".into(),
            device_id,
            room_id,
            app_discovery: false,
            live_screen: false,
            desktop_control: false,
            terminal_control: false,
        });
    }
    if !http_status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Could not verify this computer's Rub Minds authorization. Retry when the connection is stable.".into());
    }
    let returned_device = body.get("deviceId").and_then(Value::as_str).unwrap_or_default();
    if returned_device != device_id {
        emergency_stop(state)?;
        clear_device_credentials()?;
        return Ok(DeviceStatus {
            status: "revoked".into(),
            device_id,
            room_id,
            app_discovery: false,
            live_screen: false,
            desktop_control: false,
            terminal_control: false,
        });
    }
    let caps = body.get("capabilities").cloned().unwrap_or(Value::Null);
    Ok(DeviceStatus {
        status: body.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        device_id: returned_device.to_string(),
        room_id,
        app_discovery: caps.get("appDiscovery").and_then(Value::as_bool).unwrap_or(false),
        live_screen: caps.get("liveScreen").and_then(Value::as_bool).unwrap_or(false),
        desktop_control: caps.get("desktopControl").and_then(Value::as_bool).unwrap_or(false),
        terminal_control: caps.get("terminalControl").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[tauri::command]
async fn close_desktop_session(
    supabase_url: String,
    publishable_key: String,
    session_id: String,
) -> Result<(), String> {
    if Uuid::parse_str(&session_id).is_err() {
        return Err("Invalid Backroom session identity".into());
    }
    let device_id = vault_get("device-id")?.ok_or("This computer has no saved device identity")?;
    let room_id = vault_get("device-room-id")?.ok_or("This computer has no saved group binding")?;
    let token = vault_get("device-token")?.ok_or("This computer is not registered")?;
    if Uuid::parse_str(&device_id).is_err() || Uuid::parse_str(&room_id).is_err() {
        return Err("Stored device identity is invalid".into());
    }
    let base = validate_supabase_config(&supabase_url, &publishable_key, &"x".repeat(100))?;
    let response = Client::builder().timeout(Duration::from_secs(10)).build()
        .map_err(|_| "Could not initialize secure network transport".to_string())?
        .post(format!("{base}/functions/v1/backroom-device"))
        .header("apikey", publishable_key.trim())
        .bearer_auth(token)
        .json(&json!({
            "action": "desktop/session-close",
            "roomId": room_id,
            "sessionId": session_id
        }))
        .send().await
        .map_err(|_| "Could not close the server-side Backroom session".to_string())?;
    let status = response.status();
    let body: Value = response.json().await
        .map_err(|_| "Rub Minds returned an invalid session-close response".to_string())?;
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Rub Minds could not close this desktop session. It will expire automatically.".into());
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovedApp {
    id: String,
    label: String,
    executable_path: String,
    sha256: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovedAppSummary {
    id: String,
    label: String,
    sha256: String,
}

fn app_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|_| "App data directory is unavailable".to_string())?;
    fs::create_dir_all(&dir).map_err(|_| "Could not create app registry".to_string())?;
    dir.push("approved-applications.json");
    Ok(dir)
}

fn load_apps(app: &AppHandle) -> Result<Vec<ApprovedApp>, String> {
    let path = app_registry_path(app)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "The local application registry is corrupt".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Could not read the local application registry".into()),
    }
}

fn save_apps(app: &AppHandle, entries: &[ApprovedApp]) -> Result<(), String> {
    let path = app_registry_path(app)?;
    let bytes = serde_json::to_vec_pretty(entries).map_err(|_| "Could not encode app registry".to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|_| "Could not save the local application registry".to_string())?;
    fs::rename(&temp, &path).map_err(|_| "Could not finalize the local application registry".to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "The selected application cannot be read".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| "Could not verify the selected application".to_string())?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[tauri::command]
async fn pick_and_register_app(app: AppHandle) -> Result<ApprovedAppSummary, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("Installed desktop application registration is currently enabled for Windows .exe files only.".into());
    }
    #[cfg(target_os = "windows")]
    {
        let selected = app.dialog().file()
            .add_filter("Windows applications", &["exe"])
            .blocking_pick_file()
            .ok_or("Application selection was cancelled")?;
        let path = selected.into_path().map_err(|_| "Invalid selected application path".to_string())?;
        let path = path.canonicalize().map_err(|_| "The selected application does not exist".to_string())?;
        if !path.is_absolute() || path.extension().and_then(|ext| ext.to_str()).map(|ext| !ext.eq_ignore_ascii_case("exe")).unwrap_or(true) {
            return Err("Only native Windows .exe applications can be registered".into());
        }
        let metadata = fs::metadata(&path).map_err(|_| "Could not inspect the selected application".to_string())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 * 1024 {
            return Err("The selected application file is invalid".into());
        }
        let sha256 = sha256_file(&path)?;
        let label = path.file_stem().and_then(|name| name.to_str()).unwrap_or("Windows application").chars().take(80).collect::<String>();
        let entry = ApprovedApp { id: Uuid::new_v4().to_string(), label, executable_path: path.to_string_lossy().to_string(), sha256: sha256.clone() };
        let mut apps = load_apps(&app)?;
        if apps.iter().any(|item| item.executable_path == entry.executable_path) {
            return Err("This application is already registered".into());
        }
        apps.push(entry.clone());
        save_apps(&app, &apps)?;
        Ok(ApprovedAppSummary { id: entry.id, label: entry.label, sha256 })
    }
}

#[tauri::command]
fn list_registered_apps(app: AppHandle) -> Result<Vec<ApprovedAppSummary>, String> {
    Ok(load_apps(&app)?.into_iter().map(|entry| ApprovedAppSummary {
        id: entry.id, label: entry.label, sha256: entry.sha256
    }).collect())
}

#[tauri::command]
async fn launch_registered_app(app: AppHandle, state: State<'_, AppState>, app_id: String) -> Result<u32, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, app_id);
        return Err("Windows desktop application launch is not available on this platform".into());
    }
    #[cfg(target_os = "windows")]
    {
        let apps = load_apps(&app)?;
        let entry = apps.into_iter().find(|item| item.id == app_id).ok_or("Application not found in the local allowlist")?;
        let path = PathBuf::from(&entry.executable_path);
        if !path.is_absolute() || path.extension().and_then(|ext| ext.to_str()).map(|ext| !ext.eq_ignore_ascii_case("exe")).unwrap_or(true) {
            return Err("Stored application path is invalid".into());
        }
        if sha256_file(&path)? != entry.sha256 {
            return Err("Application binary changed since it was approved. Remove it and approve the new binary.".into());
        }
        check_approval_rate(&state)?;
        require_native_confirmation(&app, "Launch approved application?", &format!(
            "Open {} on this computer?\\n\\nExecutable: {}\\n\\nThe app runs locally; Backroom does not receive its private files or login state.",
            entry.label, path.display()
        ))?;
        let parent = path.parent().ok_or("Application directory is unavailable")?;
        let mut processes = state.desktop_processes.lock().map_err(|_| "Desktop process registry unavailable")?;
        processes.retain(|_, process| process.try_wait().ok().flatten().is_none());
        if processes.len() >= MAX_ACTIVE_DESKTOP_PROCESSES {
            return Err("Backroom has reached the limit of 24 active launched applications. Stop an app or use Emergency Stop.".into());
        }
        let child = Command::new(&path).current_dir(parent).spawn().map_err(|_| "Windows could not launch the approved application".to_string())?;
        let pid = child.id();
        processes.insert(pid, child);
        Ok(pid)
    }
}

#[tauri::command]
fn stop_registered_app(state: State<'_, AppState>, pid: u32) -> Result<(), String> {
    let mut processes = state.desktop_processes.lock().map_err(|_| "Desktop process registry unavailable")?;
    let mut child = processes.remove(&pid).ok_or("This app was not launched by Backroom or is already closed")?;
    child.kill().map_err(|_| "Windows could not stop the selected Backroom application".to_string())
}

#[derive(Default)]
struct AppState {
    control_grants: Mutex<HashMap<String, Instant>>,
    draft_grants: Mutex<HashMap<String, Instant>>,
    capture_geometry: Mutex<HashMap<String, CaptureGeometry>>,
    draft_targets: Mutex<HashMap<String, DraftTarget>>,
    pending_drafts: Mutex<HashMap<String, PendingDraft>>,
    terminals: Mutex<HashMap<String, Arc<TerminalSession>>>,
    desktop_processes: Mutex<HashMap<u32, NativeChild>>,
    input_events: Mutex<VecDeque<Instant>>,
    approval_events: Mutex<VecDeque<Instant>>,
}

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
}

#[derive(Clone)]
struct CaptureGeometry {
    frame_width: u32,
    frame_height: u32,
    screen_width: u32,
    screen_height: u32,
    origin_x: i32,
    origin_y: i32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftTarget {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    // Never supplied by the remote caller. This is captured locally from UI Automation.
    #[serde(skip)]
    identity: Option<EditableTargetIdentity>,
}

struct PendingDraft {
    session_id: String,
    text: String,
    target: DraftTarget,
    expires_at: Instant,
}

fn valid_session_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn resolve_terminal_session_id(requested: Option<String>) -> Result<String, String> {
    match requested {
        Some(value) if valid_session_id(&value) => Ok(value),
        Some(_) => Err("Invalid terminal session identity".into()),
        None => Ok(Uuid::new_v4().to_string()),
    }
}

fn control_granted(state: &AppState, session_id: &str) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err("Invalid control session".into());
    }
    let mut grants = state.control_grants.lock().map_err(|_| "Control state unavailable")?;
    match grants.get(session_id) {
        Some(expires_at) if *expires_at > Instant::now() => Ok(()),
        _ => {
            grants.remove(session_id);
            Err("Local computer-control approval is required".into())
        }
    }
}

fn draft_granted(state: &AppState, session_id: &str) -> Result<(), String> {
    let mut grants = state.draft_grants.lock().map_err(|_| "Draft state unavailable")?;
    match grants.get(session_id) {
        Some(expires_at) if *expires_at > Instant::now() => Ok(()),
        _ => {
            grants.remove(session_id);
            Err("Local typing approval is required".into())
        }
    }
}

fn check_approval_rate(state: &AppState) -> Result<(), String> {
    let now = Instant::now();
    let mut events = state.approval_events.lock().map_err(|_| "Approval state unavailable")?;
    while events.front().map(|time| now.duration_since(*time) >= Duration::from_secs(60)).unwrap_or(false) {
        events.pop_front();
    }
    if events.len() >= MAX_NATIVE_APPROVALS_PER_MINUTE {
        return Err("Too many native approval prompts were requested. Wait one minute before approving more actions.".into());
    }
    events.push_back(now);
    Ok(())
}

fn check_input_rate(state: &AppState) -> Result<(), String> {
    let now = Instant::now();
    let mut events = state.input_events.lock().map_err(|_| "Input state unavailable")?;
    while events.front().map(|time| now.duration_since(*time) > Duration::from_secs(1)).unwrap_or(false) {
        events.pop_front();
    }
    if events.len() >= MAX_INPUT_EVENTS_PER_SECOND {
        return Err("Input rate limit exceeded".into());
    }
    events.push_back(now);
    Ok(())
}

#[tauri::command]
async fn grant_control(app: AppHandle, state: State<'_, AppState>, session_id: String, seconds: u64) -> Result<(), String> {
    if !valid_session_id(&session_id) { return Err("Invalid session".into()); }
    let has_live_capture = state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?
        .contains_key(&session_id);
    let has_live_terminal = state.terminals.lock().map_err(|_| "Terminal state unavailable")?
        .contains_key(&session_id);
    if !has_live_capture && !has_live_terminal {
        return Err("Control can only be granted to a live Backroom screen or terminal session".into());
    }
    check_approval_rate(&state)?;
    require_native_confirmation(&app, "Allow Backroom control?", &format!(
        "Allow this group to control local session {} for up to {} seconds? Pointer, keyboard, and terminal input may reach the selected application.",
        session_id, seconds.clamp(30, 600)
    ))?;
    let ttl = seconds.clamp(30, 600);
    state.control_grants.lock().map_err(|_| "Control state unavailable")?
        .insert(session_id, Instant::now() + Duration::from_secs(ttl));
    Ok(())
}

#[tauri::command]
fn revoke_control(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.control_grants.lock().map_err(|_| "Control state unavailable")?.remove(&session_id);
    state.draft_grants.lock().map_err(|_| "Draft state unavailable")?.remove(&session_id);
    state.draft_targets.lock().map_err(|_| "Draft state unavailable")?.remove(&session_id);
    state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?.remove(&session_id);
    let mut drafts = state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?;
    drafts.retain(|_, draft| draft.session_id != session_id);
    Ok(())
}

#[tauri::command]
async fn grant_draft_typing(app: AppHandle, state: State<'_, AppState>, session_id: String, seconds: u64) -> Result<(), String> {
    control_granted(&state, &session_id)?;
    if !state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?.contains_key(&session_id) {
        return Err("Draft typing is available only in an active screen session".into());
    }
    check_approval_rate(&state)?;
    require_native_confirmation(&app, "Allow unsent draft typing?", &format!(
        "Allow Backroom to type only into a drag-selected area of this live screen for up to {} seconds? It will not press Enter or Send.",
        seconds.clamp(30, 120)
    ))?;
    let ttl = seconds.clamp(30, 120);
    state.draft_grants.lock().map_err(|_| "Draft state unavailable")?
        .insert(session_id, Instant::now() + Duration::from_secs(ttl));
    Ok(())
}

#[tauri::command]
fn set_capture_geometry(
    state: State<'_, AppState>,
    session_id: String,
    frame_width: u32,
    frame_height: u32,
    screen_width_css: u32,
    screen_height_css: u32,
    device_scale_factor: f64,
    origin_x_css: i32,
    origin_y_css: i32,
    display_surface: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) || display_surface != "monitor" ||
       !(320..=16_384).contains(&frame_width) || !(200..=16_384).contains(&frame_height) ||
       !(320..=8_192).contains(&screen_width_css) || !(200..=8_192).contains(&screen_height_css) ||
       !device_scale_factor.is_finite() || !(0.5..=4.0).contains(&device_scale_factor) ||
       origin_x_css.unsigned_abs() > 16_384 || origin_y_css.unsigned_abs() > 16_384 {
        return Err("For safe input mapping, share an entire monitor instead of a single window".into());
    }
    let screen_width = (screen_width_css as f64 * device_scale_factor).round() as u32;
    let screen_height = (screen_height_css as f64 * device_scale_factor).round() as u32;
    let tolerance_x = (screen_width as f64 * 0.02).max(16.0) as u32;
    let tolerance_y = (screen_height as f64 * 0.02).max(16.0) as u32;
    if frame_width.abs_diff(screen_width) > tolerance_x || frame_height.abs_diff(screen_height) > tolerance_y {
        return Err("Captured monitor does not match this companion display. Move Backroom to the shared monitor and share it again.".into());
    }
    state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?.insert(session_id, CaptureGeometry {
        frame_width, frame_height, screen_width, screen_height,
        origin_x: (origin_x_css as f64 * device_scale_factor).round() as i32,
        origin_y: (origin_y_css as f64 * device_scale_factor).round() as i32,
    });
    Ok(())
}

fn screen_point(geometry: &CaptureGeometry, x: f64, y: f64) -> Result<(i32, i32), String> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err("Pointer coordinates are outside the shared monitor".into());
    }
    // Normalized 1.0 represents the last visible pixel, not the first
    // coordinate beyond the monitor bounds.
    let max_x = geometry.screen_width.saturating_sub(1) as f64;
    let max_y = geometry.screen_height.saturating_sub(1) as f64;
    let px = geometry.origin_x + (x * max_x).round() as i32;
    let py = geometry.origin_y + (y * max_y).round() as i32;
    Ok((px, py))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NativeInput {
    Move { x: f64, y: f64 },
    Click { x: f64, y: f64, button: String },
    Key { key: String },
    Text { text: String },
}

fn map_key(value: &str) -> Option<Key> {
    Some(match value {
        "Enter" => Key::Return, "Escape" => Key::Escape, "Tab" => Key::Tab,
        "Backspace" => Key::Backspace, "Delete" => Key::Delete, "Space" => Key::Space,
        "ArrowUp" => Key::UpArrow, "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow, "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home, "End" => Key::End, "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown, "Shift" => Key::Shift, "Control" => Key::Control,
        "Alt" => Key::Alt, "F1" => Key::F1, "F2" => Key::F2, "F3" => Key::F3,
        "F4" => Key::F4, "F5" => Key::F5, "F6" => Key::F6, "F7" => Key::F7,
        "F8" => Key::F8, "F9" => Key::F9, "F10" => Key::F10, "F11" => Key::F11,
        "F12" => Key::F12,
        _ => {
            let mut chars = value.chars();
            let ch = chars.next()?;
            if chars.next().is_some() || ch.is_control() { return None; }
            Key::Unicode(ch)
        }
    })
}

#[tauri::command]
fn dispatch_input(state: State<'_, AppState>, session_id: String, event: NativeInput) -> Result<(), String> {
    control_granted(&state, &session_id)?;
    check_input_rate(&state)?;
    let geometry = state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?
        .get(&session_id).cloned().ok_or("Live monitor capture is not active")?;
    let mut enigo = Enigo::new(&Settings::default()).map_err(|_| "OS input driver is unavailable. Check accessibility permissions.".to_string())?;
    match event {
        NativeInput::Move { x, y } => {
            let (px, py) = screen_point(&geometry, x, y)?;
            enigo.move_mouse(px, py, Coordinate::Abs).map_err(|_| "Could not move the desktop pointer".to_string())?;
        }
        NativeInput::Click { x, y, button } => {
            let (px, py) = screen_point(&geometry, x, y)?;
            enigo.move_mouse(px, py, Coordinate::Abs).map_err(|_| "Could not move the desktop pointer".to_string())?;
            let button = match button.as_str() {
                "left" => Button::Left, "right" => Button::Right, "middle" => Button::Middle,
                _ => return Err("Unsupported mouse button".into())
            };
            enigo.button(button, Direction::Click).map_err(|_| "Could not click the desktop".to_string())?;
        }
        NativeInput::Key { key } => {
            if matches!(key.as_str(), "Meta" | "Windows" | "Command" | "Alt+F4" | "Ctrl+Alt+Delete") {
                return Err("This system-level shortcut is disabled by the companion".into());
            }
            let key = map_key(&key).ok_or("Unsupported key")?;
            enigo.key(key, Direction::Click).map_err(|_| "Could not send key input".to_string())?;
        }
        NativeInput::Text { text } => {
            if text.is_empty() || text.chars().count() > MAX_DRAFT_CHARS || text.chars().any(char::is_control) {
                return Err("Text input must be plain, single-line text of at most 4000 characters".into());
            }
            enigo.text(&text).map_err(|_| "Could not type into the selected application".to_string())?;
        }
    }
    Ok(())
}

fn selected_target_point(geometry: &CaptureGeometry, target: &DraftTarget) -> Result<(i32, i32), String> {
    let center_x = target.x + target.width / 2.0;
    let center_y = target.y + target.height / 2.0;
    screen_point(geometry, center_x, center_y)
}

fn verify_selected_editable_target(
    geometry: &CaptureGeometry,
    target: &DraftTarget,
) -> Result<(EditableTargetIdentity, i32, i32), String> {
    let expected = target.identity.as_ref().ok_or("Select and verify an accessible text field again")?;
    let (px, py) = selected_target_point(geometry, target)?;
    let (current, value) = input_targeting::inspect_at(px, py)?;
    if &current != expected {
        return Err("The selected application field changed or moved. Drag-select it again.".into());
    }
    if !value.is_empty() {
        return Err("The selected field is no longer empty. Review it and select an empty field again.".into());
    }
    Ok((current, px, py))
}

#[tauri::command]
fn select_draft_target(state: State<'_, AppState>, session_id: String, mut target: DraftTarget) -> Result<(), String> {
    control_granted(&state, &session_id)?;
    draft_granted(&state, &session_id)?;
    let geometry = state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?
        .get(&session_id).cloned().ok_or("Live monitor capture is not active")?;
    if !target.x.is_finite() || !target.y.is_finite() || !target.width.is_finite() || !target.height.is_finite() ||
       target.x < 0.0 || target.y < 0.0 || target.width < 0.01 || target.height < 0.01 ||
       target.x + target.width > 1.0 || target.y + target.height > 1.0 {
        return Err("Select a visible text-entry area inside the frame".into());
    }
    if target.width * (geometry.frame_width as f64) < 8.0 || target.height * (geometry.frame_height as f64) < 8.0 {
        return Err("Selected typing area is too small".into());
    }
    let (px, py) = selected_target_point(&geometry, &target)?;
    let (identity, value) = input_targeting::inspect_at(px, py)?;
    if !value.is_empty() {
        return Err("For safety, drag-select an empty editable field. Existing text will not be overwritten.".into());
    }
    target.identity = Some(identity);
    state.draft_targets.lock().map_err(|_| "Draft state unavailable")?.insert(session_id, target);
    Ok(())
}

#[tauri::command]
fn stage_draft_request(state: State<'_, AppState>, session_id: String, text: String) -> Result<String, String> {
    control_granted(&state, &session_id)?;
    draft_granted(&state, &session_id)?;
    if text.trim().is_empty() || text.chars().count() > MAX_DRAFT_CHARS || text.chars().any(char::is_control) {
        return Err("Draft must be non-empty, single-line plain text".into());
    }
    let target = state.draft_targets.lock().map_err(|_| "Draft state unavailable")?
        .get(&session_id).cloned().ok_or("Drag-select and verify an empty editable field first")?;
    if target.identity.is_none() {
        return Err("The selected text area has no verified accessibility identity. Select it again.".into());
    }
    let request_id = Uuid::new_v4().to_string();
    let now = Instant::now();
    let mut pending = state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?;
    pending.retain(|_, draft| draft.expires_at > now);
    if pending.len() >= 32 {
        return Err("Too many unsent draft requests are waiting for local approval".into());
    }
    pending.insert(request_id.clone(), PendingDraft {
        session_id, text, target, expires_at: now + Duration::from_secs(60),
    });
    Ok(request_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDraftSummary {
    request_id: String,
    text: String,
    session_id: String,
    expires_in_seconds: u64,
}

#[tauri::command]
fn list_pending_drafts(state: State<'_, AppState>) -> Result<Vec<PendingDraftSummary>, String> {
    let now = Instant::now();
    let mut pending = state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?;
    pending.retain(|_, draft| draft.expires_at > now);
    Ok(pending.iter().map(|(id, draft)| PendingDraftSummary {
        request_id: id.clone(), text: draft.text.clone(), session_id: draft.session_id.clone(),
        expires_in_seconds: draft.expires_at.saturating_duration_since(now).as_secs().min(60),
    }).collect())
}

#[tauri::command]
async fn approve_draft_request(app: AppHandle, state: State<'_, AppState>, request_id: String) -> Result<String, String> {
    let pending = state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?
        .remove(&request_id).ok_or("Draft request expired or no longer exists")?;
    if pending.expires_at <= Instant::now() {
        return Err("Draft request expired. Inspect the target and ask again.".into());
    }
    control_granted(&state, &pending.session_id)?;
    draft_granted(&state, &pending.session_id)?;
    check_approval_rate(&state)?;

    // The first check happens before the native approval dialog; no stale
    // selection is presented as valid to the person approving it.
    let geometry_before = state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?
        .get(&pending.session_id).cloned().ok_or("Live monitor capture is not active")?;
    verify_selected_editable_target(&geometry_before, &pending.target)?;

    require_native_confirmation(&app, "Insert this unsent draft?", &format!(
        "Insert this exact text into the verified empty text field you selected? Backroom will recheck the field identity and its empty value before typing. It will not press Enter or Send.\\n\\n{}",
        pending.text
    ))?;

    // Re-check after approval. The app may have moved, closed or populated
    // the field while the native confirmation dialog was open.
    control_granted(&state, &pending.session_id)?;
    draft_granted(&state, &pending.session_id)?;
    let geometry = state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?
        .get(&pending.session_id).cloned().ok_or("Live monitor capture is not active")?;
    let (identity, px, py) = verify_selected_editable_target(&geometry, &pending.target)?;

    // Consume before the one-shot UIA ValuePattern operation. The native driver
    // re-resolves the exact element, verifies it is still empty, writes directly
    // to that element and reads the exact value back. No global click/keyboard
    // injection, Enter, Send, or automatic retry is involved.
    state.draft_targets.lock().map_err(|_| "Draft state unavailable")?.remove(&pending.session_id);
    input_targeting::set_value_exact(px, py, &identity, &pending.text)?;
    Ok("Text inserted into the verified editable field and read back exactly. No Enter or Send action was performed.".into())
}

#[tauri::command]
fn deny_draft_request(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?.remove(&request_id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStarted {
    session_id: String,
    shell_label: String,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: Vec<u8>,
}

#[tauri::command]
async fn start_terminal(app: AppHandle, state: State<'_, AppState>, session_id: Option<String>) -> Result<TerminalStarted, String> {
    check_approval_rate(&state)?;
    require_native_confirmation(&app, "Start a native terminal?", "Start a local PowerShell/zsh/bash shell for this Backroom session? A separate time-limited control approval is needed before remote typing is enabled.")?;
    let mut active_terminals = state.terminals.lock().map_err(|_| "Terminal registry unavailable")?;
    if active_terminals.len() >= MAX_ACTIVE_TERMINALS {
        return Err("Backroom has reached the limit of four active terminal sessions. Stop a terminal or use Emergency Stop.".into());
    }
    // Validate / reserve the identity before any shell process is spawned.
    let session_id = resolve_terminal_session_id(session_id)?;
    if active_terminals.contains_key(&session_id) {
        return Err("This terminal session identity is already active".into());
    }
    let system = native_pty_system();
    let pair = system.openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|_| "Could not create the native terminal session".to_string())?;
    #[cfg(target_os = "windows")]
    let (shell, label) = ("powershell.exe", "Windows PowerShell");
    #[cfg(target_os = "macos")]
    let (shell, label) = ("/bin/zsh", "zsh");
    #[cfg(target_os = "linux")]
    let (shell, label) = ("/bin/bash", "bash");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("Native terminal is not supported on this operating system".into());
    let mut command = CommandBuilder::new(shell);
    command.env("TERM", "xterm-256color");
    command.env("CLICOLOR", "1");
    let child = pair.slave.spawn_command(command).map_err(|_| "Could not launch the native terminal shell".to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|_| "Could not attach terminal output".to_string())?;
    let writer = pair.master.take_writer().map_err(|_| "Could not attach terminal input".to_string())?;
    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    active_terminals.insert(session_id.clone(), session);
    let event_app = app.clone();
    let event_id = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    let _ = event_app.emit("backroom-terminal-output", TerminalOutput {
                        session_id: event_id.clone(), data: buffer[..size].to_vec()
                    });
                }
            }
        }
        let _ = event_app.emit("backroom-terminal-exited", json!({"sessionId":event_id}));
    });
    Ok(TerminalStarted { session_id, shell_label: label.into(), cols: 100, rows: 30 })
}

#[tauri::command]
fn write_terminal(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    control_granted(&state, &session_id)?;
    check_input_rate(&state)?;
    if data.is_empty() || data.len() > MAX_TERMINAL_INPUT || data.contains('\0') {
        return Err("Terminal input is empty or exceeds the 4000-character limit".into());
    }
    let sessions = state.terminals.lock().map_err(|_| "Terminal registry unavailable")?;
    let session = sessions.get(&session_id).ok_or("Terminal session is closed")?;
    let mut writer = session.writer.lock().map_err(|_| "Terminal writer unavailable")?;
    writer.write_all(data.as_bytes()).map_err(|_| "Terminal input failed")?;
    writer.flush().map_err(|_| "Terminal input failed")
}

#[tauri::command]
fn resize_terminal(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    control_granted(&state, &session_id)?;
    if !(20..=300).contains(&cols) || !(5..=120).contains(&rows) {
        return Err("Terminal dimensions are outside the supported range".into());
    }
    let sessions = state.terminals.lock().map_err(|_| "Terminal registry unavailable")?;
    let session = sessions.get(&session_id).ok_or("Terminal session is closed")?;
    session.master.lock().map_err(|_| "Terminal resize is unavailable")?
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|_| "Terminal resize failed".into())
}

#[tauri::command]
fn stop_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    revoke_control_inner(&state, &session_id)?;
    let session = state.terminals.lock().map_err(|_| "Terminal registry unavailable")?
        .remove(&session_id).ok_or("Terminal session is already closed")?;
    session.child.lock().map_err(|_| "Terminal process state unavailable")?
        .kill().map_err(|_| "Could not stop the terminal shell".to_string())
}

fn revoke_control_inner(state: &AppState, session_id: &str) -> Result<(), String> {
    state.control_grants.lock().map_err(|_| "Control state unavailable")?.remove(session_id);
    state.draft_grants.lock().map_err(|_| "Draft state unavailable")?.remove(session_id);
    state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?.remove(session_id);
    state.draft_targets.lock().map_err(|_| "Draft state unavailable")?.remove(session_id);
    state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?.retain(|_, draft| draft.session_id != session_id);
    Ok(())
}

#[tauri::command]
fn emergency_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.control_grants.lock().map_err(|_| "Control state unavailable")?.clear();
    state.draft_grants.lock().map_err(|_| "Draft state unavailable")?.clear();
    state.capture_geometry.lock().map_err(|_| "Capture state unavailable")?.clear();
    state.draft_targets.lock().map_err(|_| "Draft state unavailable")?.clear();
    state.pending_drafts.lock().map_err(|_| "Draft state unavailable")?.clear();
    let sessions = std::mem::take(&mut *state.terminals.lock().map_err(|_| "Terminal registry unavailable")?);
    for (_, session) in sessions {
        let _ = session.child.lock().map(|mut child| child.kill());
    }
    let processes = std::mem::take(&mut *state.desktop_processes.lock().map_err(|_| "Desktop process registry unavailable")?);
    for (_, mut child) in processes {
        let _ = child.kill();
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            secure_auth_get, secure_auth_set, secure_auth_delete,
            device_identity, register_desktop_device, desktop_device_status, sync_desktop_app_inventory, revoke_desktop_device, close_desktop_session,
            pick_and_register_app, list_registered_apps, launch_registered_app, stop_registered_app,
            grant_control, revoke_control, grant_draft_typing, set_capture_geometry,
            dispatch_input, select_draft_target, stage_draft_request, list_pending_drafts,
            approve_draft_request, deny_draft_request, start_terminal, write_terminal,
            resize_terminal, stop_terminal, emergency_stop
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Rub Minds Backroom Companion");
}


#[cfg(test)]
mod native_input_tests {
    use super::*;

    fn geometry() -> CaptureGeometry {
        CaptureGeometry {
            frame_width: 1920,
            frame_height: 1080,
            screen_width: 1920,
            screen_height: 1080,
            origin_x: 0,
            origin_y: 0,
        }
    }

    #[test]
    fn supabase_endpoint_validation_rejects_token_exfiltration_hosts() {
        let key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
        let token = "a".repeat(100);
        for attacker in [
            "https://evil.example",
            "https://project.supabase.co.attacker.example",
            "https://user:pass@project.supabase.co",
            "https://project.supabase.co/path",
            "https://project.supabase.co?redirect=https://evil.example",
            "https://project.supabase.co#fragment",
            "http://project.supabase.co",
        ] {
            assert!(validate_supabase_config(attacker, key, &token).is_err(), "accepted {attacker}");
        }
    }

    #[test]
    fn supabase_endpoint_validation_accepts_project_hosts_and_debug_loopback() {
        let key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
        let token = "a".repeat(100);
        assert_eq!(
            validate_supabase_config("https://project-ref.supabase.co/", key, &token).unwrap(),
            "https://project-ref.supabase.co"
        );
        assert_eq!(
            validate_supabase_config("https://project-ref.supabase.in", key, &token).unwrap(),
            "https://project-ref.supabase.in"
        );
        if cfg!(debug_assertions) {
            assert_eq!(
                validate_supabase_config("http://127.0.0.1:54321", key, &token).unwrap(),
                "http://127.0.0.1:54321"
            );
            assert_eq!(
                validate_supabase_config("http://localhost:54321", key, &token).unwrap(),
                "http://localhost:54321"
            );
        } else {
            assert!(validate_supabase_config("http://127.0.0.1:54321", key, &token).is_err());
        }
    }

    #[test]
    fn supabase_endpoint_validation_requires_publishable_key_and_user_session() {
        assert!(validate_supabase_config(
            "https://project-ref.supabase.co",
            "short",
            &"a".repeat(100)
        ).is_err());
        assert!(validate_supabase_config(
            "https://project-ref.supabase.co",
            "sb_publishable_abcdefghijklmnopqrstuvwxyz",
            "short"
        ).is_err());
    }

    #[test]
    fn terminal_session_uses_server_authorized_peer_uuid() {
        let peer_id = Uuid::new_v4().to_string();
        assert_eq!(resolve_terminal_session_id(Some(peer_id.clone())).unwrap(), peer_id);
    }

    #[test]
    fn terminal_session_rejects_malformed_remote_identity() {
        assert!(resolve_terminal_session_id(Some("not-a-session".into())).is_err());
    }

    #[test]
    fn local_terminal_can_generate_its_own_identity() {
        let id = resolve_terminal_session_id(None).unwrap();
        assert!(valid_session_id(&id));
    }

    #[test]
    fn normalized_pointer_maps_to_visible_monitor_pixels() {
        let g = geometry();
        assert_eq!(screen_point(&g, 0.0, 0.0).unwrap(), (0, 0));
        assert_eq!(screen_point(&g, 0.5, 0.5).unwrap(), (960, 540));
        assert_eq!(screen_point(&g, 1.0, 1.0).unwrap(), (1919, 1079));
    }

    #[test]
    fn pointer_coordinates_outside_frame_are_rejected() {
        let g = geometry();
        assert!(screen_point(&g, -0.001, 0.5).is_err());
        assert!(screen_point(&g, 1.001, 0.5).is_err());
        assert!(screen_point(&g, f64::NAN, 0.5).is_err());
        assert!(screen_point(&g, 0.5, f64::INFINITY).is_err());
    }

    #[test]
    fn input_rate_guard_caps_events_per_second() {
        let state = AppState::default();
        for _ in 0..MAX_INPUT_EVENTS_PER_SECOND {
            assert!(check_input_rate(&state).is_ok());
        }
        assert!(check_input_rate(&state).is_err());
    }

    #[test]
    fn invalid_session_identifiers_never_validate() {
        assert!(valid_session_id(&Uuid::new_v4().to_string()));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../other-session"));
    }

    #[test]
    fn native_approval_dialogs_are_rate_limited() {
        let state = AppState::default();
        for _ in 0..MAX_NATIVE_APPROVALS_PER_MINUTE {
            assert!(check_approval_rate(&state).is_ok());
        }
        assert!(check_approval_rate(&state).is_err());
    }
}
