#![cfg_attr(not(feature = "dev-bridge"), allow(dead_code, unused_imports))]

use axum::extract::{Json, Request};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use rand_core::{OsRng, RngCore};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH,
    CONTENT_TYPE,
};
use reqwest::{Client, Method, Request as ReqwestRequest, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, PhysicalSize, WebviewWindow, WindowEvent};
use tokio::sync::Mutex as TokioMutex;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{
    HeaderName as WsHeaderName, HeaderValue as WsHeaderValue,
};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendRequestArgs {
    #[serde(default)]
    request_id: String,
    method: String,
    url: String,
    params: Vec<KeyValuePair>,
    headers: Vec<KeyValuePair>,
    body: RequestBodyInput,
    auth: AuthInput,
    #[serde(default)]
    proxy: Option<ProxyConfig>,
    #[serde(default)]
    tls: Option<TlsConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyConfig {
    enabled: bool,
    #[serde(rename = "type")]
    proxy_type: String,
    host: String,
    port: u16,
    auth: Option<ProxyAuth>,
}

#[derive(Deserialize)]
struct ProxyAuth {
    username: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsConfig {
    verify_ssl: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct KeyValuePair {
    enabled: bool,
    key: String,
    value: String,
    #[serde(default)]
    description: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct EnvVariable {
    key: String,
    value: String,
    secret: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    vault_key: String,
}

#[derive(Serialize, Deserialize)]
struct Environment {
    name: String,
    variables: Vec<EnvVariable>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FormDataItem {
    enabled: bool,
    key: String,
    value: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_form_data_value_type")]
    value_type: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    file_path: String,
    #[serde(default)]
    file_content: Option<String>,
    #[serde(default)]
    content_type: String,
}

fn default_form_data_value_type() -> String {
    "text".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestBodyInput {
    #[serde(rename = "type")]
    body_type: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    form_data: Vec<FormDataItem>,
    #[serde(default)]
    binary_path: String,
    #[serde(default)]
    binary_content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInput {
    #[serde(rename = "type")]
    auth_type: String,
    basic: Option<BasicAuth>,
    bearer: Option<BearerAuth>,
    api_key: Option<ApiKeyAuth>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BasicAuth {
    username: String,
    password: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct BearerAuth {
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyAuth {
    key: String,
    value: String,
    add_to: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
struct RequestTimings {
    dns_lookup: u64,
    tcp_connect: u64,
    tls_handshake: u64,
    ttfb: u64,
    download: u64,
    total: u64,
}

impl Default for RequestTimings {
    fn default() -> Self {
        Self {
            dns_lookup: 0,
            tcp_connect: 0,
            tls_handshake: 0,
            ttfb: 0,
            download: 0,
            total: 0,
        }
    }
}

/// Upper bound on how much of the overall request budget the pre-connect
/// timing probe may consume. The probe spends *from* the total budget, never
/// on top of it.
const CONNECTION_PROBE_MAX: Duration = Duration::from_secs(5);

/// Share the remaining probe budget fairly across the addresses still to be
/// tried, so a single blackholed address cannot starve the ones behind it.
fn per_attempt_budget(remaining: Duration, remaining_attempts: usize) -> Duration {
    if remaining_attempts == 0 || remaining.is_zero() {
        return Duration::ZERO;
    }
    remaining / remaining_attempts as u32
}

/// Connection loop with an injectable `connect`, so the budget arithmetic and
/// the address walk can be tested without sockets or wall-clock timing.
/// Returns the index of the address that connected and how long it took.
fn connect_first_reachable_with<C>(
    addrs: &[SocketAddr],
    total_budget: Duration,
    mut connect: C,
) -> Option<(usize, u64)>
where
    C: FnMut(&SocketAddr, Duration) -> std::io::Result<()>,
{
    let mut remaining = total_budget;
    for (index, addr) in addrs.iter().enumerate() {
        let budget = per_attempt_budget(remaining, addrs.len() - index);
        if budget.is_zero() {
            return None;
        }
        let started_at = Instant::now();
        let outcome = connect(addr, budget);
        let elapsed = started_at.elapsed();
        remaining = remaining.saturating_sub(elapsed);
        if outcome.is_ok() {
            return Some((index, elapsed.as_millis() as u64));
        }
    }
    None
}

fn connect_first_reachable(addrs: &[SocketAddr], total_budget: Duration) -> Option<u64> {
    connect_first_reachable_with(addrs, total_budget, |addr, budget| {
        std::net::TcpStream::connect_timeout(addr, budget).map(drop)
    })
    .map(|(_, elapsed)| elapsed)
}

/// Bound the whole probe - DNS resolution included - by `budget`. Every failure
/// mode collapses to "not measured"; the probe never decides whether the real
/// request runs.
async fn run_probe_within_budget<F>(budget: Duration, probe: F) -> (u64, u64)
where
    F: std::future::Future<Output = Result<(u64, u64), String>>,
{
    match tokio::time::timeout(budget, probe).await {
        Ok(Ok(measured)) => measured,
        Ok(Err(_)) => (0, 0),
        Err(_) => (0, 0),
    }
}

/// The fallible half of the probe. Runs entirely on the blocking pool because
/// both `to_socket_addrs` and `connect_timeout` are synchronous.
fn probe_connection(host: String, port: u16) -> Result<(u64, u64), String> {
    let addr = format!("{host}:{port}");
    let dns_started_at = Instant::now();
    let addrs = addr
        .to_socket_addrs()
        .map(|iter| iter.collect::<Vec<_>>())
        .map_err(|error| format!("DNS resolve failed: {error}"))?;
    let dns_lookup = dns_started_at.elapsed().as_millis() as u64;

    if addrs.is_empty() {
        return Err("DNS resolve failed: no addresses found".to_string());
    }

    // DNS really was measured, so report it even when no address answers;
    // the connect leg stays 0 because it was never successfully measured.
    let tcp_connect = connect_first_reachable(&addrs, CONNECTION_PROBE_MAX).unwrap_or(0);
    Ok((dns_lookup, tcp_connect))
}

/// Public entry point. Deliberately infallible: there is no error channel for a
/// probe failure to escape through, so no call site can let the probe decide
/// the fate of the request.
async fn measure_connection_timings(url: &Url, budget: Duration) -> (u64, u64) {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return (0, 0);
    };
    let host = host.to_string();

    let handle = tokio::task::spawn_blocking(move || probe_connection(host, port));
    let probe = async move {
        match handle.await {
            Ok(result) => result,
            Err(error) => Err(format!("Connection probe task failed: {error}")),
        }
    };
    run_probe_within_budget(budget, probe).await
}

/// Machine-readable companion to `HttpResponse::body`. Without it the frontend
/// could only tell an ApiSolo placeholder from genuine server text by matching
/// the placeholder string, which is a far worse contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResponseBodyKind {
    Text,
    Binary,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    size: u64,
    time: u64,
    timings: RequestTimings,
    content_type: String,
    body_kind: ResponseBodyKind,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    method: String,
    url: String,
    status: u16,
    time: u64,
    size: u64,
    #[serde(default)]
    timings: RequestTimings,
    timestamp: String,
    content_type: String,
    #[serde(default)]
    request_params: Vec<KeyValuePair>,
    #[serde(default)]
    request_headers: Vec<KeyValuePair>,
    #[serde(default)]
    request_body_type: String,
    #[serde(default)]
    request_body_content: String,
    #[serde(default)]
    request_auth_type: String,
    #[serde(default)]
    request_auth: Option<AuthSave>,
    #[serde(default)]
    request_body_form_data: Vec<FormDataItem>,
    #[serde(default)]
    request_body_binary_path: String,
    #[serde(default)]
    request_body_binary_content: Option<String>,
    #[serde(default)]
    pre_request_script: String,
    #[serde(default)]
    test_script: String,
    #[serde(default)]
    response_body: String,
    #[serde(default)]
    response_headers: Vec<(String, String)>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    name: String,
    description: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionNode {
    name: String,
    path: String,
    node_type: String,
    #[serde(default)]
    children: Vec<CollectionNode>,
    method: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestBodySave {
    #[serde(rename = "type")]
    body_type: String,
    content: String,
    #[serde(default)]
    form_data: Vec<FormDataItem>,
    #[serde(default)]
    binary_path: String,
    #[serde(default)]
    binary_content: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthSave {
    #[serde(rename = "type")]
    auth_type: String,
    basic: Option<BasicAuth>,
    bearer: Option<BearerAuth>,
    #[serde(rename = "apiKey")]
    api_key: Option<ApiKeyAuth>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedRequest {
    name: String,
    method: String,
    url: String,
    #[serde(default)]
    params: Vec<KeyValuePair>,
    #[serde(default)]
    headers: Vec<KeyValuePair>,
    body: RequestBodySave,
    auth: AuthSave,
    #[serde(default)]
    pre_request_script: String,
    #[serde(default)]
    test_script: String,
}

#[derive(Clone)]
struct ResolvedProject {
    meta: ProjectMeta,
    dir: PathBuf,
}

const PROJECT_META_FILE: &str = "apisolo.project.json";
const MAX_HISTORY_ENTRIES: usize = 1000;
const WINDOW_STATE_FILE: &str = "window-state.json";
const SECRET_STORAGE_CONFIG_FILE: &str = "secret-storage.json";
const LOCAL_SECRET_VAULT_FILE: &str = "secrets.vault.json";
const LOCAL_SECRET_VAULT_VERSION: u8 = 1;
const LOCAL_SECRET_VAULT_SALT_BYTES: usize = 16;
const LOCAL_SECRET_VAULT_NONCE_BYTES: usize = 12;
const LOCAL_SECRET_VAULT_KEY_BYTES: usize = 32;
const DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT: usize = 256;
const DEV_BRIDGE_ENABLE_ENV: &str = "APISOLO_ENABLE_DEV_BRIDGE";
const DEV_BRIDGE_TOKEN_ENV: &str = "APISOLO_DEV_BRIDGE_TOKEN";

type WsSender = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;

static WS_CONNECTIONS: OnceLock<Arc<TokioMutex<HashMap<String, WsSender>>>> = OnceLock::new();
static WS_EVENT_QUEUES: OnceLock<Arc<TokioMutex<HashMap<String, Vec<WsEventPayload>>>>> =
    OnceLock::new();
static WS_SUPPRESSED_DISCONNECT_EVENTS: OnceLock<Arc<TokioMutex<HashMap<String, ()>>>> =
    OnceLock::new();
static ACTIVE_REQUESTS: OnceLock<Arc<TokioMutex<HashMap<String, ActiveRequestState>>>> =
    OnceLock::new();
static SECRET_VAULT_SESSION: OnceLock<StdMutex<SecretVaultSession>> = OnceLock::new();
#[cfg(feature = "dev-bridge")]
static DEV_SERVER_STARTED: OnceLock<()> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SecretStorageBackend {
    LocalEncrypted,
    SystemKeychain,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretStorageConfig {
    backend: SecretStorageBackend,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStorageState {
    configured: bool,
    backend: Option<SecretStorageBackend>,
    locked: bool,
    vault_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSecretVaultFile {
    version: u8,
    kdf: String,
    cipher: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Default)]
struct SecretVaultSession {
    local_key: Option<[u8; LOCAL_SECRET_VAULT_KEY_BYTES]>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsEventPayload {
    connection_id: String,
    event_type: String,
    content: String,
    timestamp: String,
}

struct ActiveRequestState {
    cancel_requested: bool,
    handle: Option<AbortHandle>,
}

impl Default for ActiveRequestState {
    fn default() -> Self {
        Self {
            cancel_requested: false,
            handle: None,
        }
    }
}

fn ws_pool() -> Arc<TokioMutex<HashMap<String, WsSender>>> {
    WS_CONNECTIONS
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

fn ws_event_queue_pool() -> Arc<TokioMutex<HashMap<String, Vec<WsEventPayload>>>> {
    WS_EVENT_QUEUES
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

fn ws_suppressed_disconnect_pool() -> Arc<TokioMutex<HashMap<String, ()>>> {
    WS_SUPPRESSED_DISCONNECT_EVENTS
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

fn active_request_pool() -> Arc<TokioMutex<HashMap<String, ActiveRequestState>>> {
    ACTIVE_REQUESTS
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

async fn publish_ws_event(app: Option<&tauri::AppHandle>, payload: WsEventPayload) {
    if let Some(app) = app {
        let event_name = format!("ws-event-{}", payload.connection_id);
        let _ = app.emit(&event_name, payload.clone());
        return;
    }

    if payload.event_type == "disconnected" {
        let suppress_pool = ws_suppressed_disconnect_pool();
        let mut suppressed = suppress_pool.lock().await;
        if suppressed.remove(&payload.connection_id).is_some() {
            ws_event_queue_pool()
                .lock()
                .await
                .remove(&payload.connection_id);
            return;
        }
    }

    let pool = ws_event_queue_pool();
    let mut queues = pool.lock().await;
    let queue = queues.entry(payload.connection_id.clone()).or_default();
    queue.push(payload);
    if queue.len() > DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT {
        let overflow = queue.len() - DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT;
        queue.drain(0..overflow);
    }
}

async fn register_active_request(request_id: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let pool = active_request_pool();
    pool.lock()
        .await
        .insert(request_id.to_string(), ActiveRequestState::default());
}

async fn unregister_active_request(request_id: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let pool = active_request_pool();
    pool.lock().await.remove(request_id);
}

async fn set_active_request_handle(request_id: &str, handle: AbortHandle) {
    if request_id.trim().is_empty() {
        return;
    }

    let pool = active_request_pool();
    let mut requests = pool.lock().await;
    if let Some(state) = requests.get_mut(request_id) {
        if state.cancel_requested {
            handle.abort();
        }
        state.handle = Some(handle);
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn data_dir() -> Result<PathBuf, String> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let root = home_dir.join("ApiSolo");
    fs::create_dir_all(root.join("projects"))
        .map_err(|error| format!("Failed to create projects directory: {error}"))?;
    let scratch_dir = root.join("scratch");
    fs::create_dir_all(&scratch_dir)
        .map_err(|error| format!("Failed to create scratch directory: {error}"))?;

    let history_path = scratch_dir.join("history.jsonl");
    if !history_path.exists() {
        fs::write(&history_path, "")
            .map_err(|error| format!("Failed to create history file: {error}"))?;
    }

    Ok(root)
}

fn projects_dir() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("projects"))
}

fn history_file_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join("history.jsonl"))
}

fn window_state_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join(WINDOW_STATE_FILE))
}

fn secret_storage_config_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join(SECRET_STORAGE_CONFIG_FILE))
}

fn local_secret_vault_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join(LOCAL_SECRET_VAULT_FILE))
}

fn read_window_state() -> Result<Option<WindowState>, String> {
    let path = window_state_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read window state: {error}"))?;
    let state = serde_json::from_str::<WindowState>(&contents)
        .map_err(|error| format!("Failed to parse window state: {error}"))?;

    if is_valid_window_size(state.width, state.height) {
        Ok(Some(state))
    } else {
        Ok(None)
    }
}

fn write_window_state(state: &WindowState) -> Result<(), String> {
    if !is_valid_window_size(state.width, state.height) {
        return Ok(());
    }

    let path = window_state_path()?;
    fs::write(&path, pretty_json(state)?)
        .map_err(|error| format!("Failed to save window state: {error}"))
}

fn is_valid_window_size(width: u32, height: u32) -> bool {
    (640..=10_000).contains(&width) && (480..=10_000).contains(&height)
}

fn restore_window_state(window: &WebviewWindow) {
    let Some(state) = (match read_window_state() {
        Ok(state) => state,
        Err(error) => {
            eprintln!("{error}");
            None
        }
    }) else {
        return;
    };

    if let Err(error) = window.set_size(PhysicalSize::new(state.width, state.height)) {
        eprintln!("Failed to restore window size: {error}");
    }
}

fn save_window_state(window: &WebviewWindow) {
    let Ok(size) = window.inner_size() else {
        return;
    };

    if let Err(error) = write_window_state(&WindowState {
        width: size.width,
        height: size.height,
    }) {
        eprintln!("{error}");
    }
}

fn register_window_state_persistence(window: WebviewWindow) {
    let tracked_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_)) {
            save_window_state(&tracked_window);
        }
    });
}

/// Process-wide mutex for the history file. Every read-modify-write command
/// takes it as its first statement, *before* any file I/O — taking it after the
/// read would leave the lost-update window wide open.
fn history_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

fn lock_history() -> MutexGuard<'static, ()> {
    history_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Test-only rendezvous point at the start of each history file I/O, used by
/// the lock tests to park a command inside its first I/O and probe the lock.
/// Compiles away entirely outside `cfg(test)`.
#[cfg(not(test))]
#[inline(always)]
fn io_checkpoint(_tag: &'static str) {}

#[cfg(test)]
struct IoCheckpoint {
    notify: std::sync::mpsc::Sender<&'static str>,
    resume: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
fn checkpoint_slot() -> &'static StdMutex<Option<IoCheckpoint>> {
    static SLOT: OnceLock<StdMutex<Option<IoCheckpoint>>> = OnceLock::new();
    SLOT.get_or_init(|| StdMutex::new(None))
}

#[cfg(test)]
fn io_checkpoint(tag: &'static str) {
    // take() ⇒ each installed checkpoint fires at most once; a command's second
    // I/O passes straight through instead of deadlocking against a test that
    // only resumes once. The inner block releases the slot guard before we
    // block, otherwise the test thread could not reach the slot.
    let taken = {
        checkpoint_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    };

    if let Some(checkpoint) = taken {
        let _ = checkpoint.notify.send(tag);
        let _ = checkpoint.resume.recv();
    }
}

fn read_history_entries() -> Result<Vec<HistoryEntry>, String> {
    io_checkpoint("read");
    let history_path = history_file_path()?;
    let file = fs::File::open(&history_path)
        .map_err(|error| format!("Failed to open history file: {error}"))?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|error| format!("Failed to read history file: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let entry = serde_json::from_str::<HistoryEntry>(&line)
            .map_err(|error| format!("Failed to parse history entry: {error}"))?;
        entries.push(entry);
    }

    Ok(entries)
}

fn write_history_entries(entries: &[HistoryEntry]) -> Result<(), String> {
    io_checkpoint("write");
    let history_path = history_file_path()?;
    let mut file = fs::File::create(&history_path)
        .map_err(|error| format!("Failed to write history file: {error}"))?;

    for entry in entries {
        let line = serde_json::to_string(entry)
            .map_err(|error| format!("Failed to serialize history entry: {error}"))?;
        writeln!(file, "{line}")
            .map_err(|error| format!("Failed to write history entry: {error}"))?;
    }

    Ok(())
}

fn validate_relative_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Parent directory traversal is not allowed".to_string())
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid path component".to_string())
            }
        }
    }

    Ok(normalized)
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if (ch.is_whitespace() || ch == '-' || ch == '_')
            && !last_was_dash
            && !slug.is_empty()
        {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

fn sanitize_file_label(value: &str) -> String {
    if value.trim().is_empty() {
        return String::new();
    }

    Path::new(value)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or(value)
        .to_string()
}

fn pretty_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize JSON: {error}"))
}

fn read_project_meta(project_dir: &Path) -> Result<ProjectMeta, String> {
    let contents = fs::read_to_string(project_dir.join(PROJECT_META_FILE))
        .map_err(|error| format!("Failed to read project metadata: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse project metadata: {error}"))
}

fn write_project_meta(project_dir: &Path, meta: &ProjectMeta) -> Result<(), String> {
    fs::write(project_dir.join(PROJECT_META_FILE), pretty_json(meta)?)
        .map_err(|error| format!("Failed to write project metadata: {error}"))
}

fn list_resolved_projects() -> Result<Vec<ResolvedProject>, String> {
    let dir = projects_dir()?;
    let mut projects = Vec::new();

    for entry in
        fs::read_dir(dir).map_err(|error| format!("Failed to read projects directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read project entry: {error}"))?;
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }

        let meta_path = entry_path.join(PROJECT_META_FILE);
        if !meta_path.exists() {
            continue;
        }

        let meta = read_project_meta(&entry_path)?;
        projects.push(ResolvedProject {
            meta,
            dir: entry_path,
        });
    }

    projects.sort_by(|left, right| {
        left.meta
            .name
            .to_lowercase()
            .cmp(&right.meta.name.to_lowercase())
    });
    Ok(projects)
}

fn resolve_project(project: &str) -> Result<ResolvedProject, String> {
    let project_key = project.trim();
    if project_key.is_empty() {
        return Err("Project name is required".to_string());
    }

    let mut matches = list_resolved_projects()?
        .into_iter()
        .filter(|item| {
            item.meta.name == project_key
                || item
                    .dir
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value == project_key)
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    match matches.len() {
        0 => Err(format!("Project not found: {project_key}")),
        1 => Ok(matches.remove(0)),
        _ => Err(format!("Project name is ambiguous: {project_key}")),
    }
}

fn touch_project(project_dir: &Path) -> Result<(), String> {
    let mut meta = read_project_meta(project_dir)?;
    meta.updated_at = now_iso();
    write_project_meta(project_dir, &meta)
}

fn project_collections_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("collections")
}

fn project_environments_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("environments")
}

fn environment_file_path(project_dir: &Path, name: &str, secrets: bool) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Environment name is required".to_string());
    }

    let slug = slugify(trimmed);
    let suffix = if secrets {
        ".env.secrets.json"
    } else {
        ".env.json"
    };
    Ok(project_environments_dir(project_dir).join(format!("{slug}{suffix}")))
}

fn read_env_variables(file_path: &Path, secret: bool) -> Result<Vec<EnvVariable>, String> {
    if !file_path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(file_path)
        .map_err(|error| format!("Failed to read environment file: {error}"))?;
    let mut variables = serde_json::from_str::<Vec<EnvVariable>>(&contents)
        .map_err(|error| format!("Failed to parse environment file: {error}"))?;

    for variable in &mut variables {
        variable.secret = secret;
        if !secret {
            variable.vault_key.clear();
        }
    }

    Ok(variables)
}

fn vault_key_for(project_dir: &Path, env_name: &str, variable_key: &str) -> String {
    let project = project_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project");
    let encoded_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(variable_key);

    format!(
        "{}:{}:{}",
        sanitize_vault_component(project),
        sanitize_vault_component(env_name),
        encoded_key
    )
}

fn sanitize_vault_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "value".to_string()
    } else {
        sanitized
    }
}

fn secret_vault_session() -> &'static StdMutex<SecretVaultSession> {
    SECRET_VAULT_SESSION.get_or_init(|| StdMutex::new(SecretVaultSession::default()))
}

fn read_secret_storage_config() -> Result<Option<SecretStorageConfig>, String> {
    let path = secret_storage_config_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read secret storage config: {error}"))?;
    let config = serde_json::from_str::<SecretStorageConfig>(&contents)
        .map_err(|error| format!("Failed to parse secret storage config: {error}"))?;
    Ok(Some(config))
}

fn write_secret_storage_config(config: &SecretStorageConfig) -> Result<(), String> {
    let path = secret_storage_config_path()?;
    fs::write(&path, pretty_json(config)?)
        .map_err(|error| format!("Failed to save secret storage config: {error}"))
}

fn parse_secret_storage_backend(value: &str) -> Result<SecretStorageBackend, String> {
    match value {
        "local-encrypted" => Ok(SecretStorageBackend::LocalEncrypted),
        "system-keychain" => Ok(SecretStorageBackend::SystemKeychain),
        _ => Err("Unsupported secret storage backend".to_string()),
    }
}

fn get_secret_storage_state_inner() -> Result<SecretStorageState, String> {
    let config = read_secret_storage_config()?;
    let vault_path = local_secret_vault_path()?.to_string_lossy().to_string();

    let Some(config) = config else {
        return Ok(SecretStorageState {
            configured: false,
            backend: None,
            locked: true,
            vault_path,
        });
    };

    let locked = match config.backend {
        SecretStorageBackend::LocalEncrypted => secret_vault_session()
            .lock()
            .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
            .local_key
            .is_none(),
        SecretStorageBackend::SystemKeychain => false,
    };

    Ok(SecretStorageState {
        configured: true,
        backend: Some(config.backend),
        locked,
        vault_path,
    })
}

fn require_secret_storage_backend() -> Result<SecretStorageBackend, String> {
    read_secret_storage_config()?
        .map(|config| config.backend)
        .ok_or_else(|| "Secret storage is not configured".to_string())
}

fn derive_local_secret_key(
    master_password: &str,
    salt: &[u8],
) -> Result<[u8; LOCAL_SECRET_VAULT_KEY_BYTES], String> {
    let mut key = [0_u8; LOCAL_SECRET_VAULT_KEY_BYTES];
    argon2::Argon2::default()
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("Failed to derive local secret vault key: {error}"))?;
    Ok(key)
}

fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_base64(value: &str, label: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("Failed to decode {label}: {error}"))
}

fn read_local_secret_vault_file() -> Result<Option<LocalSecretVaultFile>, String> {
    let path = local_secret_vault_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read local secret vault: {error}"))?;
    let vault_file = serde_json::from_str::<LocalSecretVaultFile>(&contents)
        .map_err(|error| format!("Failed to parse local secret vault: {error}"))?;
    Ok(Some(vault_file))
}

fn validate_local_secret_vault_file(
    vault_file: &LocalSecretVaultFile,
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    if vault_file.version != LOCAL_SECRET_VAULT_VERSION {
        return Err("Unsupported local secret vault version".to_string());
    }
    if vault_file.kdf != "argon2id" || vault_file.cipher != "chacha20poly1305" {
        return Err("Unsupported local secret vault format".to_string());
    }

    let salt = decode_base64(&vault_file.salt, "local secret vault salt")?;
    let nonce = decode_base64(&vault_file.nonce, "local secret vault nonce")?;
    let ciphertext = decode_base64(&vault_file.ciphertext, "local secret vault ciphertext")?;

    if salt.len() != LOCAL_SECRET_VAULT_SALT_BYTES {
        return Err("Invalid local secret vault salt length".to_string());
    }
    if nonce.len() != LOCAL_SECRET_VAULT_NONCE_BYTES {
        return Err("Invalid local secret vault nonce length".to_string());
    }

    Ok((salt, nonce, ciphertext))
}

fn decrypt_local_secret_map(
    vault_file: &LocalSecretVaultFile,
    key: &[u8; LOCAL_SECRET_VAULT_KEY_BYTES],
) -> Result<(HashMap<String, String>, Vec<u8>), String> {
    let (salt, nonce, ciphertext) = validate_local_secret_vault_file(vault_file)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| {
            "Failed to unlock local secret vault. Check the master password.".to_string()
        })?;
    let values = serde_json::from_slice::<HashMap<String, String>>(&plaintext)
        .map_err(|error| format!("Failed to parse local secret vault values: {error}"))?;
    Ok((values, salt))
}

fn write_local_secret_map(
    values: &HashMap<String, String>,
    key: &[u8; LOCAL_SECRET_VAULT_KEY_BYTES],
    salt: &[u8],
) -> Result<(), String> {
    if salt.len() != LOCAL_SECRET_VAULT_SALT_BYTES {
        return Err("Invalid local secret vault salt length".to_string());
    }

    let mut nonce = [0_u8; LOCAL_SECRET_VAULT_NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);

    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = serde_json::to_vec(values)
        .map_err(|error| format!("Failed to serialize local secret vault values: {error}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "Failed to encrypt local secret vault".to_string())?;

    let vault_file = LocalSecretVaultFile {
        version: LOCAL_SECRET_VAULT_VERSION,
        kdf: "argon2id".to_string(),
        cipher: "chacha20poly1305".to_string(),
        salt: encode_base64(salt),
        nonce: encode_base64(&nonce),
        ciphertext: encode_base64(&ciphertext),
    };

    fs::write(local_secret_vault_path()?, pretty_json(&vault_file)?)
        .map_err(|error| format!("Failed to save local secret vault: {error}"))
}

fn unlock_local_secret_storage(master_password: &str) -> Result<(), String> {
    if master_password.is_empty() {
        return Err("Local secret vault master password is required".to_string());
    }

    match read_local_secret_vault_file()? {
        Some(vault_file) => {
            let (salt, _, _) = validate_local_secret_vault_file(&vault_file)?;
            let key = derive_local_secret_key(master_password, &salt)?;
            decrypt_local_secret_map(&vault_file, &key)?;
            secret_vault_session()
                .lock()
                .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
                .local_key = Some(key);
        }
        None => {
            let mut salt = [0_u8; LOCAL_SECRET_VAULT_SALT_BYTES];
            OsRng.fill_bytes(&mut salt);
            let key = derive_local_secret_key(master_password, &salt)?;
            write_local_secret_map(&HashMap::new(), &key, &salt)?;
            secret_vault_session()
                .lock()
                .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
                .local_key = Some(key);
        }
    }

    Ok(())
}

fn current_local_secret_key() -> Result<[u8; LOCAL_SECRET_VAULT_KEY_BYTES], String> {
    secret_vault_session()
        .lock()
        .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
        .local_key
        .ok_or_else(|| "Local secret vault is locked".to_string())
}

fn load_local_secret_map() -> Result<Option<(HashMap<String, String>, Vec<u8>)>, String> {
    let Some(vault_file) = read_local_secret_vault_file()? else {
        return Ok(None);
    };
    let key = current_local_secret_key()?;
    decrypt_local_secret_map(&vault_file, &key).map(Some)
}

#[cfg(test)]
fn clear_secret_vault_session() {
    if let Ok(mut session) = secret_vault_session().lock() {
        session.local_key = None;
    }
}

#[cfg(test)]
fn test_system_secret_vault() -> &'static StdMutex<HashMap<String, String>> {
    static VAULT: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();
    VAULT.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[cfg(test)]
fn save_system_secret_value(vault_key: &str, value: &str) -> Result<(), String> {
    test_system_secret_vault()
        .lock()
        .map_err(|error| format!("Failed to lock test system secret vault: {error}"))?
        .insert(vault_key.to_string(), value.to_string());
    Ok(())
}

#[cfg(test)]
fn load_system_secret_value(vault_key: &str) -> Result<String, String> {
    Ok(test_system_secret_vault()
        .lock()
        .map_err(|error| format!("Failed to lock test system secret vault: {error}"))?
        .get(vault_key)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
fn delete_system_secret_value(vault_key: &str) -> Result<(), String> {
    test_system_secret_vault()
        .lock()
        .map_err(|error| format!("Failed to lock test system secret vault: {error}"))?
        .remove(vault_key);
    Ok(())
}

#[cfg(not(test))]
fn save_system_secret_value(vault_key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("ApiSolo", vault_key)
        .map_err(|error| format!("Failed to open system secret vault: {error}"))?;
    entry
        .set_password(value)
        .map_err(|error| format!("Failed to save secret in system vault: {error}"))
}

#[cfg(not(test))]
fn load_system_secret_value(vault_key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new("ApiSolo", vault_key)
        .map_err(|error| format!("Failed to open system secret vault: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(error) => Err(format!("Failed to read secret from system vault: {error}")),
    }
}

#[cfg(not(test))]
fn delete_system_secret_value(vault_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("ApiSolo", vault_key)
        .map_err(|error| format!("Failed to open system secret vault: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete secret from system vault: {error}"
        )),
    }
}

fn save_secret_value(vault_key: &str, value: &str) -> Result<(), String> {
    match require_secret_storage_backend()? {
        SecretStorageBackend::LocalEncrypted => {
            let Some((mut values, salt)) = load_local_secret_map()? else {
                return Err(
                    "Local secret vault is missing. Reconfigure secret storage.".to_string()
                );
            };
            let key = current_local_secret_key()?;
            values.insert(vault_key.to_string(), value.to_string());
            write_local_secret_map(&values, &key, &salt)
        }
        SecretStorageBackend::SystemKeychain => save_system_secret_value(vault_key, value),
    }
}

fn load_secret_value(vault_key: &str) -> Result<String, String> {
    match require_secret_storage_backend()? {
        SecretStorageBackend::LocalEncrypted => {
            let Some((values, _)) = load_local_secret_map()? else {
                return Ok(String::new());
            };
            Ok(values.get(vault_key).cloned().unwrap_or_default())
        }
        SecretStorageBackend::SystemKeychain => load_system_secret_value(vault_key),
    }
}

fn delete_secret_value(vault_key: &str) -> Result<(), String> {
    match require_secret_storage_backend()? {
        SecretStorageBackend::LocalEncrypted => {
            let Some((mut values, salt)) = load_local_secret_map()? else {
                return Ok(());
            };
            let key = current_local_secret_key()?;
            values.remove(vault_key);
            write_local_secret_map(&values, &key, &salt)
        }
        SecretStorageBackend::SystemKeychain => delete_system_secret_value(vault_key),
    }
}

fn resolve_secret_variables(
    project_dir: &Path,
    env_name: &str,
    variables: Vec<EnvVariable>,
    secrets_path: &Path,
) -> Result<Vec<EnvVariable>, String> {
    let mut migrated = false;
    let mut resolved = Vec::with_capacity(variables.len());

    for mut variable in variables {
        variable.secret = true;
        let vault_key = if variable.vault_key.trim().is_empty() {
            migrated = true;
            vault_key_for(project_dir, env_name, &variable.key)
        } else {
            variable.vault_key.clone()
        };

        if !variable.value.is_empty() {
            save_secret_value(&vault_key, &variable.value)?;
            migrated = true;
        }

        variable.value = load_secret_value(&vault_key)?;
        variable.vault_key = vault_key;
        resolved.push(variable);
    }

    if migrated {
        write_secret_metadata(secrets_path, &resolved)?;
    }

    Ok(resolved)
}

fn write_secret_metadata(file_path: &Path, variables: &[EnvVariable]) -> Result<(), String> {
    let metadata = variables
        .iter()
        .map(|variable| EnvVariable {
            key: variable.key.clone(),
            value: String::new(),
            secret: true,
            vault_key: variable.vault_key.clone(),
        })
        .collect::<Vec<_>>();

    fs::write(file_path, pretty_json(&metadata)?)
        .map_err(|error| format!("Failed to save environment secret metadata: {error}"))
}

fn merge_environment_variables(
    mut base: Vec<EnvVariable>,
    overlay: Vec<EnvVariable>,
) -> Vec<EnvVariable> {
    for variable in overlay {
        if let Some(existing) = base.iter_mut().find(|item| item.key == variable.key) {
            *existing = variable;
        } else {
            base.push(variable);
        }
    }
    base
}

fn resolve_template(template: &str, variables: &[EnvVariable]) -> String {
    let mut output = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut index = 0;
    let mut last_literal_start = 0;

    while index < bytes.len() {
        if bytes[index] == b'{' && index + 1 < bytes.len() && bytes[index + 1] == b'{' {
            let mut end = index + 2;
            while end + 1 < bytes.len() {
                if bytes[end] == b'}' && bytes[end + 1] == b'}' {
                    break;
                }
                end += 1;
            }

            if end + 1 < bytes.len() && bytes[end] == b'}' && bytes[end + 1] == b'}' {
                output.push_str(&template[last_literal_start..index]);
                let key = template[index + 2..end].trim();
                let replacement = match key {
                    "$timestamp" => Utc::now().timestamp().to_string(),
                    "$isoTimestamp" => now_iso(),
                    "$randomUUID" => Uuid::new_v4().to_string(),
                    _ => variables
                        .iter()
                        .find(|item| item.key == key)
                        .map(|item| item.value.clone())
                        .unwrap_or_else(|| template[index..end + 2].to_string()),
                };
                output.push_str(&replacement);
                index = end + 2;
                last_literal_start = index;
                continue;
            }
        }
        index += 1;
    }

    output.push_str(&template[last_literal_start..]);
    output
}

fn request_file_path(project_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let safe_path = validate_relative_path(relative_path)?;
    if safe_path.as_os_str().is_empty() {
        return Err("Request path is required".to_string());
    }

    let file_path = project_collections_dir(project_dir).join(safe_path);
    if file_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("Request path must point to a JSON file".to_string());
    }

    Ok(file_path)
}

fn collection_dir_path(project_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let safe_path = validate_relative_path(relative_path)?;
    Ok(project_collections_dir(project_dir).join(safe_path))
}

fn read_saved_request(file_path: &Path) -> Result<SavedRequest, String> {
    let contents = fs::read_to_string(file_path)
        .map_err(|error| format!("Failed to read saved request: {error}"))?;
    let request = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse saved request: {error}"))?;
    Ok(sanitize_saved_request_for_persistence(request))
}

fn sanitize_saved_request_for_persistence(mut request: SavedRequest) -> SavedRequest {
    request.params = redact_key_value_pairs(request.params);
    request.headers = redact_key_value_pairs(request.headers);
    request.auth = redact_auth_save(request.auth);
    request.body.content = redact_sensitive_text(&request.body.content);
    request.body.binary_path = sanitize_file_label(&request.body.binary_path);
    request.body.binary_content = None;
    request.body.form_data = request
        .body
        .form_data
        .into_iter()
        .map(|mut item| {
            if item.value_type == "file" {
                item.value.clear();
                item.file_name = sanitize_file_label(if item.file_name.is_empty() {
                    &item.file_path
                } else {
                    &item.file_name
                });
                item.file_path.clear();
                item.file_content = None;
            } else {
                item.value = redact_value(&item.key, &item.value);
            }
            item
        })
        .collect();
    request
}

fn redact_auth_save(auth: AuthSave) -> AuthSave {
    match auth.auth_type.as_str() {
        "basic" => AuthSave {
            auth_type: auth.auth_type,
            basic: auth.basic.map(|basic| BasicAuth {
                username: basic.username,
                password: preserve_template_or_empty(&basic.password),
            }),
            bearer: None,
            api_key: None,
        },
        "bearer" => AuthSave {
            auth_type: auth.auth_type,
            basic: None,
            bearer: auth.bearer.map(|bearer| BearerAuth {
                token: preserve_template_or_empty(&bearer.token),
            }),
            api_key: None,
        },
        "api-key" => AuthSave {
            auth_type: auth.auth_type,
            basic: None,
            bearer: None,
            api_key: auth.api_key.map(|api_key| ApiKeyAuth {
                key: api_key.key,
                value: preserve_template_or_empty(&api_key.value),
                add_to: api_key.add_to,
            }),
        },
        _ => AuthSave {
            auth_type: "none".to_string(),
            basic: None,
            bearer: None,
            api_key: None,
        },
    }
}

fn redact_key_value_pairs(items: Vec<KeyValuePair>) -> Vec<KeyValuePair> {
    items
        .into_iter()
        .map(|mut item| {
            item.value = redact_value(&item.key, &item.value);
            item
        })
        .collect()
}

fn redact_value(key: &str, value: &str) -> String {
    if is_sensitive_key(key) {
        preserve_template_or_empty(value)
    } else {
        redact_sensitive_text(value)
    }
}

fn preserve_template_or_empty(value: &str) -> String {
    if value.contains("{{") && value.contains("}}") {
        value.to_string()
    } else {
        String::new()
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "set-cookie",
        "token",
        "secret",
        "password",
        "passwd",
        "api-key",
        "apikey",
        "x-api-key",
        "subscription-key",
        "signature",
        "credential",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn redact_sensitive_text(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }

    value
        .split('&')
        .map(|part| {
            let Some((key, _)) = part.split_once('=') else {
                return part.to_string();
            };
            if is_sensitive_key(key) {
                format!("{key}=[redacted]")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn build_collection_tree(dir: &Path, relative: PathBuf) -> Result<Vec<CollectionNode>, String> {
    let mut folders = Vec::new();
    let mut requests = Vec::new();

    for entry in fs::read_dir(dir)
        .map_err(|error| format!("Failed to read collection directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read collection entry: {error}"))?;
        let entry_path = entry.path();
        let name = entry
            .file_name()
            .to_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Invalid collection entry name".to_string())?;

        if entry_path.is_dir() {
            let child_relative = relative.join(&name);
            folders.push(CollectionNode {
                name,
                path: child_relative.to_string_lossy().replace('\\', "/"),
                node_type: "folder".to_string(),
                children: build_collection_tree(&entry_path, child_relative)?,
                method: None,
            });
            continue;
        }

        if entry_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let child_relative = relative.join(&name);
        let saved_request = read_saved_request(&entry_path)?;
        requests.push(CollectionNode {
            name: saved_request.name,
            path: child_relative.to_string_lossy().replace('\\', "/"),
            node_type: "request".to_string(),
            children: Vec::new(),
            method: Some(saved_request.method),
        });
    }

    folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    requests.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    folders.extend(requests);
    Ok(folders)
}

#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    Ok(data_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
fn get_secret_storage_state() -> Result<SecretStorageState, String> {
    get_secret_storage_state_inner()
}

#[tauri::command]
fn configure_secret_storage(
    backend: String,
    master_password: Option<String>,
) -> Result<SecretStorageState, String> {
    let backend = parse_secret_storage_backend(&backend)?;

    match backend {
        SecretStorageBackend::LocalEncrypted => {
            let password = master_password.unwrap_or_default();
            if password.chars().count() < 8 {
                return Err(
                    "Local secret vault master password must be at least 8 characters".to_string(),
                );
            }
            unlock_local_secret_storage(&password)?;
        }
        SecretStorageBackend::SystemKeychain => {
            secret_vault_session()
                .lock()
                .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
                .local_key = None;
        }
    }

    write_secret_storage_config(&SecretStorageConfig { backend })?;
    get_secret_storage_state_inner()
}

#[tauri::command]
fn unlock_secret_storage(master_password: String) -> Result<SecretStorageState, String> {
    match require_secret_storage_backend()? {
        SecretStorageBackend::LocalEncrypted => {
            unlock_local_secret_storage(&master_password)?;
        }
        SecretStorageBackend::SystemKeychain => {}
    }

    get_secret_storage_state_inner()
}

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectMeta>, String> {
    Ok(list_resolved_projects()?
        .into_iter()
        .map(|item| item.meta)
        .collect())
}

#[tauri::command]
fn create_project(name: String, description: String) -> Result<ProjectMeta, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Project name is required".to_string());
    }

    if list_resolved_projects()?
        .iter()
        .any(|item| item.meta.name == trimmed_name)
    {
        return Err(format!("Project already exists: {trimmed_name}"));
    }

    let project_dir = projects_dir()?.join(slugify(trimmed_name));
    if project_dir.exists() {
        return Err("A project directory with the same slug already exists".to_string());
    }

    fs::create_dir_all(project_dir.join("collections"))
        .map_err(|error| format!("Failed to create collections directory: {error}"))?;
    fs::create_dir_all(project_dir.join("environments"))
        .map_err(|error| format!("Failed to create environments directory: {error}"))?;

    let timestamp = now_iso();
    let meta = ProjectMeta {
        name: trimmed_name.to_string(),
        description: description.trim().to_string(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    write_project_meta(&project_dir, &meta)?;
    Ok(meta)
}

#[tauri::command]
fn get_collection_tree(project: String) -> Result<Vec<CollectionNode>, String> {
    let resolved = resolve_project(&project)?;
    let collections_dir = project_collections_dir(&resolved.dir);
    fs::create_dir_all(&collections_dir)
        .map_err(|error| format!("Failed to create collections directory: {error}"))?;
    build_collection_tree(&collections_dir, PathBuf::new())
}

#[tauri::command]
fn save_request(
    project: String,
    collection: String,
    request: SavedRequest,
    existing_path: Option<String>,
) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let collection_dir = collection_dir_path(&resolved.dir, &collection)?;
    fs::create_dir_all(&collection_dir)
        .map_err(|error| format!("Failed to create collection directory: {error}"))?;

    let request_name = request.name.trim();
    if request_name.is_empty() {
        return Err("Request name is required".to_string());
    }

    let file_path = collection_dir.join(format!("{}.request.json", slugify(request_name)));
    let existing_file_path = match existing_path.as_deref() {
        Some(path) if !path.trim().is_empty() => Some(request_file_path(&resolved.dir, path)?),
        _ => None,
    };

    if file_path.exists() && existing_file_path.as_ref() != Some(&file_path) {
        return Err("Request with the same name already exists".to_string());
    }

    let request = sanitize_saved_request_for_persistence(request);

    fs::write(&file_path, pretty_json(&request)?)
        .map_err(|error| format!("Failed to save request: {error}"))?;

    if let Some(existing_file_path) = existing_file_path {
        if existing_file_path != file_path && existing_file_path.exists() {
            fs::remove_file(&existing_file_path)
                .map_err(|error| format!("Failed to remove previous request file: {error}"))?;
        }
    }

    touch_project(&resolved.dir)
}

#[tauri::command]
fn load_request(project: String, path: String) -> Result<SavedRequest, String> {
    let resolved = resolve_project(&project)?;
    let file_path = request_file_path(&resolved.dir, &path)?;
    if !file_path.exists() {
        return Err("Saved request does not exist".to_string());
    }
    read_saved_request(&file_path)
}

#[tauri::command]
fn create_collection(project: String, name: String, parent: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Collection name is required".to_string());
    }

    let parent_dir = collection_dir_path(&resolved.dir, &parent)?;
    fs::create_dir_all(&parent_dir)
        .map_err(|error| format!("Failed to create parent collection directory: {error}"))?;

    let collection_dir = parent_dir.join(slugify(trimmed_name));
    fs::create_dir_all(&collection_dir)
        .map_err(|error| format!("Failed to create collection: {error}"))?;
    touch_project(&resolved.dir)
}

#[tauri::command]
fn rename_collection(project: String, path: String, new_name: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let safe_path = validate_relative_path(&path)?;
    if safe_path.as_os_str().is_empty() {
        return Err("Collection path is required".to_string());
    }

    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        return Err("Collection name is required".to_string());
    }

    let current_dir = project_collections_dir(&resolved.dir).join(&safe_path);
    if !current_dir.exists() {
        return Err("Collection does not exist".to_string());
    }

    let parent_dir = current_dir
        .parent()
        .ok_or_else(|| "Collection parent directory is invalid".to_string())?;
    let target_dir = parent_dir.join(slugify(trimmed_name));

    if target_dir != current_dir && target_dir.exists() {
        return Err("Collection with the same name already exists".to_string());
    }

    fs::rename(&current_dir, &target_dir)
        .map_err(|error| format!("Failed to rename collection: {error}"))?;
    touch_project(&resolved.dir)
}

#[tauri::command]
fn delete_request(project: String, path: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let file_path = request_file_path(&resolved.dir, &path)?;
    if !file_path.exists() {
        return Err("Saved request does not exist".to_string());
    }
    fs::remove_file(&file_path).map_err(|error| format!("Failed to delete request: {error}"))?;
    touch_project(&resolved.dir)
}

#[tauri::command]
fn rename_request(project: String, path: String, new_name: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let file_path = request_file_path(&resolved.dir, &path)?;
    if !file_path.exists() {
        return Err("Saved request does not exist".to_string());
    }

    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        return Err("Request name is required".to_string());
    }

    let target_file = file_path
        .parent()
        .ok_or_else(|| "Request parent directory is invalid".to_string())?
        .join(format!("{}.request.json", slugify(trimmed_name)));

    if target_file != file_path && target_file.exists() {
        return Err("Request with the same name already exists".to_string());
    }

    let mut request = read_saved_request(&file_path)?;
    request.name = trimmed_name.to_string();

    if target_file != file_path {
        fs::rename(&file_path, &target_file)
            .map_err(|error| format!("Failed to rename request file: {error}"))?;
    }

    fs::write(&target_file, pretty_json(&request)?)
        .map_err(|error| format!("Failed to update request name: {error}"))?;

    touch_project(&resolved.dir)
}

#[tauri::command]
fn move_request(project: String, from_path: String, to_collection: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let safe_from_path = validate_relative_path(&from_path)?;
    if safe_from_path.as_os_str().is_empty() {
        return Err("Request path is required".to_string());
    }

    let safe_to_collection = validate_relative_path(&to_collection)?;
    let current_collection = safe_from_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    if current_collection == safe_to_collection {
        return Err("Request is already in the target collection".to_string());
    }

    let source_file = request_file_path(&resolved.dir, &from_path)?;
    if !source_file.exists() {
        return Err("Saved request does not exist".to_string());
    }

    let file_name = source_file
        .file_name()
        .ok_or_else(|| "Request file name is invalid".to_string())?;
    let target_dir = collection_dir_path(&resolved.dir, &to_collection)?;
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Failed to create target collection: {error}"))?;

    let target_file = target_dir.join(file_name);
    if target_file.exists() {
        return Err(
            "Request with the same file name already exists in the target collection".to_string(),
        );
    }

    let contents =
        fs::read(&source_file).map_err(|error| format!("Failed to read request file: {error}"))?;
    fs::write(&target_file, contents)
        .map_err(|error| format!("Failed to write moved request: {error}"))?;
    fs::remove_file(&source_file)
        .map_err(|error| format!("Failed to remove original request file: {error}"))?;

    touch_project(&resolved.dir)
}

#[tauri::command]
fn delete_collection(project: String, path: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let safe_path = validate_relative_path(&path)?;
    if safe_path.as_os_str().is_empty() {
        return Err("Collection path is required".to_string());
    }

    let collection_dir = project_collections_dir(&resolved.dir).join(safe_path);
    if !collection_dir.exists() {
        return Err("Collection does not exist".to_string());
    }

    fs::remove_dir_all(&collection_dir)
        .map_err(|error| format!("Failed to delete collection: {error}"))?;
    touch_project(&resolved.dir)
}

#[tauri::command]
fn list_environments(project: String) -> Result<Vec<String>, String> {
    let resolved = resolve_project(&project)?;
    let env_dir = project_environments_dir(&resolved.dir);
    fs::create_dir_all(&env_dir)
        .map_err(|error| format!("Failed to create environments directory: {error}"))?;

    let mut names = BTreeSet::new();
    for entry in fs::read_dir(&env_dir)
        .map_err(|error| format!("Failed to read environments directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read environment entry: {error}"))?;
        if !entry.path().is_file() {
            continue;
        }

        let Some(file_name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };

        if let Some(name) = file_name.strip_suffix(".env.json") {
            names.insert(name.to_string());
        } else if let Some(name) = file_name.strip_suffix(".env.secrets.json") {
            names.insert(name.to_string());
        }
    }

    Ok(names.into_iter().collect())
}

#[tauri::command]
fn load_environment(project: String, name: String) -> Result<Environment, String> {
    let resolved = resolve_project(&project)?;
    let normal_path = environment_file_path(&resolved.dir, &name, false)?;
    let secrets_path = environment_file_path(&resolved.dir, &name, true)?;
    let env_name = slugify(&name);

    let variables = merge_environment_variables(
        read_env_variables(&normal_path, false)?,
        resolve_secret_variables(
            &resolved.dir,
            &env_name,
            read_env_variables(&secrets_path, true)?,
            &secrets_path,
        )?,
    );

    Ok(Environment {
        name: env_name,
        variables,
    })
}

#[tauri::command]
fn save_environment(project: String, env: Environment) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let env_dir = project_environments_dir(&resolved.dir);
    fs::create_dir_all(&env_dir)
        .map_err(|error| format!("Failed to create environments directory: {error}"))?;

    let name = env.name.trim();
    if name.is_empty() {
        return Err("Environment name is required".to_string());
    }

    let normal_path = environment_file_path(&resolved.dir, name, false)?;
    let secrets_path = environment_file_path(&resolved.dir, name, true)?;

    let mut normal_variables = Vec::new();
    let mut secret_variables = Vec::new();

    for variable in env.variables {
        if variable.key.trim().is_empty() {
            continue;
        }

        if variable.secret {
            let vault_key = if variable.vault_key.trim().is_empty() {
                vault_key_for(&resolved.dir, name, &variable.key)
            } else {
                variable.vault_key
            };

            if variable.value.is_empty() {
                delete_secret_value(&vault_key)?;
            } else {
                save_secret_value(&vault_key, &variable.value)?;
            }

            secret_variables.push(EnvVariable {
                key: variable.key,
                value: String::new(),
                secret: true,
                vault_key,
            });
        } else {
            normal_variables.push(EnvVariable {
                key: variable.key,
                value: variable.value,
                secret: false,
                vault_key: String::new(),
            });
        }
    }

    fs::write(&normal_path, pretty_json(&normal_variables)?)
        .map_err(|error| format!("Failed to save environment: {error}"))?;
    write_secret_metadata(&secrets_path, &secret_variables)?;
    touch_project(&resolved.dir)
}

#[tauri::command]
fn delete_environment(project: String, name: String) -> Result<(), String> {
    let resolved = resolve_project(&project)?;
    let normal_path = environment_file_path(&resolved.dir, &name, false)?;
    let secrets_path = environment_file_path(&resolved.dir, &name, true)?;
    let normal_exists = normal_path.exists();
    let secrets_exists = secrets_path.exists();

    if normal_exists {
        fs::remove_file(&normal_path)
            .map_err(|error| format!("Failed to delete environment: {error}"))?;
    }
    if secrets_exists {
        for variable in read_env_variables(&secrets_path, true)? {
            let vault_key = if variable.vault_key.trim().is_empty() {
                vault_key_for(&resolved.dir, &name, &variable.key)
            } else {
                variable.vault_key
            };
            delete_secret_value(&vault_key)?;
        }
        fs::remove_file(&secrets_path)
            .map_err(|error| format!("Failed to delete environment secrets: {error}"))?;
    }
    if !normal_exists && !secrets_exists {
        return Err("Environment does not exist".to_string());
    }

    touch_project(&resolved.dir)
}

#[tauri::command]
fn resolve_variables(template: String, variables: Vec<EnvVariable>) -> Result<String, String> {
    Ok(resolve_template(&template, &variables))
}

#[tauri::command]
fn append_history(mut entry: HistoryEntry) -> Result<(), String> {
    let _guard = lock_history();

    if entry.id.trim().is_empty() {
        entry.id = Uuid::new_v4().to_string();
    }

    let mut entries = read_history_entries()?;
    entries.push(entry);

    if entries.len() > MAX_HISTORY_ENTRIES {
        let overflow = entries.len() - MAX_HISTORY_ENTRIES;
        entries.drain(0..overflow);
    }

    write_history_entries(&entries)
}

#[tauri::command]
fn load_history() -> Result<Vec<HistoryEntry>, String> {
    let _guard = lock_history();
    let mut entries = read_history_entries()?;
    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    Ok(entries)
}

#[tauri::command]
fn clear_history() -> Result<(), String> {
    let _guard = lock_history();
    write_history_entries(&[])
}

#[tauri::command]
fn delete_history_entry(id: String) -> Result<(), String> {
    let _guard = lock_history();
    let mut entries = read_history_entries()?;
    entries.retain(|entry| entry.id != id);
    write_history_entries(&entries)
}

/// Replaces history rows by id. Rows the caller did not list are kept as they
/// are on disk — the lock stops concurrent lost updates, merge-by-id stops a
/// stale snapshot from erasing rows the caller never saw. No redaction happens
/// here: Rust stays a dumb pipe for history.
#[tauri::command]
fn update_history_entries(entries: Vec<HistoryEntry>) -> Result<(), String> {
    let _guard = lock_history();
    let mut merged = read_history_entries()?;

    for update in entries.iter() {
        if let Some(existing) = merged.iter_mut().find(|entry| entry.id == update.id) {
            *existing = update.clone();
        }
    }

    write_history_entries(&merged)
}

async fn ws_connect_inner(
    app: Option<tauri::AppHandle>,
    url: String,
    headers: Vec<KeyValuePair>,
) -> Result<String, String> {
    let connection_id = Uuid::new_v4().to_string();
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("Invalid WebSocket URL: {error}"))?;

    for header in headers
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
    {
        request.headers_mut().insert(
            WsHeaderName::from_str(&header.key)
                .map_err(|error| format!("Invalid header: {error}"))?,
            WsHeaderValue::from_str(&header.value)
                .map_err(|error| format!("Invalid header value: {error}"))?,
        );
    }

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| format!("WebSocket connection failed: {error}"))?;
    let (write, mut read) = ws_stream.split();

    ws_pool().lock().await.insert(connection_id.clone(), write);
    let connected_event = WsEventPayload {
        connection_id: connection_id.clone(),
        event_type: "connected".to_string(),
        content: String::new(),
        timestamp: now_iso(),
    };
    publish_ws_event(app.as_ref(), connected_event.clone()).await;

    let pool = ws_pool();
    let cid = connection_id.clone();
    tokio::spawn(async move {
        while let Some(message) = read.next().await {
            match message {
                Ok(WsMessage::Text(text)) => {
                    publish_ws_event(
                        app.as_ref(),
                        WsEventPayload {
                            connection_id: cid.clone(),
                            event_type: "message".to_string(),
                            content: text.to_string(),
                            timestamp: now_iso(),
                        },
                    )
                    .await;
                }
                Ok(WsMessage::Binary(data)) => {
                    publish_ws_event(
                        app.as_ref(),
                        WsEventPayload {
                            connection_id: cid.clone(),
                            event_type: "message".to_string(),
                            content: format!("[binary {} bytes]", data.len()),
                            timestamp: now_iso(),
                        },
                    )
                    .await;
                }
                Ok(WsMessage::Close(_)) => {
                    break;
                }
                Err(error) => {
                    publish_ws_event(
                        app.as_ref(),
                        WsEventPayload {
                            connection_id: cid.clone(),
                            event_type: "error".to_string(),
                            content: error.to_string(),
                            timestamp: now_iso(),
                        },
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }

        pool.lock().await.remove(&cid);
        publish_ws_event(
            app.as_ref(),
            WsEventPayload {
                connection_id: cid.clone(),
                event_type: "disconnected".to_string(),
                content: String::new(),
                timestamp: now_iso(),
            },
        )
        .await;
    });

    Ok(connection_id)
}

#[tauri::command]
async fn ws_connect(
    app: tauri::AppHandle,
    url: String,
    headers: Vec<KeyValuePair>,
) -> Result<String, String> {
    ws_connect_inner(Some(app), url, headers).await
}

#[tauri::command]
async fn ws_send(connection_id: String, message: String) -> Result<(), String> {
    let pool = ws_pool();
    let mut connections = pool.lock().await;
    let sender = connections
        .get_mut(&connection_id)
        .ok_or_else(|| "Connection not found or already closed".to_string())?;

    sender
        .send(WsMessage::Text(message.into()))
        .await
        .map_err(|error| format!("Failed to send message: {error}"))
}

#[tauri::command]
async fn ws_disconnect(connection_id: String) -> Result<(), String> {
    let pool = ws_pool();
    let mut connections = pool.lock().await;
    if let Some(mut sender) = connections.remove(&connection_id) {
        ws_event_queue_pool().lock().await.remove(&connection_id);
        ws_suppressed_disconnect_pool()
            .lock()
            .await
            .insert(connection_id.clone(), ());
        let _ = sender.send(WsMessage::Close(None)).await;
    }
    Ok(())
}

#[tauri::command]
async fn ws_status(connection_id: String) -> Result<String, String> {
    let pool = ws_pool();
    let connections = pool.lock().await;
    if connections.contains_key(&connection_id) {
        Ok("connected".to_string())
    } else {
        Ok("disconnected".to_string())
    }
}

#[tauri::command]
async fn ws_drain_events(connection_id: String) -> Result<Vec<WsEventPayload>, String> {
    let pool = ws_event_queue_pool();
    let mut queues = pool.lock().await;
    let events = queues.entry(connection_id).or_default();
    let drained = std::mem::take(events);
    if drained
        .iter()
        .any(|event| event.event_type == "disconnected")
    {
        queues.remove(&drained[0].connection_id);
    }
    Ok(drained)
}

#[tauri::command]
async fn send_request(args: SendRequestArgs) -> Result<HttpResponse, String> {
    let request_id = args.request_id.clone();
    if request_id.trim().is_empty() {
        return execute_request(args).await;
    }

    register_active_request(&request_id).await;

    let task = tokio::spawn(execute_request(args));
    let abort_handle = task.abort_handle();

    set_active_request_handle(&request_id, abort_handle.clone()).await;

    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("Request cancelled".to_string()),
        Err(error) => Err(format!("Request task failed: {error}")),
    };

    unregister_active_request(&request_id).await;

    result
}

async fn execute_request(args: SendRequestArgs) -> Result<HttpResponse, String> {
    execute_request_with_budget(args, REQUEST_TOTAL_BUDGET).await
}

/// The budget is a parameter rather than a constant so that tests can observe
/// whether the checkpoints are actually wired in - a helper can be written and
/// tested perfectly and still never be called.
async fn execute_request_with_budget(
    args: SendRequestArgs,
    total_budget: Duration,
) -> Result<HttpResponse, String> {
    // The one and only timing origin for this request.
    let overall_started_at = Instant::now();
    let overall_deadline = overall_started_at + total_budget;

    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(30))
        .no_proxy();

    if let Some(proxy_cfg) = &args.proxy {
        if proxy_cfg.enabled && !proxy_cfg.host.trim().is_empty() {
            let proxy_url = match proxy_cfg.proxy_type.as_str() {
                "socks5" => format!("socks5://{}:{}", proxy_cfg.host, proxy_cfg.port),
                _ => format!("http://{}:{}", proxy_cfg.host, proxy_cfg.port),
            };

            let mut proxy = reqwest::Proxy::all(&proxy_url)
                .map_err(|error| format!("Invalid proxy: {error}"))?;

            if let Some(auth) = &proxy_cfg.auth {
                if !auth.username.is_empty() {
                    proxy = proxy.basic_auth(&auth.username, &auth.password);
                }
            }

            builder = builder.proxy(proxy);
        }
    }

    if let Some(tls_cfg) = &args.tls {
        if !tls_cfg.verify_ssl {
            builder = builder.danger_accept_invalid_certs(true);
        }
    }

    let client = builder
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

    let method = Method::from_bytes(args.method.as_bytes())
        .map_err(|error| format!("Invalid HTTP method '{}': {error}", args.method))?;

    let url = build_request_url(&args.url, &args.params, &args.auth)?;

    let mut header_map = HeaderMap::new();
    for header in args
        .headers
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
    {
        let name = HeaderName::from_str(&header.key)
            .map_err(|error| format!("Invalid header name '{}': {error}", header.key))?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|error| format!("Invalid header value for '{}': {error}", header.key))?;
        header_map.append(name, value);
    }

    if let Some(api_key) = args.auth.api_key.as_ref() {
        if args.auth.auth_type == "api-key"
            && api_key.add_to == "header"
            && !api_key.key.trim().is_empty()
        {
            let name = HeaderName::from_str(&api_key.key)
                .map_err(|error| format!("Invalid API key header '{}': {error}", api_key.key))?;
            let value = HeaderValue::from_str(&api_key.value)
                .map_err(|error| format!("Invalid API key header value: {error}"))?;
            header_map.insert(name, value);
        }
    }

    // No `?` and no `unwrap_or` here: the probe cannot fail in a way that
    // reaches this expression, which is what keeps it advisory by construction.
    let (dns_lookup, tcp_connect) = if should_measure_connection_timings(args.proxy.as_ref()) {
        measure_connection_timings(&url, probe_budget(overall_deadline, Instant::now())).await
    } else {
        (0, 0)
    };
    let mut request = client.request(method, url).headers(header_map);

    match args.auth.auth_type.as_str() {
        "basic" => {
            let basic = args
                .auth
                .basic
                .as_ref()
                .ok_or_else(|| "Missing basic auth credentials".to_string())?;
            request = request.basic_auth(&basic.username, Some(&basic.password));
        }
        "bearer" => {
            let bearer = args
                .auth
                .bearer
                .as_ref()
                .ok_or_else(|| "Missing bearer token".to_string())?;
            request = request.bearer_auth(&bearer.token);
        }
        "none" | "api-key" => {}
        other => return Err(format!("Unsupported auth type: {other}")),
    }

    match args.body.body_type.as_str() {
        "none" => {}
        "json" => {
            if !args.body.content.trim().is_empty() {
                // Parse for validation only, then send the user's bytes
                // verbatim. Round-tripping through Value would sort keys, drop
                // duplicates and collapse whitespace - fatal for any API that
                // signs the raw body.
                serde_json::from_str::<serde_json::Value>(&args.body.content)
                    .map_err(|error| format!("Invalid JSON body: {error}"))?;
                request = request
                    .header(CONTENT_TYPE, "application/json")
                    .body(args.body.content);
            }
        }
        "form-urlencoded" => {
            request = request
                .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(args.body.content);
        }
        "form-data" => {
            let form = resolve_form_data_items(&args.body)?
                .into_iter()
                .filter(|item| item.enabled && !item.key.trim().is_empty())
                .try_fold(reqwest::multipart::Form::new(), |form, item| {
                    add_form_data_part(form, item)
                })?;
            request = request.multipart(form);
        }
        "binary" => {
            let label = if args.body.binary_path.trim().is_empty() {
                "binary body".to_string()
            } else {
                format!(
                    "binary body '{}'",
                    sanitize_file_label(&args.body.binary_path)
                )
            };
            let bytes = resolve_binary_body_bytes(&args.body, &label)?;
            request = request.body(bytes);
        }
        "raw" => {
            request = request.body(args.body.content);
        }
        other => return Err(format!("Unsupported body type: {other}")),
    }

    let built = finish_request_with_deadline(
        request,
        &args.auth.auth_type,
        &args.body.body_type,
        overall_deadline,
    )?;
    let response = client
        .execute(built)
        .await
        .map_err(|error| format_error_chain("Request failed", &error))?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let raw_headers = response.headers().clone();
    let content_type = raw_headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let plan = plan_content_encoding(&raw_headers);

    let download_started_at = Instant::now();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format_error_chain("Failed to read response body", &error))?;
    let download = download_started_at.elapsed().as_millis() as u64;

    // Checked before the task is created, not after: `spawn_blocking` cannot be
    // cancelled, so an exhausted budget must stop us from starting the decode
    // rather than merely stop us from waiting for it.
    let decode_budget =
        ensure_budget_remaining(overall_deadline, Instant::now(), "decoding the response")?;
    let decoded = {
        let content_type = content_type.clone();
        // `bytes` moves into the closure so the full copy happens inside the
        // timeout; a remote-controlled body could otherwise be copied for
        // seconds outside any budget.
        let handle =
            tokio::task::spawn_blocking(move || {
                finalize_response_body(bytes.to_vec(), plan, &content_type)
            });
        let decode = async move {
            match handle.await {
                Ok(result) => result,
                Err(error) => Err(format!("Response decode task failed: {error}")),
            }
        };
        run_decode_within_budget(decode_budget, decode).await?
    };

    let headers = response_header_pairs(&raw_headers, decoded.dropped_encoding_headers);
    let timings = build_timings(
        overall_started_at.elapsed(),
        dns_lookup,
        tcp_connect,
        download,
    );

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body: decoded.body,
        size: decoded.size,
        time: timings.total,
        timings,
        content_type,
        body_kind: decoded.body_kind,
    })
}

fn should_measure_connection_timings(proxy: Option<&ProxyConfig>) -> bool {
    !matches!(proxy, Some(config) if config.enabled && !config.host.trim().is_empty())
}

/// Total wall-clock budget for one send, from the first line of
/// `execute_request_with_budget` until the decoded body is in hand.
const REQUEST_TOTAL_BUDGET: Duration = Duration::from_secs(30);

/// Cap on decompressed output. Decompression introduces an amplification the
/// identity path does not have: a 10 MB all-zero gzip expands to ~10 GB. The
/// slice that creates the amplification carries the cap.
const MAX_DECOMPRESSED_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContentEncoding {
    Gzip,
    Deflate,
    Brotli,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ContentEncodingPlan {
    /// No encoding, only `identity`, or nothing but empty tokens.
    None,
    /// Exactly one supported encoding survived normalisation.
    Decode(ContentEncoding),
    /// Unknown single encoding, several stacked encodings, or a malformed
    /// field. Carries the normalised token list for the user-facing marker.
    Undecodable(String),
}

fn supported_content_encoding(token: &str) -> Option<ContentEncoding> {
    match token {
        "gzip" | "x-gzip" => Some(ContentEncoding::Gzip),
        "deflate" => Some(ContentEncoding::Deflate),
        "br" => Some(ContentEncoding::Brotli),
        _ => None,
    }
}

/// Collect `Content-Encoding` the way HTTP defines it: repeated fields and a
/// comma list are the same ordered list. Only a single supported encoding is
/// decoded; anything else is reported honestly rather than guessed at.
fn plan_content_encoding(headers: &HeaderMap) -> ContentEncodingPlan {
    // A field value that is not valid UTF-8 is malformed, not absent. Letting
    // it fall through to `unwrap_or("")` would turn it into "no encoding" and
    // hand undecoded bytes to the text path.
    for value in headers.get_all(CONTENT_ENCODING) {
        if value.to_str().is_err() {
            return ContentEncodingPlan::Undecodable("(unparsable)".to_string());
        }
    }

    let tokens = headers
        .get_all(CONTENT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty() && token != "identity")
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        return ContentEncodingPlan::None;
    }
    if tokens.len() == 1 {
        return match supported_content_encoding(&tokens[0]) {
            Some(encoding) => ContentEncodingPlan::Decode(encoding),
            None => ContentEncodingPlan::Undecodable(tokens.join(", ")),
        };
    }
    // Two or more encodings stacked. Not deduplicated: `gzip, gzip` is real
    // double compression and collapsing it would decode the wrong thing.
    ContentEncodingPlan::Undecodable(tokens.join(", "))
}

fn decompress_response_body(
    bytes: Vec<u8>,
    plan: &ContentEncodingPlan,
) -> Result<(Vec<u8>, bool), String> {
    decompress_response_body_with_limit(bytes, plan, MAX_DECOMPRESSED_RESPONSE_BYTES)
}

/// Limit is a parameter so the boundary cases can be exercised with kilobyte
/// fixtures instead of manufacturing 64 MiB of test data.
fn decompress_response_body_with_limit(
    bytes: Vec<u8>,
    plan: &ContentEncodingPlan,
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let encoding = match plan {
        ContentEncodingPlan::Decode(encoding) => *encoding,
        ContentEncodingPlan::None | ContentEncodingPlan::Undecodable(_) => {
            return Ok((bytes, false))
        }
    };

    let label = match encoding {
        ContentEncoding::Gzip => "gzip",
        ContentEncoding::Deflate => "deflate",
        ContentEncoding::Brotli => "br",
    };

    let decoded = match encoding {
        // MultiGzDecoder, not GzDecoder: concatenated gzip members are legal
        // and GzDecoder would silently stop after the first one.
        ContentEncoding::Gzip => read_capped(
            flate2::read::MultiGzDecoder::new(bytes.as_slice()),
            limit,
            label,
        ),
        ContentEncoding::Brotli => read_capped(
            brotli_decompressor::Decompressor::new(bytes.as_slice(), 4096),
            limit,
            label,
        ),
        // `Content-Encoding: deflate` is officially zlib, but enough servers
        // emit raw deflate that browsers accept both. Try zlib, fall back.
        ContentEncoding::Deflate => {
            match read_capped(flate2::read::ZlibDecoder::new(bytes.as_slice()), limit, label) {
                Ok(decoded) => Ok(decoded),
                Err(zlib_error) => {
                    if zlib_error.contains("too large") {
                        Err(zlib_error)
                    } else {
                        read_capped(
                            flate2::read::DeflateDecoder::new(bytes.as_slice()),
                            limit,
                            label,
                        )
                    }
                }
            }
        }
    }?;

    Ok((decoded, true))
}

fn read_capped<R: Read>(reader: R, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    // `take` stops the allocation from running away; the decision below is
    // what actually enforces the limit.
    reader
        .take((limit as u64).saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|error| format!("Failed to decode {label} response body: {error}"))?;
    if out.len() > limit {
        return Err(format!(
            "Response body too large: decompressed content exceeds the {limit}-byte limit \
             (Content-Encoding: {label})"
        ));
    }
    Ok(out)
}

/// Pull the `charset` parameter out of a Content-Type. Only the parameter is
/// consulted - no BOM inspection, no `<meta>` scraping, no content sniffing,
/// because every one of those is a guess and a wrong guess is fresh mojibake.
fn charset_from_content_type(content_type: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        let (name, value) = part.split_once('=')?;
        if name.trim().eq_ignore_ascii_case("charset") {
            let value = value.trim().trim_matches('"').trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_ascii_lowercase());
        }
    }
    None
}

fn binary_body_marker(size: usize, content_type: &str, undecoded_encoding: Option<&str>) -> String {
    let shown = if content_type.trim().is_empty() {
        "(none)"
    } else {
        content_type
    };
    match undecoded_encoding {
        Some(encoding) => format!(
            "[ApiSolo] Compressed response not decoded: content-encoding: {encoding}, \
             {size} bytes, content-type: {shown}"
        ),
        None => format!(
            "[ApiSolo] Binary response not shown as text: {size} bytes, content-type: {shown}"
        ),
    }
}

/// Text-vs-binary is decided by whether the bytes decode, not by the
/// Content-Type's major type: APIs mislabel JSON as octet-stream and servers
/// mislabel PNGs as text/html, and the bytes are right in both cases.
fn decode_response_body(bytes: &[u8], content_type: &str) -> (String, ResponseBodyKind) {
    let encoding = charset_from_content_type(content_type)
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);

    // Single-byte encodings accept every byte, so decodability alone cannot
    // catch binary declared as latin-1. No real text response carries NUL.
    if bytes.contains(&0) {
        return (
            binary_body_marker(bytes.len(), content_type, None),
            ResponseBodyKind::Binary,
        );
    }

    match encoding.decode_without_bom_handling_and_without_replacement(bytes) {
        Some(text) => (text.into_owned(), ResponseBodyKind::Text),
        None => (
            binary_body_marker(bytes.len(), content_type, None),
            ResponseBodyKind::Binary,
        ),
    }
}

fn response_header_pairs(
    headers: &HeaderMap,
    drop_encoding_headers: bool,
) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            // After a successful decode these two describe bytes the user is
            // no longer looking at. Showing them next to decoded content is
            // exactly the "UI must not lie" failure mode.
            !drop_encoding_headers || (*name != CONTENT_ENCODING && *name != CONTENT_LENGTH)
        })
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

#[derive(Debug)]
struct DecodedResponseBody {
    size: u64,
    body: String,
    body_kind: ResponseBodyKind,
    dropped_encoding_headers: bool,
}

/// Synchronous on purpose: decompression plus a full charset transcode is CPU
/// work that would otherwise monopolise an async worker. Its only call site is
/// inside `spawn_blocking`.
fn finalize_response_body(
    bytes: Vec<u8>,
    plan: ContentEncodingPlan,
    content_type: &str,
) -> Result<DecodedResponseBody, String> {
    let (body_bytes, decoded) = decompress_response_body(bytes, &plan)?;
    let size = body_bytes.len() as u64;

    // An undecoded compressed payload can easily be valid UTF-8 by accident.
    // Forcing the binary path stops it from being rendered as if it were text.
    if let ContentEncodingPlan::Undecodable(tokens) = &plan {
        return Ok(DecodedResponseBody {
            size,
            body: binary_body_marker(body_bytes.len(), content_type, Some(tokens)),
            body_kind: ResponseBodyKind::Binary,
            dropped_encoding_headers: decoded,
        });
    }

    let (body, body_kind) = decode_response_body(&body_bytes, content_type);
    Ok(DecodedResponseBody {
        size,
        body,
        body_kind,
        dropped_encoding_headers: decoded,
    })
}

fn remaining_budget(deadline: Instant, now: Instant) -> Duration {
    deadline.saturating_duration_since(now)
}

fn probe_budget(deadline: Instant, now: Instant) -> Duration {
    CONNECTION_PROBE_MAX.min(remaining_budget(deadline, now))
}

fn ensure_budget_remaining(
    deadline: Instant,
    now: Instant,
    phase: &str,
) -> Result<Duration, String> {
    let remaining = remaining_budget(deadline, now);
    if remaining.is_zero() {
        return Err(format!(
            "Request budget exhausted before {phase} (30s limit)"
        ));
    }
    Ok(remaining)
}

/// Keeps build, header normalisation, budget read and timeout assignment in one
/// place and in this order. Reading the budget before the build would hand the
/// build's own cost to the HTTP phase a second time; here the ordering is four
/// consecutive lines rather than a detail buried in a long function.
fn finish_request_with_deadline(
    request: RequestBuilder,
    auth_type: &str,
    body_type: &str,
    deadline: Instant,
) -> Result<ReqwestRequest, String> {
    let mut built = request
        .build()
        .map_err(|error| format_error_chain("Failed to build request", &error))?;
    normalize_auto_headers(built.headers_mut(), auth_type, body_type);
    let budget = ensure_budget_remaining(deadline, Instant::now(), "sending the request")?;
    *built.timeout_mut() = Some(budget);
    Ok(built)
}

async fn run_decode_within_budget<F>(
    budget: Duration,
    decode: F,
) -> Result<DecodedResponseBody, String>
where
    F: std::future::Future<Output = Result<DecodedResponseBody, String>>,
{
    match tokio::time::timeout(budget, decode).await {
        Ok(result) => result,
        Err(_) => Err("Request budget exhausted while decoding the response (30s limit)".to_string()),
    }
}

/// `total` is measured, never summed from the parts: a blackholed address or a
/// slow decode has to show up in what the user is told they waited.
fn build_timings(
    overall_elapsed: Duration,
    dns_lookup: u64,
    tcp_connect: u64,
    download: u64,
) -> RequestTimings {
    RequestTimings {
        dns_lookup,
        tcp_connect,
        // Not measurable at this layer; deriving them would be fake precision.
        tls_handshake: 0,
        ttfb: 0,
        download,
        total: overall_elapsed.as_millis() as u64,
    }
}

fn keep_first_header_value(headers: &mut HeaderMap, name: HeaderName) {
    if let Some(first) = headers.get(&name).cloned() {
        headers.insert(name, first);
    }
}

fn keep_last_header_value(headers: &mut HeaderMap, name: HeaderName) {
    if let Some(last) = headers.get_all(&name).iter().last().cloned() {
        headers.insert(name, last);
    }
}

/// Collapse the duplicates reqwest's appending helpers leave behind. The user's
/// headers went in first via `.headers(...)`, the app's computed ones were
/// appended after, so "keep first" and "keep last" express the whole precedence
/// table.
fn normalize_auto_headers(headers: &mut HeaderMap, auth_type: &str, body_type: &str) {
    match body_type {
        // For multipart only the boundary we actually used is correct, so the
        // app's value wins even against an explicit user header.
        "form-data" => keep_last_header_value(headers, CONTENT_TYPE),
        // The user's value - including any charset suffix - is what they typed.
        "form-urlencoded" | "json" => keep_first_header_value(headers, CONTENT_TYPE),
        // raw / binary / none: the app adds nothing, so there is nothing to
        // collapse and however many rows the user wrote go out.
        _ => {}
    }

    // The Auth tab only participates when actively selected, which makes it an
    // unambiguous instruction. Leaving it to lose silently is the "panel that
    // does nothing" failure. Escape hatch: set the tab back to none.
    if matches!(auth_type, "basic" | "bearer") {
        keep_last_header_value(headers, AUTHORIZATION);
    }
}

/// reqwest's Display prints only the kind and the URL; the actual cause lives
/// on the source chain, which is what tells a cert rejection apart from a
/// timeout apart from a refused connection.
fn format_error_chain(prefix: &str, error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![prefix.to_string()];
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        parts.push(error.to_string());
        current = error.source();
    }
    parts.join(": ")
}

/// Only opens the query serialiser when there is something to append: calling
/// `query_pairs_mut` unconditionally appends a bare `?` to every URL.
fn build_request_url(
    raw_url: &str,
    params: &[KeyValuePair],
    auth: &AuthInput,
) -> Result<Url, String> {
    let mut url = Url::parse(raw_url).map_err(|error| format!("Invalid URL: {error}"))?;

    let mut pairs: Vec<(&str, &str)> = params
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| (item.key.as_str(), item.value.as_str()))
        .collect();

    if let Some(api_key) = auth.api_key.as_ref() {
        if auth.auth_type == "api-key" && api_key.add_to == "query" && !api_key.key.trim().is_empty()
        {
            pairs.push((api_key.key.as_str(), api_key.value.as_str()));
        }
    }

    if !pairs.is_empty() {
        let mut serializer = url.query_pairs_mut();
        for (key, value) in pairs {
            serializer.append_pair(key, value);
        }
    }

    Ok(url)
}

fn resolve_binary_body_bytes(body: &RequestBodyInput, label: &str) -> Result<Vec<u8>, String> {
    if let Some(content) = body.binary_content.as_ref() {
        return decode_base64_field(content, label);
    }

    if !body.binary_path.trim().is_empty() {
        return Err(format!(
            "{label} must include inline content; raw filesystem paths are not allowed"
        ));
    }

    decode_base64_field(&body.content, label)
}

fn resolve_form_data_items(body: &RequestBodyInput) -> Result<Vec<FormDataItem>, String> {
    if !body.form_data.is_empty() {
        return Ok(body.form_data.clone());
    }

    if body.content.trim().is_empty() {
        return Ok(Vec::new());
    }

    let legacy_items: Vec<KeyValuePair> = serde_json::from_str(&body.content)
        .map_err(|error| format!("Invalid form-data body: {error}"))?;

    Ok(legacy_items
        .into_iter()
        .map(|item| FormDataItem {
            enabled: item.enabled,
            key: item.key,
            value: item.value,
            description: item.description,
            value_type: default_form_data_value_type(),
            file_name: String::new(),
            file_path: String::new(),
            file_content: None,
            content_type: String::new(),
        })
        .collect())
}

fn add_form_data_part(
    form: reqwest::multipart::Form,
    item: FormDataItem,
) -> Result<reqwest::multipart::Form, String> {
    if item.value_type == "file" {
        let file_name = if !item.file_name.trim().is_empty() {
            item.file_name.clone()
        } else if !item.file_path.trim().is_empty() {
            Path::new(&item.file_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&item.key)
                .to_string()
        } else {
            item.key.clone()
        };
        let bytes = if let Some(content) = item.file_content.as_ref() {
            decode_base64_field(content, "form-data file")?
        } else if !item.file_path.trim().is_empty() {
            return Err(format!(
                "Form-data file parts must include inline content; raw filesystem paths are not allowed ({})",
                item.key
            ));
        } else {
            Vec::new()
        };
        let mut part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
        if !item.content_type.trim().is_empty() {
            part = part
                .mime_str(&item.content_type)
                .map_err(|error| format!("Invalid form-data content type: {error}"))?;
        }
        Ok(form.part(item.key, part))
    } else {
        Ok(form.text(item.key, item.value))
    }
}

fn decode_base64_field(value: &str, label: &str) -> Result<Vec<u8>, String> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }

    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("Invalid {label}: {error}"))
}

fn should_start_dev_bridge(env_value: Option<&str>) -> bool {
    matches!(
        env_value.map(str::trim),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

fn dev_bridge_allowed_origins() -> Vec<HeaderValue> {
    [
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "https://127.0.0.1:1420",
        "https://localhost:1420",
    ]
    .into_iter()
    .map(|origin| HeaderValue::from_str(origin).expect("valid dev bridge origin"))
    .collect()
}

fn dev_bridge_cors_layer() -> CorsLayer {
    let token_header = HeaderName::from_static("x-apisolo-dev-token");
    CorsLayer::new()
        .allow_origin(dev_bridge_allowed_origins())
        .allow_methods([Method::POST])
        .allow_headers([CONTENT_TYPE, token_header])
}

async fn require_dev_bridge_token(request: Request, next: Next) -> impl IntoResponse {
    let expected = std::env::var(DEV_BRIDGE_TOKEN_ENV).unwrap_or_default();
    let actual = request
        .headers()
        .get("x-apisolo-dev-token")
        .and_then(|value| value.to_str().ok());

    if !expected.is_empty() && actual == Some(expected.as_str()) {
        return next.run(request).await.into_response();
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "ok": false,
            "error": "Development bridge token is missing or invalid"
        })),
    )
        .into_response()
}

fn sanitize_dev_bridge_request_args(args: SendRequestArgs) -> Result<SendRequestArgs, String> {
    if args.body.body_type == "binary"
        && !args.body.binary_path.trim().is_empty()
        && args
            .body
            .binary_content
            .as_ref()
            .map(|content| content.trim().is_empty())
            .unwrap_or(true)
    {
        return Err(
            "Binary bodies over the development bridge must include inline content".to_string(),
        );
    }

    if args.body.form_data.iter().any(|item| {
        item.value_type == "file"
            && !item.file_path.trim().is_empty()
            && item
                .file_content
                .as_ref()
                .map(|content| content.trim().is_empty())
                .unwrap_or(true)
    }) {
        return Err(
            "Form-data file parts over the development bridge must include inline content"
                .to_string(),
        );
    }

    Ok(args)
}

#[tauri::command]
async fn cancel_request(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Ok(());
    }

    let pool = active_request_pool();
    if let Some(state) = pool.lock().await.get_mut(&request_id) {
        state.cancel_requested = true;
        if let Some(handle) = state.handle.take() {
            handle.abort();
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct CreateProjectArgs {
    name: String,
    description: String,
}

#[derive(Deserialize)]
struct ProjectArgs {
    project: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigureSecretStorageArgs {
    backend: String,
    #[serde(default)]
    master_password: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlockSecretStorageArgs {
    master_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequestArgs {
    project: String,
    collection: String,
    request: SavedRequest,
    #[serde(default)]
    existing_path: Option<String>,
}

#[derive(Deserialize)]
struct ProjectPathArgs {
    project: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCollectionArgs {
    project: String,
    name: String,
    parent: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameCollectionArgs {
    project: String,
    path: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameRequestArgs {
    project: String,
    path: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveRequestArgs {
    project: String,
    from_path: String,
    to_collection: String,
}

#[derive(Deserialize)]
struct EnvironmentNameArgs {
    project: String,
    name: String,
}

#[derive(Deserialize)]
struct SaveEnvironmentArgs {
    project: String,
    env: Environment,
}

#[derive(Deserialize)]
struct ResolveVariablesArgs {
    template: String,
    variables: Vec<EnvVariable>,
}

#[derive(Deserialize)]
struct AppendHistoryArgs {
    entry: HistoryEntry,
}

#[derive(Deserialize)]
struct DeleteHistoryEntryArgs {
    id: String,
}

#[derive(Deserialize)]
struct UpdateHistoryEntriesArgs {
    entries: Vec<HistoryEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequestArgs {
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsConnectionArgs {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsConnectArgs {
    url: String,
    #[serde(default)]
    headers: Vec<KeyValuePair>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsSendArgs {
    connection_id: String,
    message: String,
}

#[derive(Deserialize)]
struct SendRequestEnvelope {
    args: SendRequestArgs,
}

fn api_ok<T: Serialize>(data: T) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "data": data }))
}

fn api_err(error: String) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": false, "error": error }))
}

fn api_response<T: Serialize>(result: Result<T, String>) -> Json<serde_json::Value> {
    match result {
        Ok(data) => api_ok(data),
        Err(error) => api_err(error),
    }
}

fn api_unit(result: Result<(), String>) -> Json<serde_json::Value> {
    match result {
        Ok(()) => api_ok(serde_json::Value::Null),
        Err(error) => api_err(error),
    }
}

async fn api_get_data_dir() -> impl IntoResponse {
    api_response(get_data_dir())
}

async fn api_get_secret_storage_state() -> impl IntoResponse {
    api_response(get_secret_storage_state())
}

async fn api_configure_secret_storage(
    Json(args): Json<ConfigureSecretStorageArgs>,
) -> impl IntoResponse {
    api_response(configure_secret_storage(args.backend, args.master_password))
}

async fn api_unlock_secret_storage(Json(args): Json<UnlockSecretStorageArgs>) -> impl IntoResponse {
    api_response(unlock_secret_storage(args.master_password))
}

async fn api_list_projects() -> impl IntoResponse {
    api_response(list_projects())
}

async fn api_create_project(Json(args): Json<CreateProjectArgs>) -> impl IntoResponse {
    api_response(create_project(args.name, args.description))
}

async fn api_get_collection_tree(Json(args): Json<ProjectArgs>) -> impl IntoResponse {
    api_response(get_collection_tree(args.project))
}

async fn api_save_request(Json(args): Json<SaveRequestArgs>) -> impl IntoResponse {
    api_unit(save_request(
        args.project,
        args.collection,
        args.request,
        args.existing_path,
    ))
}

async fn api_load_request(Json(args): Json<ProjectPathArgs>) -> impl IntoResponse {
    api_response(load_request(args.project, args.path))
}

async fn api_create_collection(Json(args): Json<CreateCollectionArgs>) -> impl IntoResponse {
    api_unit(create_collection(args.project, args.name, args.parent))
}

async fn api_delete_request(Json(args): Json<ProjectPathArgs>) -> impl IntoResponse {
    api_unit(delete_request(args.project, args.path))
}

async fn api_delete_collection(Json(args): Json<ProjectPathArgs>) -> impl IntoResponse {
    api_unit(delete_collection(args.project, args.path))
}

async fn api_rename_collection(Json(args): Json<RenameCollectionArgs>) -> impl IntoResponse {
    api_unit(rename_collection(args.project, args.path, args.new_name))
}

async fn api_rename_request(Json(args): Json<RenameRequestArgs>) -> impl IntoResponse {
    api_unit(rename_request(args.project, args.path, args.new_name))
}

async fn api_move_request(Json(args): Json<MoveRequestArgs>) -> impl IntoResponse {
    api_unit(move_request(
        args.project,
        args.from_path,
        args.to_collection,
    ))
}

async fn api_list_environments(Json(args): Json<ProjectArgs>) -> impl IntoResponse {
    api_response(list_environments(args.project))
}

async fn api_load_environment(Json(args): Json<EnvironmentNameArgs>) -> impl IntoResponse {
    api_response(load_environment(args.project, args.name))
}

async fn api_save_environment(Json(args): Json<SaveEnvironmentArgs>) -> impl IntoResponse {
    api_unit(save_environment(args.project, args.env))
}

async fn api_delete_environment(Json(args): Json<EnvironmentNameArgs>) -> impl IntoResponse {
    api_unit(delete_environment(args.project, args.name))
}

async fn api_resolve_variables(Json(args): Json<ResolveVariablesArgs>) -> impl IntoResponse {
    api_response(resolve_variables(args.template, args.variables))
}

async fn api_ws_connect(Json(args): Json<WsConnectArgs>) -> impl IntoResponse {
    api_response(ws_connect_inner(None, args.url, args.headers).await)
}

async fn api_ws_send(Json(args): Json<WsSendArgs>) -> impl IntoResponse {
    api_unit(ws_send(args.connection_id, args.message).await)
}

async fn api_ws_disconnect(Json(args): Json<WsConnectionArgs>) -> impl IntoResponse {
    api_unit(ws_disconnect(args.connection_id).await)
}

async fn api_ws_status(Json(args): Json<WsConnectionArgs>) -> impl IntoResponse {
    api_response(ws_status(args.connection_id).await)
}

async fn api_send_request(Json(args): Json<SendRequestEnvelope>) -> impl IntoResponse {
    match sanitize_dev_bridge_request_args(args.args) {
        Ok(args) => api_response(send_request(args).await),
        Err(error) => api_err(error),
    }
}

async fn api_cancel_request(Json(args): Json<CancelRequestArgs>) -> impl IntoResponse {
    api_unit(cancel_request(args.request_id).await)
}

async fn api_ws_drain_events(Json(args): Json<WsConnectionArgs>) -> impl IntoResponse {
    api_response(ws_drain_events(args.connection_id).await)
}

async fn api_append_history(Json(args): Json<AppendHistoryArgs>) -> impl IntoResponse {
    api_unit(append_history(args.entry))
}

async fn api_load_history() -> impl IntoResponse {
    api_response(load_history())
}

async fn api_clear_history() -> impl IntoResponse {
    api_unit(clear_history())
}

async fn api_delete_history_entry(Json(args): Json<DeleteHistoryEntryArgs>) -> impl IntoResponse {
    api_unit(delete_history_entry(args.id))
}

async fn api_update_history_entries(Json(args): Json<UpdateHistoryEntriesArgs>) -> impl IntoResponse {
    api_unit(update_history_entries(args.entries))
}

#[cfg(feature = "dev-bridge")]
async fn start_dev_server() {
    let app = Router::new()
        .route("/api/get_data_dir", post(api_get_data_dir))
        .route(
            "/api/get_secret_storage_state",
            post(api_get_secret_storage_state),
        )
        .route(
            "/api/configure_secret_storage",
            post(api_configure_secret_storage),
        )
        .route(
            "/api/unlock_secret_storage",
            post(api_unlock_secret_storage),
        )
        .route("/api/list_projects", post(api_list_projects))
        .route("/api/create_project", post(api_create_project))
        .route("/api/get_collection_tree", post(api_get_collection_tree))
        .route("/api/save_request", post(api_save_request))
        .route("/api/load_request", post(api_load_request))
        .route("/api/create_collection", post(api_create_collection))
        .route("/api/delete_request", post(api_delete_request))
        .route("/api/delete_collection", post(api_delete_collection))
        .route("/api/rename_collection", post(api_rename_collection))
        .route("/api/rename_request", post(api_rename_request))
        .route("/api/move_request", post(api_move_request))
        .route("/api/list_environments", post(api_list_environments))
        .route("/api/load_environment", post(api_load_environment))
        .route("/api/save_environment", post(api_save_environment))
        .route("/api/delete_environment", post(api_delete_environment))
        .route("/api/resolve_variables", post(api_resolve_variables))
        .route("/api/ws_connect", post(api_ws_connect))
        .route("/api/ws_send", post(api_ws_send))
        .route("/api/ws_disconnect", post(api_ws_disconnect))
        .route("/api/ws_status", post(api_ws_status))
        .route("/api/send_request", post(api_send_request))
        .route("/api/cancel_request", post(api_cancel_request))
        .route("/api/ws_drain_events", post(api_ws_drain_events))
        .route("/api/append_history", post(api_append_history))
        .route("/api/load_history", post(api_load_history))
        .route("/api/clear_history", post(api_clear_history))
        .route("/api/delete_history_entry", post(api_delete_history_entry))
        .route(
            "/api/update_history_entries",
            post(api_update_history_entries),
        )
        .layer(middleware::from_fn(require_dev_bridge_token))
        .layer(dev_bridge_cors_layer());

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:3721").await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind dev server on 127.0.0.1:3721: {error}");
            return;
        }
    };

    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("dev server stopped: {error}");
    }
}

#[cfg(feature = "dev-bridge")]
pub async fn run_dev_server() {
    start_dev_server().await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "dev-bridge")]
    let enable_dev_bridge =
        should_start_dev_bridge(std::env::var(DEV_BRIDGE_ENABLE_ENV).ok().as_deref());
    tauri::Builder::default()
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_window_state(&window);
                register_window_state_persistence(window);
            }

            #[cfg(feature = "dev-bridge")]
            if enable_dev_bridge {
                DEV_SERVER_STARTED.get_or_init(|| {
                    tauri::async_runtime::spawn(start_dev_server());
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws_connect,
            ws_send,
            ws_disconnect,
            ws_status,
            ws_drain_events,
            send_request,
            cancel_request,
            append_history,
            load_history,
            clear_history,
            delete_history_entry,
            update_history_entries,
            get_data_dir,
            get_secret_storage_state,
            configure_secret_storage,
            unlock_secret_storage,
            list_projects,
            create_project,
            get_collection_tree,
            save_request,
            load_request,
            create_collection,
            rename_collection,
            delete_request,
            rename_request,
            move_request,
            delete_collection,
            list_environments,
            load_environment,
            save_environment,
            delete_environment,
            resolve_variables
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use tempfile::tempdir;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn lock_env() -> MutexGuard<'static, ()> {
        env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct HomeGuard {
        original_home: Option<String>,
    }

    impl HomeGuard {
        fn set(home: &Path) -> Self {
            let original_home = env::var("HOME").ok();
            unsafe {
                env::set_var("HOME", home);
            }
            Self { original_home }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => unsafe {
                    env::set_var("HOME", value);
                },
                None => unsafe {
                    env::remove_var("HOME");
                },
            }
        }
    }

    fn sample_history_entry(id: &str, timestamp: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            method: "GET".to_string(),
            url: "http://example.com/api".to_string(),
            status: 200,
            time: 100,
            size: 1024,
            timings: RequestTimings {
                dns_lookup: 10,
                tcp_connect: 15,
                tls_handshake: 20,
                ttfb: 80,
                download: 20,
                total: 145,
            },
            timestamp: timestamp.to_string(),
            content_type: "application/json".to_string(),
            request_params: vec![],
            request_headers: vec![],
            request_body_type: String::new(),
            request_body_content: String::new(),
            request_auth_type: String::new(),
            request_auth: None,
            request_body_form_data: vec![],
            request_body_binary_path: String::new(),
            request_body_binary_content: None,
            pre_request_script: String::new(),
            test_script: String::new(),
            response_body: String::new(),
            response_headers: vec![],
        }
    }

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("My API Project"), "my-api-project");
    }

    #[test]
    fn test_slugify_special_chars() {
        assert_eq!(slugify("hello@world#123"), "helloworld123");
    }

    #[test]
    fn test_slugify_empty() {
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("   "), "untitled");
    }

    #[test]
    fn test_slugify_preserves_unicode_letters() {
        assert_eq!(slugify("用户 列表"), "用户-列表");
    }

    #[test]
    fn test_valid_path() {
        let path = validate_relative_path("users/get-users.request.json").unwrap();
        assert_eq!(path, PathBuf::from("users/get-users.request.json"));
    }

    #[test]
    fn test_path_traversal_blocked() {
        assert!(validate_relative_path("../etc/passwd").is_err());
    }

    #[test]
    fn test_absolute_path_blocked() {
        assert!(validate_relative_path("/etc/passwd").is_err());
    }

    #[test]
    fn test_window_state_roundtrip() {
        let _lock = lock_env();
        let temp_home = tempdir().unwrap();
        let _home = HomeGuard::set(temp_home.path());

        write_window_state(&WindowState {
            width: 1440,
            height: 900,
        })
        .unwrap();

        let state = read_window_state().unwrap().unwrap();
        assert_eq!(state.width, 1440);
        assert_eq!(state.height, 900);
    }

    #[test]
    fn test_window_state_ignores_invalid_sizes() {
        let _lock = lock_env();
        let temp_home = tempdir().unwrap();
        let _home = HomeGuard::set(temp_home.path());
        let path = window_state_path().unwrap();

        fs::write(&path, r#"{"width":120,"height":80}"#).unwrap();

        assert!(read_window_state().unwrap().is_none());
    }

    #[test]
    fn test_basic_variable() {
        let variables = vec![EnvVariable {
            key: "baseUrl".to_string(),
            value: "http://localhost".to_string(),
            secret: false,
            vault_key: String::new(),
        }];
        assert_eq!(
            resolve_template("{{baseUrl}}/api", &variables),
            "http://localhost/api"
        );
    }

    #[test]
    fn test_builtin_timestamp() {
        let resolved = resolve_template("{{$timestamp}}", &[]);
        assert!(!resolved.is_empty());
        assert!(resolved.parse::<i64>().is_ok());
    }

    #[test]
    fn test_unresolved_variable() {
        assert_eq!(resolve_template("{{unknown}}", &[]), "{{unknown}}");
    }

    #[test]
    fn test_pretty_json() {
        #[derive(Serialize)]
        struct Sample {
            name: String,
            count: u32,
        }

        let json = pretty_json(&Sample {
            name: "demo".to_string(),
            count: 1,
        })
        .unwrap();

        assert!(json.contains('\n'));
        assert!(json.contains("  \"name\""));
    }

    #[test]
    fn test_append_and_load_history() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        append_history(sample_history_entry("test-1", "2026-03-27T10:00:00Z")).unwrap();
        append_history(sample_history_entry("test-2", "2026-03-27T10:01:00Z")).unwrap();
        append_history(sample_history_entry("test-3", "2026-03-27T10:02:00Z")).unwrap();

        let entries = load_history().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id, "test-3");
        assert_eq!(entries[1].id, "test-2");
        assert_eq!(entries[2].id, "test-1");
    }

    #[test]
    fn test_append_history_preserves_replay_fields_on_disk() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let mut entry = sample_history_entry("sensitive", "2026-03-27T10:00:00Z");
        entry.request_auth_type = "bearer".to_string();
        entry.request_auth = Some(AuthSave {
            auth_type: "bearer".to_string(),
            basic: None,
            bearer: Some(BearerAuth {
                token: "secret-token".to_string(),
            }),
            api_key: None,
        });
        entry.request_body_type = "binary".to_string();
        entry.request_body_binary_path = "payload.bin".to_string();
        entry.request_body_binary_content = Some("AQIDBA==".to_string());
        entry.request_body_form_data = vec![FormDataItem {
            enabled: true,
            key: "file".to_string(),
            value: String::new(),
            description: String::new(),
            value_type: "file".to_string(),
            file_name: "secret.txt".to_string(),
            file_path: "/tmp/secret.txt".to_string(),
            file_content: Some("c2VjcmV0".to_string()),
            content_type: "text/plain".to_string(),
        }];

        append_history(entry).unwrap();

        let entries = load_history().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].request_auth_type, "bearer");
        assert_eq!(
            entries[0]
                .request_auth
                .as_ref()
                .and_then(|auth| auth.bearer.as_ref())
                .map(|bearer| bearer.token.as_str()),
            Some("secret-token")
        );
        assert_eq!(entries[0].request_body_binary_path, "payload.bin");
        assert_eq!(
            entries[0].request_body_binary_content.as_deref(),
            Some("AQIDBA==")
        );
        assert_eq!(entries[0].request_body_form_data[0].file_name, "secret.txt");
        assert_eq!(
            entries[0].request_body_form_data[0].file_path,
            "/tmp/secret.txt".to_string()
        );
        assert_eq!(
            entries[0].request_body_form_data[0].file_content.as_deref(),
            Some("c2VjcmV0")
        );
    }

    #[test]
    fn test_history_cap() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        for index in 0..=1000 {
            let timestamp = format!("2026-03-27T10:{:02}:00Z", index % 60);
            append_history(sample_history_entry(&format!("test-{index}"), &timestamp)).unwrap();
        }

        let entries = load_history().unwrap();
        assert_eq!(entries.len(), 1000);
        assert!(!entries.iter().any(|entry| entry.id == "test-0"));
    }

    fn sample_saved_request(name: &str, method: &str, url: &str) -> SavedRequest {
        SavedRequest {
            name: name.to_string(),
            method: method.to_string(),
            url: url.to_string(),
            params: vec![],
            headers: vec![],
            body: RequestBodySave {
                body_type: "none".to_string(),
                content: "".to_string(),
                form_data: vec![],
                binary_path: "".to_string(),
                binary_content: None,
            },
            auth: AuthSave {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            pre_request_script: String::new(),
            test_script: String::new(),
        }
    }

    fn sample_env_variable(key: &str, value: &str, secret: bool) -> EnvVariable {
        EnvVariable {
            key: key.to_string(),
            value: value.to_string(),
            secret,
            vault_key: String::new(),
        }
    }

    fn configure_local_secret_storage_for_test() {
        clear_secret_vault_session();
        configure_secret_storage(
            "local-encrypted".to_string(),
            Some("test-passphrase".to_string()),
        )
        .unwrap();
    }

    #[test]
    fn test_secret_storage_requires_first_run_choice() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        clear_secret_vault_session();

        let state = get_secret_storage_state().unwrap();
        assert!(!state.configured);
        assert!(state.locked);

        let error = save_secret_value("project:dev:apiKey", "secret").unwrap_err();
        assert!(error.contains("not configured"));
    }

    #[test]
    fn test_local_secret_storage_encrypts_and_requires_unlock() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        clear_secret_vault_session();

        configure_secret_storage(
            "local-encrypted".to_string(),
            Some("correct-passphrase".to_string()),
        )
        .unwrap();
        save_secret_value("project:dev:apiKey", "local-secret").unwrap();

        let vault_contents = std::fs::read_to_string(local_secret_vault_path().unwrap()).unwrap();
        assert!(!vault_contents.contains("local-secret"));
        assert!(vault_contents.contains("chacha20poly1305"));

        clear_secret_vault_session();
        let locked_state = get_secret_storage_state().unwrap();
        assert!(locked_state.configured);
        assert!(locked_state.locked);

        let locked_error = load_secret_value("project:dev:apiKey").unwrap_err();
        assert!(locked_error.contains("locked"));

        let wrong_password = unlock_secret_storage("wrong-passphrase".to_string()).unwrap_err();
        assert!(wrong_password.contains("master password"));

        unlock_secret_storage("correct-passphrase".to_string()).unwrap();
        assert_eq!(
            load_secret_value("project:dev:apiKey").unwrap(),
            "local-secret"
        );
    }

    #[test]
    fn test_system_secret_storage_remains_optional() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        clear_secret_vault_session();

        configure_secret_storage("system-keychain".to_string(), None).unwrap();
        let state = get_secret_storage_state().unwrap();
        assert!(state.configured);
        assert_eq!(state.backend, Some(SecretStorageBackend::SystemKeychain));
        assert!(!state.locked);

        save_secret_value("project:dev:apiKey", "system-secret").unwrap();
        assert_eq!(
            load_secret_value("project:dev:apiKey").unwrap(),
            "system-secret"
        );
    }

    #[test]
    fn test_project_crud() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let project = create_project("Test API".to_string(), "A test project".to_string()).unwrap();
        assert_eq!(project.name, "Test API");

        let projects = list_projects().unwrap();
        assert!(projects.iter().any(|item| item.name == "Test API"));

        let duplicate = create_project("Test API".to_string(), "".to_string());
        assert!(duplicate.is_err());

        let project_dir = temp_home.path().join("ApiSolo/projects/test-api");
        assert!(project_dir.join("apisolo.project.json").exists());
        assert!(project_dir.join("collections").is_dir());
        assert!(project_dir.join("environments").is_dir());
    }

    #[test]
    fn test_collection_and_request() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("My API".to_string(), "".to_string()).unwrap();
        create_collection("My API".to_string(), "users".to_string(), "".to_string()).unwrap();

        save_request(
            "My API".to_string(),
            "users".to_string(),
            sample_saved_request("Get Users", "GET", "https://api.example.com/users"),
            None,
        )
        .unwrap();
        save_request(
            "My API".to_string(),
            "users".to_string(),
            sample_saved_request("Create User", "POST", "https://api.example.com/users"),
            None,
        )
        .unwrap();

        let tree = get_collection_tree("My API".to_string()).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "users");
        assert_eq!(tree[0].node_type, "folder");
        assert_eq!(tree[0].children.len(), 2);
        assert!(tree[0].children.iter().any(|node| {
            node.node_type == "request"
                && node.name == "Get Users"
                && node.method.as_deref() == Some("GET")
        }));
        assert!(tree[0].children.iter().any(|node| {
            node.node_type == "request"
                && node.name == "Create User"
                && node.method.as_deref() == Some("POST")
        }));

        let request = load_request(
            "My API".to_string(),
            "users/get-users.request.json".to_string(),
        )
        .unwrap();
        assert_eq!(request.name, "Get Users");
        assert_eq!(request.method, "GET");

        rename_request(
            "My API".to_string(),
            "users/get-users.request.json".to_string(),
            "List Users".to_string(),
        )
        .unwrap();
        rename_collection(
            "My API".to_string(),
            "users".to_string(),
            "accounts".to_string(),
        )
        .unwrap();

        let tree = get_collection_tree("My API".to_string()).unwrap();
        assert_eq!(tree[0].name, "accounts");
        assert!(tree[0].children.iter().any(|node| {
            node.node_type == "request"
                && node.name == "List Users"
                && node.path == "accounts/list-users.request.json"
        }));

        delete_request(
            "My API".to_string(),
            "accounts/list-users.request.json".to_string(),
        )
        .unwrap();

        let tree = get_collection_tree("My API".to_string()).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].name, "Create User");

        delete_collection("My API".to_string(), "accounts".to_string()).unwrap();

        let tree = get_collection_tree("My API".to_string()).unwrap();
        assert!(tree.is_empty());
    }

    #[test]
    fn test_save_request_strips_sensitive_persistence_fields() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Sensitive Save".to_string(), "".to_string()).unwrap();
        let mut request =
            sample_saved_request("Upload Secret", "POST", "https://api.example.com/upload");
        request.headers = vec![KeyValuePair {
            enabled: true,
            key: "Authorization".to_string(),
            value: "Bearer direct-token".to_string(),
            description: String::new(),
        }];
        request.auth = AuthSave {
            auth_type: "bearer".to_string(),
            basic: None,
            bearer: Some(BearerAuth {
                token: "{{apiToken}}".to_string(),
            }),
            api_key: None,
        };
        request.body = RequestBodySave {
            body_type: "form-data".to_string(),
            content: String::new(),
            form_data: vec![FormDataItem {
                enabled: true,
                key: "file".to_string(),
                value: String::new(),
                description: String::new(),
                value_type: "file".to_string(),
                file_name: "secret.txt".to_string(),
                file_path: "/tmp/secret.txt".to_string(),
                file_content: Some("c2VjcmV0".to_string()),
                content_type: "text/plain".to_string(),
            }],
            binary_path: String::new(),
            binary_content: Some("c2VjcmV0".to_string()),
        };

        save_request("Sensitive Save".to_string(), "".to_string(), request, None).unwrap();

        let saved = load_request(
            "Sensitive Save".to_string(),
            "upload-secret.request.json".to_string(),
        )
        .unwrap();

        assert_eq!(saved.headers[0].value, "");
        assert_eq!(
            saved.auth.bearer.map(|bearer| bearer.token),
            Some("{{apiToken}}".to_string())
        );
        assert_eq!(saved.body.form_data[0].file_name, "secret.txt");
        assert_eq!(saved.body.form_data[0].file_path, "");
        assert!(saved.body.form_data[0].file_content.is_none());
        assert!(saved.body.binary_content.is_none());
    }

    #[test]
    fn test_environment_crud() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Env Test".to_string(), "".to_string()).unwrap();
        configure_local_secret_storage_for_test();

        let environments = list_environments("Env Test".to_string()).unwrap();
        assert!(environments.is_empty());

        save_environment(
            "Env Test".to_string(),
            Environment {
                name: "dev".to_string(),
                variables: vec![
                    sample_env_variable("baseUrl", "http://localhost:3000", false),
                    sample_env_variable("apiKey", "secret-key-123", true),
                ],
            },
        )
        .unwrap();

        let environments = list_environments("Env Test".to_string()).unwrap();
        assert_eq!(environments, vec!["dev".to_string()]);

        let env = load_environment("Env Test".to_string(), "dev".to_string()).unwrap();
        assert_eq!(env.name, "dev");
        assert_eq!(env.variables.len(), 2);
        assert!(env.variables.iter().any(|variable| {
            variable.key == "baseUrl"
                && variable.value == "http://localhost:3000"
                && !variable.secret
        }));
        assert!(env.variables.iter().any(|variable| {
            variable.key == "apiKey" && variable.value == "secret-key-123" && variable.secret
        }));

        let env_dir = temp_home
            .path()
            .join("ApiSolo/projects/env-test/environments");
        let normal_contents = std::fs::read_to_string(env_dir.join("dev.env.json")).unwrap();
        let secret_contents =
            std::fs::read_to_string(env_dir.join("dev.env.secrets.json")).unwrap();
        let normal_vars: Vec<EnvVariable> = serde_json::from_str(&normal_contents).unwrap();
        let secret_vars: Vec<EnvVariable> = serde_json::from_str(&secret_contents).unwrap();

        assert_eq!(normal_vars.len(), 1);
        assert_eq!(normal_vars[0].key, "baseUrl");
        assert_eq!(normal_vars[0].value, "http://localhost:3000");
        assert!(!normal_vars[0].secret);

        assert_eq!(secret_vars.len(), 1);
        assert_eq!(secret_vars[0].key, "apiKey");
        assert_eq!(secret_vars[0].value, "");
        assert!(secret_vars[0].secret);
        assert!(!secret_vars[0].vault_key.is_empty());

        delete_environment("Env Test".to_string(), "dev".to_string()).unwrap();

        let environments = list_environments("Env Test".to_string()).unwrap();
        assert!(environments.is_empty());
    }

    #[test]
    fn test_environment_secret_plaintext_migration() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Migration Test".to_string(), "".to_string()).unwrap();
        configure_local_secret_storage_for_test();

        let env_dir = temp_home
            .path()
            .join("ApiSolo/projects/migration-test/environments");
        std::fs::write(
            env_dir.join("dev.env.secrets.json"),
            r#"[{"key":"apiKey","value":"legacy-secret","secret":true}]"#,
        )
        .unwrap();

        let env = load_environment("Migration Test".to_string(), "dev".to_string()).unwrap();
        let variable = env
            .variables
            .iter()
            .find(|variable| variable.key == "apiKey")
            .unwrap();
        assert_eq!(variable.value, "legacy-secret");
        assert!(variable.secret);

        let secret_contents =
            std::fs::read_to_string(env_dir.join("dev.env.secrets.json")).unwrap();
        let secret_vars: Vec<EnvVariable> = serde_json::from_str(&secret_contents).unwrap();
        assert_eq!(secret_vars[0].value, "");
        assert!(!secret_vars[0].vault_key.is_empty());
    }

    #[test]
    fn test_resolve_variables_command() {
        let resolved = resolve_variables(
            "{{host}}/{{path}}".to_string(),
            vec![
                sample_env_variable("host", "https://api.com", false),
                sample_env_variable("path", "users", false),
            ],
        )
        .unwrap();
        assert_eq!(resolved, "https://api.com/users");

        let resolved =
            resolve_variables("ts={{$timestamp}}&id={{$randomUUID}}".to_string(), vec![]).unwrap();
        let mut parts = resolved.split("&id=");
        let timestamp_part = parts.next().unwrap();
        let uuid_part = parts.next().unwrap();
        assert!(parts.next().is_none());
        assert_eq!(
            timestamp_part
                .strip_prefix("ts=")
                .unwrap()
                .parse::<i64>()
                .is_ok(),
            true
        );
        assert!(uuid::Uuid::parse_str(uuid_part).is_ok());
    }

    #[test]
    fn test_history_delete_entry() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        append_history(sample_history_entry("test-1", "2026-03-27T10:00:00Z")).unwrap();
        append_history(sample_history_entry("test-2", "2026-03-27T10:01:00Z")).unwrap();
        append_history(sample_history_entry("test-3", "2026-03-27T10:02:00Z")).unwrap();

        delete_history_entry("test-2".to_string()).unwrap();

        let entries = load_history().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(!entries.iter().any(|entry| entry.id == "test-2"));
    }

    #[test]
    fn test_clear_history() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        append_history(sample_history_entry("test-1", "2026-03-27T10:00:00Z")).unwrap();
        append_history(sample_history_entry("test-2", "2026-03-27T10:01:00Z")).unwrap();
        append_history(sample_history_entry("test-3", "2026-03-27T10:02:00Z")).unwrap();

        clear_history().unwrap();

        let entries = load_history().unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_path_security() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Safe".to_string(), "".to_string()).unwrap();

        assert!(load_request("Safe".to_string(), "../../../etc/passwd".to_string()).is_err());
        assert!(delete_collection("Safe".to_string(), "../..".to_string()).is_err());
        assert!(rename_collection(
            "Safe".to_string(),
            "../..".to_string(),
            "renamed".to_string()
        )
        .is_err());
        assert!(rename_request(
            "Safe".to_string(),
            "../test.request.json".to_string(),
            "renamed".to_string()
        )
        .is_err());
        assert!(save_request(
            "Safe".to_string(),
            "../escape".to_string(),
            sample_saved_request("Escape", "GET", "https://api.example.com/escape"),
            None,
        )
        .is_err());
    }

    #[tokio::test]
    async fn test_send_request_real_http() {
        use wiremock::{
            matchers::{header, method, path, query_param},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/get"))
            .and(query_param("foo", "bar"))
            .and(header("X-Test", "apisolo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "args": { "foo": "bar" },
                "headers": { "X-Test": "apisolo" }
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let args = SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/get?foo=bar", mock_server.uri()),
            params: vec![],
            headers: vec![KeyValuePair {
                enabled: true,
                key: "X-Test".to_string(),
                value: "apisolo".to_string(),
                description: String::new(),
            }],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        };

        let response = send_request(args).await.unwrap();

        assert_eq!(response.status, 200);
        assert!(!response.status_text.is_empty());
        assert!(response.time <= response.timings.total);
        assert!(response.size > 0);
        assert!(response.body.contains("\"foo\":\"bar\""));
        assert!(response.body.contains("\"X-Test\":\"apisolo\""));
        assert!(!response.headers.is_empty());
    }

    #[tokio::test]
    async fn test_send_request_post_json() {
        use wiremock::{
            matchers::{body_json, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(body_json(serde_json::json!({"name":"ApiSolo","version":1})))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"name":"ApiSolo","version":1})),
            )
            .expect(1)
            .mount(&mock_server)
            .await;

        let args = SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/post", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "json".to_string(),
                content: r#"{"name":"ApiSolo","version":1}"#.to_string(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        };

        let response = send_request(args).await.unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response.body).unwrap(),
            serde_json::json!({"name":"ApiSolo","version":1})
        );
    }

    #[tokio::test]
    async fn test_send_request_invalid_url() {
        let args = SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: "not-a-valid-url".to_string(),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        };

        let result = send_request(args).await;
        assert!(result.is_err());
    }

    /// Simulate the exact JSON the frontend sends via Tauri invoke,
    /// to verify serde deserialization matches the frontend's camelCase format.
    #[test]
    fn test_serde_frontend_json_compat_send_request() {
        let json = r#"{
            "method": "POST",
            "url": "https://api.example.com/users",
            "params": [
                {"enabled": true, "key": "page", "value": "1"}
            ],
            "headers": [
                {"enabled": true, "key": "Content-Type", "value": "application/json"}
            ],
            "body": {
                "type": "json",
                "content": "{\"name\":\"test\"}"
            },
            "auth": {
                "type": "api-key",
                "apiKey": {
                    "key": "X-API-Key",
                    "value": "secret123",
                    "addTo": "header"
                }
            }
        }"#;

        let args: SendRequestArgs = serde_json::from_str(json).unwrap();
        assert_eq!(args.method, "POST");
        assert_eq!(args.url, "https://api.example.com/users");
        assert_eq!(args.params.len(), 1);
        assert_eq!(args.headers.len(), 1);
        assert_eq!(args.body.body_type, "json");
        assert_eq!(args.auth.auth_type, "api-key");
        let api_key = args.auth.api_key.unwrap();
        assert_eq!(api_key.key, "X-API-Key");
        assert_eq!(api_key.value, "secret123");
        assert_eq!(api_key.add_to, "header");
    }

    #[test]
    fn test_serde_frontend_json_compat_saved_request() {
        let json = r#"{
            "name": "Create User",
            "method": "POST",
            "url": "https://api.example.com/users",
            "params": [],
            "headers": [],
            "body": {
                "type": "json",
                "content": "{}",
                "formData": [],
                "binaryPath": ""
            },
            "auth": {
                "type": "bearer",
                "bearer": {"token": "abc"},
                "apiKey": {"key": "k", "value": "v", "addTo": "query"}
            }
        }"#;

        let req: SavedRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.name, "Create User");
        assert_eq!(req.body.body_type, "json");
        assert!(req.body.form_data.is_empty());
        assert!(req.body.binary_path.is_empty());
        assert_eq!(req.auth.auth_type, "bearer");
        let api_key = req.auth.api_key.unwrap();
        assert_eq!(api_key.add_to, "query");
    }

    #[test]
    fn test_serde_frontend_json_compat_response() {
        let response = HttpResponse {
            status: 200,
            status_text: "OK".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: "{}".to_string(),
            size: 2,
            time: 150,
            timings: RequestTimings {
                dns_lookup: 15,
                tcp_connect: 20,
                tls_handshake: 25,
                ttfb: 120,
                download: 30,
                total: 210,
            },
            content_type: "application/json".to_string(),
            body_kind: ResponseBodyKind::Text,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"statusText\""));
        assert!(json.contains("\"bodyKind\":\"text\""));
        assert!(json.contains("\"contentType\""));
        assert!(json.contains("\"timings\""));
        assert!(!json.contains("\"status_text\""));
        assert!(!json.contains("\"content_type\""));
    }

    #[test]
    fn test_serde_frontend_json_compat_history_entry_old_format() {
        let json = r#"{
            "id": "history-1",
            "method": "GET",
            "url": "https://api.example.com/users",
            "status": 200,
            "time": 150,
            "size": 2048,
            "timestamp": "2026-03-27T10:00:00Z",
            "contentType": "application/json"
        }"#;

        let entry: HistoryEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.method, "GET");
        assert!(entry.request_params.is_empty());
        assert!(entry.request_headers.is_empty());
        assert!(entry.request_body_type.is_empty());
        assert!(entry.request_body_content.is_empty());
        assert!(entry.request_auth_type.is_empty());
        assert!(entry.pre_request_script.is_empty());
        assert!(entry.test_script.is_empty());
        assert!(entry.response_body.is_empty());
        assert!(entry.response_headers.is_empty());
        assert_eq!(entry.timings.total, 0);
    }

    #[test]
    fn test_serde_frontend_json_compat_history_entry_new_fields() {
        let entry = HistoryEntry {
            id: "history-2".to_string(),
            method: "POST".to_string(),
            url: "https://api.example.com/users".to_string(),
            status: 201,
            time: 220,
            size: 512,
            timings: RequestTimings {
                dns_lookup: 18,
                tcp_connect: 22,
                tls_handshake: 26,
                ttfb: 180,
                download: 40,
                total: 286,
            },
            timestamp: "2026-03-27T11:00:00Z".to_string(),
            content_type: "application/json".to_string(),
            request_params: vec![KeyValuePair {
                enabled: true,
                key: "page".to_string(),
                value: "1".to_string(),
                description: String::new(),
            }],
            request_headers: vec![KeyValuePair {
                enabled: true,
                key: "X-Test".to_string(),
                value: "true".to_string(),
                description: String::new(),
            }],
            request_body_type: "json".to_string(),
            request_body_content: "{\"name\":\"alice\"}".to_string(),
            request_auth_type: "bearer".to_string(),
            request_auth: Some(AuthSave {
                auth_type: "bearer".to_string(),
                basic: None,
                bearer: Some(BearerAuth {
                    token: "token-123".to_string(),
                }),
                api_key: None,
            }),
            request_body_form_data: vec![],
            request_body_binary_path: String::new(),
            request_body_binary_content: None,
            pre_request_script: "pm.environment.set(\"baseUrl\", \"https://api.example.com\")"
                .to_string(),
            test_script: "pm.test(\"status\", () => pm.expect(pm.response).to.have.status(201))"
                .to_string(),
            response_body: "{\"ok\":true}".to_string(),
            response_headers: vec![("content-type".to_string(), "application/json".to_string())],
        };

        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"requestParams\""));
        assert!(json.contains("\"requestHeaders\""));
        assert!(json.contains("\"requestBodyType\""));
        assert!(json.contains("\"requestBodyContent\""));
        assert!(json.contains("\"requestAuthType\""));
        assert!(json.contains("\"requestAuth\""));
        assert!(json.contains("\"preRequestScript\""));
        assert!(json.contains("\"testScript\""));
        assert!(json.contains("\"responseBody\""));
        assert!(json.contains("\"responseHeaders\""));
        assert!(json.contains("\"timings\""));
        assert!(!json.contains("\"request_params\""));

        let roundtrip: HistoryEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.request_body_type, "json");
        assert_eq!(roundtrip.request_auth_type, "bearer");
        assert_eq!(
            roundtrip
                .request_auth
                .as_ref()
                .and_then(|auth| auth.bearer.as_ref())
                .map(|bearer| bearer.token.as_str()),
            Some("token-123")
        );
        assert!(roundtrip.pre_request_script.contains("baseUrl"));
        assert!(roundtrip.test_script.contains("pm.test"));
        assert_eq!(roundtrip.response_headers.len(), 1);
        assert_eq!(roundtrip.timings.total, 286);
    }

    /// =========================================================
    /// Full E2E test: mock HTTP server + complete user workflow
    /// =========================================================
    /// Simulates a real user session:
    ///   1. Create project + environment
    ///   2. Save a request with {{variable}} placeholders
    ///   3. Resolve variables + send request to mock server
    ///   4. Verify response, history, and persisted data
    ///   5. Load saved request back and re-send
    ///   6. Verify mock server received correct headers/body
    #[test]
    fn test_e2e_full_workflow_with_mock_server() {
        use wiremock::{
            matchers::{header, method, path},
            Mock, MockServer, ResponseTemplate,
        };

        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        let runtime = tokio::runtime::Runtime::new().unwrap();

        runtime.block_on(async {
            // ── Step 1: Start mock HTTP server ──
            let mock_server = MockServer::start().await;

            Mock::given(method("GET"))
                .and(path("/api/v1/users"))
                .and(header("X-API-Key", "test-key-123"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({
                            "users": [
                                {"id": 1, "name": "Alice"},
                                {"id": 2, "name": "Bob"}
                            ],
                            "total": 2
                        }))
                        .insert_header("X-Request-Id", "mock-req-001"),
                )
                .expect(1..)
                .mount(&mock_server)
                .await;

            Mock::given(method("POST"))
                .and(path("/api/v1/users"))
                .and(header("Content-Type", "application/json"))
                .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                    "id": 3,
                    "name": "Charlie",
                    "created": true
                })))
                .expect(1)
                .mount(&mock_server)
                .await;

            let base_url = mock_server.uri();

            // ── Step 2: Create project ──
            let project = create_project(
                "E2E Test API".to_string(),
                "End-to-end test project".to_string(),
            )
            .unwrap();
            assert_eq!(project.name, "E2E Test API");
            configure_local_secret_storage_for_test();

            // ── Step 3: Create environment with variables ──
            save_environment(
                "E2E Test API".to_string(),
                Environment {
                    name: "test".to_string(),
                    variables: vec![
                        EnvVariable {
                            key: "baseUrl".to_string(),
                            value: base_url.clone(),
                            secret: false,
                            vault_key: String::new(),
                        },
                        EnvVariable {
                            key: "apiKey".to_string(),
                            value: "test-key-123".to_string(),
                            secret: true,
                            vault_key: String::new(),
                        },
                    ],
                },
            )
            .unwrap();

            // Verify environment was saved correctly
            let env = load_environment("E2E Test API".to_string(), "test".to_string()).unwrap();
            assert_eq!(env.variables.len(), 2);
            let secret_var = env.variables.iter().find(|v| v.key == "apiKey").unwrap();
            assert!(secret_var.secret);

            // ── Step 4: Create collection and save request ──
            create_collection(
                "E2E Test API".to_string(),
                "users".to_string(),
                "".to_string(),
            )
            .unwrap();

            save_request(
                "E2E Test API".to_string(),
                "users".to_string(),
                SavedRequest {
                    name: "List Users".to_string(),
                    method: "GET".to_string(),
                    url: "{{baseUrl}}/api/v1/users".to_string(),
                    params: vec![],
                    headers: vec![KeyValuePair {
                        enabled: true,
                        key: "X-API-Key".to_string(),
                        value: "{{apiKey}}".to_string(),
                        description: "Auth key".to_string(),
                    }],
                    body: RequestBodySave {
                        body_type: "none".to_string(),
                        content: String::new(),
                        form_data: vec![],
                        binary_path: String::new(),
                        binary_content: None,
                    },
                    auth: AuthSave {
                        auth_type: "none".to_string(),
                        basic: None,
                        bearer: None,
                        api_key: None,
                    },
                    pre_request_script: "pm.environment.set(\"apiKey\", \"{{apiKey}}\")"
                        .to_string(),
                    test_script: "pm.test(\"status\", () => pm.expect(pm.response).to.be.ok)"
                        .to_string(),
                },
                None,
            )
            .unwrap();

            // Verify collection tree
            let tree = get_collection_tree("E2E Test API".to_string()).unwrap();
            assert_eq!(tree.len(), 1);
            assert_eq!(tree[0].name, "users");
            assert_eq!(tree[0].children.len(), 1);
            assert_eq!(tree[0].children[0].name, "List Users");

            // ── Step 5: Load saved request back ──
            let loaded = load_request(
                "E2E Test API".to_string(),
                "users/list-users.request.json".to_string(),
            )
            .unwrap();
            assert_eq!(loaded.name, "List Users");
            assert_eq!(loaded.url, "{{baseUrl}}/api/v1/users");
            assert_eq!(loaded.headers[0].value, "{{apiKey}}");
            assert!(loaded.pre_request_script.contains("apiKey"));
            assert!(loaded.test_script.contains("pm.test"));

            // ── Step 6: Resolve variables (like frontend does before sending) ──
            let resolved_url = resolve_variables(loaded.url, env.variables.clone()).unwrap();
            assert_eq!(resolved_url, format!("{}/api/v1/users", base_url));

            let resolved_header_value =
                resolve_variables(loaded.headers[0].value.clone(), env.variables.clone()).unwrap();
            assert_eq!(resolved_header_value, "test-key-123");

            // ── Step 7: Send GET request to mock server ──
            let get_response = send_request(SendRequestArgs {
                request_id: String::new(),
                method: "GET".to_string(),
                url: resolved_url,
                params: vec![],
                headers: vec![KeyValuePair {
                    enabled: true,
                    key: "X-API-Key".to_string(),
                    value: resolved_header_value,
                    description: String::new(),
                }],
                body: RequestBodyInput {
                    body_type: "none".to_string(),
                    content: String::new(),
                    form_data: vec![],
                    binary_path: String::new(),
                    binary_content: None,
                },
                auth: AuthInput {
                    auth_type: "none".to_string(),
                    basic: None,
                    bearer: None,
                    api_key: None,
                },
                proxy: None,
                tls: None,
            })
            .await
            .unwrap();
            let get_body: serde_json::Value = serde_json::from_str(&get_response.body).unwrap();

            assert_eq!(get_response.status, 200);
            assert_eq!(
                get_body,
                serde_json::json!({
                    "users": [
                        {"id": 1, "name": "Alice"},
                        {"id": 2, "name": "Bob"}
                    ],
                    "total": 2
                })
            );
            assert!(get_response.size > 0);
            assert!(get_response.content_type.contains("application/json"));
            // Verify mock server's custom response header came through
            assert!(get_response
                .headers
                .iter()
                .any(|(k, v)| k == "x-request-id" && v == "mock-req-001"));

            // ── Step 8: Record to history ──
            let history_entry = HistoryEntry {
                id: Uuid::new_v4().to_string(),
                method: "GET".to_string(),
                url: format!("{}/api/v1/users", base_url),
                status: get_response.status,
                time: get_response.time,
                size: get_response.size,
                timings: get_response.timings.clone(),
                timestamp: now_iso(),
                content_type: get_response.content_type.clone(),
                request_params: vec![],
                request_headers: vec![KeyValuePair {
                    enabled: true,
                    key: "X-API-Key".to_string(),
                    value: "test-key-123".to_string(),
                    description: String::new(),
                }],
                request_body_type: "none".to_string(),
                request_body_content: String::new(),
                request_auth_type: "api-key".to_string(),
                request_auth: Some(AuthSave {
                    auth_type: "api-key".to_string(),
                    basic: None,
                    bearer: None,
                    api_key: Some(ApiKeyAuth {
                        key: "X-API-Key".to_string(),
                        value: "test-key-123".to_string(),
                        add_to: "header".to_string(),
                    }),
                }),
                request_body_form_data: vec![],
                request_body_binary_path: String::new(),
                request_body_binary_content: None,
                pre_request_script: String::new(),
                test_script: String::new(),
                response_body: get_response.body.clone(),
                response_headers: get_response.headers.clone(),
            };
            append_history(history_entry).unwrap();

            // ── Step 9: Send POST request with JSON body ──
            let post_response = send_request(SendRequestArgs {
                request_id: String::new(),
                method: "POST".to_string(),
                url: format!("{}/api/v1/users", base_url),
                params: vec![],
                headers: vec![],
                body: RequestBodyInput {
                    body_type: "json".to_string(),
                    content: r#"{"name":"Charlie"}"#.to_string(),
                    form_data: vec![],
                    binary_path: String::new(),
                    binary_content: None,
                },
                auth: AuthInput {
                    auth_type: "none".to_string(),
                    basic: None,
                    bearer: None,
                    api_key: None,
                },
                proxy: None,
                tls: None,
            })
            .await
            .unwrap();
            let post_body: serde_json::Value = serde_json::from_str(&post_response.body).unwrap();

            assert_eq!(post_response.status, 201);
            assert_eq!(
                post_body,
                serde_json::json!({
                    "id": 3,
                    "name": "Charlie",
                    "created": true
                })
            );

            // Record POST to history
            let post_history = HistoryEntry {
                id: Uuid::new_v4().to_string(),
                method: "POST".to_string(),
                url: format!("{}/api/v1/users", base_url),
                status: post_response.status,
                time: post_response.time,
                size: post_response.size,
                timings: post_response.timings.clone(),
                timestamp: now_iso(),
                content_type: post_response.content_type.clone(),
                request_params: vec![],
                request_headers: vec![],
                request_body_type: "json".to_string(),
                request_body_content: r#"{"name":"Charlie"}"#.to_string(),
                request_auth_type: "none".to_string(),
                request_auth: Some(AuthSave {
                    auth_type: "none".to_string(),
                    basic: None,
                    bearer: None,
                    api_key: None,
                }),
                request_body_form_data: vec![],
                request_body_binary_path: String::new(),
                request_body_binary_content: None,
                pre_request_script: String::new(),
                test_script: String::new(),
                response_body: post_response.body.clone(),
                response_headers: post_response.headers.clone(),
            };
            append_history(post_history).unwrap();

            // ── Step 10: Verify history ──
            let history = load_history().unwrap();
            assert_eq!(history.len(), 2);
            // Most recent first
            assert_eq!(history[0].method, "POST");
            assert_eq!(history[0].status, 201);
            assert_eq!(history[1].method, "GET");
            assert_eq!(history[1].status, 200);
            // Both should point to our mock server
            assert!(history[0].url.contains("/api/v1/users"));
            assert!(history[1].url.contains("/api/v1/users"));

            // ── Step 11: Verify all persisted data ──
            // Projects
            let projects = list_projects().unwrap();
            assert_eq!(projects.len(), 1);
            assert_eq!(projects[0].name, "E2E Test API");

            // Environments
            let envs = list_environments("E2E Test API".to_string()).unwrap();
            assert_eq!(envs, vec!["test"]);

            // Collection tree still intact
            let tree = get_collection_tree("E2E Test API".to_string()).unwrap();
            assert_eq!(tree[0].children.len(), 1);

            // Verify mock server received all expected requests
            // (wiremock will panic on drop if expectations not met)
        });
    }

    /// Test API Key auth via header — send to mock server and verify header arrives
    #[tokio::test]
    async fn test_e2e_api_key_auth_header() {
        use wiremock::{
            matchers::{header, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(header("X-Custom-Auth", "my-secret-key"))
            .respond_with(ResponseTemplate::new(200).set_body_string("auth ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/protected", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "api-key".to_string(),
                basic: None,
                bearer: None,
                api_key: Some(ApiKeyAuth {
                    key: "X-Custom-Auth".to_string(),
                    value: "my-secret-key".to_string(),
                    add_to: "header".to_string(),
                }),
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "auth ok");
    }

    /// Test API Key auth via query param
    #[tokio::test]
    async fn test_e2e_api_key_auth_query() {
        use wiremock::{
            matchers::{method, query_param},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(query_param("api_key", "qwerty"))
            .respond_with(ResponseTemplate::new(200).set_body_string("query auth ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/data", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "api-key".to_string(),
                basic: None,
                bearer: None,
                api_key: Some(ApiKeyAuth {
                    key: "api_key".to_string(),
                    value: "qwerty".to_string(),
                    add_to: "query".to_string(),
                }),
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "query auth ok");
    }

    /// Test Bearer auth
    #[tokio::test]
    async fn test_e2e_bearer_auth() {
        use wiremock::{
            matchers::{header, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(header("Authorization", "Bearer my-jwt-token"))
            .respond_with(ResponseTemplate::new(200).set_body_string("bearer ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/me", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "bearer".to_string(),
                basic: None,
                bearer: Some(BearerAuth {
                    token: "my-jwt-token".to_string(),
                }),
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "bearer ok");
    }

    /// Test Basic auth
    #[tokio::test]
    async fn test_e2e_basic_auth() {
        use wiremock::{
            matchers::{header, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        // Basic auth "admin:password123" → base64 "YWRtaW46cGFzc3dvcmQxMjM="
        Mock::given(method("GET"))
            .and(header("Authorization", "Basic YWRtaW46cGFzc3dvcmQxMjM="))
            .respond_with(ResponseTemplate::new(200).set_body_string("basic ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/admin", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "basic".to_string(),
                basic: Some(BasicAuth {
                    username: "admin".to_string(),
                    password: "password123".to_string(),
                }),
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "basic ok");
    }

    /// Test form-urlencoded body
    #[tokio::test]
    async fn test_e2e_form_urlencoded() {
        use wiremock::{
            matchers::{body_string, header, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(header("Content-Type", "application/x-www-form-urlencoded"))
            .and(body_string("username=alice&password=secret"))
            .respond_with(ResponseTemplate::new(200).set_body_string("form ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/login", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "form-urlencoded".to_string(),
                content: "username=alice&password=secret".to_string(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "form ok");
    }

    #[tokio::test]
    async fn test_e2e_binary_body() {
        use wiremock::{
            matchers::{body_bytes, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(body_bytes(vec![1_u8, 2, 3, 4]))
            .respond_with(ResponseTemplate::new(200).set_body_string("binary ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/binary", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "binary".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: "payload.bin".to_string(),
                binary_content: Some("AQIDBA==".to_string()),
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "binary ok");
    }

    #[tokio::test]
    async fn test_e2e_form_data_file_part() {
        use wiremock::{
            matchers::{body_string_contains, header_regex, method},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(header_regex(
                "content-type",
                "multipart/form-data; boundary=.*",
            ))
            .and(body_string_contains("name=\"file\""))
            .and(body_string_contains("filename=\"hello.txt\""))
            .and(body_string_contains("hello world"))
            .respond_with(ResponseTemplate::new(200).set_body_string("multipart ok"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/multipart", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "form-data".to_string(),
                content: String::new(),
                form_data: vec![FormDataItem {
                    enabled: true,
                    key: "file".to_string(),
                    value: String::new(),
                    description: String::new(),
                    value_type: "file".to_string(),
                    file_name: "hello.txt".to_string(),
                    file_path: String::new(),
                    file_content: Some("aGVsbG8gd29ybGQ=".to_string()),
                    content_type: "text/plain".to_string(),
                }],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, "multipart ok");
    }

    #[tokio::test]
    async fn test_send_request_rejects_binary_raw_file_paths_for_local_tauri() {
        use wiremock::MockServer;

        let temp_file = tempfile::NamedTempFile::new().unwrap();
        fs::write(temp_file.path(), [1_u8, 2, 3, 4]).unwrap();
        let mock_server = MockServer::start().await;

        let error = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/binary", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "binary".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: temp_file.path().display().to_string(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .err()
        .unwrap();

        assert!(error.contains("must include inline content; raw filesystem paths are not allowed"));
        assert!(error.contains(
            temp_file
                .path()
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap()
        ));
    }

    #[tokio::test]
    async fn test_send_request_rejects_form_data_raw_file_paths_for_local_tauri() {
        use wiremock::MockServer;

        let temp_file = tempfile::NamedTempFile::new().unwrap();
        fs::write(temp_file.path(), "hello from disk").unwrap();
        let mock_server = MockServer::start().await;

        let error = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: format!("{}/multipart", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "form-data".to_string(),
                content: String::new(),
                form_data: vec![FormDataItem {
                    enabled: true,
                    key: "file".to_string(),
                    value: String::new(),
                    description: String::new(),
                    value_type: "file".to_string(),
                    file_name: String::new(),
                    file_path: temp_file.path().display().to_string(),
                    file_content: None,
                    content_type: "text/plain".to_string(),
                }],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .err()
        .unwrap();

        assert_eq!(
            error,
            "Form-data file parts must include inline content; raw filesystem paths are not allowed (file)"
        );
    }

    #[tokio::test]
    async fn test_cancel_request_aborts_in_flight() {
        use std::time::Duration;
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(1))
                    .set_body_string("too slow"),
            )
            .mount(&mock_server)
            .await;

        let handle = tokio::spawn(send_request(SendRequestArgs {
            request_id: "cancel-me".to_string(),
            method: "GET".to_string(),
            url: format!("{}/slow", mock_server.uri()),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        }));

        for _ in 0..50 {
            let registered = active_request_pool().lock().await.contains_key("cancel-me");
            let received = mock_server
                .received_requests()
                .await
                .map(|items| !items.is_empty())
                .unwrap_or(false);
            if registered && received {
                break;
            }
            tokio::task::yield_now().await;
        }

        cancel_request("cancel-me".to_string()).await.unwrap();
        let result = handle.await.unwrap();

        match result {
            Err(error) => assert_eq!(error, "Request cancelled"),
            Ok(_) => panic!("expected cancelled request to return an error"),
        }
        assert!(!active_request_pool().lock().await.contains_key("cancel-me"));
        assert!(
            mock_server
                .received_requests()
                .await
                .unwrap_or_default()
                .len()
                <= 1
        );
    }

    #[tokio::test]
    async fn test_suppressed_disconnect_event_does_not_recreate_queue() {
        ws_event_queue_pool().lock().await.insert(
            "ws-test".to_string(),
            vec![WsEventPayload {
                connection_id: "ws-test".to_string(),
                event_type: "message".to_string(),
                content: "hello".to_string(),
                timestamp: now_iso(),
            }],
        );
        ws_suppressed_disconnect_pool()
            .lock()
            .await
            .insert("ws-test".to_string(), ());

        publish_ws_event(
            None,
            WsEventPayload {
                connection_id: "ws-test".to_string(),
                event_type: "disconnected".to_string(),
                content: String::new(),
                timestamp: now_iso(),
            },
        )
        .await;

        let pool = ws_event_queue_pool();
        let queues = pool.lock().await;
        assert!(!queues.contains_key("ws-test"));
    }

    #[test]
    fn test_default_app_run_does_not_start_dev_bridge() {
        assert!(!should_start_dev_bridge(None));
    }

    #[test]
    fn test_dev_bridge_can_be_explicitly_enabled() {
        assert!(should_start_dev_bridge(Some("1")));
        assert!(should_start_dev_bridge(Some("true")));
        assert!(should_start_dev_bridge(Some("TRUE")));
        assert!(!should_start_dev_bridge(Some("0")));
        assert!(!should_start_dev_bridge(Some("false")));
    }

    #[test]
    fn test_dev_bridge_cors_is_limited_to_explicit_origins() {
        let origins = dev_bridge_allowed_origins();
        let values = origins
            .iter()
            .map(|value| value.to_str().unwrap().to_string())
            .collect::<Vec<_>>();

        assert!(values.contains(&"http://127.0.0.1:1420".to_string()));
        assert!(values.contains(&"http://localhost:1420".to_string()));
        assert!(!values.contains(&"*".to_string()));
    }

    #[test]
    fn test_dev_bridge_rejects_binary_body_raw_file_paths() {
        let error = sanitize_dev_bridge_request_args(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: "http://example.com/upload".to_string(),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "binary".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: "/tmp/secret.bin".to_string(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .err()
        .unwrap();

        assert_eq!(
            error,
            "Binary bodies over the development bridge must include inline content"
        );
    }

    #[test]
    fn test_dev_bridge_rejects_form_data_raw_file_paths() {
        let error = sanitize_dev_bridge_request_args(SendRequestArgs {
            request_id: String::new(),
            method: "POST".to_string(),
            url: "http://example.com/upload".to_string(),
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "form-data".to_string(),
                content: String::new(),
                form_data: vec![FormDataItem {
                    enabled: true,
                    key: "file".to_string(),
                    value: String::new(),
                    description: String::new(),
                    value_type: "file".to_string(),
                    file_name: String::new(),
                    file_path: "/tmp/secret.txt".to_string(),
                    file_content: None,
                    content_type: String::new(),
                }],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .err()
        .unwrap();

        assert_eq!(
            error,
            "Form-data file parts over the development bridge must include inline content"
        );
    }

    #[tokio::test]
    async fn test_dev_bridge_ws_event_queue_is_bounded() {
        let connection_id = "ws-bounded".to_string();
        for index in 0..(DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT + 5) {
            publish_ws_event(
                None,
                WsEventPayload {
                    connection_id: connection_id.clone(),
                    event_type: "message".to_string(),
                    content: format!("event-{index}"),
                    timestamp: now_iso(),
                },
            )
            .await;
        }

        let queue = ws_event_queue_pool()
            .lock()
            .await
            .get(&connection_id)
            .cloned()
            .unwrap();
        let expected_last = format!("event-{}", DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT + 4);

        assert_eq!(queue.len(), DEV_BRIDGE_WS_EVENT_BUFFER_LIMIT);
        assert_eq!(
            queue.first().map(|event| event.content.as_str()),
            Some("event-5")
        );
        assert_eq!(
            queue.last().map(|event| event.content.as_str()),
            Some(expected_last.as_str())
        );
    }

    #[test]
    fn test_should_skip_connection_timings_when_proxy_enabled() {
        let disabled_proxy = ProxyConfig {
            enabled: false,
            proxy_type: "http".to_string(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            auth: None,
        };
        let enabled_proxy = ProxyConfig {
            enabled: true,
            proxy_type: "http".to_string(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            auth: None,
        };

        assert!(should_measure_connection_timings(None));
        assert!(should_measure_connection_timings(Some(&disabled_proxy)));
        assert!(!should_measure_connection_timings(Some(&enabled_proxy)));
    }

    /// Test query params are properly appended
    #[tokio::test]
    async fn test_e2e_query_params() {
        use wiremock::{
            matchers::{method, query_param},
            Mock, MockServer, ResponseTemplate,
        };

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(query_param("page", "2"))
            .and(query_param("limit", "10"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"page": 2, "limit": 10})),
            )
            .expect(1)
            .mount(&mock_server)
            .await;

        let response = send_request(SendRequestArgs {
            request_id: String::new(),
            method: "GET".to_string(),
            url: format!("{}/items", mock_server.uri()),
            params: vec![
                KeyValuePair {
                    enabled: true,
                    key: "page".to_string(),
                    value: "2".to_string(),
                    description: String::new(),
                },
                KeyValuePair {
                    enabled: true,
                    key: "limit".to_string(),
                    value: "10".to_string(),
                    description: String::new(),
                },
                KeyValuePair {
                    enabled: false,
                    key: "disabled_param".to_string(),
                    value: "should_not_appear".to_string(),
                    description: String::new(),
                },
            ],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        })
        .await
        .unwrap();

        let body: serde_json::Value = serde_json::from_str(&response.body).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(body, serde_json::json!({"page": 2, "limit": 10}));
    }

    #[test]
    fn test_serde_proxy_config() {
        let json = r#"{
          "method": "GET",
          "url": "https://httpbin.org/get",
          "params": [],
          "headers": [],
          "body": {"type": "none", "content": ""},
          "auth": {"type": "none"},
          "proxy": {
            "enabled": true,
            "type": "http",
            "host": "127.0.0.1",
            "port": 8080,
            "auth": {"username": "user", "password": "pass"}
          },
          "tls": {
            "verifySsl": false
          }
        }"#;

        let args: SendRequestArgs = serde_json::from_str(json).unwrap();
        let proxy = args.proxy.unwrap();
        let proxy_auth = proxy.auth.unwrap();
        let tls = args.tls.unwrap();

        assert!(proxy.enabled);
        assert_eq!(proxy.proxy_type, "http");
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 8080);
        assert_eq!(proxy_auth.username, "user");
        assert_eq!(proxy_auth.password, "pass");
        assert!(!tls.verify_ssl);
    }

    #[test]
    fn test_serde_proxy_absent() {
        let json = r#"{
          "method": "GET",
          "url": "https://example.com",
          "params": [],
          "headers": [],
          "body": {"type": "none", "content": ""},
          "auth": {"type": "none"}
        }"#;

        let args: SendRequestArgs = serde_json::from_str(json).unwrap();
        assert!(args.proxy.is_none());
        assert!(args.tls.is_none());
    }

    #[test]
    fn test_serde_request_timings() {
        let response = HttpResponse {
            status: 200,
            status_text: "OK".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: "{}".to_string(),
            size: 2,
            time: 42,
            timings: RequestTimings {
                dns_lookup: 2,
                tcp_connect: 3,
                tls_handshake: 5,
                ttfb: 10,
                download: 32,
                total: 52,
            },
            content_type: "application/json".to_string(),
            body_kind: ResponseBodyKind::Text,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"timings\""));
        assert!(json.contains("\"ttfb\""));
        assert!(json.contains("\"download\""));
        assert!(json.contains("\"dnsLookup\""));
        assert!(json.contains("\"tcpConnect\""));
        assert!(json.contains("\"tlsHandshake\""));
    }

    #[test]
    fn test_serde_history_with_timings() {
        let entry = HistoryEntry {
            id: "history-with-timings".to_string(),
            method: "POST".to_string(),
            url: "https://example.com/items".to_string(),
            status: 201,
            time: 75,
            size: 256,
            timings: RequestTimings {
                dns_lookup: 5,
                tcp_connect: 10,
                tls_handshake: 10,
                ttfb: 25,
                download: 50,
                total: 100,
            },
            timestamp: "2026-03-27T12:00:00Z".to_string(),
            content_type: "application/json".to_string(),
            request_params: vec![KeyValuePair {
                enabled: true,
                key: "page".to_string(),
                value: "1".to_string(),
                description: String::new(),
            }],
            request_headers: vec![KeyValuePair {
                enabled: true,
                key: "X-Test".to_string(),
                value: "1".to_string(),
                description: String::new(),
            }],
            request_body_type: "json".to_string(),
            request_body_content: "{\"ok\":true}".to_string(),
            request_auth_type: "none".to_string(),
            request_auth: Some(AuthSave {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            }),
            request_body_form_data: vec![],
            request_body_binary_path: String::new(),
            request_body_binary_content: None,
            pre_request_script: "pm.environment.set('token', '123')".to_string(),
            test_script: "pm.test('ok', () => true)".to_string(),
            response_body: "{\"id\":1}".to_string(),
            response_headers: vec![("content-type".to_string(), "application/json".to_string())],
        };

        let json = serde_json::to_string(&entry).unwrap();
        let roundtrip: HistoryEntry = serde_json::from_str(&json).unwrap();

        assert_eq!(roundtrip.id, "history-with-timings");
        assert_eq!(roundtrip.timings.dns_lookup, 5);
        assert_eq!(roundtrip.timings.tcp_connect, 10);
        assert_eq!(roundtrip.timings.tls_handshake, 10);
        assert_eq!(roundtrip.timings.ttfb, 25);
        assert_eq!(roundtrip.timings.download, 50);
        assert_eq!(roundtrip.timings.total, 100);
        assert_eq!(roundtrip.request_body_type, "json");
        assert_eq!(roundtrip.response_body, "{\"id\":1}");
    }

    #[test]
    fn test_serde_history_without_timings() {
        let json = r#"{
          "id": "old-entry",
          "method": "GET",
          "url": "https://example.com",
          "status": 200,
          "time": 100,
          "size": 500,
          "timestamp": "2026-03-27T10:00:00Z",
          "contentType": "application/json"
        }"#;

        let entry: HistoryEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.id, "old-entry");
        assert_eq!(entry.timings.dns_lookup, 0);
        assert_eq!(entry.timings.tcp_connect, 0);
        assert_eq!(entry.timings.tls_handshake, 0);
        assert_eq!(entry.timings.ttfb, 0);
        assert_eq!(entry.timings.download, 0);
        assert_eq!(entry.timings.total, 0);
        assert!(entry.request_params.is_empty());
        assert!(entry.request_headers.is_empty());
        assert!(entry.request_body_type.is_empty());
        assert!(entry.request_body_content.is_empty());
        assert!(entry.request_auth_type.is_empty());
        assert!(entry.request_auth.is_none());
        assert!(entry.pre_request_script.is_empty());
        assert!(entry.test_script.is_empty());
        assert!(entry.response_body.is_empty());
        assert!(entry.response_headers.is_empty());
    }

    #[test]
    fn test_serde_saved_request_with_scripts() {
        let json = r#"{
          "name": "Test",
          "method": "POST",
          "url": "https://api.com",
          "params": [],
          "headers": [],
          "body": {"type": "json", "content": "{}"},
          "auth": {"type": "none"},
          "preRequestScript": "pm.environment.set('token', '123')",
          "testScript": "pm.test('ok', () => pm.expect(pm.response.status).to.equal(200))"
        }"#;

        let request: SavedRequest = serde_json::from_str(json).unwrap();
        assert_eq!(
            request.pre_request_script,
            "pm.environment.set('token', '123')"
        );
        assert_eq!(
            request.test_script,
            "pm.test('ok', () => pm.expect(pm.response.status).to.equal(200))"
        );
    }

    #[test]
    fn test_serde_saved_request_without_scripts() {
        let json = r#"{
          "name": "Old Request",
          "method": "GET",
          "url": "https://api.com",
          "params": [],
          "headers": [],
          "body": {"type": "none", "content": ""},
          "auth": {"type": "none"}
        }"#;

        let request: SavedRequest = serde_json::from_str(json).unwrap();
        assert!(request.pre_request_script.is_empty());
        assert!(request.test_script.is_empty());
    }

    #[test]
    fn test_move_request() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Move Test".to_string(), "".to_string()).unwrap();
        create_collection(
            "Move Test".to_string(),
            "source".to_string(),
            "".to_string(),
        )
        .unwrap();
        create_collection(
            "Move Test".to_string(),
            "target".to_string(),
            "".to_string(),
        )
        .unwrap();
        save_request(
            "Move Test".to_string(),
            "source".to_string(),
            sample_saved_request("My Req", "GET", "https://api.example.com/items"),
            None,
        )
        .unwrap();

        let tree = get_collection_tree("Move Test".to_string()).unwrap();
        let source = tree.iter().find(|node| node.name == "source").unwrap();
        assert_eq!(source.children.len(), 1);

        move_request(
            "Move Test".to_string(),
            "source/my-req.request.json".to_string(),
            "target".to_string(),
        )
        .unwrap();

        let tree = get_collection_tree("Move Test".to_string()).unwrap();
        let source = tree.iter().find(|node| node.name == "source").unwrap();
        let target = tree.iter().find(|node| node.name == "target").unwrap();
        assert_eq!(source.children.len(), 0);
        assert_eq!(target.children.len(), 1);

        let request = load_request(
            "Move Test".to_string(),
            "target/my-req.request.json".to_string(),
        )
        .unwrap();
        assert_eq!(request.name, "My Req");
    }

    #[test]
    fn test_rename_collection() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Rename Test".to_string(), "".to_string()).unwrap();
        create_collection(
            "Rename Test".to_string(),
            "old-name".to_string(),
            "".to_string(),
        )
        .unwrap();
        save_request(
            "Rename Test".to_string(),
            "old-name".to_string(),
            sample_saved_request("Req1", "GET", "https://api.example.com/req1"),
            None,
        )
        .unwrap();

        rename_collection(
            "Rename Test".to_string(),
            "old-name".to_string(),
            "new-name".to_string(),
        )
        .unwrap();

        let tree = get_collection_tree("Rename Test".to_string()).unwrap();
        assert!(tree.iter().any(|node| node.name == "new-name"));
        assert!(!temp_home
            .path()
            .join("ApiSolo/projects/rename-test/collections/old-name")
            .exists());
    }

    #[test]
    fn test_rename_request() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Rename Req".to_string(), "".to_string()).unwrap();
        create_collection("Rename Req".to_string(), "col".to_string(), "".to_string()).unwrap();
        save_request(
            "Rename Req".to_string(),
            "col".to_string(),
            sample_saved_request("Old Name", "GET", "https://api.example.com/items"),
            None,
        )
        .unwrap();

        rename_request(
            "Rename Req".to_string(),
            "col/old-name.request.json".to_string(),
            "New Name".to_string(),
        )
        .unwrap();

        let request = load_request(
            "Rename Req".to_string(),
            "col/new-name.request.json".to_string(),
        )
        .unwrap();
        assert_eq!(request.name, "New Name");
        assert!(load_request(
            "Rename Req".to_string(),
            "col/old-name.request.json".to_string(),
        )
        .is_err());
    }

    #[test]
    fn test_save_request_rejects_conflicting_slug() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Conflict Test".to_string(), "".to_string()).unwrap();
        create_collection(
            "Conflict Test".to_string(),
            "col".to_string(),
            "".to_string(),
        )
        .unwrap();

        save_request(
            "Conflict Test".to_string(),
            "col".to_string(),
            sample_saved_request("用户列表", "GET", "https://api.example.com/a"),
            None,
        )
        .unwrap();

        let result = save_request(
            "Conflict Test".to_string(),
            "col".to_string(),
            sample_saved_request("用户 列表", "GET", "https://api.example.com/b"),
            None,
        );

        assert!(result.is_ok());

        let duplicate = save_request(
            "Conflict Test".to_string(),
            "col".to_string(),
            sample_saved_request("用户列表", "POST", "https://api.example.com/c"),
            None,
        );

        assert!(duplicate.is_err());
    }

    #[test]
    fn test_save_request_allows_overwrite_of_existing_path() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Overwrite Test".to_string(), "".to_string()).unwrap();
        create_collection(
            "Overwrite Test".to_string(),
            "col".to_string(),
            "".to_string(),
        )
        .unwrap();

        save_request(
            "Overwrite Test".to_string(),
            "col".to_string(),
            sample_saved_request("Old Name", "GET", "https://api.example.com/a"),
            None,
        )
        .unwrap();

        save_request(
            "Overwrite Test".to_string(),
            "col".to_string(),
            sample_saved_request("Old Name", "POST", "https://api.example.com/b"),
            Some("col/old-name.request.json".to_string()),
        )
        .unwrap();

        let request = load_request(
            "Overwrite Test".to_string(),
            "col/old-name.request.json".to_string(),
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.example.com/b");
    }
    // ---------------------------------------------------------------------
    // D01 — history redaction slice
    // ---------------------------------------------------------------------

    const SHARED_SENSITIVE_KEYS: &str = include_str!("../../src/utils/__fixtures__/sensitive-keys.json");

    #[derive(Deserialize)]
    struct SharedSensitiveKeys {
        sensitive: Vec<String>,
        insensitive: Vec<String>,
    }

    #[test]
    fn test_is_sensitive_key_matches_shared_fixture() {
        let fixture: SharedSensitiveKeys = serde_json::from_str(SHARED_SENSITIVE_KEYS).unwrap();

        for key in &fixture.sensitive {
            assert!(is_sensitive_key(key), "expected {key} to be sensitive");
        }

        for key in &fixture.insensitive {
            assert!(!is_sensitive_key(key), "expected {key} to be insensitive");
        }
    }

    #[test]
    fn test_update_history_entries_preserves_unlisted_rows() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        append_history(sample_history_entry("keep-1", "2026-03-27T10:00:00Z")).unwrap();
        append_history(sample_history_entry("rewrite", "2026-03-27T10:01:00Z")).unwrap();
        append_history(sample_history_entry("keep-2", "2026-03-27T10:02:00Z")).unwrap();

        let mut updated = sample_history_entry("rewrite", "2026-03-27T10:01:00Z");
        updated.url = "https://api.example.com/sanitized".to_string();
        update_history_entries(vec![
            updated,
            sample_history_entry("not-on-disk", "2026-03-27T10:03:00Z"),
        ])
        .unwrap();

        let entries = read_history_entries().unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["keep-1", "rewrite", "keep-2"]);
        assert_eq!(entries[1].url, "https://api.example.com/sanitized");
        assert_eq!(entries[0].url, "http://example.com/api");
        assert_eq!(entries[2].url, "http://example.com/api");
    }

    #[test]
    fn test_read_saved_request_blanks_new_keys_without_touching_disk() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Legacy Keys".to_string(), String::new()).unwrap();
        let resolved = resolve_project("Legacy Keys").unwrap();
        let file_path = project_collections_dir(&resolved.dir).join("signed.request.json");

        // Written straight to disk so it keeps the plaintext a pre-upgrade
        // ApiSolo would have saved under the now-sensitive key names.
        let mut request = sample_saved_request("Signed", "GET", "https://api.example.com/signed");
        request.headers = vec![
            KeyValuePair {
                enabled: true,
                key: "X-Amz-Signature".to_string(),
                value: "abc123signature".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "aws-credential".to_string(),
                value: "AKIAEXAMPLE".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "Ocp-Apim-Subscription-Key".to_string(),
                value: "sub-key-1".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "X-Request-Id".to_string(),
                value: "req-1".to_string(),
                description: String::new(),
            },
        ];
        fs::write(&file_path, pretty_json(&request).unwrap()).unwrap();
        let before = fs::read(&file_path).unwrap();

        let loaded = load_request("Legacy Keys".to_string(), "signed.request.json".to_string()).unwrap();

        assert_eq!(loaded.headers[0].value, "");
        assert_eq!(loaded.headers[1].value, "");
        assert_eq!(loaded.headers[2].value, "");
        assert_eq!(loaded.headers[3].value, "req-1");
        assert_eq!(fs::read(&file_path).unwrap(), before);
        assert!(String::from_utf8(before).unwrap().contains("abc123signature"));
    }

    #[test]
    fn test_save_request_persists_blanked_new_keys() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Signed Save".to_string(), String::new()).unwrap();
        let mut request = sample_saved_request("Signed", "GET", "https://api.example.com/signed");
        request.headers = vec![
            KeyValuePair {
                enabled: true,
                key: "X-Amz-Signature".to_string(),
                value: "abc123signature".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "aws-credential".to_string(),
                value: "AKIAEXAMPLE".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "subscription-key".to_string(),
                value: "sub-key-1".to_string(),
                description: String::new(),
            },
            KeyValuePair {
                enabled: true,
                key: "X-Request-Id".to_string(),
                value: "req-1".to_string(),
                description: String::new(),
            },
        ];

        save_request("Signed Save".to_string(), String::new(), request, None).unwrap();

        let resolved = resolve_project("Signed Save").unwrap();
        let file_path = project_collections_dir(&resolved.dir).join("signed.request.json");
        let on_disk = fs::read_to_string(&file_path).unwrap();

        assert!(!on_disk.contains("abc123signature"));
        assert!(!on_disk.contains("AKIAEXAMPLE"));
        assert!(!on_disk.contains("sub-key-1"));
        assert!(on_disk.contains("req-1"));
    }

    // ---------------------------------------------------------------------
    // §30 — the history lock must be held before any file I/O
    //
    // The only lock killer is the `try_lock` verdict taken while the command is
    // parked inside its *first* I/O. Timeouts are used solely to detect a
    // command that never reaches I/O and never feed the lock verdict; the final
    // state assertions only prove the command semantics, not the lock position
    // (all four guard placements produce the same final state without a race).
    // ---------------------------------------------------------------------

    const LOCK_PROBE_LIVENESS: std::time::Duration = std::time::Duration::from_secs(5);

    #[derive(Debug, PartialEq, Eq)]
    enum LockVerdict {
        LockHeld,
        LockFree,
        NeverReachedIo,
        HarnessError,
    }

    #[derive(Clone, Copy)]
    enum HistoryCommand {
        Append,
        AppendThenPanic,
        Load,
        Clear,
        Delete,
        Update,
        /// Harness-only: reaches the I/O checkpoint without taking the lock, so
        /// the probe can observe a free-but-poisoned lock.
        UnlockedRead,
    }

    struct LockProbe {
        verdict: LockVerdict,
        note: Option<&'static str>,
        child_ok: bool,
        outcome: Option<String>,
        final_ids: Vec<String>,
    }

    /// Installed right after the checkpoint slot so that any early return or
    /// panic still releases the parked child and empties the global slot.
    struct CheckpointCleanup {
        resume: Option<std::sync::mpsc::Sender<()>>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for CheckpointCleanup {
        fn drop(&mut self) {
            if let Some(resume) = self.resume.take() {
                let _ = resume.send(());
            }

            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }

            *checkpoint_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            history_lock().clear_poison();
        }
    }

    fn seed_history(ids: &[&str]) {
        let entries: Vec<HistoryEntry> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| sample_history_entry(id, &format!("2026-03-27T10:0{index}:00Z")))
            .collect();
        write_history_entries(&entries).unwrap();
    }

    fn history_ids() -> Vec<String> {
        read_history_entries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    fn run_history_command(command: HistoryCommand, outcome: &Arc<StdMutex<Option<String>>>) {
        let record = |value: &str| {
            *outcome
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.to_string());
        };

        match command {
            HistoryCommand::Append | HistoryCommand::AppendThenPanic => {
                append_history(sample_history_entry("N", "2026-03-27T11:00:00Z")).unwrap();
                record("append completed");

                if matches!(command, HistoryCommand::AppendThenPanic) {
                    // The command has fully returned: the guard is dropped, the
                    // final state is [A, N] and the outcome is recorded. Only
                    // `child_ok` can catch this.
                    panic!("child panics AFTER the command completed");
                }
            }
            HistoryCommand::Load => {
                let entries = load_history().unwrap();
                let ids: Vec<String> = entries.into_iter().map(|entry| entry.id).collect();
                record(&format!("load returned {}", ids.join(",")));
            }
            HistoryCommand::Clear => {
                clear_history().unwrap();
                record("clear completed");
            }
            HistoryCommand::Delete => {
                delete_history_entry("A".to_string()).unwrap();
                record("delete completed");
            }
            HistoryCommand::UnlockedRead => {
                let entries = read_history_entries().unwrap();
                record(&format!("unlocked read returned {} entries", entries.len()));
            }
            HistoryCommand::Update => {
                let mut updated = sample_history_entry("A", "2026-03-27T10:00:00Z");
                updated.url = "https://api.example.com/updated".to_string();
                update_history_entries(vec![updated]).unwrap();
                record("update completed");
            }
        }
    }

    fn run_lock_probe(command: HistoryCommand, child_delay: std::time::Duration) -> LockProbe {
        let (notify_tx, notify_rx) = std::sync::mpsc::channel::<&'static str>();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel::<()>();

        *checkpoint_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(IoCheckpoint {
            notify: notify_tx,
            resume: resume_rx,
        });

        let mut cleanup = CheckpointCleanup {
            resume: Some(resume_tx),
            handle: None,
        };

        let outcome_slot: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let child_outcome = Arc::clone(&outcome_slot);
        cleanup.handle = Some(std::thread::spawn(move || {
            std::thread::sleep(child_delay);
            run_history_command(command, &child_outcome);
        }));

        // No assertion and no panic inside this window — the cleanup below has
        // to run before anything can fail.
        let (verdict, note) = match notify_rx.recv_timeout(LOCK_PROBE_LIVENESS) {
            Err(_) => (
                LockVerdict::NeverReachedIo,
                Some("command never reached file I/O"),
            ),
            Ok(_) => match history_lock().try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => (LockVerdict::LockHeld, None),
                Ok(guard) => {
                    drop(guard);
                    (LockVerdict::LockFree, None)
                }
                Err(std::sync::TryLockError::Poisoned(_)) => (
                    LockVerdict::HarnessError,
                    Some("history lock poisoned"),
                ),
            },
        };

        if let Some(resume) = cleanup.resume.take() {
            let _ = resume.send(());
        }

        let child_ok = match cleanup.handle.take() {
            Some(handle) => handle.join().is_ok(),
            None => true,
        };

        drop(cleanup);

        let outcome = outcome_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();

        LockProbe {
            verdict,
            note,
            child_ok,
            outcome,
            final_ids: history_ids(),
        }
    }

    fn assert_lock_probe(probe: &LockProbe, expected_outcome: &str, expected_final: &[&str]) {
        let mut failures: Vec<String> = Vec::new();

        if probe.verdict != LockVerdict::LockHeld {
            failures.push(match probe.note {
                Some(note) => format!("verdict={:?} ({note})", probe.verdict),
                None => format!("verdict={:?}", probe.verdict),
            });
        }

        if !probe.child_ok {
            failures.push("child panicked".to_string());
        }

        if probe.outcome.as_deref() != Some(expected_outcome) {
            failures.push(format!(
                "outcome={:?}, expected {expected_outcome:?}",
                probe.outcome
            ));
        }

        let final_ids: Vec<&str> = probe.final_ids.iter().map(String::as_str).collect();
        if final_ids != expected_final {
            failures.push(format!("final={final_ids:?}, expected {expected_final:?}"));
        }

        assert!(failures.is_empty(), "lock probe failed: {}", failures.join(" + "));
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_append() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A"]);

        let probe = run_lock_probe(HistoryCommand::Append, std::time::Duration::ZERO);
        assert_lock_probe(&probe, "append completed", &["A", "N"]);
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_append_with_a_delayed_child() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A"]);

        // 250ms is the offset that made an earlier, timeout-based design let
        // every wrong guard placement pass; the verdict must not depend on it.
        let probe = run_lock_probe(
            HistoryCommand::Append,
            std::time::Duration::from_millis(250),
        );
        assert_lock_probe(&probe, "append completed", &["A", "N"]);
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_load() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A"]);
        let before = fs::read(history_file_path().unwrap()).unwrap();

        let probe = run_lock_probe(HistoryCommand::Load, std::time::Duration::ZERO);
        assert_lock_probe(&probe, "load returned A", &["A"]);
        assert_eq!(fs::read(history_file_path().unwrap()).unwrap(), before);
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_clear() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A", "B"]);

        // `clear_history` never reads, so its first I/O is the write.
        let probe = run_lock_probe(HistoryCommand::Clear, std::time::Duration::ZERO);
        assert_lock_probe(&probe, "clear completed", &[]);
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_delete() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A", "B"]);

        let probe = run_lock_probe(HistoryCommand::Delete, std::time::Duration::ZERO);
        assert_lock_probe(&probe, "delete completed", &["B"]);
    }

    #[test]
    fn test_history_lock_held_at_first_io_in_update() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A", "B"]);

        let probe = run_lock_probe(HistoryCommand::Update, std::time::Duration::ZERO);
        assert_lock_probe(&probe, "update completed", &["A", "B"]);
        let entries = read_history_entries().unwrap();
        assert_eq!(entries[0].url, "https://api.example.com/updated");
        assert_eq!(entries[1].url, "http://example.com/api");
    }

    #[test]
    fn test_child_panic_after_completion_fails_the_test() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A"]);

        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let probe = run_lock_probe(HistoryCommand::AppendThenPanic, std::time::Duration::ZERO);
        let assert_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_lock_probe(&probe, "append completed", &["A", "N"]);
        }));
        std::panic::set_hook(previous_hook);

        // The other three signals are all correct, so `child_ok` is the only
        // assertion that can fail here. Deleting the `child_ok` branch from
        // `assert_lock_probe` turns this test RED — that is the evidence that
        // the assertion is load-bearing rather than decorative.
        assert_eq!(probe.verdict, LockVerdict::LockHeld);
        assert_eq!(probe.outcome.as_deref(), Some("append completed"));
        assert_eq!(probe.final_ids, vec!["A".to_string(), "N".to_string()]);
        assert!(!probe.child_ok);
        assert!(
            assert_result.is_err(),
            "assert_lock_probe must fail when the child panicked after completing"
        );

        // The lock must not stay poisoned for the next case.
        assert!(history_lock().try_lock().is_ok());
    }

    /// Poisons the history lock by letting a thread panic while holding it.
    fn poison_history_lock() {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let _ = std::thread::spawn(|| {
            let _guard = history_lock().lock().unwrap();
            panic!("poisoning the history lock on purpose");
        })
        .join();
        std::panic::set_hook(previous_hook);
    }

    #[test]
    fn test_poisoned_lock_is_reported_and_cleared_not_read_as_held() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        seed_history(&["A"]);

        poison_history_lock();
        assert!(
            history_lock().try_lock().is_err(),
            "precondition: the lock must be poisoned before the probe"
        );

        // The command does not take the lock, so at the checkpoint the lock is
        // free *and* poisoned — the one situation that reaches the poisoned
        // branch. Reporting it as LockHeld would silently turn a broken
        // environment into a passing lock assertion.
        let probe = run_lock_probe(HistoryCommand::UnlockedRead, std::time::Duration::ZERO);

        assert_eq!(probe.verdict, LockVerdict::HarnessError);
        assert_eq!(probe.note, Some("history lock poisoned"));
        assert!(probe.child_ok, "the probe must not panic on the poisoned path");
        assert_eq!(probe.outcome.as_deref(), Some("unlocked read returned 1 entries"));

        // Cleanup::drop calls clear_poison, so one panicking child cannot
        // contaminate every later case.
        assert!(
            history_lock().try_lock().is_ok(),
            "cleanup must clear the poison for the next case"
        );

        let next = run_lock_probe(HistoryCommand::Append, std::time::Duration::ZERO);
        assert_lock_probe(&next, "append completed", &["A", "N"]);
    }

    #[test]
    fn test_concurrent_append_and_update_keep_both_writes() {
        // Supplementary and non-deterministic: it passes with the lock and
        // very likely fails without it, but the deterministic kill comes from
        // the checkpoint probes above.
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        for round in 0..30 {
            seed_history(&["A"]);

            let barrier = Arc::new(std::sync::Barrier::new(2));
            let appender_barrier = Arc::clone(&barrier);
            let updater_barrier = Arc::clone(&barrier);

            let appender = std::thread::spawn(move || {
                appender_barrier.wait();
                append_history(sample_history_entry("N", "2026-03-27T11:00:00Z")).unwrap();
            });
            let updater = std::thread::spawn(move || {
                let mut updated = sample_history_entry("A", "2026-03-27T10:00:00Z");
                updated.url = "https://api.example.com/sanitized".to_string();
                updater_barrier.wait();
                update_history_entries(vec![updated]).unwrap();
            });

            appender.join().unwrap();
            updater.join().unwrap();

            let entries = read_history_entries().unwrap();
            let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
            assert_eq!(ids, vec!["A", "N"], "round {round}");
            assert_eq!(
                entries[0].url, "https://api.example.com/sanitized",
                "round {round}"
            );
        }
    }

    // ================= D02 — HTTP 报文正确性 =================
    //
    // Fixtures below are byte literals produced by EXTERNAL tools, never by the
    // crate under test - generating the expected value with the same code that
    // decodes it would prove nothing. Commands are recorded next to each one.
    //
    // PAYLOAD (80 bytes):
    //   {"repo":"tauri-apps/tauri","stars":12345,"描述":"跨平台桌面应用框架"}
    const D02_PAYLOAD: &str =
        "{\"repo\":\"tauri-apps/tauri\",\"stars\":12345,\"描述\":\"跨平台桌面应用框架\"}";

    // printf '%s' "$PAYLOAD" | gzip -n -c | xxd -i
    const D02_GZIP: &[u8] = &[
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xab, 0x56, 0x2a, 0x4a, 0x2d,
        0xc8, 0x57, 0xb2, 0x52, 0x2a, 0x49, 0x2c, 0x2d, 0xca, 0xd4, 0x4d, 0x2c, 0x28, 0x28, 0xd6,
        0x07, 0x33, 0x95, 0x74, 0x94, 0x8a, 0x4b, 0x12, 0x8b, 0x8a, 0x95, 0xac, 0x0c, 0x8d, 0x8c,
        0x4d, 0x4c, 0x75, 0x94, 0x9e, 0xf5, 0xf7, 0xbf, 0xd8, 0xbf, 0x01, 0xa8, 0xf2, 0xc5, 0xf6,
        0x15, 0x4f, 0x77, 0x6e, 0x7e, 0xda, 0xbf, 0xe1, 0xd9, 0xc2, 0x9e, 0x97, 0x73, 0x17, 0x3d,
        0xdd, 0x35, 0xe5, 0xf9, 0x94, 0x15, 0xcf, 0x16, 0xb6, 0x3d, 0x9b, 0xb7, 0x4d, 0xa9, 0x16,
        0x00, 0xe0, 0xc8, 0xfb, 0x23, 0x50, 0x00, 0x00, 0x00,
    ];

    // printf '%s' "$PAYLOAD" | brotli -c | xxd -i
    const D02_BROTLI: &[u8] = &[
        0x21, 0x3c, 0x01, 0x04, 0x7b, 0x22, 0x72, 0x65, 0x70, 0x6f, 0x22, 0x3a, 0x22, 0x74, 0x61,
        0x75, 0x72, 0x69, 0x2d, 0x61, 0x70, 0x70, 0x73, 0x2f, 0x74, 0x61, 0x75, 0x72, 0x69, 0x22,
        0x2c, 0x22, 0x73, 0x74, 0x61, 0x72, 0x73, 0x22, 0x3a, 0x31, 0x32, 0x33, 0x34, 0x35, 0x2c,
        0x22, 0xe6, 0x8f, 0x8f, 0xe8, 0xbf, 0xb0, 0x22, 0x3a, 0x22, 0xe8, 0xb7, 0xa8, 0xe5, 0xb9,
        0xb3, 0xe5, 0x8f, 0xb0, 0xe6, 0xa1, 0x8c, 0xe9, 0x9d, 0xa2, 0xe5, 0xba, 0x94, 0xe7, 0x94,
        0xa8, 0xe6, 0xa1, 0x86, 0xe6, 0x9e, 0xb6, 0x22, 0x7d, 0x03,
    ];

    // python3: zlib.compress(payload)  -> RFC 1950 zlib stream
    const D02_ZLIB: &[u8] = &[
        0x78, 0x9c, 0xab, 0x56, 0x2a, 0x4a, 0x2d, 0xc8, 0x57, 0xb2, 0x52, 0x2a, 0x49, 0x2c, 0x2d,
        0xca, 0xd4, 0x4d, 0x2c, 0x28, 0x28, 0xd6, 0x07, 0x33, 0x95, 0x74, 0x94, 0x8a, 0x4b, 0x12,
        0x8b, 0x8a, 0x95, 0xac, 0x0c, 0x8d, 0x8c, 0x4d, 0x4c, 0x75, 0x94, 0x9e, 0xf5, 0xf7, 0xbf,
        0xd8, 0xbf, 0x01, 0xa8, 0xf2, 0xc5, 0xf6, 0x15, 0x4f, 0x77, 0x6e, 0x7e, 0xda, 0xbf, 0xe1,
        0xd9, 0xc2, 0x9e, 0x97, 0x73, 0x17, 0x3d, 0xdd, 0x35, 0xe5, 0xf9, 0x94, 0x15, 0xcf, 0x16,
        0xb6, 0x3d, 0x9b, 0xb7, 0x4d, 0xa9, 0x16, 0x00, 0x20, 0x87, 0x26, 0x7e,
    ];

    // python3: zlib.compressobj(9, zlib.DEFLATED, -15) -> raw deflate, no header
    const D02_RAW_DEFLATE: &[u8] = &[
        0xab, 0x56, 0x2a, 0x4a, 0x2d, 0xc8, 0x57, 0xb2, 0x52, 0x2a, 0x49, 0x2c, 0x2d, 0xca, 0xd4,
        0x4d, 0x2c, 0x28, 0x28, 0xd6, 0x07, 0x33, 0x95, 0x74, 0x94, 0x8a, 0x4b, 0x12, 0x8b, 0x8a,
        0x95, 0xac, 0x0c, 0x8d, 0x8c, 0x4d, 0x4c, 0x75, 0x94, 0x9e, 0xf5, 0xf7, 0xbf, 0xd8, 0xbf,
        0x01, 0xa8, 0xf2, 0xc5, 0xf6, 0x15, 0x4f, 0x77, 0x6e, 0x7e, 0xda, 0xbf, 0xe1, 0xd9, 0xc2,
        0x9e, 0x97, 0x73, 0x17, 0x3d, 0xdd, 0x35, 0xe5, 0xf9, 0x94, 0x15, 0xcf, 0x16, 0xb6, 0x3d,
        0x9b, 0xb7, 0x4d, 0xa9, 0x16, 0x00,
    ];

    // python3: gzip.compress(b'a' * 1024) / gzip.compress(b'a' * 1025)
    const D02_GZIP_1024: &[u8] = &[
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0x4b, 0x4c, 0x1c, 0x05, 0xa3,
        0x60, 0x14, 0x8c, 0x54, 0x00, 0x00, 0xb9, 0x97, 0x55, 0x7c, 0x00, 0x04, 0x00, 0x00,
    ];
    const D02_GZIP_1025: &[u8] = &[
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0x4b, 0x4c, 0x1c, 0x05, 0xa3,
        0x60, 0x14, 0x8c, 0x58, 0x00, 0x00, 0xfc, 0xe0, 0x76, 0x5a, 0x01, 0x04, 0x00, 0x00,
    ];

    fn d02_args(method: &str, url: String) -> SendRequestArgs {
        SendRequestArgs {
            request_id: String::new(),
            method: method.to_string(),
            url,
            params: vec![],
            headers: vec![],
            body: RequestBodyInput {
                body_type: "none".to_string(),
                content: String::new(),
                form_data: vec![],
                binary_path: String::new(),
                binary_content: None,
            },
            auth: AuthInput {
                auth_type: "none".to_string(),
                basic: None,
                bearer: None,
                api_key: None,
            },
            proxy: None,
            tls: None,
        }
    }

    fn d02_header(key: &str, value: &str) -> KeyValuePair {
        KeyValuePair {
            enabled: true,
            key: key.to_string(),
            value: value.to_string(),
            description: String::new(),
        }
    }

    fn d02_encoding_headers(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(CONTENT_ENCODING, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    /// wiremock 0.5 splits stored header values on commas
    /// (`wiremock-0.5.22/src/request.rs:154`), so "exactly one header line"
    /// assertions are only sound for values containing no comma. Every value
    /// used below satisfies that.
    fn d02_header_values(request: &wiremock::Request, name: &str) -> Vec<String> {
        request
            .headers
            .iter()
            .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
            .map(|(_, values)| values.iter().map(|value| value.to_string()).collect())
            .unwrap_or_default()
    }

    async fn d02_serve(body: &'static [u8], headers: &[(&str, &str)]) -> wiremock::MockServer {
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let mut template = ResponseTemplate::new(200).set_body_bytes(body.to_vec());
        for (key, value) in headers {
            template = template.insert_header(*key, *value);
        }
        Mock::given(method("GET"))
            .respond_with(template)
            .mount(&server)
            .await;
        server
    }

    // ---------- §1-§7 解压 ----------

    #[tokio::test]
    async fn test_decompress_gzip_response_body() {
        let server = d02_serve(
            D02_GZIP,
            &[
                ("content-encoding", "gzip"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, D02_PAYLOAD);
    }

    #[tokio::test]
    async fn test_decompress_brotli_response_body() {
        let server = d02_serve(
            D02_BROTLI,
            &[
                ("content-encoding", "br"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, D02_PAYLOAD);
    }

    #[tokio::test]
    async fn test_decompress_deflate_zlib_response_body() {
        let server = d02_serve(
            D02_ZLIB,
            &[
                ("content-encoding", "deflate"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, D02_PAYLOAD);
    }

    #[test]
    fn test_decompress_raw_deflate_stream() {
        // Servers that emit bare RFC 1951 under `Content-Encoding: deflate` are
        // common enough that browsers accept them; the zlib decoder must fall
        // back rather than reject.
        let (bytes, decoded) = decompress_response_body(
            D02_RAW_DEFLATE.to_vec(),
            &ContentEncodingPlan::Decode(ContentEncoding::Deflate),
        )
        .unwrap();
        assert!(decoded);
        assert_eq!(String::from_utf8(bytes).unwrap(), D02_PAYLOAD);
    }

    #[test]
    fn test_content_encoding_token_case_and_whitespace() {
        assert_eq!(
            plan_content_encoding(&d02_encoding_headers(&[" GZIP "])),
            ContentEncodingPlan::Decode(ContentEncoding::Gzip)
        );
        assert_eq!(
            plan_content_encoding(&d02_encoding_headers(&["Br"])),
            ContentEncodingPlan::Decode(ContentEncoding::Brotli)
        );
    }

    #[test]
    fn test_content_encoding_x_gzip_alias() {
        assert_eq!(
            plan_content_encoding(&d02_encoding_headers(&["x-gzip"])),
            ContentEncodingPlan::Decode(ContentEncoding::Gzip)
        );
    }

    #[test]
    fn test_decompress_multi_member_gzip() {
        // Two gzip members concatenated - legal, and GzDecoder would stop after
        // the first one.
        let mut doubled = D02_GZIP.to_vec();
        doubled.extend_from_slice(D02_GZIP);
        let (bytes, decoded) = decompress_response_body(
            doubled,
            &ContentEncodingPlan::Decode(ContentEncoding::Gzip),
        )
        .unwrap();
        assert!(decoded);
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            format!("{D02_PAYLOAD}{D02_PAYLOAD}")
        );
    }

    // ---------- §8-§16 编码判定、上限、Accept-Encoding ----------

    #[tokio::test]
    async fn test_decoded_response_drops_encoding_headers() {
        let server = d02_serve(
            D02_GZIP,
            &[
                ("content-encoding", "gzip"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        let names = response
            .headers
            .iter()
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        // They describe the compressed bytes; keeping them next to decoded
        // content is the "UI must not lie" failure.
        assert!(!names.contains(&"content-encoding".to_string()), "{names:?}");
        assert!(!names.contains(&"content-length".to_string()), "{names:?}");
        assert!(names.contains(&"content-type".to_string()), "{names:?}");
    }

    #[test]
    fn test_plan_content_encoding_table() {
        let rows: Vec<(&str, HeaderMap, ContentEncodingPlan)> = vec![
            ("(1) 无头", HeaderMap::new(), ContentEncodingPlan::None),
            (
                "(2) identity",
                d02_encoding_headers(&["identity"]),
                ContentEncodingPlan::None,
            ),
            (
                "(3) 全空 token",
                d02_encoding_headers(&[" , , "]),
                ContentEncodingPlan::None,
            ),
            (
                "(4) identity, gzip",
                d02_encoding_headers(&["identity, gzip"]),
                ContentEncodingPlan::Decode(ContentEncoding::Gzip),
            ),
            (
                "(5) gzip, br",
                d02_encoding_headers(&["gzip, br"]),
                ContentEncodingPlan::Undecodable("gzip, br".to_string()),
            ),
            (
                "(6) 两行 gzip + br",
                d02_encoding_headers(&["gzip", "br"]),
                ContentEncodingPlan::Undecodable("gzip, br".to_string()),
            ),
            (
                "(7) gzip, gzip 不去重",
                d02_encoding_headers(&["gzip, gzip"]),
                ContentEncodingPlan::Undecodable("gzip, gzip".to_string()),
            ),
            (
                "(8) gzip;q=1.0",
                d02_encoding_headers(&["gzip;q=1.0"]),
                ContentEncodingPlan::Undecodable("gzip;q=1.0".to_string()),
            ),
            (
                "(9) zstd",
                d02_encoding_headers(&["zstd"]),
                ContentEncodingPlan::Undecodable("zstd".to_string()),
            ),
        ];
        let mut failures = vec![];
        for (label, headers, expected) in rows {
            let got = plan_content_encoding(&headers);
            if got != expected {
                failures.push(format!("{label}: expected {expected:?}, got {got:?}"));
            }
        }
        assert!(failures.is_empty(), "ROWS FAILED:\n{}", failures.join("\n"));
    }

    #[test]
    fn test_non_utf8_content_encoding_is_undecodable() {
        // A malformed field is malformed, not absent. Letting `to_str()` fail
        // into an empty string would turn it into "no encoding" and hand
        // undecoded bytes to the text path.
        let mut headers = HeaderMap::new();
        headers.append(
            CONTENT_ENCODING,
            HeaderValue::from_bytes(b"gzip,\x80").unwrap(),
        );
        assert_eq!(
            plan_content_encoding(&headers),
            ContentEncodingPlan::Undecodable("(unparsable)".to_string())
        );
    }

    #[tokio::test]
    async fn test_undecodable_encoding_is_kept_raw_and_marked_binary() {
        // Fixture is deliberately valid UTF-8 with no NUL, so both text guards
        // would pass it: only the forced-binary branch can make it binary.
        const PLAIN: &[u8] = b"this is valid utf-8 and contains no nul byte";
        let server = d02_serve(
            PLAIN,
            &[
                ("content-encoding", "zstd"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert!(
            response.body.contains("Compressed response not decoded"),
            "{}",
            response.body
        );
        assert!(response.body.contains("zstd"), "{}", response.body);
        let names = response
            .headers
            .iter()
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        assert!(names.contains(&"content-encoding".to_string()), "{names:?}");
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"bodyKind\":\"binary\""), "{json}");
    }

    #[tokio::test]
    async fn test_identity_or_absent_encoding_is_not_decompressed() {
        assert_eq!(
            plan_content_encoding(&d02_encoding_headers(&["identity"])),
            ContentEncodingPlan::None
        );
        const PLAIN: &[u8] = b"plain ascii body";
        let server = d02_serve(
            PLAIN,
            &[
                ("content-encoding", "identity"),
                ("content-type", "text/plain"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, "plain ascii body");
        // Nothing was decoded, so nothing may be stripped.
        let names = response
            .headers
            .iter()
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        assert!(names.contains(&"content-encoding".to_string()), "{names:?}");
        assert!(names.contains(&"content-length".to_string()), "{names:?}");
    }

    #[tokio::test]
    async fn test_corrupt_gzip_response_fails_with_named_encoding() {
        const NOT_GZIP: &[u8] = b"this is definitely not a gzip stream";
        let server = d02_serve(NOT_GZIP, &[("content-encoding", "gzip")]).await;
        let error = send_request(d02_args("GET", server.uri()))
            .await
            .unwrap_err();
        assert!(error.contains("gzip"), "{error}");
        assert!(error.contains("Failed to decode"), "{error}");
    }

    #[test]
    fn test_decompressed_body_at_the_limit_succeeds() {
        // The limit means "up to and including", not "at this point it is over".
        let (bytes, _) = decompress_response_body_with_limit(
            D02_GZIP_1024.to_vec(),
            &ContentEncodingPlan::Decode(ContentEncoding::Gzip),
            1024,
        )
        .unwrap();
        assert_eq!(bytes.len(), 1024);
    }

    #[test]
    fn test_decompressed_body_over_the_limit_is_rejected() {
        let error = decompress_response_body_with_limit(
            D02_GZIP_1025.to_vec(),
            &ContentEncodingPlan::Decode(ContentEncoding::Gzip),
            1024,
        )
        .unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert!(error.contains("1024"), "{error}");
    }

    #[tokio::test]
    async fn test_no_accept_encoding_header_is_added() {
        // The whole reason decompression is done by hand: enabling reqwest's
        // features would inject this header into requests the user never asked
        // to compress.
        let server = d02_serve(b"ok", &[]).await;
        send_request(d02_args("GET", server.uri())).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "accept-encoding"),
            Vec::<String>::new()
        );
    }

    // ---------- §17-§24 正文解码 ----------

    #[test]
    fn test_response_charset_is_honored() {
        // gb2312: 中=D6D0 文=CEC4 测=B2E2 试=CAD4; shift_jis: テ=8365 ス=8358
        // ト=8367; iso-8859-1: é=E9. Verifiable with `iconv`.
        let gb: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x61, 0x62, 0x63,
        ];
        let sjis: &[u8] = &[0x83, 0x65, 0x83, 0x58, 0x83, 0x67];
        let latin: &[u8] = &[0x63, 0x61, 0x66, 0xE9];
        let rows: Vec<(&[u8], &str, &str)> = vec![
            (gb, "text/html; charset=gb2312", "中文测试abc"),
            (gb, "text/html; charset=gbk", "中文测试abc"),
            (sjis, "text/plain; charset=shift_jis", "テスト"),
            (latin, "text/plain; charset=iso-8859-1", "café"),
        ];
        let mut failures = vec![];
        for (bytes, content_type, expected) in rows {
            let (body, kind) = decode_response_body(bytes, content_type);
            if body != expected || kind != ResponseBodyKind::Text {
                failures.push(format!(
                    "{content_type}: expected {expected:?}, got {body:?} {kind:?}"
                ));
            }
        }
        assert!(failures.is_empty(), "ROWS FAILED:\n{}", failures.join("\n"));
    }

    #[test]
    fn test_charset_parameter_parsing() {
        let rows = [
            ("text/html; CHARSET=GB2312", Some("gb2312")),
            ("text/html;charset=\"gb2312\"", Some("gb2312")),
            ("multipart/x; boundary=b; charset=gb2312", Some("gb2312")),
            ("text/html; charset=gb2312; foo=bar", Some("gb2312")),
            // Must not match as a substring.
            ("text/html; xcharset=gb2312", None),
            ("text/html", None),
        ];
        let mut failures = vec![];
        for (input, expected) in rows {
            let got = charset_from_content_type(input);
            if got.as_deref() != expected {
                failures.push(format!("{input}: expected {expected:?}, got {got:?}"));
            }
        }
        assert!(failures.is_empty(), "ROWS FAILED:\n{}", failures.join("\n"));
    }

    #[test]
    fn test_response_without_charset_decodes_as_utf8() {
        let (body, kind) = decode_response_body("héllo".as_bytes(), "text/plain");
        assert_eq!(body, "héllo");
        assert_eq!(kind, ResponseBodyKind::Text);
    }

    #[test]
    fn test_unrecognized_charset_label_falls_back_to_utf8() {
        let (body, kind) =
            decode_response_body("héllo".as_bytes(), "text/plain; charset=x-not-a-charset");
        assert_eq!(body, "héllo");
        assert_eq!(kind, ResponseBodyKind::Text);
    }

    #[test]
    fn test_undecodable_bytes_are_reported_as_binary() {
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let (body, kind) = decode_response_body(png, "image/png");
        assert_eq!(kind, ResponseBodyKind::Binary);
        assert!(body.starts_with("[ApiSolo] Binary response"), "{body}");
        assert!(body.contains("image/png"), "{body}");
        // The whole point: no lossy substitution anywhere.
        assert!(!body.contains('\u{FFFD}'), "{body}");
    }

    #[test]
    fn test_response_with_nul_byte_is_binary() {
        // Valid UTF-8, so the decode guard lets it through: only the NUL guard
        // can reject it.
        let (_, kind) = decode_response_body(b"ok\0ok", "text/plain");
        assert_eq!(kind, ResponseBodyKind::Binary);
    }

    #[tokio::test]
    async fn test_empty_response_body_is_empty_text() {
        let server = d02_serve(b"", &[("content-type", "text/plain")]).await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, "");
        assert_eq!(response.size, 0);
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"bodyKind\":\"text\""), "{json}");
    }

    #[tokio::test]
    async fn test_response_size_is_post_decompression_byte_count() {
        let server = d02_serve(
            D02_GZIP,
            &[
                ("content-encoding", "gzip"),
                ("content-type", "application/json"),
            ],
        )
        .await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.size as usize, D02_PAYLOAD.len());
        assert_ne!(response.size as usize, D02_GZIP.len());
    }

    // ---------- §25-§33 自动请求头与请求体保真 ----------

    #[tokio::test]
    async fn test_form_data_sends_single_content_type_with_real_boundary() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        // A stale boundary left over from a pasted cURL: for multipart only the
        // boundary we actually used can be right.
        args.headers = vec![d02_header(
            "Content-Type",
            "multipart/form-data; boundary=----WebKitFormBoundaryStale",
        )];
        args.body = RequestBodyInput {
            body_type: "form-data".to_string(),
            content: String::new(),
            form_data: vec![FormDataItem {
                enabled: true,
                key: "a".to_string(),
                value: "1".to_string(),
                description: String::new(),
                value_type: "text".to_string(),
                file_name: String::new(),
                file_path: String::new(),
                file_content: None,
                content_type: String::new(),
            }],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let values = d02_header_values(&received[0], "content-type");
        assert_eq!(values.len(), 1, "{values:?}");
        assert!(values[0].starts_with("multipart/form-data; boundary="));
        assert!(!values[0].contains("Stale"), "{values:?}");
        // The boundary announced must be the one the body actually uses.
        let boundary = values[0].split("boundary=").nth(1).unwrap();
        let body = String::from_utf8_lossy(&received[0].body);
        assert!(body.contains(boundary), "boundary {boundary} not in body");
    }

    #[tokio::test]
    async fn test_form_urlencoded_keeps_user_content_type() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        args.headers = vec![d02_header(
            "Content-Type",
            "application/x-www-form-urlencoded;charset=UTF-8",
        )];
        args.body = RequestBodyInput {
            body_type: "form-urlencoded".to_string(),
            content: "user=a&pass=b".to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let values = d02_header_values(&received[0], "content-type");
        assert_eq!(
            values,
            vec!["application/x-www-form-urlencoded;charset=UTF-8".to_string()]
        );
    }

    #[tokio::test]
    async fn test_json_body_keeps_user_content_type() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        args.headers = vec![d02_header("Content-Type", "application/vnd.api+json")];
        args.body = RequestBodyInput {
            body_type: "json".to_string(),
            content: "{\"a\":1}".to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "content-type"),
            vec!["application/vnd.api+json".to_string()]
        );
    }

    #[tokio::test]
    async fn test_raw_body_adds_no_content_type() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        args.body = RequestBodyInput {
            body_type: "raw".to_string(),
            content: "anything".to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "content-type"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn test_bearer_auth_replaces_manual_authorization_header() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        args.headers = vec![d02_header("Authorization", "Bearer stale-token")];
        args.auth = AuthInput {
            auth_type: "bearer".to_string(),
            basic: None,
            bearer: Some(BearerAuth {
                token: "fresh-token".to_string(),
            }),
            api_key: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        // Exactly one, and it is the panel's - a panel that silently does
        // nothing is the failure this fixes.
        assert_eq!(
            d02_header_values(&received[0], "authorization"),
            vec!["Bearer fresh-token".to_string()]
        );
    }

    #[tokio::test]
    async fn test_auth_none_keeps_every_manual_authorization_header() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        // Two rows on purpose: with one value an unconditional keep-last would
        // be an inert mutation and prove nothing.
        args.headers = vec![
            d02_header("Authorization", "Bearer aaa"),
            d02_header("Authorization", "Bearer bbb"),
        ];
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "authorization"),
            vec!["Bearer aaa".to_string(), "Bearer bbb".to_string()]
        );
    }

    #[tokio::test]
    async fn test_json_body_is_sent_verbatim() {
        let server = d02_serve(b"ok", &[]).await;
        // Indented, non-alphabetical, duplicate key, oversized integer: every
        // one of these is destroyed by a Value round-trip, and raw-body
        // signature schemes sign exactly these bytes.
        let body = "{\n  \"timestamp\": 1700000000,\n  \"nonce\": \"ab\",\n  \
                    \"amount\": \"1.00\",\n  \"a\": 1,\n  \"a\": 2,\n  \
                    \"id\": 123456789012345678901\n}";
        let mut args = d02_args("POST", server.uri());
        args.body = RequestBodyInput {
            body_type: "json".to_string(),
            content: body.to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(received[0].body, body.as_bytes());
    }

    #[tokio::test]
    async fn test_invalid_json_body_is_rejected_before_sending() {
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        args.body = RequestBodyInput {
            body_type: "json".to_string(),
            content: "{\"a\":".to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        let error = send_request(args).await.unwrap_err();
        assert!(error.contains("Invalid JSON body"), "{error}");
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    // ---------- §34-§35 失败诊断 ----------

    #[test]
    fn test_format_error_chain_joins_every_source() {
        #[derive(Debug)]
        struct Layer {
            message: &'static str,
            source: Option<Box<Layer>>,
        }
        impl std::fmt::Display for Layer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.message)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.source
                    .as_ref()
                    .map(|inner| inner.as_ref() as &(dyn std::error::Error + 'static))
            }
        }

        let chain = Layer {
            message: "outer",
            source: Some(Box::new(Layer {
                message: "middle",
                source: Some(Box::new(Layer {
                    message: "root cause",
                    source: None,
                })),
            })),
        };
        assert_eq!(
            format_error_chain("Request failed", &chain),
            "Request failed: outer: middle: root cause"
        );
    }

    #[tokio::test]
    async fn test_transport_error_includes_cause_chain() {
        // A port that is definitely closed: bind, read the port, drop.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let error = send_request(d02_args("GET", format!("http://127.0.0.1:{port}/")))
            .await
            .unwrap_err();
        assert!(
            error.starts_with("Request failed: error sending request for url ("),
            "{error}"
        );
        // Assert structurally, not on platform wording: something must follow
        // the Display form, which is exactly what the source walk adds.
        let tail = &error[error.find(')').unwrap()..];
        assert!(tail.contains(": "), "chain not walked: {error}");
    }

    #[tokio::test]
    async fn test_body_read_error_includes_cause_chain() {
        // Announce more body than we send, then hang up.
        //
        // The accept loop must keep running: the pre-connect timing probe opens
        // its own throwaway connection first, so a single-accept fixture would
        // serve the probe and then leave the real request with a closed port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort")
                        .await;
                    let _ = stream.shutdown().await;
                });
            }
        });

        let error = send_request(d02_args("GET", format!("http://{addr}/")))
            .await
            .unwrap_err();
        assert!(error.starts_with("Failed to read response body"), "{error}");
        let tail = &error["Failed to read response body".len()..];
        assert!(tail.matches(": ").count() >= 2, "chain not walked: {error}");
    }

    // ---------- §36-§45 预算、探测与耗时 ----------

    #[tokio::test]
    async fn test_probe_errors_are_swallowed() {
        // Structural note: `measure_connection_timings` returns a plain tuple,
        // so a probe failure has no channel to reach the caller through. This
        // pins the swallowing arm; the load-bearing guarantee is the type.
        let outcome =
            run_probe_within_budget(Duration::from_secs(5), async { Err("dns exploded".into()) })
                .await;
        assert_eq!(outcome, (0, 0));
    }

    #[test]
    fn test_connect_first_reachable_tries_every_address() {
        let addrs: Vec<SocketAddr> = vec![
            "127.0.0.1:1".parse().unwrap(),
            "127.0.0.1:2".parse().unwrap(),
        ];
        let hit = connect_first_reachable_with(&addrs, Duration::from_secs(5), |addr, _| {
            if addr.port() == 2 {
                Ok(())
            } else {
                Err(std::io::Error::other("refused"))
            }
        });
        assert_eq!(hit.map(|(index, _)| index), Some(1));
    }

    #[test]
    fn test_per_attempt_budget_is_shared_fairly() {
        assert_eq!(
            per_attempt_budget(Duration::from_secs(5), 2),
            Duration::from_millis(2500)
        );
        assert_eq!(
            per_attempt_budget(Duration::from_secs(5), 1),
            Duration::from_secs(5)
        );
        assert_eq!(per_attempt_budget(Duration::ZERO, 3), Duration::ZERO);
        assert_eq!(per_attempt_budget(Duration::from_secs(5), 0), Duration::ZERO);
    }

    #[test]
    fn test_connect_first_reachable_gives_each_address_a_share() {
        let addrs: Vec<SocketAddr> = vec![
            "127.0.0.1:1".parse().unwrap(),
            "127.0.0.1:2".parse().unwrap(),
        ];
        let mut seen: Vec<(u16, Duration)> = vec![];
        connect_first_reachable_with(&addrs, Duration::from_secs(5), |addr, budget| {
            seen.push((addr.port(), budget));
            Err(std::io::Error::other("refused"))
        });
        // A blackholed first address may only spend its own share.
        assert_eq!(seen[0].1, Duration::from_millis(2500), "{seen:?}");
        assert_eq!(seen.len(), 2, "second address never tried: {seen:?}");
    }

    #[test]
    fn test_connect_first_reachable_stops_when_budget_is_exhausted() {
        let addrs: Vec<SocketAddr> = vec![
            "127.0.0.1:1".parse().unwrap(),
            "127.0.0.1:2".parse().unwrap(),
        ];
        let hit = connect_first_reachable_with(&addrs, Duration::ZERO, |_, _| {
            panic!("budget exhausted; no connection may be attempted");
        });
        assert_eq!(hit, None);
    }

    #[tokio::test(start_paused = true)]
    async fn test_probe_budget_covers_the_whole_probe() {
        // Frozen clock: with real time a zero-duration timer races the inner
        // future and the inner future usually wins - measured 1000/1000.
        let probe = async {
            tokio::time::sleep(Duration::from_nanos(1)).await;
            Ok((7_u64, 9_u64))
        };
        assert_eq!(run_probe_within_budget(Duration::ZERO, probe).await, (0, 0));

        let probe = async {
            tokio::time::sleep(Duration::from_nanos(1)).await;
            Ok((7_u64, 9_u64))
        };
        assert_eq!(
            run_probe_within_budget(Duration::from_secs(5), probe).await,
            (7, 9)
        );
    }

    #[test]
    fn test_probe_budget_never_exceeds_the_overall_remaining() {
        let now = Instant::now();
        assert_eq!(
            probe_budget(now + Duration::from_secs(30), now),
            Duration::from_secs(5)
        );
        assert_eq!(
            probe_budget(now + Duration::from_secs(2), now),
            Duration::from_secs(2)
        );
        assert_eq!(probe_budget(now - Duration::from_secs(1), now), Duration::ZERO);
    }

    #[test]
    fn test_exhausted_budget_is_rejected() {
        let now = Instant::now();
        let error = ensure_budget_remaining(now, now, "sending the request").unwrap_err();
        assert!(error.contains("budget exhausted"), "{error}");
        assert_eq!(
            ensure_budget_remaining(now + Duration::from_secs(4), now, "sending the request")
                .unwrap(),
            Duration::from_secs(4)
        );
    }

    #[test]
    fn test_request_timeout_is_taken_from_the_remaining_budget() {
        let client = Client::builder().no_proxy().build().unwrap();
        let now = Instant::now();
        let built = finish_request_with_deadline(
            client.get("http://127.0.0.1:1/"),
            "none",
            "none",
            now + Duration::from_secs(23),
        )
        .unwrap();
        // Truncating to whole seconds keeps this off the wall clock: the
        // assertion is "it came from the deadline", not a duration measurement.
        assert_eq!(built.timeout().unwrap().as_secs(), 22);
    }

    #[tokio::test]
    async fn test_execute_request_with_zero_budget_sends_nothing() {
        // Wiring, not helper: deleting the pre-send checkpoint makes the
        // request go out and this turns red.
        let server = d02_serve(b"ok", &[]).await;
        let error = execute_request_with_budget(d02_args("GET", server.uri()), Duration::ZERO)
            .await
            .unwrap_err();
        assert!(error.contains("budget exhausted"), "{error}");
        assert!(
            server.received_requests().await.unwrap().is_empty(),
            "budget was exhausted; the request must never have been sent"
        );
    }

    #[tokio::test]
    async fn test_execute_request_honours_a_small_budget() {
        // Wiring: the per-request timeout must come from the budget. If it is
        // dropped or replaced by the 30s constant the delayed response arrives
        // and this returns Ok. Any budget-respecting path yields Err, so there
        // is no middle state; 500ms vs 5s is a 10x margin.
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_delay(Duration::from_secs(5)),
            )
            .mount(&server)
            .await;
        let outcome = execute_request_with_budget(
            d02_args("GET", server.uri()),
            Duration::from_millis(500),
        )
        .await;
        assert!(outcome.is_err(), "budget was ignored: {outcome:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn test_decode_over_budget_fails_at_the_deadline() {
        let decode = async {
            tokio::time::sleep(Duration::from_nanos(1)).await;
            Ok(DecodedResponseBody {
                size: 0,
                body: String::new(),
                body_kind: ResponseBodyKind::Text,
                dropped_encoding_headers: false,
            })
        };
        let error = run_decode_within_budget(Duration::ZERO, decode)
            .await
            .unwrap_err();
        assert!(error.contains("budget exhausted"), "{error}");

        let decode = async {
            tokio::time::sleep(Duration::from_nanos(1)).await;
            Ok(DecodedResponseBody {
                size: 7,
                body: "ok".to_string(),
                body_kind: ResponseBodyKind::Text,
                dropped_encoding_headers: false,
            })
        };
        assert_eq!(
            run_decode_within_budget(Duration::from_secs(5), decode)
                .await
                .unwrap()
                .size,
            7
        );
    }

    #[test]
    fn test_build_timings_uses_measured_total_not_the_sum() {
        let timings = build_timings(Duration::from_millis(500), 10, 20, 30);
        assert_eq!(timings.total, 500);
        assert!(timings.total >= timings.dns_lookup + timings.tcp_connect + timings.download);
    }

    #[test]
    fn test_build_timings_keeps_tls_and_ttfb_zero() {
        let timings = build_timings(Duration::from_millis(500), 10, 20, 30);
        assert_eq!(timings.tls_handshake, 0);
        assert_eq!(timings.ttfb, 0);
    }

    // ---------- §48-§49 请求目标与运行时 ----------

    #[tokio::test]
    async fn test_request_target_has_no_trailing_question_mark() {
        let server = d02_serve(b"ok", &[]).await;
        let base = server.uri();

        send_request(d02_args("GET", format!("{base}/v1/users")))
            .await
            .unwrap();
        let mut args = d02_args("GET", format!("{base}/v1/users"));
        args.params = vec![d02_header("a", "1")];
        send_request(args).await.unwrap();
        // A `?` the user typed themselves is theirs to keep.
        send_request(d02_args("GET", format!("{base}/v1/users?")))
            .await
            .unwrap();

        let received = server.received_requests().await.unwrap();
        assert_eq!(received[0].url.query(), None, "stray ? on the wire");
        assert_eq!(received[1].url.query(), Some("a=1"));
        assert_eq!(received[2].url.query(), Some(""));
    }

    #[test]
    fn test_finalize_response_body_is_runtime_independent() {
        // Plain #[test]: no async runtime. Proves the function can be called
        // off the executor, which is what makes the spawn_blocking call site
        // possible. NOTE: this does not prove the call site is wrapped - see
        // the verification gap register in TECH.md §4.3.
        let decoded = finalize_response_body(
            D02_PAYLOAD.as_bytes().to_vec(),
            ContentEncodingPlan::None,
            "application/json",
        )
        .unwrap();
        assert_eq!(decoded.body, D02_PAYLOAD);
        assert_eq!(decoded.body_kind, ResponseBodyKind::Text);
    }

}
