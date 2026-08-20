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
use std::collections::{BTreeMap, BTreeSet, HashMap};
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
///
/// `connect` is injectable so that the budget actually handed to each address
/// can be observed. That matters more than it looks: an earlier version took no
/// budget at all here and the address loop used the constant, which meant the
/// caller's budget was silently dropped and the fair-share guarantee only held
/// when the caller's budget happened to equal the constant.
fn probe_connection_with<C>(
    host: String,
    port: u16,
    budget: Duration,
    connect: C,
) -> Result<(u64, u64), String>
where
    C: FnMut(&SocketAddr, Duration) -> std::io::Result<()>,
{
    let addr = format!("{host}:{port}");
    let started_at = Instant::now();
    let addrs = addr
        .to_socket_addrs()
        .map(|iter| iter.collect::<Vec<_>>())
        .map_err(|error| format!("DNS resolve failed: {error}"))?;
    let dns_elapsed = started_at.elapsed();
    let dns_lookup = dns_elapsed.as_millis() as u64;

    if addrs.is_empty() {
        return Err("DNS resolve failed: no addresses found".to_string());
    }

    // Whatever DNS spent comes out of the same budget; the address loop only
    // gets what is left, and splits that fairly across the addresses.
    let remaining = budget.saturating_sub(dns_elapsed);

    // DNS really was measured, so report it even when no address answers;
    // the connect leg stays 0 because it was never successfully measured.
    let tcp_connect = connect_first_reachable_with(&addrs, remaining, connect)
        .map(|(_, elapsed)| elapsed)
        .unwrap_or(0);
    Ok((dns_lookup, tcp_connect))
}

fn probe_connection(host: String, port: u16, budget: Duration) -> Result<(u64, u64), String> {
    probe_connection_with(host, port, budget, |addr, budget| {
        std::net::TcpStream::connect_timeout(addr, budget).map(drop)
    })
}

/// Public entry point. Deliberately infallible: there is no error channel for a
/// probe failure to escape through, so no call site can let the probe decide
/// the fate of the request.
async fn measure_connection_timings(url: &Url, budget: Duration) -> (u64, u64) {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return (0, 0);
    };
    let host = host.to_string();

    let handle = tokio::task::spawn_blocking(move || probe_connection(host, port, budget));
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

const WS_HANDSHAKE_BUDGET_SECS: u64 = 30;
const WS_CLOSE_BUDGET_SECS: u64 = 5;
const WS_CANCELLED: &str = "WebSocket connection was cancelled";

type WsSender = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;

type WsReader = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// An established connection. `sender` is behind its own mutex so `ws_send` and
/// `close_ws_sender` can drop the *pool* lock before touching the network — a
/// stuck peer must not serialize every other connection's send/disconnect.
struct WsOpen {
    sender: Arc<TokioMutex<WsSender>>,
    reader: AbortHandle,
    /// Broadcasts "this connection is over". An in-flight `ws_send` uses it to
    /// abandon *both* the lock wait and the network send.
    cancel: tokio::sync::watch::Sender<bool>,
}

enum WsSlot {
    /// The cancel channel is created in `ws_prepare`, so a cancel arriving
    /// *during* the handshake has somewhere to land. Moving to `Open` hands the
    /// same sender over to `WsOpen`: one connection, one channel, start to end.
    Pending {
        cancel: tokio::sync::watch::Sender<bool>,
    },
    Open(WsOpen),
}

static WS_CONNECTIONS: OnceLock<Arc<TokioMutex<HashMap<String, WsSlot>>>> = OnceLock::new();
static WS_EVENT_QUEUES: OnceLock<Arc<TokioMutex<HashMap<String, Vec<WsEventPayload>>>>> =
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

fn ws_pool() -> Arc<TokioMutex<HashMap<String, WsSlot>>> {
    WS_CONNECTIONS
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

fn ws_event_queue_pool() -> Arc<TokioMutex<HashMap<String, Vec<WsEventPayload>>>> {
    WS_EVENT_QUEUES
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

fn active_request_pool() -> Arc<TokioMutex<HashMap<String, ActiveRequestState>>> {
    ACTIVE_REQUESTS
        .get_or_init(|| Arc::new(TokioMutex::new(HashMap::new())))
        .clone()
}

async fn publish_ws_event(app: Option<&tauri::AppHandle>, payload: WsEventPayload) {
    record_published_ws_event(&payload);

    if let Some(app) = app {
        let event_name = format!("ws-event-{}", payload.connection_id);
        let _ = app.emit(&event_name, payload.clone());
        return;
    }

    let pool = ws_event_queue_pool();
    let mut queues = pool.lock().await;
    // `get_mut`, never `entry().or_default()`: a queue is created by
    // `ws_connect_inner` before the handshake and removed by `ws_disconnect`.
    // Recreating it here would resurrect the queue of a connection nobody is
    // draining any more — the orphan-pool defect this slice exists to remove.
    let Some(queue) = queues.get_mut(&payload.connection_id) else {
        return;
    };
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

    // The history file is deliberately not pre-created. It used to be, guarded
    // by an exists() check, and that pairing was both a lost-update window and
    // the one write in the data directory that did not go through write_atomic:
    // a second caller could find the file missing, get descheduled while the
    // first appended real entries, and then truncate them with an empty write.
    // Nothing needs the file to exist - the reader treats "not there" as "no
    // history", and the first append creates it atomically.
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

// ---------------------------------------------------------------------------
// WebSocket test-only facilities.
//
// Same shape as `io_checkpoint` above, but the WS paths run inside an async
// context, so the rendezvous must use async channels: a blocking recv would
// deadlock the current-thread runtime a `#[tokio::test]` runs on.
// ---------------------------------------------------------------------------

#[cfg(not(test))]
#[inline(always)]
async fn ws_checkpoint(_tag: &'static str) {}

#[cfg(not(test))]
#[inline(always)]
fn record_published_ws_event(_payload: &WsEventPayload) {}

#[cfg(not(test))]
#[inline(always)]
fn ws_reader_alive_guard() {}

#[cfg(not(test))]
#[inline(always)]
fn ws_first_pending_signal(_tag: &'static str) {}

#[cfg(not(test))]
#[inline(always)]
fn ws_handshake_budget() -> Duration {
    Duration::from_secs(WS_HANDSHAKE_BUDGET_SECS)
}

#[cfg(not(test))]
#[inline(always)]
fn ws_close_budget() -> Duration {
    Duration::from_secs(WS_CLOSE_BUDGET_SECS)
}

/// Wraps a future and signals the first time it returns `Poll::Pending`.
///
/// The observation point has to be bound to a real state transition of the
/// awaited future, not to the moment we called it: "we invoked send" is not
/// "send is stuck", and "the task was spawned" is not "the task is running".
/// Two earlier designs keyed off our own actions and both admitted a false
/// green.
#[cfg(not(test))]
#[inline(always)]
async fn observing_first_pending<F: std::future::Future>(_tag: &'static str, fut: F) -> F::Output {
    fut.await
}

#[cfg(test)]
async fn ws_checkpoint(tag: &'static str) {
    tests::ws_support::ws_checkpoint(tag).await
}

#[cfg(test)]
fn record_published_ws_event(payload: &WsEventPayload) {
    tests::ws_support::record_published_ws_event(payload)
}

#[cfg(test)]
fn ws_reader_alive_guard() -> tests::ws_support::ReaderAliveGuard {
    tests::ws_support::ReaderAliveGuard::new()
}

#[cfg(test)]
fn ws_first_pending_signal(tag: &'static str) {
    tests::ws_support::first_pending_signal(tag)
}

#[cfg(test)]
fn ws_handshake_budget() -> Duration {
    tests::ws_support::handshake_budget()
}

#[cfg(test)]
fn ws_close_budget() -> Duration {
    tests::ws_support::close_budget()
}

#[cfg(test)]
async fn observing_first_pending<F: std::future::Future>(tag: &'static str, fut: F) -> F::Output {
    let mut fut = Box::pin(fut); // Box::pin sidesteps pin projection, no unsafe.
    let mut signalled = false;
    std::future::poll_fn(move |cx| match fut.as_mut().poll(cx) {
        std::task::Poll::Pending => {
            if !signalled {
                signalled = true;
                ws_first_pending_signal(tag);
            }
            std::task::Poll::Pending
        }
        ready => ready,
    })
    .await
}

/// Test-only rendezvous keyed by name, used by the lock tests to park a thread
/// inside a critical section — *after* the guard is taken and *before* the
/// first read — so the test thread can prove the lock was already held when the
/// snapshot was about to be read. Compiles away entirely outside `cfg(test)`:
/// an empty `#[inline(always)]` function emits no instructions, so this is a
/// test fixture rather than a concession in the shipped product.
#[cfg(not(test))]
#[inline(always)]
fn checkpoint(_name: &'static str) {}

#[cfg(test)]
fn checkpoint(name: &'static str) {
    tests::checkpoints::hit(name)
}

#[cfg(test)]
fn atomic_temp_paths() -> &'static StdMutex<Vec<PathBuf>> {
    static PATHS: OnceLock<StdMutex<Vec<PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(|| StdMutex::new(Vec::new()))
}

/// Records every temporary file `write_atomic` actually created. Asserting on
/// the final file cannot show how many temp files existed — one file can only
/// ever show one name — so the concurrency test reads this log instead.
#[cfg(test)]
fn record_atomic_temp_path(path: &Path) {
    atomic_temp_paths()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(path.to_path_buf());
}

/// Writes `contents` to `path` by filling a uniquely named temporary file in
/// the same directory and renaming it over the target. A reader therefore sees
/// either the complete old contents or the complete new ones, never the
/// truncation window that `fs::write` leaves open.
///
/// The temp name carries a uuid deliberately. A deterministic name lets two
/// concurrent writers open the *same* inode and interleave their bytes, which
/// is how an earlier draft produced `BBBBAAAA` in a target file. The cost of
/// uniqueness is that a crash leaves the temp file behind instead of having it
/// reused by the next write; those leftovers are inert (no scanner recognises
/// them) and documented as user-removable.
///
/// Not promised: power-cut durability. The parent-directory sync below is best
/// effort, so after a power cut the old contents may come back — but the file
/// is never left corrupt.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Failed to write {}: no parent directory", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Failed to write {}: invalid file name", path.display()))?;

    // Leading dot + `.tmp` extension keeps these out of the collection tree
    // (which filters on `extension == "json"`) and the environment list (which
    // filters on `.env.json` / `.env.secrets.json` suffixes).
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
    {
        Ok(file) => file,
        Err(error) => {
            return Err(format!(
                "Failed to create temporary file for {}: {error}",
                path.display()
            ))
        }
    };

    #[cfg(test)]
    record_atomic_temp_path(&temp_path);
    checkpoint("atomic_temp_created");

    let mut write_result = file.write_all(contents);
    if write_result.is_ok() {
        write_result = file.sync_all();
    }
    drop(file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "Failed to write temporary file for {}: {error}",
            path.display()
        ));
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Failed to replace {}: {error}", path.display()));
    }

    if let Ok(dir) = fs::File::open(parent) {
        if let Err(error) = dir.sync_all() {
            eprintln!("Failed to sync directory {}: {error}", parent.display());
        }
    }

    Ok(())
}

/// A parsed history file plus the raw bytes of every line that could not be
/// parsed. Corrupt lines are carried as bytes, not text: a line can be invalid
/// UTF-8, and the whole point of quarantine is that nothing is altered.
#[derive(Default)]
struct HistoryFile {
    entries: Vec<HistoryEntry>,
    corrupt_lines: Vec<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryHealth {
    skipped_lines: usize,
    quarantined_lines: usize,
}

fn history_quarantine_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join("history.corrupt.jsonl"))
}

/// Appends raw corrupt lines to the quarantine file and flushes them to disk.
/// A failure here must abort the caller's write: dropping a bad line from
/// history.jsonl when its quarantined copy never landed is silent data loss.
fn quarantine_history_lines(lines: &[Vec<u8>]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }

    let path = history_quarantine_path()?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|error| format!("Failed to open history quarantine file: {error}"))?;

    for line in lines {
        // The only byte we add is the separating newline; CRLF endings and
        // invalid UTF-8 go to disk exactly as they were read.
        file.write_all(line)
            .map_err(|error| format!("Failed to write history quarantine file: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Failed to write history quarantine file: {error}"))?;
    }

    file.sync_all()
        .map_err(|error| format!("Failed to flush history quarantine file: {error}"))
}

fn read_history_entries() -> Result<HistoryFile, String> {
    io_checkpoint("read");
    let history_path = history_file_path()?;
    let file = match fs::File::open(&history_path) {
        Ok(file) => file,
        // No file is not an error, it is an empty history. Reporting it as a
        // failure is what forced the data directory to pre-create the file,
        // and that pre-creation was itself a truncating write.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryFile::default())
        }
        Err(error) => return Err(format!("Failed to open history file: {error}")),
    };
    let mut reader = BufReader::new(file);
    let mut history = HistoryFile::default();

    loop {
        // read_until, not lines(): `lines()` fails the entire read on the first
        // byte sequence that is not UTF-8, which is how one torn line used to
        // brick the whole history panel.
        let mut raw = Vec::new();
        let read = reader
            .read_until(b'\n', &mut raw)
            .map_err(|error| format!("Failed to read history file: {error}"))?;
        if read == 0 {
            break;
        }
        if raw.last() == Some(&b'\n') {
            raw.pop();
        }

        // Blank lines were never data, so they are not corruption either.
        if raw.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        let Ok(text) = std::str::from_utf8(&raw) else {
            history.corrupt_lines.push(raw);
            continue;
        };

        match serde_json::from_str::<HistoryEntry>(text) {
            Ok(entry) => history.entries.push(entry),
            Err(_) => {
                history.corrupt_lines.push(raw);
                continue;
            }
        }
    }

    Ok(history)
}

fn write_history_entries(
    entries: &[HistoryEntry],
    corrupt_lines: &[Vec<u8>],
) -> Result<(), String> {
    io_checkpoint("write");

    // Order matters and is not interchangeable: rewriting first would leave a
    // state where the bad line is gone from history.jsonl and was never
    // persisted anywhere else.
    quarantine_history_lines(corrupt_lines)?;

    let history_path = history_file_path()?;

    let mut buffer = Vec::new();
    for entry in entries {
        let line = serde_json::to_string(entry)
            .map_err(|error| format!("Failed to serialize history entry: {error}"))?;
        buffer.extend_from_slice(line.as_bytes());
        buffer.push(b'\n');
    }

    write_atomic(&history_path, &buffer)
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
    write_atomic(
        &project_dir.join(PROJECT_META_FILE),
        pretty_json(meta)?.as_bytes(),
    )
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

/// Escapes a vault-key component so the three-part key stays unambiguously
/// splittable: afterwards ':' only ever occurs as "\\:" and '\\' only as
/// "\\\\". The third component is base64url, which contains neither.
fn escape_vault_component(value: &str) -> String {
    value.replace('\\', "\\\\").replace(':', "\\:")
}

/// `project : environment-slug : base64url(variable name)`.
///
/// The previous scheme replaced every non-ASCII-alphanumeric character with
/// '_', which collapsed 生产 and 测试 to the same "__". Two visibly separate
/// environments then shared one vault slot: saving one overwrote the other's
/// credential, and deleting one deleted both. Names now survive verbatim, and
/// slugifying here removes the old three-way disagreement between the save,
/// load and delete paths over which spelling of the name to hash.
fn vault_key_for(project_dir: &Path, env_name: &str, variable_key: &str) -> String {
    let project = project_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("project");
    let encoded_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(variable_key);

    format!(
        "{}:{}:{}",
        escape_vault_component(project),
        escape_vault_component(&slugify(env_name)),
        encoded_key
    )
}

/// The pre-D03 key shape. Kept for one purpose only — finding an existing
/// entry so it can be copied forward. Nothing writes with it.
fn legacy_vault_key_for(project_dir: &Path, env_name: &str, variable_key: &str) -> String {
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
    write_atomic(&path, pretty_json(config)?.as_bytes())
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

    write_atomic(
        &local_secret_vault_path()?,
        pretty_json(&vault_file)?.as_bytes(),
    )
    .map_err(|error| format!("Failed to save local secret vault: {error}"))
}

/// Serialises the local vault's read-decrypt-modify-encrypt-write cycle.
///
/// Atomic file replacement is not enough on its own: it stops half a file from
/// reaching disk, but two savers that each read the same old snapshot will
/// still have the later one erase the earlier one's entry. Every function that
/// takes this lock takes it as its very first statement, before any read.
///
/// Never nested with VAULT_MAINTENANCE_TX or D01's history lock.
fn local_vault_tx() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

fn lock_local_vault_tx() -> MutexGuard<'static, ()> {
    local_vault_tx()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
fn vault_creations() -> &'static StdMutex<Vec<Vec<u8>>> {
    static CREATIONS: OnceLock<StdMutex<Vec<Vec<u8>>>> = OnceLock::new();
    CREATIONS.get_or_init(|| StdMutex::new(Vec::new()))
}

/// Records every vault that was actually created. Asserting that the finished
/// file holds one salt proves nothing — a file can only ever show one salt.
/// Counting creations is what distinguishes "created once" from "created,
/// then silently recreated over the top".
#[cfg(test)]
fn record_vault_creation(salt: &[u8]) {
    vault_creations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(salt.to_vec());
}

/// Everything after the empty-password check, lifted verbatim so the guard can
/// be the first statement. The decision of whether the vault exists has to sit
/// inside the critical section: two callers that both read `None` outside it
/// would both generate a fresh salt, and the later one would overwrite the
/// vault the earlier one had just created and stored secrets in — with a salt
/// that cannot decrypt them.
fn unlock_local_secret_vault_locked(master_password: &str) -> Result<(), String> {
    let _guard = lock_local_vault_tx();
    checkpoint("vault_unlock_enter");
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
            #[cfg(test)]
            record_vault_creation(&salt);
            secret_vault_session()
                .lock()
                .map_err(|error| format!("Failed to lock secret vault session: {error}"))?
                .local_key = Some(key);
        }
    }

    Ok(())
}

fn unlock_local_secret_storage(master_password: &str) -> Result<(), String> {
    if master_password.is_empty() {
        return Err("Local secret vault master password is required".to_string());
    }

    unlock_local_secret_vault_locked(master_password)
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
fn system_secret_vault_failure() -> &'static StdMutex<bool> {
    static FAILING: OnceLock<StdMutex<bool>> = OnceLock::new();
    FAILING.get_or_init(|| StdMutex::new(false))
}

/// Makes the keychain stub refuse deletions, so a backend that genuinely says
/// no can be driven through the real production entry point instead of being
/// simulated by making the whole scratch directory unwritable — which would
/// also block the maintenance file and hide the very mutant under test.
#[cfg(test)]
fn set_system_secret_vault_failure(enabled: bool) {
    *system_secret_vault_failure()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = enabled;
}

#[cfg(test)]
fn delete_system_secret_value(vault_key: &str) -> Result<(), String> {
    if *system_secret_vault_failure()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
    {
        return Err("Failed to delete secret from system vault: injected".to_string());
    }

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

/// The LocalEncrypted branch of `save_secret_value`, lifted verbatim so the
/// transaction guard can be the first statement of the function. The dispatch
/// stays outside on purpose: LOCAL_VAULT_TX is a global lock, and holding it
/// across the keychain path would serialise every keychain write and could
/// cover a system authorisation prompt.
fn save_local_secret_value(vault_key: &str, value: &str) -> Result<(), String> {
    let _guard = lock_local_vault_tx();
    checkpoint("vault_rmw_enter");
    let Some((mut values, salt)) = load_local_secret_map()? else {
        return Err("Local secret vault is missing. Reconfigure secret storage.".to_string());
    };
    let key = current_local_secret_key()?;
    values.insert(vault_key.to_string(), value.to_string());
    write_local_secret_map(&values, &key, &salt)
}

fn delete_local_secret_value(vault_key: &str) -> Result<(), String> {
    let _guard = lock_local_vault_tx();
    checkpoint("vault_rmw_enter");
    let Some((mut values, salt)) = load_local_secret_map()? else {
        return Ok(());
    };
    let key = current_local_secret_key()?;
    values.remove(vault_key);
    write_local_secret_map(&values, &key, &salt)
}

fn save_secret_value(vault_key: &str, value: &str) -> Result<(), String> {
    match require_secret_storage_backend()? {
        SecretStorageBackend::LocalEncrypted => save_local_secret_value(vault_key, value),
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
        SecretStorageBackend::LocalEncrypted => delete_local_secret_value(vault_key),
        SecretStorageBackend::SystemKeychain => delete_system_secret_value(vault_key),
    }
}


// ---------------------------------------------------------------------------
// Vault maintenance: collision evidence and the deferred cleanup queue.
//
// One sidecar file, one reader, one lock, one read-modify-write. It holds
// identifiers and failure classifications only — never a secret value, and
// never a backend's raw error string.

const MAINTENANCE_VERSION: u8 = 1;

fn maintenance_version() -> u8 {
    MAINTENANCE_VERSION
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentRef {
    /// Project directory name.
    project: String,
    /// Environment file stem.
    environment: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretKeyCollision {
    legacy_vault_key: String,
    variable_key: String,
    environments: Vec<EnvironmentRef>,
    detected_at: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum PruneFailureKind {
    IndexUnreadable,
    IndexIncomplete,
    BackendDelete,
}

/// Exactly two fields, and that is a load-bearing property: a raw backend
/// error can carry paths or key material, so there is nowhere here to put one.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PruneFailure {
    at: String,
    kind: PruneFailureKind,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceSnapshot {
    #[serde(default = "maintenance_version")]
    version: u8,
    #[serde(default)]
    collisions: Vec<SecretKeyCollision>,
    #[serde(default)]
    pending_prune: Vec<String>,
    #[serde(default)]
    last_failure: Option<PruneFailure>,
}

impl Default for MaintenanceSnapshot {
    fn default() -> Self {
        Self {
            version: MAINTENANCE_VERSION,
            collisions: Vec::new(),
            pending_prune: Vec::new(),
            last_failure: None,
        }
    }
}

/// Guards a vault key's whole lifetime, which is the unit neither of the two
/// locks below can express.
///
/// Writing a secret and publishing the metadata that names it are two separate
/// writes, and so are scanning for references and deleting what nothing names.
/// Each individual write is already safe; the damage comes from interleaving
/// the two *pairs*. A key still queued from an interrupted round and typed in
/// again by the user gets its new value deleted in the gap before the metadata
/// naming it reaches disk, and the environment then points at an empty slot
/// permanently - the exact data loss this slice exists to stop, re-entering
/// through the cleanup that was supposed to prevent it.
///
/// Lock order: this one is outermost. Whoever holds it may go on to take the
/// maintenance lock or the vault lock; nothing takes this one while holding
/// either. Cleanup being maintenance rather than something the user asked for,
/// the cost of waiting here is a deferred deletion, never a blocked save.
fn vault_key_lifecycle_tx() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

fn lock_vault_key_lifecycle_tx() -> MutexGuard<'static, ()> {
    vault_key_lifecycle_tx()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Guards the maintenance file's read-merge-write cycle. Atomic replacement
/// alone is not enough: two loads that each discover a different collision
/// would read the same old snapshot and each write back only their own, and
/// once migration completes the lost evidence cannot be reconstructed.
///
/// Never held at the same time as LOCAL_VAULT_TX. Cleanup runs as: hold this,
/// read the queue, release, delete through the vault lock, re-acquire this to
/// record what finished.
fn vault_maintenance_tx() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

fn lock_vault_maintenance_tx() -> MutexGuard<'static, ()> {
    vault_maintenance_tx()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn vault_maintenance_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("scratch").join("vault-maintenance.json"))
}

fn read_maintenance_snapshot() -> Result<MaintenanceSnapshot, String> {
    let path = vault_maintenance_path()?;
    if !path.exists() {
        return Ok(MaintenanceSnapshot::default());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read vault maintenance file: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse vault maintenance file: {error}"))
}

/// Fails the collision record on demand, and nothing else.
///
/// The obvious injection - make the scratch directory unwritable - cannot test
/// what it looks like it tests here. Recording the collision and queueing the
/// cleanup write the *same* maintenance file, so an unwritable directory fails
/// both, and a version that drops the record's error simply fails one line
/// later with the same outcome: same error, same untouched vault, same
/// unflipped pointer. Nothing distinguishes them. The spec wrote that warning
/// down for a different test and then used the unwritable directory here
/// anyway.
#[cfg(not(test))]
#[inline(always)]
fn injected_collision_record_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn collision_record_failure() -> &'static StdMutex<bool> {
    static FAILURE: OnceLock<StdMutex<bool>> = OnceLock::new();
    FAILURE.get_or_init(|| StdMutex::new(false))
}

#[cfg(test)]
fn set_collision_record_failure(enabled: bool) {
    *collision_record_failure()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = enabled;
}

#[cfg(test)]
fn injected_collision_record_failure() -> Result<(), String> {
    if *collision_record_failure()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
    {
        return Err("Failed to record vault key collisions: injected".to_string());
    }
    Ok(())
}

fn write_maintenance_snapshot(snapshot: &MaintenanceSnapshot) -> Result<(), String> {
    write_atomic(
        &vault_maintenance_path()?,
        pretty_json(snapshot)?.as_bytes(),
    )
}

/// Recovers the variable name from a vault key's third segment. Legacy keys
/// sanitise their first two segments down to `[A-Za-z0-9_-]`, so the last ':'
/// always separates the base64 name.
fn variable_key_from_vault_key(vault_key: &str) -> String {
    let Some((_, encoded)) = vault_key.rsplit_once(':') else {
        return String::new();
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn record_vault_key_collisions(
    candidates: &[String],
    index: &VaultKeyIndex,
) -> Result<(), String> {
    let _guard = lock_vault_maintenance_tx();
    checkpoint("maintenance_enter");
    injected_collision_record_failure()?;
    let mut snapshot = read_maintenance_snapshot()?;

    let mut changed = false;
    for candidate in candidates {
        let Some(references) = index.refs.get(candidate) else {
            continue;
        };

        let mut distinct: Vec<EnvironmentRef> = Vec::new();
        for reference in references {
            if !distinct.contains(reference) {
                distinct.push(reference.clone());
            }
        }
        if distinct.len() < 2 {
            continue;
        }
        if snapshot
            .collisions
            .iter()
            .any(|collision| &collision.legacy_vault_key == candidate)
        {
            continue;
        }

        snapshot.collisions.push(SecretKeyCollision {
            legacy_vault_key: candidate.clone(),
            variable_key: variable_key_from_vault_key(candidate),
            environments: distinct,
            detected_at: now_iso(),
        });
        changed = true;
    }

    if !changed {
        return Ok(());
    }

    write_maintenance_snapshot(&snapshot)
}

fn enqueue_pending_prune(keys: &[String]) -> Result<(), String> {
    let _guard = lock_vault_maintenance_tx();
    checkpoint("maintenance_enter");
    let mut snapshot = read_maintenance_snapshot()?;

    let mut changed = false;
    for key in keys {
        if !snapshot.pending_prune.contains(key) {
            snapshot.pending_prune.push(key.clone());
            changed = true;
        }
    }

    if !changed {
        return Ok(());
    }

    write_maintenance_snapshot(&snapshot)
}

/// Read-only on purpose. An earlier design took the queue out of the file and
/// wrote it back shortened; a crash between that and the actual deletion lost
/// the cleanup intent permanently — the very defect this queue exists to fix.
/// The queue only ever shrinks in `resolve_pending_prune`, for keys already
/// confirmed done.
fn read_pending_prune() -> Result<Vec<String>, String> {
    let _guard = lock_vault_maintenance_tx();
    checkpoint("maintenance_enter");
    let snapshot = read_maintenance_snapshot()?;
    Ok(snapshot.pending_prune)
}

fn resolve_pending_prune(done: &[String]) -> Result<(), String> {
    let _guard = lock_vault_maintenance_tx();
    checkpoint("maintenance_enter");
    let mut snapshot = read_maintenance_snapshot()?;

    let before = snapshot.pending_prune.len();
    snapshot.pending_prune.retain(|key| !done.contains(key));
    if snapshot.pending_prune.len() == before {
        return Ok(());
    }

    write_maintenance_snapshot(&snapshot)
}

/// Records that a cleanup round did not finish. Not a checker target: it never
/// branches on what it read, so there is no read-before-lock surface here.
fn note_pending_prune_failure(kind: PruneFailureKind) -> Result<(), String> {
    let _guard = lock_vault_maintenance_tx();
    let mut snapshot = read_maintenance_snapshot()?;
    snapshot.last_failure = Some(PruneFailure {
        at: now_iso(),
        kind,
    });
    write_maintenance_snapshot(&snapshot)
}

struct VaultKeyIndex {
    refs: BTreeMap<String, Vec<EnvironmentRef>>,
    /// False when any environment's metadata could not be read, or when some
    /// row still has no key written down. An incomplete index may not be used
    /// to conclude that anything is unreferenced.
    complete: bool,
}

/// Scans every environment's secret metadata for the vault keys still in use.
fn index_referenced_vault_keys() -> Result<VaultKeyIndex, String> {
    let mut index = VaultKeyIndex {
        refs: BTreeMap::new(),
        complete: true,
    };

    let projects = projects_dir()?;
    let Ok(project_entries) = fs::read_dir(&projects) else {
        index.complete = false;
        return Ok(index);
    };

    for project_entry in project_entries {
        let Ok(project_entry) = project_entry else {
            index.complete = false;
            continue;
        };
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let Some(project_name) = project_dir
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
        else {
            index.complete = false;
            continue;
        };

        let env_dir = project_environments_dir(&project_dir);
        if !env_dir.exists() {
            continue;
        }
        let Ok(env_entries) = fs::read_dir(&env_dir) else {
            index.complete = false;
            continue;
        };

        for env_entry in env_entries {
            let Ok(env_entry) = env_entry else {
                index.complete = false;
                continue;
            };
            let path = env_entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(stem) = file_name.strip_suffix(".env.secrets.json") else {
                continue;
            };

            let reference = EnvironmentRef {
                project: project_name.clone(),
                environment: stem.to_string(),
            };

            let Ok(variables) = read_env_variables(&path, true) else {
                index.complete = false;
                continue;
            };

            for variable in variables {
                let recorded = variable.vault_key.trim();
                if !recorded.is_empty() {
                    index
                        .refs
                        .entry(recorded.to_string())
                        .or_default()
                        .push(reference.clone());
                    continue;
                }

                // Old-format row with no key written down. The read path
                // derives one, so the reference is implicit but real. The
                // derivation is only a guess — the legacy key was built from
                // whatever spelling of the name was passed in at the time, and
                // disk only kept the slug — so the whole round is downgraded
                // rather than risk deleting a key that is still in use.
                index.complete = false;
                for derived in [
                    vault_key_for(&project_dir, stem, &variable.key),
                    legacy_vault_key_for(&project_dir, stem, &variable.key),
                ] {
                    index
                        .refs
                        .entry(derived)
                        .or_default()
                        .push(reference.clone());
                }
            }
        }
    }

    Ok(index)
}

/// Deletes vault entries nothing references any more, returning only the keys
/// confirmed finished. The caller removes exactly those from the queue — a
/// plain `Result<(), String>` could not say which, and an incomplete index
/// would then look like "pruned everything" and drop the whole queue.
fn prune_orphan_vault_keys(
    candidates: &[String],
    index: &VaultKeyIndex,
) -> Result<Vec<String>, String> {
    // Kept deliberately, and it is not dead code even though nothing reaches
    // it today. The only caller checks index.complete before it dispatches
    // here, so this branch is unreachable through that path - measured, not
    // assumed: flipping this condition alone changes no observable behaviour
    // and survives the whole suite. What the outer check cannot do is bind a
    // caller that does not exist yet, and the cost of getting this wrong is
    // deleting a live credential because one unrelated file happened to be
    // unreadable. Deleting this line only looks safe while there is exactly
    // one caller.
    if !index.complete {
        return Ok(Vec::new());
    }

    let mut done = Vec::new();
    for candidate in candidates {
        if index.refs.contains_key(candidate) {
            continue;
        }

        // Already gone counts as finished; that is what makes a retry after a
        // partial round idempotent.
        if load_secret_value(candidate)?.is_empty() {
            done.push(candidate.clone());
            continue;
        }

        // One failure aborts the round and nothing is reported done, so the
        // whole batch stays queued. Erring towards one more retry is always
        // safer than erring towards deleting a live credential.
        delete_secret_value(candidate)?;
        done.push(candidate.clone());
    }

    Ok(done)
}

/// The single rule shared by collision detection and orphan cleanup.
///
/// A recorded key is what the previous version actually wrote on disk; a
/// derived one is a guess. When a recorded key exists the guess is dropped,
/// because it can coincide with a key another environment is genuinely using —
/// and acting on that guess copies someone else's credential into this
/// environment, or deletes theirs.
fn legacy_vault_key_candidates(
    project_dir: &Path,
    env_name: &str,
    variable: &EnvVariable,
) -> Vec<String> {
    let target = vault_key_for(project_dir, env_name, &variable.key);
    let recorded = variable.vault_key.trim();

    if !recorded.is_empty() {
        if recorded == target {
            return Vec::new();
        }
        return vec![recorded.to_string()];
    }

    let derived = legacy_vault_key_for(project_dir, env_name, &variable.key);
    if derived == target {
        return Vec::new();
    }
    vec![derived]
}

/// Runs the deferred cleanup queue and records failures without blocking the
/// user. Cleanup is maintenance, not part of what the user asked for: refusing
/// to open an environment because a stale prune never finished points exactly
/// the wrong way. Failures are still never swallowed — they leave a dated,
/// classified marker on disk.
///
/// Callers must already hold the lifecycle lock. There is deliberately no
/// wrapper that takes it here: every entry point that reaches cleanup - load,
/// save, delete - now holds the lock from before it reads the metadata, so a
/// self-locking variant would only be reachable by deadlocking against a guard
/// the caller already owns.
fn retry_pending_prune_locked(pending: &[String]) {
    if pending.is_empty() {
        return;
    }

    let outcome = match index_referenced_vault_keys() {
        Err(_) => Err(PruneFailureKind::IndexUnreadable),
        Ok(index) if !index.complete => Err(PruneFailureKind::IndexIncomplete),
        Ok(index) => prune_orphan_vault_keys(pending, &index)
            .map_err(|_| PruneFailureKind::BackendDelete),
    };

    match outcome {
        Ok(done) => {
            // A failure here writes to the very file it would report to, so
            // there is nowhere to record it but the log.
            if resolve_pending_prune(&done).is_err() {
                eprintln!(
                    "[vault-maintenance] resolve failed kind=resolve-write pending={}",
                    pending.len()
                );
            }
        }
        Err(kind) => {
            // Fixed classification only. Backend error strings can carry paths
            // or key material, and the log is the same boundary as the file.
            eprintln!(
                "[vault-maintenance] deferred cleanup failed kind={kind:?} pending={}",
                pending.len()
            );
            if note_pending_prune_failure(kind).is_err() {
                eprintln!("[vault-maintenance] failure marker not persisted kind={kind:?}");
            }
        }
    }
}

#[tauri::command]
fn get_secret_key_collisions() -> Result<Vec<SecretKeyCollision>, String> {
    Ok(read_maintenance_snapshot()?.collisions)
}

/// Clears one collision record. Nothing else does — not completing the
/// migration, not restarting, not loading the environment again. The user has
/// to be told which credential to re-enter, and the record is what tells them.
#[tauri::command]
fn acknowledge_secret_key_collision(legacy_vault_key: String) -> Result<(), String> {
    let _guard = lock_vault_maintenance_tx();
    checkpoint("maintenance_enter");
    let mut snapshot = read_maintenance_snapshot()?;
    snapshot
        .collisions
        .retain(|collision| collision.legacy_vault_key != legacy_vault_key);
    write_maintenance_snapshot(&snapshot)
}

/// Callers must already hold the lifecycle lock, and must have taken it
/// *before* reading the `variables` passed in here.
///
/// Taking it inside this function was not enough, and the reason is worth
/// keeping: the migration rewrites the metadata file from the list it was
/// handed, so the read that produced that list is part of the critical section
/// even though it happens in the caller. A save landing in the gap between the
/// read and the lock is not merely raced - the rewrite erases whatever it
/// added, and the save has already reported success.
fn resolve_secret_variables_locked(
    project_dir: &Path,
    env_name: &str,
    variables: Vec<EnvVariable>,
    secrets_path: &Path,
) -> Result<Vec<EnvVariable>, String> {
    // Step 0: pick up cleanup a previous run could not finish. Failures here
    // never block the load.
    retry_pending_prune_locked(&read_pending_prune()?);

    let mut candidates: Vec<String> = Vec::new();
    for variable in &variables {
        for candidate in legacy_vault_key_candidates(project_dir, env_name, variable) {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }

    // Step 1: evidence before migration, and this one *does* block. Once the
    // pointers flip, nothing on disk shows that two environments ever shared a
    // slot — better to refuse to open than to erase the only proof.
    if !candidates.is_empty() {
        let index_before = index_referenced_vault_keys()?;
        record_vault_key_collisions(&candidates, &index_before)?;
        enqueue_pending_prune(&candidates)?;
    }

    let mut changed = false;
    let mut resolved = Vec::with_capacity(variables.len());

    for mut variable in variables {
        variable.secret = true;
        let target = vault_key_for(project_dir, env_name, &variable.key);
        let recorded = variable.vault_key.trim().to_string();

        if !variable.value.is_empty() {
            // Plaintext left in the metadata file by an old version.
            save_secret_value(&target, &variable.value)?;
            changed = true;
        } else if load_secret_value(&target)?.is_empty() {
            // Copy forward only into an empty slot: that keeps the migration
            // idempotent and stops it overwriting something the user has since
            // typed in.
            for candidate in legacy_vault_key_candidates(project_dir, env_name, &variable) {
                let legacy_value = load_secret_value(&candidate)?;
                if legacy_value.is_empty() {
                    continue;
                }
                save_secret_value(&target, &legacy_value)?;
                changed = true;
                break;
            }
        }

        if recorded != target {
            changed = true;
        }

        variable.value = load_secret_value(&target)?;
        variable.vault_key = target;
        resolved.push(variable);
    }

    if changed {
        // Step 3: the pointer flips here, and only then is the old key
        // genuinely unreferenced. The queue was written before the flip, so an
        // interrupted cleanup is retried on the next load rather than lost.
        write_secret_metadata(secrets_path, &resolved)?;
        retry_pending_prune_locked(&candidates);
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

    write_atomic(file_path, pretty_json(&metadata)?.as_bytes())
        .map_err(|error| format!("Failed to save environment secret metadata: {error}"))
}

/// Renames a file we could not parse, keeping its bytes byte-for-byte. The
/// alternative — carrying on and overwriting it — destroys the only record of
/// which vault entries the environment owned.
fn quarantine_unreadable_file(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot quarantine {}: no parent directory", path.display()))?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Cannot quarantine {}: invalid file name", path.display()))?;

    let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();

    // The timestamp only resolves to a second, and rename replaces whatever is
    // already there. Two files quarantined inside the same second would leave
    // the first one destroyed - and this file exists precisely because it is
    // the only surviving record of which vault entries an environment owned.
    // So the name is reserved with create_new first: whoever wins the
    // reservation owns that name, and the loser moves to the next suffix
    // instead of overwriting.
    for attempt in 0..1000 {
        let target = if attempt == 0 {
            parent.join(format!("{stem}.corrupt-{timestamp}.json"))
        } else {
            parent.join(format!("{stem}.corrupt-{timestamp}-{attempt}.json"))
        };

        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(_) => {
                // Renaming over our own placeholder is the point: the name is
                // ours from here on.
                fs::rename(path, &target).map_err(|error| {
                    format!("Failed to quarantine unreadable file: {error}")
                })?;
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("Failed to quarantine unreadable file: {error}"))
            }
        }
    }

    Err(format!(
        "Failed to quarantine {}: too many quarantined copies in the same second",
        path.display()
    ))
}

fn read_previous_secret_metadata(path: &Path) -> Result<Vec<EnvVariable>, String> {
    match read_env_variables(path, true) {
        Ok(variables) => Ok(variables),
        Err(_) => {
            quarantine_unreadable_file(path)?;
            Ok(Vec::new())
        }
    }
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
        // One foreign or half-written .json used to fail the whole tree, so a
        // project with dozens of intact requests showed an empty sidebar. The
        // file is left alone on disk; it simply is not a request.
        let saved_request = match read_saved_request(&entry_path) {
            Ok(request) => request,
            Err(error) => {
                eprintln!(
                    "Skipping unreadable saved request {}: {error}",
                    entry_path.display()
                );
                continue;
            }
        };
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

    write_atomic(&file_path, pretty_json(&request)?.as_bytes())
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

    write_atomic(&target_file, pretty_json(&request)?.as_bytes())
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
    write_atomic(&target_file, &contents)
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
    // Ahead of the reads below, not inside the migration they feed. Loading is
    // a read-modify-write of the metadata file: what it rewrites is decided
    // from the snapshot read here, so the snapshot is part of the critical
    // section. A save that lands between the read and the rewrite loses every
    // variable it added, and reports success while doing it.
    let _guard = lock_vault_key_lifecycle_tx();
    let resolved = resolve_project(&project)?;
    let normal_path = environment_file_path(&resolved.dir, &name, false)?;
    let secrets_path = environment_file_path(&resolved.dir, &name, true)?;
    let env_name = slugify(&name);

    // Both reads hoisted out of the call below, in their original order. As
    // arguments they were evaluated before the callee could take any lock, so
    // the metadata snapshot this load goes on to rewrite was read outside it.
    let normal_variables = read_env_variables(&normal_path, false)?;
    let secret_metadata = read_env_variables(&secrets_path, true)?;
    checkpoint("environment_metadata_read");

    let variables = merge_environment_variables(
        normal_variables,
        resolve_secret_variables_locked(&resolved.dir, &env_name, secret_metadata, &secrets_path)?,
    );

    Ok(Environment {
        name: env_name,
        variables,
    })
}

/// `create` is the caller's statement of intent: true means "this name has
/// never been saved before". Guessing it here is what let a typo silently
/// overwrite an existing environment. Absent means the old behaviour, so a
/// rollback of the frontend cannot break this.
#[tauri::command]
fn save_environment(project: String, env: Environment, create: Option<bool>) -> Result<(), String> {
    // Outermost statement, and deliberately ahead of the validation below: from
    // here to the metadata write at the end, this call owns the lifetime of
    // every vault key it touches. Quarantining the old metadata is inside that
    // span too - while the file is renamed aside, the keys it named look
    // unreferenced to a scan, which is a second way into the same deletion.
    let _guard = lock_vault_key_lifecycle_tx();
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

    // First statement that touches disk state, deliberately. STAGING and
    // staging normalise to one file, and creating the second used to overwrite
    // the first and orphan its secrets. The guard sits ahead of every read,
    // rename and write so a rejection leaves the directory byte-identical -
    // including not quarantining a metadata file that happens to be corrupt.
    if create.unwrap_or(false) && (normal_path.exists() || secrets_path.exists()) {
        let existing = normal_path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.strip_suffix(".env"))
            .unwrap_or(name)
            .to_string();
        return Err(format!("Environment already exists: {existing}"));
    }

    let previous = read_previous_secret_metadata(&secrets_path)?;

    let mut normal_variables = Vec::new();
    let mut secret_variables = Vec::new();

    for variable in env.variables {
        if variable.key.trim().is_empty() {
            continue;
        }

        if variable.secret {
            // Always recomputed. The frontend never round-trips a vault key,
            // and trusting one it did send would reintroduce the three-way
            // disagreement over which spelling addresses a secret.
            let vault_key = vault_key_for(&resolved.dir, name, &variable.key);

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

    // Keys this environment used to own and no longer lists: a deleted secret
    // row, a renamed one, or one demoted to a plain variable. Their values
    // stayed in the vault forever, invisible and unreachable from the UI.
    let mut removed: Vec<String> = Vec::new();
    for variable in &previous {
        let recorded = variable.vault_key.trim();
        if recorded.is_empty() {
            continue;
        }
        if secret_variables
            .iter()
            .any(|kept| kept.vault_key == recorded)
        {
            continue;
        }
        if !removed.contains(&recorded.to_string()) {
            removed.push(recorded.to_string());
        }
    }

    if !removed.is_empty() {
        let index_before = index_referenced_vault_keys()?;
        record_vault_key_collisions(&removed, &index_before)?;
        enqueue_pending_prune(&removed)?;
    }

    // Between the backend writes above and the metadata below, a value exists
    // that nothing on disk names yet. That is the window the cleanup thread
    // must not be allowed into.
    checkpoint("secret_values_written");

    write_atomic(&normal_path, pretty_json(&normal_variables)?.as_bytes())
        .map_err(|error| format!("Failed to save environment: {error}"))?;
    // The pointer flips here; only now are the removed keys truly unreferenced.
    write_secret_metadata(&secrets_path, &secret_variables)?;

    retry_pending_prune_locked(&removed);
    touch_project(&resolved.dir)
}

#[tauri::command]
fn delete_environment(project: String, name: String) -> Result<(), String> {
    // The third entry into the same window, and the one the review did not
    // name: this reads the metadata to learn which vault entries the
    // environment owned, then removes the files. Unlocked, a save landing in
    // between makes the key list stale - the secret it added is never queued
    // and stays in the vault with nothing naming it - and a save landing after
    // the files are gone republishes them, bringing a deleted environment back
    // into the list.
    let _guard = lock_vault_key_lifecycle_tx();
    let resolved = resolve_project(&project)?;

    // Ahead of the "does not exist" early return on purpose. A previous call
    // may have removed the files and then failed to finish cleanup; this is the
    // one entry point a user will trigger again, so if it bailed out early the
    // queue would never find another taker.
    retry_pending_prune_locked(&read_pending_prune()?);

    let normal_path = environment_file_path(&resolved.dir, &name, false)?;
    let secrets_path = environment_file_path(&resolved.dir, &name, true)?;
    let normal_exists = normal_path.exists();
    let secrets_exists = secrets_path.exists();

    // An unreadable metadata file is quarantined rather than deleted, matching
    // what saving does. Deleting it was the worst of the three options this
    // slice uses: loading fails loudly because a half-shown environment is what
    // makes users overwrite it, saving renames the file aside because its bytes
    // are the only record of which vault entries the environment owned - and
    // deleting threw those bytes away while the entries they name stayed in the
    // vault, unreachable and undeletable. That is the defect this slice exists
    // to fix, reappearing at the one entry point that destroys the evidence.
    // It also made the recovery instructions in both READMEs false.
    let mut candidates: Vec<String> = Vec::new();
    let mut quarantined_metadata: Option<PathBuf> = None;
    if secrets_exists {
        let previous = match read_env_variables(&secrets_path, true) {
            Ok(variables) => variables,
            Err(_) => {
                quarantined_metadata = Some(quarantine_unreadable_file(&secrets_path)?);
                Vec::new()
            }
        };

        for variable in previous {
            let recorded = variable.vault_key.trim();
            let owned = if recorded.is_empty() {
                vault_key_for(&resolved.dir, &name, &variable.key)
            } else {
                recorded.to_string()
            };
            if !candidates.contains(&owned) {
                candidates.push(owned);
            }
            for candidate in legacy_vault_key_candidates(&resolved.dir, &name, &variable) {
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
    }

    // Queue before deleting the files, not after. The old order deleted vault
    // entries first, so a crash in the middle left the environment on disk with
    // its secrets already gone.
    if !candidates.is_empty() {
        enqueue_pending_prune(&candidates)?;
    }

    if normal_exists {
        fs::remove_file(&normal_path)
            .map_err(|error| format!("Failed to delete environment: {error}"))?;
    }
    // Quarantining already moved the file off this path, and the environment is
    // gone from the list either way because the renamed file no longer matches
    // the .env.secrets.json suffix. The user's delete is honoured; the bytes
    // survive for whoever has to work out what was in the vault.
    if secrets_exists && quarantined_metadata.is_none() {
        fs::remove_file(&secrets_path)
            .map_err(|error| format!("Failed to delete environment secrets: {error}"))?;
    }
    if !normal_exists && !secrets_exists {
        return Err("Environment does not exist".to_string());
    }

    // Prune only now: an entry another environment still names is kept, which
    // is what stops deleting 测试 from taking 生产's token with it.
    retry_pending_prune_locked(&candidates);
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

    let mut file = read_history_entries()?;
    file.entries.push(entry);

    if file.entries.len() > MAX_HISTORY_ENTRIES {
        let overflow = file.entries.len() - MAX_HISTORY_ENTRIES;
        file.entries.drain(0..overflow);
    }

    write_history_entries(&file.entries, &file.corrupt_lines)
}

#[tauri::command]
fn load_history() -> Result<Vec<HistoryEntry>, String> {
    let _guard = lock_history();
    let mut file = read_history_entries()?;
    if !file.corrupt_lines.is_empty() {
        eprintln!(
            "[history] skipped {} unreadable line(s)",
            file.corrupt_lines.len()
        );
    }
    file.entries
        .sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    Ok(file.entries)
}

#[tauri::command]
fn clear_history() -> Result<(), String> {
    let _guard = lock_history();
    write_history_entries(&[], &[])?;

    // An explicit clear means no residue. Quarantined lines can hold
    // credentials that older versions wrote in plaintext.
    let quarantine_path = history_quarantine_path()?;
    match fs::remove_file(&quarantine_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete history quarantine file: {error}"
        )),
    }
}

#[tauri::command]
fn delete_history_entry(id: String) -> Result<(), String> {
    let _guard = lock_history();
    let mut file = read_history_entries()?;
    file.entries.retain(|entry| entry.id != id);
    write_history_entries(&file.entries, &file.corrupt_lines)
}

/// Replaces history rows by id. Rows the caller did not list are kept as they
/// are on disk — the lock stops concurrent lost updates, merge-by-id stops a
/// stale snapshot from erasing rows the caller never saw. No redaction happens
/// here: Rust stays a dumb pipe for history.
#[tauri::command]
fn update_history_entries(entries: Vec<HistoryEntry>) -> Result<(), String> {
    let _guard = lock_history();
    let mut file = read_history_entries()?;

    for update in entries.iter() {
        if let Some(existing) = file.entries.iter_mut().find(|entry| entry.id == update.id) {
            *existing = update.clone();
        }
    }

    // Passing &[] here would silently drop quarantine-bound lines that may
    // carry plaintext credentials.
    write_history_entries(&file.entries, &file.corrupt_lines)
}

/// Counts what the last read had to skip and what is sitting in quarantine, so
/// the history panel can say so and re-enable its clear button. A new command
/// rather than a wider `load_history`: the button's disabled condition lives in
/// the panel, so the UI has to change either way.
#[tauri::command]
fn get_history_health() -> Result<HistoryHealth, String> {
    let _guard = lock_history();
    let file = read_history_entries()?;

    let quarantine_path = history_quarantine_path()?;
    let quarantined_lines = match fs::read(&quarantine_path) {
        Ok(bytes) => bytes.iter().filter(|byte| **byte == b'\n').count(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(format!("Failed to read history quarantine file: {error}"))
        }
    };

    Ok(HistoryHealth {
        skipped_lines: file.corrupt_lines.len(),
        quarantined_lines,
    })
}

/// Allocates the connection id and parks a `Pending` slot in the pool. Zero
/// I/O — the whole point is that the frontend can register its event listener
/// against a *known* id before any handshake starts. Tauri has no event replay,
/// so "listener first" has to be a happens-before relationship, not a race the
/// frontend usually wins.
#[tauri::command]
async fn ws_prepare() -> Result<String, String> {
    let connection_id = Uuid::new_v4().to_string();
    let (cancel, _) = tokio::sync::watch::channel(false);
    ws_pool()
        .lock()
        .await
        .insert(connection_id.clone(), WsSlot::Pending { cancel });
    Ok(connection_id)
}

/// Removes a slot this coroutine itself created and owns. Only used on
/// `ws_connect_inner`'s *own* error paths — on the cancel paths the slot
/// belongs to `ws_disconnect` (see `take_open_ws_slot`).
async fn release_ws_slot(connection_id: &str) {
    ws_pool().lock().await.remove(connection_id);
    ws_event_queue_pool().lock().await.remove(connection_id);
}

fn build_ws_request(
    url: &str,
    headers: &[KeyValuePair],
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
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

    Ok(request)
}

async fn ws_connect_inner(
    app: Option<tauri::AppHandle>,
    connection_id: String,
    url: String,
    headers: Vec<KeyValuePair>,
) -> Result<(), String> {
    // 1. Claim the prepared slot and subscribe to its cancel channel.
    //
    // A missing slot is the *normal* outcome of "cancel arrived first":
    // `ws_disconnect` removes the Pending slot itself, so the handshake is
    // never even started. It shares the wording with "this id was never
    // prepared" on purpose — the only caller is the frontend using an id it
    // just received, so both cases are programming errors or a cancel, and all
    // three are refused identically. Whether the user sees an error is decided
    // by the frontend's own `cancelled` flag, not by this string.
    let mut cancel_rx = {
        let pool = ws_pool();
        let connections = pool.lock().await;
        match connections.get(&connection_id) {
            Some(WsSlot::Pending { cancel }) => cancel.subscribe(),
            _ => return Err("Unknown WebSocket connection".to_string()),
        }
    };

    // 2. The dev-bridge queue must exist before the handshake, otherwise frames
    //    that arrive with the upgrade have nowhere to land. The Tauri path
    //    deliberately builds no queue: nobody drains it there, and an undrained
    //    pool is exactly the leak this slice removes.
    if app.is_none() {
        ws_event_queue_pool()
            .lock()
            .await
            .insert(connection_id.clone(), Vec::new());
    }

    // 3. Build the request.
    let request = match build_ws_request(&url, &headers) {
        Ok(request) => request,
        Err(error) => {
            release_ws_slot(&connection_id).await;
            return Err(error);
        }
    };

    // 4. Handshake and cancel share one `select!`. `biased` polls cancel first,
    //    so a cancel that landed before we got here means the handshake is
    //    never initiated at all.
    let handshake = observing_first_pending(
        "handshake",
        tokio::time::timeout(ws_handshake_budget(), tokio_tungstenite::connect_async(request)),
    );
    let (ws_stream, _) = tokio::select! {
        biased;
        // The `watch::Ref` this yields holds a non-Send read guard, so it is
        // dropped inside the branch future rather than becoming part of the
        // select's output type — otherwise the whole command future stops being
        // Send and Tauri cannot register it.
        _ = async { let _ = cancel_rx.wait_for(|cancelled| *cancelled).await; } => {
            // Dropping the handshake future here drops the half-open TcpStream,
            // so the socket closes at the moment of cancellation rather than
            // when the budget expires.
            //
            // The slot is NOT removed here: reaching this branch means
            // `ws_disconnect` already ran and already removed it. A second
            // remove would be a harmless no-op, but it would create a second
            // owner, and the next person to read this could not tell which one
            // is load-bearing. Same for the queue.
            return Err(WS_CANCELLED.to_string());
        }
        result = handshake => match result {
            Err(_elapsed) => {
                release_ws_slot(&connection_id).await;
                return Err(format!(
                    "WebSocket handshake timed out after {WS_HANDSHAKE_BUDGET_SECS}s"
                ));
            }
            Ok(Err(error)) => {
                release_ws_slot(&connection_id).await;
                return Err(format!("WebSocket connection failed: {error}"));
            }
            Ok(Ok(stream)) => stream,
        },
    };

    // 5. Test-only rendezvous. It proves the handshake *completed*; it does not
    //    prove the handshake is cancellable — that is what the "handshake" tag
    //    on the future above observes.
    ws_checkpoint("handshake-done").await;

    let (write, read) = ws_stream.split();

    // 6. Spawn the reader parked behind a gate, then install the slot. The gate
    //    is what makes "connected precedes the first frame" structural instead
    //    of a scheduling coin flip.
    let (gate_tx, gate_rx) = tokio::sync::oneshot::channel::<()>();
    let reader_task = tokio::spawn(ws_reader_loop(
        app.clone(),
        connection_id.clone(),
        read,
        gate_rx,
    ));

    let cancel = {
        let pool = ws_pool();
        let mut connections = pool.lock().await;
        let cancelled = !matches!(
            connections.get(&connection_id),
            Some(WsSlot::Pending { .. })
        ) || *cancel_rx.borrow();

        if cancelled {
            drop(connections);
            // Only tear down what this coroutine created: gate, reader task,
            // write half. Slot and queue belong to `ws_disconnect`.
            drop(gate_tx);
            let _ = reader_task.await;
            drop(write);
            return Err(WS_CANCELLED.to_string());
        }

        let Some(WsSlot::Pending { cancel }) = connections.remove(&connection_id) else {
            // Unreachable given the check above, but expressing it as a value
            // keeps the ownership story total.
            drop(connections);
            drop(gate_tx);
            let _ = reader_task.await;
            drop(write);
            return Err(WS_CANCELLED.to_string());
        };

        connections.insert(
            connection_id.clone(),
            WsSlot::Open(WsOpen {
                sender: Arc::new(TokioMutex::new(write)),
                reader: reader_task.abort_handle(),
                cancel: cancel.clone(),
            }),
        );
        cancel
    };
    let _ = cancel;

    // 7. Re-check before publishing.
    //
    // This NARROWS the window, it does not close it: `ws_disconnect` can still
    // take the Open slot between this unlock and the emit below. The actual fix
    // for that race is the frontend's terminal-state guard, which discards a
    // `connected` event that arrives after cancel/disconnect/teardown.
    //
    // Keep this re-check anyway — deleting it is invisible under most
    // interleavings, which is exactly why the reason has to live in the code
    // and not only in the spec:
    //   (a) in the common case the backend avoids emitting an event it already
    //       knows is false;
    //   (b) on the browser path it is the only interception point, since the
    //       queue is gone and `publish_ws_event` no longer recreates it.
    //
    // Publishing is deliberately NOT done under the pool lock. That would make
    // "slot is Open" and "connected emitted" atomic, but it puts an `await`
    // inside the pool lock — the very shape this slice removes from ws_send and
    // ws_disconnect. On the dev-bridge path publish itself awaits another lock,
    // so folding it in would nest async locks.
    let still_open = {
        let pool = ws_pool();
        let connections = pool.lock().await;
        matches!(connections.get(&connection_id), Some(WsSlot::Open(_))) && !*cancel_rx.borrow()
    };

    if !still_open {
        drop(gate_tx);
        return Err(WS_CANCELLED.to_string());
    }

    publish_ws_event(
        app.as_ref(),
        WsEventPayload {
            connection_id: connection_id.clone(),
            event_type: "connected".to_string(),
            content: String::new(),
            timestamp: now_iso(),
        },
    )
    .await;

    // 8. Publish first, then open the gate: frame ordering must not depend on
    //    the scheduler.
    let _ = gate_tx.send(());

    Ok(())
}

async fn ws_reader_loop(
    app: Option<tauri::AppHandle>,
    connection_id: String,
    mut read: WsReader,
    gate: tokio::sync::oneshot::Receiver<()>,
) {
    // Marks "this task was polled and entered the body", which is what the
    // liveness tests wait for. It has to sit *before* the gate await: a
    // cancelled connection would otherwise never be observed alive, and the
    // cancel and reader-termination invariants would contradict each other.
    let _alive = ws_reader_alive_guard();

    if gate.await.is_err() {
        return;
    }

    while let Some(message) = read.next().await {
        match message {
            Ok(WsMessage::Text(text)) => {
                publish_ws_event(
                    app.as_ref(),
                    WsEventPayload {
                        connection_id: connection_id.clone(),
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
                        connection_id: connection_id.clone(),
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
                        connection_id: connection_id.clone(),
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

    // Only reachable when the *peer* ended the connection. A user-initiated
    // disconnect aborts this task, so no late `disconnected` is produced and no
    // suppression bookkeeping is needed.
    ws_pool().lock().await.remove(&connection_id);
    publish_ws_event(
        app.as_ref(),
        WsEventPayload {
            connection_id: connection_id.clone(),
            event_type: "disconnected".to_string(),
            content: String::new(),
            timestamp: now_iso(),
        },
    )
    .await;
}

#[tauri::command]
async fn ws_connect(
    app: tauri::AppHandle,
    connection_id: String,
    url: String,
    headers: Vec<KeyValuePair>,
) -> Result<(), String> {
    ws_connect_inner(Some(app), connection_id, url, headers).await
}

#[tauri::command]
async fn ws_send(connection_id: String, message: String) -> Result<(), String> {
    let (sender, mut cancel_rx) = {
        let pool = ws_pool();
        let connections = pool.lock().await;
        let taken = match connections.get(&connection_id) {
            Some(WsSlot::Open(open)) => (open.sender.clone(), open.cancel.subscribe()),
            Some(WsSlot::Pending { .. }) => {
                return Err("Connection is still being established".to_string())
            }
            None => return Err("Connection not found or already closed".to_string()),
        };
        drop(connections); // Explicit: this line is what keeps the network send out of the pool lock.
        taken
    };
    ws_checkpoint("send-after-unlock").await;

    tokio::select! {
        biased;
        // The lock wait and the send live in the *same* branch, so cancelling
        // abandons the whole path rather than just the network call.
        result = async {
            let mut guard = sender.lock().await;
            observing_first_pending("send", guard.send(WsMessage::Text(message.into()))).await
        } => result.map_err(|error| format!("Failed to send message: {error}")),
        // Ref dropped inside the branch future — see the note in ws_connect_inner.
        _ = async { let _ = cancel_rx.wait_for(|cancelled| *cancelled).await; } => Err("Connection was closed".to_string()),
    }
}

/// Takes ownership of an established connection, or cancels a pending one.
///
/// Destroying the slot is this function's job in *both* cases, because it is
/// the only party on the cancel path guaranteed to run: after `ws_prepare`
/// succeeds there are legitimate frontend paths that never call `ws_connect` at
/// all, so a Pending slot whose removal is deferred to that coroutine would
/// leak forever.
fn take_open_ws_slot(
    connections: &mut HashMap<String, WsSlot>,
    connection_id: &str,
) -> Option<WsOpen> {
    match connections.get(connection_id) {
        Some(WsSlot::Pending { cancel }) => {
            let _ = cancel.send(true);
            connections.remove(connection_id);
            None
        }
        Some(WsSlot::Open(_)) => match connections.remove(connection_id) {
            Some(WsSlot::Open(open)) => Some(open),
            _ => None,
        },
        None => None,
    }
}

fn spawn_ws_close(sender: Arc<TokioMutex<WsSender>>) {
    tokio::spawn(close_ws_sender(sender));
}

async fn close_ws_sender(sender: Arc<TokioMutex<WsSender>>) {
    // The budget has to cover the *lock wait* too. Covering only the network
    // send leaves a stuck `ws_send` holding the guard and the close task
    // waiting on it forever — the same "await outside the budget" shape this
    // slice removes elsewhere.
    //
    // With the cancel path present the stuck sender releases its guard almost
    // immediately, so this budget is defence in depth rather than the
    // load-bearing half. It is kept for the case where the cancel path is
    // absent or the send task is not polled for a long time; it has no
    // independent mutation killer, and that is recorded rather than papered
    // over.
    let _ = tokio::time::timeout(ws_close_budget(), async {
        let mut guard = sender.lock().await;
        let _ = guard.send(WsMessage::Close(None)).await;
    })
    .await;
    // Guard and the last Arc drop here, releasing the write half. Budget
    // expiry releases it just the same.
}

#[tauri::command]
async fn ws_disconnect(connection_id: String) -> Result<(), String> {
    let pool = ws_pool();
    let mut connections = pool.lock().await;
    let open = take_open_ws_slot(&mut connections, &connection_id);
    drop(connections); // Explicit: this line is what keeps the Close frame out of the pool lock.
    ws_checkpoint("disconnect-after-unlock").await;

    ws_event_queue_pool().lock().await.remove(&connection_id);

    if let Some(open) = open {
        // Explicit send rather than relying on the Sender being dropped below.
        // Dropping it has the same effect, so this line has no independent
        // killer — it is kept so the cancellation is visible in the code and a
        // later refactor cannot lose the unwritten "drop implies cancel"
        // dependency.
        let _ = open.cancel.send(true);
        // Dropping the read half is what actually closes the socket against a
        // peer that never sends Close: SplitSink has no Drop, so releasing the
        // write half alone would leave the reader parked forever.
        open.reader.abort();
        // Best-effort polite Close on a bounded, detached task, so the
        // disconnect button's latency is decoupled from the peer's.
        spawn_ws_close(open.sender);
    }

    // Cancelling a connection that has not been established yet still
    // *succeeded*. Reporting it as an error would surface a user's own cancel
    // as a failure.
    Ok(())
}

#[tauri::command]
async fn ws_drain_events(connection_id: String) -> Result<Vec<WsEventPayload>, String> {
    let pool = ws_event_queue_pool();
    let mut queues = pool.lock().await;
    // `get_mut`, never `entry().or_default()`: draining an unknown id must not
    // create an entry nobody will ever remove.
    let Some(events) = queues.get_mut(&connection_id) else {
        return Ok(Vec::new());
    };
    let drained = std::mem::take(events);
    if drained
        .iter()
        .any(|event| event.event_type == "disconnected")
    {
        // Keyed by the argument, not by `drained[0]`, so an empty batch cannot
        // panic and a mixed batch cannot remove the wrong queue.
        queues.remove(&connection_id);
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
    #[serde(default)]
    create: Option<bool>,
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
    connection_id: String,
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
    api_unit(save_environment(args.project, args.env, args.create))
}

async fn api_delete_environment(Json(args): Json<EnvironmentNameArgs>) -> impl IntoResponse {
    api_unit(delete_environment(args.project, args.name))
}

async fn api_resolve_variables(Json(args): Json<ResolveVariablesArgs>) -> impl IntoResponse {
    api_response(resolve_variables(args.template, args.variables))
}

async fn api_ws_prepare() -> impl IntoResponse {
    api_response(ws_prepare().await)
}

async fn api_ws_connect(Json(args): Json<WsConnectArgs>) -> impl IntoResponse {
    api_unit(ws_connect_inner(None, args.connection_id, args.url, args.headers).await)
}

async fn api_ws_send(Json(args): Json<WsSendArgs>) -> impl IntoResponse {
    api_unit(ws_send(args.connection_id, args.message).await)
}

async fn api_ws_disconnect(Json(args): Json<WsConnectionArgs>) -> impl IntoResponse {
    api_unit(ws_disconnect(args.connection_id).await)
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

async fn api_get_history_health() -> impl IntoResponse {
    api_response(get_history_health())
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
        .route("/api/ws_prepare", post(api_ws_prepare))
        .route("/api/ws_connect", post(api_ws_connect))
        .route("/api/ws_send", post(api_ws_send))
        .route("/api/ws_disconnect", post(api_ws_disconnect))
        .route("/api/send_request", post(api_send_request))
        .route("/api/cancel_request", post(api_cancel_request))
        .route("/api/ws_drain_events", post(api_ws_drain_events))
        .route("/api/append_history", post(api_append_history))
        .route("/api/load_history", post(api_load_history))
        .route("/api/get_history_health", post(api_get_history_health))
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
            ws_prepare,
            ws_connect,
            ws_send,
            ws_disconnect,
            ws_drain_events,
            send_request,
            cancel_request,
            append_history,
            load_history,
            clear_history,
            delete_history_entry,
            update_history_entries,
            get_history_health,
            get_secret_key_collisions,
            acknowledge_secret_key_collision,
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

    /// Named, one-shot rendezvous points for the concurrency tests.
    ///
    /// A test installs a gate under one name; the code under test parks there
    /// once; the test thread probes whatever it needs while the child is
    /// pinned. `hit` removes the gate *before* it blocks, so a second arrival
    /// at the same name passes straight through — a correct implementation
    /// that writes twice must not deadlock against a test that releases once.
    pub(super) mod checkpoints {
        use std::collections::HashMap;
        use std::sync::mpsc::{channel, Receiver, Sender};
        use std::sync::{Mutex, OnceLock};

        pub(crate) enum Event {
            Arrived,
            Returned(Result<(), String>),
        }

        struct Gate {
            arrival: Sender<Event>,
            release: Receiver<()>,
        }

        fn registry() -> &'static Mutex<HashMap<&'static str, Gate>> {
            static REGISTRY: OnceLock<Mutex<HashMap<&'static str, Gate>>> = OnceLock::new();
            REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
        }

        pub(crate) fn hit(name: &'static str) {
            // Take the gate out under the registry lock and release that lock
            // before blocking, otherwise the test thread could not reach the
            // registry to clean up.
            let gate = {
                registry()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(name)
            };

            if let Some(gate) = gate {
                let _ = gate.arrival.send(Event::Arrived);
                let _ = gate.release.recv();
            }
        }

        pub(crate) fn install(name: &'static str, arrival: Sender<Event>) -> Sender<()> {
            let (release_tx, release_rx) = channel();
            registry()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(
                    name,
                    Gate {
                        arrival,
                        release: release_rx,
                    },
                );
            release_tx
        }

        pub(crate) fn clear() {
            registry()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
    }

    /// Test-only WebSocket support: rendezvous points, liveness probes, and
    /// the offline peer used by the lifecycle tests.
    ///
    /// Every observation point here is bound to a real state transition of the
    /// thing being observed, never to the moment the test called something.
    /// "We invoked send" is not "send is stuck"; "the task was spawned" is not
    /// "the task is running". Both of those shortcuts admitted a false green in
    /// earlier designs.
    pub(super) mod ws_support {
        use super::super::{WsEventPayload, WS_CLOSE_BUDGET_SECS, WS_HANDSHAKE_BUDGET_SECS};
        use std::collections::HashSet;
        use std::sync::{Mutex, OnceLock};
        use std::time::Duration;

        pub(crate) struct WsCheckpoint {
            pub notify: tokio::sync::mpsc::UnboundedSender<&'static str>,
            pub resume: tokio::sync::oneshot::Receiver<()>,
        }

        fn checkpoint_slot() -> &'static Mutex<Option<WsCheckpoint>> {
            static SLOT: OnceLock<Mutex<Option<WsCheckpoint>>> = OnceLock::new();
            SLOT.get_or_init(|| Mutex::new(None))
        }

        /// take() ⇒ each installed checkpoint fires at most once. "One-shot"
        /// has to be a property of the mechanism: if it relied on the test
        /// remembering to drain, a second arrival would park forever while the
        /// test waits to join, and both sides would hang.
        pub(crate) async fn ws_checkpoint(tag: &'static str) {
            let taken = {
                checkpoint_slot()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
            };

            if let Some(checkpoint) = taken {
                let _ = checkpoint.notify.send(tag);
                let _ = checkpoint.resume.await;
            }
        }

        pub(crate) fn install_ws_checkpoint(
        ) -> (tokio::sync::mpsc::UnboundedReceiver<&'static str>, tokio::sync::oneshot::Sender<()>)
        {
            let (notify_tx, notify_rx) = tokio::sync::mpsc::unbounded_channel();
            let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
            *checkpoint_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(WsCheckpoint {
                notify: notify_tx,
                resume: resume_rx,
            });
            (notify_rx, resume_tx)
        }

        // --- published event log ------------------------------------------
        //
        // Installed inside the *production* `publish_ws_event` body, so it
        // records that publishing actually happened rather than that a helper
        // could work in isolation.

        fn published() -> &'static Mutex<Vec<(String, String)>> {
            static LOG: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
            LOG.get_or_init(|| Mutex::new(Vec::new()))
        }

        pub(crate) fn record_published_ws_event(payload: &WsEventPayload) {
            published()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((payload.connection_id.clone(), payload.event_type.clone()));
        }

        pub(crate) fn published_events() -> Vec<(String, String)> {
            published()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        // --- reader liveness ----------------------------------------------

        fn alive_channel() -> &'static tokio::sync::watch::Sender<usize> {
            static ALIVE: OnceLock<tokio::sync::watch::Sender<usize>> = OnceLock::new();
            ALIVE.get_or_init(|| tokio::sync::watch::channel(0).0)
        }

        /// Published over a `watch`, not a bare counter plus `Notify`: the
        /// tests must *positively* wait for `alive == 1` before judging
        /// anything, and `Notify` drops a notification that arrives before the
        /// wait — which is exactly the false green this guards against.
        pub(crate) struct ReaderAliveGuard;

        impl ReaderAliveGuard {
            pub(crate) fn new() -> Self {
                alive_channel().send_modify(|count| *count += 1);
                Self
            }
        }

        impl Drop for ReaderAliveGuard {
            fn drop(&mut self) {
                alive_channel().send_modify(|count| *count = count.saturating_sub(1));
            }
        }

        pub(crate) fn reader_alive_rx() -> tokio::sync::watch::Receiver<usize> {
            alive_channel().subscribe()
        }

        // --- first-Pending signals ----------------------------------------

        fn first_pending_channel() -> &'static tokio::sync::watch::Sender<HashSet<&'static str>> {
            static TAGS: OnceLock<tokio::sync::watch::Sender<HashSet<&'static str>>> =
                OnceLock::new();
            TAGS.get_or_init(|| tokio::sync::watch::channel(HashSet::new()).0)
        }

        pub(crate) fn first_pending_signal(tag: &'static str) {
            first_pending_channel().send_modify(|tags| {
                tags.insert(tag);
            });
        }

        pub(crate) fn first_pending_rx() -> tokio::sync::watch::Receiver<HashSet<&'static str>> {
            first_pending_channel().subscribe()
        }

        // --- overridable budgets ------------------------------------------
        //
        // The tests assert *which branch was taken*, never a wall-clock
        // duration.

        fn handshake_budget_slot() -> &'static Mutex<Duration> {
            static SLOT: OnceLock<Mutex<Duration>> = OnceLock::new();
            SLOT.get_or_init(|| Mutex::new(Duration::from_secs(WS_HANDSHAKE_BUDGET_SECS)))
        }

        fn close_budget_slot() -> &'static Mutex<Duration> {
            static SLOT: OnceLock<Mutex<Duration>> = OnceLock::new();
            SLOT.get_or_init(|| Mutex::new(Duration::from_secs(WS_CLOSE_BUDGET_SECS)))
        }

        pub(crate) fn handshake_budget() -> Duration {
            *handshake_budget_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        pub(crate) fn close_budget() -> Duration {
            *close_budget_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        pub(crate) fn set_handshake_budget(value: Duration) {
            *handshake_budget_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
        }

        pub(crate) fn set_close_budget(value: Duration) {
            *close_budget_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
        }

        /// Process-wide state is shared by every test in this binary, so the WS
        /// tests depend on `--test-threads=1` (i.e. `npm run test:rust`).
        pub(crate) async fn reset_ws_state() {
            super::super::ws_pool().lock().await.clear();
            super::super::ws_event_queue_pool().lock().await.clear();
            published()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
            *checkpoint_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            first_pending_channel().send_modify(|tags| tags.clear());
            set_handshake_budget(Duration::from_secs(WS_HANDSHAKE_BUDGET_SECS));
            set_close_budget(Duration::from_secs(WS_CLOSE_BUDGET_SECS));
        }
    }

    /// Verdicts are four-valued and mutually exclusive on purpose. Once
    /// "never observed" is allowed to slide into a benign result, the test's
    /// upper bound quietly stops being a deadlock guard and becomes the
    /// judgement itself.
    #[cfg(test)]
    #[derive(Debug, PartialEq, Eq)]
    enum HandshakeVerdict {
        BudgetEnforced,
        NoBudget,
        UnexpectedSuccess,
        HarnessError,
    }

    #[cfg(test)]
    #[derive(Debug, PartialEq, Eq)]
    enum CancelVerdict {
        HandshakeCancelled,
        HandshakeNotCancelled,
        HandshakeNeverPending,
        HarnessError,
    }

    #[cfg(test)]
    #[derive(Debug, PartialEq, Eq)]
    enum ReaderVerdict {
        ReaderTerminated,
        ReaderStillAlive,
        ReaderNeverStarted,
        HarnessError,
    }

    #[cfg(test)]
    #[derive(Debug, PartialEq, Eq)]
    enum WriterVerdict {
        WriterReleased,
        WriterStillHeld,
        SendNeverStuck,
        HarnessError,
    }

    /// Offline test peers. Everything is loopback; nothing leaves the machine.
    #[cfg(test)]
    #[derive(Clone, Copy)]
    enum TestPeer {
        /// Sends one frame immediately after the upgrade, then closes.
        FrameThenClose,
        /// Accepts, then never sends a frame, never sends Close, never closes
        /// the TCP connection.
        SilentForever,
        /// Completes the TCP handshake and never replies 101, so the client's
        /// handshake future parks deterministically.
        AcceptTcpNeverUpgrade,
        /// Stays connected and idle.
        HoldOpen,
    }

    #[cfg(test)]
    struct TestPeerHandle {
        url: String,
        accepted: tokio::sync::watch::Receiver<usize>,
        /// Whether the accepted stream has seen EOF — i.e. the *client* closed
        /// the socket. The peer itself never closes, so EOF has exactly one
        /// cause.
        eof: tokio::sync::watch::Receiver<bool>,
        /// Connections currently being serviced. A peer that died before the
        /// verdict would make the reader terminate, the writer release and the
        /// handshake return all on its own, so none of those endpoints could be
        /// attributed to the mechanism under test.
        live: tokio::sync::watch::Receiver<usize>,
        task: tokio::task::JoinHandle<()>,
        /// Per-connection tasks, so a finished test can release its sockets
        /// instead of leaving them parked for the rest of the binary.
        connections: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>>,
    }

    #[cfg(test)]
    async fn spawn_test_ws_peer(peer: TestPeer) -> TestPeerHandle {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::watch::channel(0usize);
        let (eof_tx, eof_rx) = tokio::sync::watch::channel(false);
        let (live_tx, live_rx) = tokio::sync::watch::channel(0usize);
        let connections: Arc<StdMutex<Vec<tokio::task::JoinHandle<()>>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let connections_for_loop = connections.clone();

        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                accepted_tx.send_modify(|count| *count += 1);
                live_tx.send_modify(|count| *count += 1);

                // Each connection is serviced on its own task: the peers below
                // deliberately park forever, and doing that inline would stop
                // the listener from ever accepting a second connection.
                let eof_tx = eof_tx.clone();
                let live_tx = live_tx.clone();
                let handle = tokio::spawn(async move {
                    match peer {
                        TestPeer::AcceptTcpNeverUpgrade => {
                            // Read until EOF and nothing else. Never close,
                            // never shut down: that keeps "the stream saw EOF"
                            // uniquely caused by the client releasing its
                            // socket, which is what the cancel assertion reads.
                            let mut stream = stream;
                            let mut buffer = [0u8; 1024];
                            loop {
                                match stream.read(&mut buffer).await {
                                    Ok(0) => {
                                        eof_tx.send_replace(true);
                                        break;
                                    }
                                    Ok(_) => continue,
                                    Err(_) => {
                                        eof_tx.send_replace(true);
                                        break;
                                    }
                                }
                            }
                            std::future::pending::<()>().await;
                        }
                        TestPeer::FrameThenClose => {
                            let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                                live_tx.send_modify(|count| *count -= 1);
                                return;
                            };
                            use futures_util::SinkExt;
                            let _ = ws
                                .send(tokio_tungstenite::tungstenite::Message::Text(
                                    "first-frame".into(),
                                ))
                                .await;
                            let _ = ws
                                .send(tokio_tungstenite::tungstenite::Message::Close(None))
                                .await;
                            let _ = ws.flush().await;
                            std::future::pending::<()>().await;
                        }
                        TestPeer::SilentForever | TestPeer::HoldOpen => {
                            let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                                live_tx.send_modify(|count| *count -= 1);
                                return;
                            };
                            // Hold the stream open and read nothing, so a large
                            // client send fills the window and parks.
                            let _ws = ws;
                            std::future::pending::<()>().await;
                        }
                    }
                });
                connections_for_loop
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(handle);
            }
        });

        TestPeerHandle {
            url: format!("ws://{addr}/socket"),
            accepted: accepted_rx,
            eof: eof_rx,
            live: live_rx,
            task,
            connections,
        }
    }

    #[cfg(test)]
    impl TestPeerHandle {
        async fn wait_accepted(&mut self, at_least: usize) -> bool {
            tokio::time::timeout(
                Duration::from_secs(5),
                self.accepted.wait_for(|count| *count >= at_least),
            )
            .await
            .is_ok()
        }

        async fn wait_eof(&mut self, budget: Duration) -> bool {
            tokio::time::timeout(budget, self.eof.wait_for(|seen| *seen))
                .await
                .is_ok()
        }

        fn servicing(&self) -> usize {
            *self.live.borrow()
        }

        /// Releases the listener and every serviced connection. Without this the
        /// parked peer tasks would hold their sockets for the rest of the test
        /// binary, which is both a leak and a source of cross-test timing noise.
        fn shutdown(&self) {
            self.task.abort();
            for handle in self
                .connections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
            {
                handle.abort();
            }
        }
    }

    /// Waits for a `observing_first_pending` tag, i.e. for the awaited future
    /// to have actually parked. Failing to observe it is never a pass.
    #[cfg(test)]
    async fn wait_first_pending(tag: &'static str, budget: Duration) -> bool {
        let mut rx = ws_support::first_pending_rx();
        let observed = tokio::time::timeout(budget, rx.wait_for(|tags| tags.contains(tag)))
            .await
            .is_ok();
        observed
    }

    #[cfg(test)]
    async fn wait_reader_alive(target: usize, budget: Duration) -> bool {
        let mut rx = ws_support::reader_alive_rx();
        let observed = tokio::time::timeout(budget, rx.wait_for(|count| *count == target))
            .await
            .is_ok();
        observed
    }

    /// How long the test thread waits for a child to reach its checkpoint.
    /// A timeout means one thing only: the command never got there. It is
    /// never evidence about the lock.
    const NAMED_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(10);

    /// Releases and joins the parked child no matter how the test thread
    /// leaves the probe window. Without it a failing probe would panic while a
    /// child still holds a production lock, stranding every later test.
    struct NamedCheckpointCleanup {
        release: Option<std::sync::mpsc::Sender<()>>,
        child: Option<std::thread::JoinHandle<()>>,
    }

    impl NamedCheckpointCleanup {
        fn release_and_join(&mut self) -> bool {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            match self.child.take() {
                Some(child) => child.join().is_ok(),
                None => false,
            }
        }
    }

    impl Drop for NamedCheckpointCleanup {
        fn drop(&mut self) {
            self.release_and_join();
            checkpoints::clear();
        }
    }

    struct ParkedRun<T> {
        probe: Option<T>,
        child_ok: bool,
        returned: Vec<Result<(), String>>,
    }

    /// Runs `body` on a child thread, waits for it to park at `name`, runs
    /// `probe` on the test thread while it is pinned, then releases and joins.
    /// Asserts nothing: the caller inspects the returned facts *after* cleanup
    /// has already run.
    fn with_thread_parked_at<T>(
        name: &'static str,
        body: impl FnOnce() -> Result<(), String> + Send + 'static,
        probe: impl FnOnce() -> T,
    ) -> ParkedRun<T> {
        let (event_tx, event_rx) = std::sync::mpsc::channel::<checkpoints::Event>();
        let release = checkpoints::install(name, event_tx.clone());

        let child = std::thread::spawn(move || {
            let result = body();
            let _ = event_tx.send(checkpoints::Event::Returned(result));
        });

        let mut cleanup = NamedCheckpointCleanup {
            release: Some(release),
            child: Some(child),
        };

        let mut returned = Vec::new();
        let arrived = match event_rx.recv_timeout(NAMED_CHECKPOINT_TIMEOUT) {
            Ok(checkpoints::Event::Arrived) => true,
            Ok(checkpoints::Event::Returned(result)) => {
                returned.push(result);
                false
            }
            Err(_) => false,
        };

        // No assertion may run in this window — cleanup has to happen first.
        let probe = if arrived { Some(probe()) } else { None };

        let child_ok = cleanup.release_and_join();
        drop(cleanup);

        for event in event_rx.try_iter() {
            if let checkpoints::Event::Returned(result) = event {
                returned.push(result);
            }
        }

        ParkedRun {
            probe,
            child_ok,
            returned,
        }
    }

    struct NamedLockProbe {
        verdict: LockVerdict,
        child_ok: bool,
        returned: Vec<Result<(), String>>,
    }

    fn probe_lock_at_checkpoint(
        name: &'static str,
        lock: &'static StdMutex<()>,
        body: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> NamedLockProbe {
        let run = with_thread_parked_at(name, body, || match lock.try_lock() {
            Err(std::sync::TryLockError::WouldBlock) => LockVerdict::LockHeld,
            Ok(guard) => {
                drop(guard);
                LockVerdict::LockFree
            }
            Err(std::sync::TryLockError::Poisoned(error)) => {
                // A poisoned result still carries an acquired guard. Dropping
                // it keeps the lock usable for the rest of the file. It must
                // not be folded into LockHeld, which would misreport the lock.
                drop(error.into_inner());
                LockVerdict::HarnessError
            }
        });

        // Without this, one panicking child turns every later `try_lock` into
        // `Poisoned` and the whole file reports infrastructure failure.
        lock.clear_poison();

        NamedLockProbe {
            verdict: run.probe.unwrap_or(LockVerdict::NeverReachedIo),
            child_ok: run.child_ok,
            returned: run.returned,
        }
    }

    /// The four facts of the checkpoint protocol, reported together. Checking
    /// the verdict alone lets "held the lock, reached the checkpoint, then
    /// panicked" pass as success; checking them apart makes a crashed child
    /// read as a misplaced lock.
    fn assert_named_lock_probe(label: &str, probe: &NamedLockProbe, expected: LockVerdict) {
        let returned_ok = probe.returned.len() == 1 && probe.returned[0].is_ok();
        assert!(
            probe.verdict == expected && probe.child_ok && returned_ok,
            "{label}: verdict={:?} (expected {expected:?}), child_ok={}, returned={:?}",
            probe.verdict,
            probe.child_ok,
            probe.returned
        );
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
            None,
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
                None,
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

    // -----------------------------------------------------------------------
    // WebSocket lifecycle tests.
    //
    // Every liveness test below first *positively observes its starting point*
    // and only then waits, under a test-side bound, for the end state. A bound
    // that expires is mapped to a named red verdict, never to a pass; and a
    // starting point that was never observed is its own verdict, because
    // "it never got going" and "it finished" are different facts that an
    // earlier design folded into one.
    //
    // These tests read process-wide pools, so they require --test-threads=1
    // (that is, `npm run test:rust`).
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_ws_handshake_budget_is_enforced() {
        ws_support::reset_ws_state().await;
        ws_support::set_handshake_budget(Duration::from_millis(300));
        let mut peer = spawn_test_ws_peer(TestPeer::AcceptTcpNeverUpgrade).await;

        let connection_id = ws_prepare().await.unwrap();
        // The bound lives in the test, so a missing product budget makes the
        // test go red and stop rather than hang.
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new()),
        )
        .await;

        let verdict = match outcome {
            Err(_elapsed) => HandshakeVerdict::NoBudget,
            Ok(Err(error)) if error.contains("timed out") => HandshakeVerdict::BudgetEnforced,
            Ok(Err(_)) => HandshakeVerdict::HarnessError,
            Ok(Ok(())) => HandshakeVerdict::UnexpectedSuccess,
        };

        assert_eq!(verdict, HandshakeVerdict::BudgetEnforced);
        assert!(peer.wait_accepted(1).await, "peer never accepted a connection");
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_disconnect_cancels_an_in_flight_handshake() {
        ws_support::reset_ws_state().await;
        // Left at the default 30s on purpose: with a millisecond budget the
        // handshake would end on its own and a green would prove the budget
        // works, not that cancelling works. Same endpoint, different cause.
        let mut peer = spawn_test_ws_peer(TestPeer::AcceptTcpNeverUpgrade).await;

        let connection_id = ws_prepare().await.unwrap();
        let handshake = tokio::spawn(ws_connect_inner(
            None,
            connection_id.clone(),
            peer.url.clone(),
            Vec::new(),
        ));

        // Starting point, observed positively: the handshake future has parked
        // at least once, and the peer really has a connection in hand.
        let pending_observed = wait_first_pending("handshake", Duration::from_secs(5)).await;
        let accepted = peer.wait_accepted(1).await;

        ws_disconnect(connection_id.clone()).await.unwrap();

        // 2s, far below the 30s product budget: this gap is what separates
        // "cancelled now" from "gave up when the budget expired".
        let returned = tokio::time::timeout(Duration::from_secs(2), handshake).await;

        let verdict = if !pending_observed || !accepted {
            CancelVerdict::HandshakeNeverPending
        } else {
            match returned {
                Err(_elapsed) => CancelVerdict::HandshakeNotCancelled,
                Ok(Ok(Err(error))) if error == WS_CANCELLED => {
                    // Returning is not releasing: the peer must see EOF, which
                    // only the client closing its socket can produce.
                    if peer.wait_eof(Duration::from_secs(2)).await {
                        CancelVerdict::HandshakeCancelled
                    } else {
                        CancelVerdict::HandshakeNotCancelled
                    }
                }
                Ok(Ok(_)) | Ok(Err(_)) => CancelVerdict::HarnessError,
            }
        };

        assert_eq!(verdict, CancelVerdict::HandshakeCancelled);
        assert!(
            !ws_support::published_events()
                .iter()
                .any(|(id, kind)| id == &connection_id && kind == "connected"),
            "a connected event was published for a cancelled handshake"
        );
        assert!(ws_pool().lock().await.is_empty());
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_prepare_then_disconnect_without_connect_leaves_nothing() {
        ws_support::reset_ws_state().await;

        // The window where no coroutine will ever arrive to clean up: the
        // frontend prepared a connection and then abandoned it without ever
        // calling ws_connect. Destroying the slot has to be ws_disconnect's
        // job, because it is the only party guaranteed to run here.
        let connection_id = ws_prepare().await.unwrap();
        assert_eq!(ws_pool().lock().await.len(), 1);

        ws_disconnect(connection_id).await.unwrap();

        assert_eq!(ws_pool().lock().await.len(), 0);
        assert_eq!(ws_event_queue_pool().lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_ws_disconnect_terminates_the_reader_against_a_silent_peer() {
        ws_support::reset_ws_state().await;
        let peer = spawn_test_ws_peer(TestPeer::SilentForever).await;

        let connection_id = ws_prepare().await.unwrap();
        ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
            .await
            .unwrap();

        // Starting point: the reader task really is running. A count of zero
        // could just as well mean it was never polled.
        let started = wait_reader_alive(1, Duration::from_secs(5)).await;

        ws_disconnect(connection_id.clone()).await.unwrap();

        let terminated = wait_reader_alive(0, Duration::from_secs(5)).await;

        let verdict = if !started {
            ReaderVerdict::ReaderNeverStarted
        } else if terminated {
            ReaderVerdict::ReaderTerminated
        } else {
            ReaderVerdict::ReaderStillAlive
        };

        assert_eq!(verdict, ReaderVerdict::ReaderTerminated);
        assert!(
            peer.servicing() >= 1,
            "peer stopped servicing the connection before the verdict"
        );
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_disconnect_releases_a_stuck_writer_within_budget() {
        ws_support::reset_ws_state().await;
        ws_support::set_close_budget(Duration::from_millis(100));
        let peer = spawn_test_ws_peer(TestPeer::SilentForever).await;

        let connection_id = ws_prepare().await.unwrap();
        ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
            .await
            .unwrap();

        let sender = {
            let pool = ws_pool();
            let connections = pool.lock().await;
            match connections.get(&connection_id) {
                Some(WsSlot::Open(open)) => open.sender.clone(),
                _ => panic!("connection was not open"),
            }
        };
        // A second strong reference so "released" can be observed from here.
        let probe = sender.clone();
        drop(sender);

        let send_id = connection_id.clone();
        let stuck_send = tokio::spawn(async move {
            // Big enough that a peer which never reads cannot absorb it, so the
            // send parks instead of completing.
            let payload = "x".repeat(64 * 1024 * 1024);
            ws_send(send_id, payload).await
        });

        // Starting point: the send future has actually parked. If the peer had
        // drained it, killing the cancel path would not be observable and a
        // green would mean nothing.
        let stuck = wait_first_pending("send", Duration::from_secs(10)).await;

        ws_disconnect(connection_id.clone()).await.unwrap();

        let mut released = false;
        for _ in 0..100 {
            if Arc::strong_count(&probe) == 1 {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let verdict = if !stuck {
            WriterVerdict::SendNeverStuck
        } else if released {
            WriterVerdict::WriterReleased
        } else {
            WriterVerdict::WriterStillHeld
        };

        assert_eq!(verdict, WriterVerdict::WriterReleased);
        assert!(
            peer.servicing() >= 1,
            "peer stopped servicing the connection before the verdict"
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), stuck_send).await;
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_disconnect_does_not_hold_the_pool_lock() {
        ws_support::reset_ws_state().await;
        let peer = spawn_test_ws_peer(TestPeer::HoldOpen).await;

        let connection_id = ws_prepare().await.unwrap();
        ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
            .await
            .unwrap();

        let (mut arrivals, resume) = ws_support::install_ws_checkpoint();
        let disconnect_id = connection_id.clone();
        let disconnecting = tokio::spawn(async move { ws_disconnect(disconnect_id).await });

        let tag = tokio::time::timeout(Duration::from_secs(5), arrivals.recv())
            .await
            .expect("disconnect never reached its checkpoint")
            .expect("checkpoint channel closed");
        assert_eq!(tag, "disconnect-after-unlock");

        // Synchronous judgement at a pinned instant — no timeout anywhere in
        // the assertion itself.
        let free = ws_pool().try_lock().is_ok();
        let _ = resume.send(());
        let _ = disconnecting.await;

        assert!(free, "ws_disconnect still held the pool lock past the unlock point");
        assert!(
            peer.servicing() >= 1,
            "peer stopped servicing the connection before the verdict"
        );
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_send_does_not_hold_the_pool_lock() {
        ws_support::reset_ws_state().await;
        let peer = spawn_test_ws_peer(TestPeer::HoldOpen).await;

        let connection_id = ws_prepare().await.unwrap();
        ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
            .await
            .unwrap();

        let (mut arrivals, resume) = ws_support::install_ws_checkpoint();
        let send_id = connection_id.clone();
        let sending = tokio::spawn(async move { ws_send(send_id, "ping".to_string()).await });

        let tag = tokio::time::timeout(Duration::from_secs(5), arrivals.recv())
            .await
            .expect("send never reached its checkpoint")
            .expect("checkpoint channel closed");
        assert_eq!(tag, "send-after-unlock");

        let free = ws_pool().try_lock().is_ok();
        let _ = resume.send(());
        let _ = tokio::time::timeout(Duration::from_secs(5), sending).await;

        assert!(free, "ws_send still held the pool lock past the unlock point");
        assert!(
            peer.servicing() >= 1,
            "peer stopped servicing the connection before the verdict"
        );
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_connection_state_does_not_accumulate() {
        ws_support::reset_ws_state().await;
        let mut peer = spawn_test_ws_peer(TestPeer::HoldOpen).await;

        for _ in 0..5 {
            let connection_id = ws_prepare().await.unwrap();
            // app: None ⇒ the dev-bridge path, which is the one that builds an
            // event queue, so both maps are exercised.
            ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
                .await
                .unwrap();
            // The frontend drains after disconnecting; draining an unknown id
            // must not resurrect an entry.
            ws_disconnect(connection_id.clone()).await.unwrap();
            let drained = ws_drain_events(connection_id).await.unwrap();
            assert!(drained.is_empty());
        }

        assert_eq!(ws_pool().lock().await.len(), 0);
        assert_eq!(ws_event_queue_pool().lock().await.len(), 0);
        assert!(peer.wait_accepted(5).await);
        peer.shutdown();
    }

    #[tokio::test]
    async fn test_ws_connect_publishes_connected_before_the_first_frame() {
        ws_support::reset_ws_state().await;
        let peer = spawn_test_ws_peer(TestPeer::FrameThenClose).await;

        let connection_id = ws_prepare().await.unwrap();
        ws_connect_inner(None, connection_id.clone(), peer.url.clone(), Vec::new())
            .await
            .unwrap();

        // Wait for the frame to make it through the gate.
        let mut seen = Vec::new();
        for _ in 0..100 {
            seen = ws_support::published_events()
                .into_iter()
                .filter(|(id, _)| id == &connection_id)
                .map(|(_, kind)| kind)
                .collect();
            if seen.iter().any(|kind| kind == "message") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Ordering is enforced by the reader's gate, not by scheduling luck.
        assert_eq!(seen.first().map(String::as_str), Some("connected"));
        assert!(seen.iter().any(|kind| kind == "message"));
        peer.shutdown();
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
        // The queue is now created by ws_connect_inner rather than by
        // publish_ws_event, so the fixture has to register it first. The
        // assertions below are unchanged.
        ws_event_queue_pool()
            .lock()
            .await
            .insert(connection_id.clone(), Vec::new());
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

        let entries = read_history_entries().unwrap().entries;
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
        write_history_entries(&entries, &[]).unwrap();
    }

    fn history_ids() -> Vec<String> {
        read_history_entries()
            .unwrap()
            .entries
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
                let entries = read_history_entries().unwrap().entries;
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
        let entries = read_history_entries().unwrap().entries;
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

            let entries = read_history_entries().unwrap().entries;
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
    async fn test_api_key_header_replaces_a_manual_row_of_the_same_name() {
        // The existing e2e for api-key auth supplies no header row of its own,
        // so insert and append produce the identical single value and the
        // mutation ledger found `insert -> append` surviving. Only a manual row
        // with the same name can tell the two apart.
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        args.headers = vec![d02_header("X-Custom-Auth", "manual-stale-value")];
        args.auth = AuthInput {
            auth_type: "api-key".to_string(),
            basic: None,
            bearer: None,
            api_key: Some(ApiKeyAuth {
                key: "X-Custom-Auth".to_string(),
                value: "my-secret-key".to_string(),
                add_to: "header".to_string(),
            }),
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "x-custom-auth"),
            vec!["my-secret-key".to_string()]
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
    fn test_probe_connection_hands_the_callers_budget_to_the_addresses() {
        // The bug this pins: `probe_connection` used to take no budget at all
        // and the address loop used CONNECTION_PROBE_MAX, so the caller's
        // budget died between the timeout wrapper and the loop. The fair-share
        // guarantee then only held when the caller happened to pass 5s, and a
        // request with 2s left would give its first address 2.5s - the outer
        // timeout fires and the second address is never tried at all.
        //
        // localhost resolves to at least one address on every supported
        // platform; assert against the count actually resolved so this cannot
        // silently pass on a single-stack machine.
        let mut seen: Vec<Duration> = vec![];
        let budget = Duration::from_secs(2);
        let outcome = probe_connection_with("localhost".to_string(), 9, budget, |_, given| {
            seen.push(given);
            Err(std::io::Error::other("refused"))
        });
        assert!(outcome.is_ok(), "{outcome:?}");
        assert!(!seen.is_empty(), "no address was tried");
        // Each address gets at most its fair share of the caller's budget, and
        // in particular never the CONNECTION_PROBE_MAX constant.
        let fair_share = budget / seen.len() as u32;
        assert!(
            seen[0] <= fair_share,
            "first address got {:?}, more than its {:?} share of the caller's {:?}",
            seen[0],
            fair_share,
            budget
        );
        assert!(
            seen[0] < CONNECTION_PROBE_MAX,
            "first address got the constant ({:?}) instead of the caller's budget",
            seen[0]
        );
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


    // ---------- 评审 R1 IMPORTANT 的补强 ----------

    #[tokio::test]
    async fn test_json_body_that_is_only_whitespace_sends_no_body() {
        // Pins the branch the §33 test missed. Empty or whitespace-only JSON
        // content is treated as "no body", not as malformed JSON: that guard
        // predates this change and §33 ties the rejection wording to the
        // previous behaviour, so leaving the editor blank must not start
        // erroring. Malformed-but-present content is still rejected - see
        // test_invalid_json_body_is_rejected_before_sending.
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("POST", server.uri());
        args.body = RequestBodyInput {
            body_type: "json".to_string(),
            content: "   \n\t ".to_string(),
            form_data: vec![],
            binary_path: String::new(),
            binary_content: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        assert!(received[0].body.is_empty(), "{:?}", received[0].body);
        // No body means no content-type of ours either.
        assert_eq!(
            d02_header_values(&received[0], "content-type"),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn test_undecodable_encoding_preserves_the_original_bytes_and_length() {
        // §11 promised the bytes are untouched and Content-Length survives, but
        // the original test only looked at the marker text, so returning an
        // empty Vec from the undecodable branch left it green. These assertions
        // are the ones that collapse if the bytes stop being preserved.
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
        // size is the byte count of the untouched body ...
        assert_eq!(response.size as usize, PLAIN.len());
        // ... and the marker reports that same count back to the user.
        assert!(
            response.body.contains(&format!("{} bytes", PLAIN.len())),
            "{}",
            response.body
        );
        // ... and Content-Length still describes those same bytes.
        let content_length = response
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.clone());
        assert_eq!(content_length, Some(PLAIN.len().to_string()));
    }

    #[tokio::test]
    async fn test_corrupt_stream_error_carries_the_underlying_cause() {
        // §13 asks for the encoding name *and* the underlying reason. The
        // original test only checked the name, so replacing the cause with a
        // fixed string kept it green.
        const NOT_GZIP: &[u8] = b"this is definitely not a gzip stream";
        let server = d02_serve(NOT_GZIP, &[("content-encoding", "gzip")]).await;
        let error = send_request(d02_args("GET", server.uri()))
            .await
            .unwrap_err();
        let (_, cause) = error.rsplit_once(": ").expect("no cause segment");
        assert!(
            !cause.trim().is_empty() && cause != "gzip",
            "no underlying cause carried: {error}"
        );
        // flate2 reports the header mismatch; assert something specific enough
        // that a hard-coded string would have to impersonate it.
        assert!(
            error.to_lowercase().contains("header"),
            "cause is not the decoder's own: {error}"
        );
    }

    #[tokio::test]
    async fn test_user_supplied_accept_encoding_is_sent_unchanged() {
        // §16 has two halves. The existing test covers "we add none"; this one
        // covers "we keep the user's", which is the half that matters for the
        // pasted-cURL workflow and which a blanket remove() would pass.
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        args.headers = vec![d02_header("Accept-Encoding", "gzip")];
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "accept-encoding"),
            vec!["gzip".to_string()]
        );
    }

    #[tokio::test]
    async fn test_declared_charset_is_honoured_through_the_request_path() {
        // §17-§22 were only exercised against the decoder helper, so the
        // production path could have ignored Content-Type entirely and every
        // one of them would still pass. This drives the whole path.
        // gb2312: 中=D6D0 文=CEC4 测=B2E2 试=CAD4, then "abc".
        const GBK: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x61, 0x62, 0x63,
        ];
        let server = d02_serve(GBK, &[("content-type", "text/html; charset=gb2312")]).await;
        let response = send_request(d02_args("GET", server.uri())).await.unwrap();
        assert_eq!(response.body, "中文测试abc");
        assert!(!response.body.contains('\u{FFFD}'), "{}", response.body);
    }

    #[tokio::test]
    async fn test_binary_and_none_bodies_add_no_content_type() {
        // §28 covers raw / binary / none; only raw was exercised.
        let server = d02_serve(b"ok", &[]).await;

        let mut binary = d02_args("POST", server.uri());
        binary.body = RequestBodyInput {
            body_type: "binary".to_string(),
            content: String::new(),
            form_data: vec![],
            binary_path: "payload.bin".to_string(),
            binary_content: Some("AQIDBA==".to_string()),
        };
        send_request(binary).await.unwrap();

        send_request(d02_args("GET", server.uri())).await.unwrap();

        let received = server.received_requests().await.unwrap();
        for request in &received {
            assert_eq!(
                d02_header_values(request, "content-type"),
                Vec::<String>::new(),
                "{:?}",
                request.method
            );
        }
    }

    #[tokio::test]
    async fn test_basic_auth_replaces_a_manual_authorization_header() {
        // §29 names basic and bearer; only bearer was exercised.
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        args.headers = vec![d02_header("Authorization", "Basic c3RhbGU6c3RhbGU=")];
        args.auth = AuthInput {
            auth_type: "basic".to_string(),
            basic: Some(BasicAuth {
                username: "alice".to_string(),
                // A colon in the password is legal and must survive.
                password: "p:w".to_string(),
            }),
            bearer: None,
            api_key: None,
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        let values = d02_header_values(&received[0], "authorization");
        assert_eq!(values.len(), 1, "{values:?}");
        assert_ne!(values[0], "Basic c3RhbGU6c3RhbGU=");
        // base64("alice:p:w")
        assert_eq!(values[0], "Basic YWxpY2U6cDp3");
    }

    #[tokio::test]
    async fn test_api_key_mode_leaves_a_manual_authorization_header_alone() {
        // §30 says anything other than basic/bearer must not touch a manual
        // Authorization row; api-key mode was never exercised for that.
        let server = d02_serve(b"ok", &[]).await;
        let mut args = d02_args("GET", server.uri());
        // Two rows, not one: with a single value a keep-last collapse is
        // indistinguishable from leaving the header alone, which is exactly how
        // the api-key insert/append mutation escaped the first ledger run.
        args.headers = vec![
            d02_header("Authorization", "Bearer hand-written-a"),
            d02_header("Authorization", "Bearer hand-written-b"),
        ];
        args.auth = AuthInput {
            auth_type: "api-key".to_string(),
            basic: None,
            bearer: None,
            api_key: Some(ApiKeyAuth {
                key: "X-Api-Key".to_string(),
                value: "secret".to_string(),
                add_to: "header".to_string(),
            }),
        };
        send_request(args).await.unwrap();
        let received = server.received_requests().await.unwrap();
        assert_eq!(
            d02_header_values(&received[0], "authorization"),
            vec![
                "Bearer hand-written-a".to_string(),
                "Bearer hand-written-b".to_string()
            ]
        );
        assert_eq!(
            d02_header_values(&received[0], "x-api-key"),
            vec!["secret".to_string()]
        );
    }


    // ---------------------------------------------------------------- D03 §六
    // How files get written: atomic replacement, concurrent writers, no
    // leftovers, and leftovers that are never mistaken for user data.

    fn d03_reset_atomic_temp_log() {
        atomic_temp_paths()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    fn d03_recorded_atomic_temp_paths() -> Vec<PathBuf> {
        atomic_temp_paths()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn d03_dir_file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn test_concurrent_writers_both_succeed_and_never_interleave() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_reset_atomic_temp_log();

        let dir = temp_home.path().to_path_buf();
        let target = dir.join("contended.json");
        let child_target = target.clone();
        let probe_target = target.clone();

        // (a) The child is pinned between `create_new` and `rename`, so its
        // temp file provably exists while the test thread runs a whole
        // `write_atomic` of its own. With a deterministic temp name the second
        // `create_new` would hit EEXIST — that is what makes this deterministic
        // rather than a race the mutant might win.
        let run = with_thread_parked_at(
            "atomic_temp_created",
            move || write_atomic(&child_target, &[b'A'; 4096]),
            move || write_atomic(&probe_target, &[b'B'; 4096]),
        );

        let probe = run
            .probe
            .expect("child never reached the temp-file checkpoint");
        assert!(probe.is_ok(), "test-thread writer failed: {probe:?}");
        assert!(run.child_ok, "child thread panicked");
        assert_eq!(
            run.returned.len(),
            1,
            "expected exactly one return event, got {:?}",
            run.returned
        );
        assert!(
            run.returned[0].is_ok(),
            "child writer failed: {:?}",
            run.returned[0]
        );

        let contents = std::fs::read(&target).unwrap();
        assert_eq!(contents.len(), 4096, "target is not one complete write");
        let all_a = contents.iter().all(|byte| *byte == b'A');
        let all_b = contents.iter().all(|byte| *byte == b'B');
        assert!(
            all_a || all_b,
            "target interleaved two writers: {} A bytes, {} B bytes",
            contents.iter().filter(|byte| **byte == b'A').count(),
            contents.iter().filter(|byte| **byte == b'B').count()
        );

        let temps = d03_recorded_atomic_temp_paths();
        assert_eq!(temps.len(), 2, "expected two temp files, got {temps:?}");
        assert_ne!(
            temps[0], temps[1],
            "both writers used the same temp path: {temps:?}"
        );

        // (b) The same property without threads: a leftover file sitting on the
        // deterministic name must not be able to fail a fresh write.
        let residue = dir.join(".contended.json.tmp");
        std::fs::write(&residue, b"leftover from a crash").unwrap();
        write_atomic(&target, b"fresh").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"fresh");
    }

    #[test]
    fn test_write_atomic_leaves_no_temp_file() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let dir = temp_home.path().join("atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");

        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(
            d03_dir_file_names(&dir),
            vec!["state.json".to_string()],
            "a temp file survived the write"
        );
    }

    #[test]
    fn test_temp_files_are_invisible_to_collection_tree_and_environment_list() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Temp Vis".to_string(), String::new()).unwrap();
        save_request(
            "Temp Vis".to_string(),
            String::new(),
            sample_saved_request("Get Users", "GET", "http://example.com/users"),
            None,
        )
        .unwrap();
        save_environment(
            "Temp Vis".to_string(),
            Environment {
                name: "staging".to_string(),
                variables: vec![sample_env_variable("baseUrl", "http://localhost", false)],
            },
            None,
        )
        .unwrap();

        let project_dir = temp_home.path().join("ApiSolo/projects/temp-vis");
        let collections_dir = project_dir.join("collections");
        let environments_dir = project_dir.join("environments");

        // Park a real `write_atomic` between `create_new` and `rename` so a
        // genuine in-flight temp file is on disk while the listings run. This
        // is the crash-leftover shape, produced by production code rather than
        // hand-rolled in the test.
        let request_target = collections_dir.join("get-users.request.json");
        let collections_probe_dir = collections_dir.clone();
        let run = with_thread_parked_at(
            "atomic_temp_created",
            move || write_atomic(&request_target, b"{}"),
            move || {
                let tree = get_collection_tree("Temp Vis".to_string()).unwrap();
                let names: Vec<String> = tree.iter().map(|node| node.name.clone()).collect();
                let on_disk = d03_dir_file_names(&collections_probe_dir);
                (names, on_disk)
            },
        );

        let (tree_names, collection_files) = run
            .probe
            .expect("child never reached the temp-file checkpoint");
        assert!(run.child_ok && run.returned.len() == 1 && run.returned[0].is_ok());
        // Fixture self-check: the temp file really was on disk while we looked,
        // otherwise "not listed" would be vacuously true.
        assert_eq!(
            collection_files.len(),
            2,
            "expected the target plus one in-flight temp file, saw {collection_files:?}"
        );
        assert_eq!(
            tree_names,
            vec!["Get Users".to_string()],
            "an in-flight temp file showed up in the collection tree"
        );

        let env_target = environments_dir.join("staging.env.json");
        let environments_probe_dir = environments_dir.clone();
        let run = with_thread_parked_at(
            "atomic_temp_created",
            move || write_atomic(&env_target, b"[]"),
            move || {
                let names = list_environments("Temp Vis".to_string()).unwrap();
                let on_disk = d03_dir_file_names(&environments_probe_dir);
                (names, on_disk)
            },
        );

        let (env_names, env_files) = run
            .probe
            .expect("child never reached the temp-file checkpoint");
        assert!(run.child_ok && run.returned.len() == 1 && run.returned[0].is_ok());
        assert_eq!(
            env_files.len(),
            3,
            "expected two env files plus one in-flight temp file, saw {env_files:?}"
        );
        assert_eq!(
            env_names,
            vec!["staging".to_string()],
            "an in-flight temp file showed up in the environment list"
        );
    }

    // ---------------------------------------------------------------- D03 §五
    // The history file: one bad line used to brick the whole panel, and the
    // only in-app way out (Clear history) greyed itself out because the list
    // was empty. Bad lines are now skipped, and their raw bytes are preserved.

    fn d03_history_line(id: &str, timestamp: &str) -> Vec<u8> {
        serde_json::to_vec(&sample_history_entry(id, timestamp)).unwrap()
    }

    fn d03_write_raw_history(bytes: &[u8]) {
        std::fs::write(history_file_path().unwrap(), bytes).unwrap();
    }

    fn d03_read_raw_history() -> Vec<u8> {
        std::fs::read(history_file_path().unwrap()).unwrap()
    }

    fn d03_read_quarantine() -> Vec<u8> {
        std::fs::read(history_quarantine_path().unwrap()).unwrap_or_default()
    }

    /// One good line, one unparsable line, one good line — the shape a crash
    /// mid-write leaves behind.
    fn d03_seed_torn_history() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&d03_history_line("good-1", "2026-03-27T10:00:00Z"));
        raw.push(b'\n');
        raw.extend_from_slice(br#"{"id":"torn","method":"GET""#);
        raw.push(b'\n');
        raw.extend_from_slice(&d03_history_line("good-2", "2026-03-27T10:02:00Z"));
        raw.push(b'\n');
        d03_write_raw_history(&raw);
    }

    #[test]
    fn test_load_history_skips_corrupt_lines() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_seed_torn_history();

        let entries = load_history().unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["good-2", "good-1"]);
    }

    #[test]
    fn test_history_mutations_quarantine_corrupt_lines() {
        for (label, mutate) in [
            (
                "append",
                Box::new(|| {
                    append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap()
                }) as Box<dyn Fn()>,
            ),
            (
                "delete",
                Box::new(|| delete_history_entry("good-1".to_string()).unwrap()) as Box<dyn Fn()>,
            ),
            (
                "update",
                Box::new(|| {
                    let mut updated = sample_history_entry("good-1", "2026-03-27T10:00:00Z");
                    updated.url = "https://api.example.com/updated".to_string();
                    update_history_entries(vec![updated]).unwrap()
                }) as Box<dyn Fn()>,
            ),
        ] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            d03_seed_torn_history();

            mutate();

            assert_eq!(
                d03_read_quarantine(),
                b"{\"id\":\"torn\",\"method\":\"GET\"\n".to_vec(),
                "{label}: quarantine file does not hold the corrupt line verbatim"
            );
            let rewritten = d03_read_raw_history();
            assert!(
                !rewritten.windows(4).any(|window| window == b"torn"),
                "{label}: the corrupt line is still in history.jsonl"
            );
        }
    }

    #[test]
    fn test_invalid_utf8_line_is_isolated_not_fatal() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let mut raw = Vec::new();
        raw.extend_from_slice(&d03_history_line("good-1", "2026-03-27T10:00:00Z"));
        raw.push(b'\n');
        raw.extend_from_slice(&[0xFF, 0xFE]);
        raw.push(b'\n');
        d03_write_raw_history(&raw);

        let entries = load_history().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "good-1");

        append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap();
        assert_eq!(
            d03_read_quarantine(),
            vec![0xFF, 0xFE, b'\n'],
            "invalid UTF-8 bytes were altered on the way to quarantine"
        );
    }

    #[test]
    fn test_quarantine_preserves_crlf_and_missing_final_newline() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let mut raw = Vec::new();
        raw.extend_from_slice(&d03_history_line("good-1", "2026-03-27T10:00:00Z"));
        raw.extend_from_slice(b"\r\n");
        raw.extend_from_slice(b"not json\r\n");
        // Final line with no trailing newline at all.
        raw.extend_from_slice(b"also not json");
        d03_write_raw_history(&raw);

        append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap();

        assert_eq!(
            d03_read_quarantine(),
            b"not json\r\nalso not json\n".to_vec(),
            "quarantine normalised the bytes it was supposed to preserve"
        );
    }

    #[test]
    fn test_history_is_not_rewritten_until_quarantine_succeeds() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_seed_torn_history();
        let before = d03_read_raw_history();

        // A directory where the quarantine file belongs: append/create fails,
        // and nothing about history.jsonl may change as a result.
        std::fs::create_dir_all(history_quarantine_path().unwrap()).unwrap();

        let error = append_history(sample_history_entry("added", "2026-03-27T10:03:00Z"))
            .expect_err("append must fail when the corrupt line cannot be quarantined");
        assert!(error.contains("quarantine"), "unexpected error: {error}");
        assert_eq!(
            d03_read_raw_history(),
            before,
            "history.jsonl was rewritten even though quarantine failed"
        );
    }

    #[test]
    fn test_blank_history_lines_are_not_quarantined() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let mut raw = Vec::new();
        raw.extend_from_slice(&d03_history_line("good-1", "2026-03-27T10:00:00Z"));
        raw.extend_from_slice(b"\n\n   \n\t\n");
        raw.extend_from_slice(&d03_history_line("good-2", "2026-03-27T10:02:00Z"));
        raw.push(b'\n');
        d03_write_raw_history(&raw);

        assert_eq!(load_history().unwrap().len(), 2);

        append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap();
        assert!(
            d03_read_quarantine().is_empty(),
            "blank lines were treated as corruption"
        );
    }

    #[test]
    fn test_history_read_still_works_after_quarantine_failure() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_seed_torn_history();
        std::fs::create_dir_all(history_quarantine_path().unwrap()).unwrap();

        assert!(append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).is_err());

        // The panel must not brick a second time: reading is unaffected by a
        // failed quarantine.
        let entries = load_history().unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["good-2", "good-1"]);
    }

    #[test]
    fn test_clear_history_removes_quarantine_file() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_seed_torn_history();

        append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap();
        assert!(history_quarantine_path().unwrap().exists());

        clear_history().unwrap();

        assert!(
            !history_quarantine_path().unwrap().exists(),
            "an explicit clear left quarantined lines on disk"
        );
        assert!(load_history().unwrap().is_empty());
    }

    #[test]
    fn test_get_history_health_reports_skipped_and_quarantined_counts() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let mut raw = Vec::new();
        raw.extend_from_slice(&d03_history_line("good-1", "2026-03-27T10:00:00Z"));
        raw.push(b'\n');
        raw.extend_from_slice(b"first bad\n");
        raw.extend_from_slice(b"second bad\n");
        d03_write_raw_history(&raw);

        let health = get_history_health().unwrap();
        assert_eq!(health.skipped_lines, 2);
        assert_eq!(health.quarantined_lines, 0);

        append_history(sample_history_entry("added", "2026-03-27T10:03:00Z")).unwrap();

        let health = get_history_health().unwrap();
        assert_eq!(health.skipped_lines, 0);
        assert_eq!(health.quarantined_lines, 2);
    }

    // ---------------------------------------------------------------- D03 §七
    // The collection tree: one unparsable .json must cost only itself.

    fn d03_collection_names(project: &str) -> Vec<String> {
        get_collection_tree(project.to_string())
            .unwrap()
            .iter()
            .map(|node| node.name.clone())
            .collect()
    }

    #[test]
    fn test_collection_tree_skips_unparsable_files() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Tree Skip".to_string(), String::new()).unwrap();
        save_request(
            "Tree Skip".to_string(),
            String::new(),
            sample_saved_request("Get Users", "GET", "http://example.com/users"),
            None,
        )
        .unwrap();

        let collections_dir = temp_home
            .path()
            .join("ApiSolo/projects/tree-skip/collections");
        // A foreign export and a half-written save, the two shapes users hit.
        std::fs::write(
            collections_dir.join("openapi.json"),
            r#"{"openapi":"3.0.0","paths":{}}"#,
        )
        .unwrap();
        std::fs::write(collections_dir.join("torn.request.json"), r#"{"name":"To"#).unwrap();

        assert_eq!(d03_collection_names("Tree Skip"), vec!["Get Users"]);
        assert!(
            collections_dir.join("openapi.json").exists()
                && collections_dir.join("torn.request.json").exists(),
            "skipping a file must not delete or move it"
        );
    }

    #[test]
    fn test_collection_tree_skips_unparsable_files_in_subfolders() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        create_project("Tree Sub".to_string(), String::new()).unwrap();
        create_collection("Tree Sub".to_string(), "users".to_string(), String::new()).unwrap();
        save_request(
            "Tree Sub".to_string(),
            "users".to_string(),
            sample_saved_request("List Users", "GET", "http://example.com/users"),
            None,
        )
        .unwrap();
        save_request(
            "Tree Sub".to_string(),
            String::new(),
            sample_saved_request("Root Request", "GET", "http://example.com/"),
            None,
        )
        .unwrap();

        let collections_dir = temp_home
            .path()
            .join("ApiSolo/projects/tree-sub/collections");
        std::fs::write(collections_dir.join("users/torn.request.json"), "{").unwrap();

        let tree = get_collection_tree("Tree Sub".to_string()).unwrap();
        let top: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(top, vec!["users", "Root Request"]);

        let folder = tree.iter().find(|node| node.name == "users").unwrap();
        let children: Vec<&str> = folder
            .children
            .iter()
            .map(|node| node.name.as_str())
            .collect();
        assert_eq!(children, vec!["List Users"]);
    }

    // ---------------------------------------------------------------- D03 §一
    // Secret identity. Two CJK-named environments used to share one vault slot.

    fn d03_project_dir(slug: &str) -> PathBuf {
        PathBuf::from("/tmp/ApiSolo/projects").join(slug)
    }

    #[test]
    fn test_vault_keys_are_distinct_for_cjk_environment_names() {
        let project = d03_project_dir("my-api");
        let production = vault_key_for(&project, "生产", "token");
        let staging = vault_key_for(&project, "测试", "token");

        assert_ne!(
            production, staging,
            "两个中文环境名共用了同一个密钥槽: {production}"
        );
    }

    #[test]
    fn test_vault_keys_are_distinct_for_cjk_project_names() {
        let orders = vault_key_for(&d03_project_dir("订单服务"), "dev", "token");
        let users = vault_key_for(&d03_project_dir("用户服务"), "dev", "token");

        assert_ne!(orders, users, "两个中文项目名共用了同一个密钥槽: {orders}");
    }

    #[test]
    fn test_vault_key_keeps_readable_non_ascii_components() {
        assert_eq!(
            vault_key_for(&d03_project_dir("my-api"), "生产", "token"),
            "my-api:生产:dG9rZW4"
        );
    }

    #[test]
    fn test_vault_key_is_derived_from_environment_slug() {
        let project = d03_project_dir("my-api");
        let canonical = vault_key_for(&project, "staging", "token");

        for spelling in ["Staging", "STAGING", "  staging  "] {
            assert_eq!(
                vault_key_for(&project, spelling, "token"),
                canonical,
                "{spelling} should address the same secret as staging"
            );
        }

        assert_eq!(
            vault_key_for(&project, "my env", "token"),
            vault_key_for(&project, "my_env", "token"),
            "my env and my_env slugify to the same environment"
        );
    }

    // ---------------------------------------------------------------- D03 §二
    // Vault concurrency. These probes assert one thing precisely: the guard is
    // already held at the moment the snapshot is about to be read. They do not
    // stage a lost update — a correct implementation would block the second
    // writer on the lock, which deadlocks against releasing the first one.

    fn d03_reset_vault_creations() {
        vault_creations()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    fn d03_vault_creation_count() -> usize {
        vault_creations()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    #[test]
    fn test_vault_rmw_lock_is_alive_at_the_checkpoint() {
        for label in ["save_secret_value", "delete_secret_value"] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            configure_local_secret_storage_for_test();
            save_secret_value("K1", "v1").unwrap();
            save_secret_value("K2", "v2").unwrap();

            let probe = probe_lock_at_checkpoint("vault_rmw_enter", local_vault_tx(), move || {
                if label == "save_secret_value" {
                    save_secret_value("K3", "v3")
                } else {
                    delete_secret_value("K2")
                }
            });

            assert_named_lock_probe(label, &probe, LockVerdict::LockHeld);

            // Trailing state check. It carries no killing power - it passes
            // under every mutant this test targets - and is here only to show
            // the command did what it was asked.
            assert_eq!(load_secret_value("K1").unwrap(), "v1");
        }
    }

    #[test]
    fn test_unlock_lock_is_held_before_the_existence_check() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        clear_secret_vault_session();
        d03_reset_vault_creations();

        // Brand new HOME: the vault does not exist, so the child is about to
        // take the `None` branch. Holding the lock only around that branch is
        // not enough - the decision to enter it is the TOCTOU.
        let probe = probe_lock_at_checkpoint("vault_unlock_enter", local_vault_tx(), || {
            unlock_local_secret_storage("test-passphrase")
        });

        assert_named_lock_probe("unlock", &probe, LockVerdict::LockHeld);

        // Serial second unlock: proves the follow-up took the `Some` branch.
        // Like the check above it carries no killing power for this invariant.
        unlock_local_secret_storage("test-passphrase").unwrap();
        assert_eq!(
            d03_vault_creation_count(),
            1,
            "the vault was created more than once"
        );
    }

    // ------------------------------------------------- D03 §一 (migration)
    // Copying legacy vault entries forward, and recording the collisions the
    // old key scheme already caused before erasing the evidence of them.

    fn d03_env_file(home: &Path, project_slug: &str, env_stem: &str, secrets: bool) -> PathBuf {
        let suffix = if secrets {
            ".env.secrets.json"
        } else {
            ".env.json"
        };
        home.join("ApiSolo/projects")
            .join(project_slug)
            .join("environments")
            .join(format!("{env_stem}{suffix}"))
    }

    /// Writes secret metadata the way an older version did: a recorded vault
    /// key and no value.
    fn d03_write_recorded_metadata(path: &Path, rows: &[(&str, &str)]) {
        let variables: Vec<EnvVariable> = rows
            .iter()
            .map(|(key, vault_key)| EnvVariable {
                key: key.to_string(),
                value: String::new(),
                secret: true,
                vault_key: vault_key.to_string(),
            })
            .collect();
        std::fs::write(path, pretty_json(&variables).unwrap()).unwrap();
    }

    fn d03_read_metadata(path: &Path) -> Vec<EnvVariable> {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn d03_maintenance_json() -> serde_json::Value {
        match std::fs::read_to_string(vault_maintenance_path().unwrap()) {
            Ok(text) => serde_json::from_str(&text).unwrap(),
            Err(_) => serde_json::json!({}),
        }
    }

    fn d03_pending_prune() -> Vec<String> {
        d03_maintenance_json()
            .get("pendingPrune")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|value| value.as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn d03_env_value(project: &str, env: &str, key: &str) -> String {
        load_environment(project.to_string(), env.to_string())
            .unwrap()
            .variables
            .into_iter()
            .find(|variable| variable.key == key)
            .map(|variable| variable.value)
            .unwrap_or_default()
    }

    #[test]
    fn test_legacy_vault_entry_is_migrated_on_load() {
        // Upper case, underscore, punctuation and CJK: four shapes whose old
        // key differs from the new one.
        for env_name in ["My Env", "my_env", "prod!", "生产"] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Legacy".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();

            let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
            let stem = slugify(env_name);
            let legacy = legacy_vault_key_for(&project_dir, env_name, "token");
            let target = vault_key_for(&project_dir, env_name, "token");
            assert_ne!(legacy, target, "{env_name} needs no migration; bad fixture");

            save_secret_value(&legacy, "PROD-SECRET").unwrap();
            let secrets_path = d03_env_file(temp_home.path(), "legacy", &stem, true);
            d03_write_recorded_metadata(&secrets_path, &[("token", &legacy)]);

            assert_eq!(
                d03_env_value("Legacy", env_name, "token"),
                "PROD-SECRET",
                "{env_name}: value did not survive migration"
            );
            let metadata = d03_read_metadata(&secrets_path);
            assert_eq!(metadata[0].vault_key, target, "{env_name}: pointer not flipped");

            // Opening again must be stable, not a second migration.
            assert_eq!(d03_env_value("Legacy", env_name, "token"), "PROD-SECRET");

            // Half-migrated state: the value already sits under the new key but
            // the metadata still names the old one. Reopening self-heals.
            d03_write_recorded_metadata(&secrets_path, &[("token", &legacy)]);
            assert_eq!(
                d03_env_value("Legacy", env_name, "token"),
                "PROD-SECRET",
                "{env_name}: half-migrated state lost the value"
            );
            assert_eq!(d03_read_metadata(&secrets_path)[0].vault_key, target);
        }
    }

    #[test]
    fn test_migration_does_not_overwrite_existing_new_key_value() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
        let target = vault_key_for(&project_dir, "My Env", "token");
        save_secret_value(&legacy, "old").unwrap();
        save_secret_value(&target, "new").unwrap();

        let secrets_path = d03_env_file(temp_home.path(), "legacy", "my-env", true);
        d03_write_recorded_metadata(&secrets_path, &[("token", &legacy)]);

        assert_eq!(
            d03_env_value("Legacy", "My Env", "token"),
            "new",
            "migration overwrote a value the user had already entered"
        );
    }

    #[test]
    fn test_migration_prunes_unreferenced_legacy_vault_key() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
        save_secret_value(&legacy, "PROD-SECRET").unwrap();
        d03_write_recorded_metadata(
            &d03_env_file(temp_home.path(), "legacy", "my-env", true),
            &[("token", &legacy)],
        );

        assert_eq!(d03_env_value("Legacy", "My Env", "token"), "PROD-SECRET");
        assert_eq!(
            load_secret_value(&legacy).unwrap(),
            "",
            "the orphaned legacy entry is still in the vault"
        );
        assert!(d03_pending_prune().is_empty(), "queue was not resolved");
    }

    #[test]
    fn test_migration_keeps_legacy_vault_key_referenced_by_another_environment() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        // Two CJK names that the old scheme collapsed onto one slot.
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        assert_eq!(shared, legacy_vault_key_for(&project_dir, "测试", "token"));
        save_secret_value(&shared, "SURVIVOR").unwrap();

        for stem in ["生产", "测试"] {
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "legacy", stem, true),
                &[("token", &shared)],
            );
        }

        assert_eq!(d03_env_value("Legacy", "生产", "token"), "SURVIVOR");
        assert_eq!(
            load_secret_value(&shared).unwrap(),
            "SURVIVOR",
            "the shared legacy entry was deleted while 测试 still pointed at it"
        );
    }

    #[test]
    fn test_collided_environments_both_keep_the_surviving_secret() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        save_secret_value(&shared, "SURVIVOR").unwrap();
        for stem in ["生产", "测试"] {
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "legacy", stem, true),
                &[("token", &shared)],
            );
        }

        // Both environments end up holding a copy of the one value that
        // survived the old overwrite. Neither is blanked: an empty box reads as
        // "deleted", which misleads harder than a wrong value.
        assert_eq!(d03_env_value("Legacy", "生产", "token"), "SURVIVOR");
        assert_eq!(d03_env_value("Legacy", "测试", "token"), "SURVIVOR");

        let production = vault_key_for(&project_dir, "生产", "token");
        let staging = vault_key_for(&project_dir, "测试", "token");
        assert_ne!(production, staging);
        assert_eq!(load_secret_value(&production).unwrap(), "SURVIVOR");
        assert_eq!(load_secret_value(&staging).unwrap(), "SURVIVOR");

        // From now on they are independent.
        save_secret_value(&production, "REAL-PROD").unwrap();
        assert_eq!(load_secret_value(&staging).unwrap(), "SURVIVOR");
    }

    #[test]
    fn test_prune_is_skipped_when_a_secrets_metadata_file_is_unreadable() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        create_project("Unrelated".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
        save_secret_value(&legacy, "PROD-SECRET").unwrap();
        d03_write_recorded_metadata(
            &d03_env_file(temp_home.path(), "legacy", "my-env", true),
            &[("token", &legacy)],
        );

        // A broken file in a completely different project must stop the whole
        // round: better an orphan than a wrong deletion.
        std::fs::write(
            d03_env_file(temp_home.path(), "unrelated", "dev", true),
            "{ not json",
        )
        .unwrap();

        assert_eq!(d03_env_value("Legacy", "My Env", "token"), "PROD-SECRET");
        assert_eq!(
            load_secret_value(&legacy).unwrap(),
            "PROD-SECRET",
            "pruned against an index that was known to be incomplete"
        );
        assert_eq!(d03_pending_prune(), vec![legacy]);
    }

    #[test]
    fn test_prune_respects_implicit_reference_from_empty_vault_key() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        save_secret_value(&shared, "SHARED").unwrap();

        // 生产 records the key explicitly; 测试 is older still and records
        // nothing, so its reference exists only by derivation.
        d03_write_recorded_metadata(
            &d03_env_file(temp_home.path(), "legacy", "生产", true),
            &[("token", &shared)],
        );
        std::fs::write(
            d03_env_file(temp_home.path(), "legacy", "测试", true),
            r#"[{"key":"token","value":"","secret":true,"vault_key":""}]"#,
        )
        .unwrap();

        assert_eq!(d03_env_value("Legacy", "生产", "token"), "SHARED");
        assert_eq!(
            load_secret_value(&shared).unwrap(),
            "SHARED",
            "deleted a key that an old-format row still referenced implicitly"
        );
        assert_eq!(
            d03_env_value("Legacy", "测试", "token"),
            "SHARED",
            "测试 lost its value"
        );
    }

    #[test]
    fn test_collision_candidates_come_from_recorded_keys_only() {
        // (a) Two environments whose files differ but whose metadata names the
        // same old key. Recomputing a candidate from the file stem finds
        // neither, so the collision would go unrecorded and migration would
        // then erase the only evidence it ever happened.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Rec".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();

            let project_dir = temp_home.path().join("ApiSolo/projects/rec");
            let recorded = legacy_vault_key_for(&project_dir, "a_b", "token");
            // Fixture self-check: the two names really do land on different
            // files while sharing one recorded key.
            assert_eq!(slugify("a.b"), "ab");
            assert_eq!(slugify("a_b"), "a-b");
            assert_eq!(recorded, legacy_vault_key_for(&project_dir, "a.b", "token"));
            save_secret_value(&recorded, "SHARED").unwrap();

            for stem in ["ab", "a-b"] {
                d03_write_recorded_metadata(
                    &d03_env_file(temp_home.path(), "rec", stem, true),
                    &[("token", &recorded)],
                );
            }

            load_environment("Rec".to_string(), "a.b".to_string()).unwrap();

            let collisions = get_secret_key_collisions().unwrap();
            assert_eq!(collisions.len(), 1, "collision was not recorded");
            assert_eq!(
                collisions[0].legacy_vault_key, recorded,
                "recorded the recomputed guess instead of the key that really existed"
            );
            assert_eq!(collisions[0].variable_key, "token");
            assert_eq!(collisions[0].environments.len(), 2);
        }

        // (b) The recorded key points at something the vault no longer has,
        // while the *derived* key is one another environment genuinely uses.
        // Falling back to the derived candidate would copy that environment's
        // credential into this one - and sub-case (a) cannot see that at all.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Rec".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();

            let project_dir = temp_home.path().join("ApiSolo/projects/rec");
            let gone = format!(
                "rec:GONE:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("token")
            );
            let derived = legacy_vault_key_for(&project_dir, "生产", "token");
            assert_eq!(derived, legacy_vault_key_for(&project_dir, "测试", "token"));
            save_secret_value(&derived, "TEST-SECRET").unwrap();

            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "rec", "生产", true),
                &[("token", &gone)],
            );
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "rec", "测试", true),
                &[("token", &derived)],
            );

            assert_eq!(
                d03_env_value("Rec", "生产", "token"),
                "",
                "生产 was handed 测试's credential"
            );
            assert!(
                get_secret_key_collisions().unwrap().is_empty(),
                "invented a collision from a guessed key"
            );
            assert!(
                !d03_pending_prune().contains(&derived),
                "queued another environment's live key for deletion"
            );
            assert_eq!(load_secret_value(&derived).unwrap(), "TEST-SECRET");
        }
    }

    #[test]
    fn test_migration_aborts_when_collision_record_cannot_be_persisted() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        save_secret_value(&shared, "SURVIVOR").unwrap();
        let secrets_path = d03_env_file(temp_home.path(), "legacy", "生产", true);
        for stem in ["生产", "测试"] {
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "legacy", stem, true),
                &[("token", &shared)],
            );
        }

        // Only the record fails; scratch stays writable on purpose. An
        // unwritable scratch would also stop the queue write on the next line,
        // and then a version that drops the record's error would fail there
        // instead - same error, same intact vault, same unflipped pointer, so
        // nothing would distinguish it. Measured: under an unwritable scratch
        // that mutant survived the whole suite.
        let outcome = {
            let _failure = CollisionRecordFailure::on();
            load_environment("Legacy".to_string(), "生产".to_string())
        };

        assert!(
            outcome.is_err(),
            "load must fail when the collision record cannot land"
        );
        assert_eq!(
            load_secret_value(&shared).unwrap(),
            "SURVIVOR",
            "cleaned up the legacy key without recording the collision"
        );
        assert_eq!(
            d03_read_metadata(&secrets_path)[0].vault_key, shared,
            "flipped the pointer without recording the collision"
        );
    }

    #[test]
    fn test_collision_record_survives_reload_until_acknowledged() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        save_secret_value(&shared, "SURVIVOR").unwrap();
        for stem in ["生产", "测试"] {
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "legacy", stem, true),
                &[("token", &shared)],
            );
        }

        load_environment("Legacy".to_string(), "生产".to_string()).unwrap();
        assert_eq!(get_secret_key_collisions().unwrap().len(), 1);

        // Completing the migration, reloading either environment, and reading
        // the file again must all leave the record alone.
        for _ in 0..2 {
            load_environment("Legacy".to_string(), "生产".to_string()).unwrap();
            load_environment("Legacy".to_string(), "测试".to_string()).unwrap();
        }
        assert_eq!(
            get_secret_key_collisions().unwrap().len(),
            1,
            "the collision record was quietly dropped"
        );
        assert_eq!(
            d03_maintenance_json()["collisions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        acknowledge_secret_key_collision(shared).unwrap();
        assert!(get_secret_key_collisions().unwrap().is_empty());
    }

    // ---------------------------------------------------------------- D03 §四
    // Creating, saving and deleting environments.

    fn d03_env_dir_names(home: &Path, project_slug: &str) -> Vec<String> {
        d03_dir_file_names(
            &home
                .join("ApiSolo/projects")
                .join(project_slug)
                .join("environments"),
        )
    }

    fn d03_env(name: &str, variables: Vec<EnvVariable>) -> Environment {
        Environment {
            name: name.to_string(),
            variables,
        }
    }

    #[test]
    fn test_save_environment_rejects_conflicting_slug() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Slug".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        save_environment(
            "Slug".to_string(),
            d03_env("staging", vec![sample_env_variable("baseUrl", "http://a", false)]),
            Some(true),
        )
        .unwrap();

        for conflicting in ["STAGING", "Staging"] {
            let error = save_environment(
                "Slug".to_string(),
                d03_env(conflicting, vec![sample_env_variable("baseUrl", "http://b", false)]),
                Some(true),
            )
            .unwrap_err();
            assert!(
                error.contains("staging"),
                "the error must name the environment it collides with: {error}"
            );
        }

        // The original is untouched.
        let variables = load_environment("Slug".to_string(), "staging".to_string())
            .unwrap()
            .variables;
        assert_eq!(variables[0].value, "http://a");
    }

    #[test]
    fn test_conflicting_slug_rejection_touches_no_disk_state() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Slug".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        save_environment(
            "Slug".to_string(),
            d03_env("staging", vec![sample_env_variable("token", "secret", true)]),
            Some(true),
        )
        .unwrap();

        // Corrupt the metadata deliberately: rejecting must not "helpfully"
        // quarantine it on the way out, which would leave a renamed backup
        // behind and make the rejection visible on disk.
        let secrets_path = d03_env_file(temp_home.path(), "slug", "staging", true);
        let normal_path = d03_env_file(temp_home.path(), "slug", "staging", false);
        std::fs::write(&secrets_path, "{ not json").unwrap();

        let before_secrets = std::fs::read(&secrets_path).unwrap();
        let before_normal = std::fs::read(&normal_path).unwrap();
        let before_names = d03_env_dir_names(temp_home.path(), "slug");

        assert!(save_environment(
            "Slug".to_string(),
            d03_env("STAGING", vec![sample_env_variable("token", "other", true)]),
            Some(true),
        )
        .is_err());

        assert_eq!(std::fs::read(&secrets_path).unwrap(), before_secrets);
        assert_eq!(std::fs::read(&normal_path).unwrap(), before_normal);
        assert_eq!(
            d03_env_dir_names(temp_home.path(), "slug"),
            before_names,
            "the rejected save left a new file behind"
        );
    }

    #[test]
    fn test_save_environment_updates_existing_environment() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Slug".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        save_environment(
            "Slug".to_string(),
            d03_env("staging", vec![sample_env_variable("baseUrl", "http://a", false)]),
            Some(true),
        )
        .unwrap();

        // create=Some(false) and create=None are both updates and must pass
        // straight through the guard.
        for (label, create) in [("explicit-false", Some(false)), ("absent", None)] {
            save_environment(
                "Slug".to_string(),
                d03_env(
                    "staging",
                    vec![sample_env_variable("baseUrl", &format!("http://{label}"), false)],
                ),
                create,
            )
            .unwrap_or_else(|error| panic!("{label}: update was rejected: {error}"));

            let variables = load_environment("Slug".to_string(), "staging".to_string())
                .unwrap()
                .variables;
            assert_eq!(variables[0].value, format!("http://{label}"));
        }
    }

    #[test]
    fn test_save_environment_removes_vault_value_for_deleted_secret() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Del".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        save_environment(
            "Del".to_string(),
            d03_env(
                "dev",
                vec![
                    sample_env_variable("keep", "keep-value", true),
                    sample_env_variable("drop", "drop-value", true),
                ],
            ),
            Some(true),
        )
        .unwrap();

        let project_dir = temp_home.path().join("ApiSolo/projects/del");
        let dropped = vault_key_for(&project_dir, "dev", "drop");
        let kept = vault_key_for(&project_dir, "dev", "keep");
        assert_eq!(load_secret_value(&dropped).unwrap(), "drop-value");

        save_environment(
            "Del".to_string(),
            d03_env("dev", vec![sample_env_variable("keep", "keep-value", true)]),
            None,
        )
        .unwrap();

        assert_eq!(
            load_secret_value(&dropped).unwrap(),
            "",
            "the removed secret's value is still in the backend"
        );
        assert_eq!(load_secret_value(&kept).unwrap(), "keep-value");
    }

    #[test]
    fn test_save_environment_removes_vault_value_for_renamed_or_demoted_secret() {
        for (label, replacement) in [
            ("renamed", sample_env_variable("tokenV2", "token-value", true)),
            ("demoted", sample_env_variable("token", "token-value", false)),
        ] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Ren".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();

            save_environment(
                "Ren".to_string(),
                d03_env("dev", vec![sample_env_variable("token", "token-value", true)]),
                Some(true),
            )
            .unwrap();

            let project_dir = temp_home.path().join("ApiSolo/projects/ren");
            let original = vault_key_for(&project_dir, "dev", "token");
            assert_eq!(load_secret_value(&original).unwrap(), "token-value");

            save_environment("Ren".to_string(), d03_env("dev", vec![replacement]), None).unwrap();

            assert_eq!(
                load_secret_value(&original).unwrap(),
                "",
                "{label}: the old vault entry outlived the variable"
            );
        }
    }

    #[test]
    fn test_save_environment_quarantines_unreadable_secret_metadata() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Quar".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let secrets_path = d03_env_file(temp_home.path(), "quar", "dev", true);
        std::fs::create_dir_all(secrets_path.parent().unwrap()).unwrap();
        let original = br#"[{"key":"token","value":"","secret":true,"vault_key":"#.to_vec();
        std::fs::write(&secrets_path, &original).unwrap();

        // Update path: no `create` flag, so the guard does not fire.
        save_environment(
            "Quar".to_string(),
            d03_env("dev", vec![sample_env_variable("token", "fresh", true)]),
            None,
        )
        .unwrap();

        let quarantined: Vec<String> = d03_env_dir_names(temp_home.path(), "quar")
            .into_iter()
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "expected exactly one quarantined file, saw {quarantined:?}"
        );
        assert!(quarantined[0].starts_with("dev.env.secrets.corrupt-"));
        assert_eq!(
            std::fs::read(
                temp_home
                    .path()
                    .join("ApiSolo/projects/quar/environments")
                    .join(&quarantined[0])
            )
            .unwrap(),
            original,
            "the quarantined file's bytes were modified"
        );
    }

    #[test]
    fn test_load_environment_fails_loudly_on_unreadable_environment_file() {
        for secrets in [false, true] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Loud".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();

            save_environment(
                "Loud".to_string(),
                d03_env("dev", vec![sample_env_variable("baseUrl", "http://a", false)]),
                Some(true),
            )
            .unwrap();

            let path = d03_env_file(temp_home.path(), "loud", "dev", secrets);
            std::fs::write(&path, "{ not json").unwrap();

            // Rendering an unreadable environment as empty is the lie that
            // makes the next save wipe it.
            assert!(
                load_environment("Loud".to_string(), "dev".to_string()).is_err(),
                "secrets={secrets}: an unreadable environment loaded as empty"
            );
        }
    }

    #[test]
    fn test_delete_environment_keeps_secrets_another_environment_still_uses() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        // Un-migrated collided pair: both name the same old key.
        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let shared = legacy_vault_key_for(&project_dir, "生产", "token");
        save_secret_value(&shared, "SURVIVOR").unwrap();
        for stem in ["生产", "测试"] {
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "legacy", stem, true),
                &[("token", &shared)],
            );
        }

        delete_environment("Legacy".to_string(), "测试".to_string()).unwrap();

        assert_eq!(
            load_secret_value(&shared).unwrap(),
            "SURVIVOR",
            "deleting 测试 took 生产's token with it"
        );
        assert_eq!(d03_env_value("Legacy", "生产", "token"), "SURVIVOR");
    }

    // ------------------------------------------- D03 §一/§三 (maintenance)
    // The maintenance file's lock, and the cleanup queue's survival across
    // every way a round can fail to finish.

    fn d03_seed_maintenance(collisions: &[&str], pending: &[&str]) {
        let snapshot = MaintenanceSnapshot {
            version: MAINTENANCE_VERSION,
            collisions: collisions
                .iter()
                .map(|key| SecretKeyCollision {
                    legacy_vault_key: (*key).to_string(),
                    variable_key: "token".to_string(),
                    environments: vec![
                        EnvironmentRef {
                            project: "legacy".to_string(),
                            environment: "生产".to_string(),
                        },
                        EnvironmentRef {
                            project: "legacy".to_string(),
                            environment: "测试".to_string(),
                        },
                    ],
                    detected_at: "2026-08-18T00:00:00Z".to_string(),
                })
                .collect(),
            pending_prune: pending.iter().map(|key| (*key).to_string()).collect(),
            last_failure: None,
        };
        write_maintenance_snapshot(&snapshot).unwrap();
    }

    fn d03_last_failure() -> Option<serde_json::Value> {
        d03_maintenance_json()
            .get("lastFailure")
            .filter(|value| !value.is_null())
            .cloned()
    }

    /// Asserts the failure marker records a classification and nothing else.
    /// A structural check, not a search for a particular error string: a
    /// negative assertion would pass simply because the injected sentinel never
    /// appeared in serde's message.
    fn d03_assert_failure_marker(kind: &str) {
        let failure = d03_last_failure().expect("no failure marker was written");
        let object = failure.as_object().expect("lastFailure is not an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["at", "kind"],
            "the failure marker carries fields beyond the classification"
        );
        assert_eq!(object["kind"], serde_json::json!(kind));
        assert!(
            !object["at"].as_str().unwrap_or_default().is_empty(),
            "failure marker has no timestamp"
        );
    }

    struct CollisionRecordFailure;

    impl CollisionRecordFailure {
        fn on() -> Self {
            set_collision_record_failure(true);
            Self
        }
    }

    impl Drop for CollisionRecordFailure {
        fn drop(&mut self) {
            set_collision_record_failure(false);
        }
    }

    struct SystemVaultFailure;

    impl SystemVaultFailure {
        fn on() -> Self {
            set_system_secret_vault_failure(true);
            Self
        }
    }

    impl Drop for SystemVaultFailure {
        fn drop(&mut self) {
            set_system_secret_vault_failure(false);
        }
    }

    fn d03_reset_system_vault() {
        test_system_secret_vault()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        set_system_secret_vault_failure(false);
    }

    #[test]
    fn test_maintenance_lock_is_alive_at_the_checkpoint() {
        for function in [
            "record_vault_key_collisions",
            "acknowledge_secret_key_collision",
            "enqueue_pending_prune",
            "read_pending_prune",
            "resolve_pending_prune",
        ] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            d03_seed_maintenance(&["GROUP-A", "GROUP-B"], &["queued"]);

            let probe =
                probe_lock_at_checkpoint("maintenance_enter", vault_maintenance_tx(), move || {
                    match function {
                        "record_vault_key_collisions" => {
                            let index = VaultKeyIndex {
                                refs: BTreeMap::new(),
                                complete: true,
                            };
                            record_vault_key_collisions(&["queued".to_string()], &index)
                        }
                        "acknowledge_secret_key_collision" => {
                            acknowledge_secret_key_collision("GROUP-A".to_string())
                        }
                        "enqueue_pending_prune" => enqueue_pending_prune(&["other".to_string()]),
                        "read_pending_prune" => read_pending_prune().map(|_| ()),
                        _ => resolve_pending_prune(&["queued".to_string()]),
                    }
                });

            assert_named_lock_probe(function, &probe, LockVerdict::LockHeld);
        }

        // One installed gate, two arrivals: the second must pass straight
        // through. Otherwise any correct implementation that touches the file
        // twice deadlocks against a test that releases once.
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        d03_seed_maintenance(&["GROUP-A", "GROUP-B"], &[]);

        let probe = probe_lock_at_checkpoint("maintenance_enter", vault_maintenance_tx(), || {
            enqueue_pending_prune(&["queued-by-child".to_string()])?;
            acknowledge_secret_key_collision("GROUP-A".to_string())
        });
        assert_named_lock_probe("two arrivals", &probe, LockVerdict::LockHeld);

        let remaining = get_secret_key_collisions().unwrap();
        assert_eq!(
            remaining.len(),
            1,
            "the second call never completed: {remaining:?}",
            remaining = remaining
                .iter()
                .map(|collision| collision.legacy_vault_key.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(remaining[0].legacy_vault_key, "GROUP-B");
        assert_eq!(d03_pending_prune(), vec!["queued-by-child".to_string()]);
    }

    #[test]
    fn test_pending_prune_survives_every_interruption_point() {
        // (a) Reading the queue is non-destructive. An earlier design took the
        // queue out of the file first; a crash before the deletion then lost
        // the cleanup intent for good.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            d03_seed_maintenance(&[], &["orphan-key"]);
            let before = std::fs::read(vault_maintenance_path().unwrap()).unwrap();

            assert_eq!(read_pending_prune().unwrap(), vec!["orphan-key".to_string()]);

            assert_eq!(
                std::fs::read(vault_maintenance_path().unwrap()).unwrap(),
                before,
                "reading the queue rewrote the file"
            );
        }

        // (b) Interrupted between the delete and the resolve: the entry is
        // already gone from the backend, so the retry confirms it and clears
        // the queue rather than blocking on it forever.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Retry".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();
            save_environment(
                "Retry".to_string(),
                d03_env("dev", vec![sample_env_variable("token", "value", true)]),
                Some(true),
            )
            .unwrap();
            d03_seed_maintenance(&[], &["already-deleted-key"]);

            load_environment("Retry".to_string(), "dev".to_string()).unwrap();

            assert!(
                d03_pending_prune().is_empty(),
                "a key confirmed absent stayed queued forever"
            );
        }

        // (c) The index could not be trusted because of an unrelated broken
        // file. Nothing is deleted and nothing leaves the queue.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Retry".to_string(), String::new()).unwrap();
            create_project("Unrelated".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();
            save_environment(
                "Retry".to_string(),
                d03_env("dev", vec![sample_env_variable("token", "value", true)]),
                Some(true),
            )
            .unwrap();
            save_secret_value("orphan-key", "orphan-value").unwrap();
            d03_seed_maintenance(&[], &["orphan-key"]);
            std::fs::write(
                d03_env_file(temp_home.path(), "unrelated", "dev", true),
                "{ not json",
            )
            .unwrap();

            load_environment("Retry".to_string(), "dev".to_string()).unwrap();

            assert_eq!(d03_pending_prune(), vec!["orphan-key".to_string()]);
            assert_eq!(load_secret_value("orphan-key").unwrap(), "orphan-value");
            d03_assert_failure_marker("index-incomplete");
        }

        // (d) Still referenced by another environment: it stays queued while
        // the rest of the batch completes.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Retry".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();
            save_environment(
                "Retry".to_string(),
                d03_env("dev", vec![sample_env_variable("token", "value", true)]),
                Some(true),
            )
            .unwrap();
            save_environment(
                "Retry".to_string(),
                d03_env("other", vec![sample_env_variable("token", "other", true)]),
                Some(true),
            )
            .unwrap();

            let project_dir = temp_home.path().join("ApiSolo/projects/retry");
            let referenced = vault_key_for(&project_dir, "other", "token");
            save_secret_value("free-orphan", "gone-soon").unwrap();
            d03_seed_maintenance(&[], &[&referenced, "free-orphan"]);

            load_environment("Retry".to_string(), "dev".to_string()).unwrap();

            assert_eq!(
                d03_pending_prune(),
                vec![referenced.clone()],
                "the referenced key left the queue, or the free one did not"
            );
            assert_eq!(load_secret_value(&referenced).unwrap(), "other");
            assert_eq!(load_secret_value("free-orphan").unwrap(), "");
        }

        // (e) The backend genuinely refuses. Driven through load_environment,
        // not through the helper: the mutant this kills lives in the caller,
        // and calling the helper directly leaves pending unchanged either way.
        //
        // The refusal is injected in the keychain stub rather than by making
        // scratch read-only, because an unwritable scratch would also stop the
        // wrong-resolve mutant from shortening the queue and the test would
        // pass under it.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            d03_reset_system_vault();
            create_project("Retry".to_string(), String::new()).unwrap();
            configure_secret_storage("system-keychain".to_string(), None).unwrap();

            let project_dir = temp_home.path().join("ApiSolo/projects/retry");
            let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
            let target = vault_key_for(&project_dir, "My Env", "token");
            save_secret_value(&legacy, "LEGACY-SECRET").unwrap();
            d03_write_recorded_metadata(
                &d03_env_file(temp_home.path(), "retry", "my-env", true),
                &[("token", &legacy)],
            );

            {
                let _failure = SystemVaultFailure::on();
                // Cleanup failure must not block the user.
                assert_eq!(
                    d03_env_value("Retry", "My Env", "token"),
                    "LEGACY-SECRET",
                    "a failed cleanup blocked the load"
                );
                assert_eq!(
                    d03_pending_prune(),
                    vec![legacy.clone()],
                    "the queue was cleared even though the delete failed"
                );
                assert_eq!(load_secret_value(&legacy).unwrap(), "LEGACY-SECRET");
                d03_assert_failure_marker("backend-delete");
            }

            // Fault cleared: the retry finishes on the next load.
            assert_eq!(d03_env_value("Retry", "My Env", "token"), "LEGACY-SECRET");
            assert_eq!(load_secret_value(&legacy).unwrap(), "");
            assert_eq!(load_secret_value(&target).unwrap(), "LEGACY-SECRET");
            assert!(d03_pending_prune().is_empty());
            d03_reset_system_vault();
        }

        // (f) delete_environment drains the queue before its "does not exist"
        // early return. A previous call may have removed the files without
        // finishing cleanup, and this is the only entry point a user retries.
        {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            create_project("Retry".to_string(), String::new()).unwrap();
            configure_local_secret_storage_for_test();
            save_secret_value("left-behind", "still-here").unwrap();
            d03_seed_maintenance(&[], &["left-behind"]);

            let outcome = delete_environment("Retry".to_string(), "gone".to_string());

            assert!(outcome.is_err(), "the environment really is absent");
            assert_eq!(
                load_secret_value("left-behind").unwrap(),
                "",
                "the early return skipped the queue"
            );
            assert!(d03_pending_prune().is_empty());
        }
    }

    /// Saving a secret writes its value into the backend first and publishes
    /// the metadata that names it afterwards. In between, the value exists and
    /// nothing on disk references it - and the cleanup thread's own composite,
    /// "scan for references, then delete what nothing names", straddles exactly
    /// that gap. A key left in the queue by an earlier round and then typed in
    /// again by the user is deleted between the two writes, after which the
    /// environment points at an empty vault slot for good.
    ///
    /// Driven through `delete_environment`, which drains the queue ahead of its
    /// "does not exist" early return: the deletion this reproduces happens
    /// inside a production entry point, not in a helper called by hand.
    ///
    /// The wait below is not what makes the outcome deterministic. Without the
    /// exclusion the cleanup runs to completion on local files in milliseconds;
    /// with it the cleanup cannot proceed until the parked save is released, so
    /// the scan that follows sees the published metadata. The assertion reads
    /// the same either way - the value that was saved is still there, or it is
    /// not.
    #[test]
    fn test_a_queued_key_is_not_pruned_while_it_is_being_saved() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Race".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/race");
        let key = vault_key_for(&project_dir, "dev", "token");

        // The state an interrupted cleanup round leaves behind: the key is
        // queued for deletion and nothing on disk names it.
        d03_seed_maintenance(&[], &[&key]);
        assert_eq!(
            d03_pending_prune(),
            vec![key.clone()],
            "fixture: the queue was not seeded, so nothing here could prune"
        );

        let saved_key = key.clone();
        let run = with_thread_parked_at(
            "secret_values_written",
            move || {
                save_environment(
                    "Race".to_string(),
                    d03_env("dev", vec![sample_env_variable("token", "RESTORED", true)]),
                    Some(true),
                )
            },
            || {
                let (finished_tx, finished_rx) = std::sync::mpsc::channel();
                let cleanup = std::thread::spawn(move || {
                    let outcome = delete_environment("Race".to_string(), "gone".to_string());
                    let _ = finished_tx.send(());
                    outcome
                });
                let finished = finished_rx
                    .recv_timeout(Duration::from_secs(2))
                    .is_ok();
                (cleanup, finished)
            },
        );

        let (cleanup, cleanup_finished_while_parked) = run
            .probe
            .expect("the save never reached the checkpoint, so no interleaving was tested");
        let cleanup_outcome = match cleanup.join() {
            Ok(outcome) => format!("{outcome:?}"),
            Err(_) => "panicked".to_string(),
        };

        assert_eq!(
            load_secret_value(&saved_key).unwrap(),
            "RESTORED",
            "the cleanup deleted the value this save had just written \
             (cleanup finished while the save was parked: {cleanup_finished_while_parked}, \
             cleanup returned {cleanup_outcome}, save returned {returned:?}, child_ok={child_ok})",
            returned = run.returned,
            child_ok = run.child_ok
        );
    }

    /// The second half of the same window, on the other side of the pair.
    /// R2 closed the gap between writing a secret and publishing the metadata
    /// naming it; this one is the gap between *reading* that metadata and
    /// rewriting it. A load reads the file, migration decides what the file
    /// should say, and the file is rewritten from that decision - so a save
    /// that lands in between is not merely raced, it is erased: the load
    /// rewrites the metadata from a list that predates the new variable, and
    /// the value saved for it stays in the vault with nothing naming it.
    ///
    /// The save reports success, which is what makes this worse than a lost
    /// update. Nothing at any layer says the variable did not survive.
    #[test]
    fn test_a_stale_load_cannot_erase_a_secret_saved_while_it_was_reading() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Race".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        // Old-format metadata, so the load has migration work to do and really
        // does reach the rewrite. Without that `changed` stays false and the
        // load never writes, which would make this test pass for a reason that
        // has nothing to do with the lock.
        let project_dir = temp_home.path().join("ApiSolo/projects/race");
        let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
        save_secret_value(&legacy, "LEGACY-A").unwrap();
        d03_write_recorded_metadata(
            &d03_env_file(temp_home.path(), "race", "my-env", true),
            &[("token", &legacy)],
        );

        let run = with_thread_parked_at(
            "environment_metadata_read",
            || load_environment("Race".to_string(), "My Env".to_string()).map(|_| ()),
            || {
                let (finished_tx, finished_rx) = std::sync::mpsc::channel();
                let save = std::thread::spawn(move || {
                    let outcome = save_environment(
                        "Race".to_string(),
                        d03_env(
                            "My Env",
                            vec![
                                sample_env_variable("token", "LEGACY-A", true),
                                sample_env_variable("added", "NEW-B", true),
                            ],
                        ),
                        None,
                    );
                    let _ = finished_tx.send(());
                    outcome
                });
                let finished = finished_rx.recv_timeout(Duration::from_secs(2)).is_ok();
                (save, finished)
            },
        );

        let (save, save_finished_while_parked) = run
            .probe
            .expect("the load never reached the checkpoint, so no interleaving was tested");
        let save_outcome = match save.join() {
            Ok(outcome) => format!("{outcome:?}"),
            Err(_) => "panicked".to_string(),
        };

        assert_eq!(
            d03_env_value("Race", "My Env", "added"),
            "NEW-B",
            "a load that had already read the old metadata rewrote it and dropped the \
             variable this save added (save finished while the load was parked: \
             {save_finished_while_parked}, save returned {save_outcome}, load returned \
             {returned:?}, child_ok={child_ok})",
            returned = run.returned,
            child_ok = run.child_ok
        );
    }

    // ------------------------------------------------ D03 §六 (every writer)
    // Each of the nine production writers, driven through its own command with
    // its target directory read-only. Testing write_atomic alone proves nothing
    // about whether a given call site actually uses it.
    //
    // Why a read-only directory: it stops `create_new` from making a temp file,
    // but it does NOT stop `fs::write` from opening an existing file and
    // truncating it. So a call site reverted to fs::write shows up as a changed
    // target, which is exactly the damage this invariant is about.

    fn d03_with_readonly_dir<T>(dir: &Path, body: impl FnOnce() -> T) -> T {
        let restore = std::fs::metadata(dir).unwrap().permissions();
        let mut readonly = restore.clone();
        std::os::unix::fs::PermissionsExt::set_mode(&mut readonly, 0o555);
        std::fs::set_permissions(dir, readonly).unwrap();
        let outcome = body();
        std::fs::set_permissions(dir, restore).unwrap();
        outcome
    }

    /// The list below is derived from the producing side, not copied from the
    /// plan. Copying the plan is how it went wrong the first time: the table
    /// was the spec's nine-row survey of the writes that existed when the spec
    /// was written, so `write_maintenance_snapshot` - added by this same slice,
    /// after that survey - was never in it and nothing noticed.
    ///
    /// Regenerate with, over the production half of this file:
    ///   grep -n 'write_atomic(' src-tauri/src/lib.rs
    ///   grep -n 'fs::write(\|File::create(' src-tauri/src/lib.rs
    ///
    /// Ten call sites, all covered below: write_history_entries,
    /// write_project_meta, write_secret_storage_config, write_local_secret_map,
    /// write_maintenance_snapshot, write_secret_metadata, save_request,
    /// rename_request, move_request, and save_environment's plain file.
    ///
    /// One `fs::write` survives on purpose, for window-state.json, which
    /// PRODUCT lists as a non-goal: it is regenerated from scratch on every
    /// launch and losing it costs a window size. The history file's
    /// pre-creation used to be the second one and is now gone entirely.
    #[test]
    fn test_every_production_writer_leaves_target_intact_on_failure() {
        for writer in [
            "write_history_entries",
            "write_project_meta",
            "write_secret_storage_config",
            "write_local_secret_map",
            "write_maintenance_snapshot",
            "write_secret_metadata",
            "save_request",
            "rename_request",
            "move_request",
            "save_environment_normal_file",
        ] {
            let _guard = lock_env();
            let temp_home = tempdir().unwrap();
            let _home_guard = HomeGuard::set(temp_home.path());
            d03_reset_system_vault();

            let scratch = temp_home.path().join("ApiSolo/scratch");
            let project_dir = temp_home.path().join("ApiSolo/projects/writers");
            let collections = project_dir.join("collections");
            let environments = project_dir.join("environments");

            // Every case needs the target to already exist with known bytes;
            // otherwise `fs::write` would fail too and the mutant would hide
            // behind the same error.
            let (target, dir, action): (PathBuf, PathBuf, Box<dyn Fn() -> Result<(), String>>) =
                match writer {
                    "write_history_entries" => {
                        append_history(sample_history_entry("A", "2026-03-27T10:00:00Z")).unwrap();
                        (
                            history_file_path().unwrap(),
                            scratch.clone(),
                            Box::new(|| {
                                append_history(sample_history_entry("B", "2026-03-27T10:01:00Z"))
                            }),
                        )
                    }
                    "write_project_meta" => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        save_request(
                            "Writers".to_string(),
                            String::new(),
                            sample_saved_request("Req", "GET", "http://example.com/"),
                            None,
                        )
                        .unwrap();
                        (
                            project_dir.join(PROJECT_META_FILE),
                            project_dir.clone(),
                            Box::new(|| {
                                // Ends in touch_project; collections/ is still
                                // writable, so only the meta write can fail.
                                save_request(
                                    "Writers".to_string(),
                                    String::new(),
                                    sample_saved_request("Req", "POST", "http://example.com/"),
                                    Some("req.request.json".to_string()),
                                )
                            }),
                        )
                    }
                    "write_secret_storage_config" => {
                        configure_secret_storage("system-keychain".to_string(), None).unwrap();
                        (
                            secret_storage_config_path().unwrap(),
                            scratch.clone(),
                            Box::new(|| {
                                configure_secret_storage("system-keychain".to_string(), None)
                                    .map(|_| ())
                            }),
                        )
                    }
                    "write_local_secret_map" => {
                        configure_local_secret_storage_for_test();
                        save_secret_value("K1", "v1").unwrap();
                        (
                            local_secret_vault_path().unwrap(),
                            scratch.clone(),
                            Box::new(|| save_secret_value("K2", "v2")),
                        )
                    }
                    "write_maintenance_snapshot" => {
                        // Seeded so the target already holds bytes. Without
                        // that the read-only directory would fail an
                        // fs::write too, for want of a file to truncate, and
                        // the two spellings would be indistinguishable.
                        let key = "writers:dev:dG9rZW4".to_string();
                        enqueue_pending_prune(std::slice::from_ref(&key)).unwrap();
                        (
                            vault_maintenance_path().unwrap(),
                            scratch.clone(),
                            // Rewrites the file whether or not the key matches
                            // anything, so the write is reached unconditionally.
                            Box::new(move || acknowledge_secret_key_collision(key.clone())),
                        )
                    }
                    "write_secret_metadata" => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        configure_local_secret_storage_for_test();
                        let legacy = legacy_vault_key_for(&project_dir, "My Env", "token");
                        save_secret_value(&legacy, "LEGACY").unwrap();
                        let path = d03_env_file(temp_home.path(), "writers", "my-env", true);
                        d03_write_recorded_metadata(&path, &[("token", &legacy)]);
                        (
                            path,
                            environments.clone(),
                            // A pending migration reaches write_secret_metadata
                            // without writing the plain .env.json first.
                            Box::new(|| {
                                load_environment("Writers".to_string(), "My Env".to_string())
                                    .map(|_| ())
                            }),
                        )
                    }
                    "save_request" => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        save_request(
                            "Writers".to_string(),
                            String::new(),
                            sample_saved_request("Req", "GET", "http://example.com/"),
                            None,
                        )
                        .unwrap();
                        (
                            collections.join("req.request.json"),
                            collections.clone(),
                            Box::new(|| {
                                save_request(
                                    "Writers".to_string(),
                                    String::new(),
                                    sample_saved_request("Req", "POST", "http://example.com/"),
                                    Some("req.request.json".to_string()),
                                )
                            }),
                        )
                    }
                    "rename_request" => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        save_request(
                            "Writers".to_string(),
                            String::new(),
                            sample_saved_request("Req", "GET", "http://example.com/"),
                            None,
                        )
                        .unwrap();
                        (
                            collections.join("req.request.json"),
                            collections.clone(),
                            // Same slug, so no fs::rename happens and the
                            // rewrite is the only thing that can fail.
                            Box::new(|| {
                                rename_request(
                                    "Writers".to_string(),
                                    "req.request.json".to_string(),
                                    "REQ".to_string(),
                                )
                            }),
                        )
                    }
                    "move_request" => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        create_collection(
                            "Writers".to_string(),
                            "archive".to_string(),
                            String::new(),
                        )
                        .unwrap();
                        save_request(
                            "Writers".to_string(),
                            String::new(),
                            sample_saved_request("Req", "GET", "http://example.com/"),
                            None,
                        )
                        .unwrap();
                        (
                            collections.join("req.request.json"),
                            collections.join("archive"),
                            Box::new(|| {
                                move_request(
                                    "Writers".to_string(),
                                    "req.request.json".to_string(),
                                    "archive".to_string(),
                                )
                            }),
                        )
                    }
                    _ => {
                        create_project("Writers".to_string(), String::new()).unwrap();
                        configure_local_secret_storage_for_test();
                        save_environment(
                            "Writers".to_string(),
                            d03_env(
                                "dev",
                                vec![sample_env_variable("baseUrl", "http://a", false)],
                            ),
                            Some(true),
                        )
                        .unwrap();
                        (
                            d03_env_file(temp_home.path(), "writers", "dev", false),
                            environments.clone(),
                            Box::new(|| {
                                save_environment(
                                    "Writers".to_string(),
                                    d03_env(
                                        "dev",
                                        vec![sample_env_variable("baseUrl", "http://b", false)],
                                    ),
                                    None,
                                )
                            }),
                        )
                    }
                };

            let before = std::fs::read(&target).unwrap_or_else(|error| {
                panic!("{writer}: fixture target {} missing: {error}", target.display())
            });

            let outcome = d03_with_readonly_dir(&dir, action);

            assert!(
                outcome.is_err(),
                "{writer}: the command reported success although its directory was read-only"
            );
            assert_eq!(
                std::fs::read(&target).unwrap(),
                before,
                "{writer}: the target was modified by a write that failed"
            );

            // move_request is the one call site the read-only probe cannot
            // speak about. Its destination is guaranteed not to exist — the
            // command rejects an occupied target before it writes anything —
            // so there is no old content for a truncating write to destroy,
            // and `fs::write` fails on a read-only directory for exactly the
            // same reason `create_new` does. Measured, not assumed: reverting
            // this call site to `fs::write` left all 183 tests green, while
            // the other eight sites each turned this test red.
            //
            // What stays observable is whether the destination goes through
            // write_atomic at all, so run the move for real and look for the
            // temp file it must have left in the destination directory.
            if writer == "move_request" {
                d03_reset_atomic_temp_log();
                move_request(
                    "Writers".to_string(),
                    "req.request.json".to_string(),
                    "archive".to_string(),
                )
                .unwrap();
                let temps = d03_recorded_atomic_temp_paths();
                assert!(
                    temps.iter().any(|temp| temp.parent() == Some(dir.as_path())),
                    "move_request wrote its destination without write_atomic; \
                     temp files recorded: {temps:?}"
                );
            }
        }
    }

    #[test]
    fn test_setting_up_the_data_directory_never_touches_the_history_file() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        // Preparing the data directory used to create an empty history file
        // behind an exists() check. Two callers could both find it missing,
        // and the one that resumed second would blank whatever the first had
        // written in between - a truncating write, on user data, and the only
        // one in the directory that never went through write_atomic.
        let history_path = data_dir().unwrap().join("scratch").join("history.jsonl");
        assert!(
            !history_path.exists(),
            "preparing the data directory created the history file"
        );

        // Absent is not broken; it means no history yet.
        assert!(load_history().unwrap().is_empty());
        assert_eq!(get_history_health().unwrap().skipped_lines, 0);

        append_history(sample_history_entry("A", "2026-03-27T10:00:00Z")).unwrap();
        let after_first = std::fs::read(&history_path).unwrap();
        assert!(!after_first.is_empty());

        // Every command prepares the directory first, so this runs constantly
        // against a file that already holds entries.
        data_dir().unwrap();
        assert_eq!(
            std::fs::read(&history_path).unwrap(),
            after_first,
            "preparing the data directory rewrote an existing history file"
        );
        assert_eq!(load_history().unwrap().len(), 1);
    }

    #[test]
    fn test_delete_environment_quarantines_unreadable_secret_metadata() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        create_project("Legacy".to_string(), String::new()).unwrap();
        configure_local_secret_storage_for_test();

        let project_dir = temp_home.path().join("ApiSolo/projects/legacy");
        let owned = vault_key_for(&project_dir, "dev", "token");
        save_secret_value(&owned, "STILL-IN-THE-VAULT").unwrap();

        let normal_path = d03_env_file(temp_home.path(), "legacy", "dev", false);
        std::fs::write(&normal_path, "[]").unwrap();
        let secrets_path = d03_env_file(temp_home.path(), "legacy", "dev", true);
        let corrupt = b"{ this is not the metadata it used to be".to_vec();
        std::fs::write(&secrets_path, &corrupt).unwrap();

        delete_environment("Legacy".to_string(), "dev".to_string()).unwrap();

        // The user asked for the environment to go, and it is gone.
        assert!(!normal_path.exists());
        assert!(!secrets_path.exists());
        assert!(!list_environments("Legacy".to_string())
            .unwrap()
            .contains(&"dev".to_string()));

        // But its bytes are not gone. They are the only surviving record of
        // which vault entries this environment owned, and deleting them left
        // those entries in the vault with nothing left on disk naming them -
        // unreachable and undeletable, which is the defect this slice exists
        // to fix. Loading refuses outright and saving renames the file aside;
        // deleting now matches saving.
        let env_dir = temp_home.path().join("ApiSolo/projects/legacy/environments");
        let quarantined: Vec<PathBuf> = std::fs::read_dir(&env_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".corrupt-"))
            })
            .collect();
        assert_eq!(quarantined.len(), 1, "expected one quarantined file");
        assert_eq!(
            std::fs::read(&quarantined[0]).unwrap(),
            corrupt,
            "the quarantined bytes were not preserved"
        );

        // Renaming a file back is what both READMEs tell the user to do, so
        // the name has to be one the environment list ignores until then.
        assert_eq!(load_secret_value(&owned).unwrap(), "STILL-IN-THE-VAULT");
    }

    #[test]
    fn test_quarantine_never_overwrites_an_earlier_copy_from_the_same_second() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());
        let dir = temp_home.path();

        // The name carries a timestamp that only resolves to a second, and
        // rename replaces silently. Two quarantines inside one second used to
        // leave the first destroyed - the file whose entire purpose is to be
        // the last surviving copy.
        //
        // Both candidate seconds are occupied up front so the collision does
        // not depend on which side of a tick the call lands.
        let source = dir.join("dev.env.secrets.json");
        std::fs::write(&source, b"the corrupt bytes").unwrap();

        let mut blocked = Vec::new();
        for offset in [0_i64, 1] {
            let stamp = (Utc::now() + chrono::Duration::seconds(offset))
                .format("%Y%m%dT%H%M%SZ")
                .to_string();
            let path = dir.join(format!("dev.env.secrets.corrupt-{stamp}.json"));
            std::fs::write(&path, format!("earlier copy {offset}")).unwrap();
            blocked.push(path);
        }

        let target = quarantine_unreadable_file(&source).unwrap();

        assert!(
            !blocked.contains(&target),
            "quarantine landed on a name that was already taken: {}",
            target.display()
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"the corrupt bytes");
        for (offset, path) in blocked.iter().enumerate() {
            assert_eq!(
                std::fs::read(path).unwrap(),
                format!("earlier copy {offset}").into_bytes(),
                "an earlier quarantined copy was overwritten: {}",
                path.display()
            );
        }
        assert!(!source.exists());
    }

    // --------------------------------------- the harness checking itself (P9)
    // The probe protocol was validated on a standalone model before it was
    // written here, and the model is not the harness. These two fixtures drive
    // the real one through the branches the model covered: a child that panics
    // while holding the lock, and a lock that is already poisoned when the
    // probe looks at it. Both are infrastructure failures that must not be
    // reported as lock verdicts - a poisoned result carries an acquired guard,
    // so folding it into "held" would state the opposite of the truth.

    fn d03_without_panic_output<T>(body: impl FnOnce() -> T) -> T {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let outcome = body();
        std::panic::set_hook(previous);
        outcome
    }

    #[test]
    fn test_the_probe_reports_a_child_that_panics_and_leaves_the_lock_usable() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let probe = d03_without_panic_output(|| {
            probe_lock_at_checkpoint("maintenance_enter", vault_maintenance_tx(), || {
                let _held = lock_vault_maintenance_tx();
                checkpoint("maintenance_enter");
                panic!("child panics after arriving at the checkpoint");
            })
        });

        // The lock really was held, so the verdict alone looks like a pass.
        // That is the point of checking the other three: a child that arrives
        // holding the lock and then dies never did the work the test believes
        // it observed.
        assert_eq!(probe.verdict, LockVerdict::LockHeld);
        assert!(
            !probe.child_ok,
            "a child that panicked was reported as having finished"
        );
        assert!(
            probe.returned.is_empty(),
            "a child that panicked reported a return value: {:?}",
            probe.returned
        );

        // And the next probe has to be unaffected. Without the harness clearing
        // the poison, one panicking child turns every later try_lock in the
        // file into Poisoned, and a whole run reports infrastructure failures
        // that read exactly like real ones.
        let after = probe_lock_at_checkpoint("maintenance_enter", vault_maintenance_tx(), || {
            let _held = lock_vault_maintenance_tx();
            checkpoint("maintenance_enter");
            Ok(())
        });
        assert_eq!(
            after.verdict,
            LockVerdict::LockHeld,
            "a previous panic leaked into the next probe"
        );
        assert!(after.child_ok);
    }

    #[test]
    fn test_the_probe_calls_an_already_poisoned_lock_a_harness_failure() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        // Poison it from outside, then park the child *without* taking it, so
        // try_lock succeeds and reports the poison rather than WouldBlock.
        d03_without_panic_output(|| {
            let _ = std::thread::spawn(|| {
                let _held = vault_maintenance_tx().lock().unwrap();
                panic!("poisoning the maintenance lock on purpose");
            })
            .join();
        });

        let probe = probe_lock_at_checkpoint("maintenance_enter", vault_maintenance_tx(), || {
            checkpoint("maintenance_enter");
            Ok(())
        });

        assert_eq!(
            probe.verdict,
            LockVerdict::HarnessError,
            "a poisoned lock was reported as a lock verdict"
        );
        assert!(probe.child_ok);

        // The guard that came with the poisoned result has to have been
        // dropped, and the poison cleared, or the rest of the file is ruined.
        assert!(
            vault_maintenance_tx().try_lock().is_ok(),
            "the poisoned guard was never released"
        );
        enqueue_pending_prune(&["probe:after:poison".to_string()]).unwrap();
        assert_eq!(read_pending_prune().unwrap(), vec!["probe:after:poison"]);
    }

    // ------------------------------------------------- cross-slice (D01+D03)
    // Named so nobody has to guess: this one spans two slices and is not one of
    // the 43 invariants. It exists because the two defects compound. A user
    // whose history had one torn line could never reach the legacy-credential
    // sanitiser at all - the read failed outright, the panel came up empty, and
    // the clear button was greyed out because the list was empty. The
    // credentials this user most wanted scrubbed were the ones the scrub could
    // not see.
    //
    // Where the halves live: skipping and quarantining is Rust, the redaction
    // itself is the frontend history store, and Rust is deliberately a pipe for
    // history content. So this proves reachability and the write-back contract;
    // that the sanitiser blanks a given field is the store's own tests' job,
    // and the redaction step below is a stand-in for it, not a copy of it.
    #[test]
    fn test_cross_slice_d01_scrub_runs_after_d03_read_resilience() {
        let _guard = lock_env();
        let temp_home = tempdir().unwrap();
        let _home_guard = HomeGuard::set(temp_home.path());

        let clean = sample_history_entry("clean", "2026-03-27T10:00:00Z");
        let mut legacy = sample_history_entry("legacy", "2026-03-27T10:05:00Z");
        legacy.request_headers = vec![KeyValuePair {
            enabled: true,
            key: "Authorization".to_string(),
            value: "Bearer super-secret-token".to_string(),
            description: String::new(),
        }];

        // A line an earlier crash cut in half, sitting between two good rows.
        let torn = "{\"id\":\"torn\",\"method\":\"GET\",\"url\":\"http://exa";
        let history_path = history_file_path().unwrap();
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        std::fs::write(
            &history_path,
            format!(
                "{}\n{torn}\n{}\n",
                serde_json::to_string(&clean).unwrap(),
                serde_json::to_string(&legacy).unwrap()
            ),
        )
        .unwrap();

        // D03's half: the torn line costs only itself, so both good rows arrive.
        let loaded = load_history().unwrap();
        assert_eq!(
            loaded
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["legacy", "clean"],
            "a torn line still cost the whole read"
        );

        // The credential arrives verbatim. That is the contract the sanitiser
        // depends on: if Rust altered it here there would be two redaction
        // implementations disagreeing about what counts as sensitive.
        let delivered = loaded.iter().find(|entry| entry.id == "legacy").unwrap();
        assert_eq!(
            delivered.request_headers[0].value, "Bearer super-secret-token",
            "the legacy credential did not reach the caller intact"
        );

        // D01's half, driven the way the store drives it: sanitise what came
        // back, then write back only the rows that changed.
        let mut scrubbed = delivered.clone();
        scrubbed.request_headers[0].value = "[redacted]".to_string();
        update_history_entries(vec![scrubbed]).unwrap();

        // The rewrite must not swallow the torn line. Its bytes can hold a
        // credential of their own, so they go to quarantine unchanged rather
        // than disappearing with the file that was replaced.
        let quarantined =
            std::fs::read_to_string(history_quarantine_path().unwrap()).unwrap();
        assert_eq!(
            quarantined,
            format!("{torn}\n"),
            "the torn line was not preserved byte for byte"
        );

        let after = load_history().unwrap();
        assert_eq!(after.len(), 2);
        let stored = after.iter().find(|entry| entry.id == "legacy").unwrap();
        assert_eq!(
            stored.request_headers[0].value, "[redacted]",
            "the scrubbed row did not survive the write-back"
        );
    }

    // ----------------------------------------- D03 §2.11 (lock structure)
    // A syntax check, deliberately not a behaviour check. The dynamic probes
    // prove a lock is alive at a checkpoint, but only for functions that have
    // one: they cannot see a function that forgot its checkpoint, and they
    // cannot see a guard taken inside an inner block that ends before the read.
    // This reads lib.rs back and answers the other half - in each function the
    // lock rules cover, is the guard the first thing that happens?
    //
    // Three text-based versions of this check came before it and all three
    // passed on code that was wrong: counting braces per line, then lexical
    // masking, then masking plus self-checks. Every failure was the same shape,
    // approximating a syntax question. Parsing removes the question instead of
    // producing one more instance of it.
    mod lock_structure {
        use syn::visit::Visit;
        use syn::{Expr, File, ItemFn, Pat, PathArguments, Stmt};

        pub struct Target {
            pub function: &'static str,
            pub accessor: &'static str,
            pub read: &'static str,
            /// Declared per function, never a blanket allowance. A macro is
            /// rejected rather than expanded, so every name listed here marks a
            /// place this check stops looking.
            pub allowed_macros: &'static [&'static str],
            /// Same rule one level up. An attribute macro replaces the item it
            /// is written on, so trusting attributes by default means checking
            /// a function the compiler may never build. Listing them per target
            /// keeps `#[tauri::command]` - which every command here carries -
            /// from becoming a licence for any attribute at all.
            pub allowed_attributes: &'static [&'static str],
        }

        /// The list is part of what gets reviewed. Deleting a row silently
        /// removes the guarantee for that function, and no machine can notice
        /// that - which is why the test asserts the row count as well.
        pub const TARGETS: &[Target] = &[
            Target {
                function: "save_local_secret_value",
                accessor: "lock_local_vault_tx",
                read: "load_local_secret_map",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            Target {
                function: "delete_local_secret_value",
                accessor: "lock_local_vault_tx",
                read: "load_local_secret_map",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            Target {
                function: "unlock_local_secret_vault_locked",
                accessor: "lock_local_vault_tx",
                read: "read_local_secret_vault_file",
                // The session-key error path formats a message. Listed rather
                // than waved through: the token stream is still swept for the
                // two names below, so a read cannot hide inside it.
                allowed_macros: &["format"],
                allowed_attributes: &[],
            },
            Target {
                function: "record_vault_key_collisions",
                accessor: "lock_vault_maintenance_tx",
                read: "read_maintenance_snapshot",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            Target {
                function: "acknowledge_secret_key_collision",
                accessor: "lock_vault_maintenance_tx",
                read: "read_maintenance_snapshot",
                allowed_macros: &[],
                allowed_attributes: &["tauri::command"],
            },
            Target {
                function: "enqueue_pending_prune",
                accessor: "lock_vault_maintenance_tx",
                read: "read_maintenance_snapshot",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            Target {
                function: "read_pending_prune",
                accessor: "lock_vault_maintenance_tx",
                read: "read_maintenance_snapshot",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            Target {
                function: "resolve_pending_prune",
                accessor: "lock_vault_maintenance_tx",
                read: "read_maintenance_snapshot",
                allowed_macros: &[],
                allowed_attributes: &[],
            },
            // The lifecycle rows: the three commands that touch an
            // environment's secret metadata. Appended rather than slotted in
            // beside their relatives, because the self-test above addresses two
            // rows by index and renumbering them would move the probe silently.
            //
            // Each names as its `read` the call that must not happen first. For
            // all three that is a *read of the metadata*, not the cleanup at the
            // end - which is the correction R4 forced. The guard used to be
            // taken inside the migration helper, after the caller had already
            // read the file the migration goes on to rewrite; a save landing in
            // that gap was erased. Binding the row to the read makes the
            // boundary of the critical section the thing that gets checked.
            Target {
                function: "load_environment",
                accessor: "lock_vault_key_lifecycle_tx",
                read: "read_env_variables",
                allowed_macros: &[],
                allowed_attributes: &["tauri::command"],
            },
            Target {
                function: "save_environment",
                accessor: "lock_vault_key_lifecycle_tx",
                read: "read_previous_secret_metadata",
                allowed_macros: &["format"],
                allowed_attributes: &["tauri::command"],
            },
            Target {
                function: "delete_environment",
                accessor: "lock_vault_key_lifecycle_tx",
                read: "read_env_variables",
                allowed_macros: &["format"],
                allowed_attributes: &["tauri::command"],
            },
        ];

        /// Anything unreadable fails rather than passes, and "unreadable" is
        /// decided by what this function can expand rather than by a list of
        /// shapes known to be dangerous. It expands nothing, so **every** item
        /// macro at this level is rejected, not just `include!`.
        ///
        /// The earlier version named `include!` specifically, which read as
        /// thorough and was not: any other item macro walked through, and
        /// `check` below only ever collects functions spelled out in the
        /// source. A macro expanding to a read-before-lock `read_pending_prune`
        /// under `#[cfg(test)]`, sitting beside a compliant `#[cfg(not(test))]`
        /// one, is what the compiler builds while the check reads only the
        /// compliant copy and reports nothing. Enumerating which macros can
        /// hide a function has no fixed point - the same reason the guard rule
        /// stopped enumerating ways to drop a guard.
        ///
        /// The crate root is the whole scope on purpose: it is exactly where
        /// `check` collects its targets from, and a macro nested inside a module
        /// cannot declare an item out here.
        pub fn unanalysable(file: &File) -> Vec<String> {
            let mut problems = Vec::new();
            for item in &file.items {
                match item {
                    syn::Item::Mod(item) if item.content.is_none() => problems.push(format!(
                        "module {} is not inline, so its contents are not analysable",
                        item.ident
                    )),
                    syn::Item::Macro(item) => {
                        let name = item
                            .mac
                            .path
                            .segments
                            .last()
                            .map(|segment| segment.ident.to_string())
                            .unwrap_or_else(|| "<unnamed>".to_string());
                        problems.push(format!(
                            "the item macro {name}! is not expanded here, so anything it \
                             declares is invisible to this check"
                        ));
                    }
                    _ => {}
                }
            }
            problems
        }

        /// Walks a `use` tree for anything that could bind `name` at the crate
        /// root. Visits every branch rather than short-circuiting, because a
        /// glob further along the same group still has to be reported.
        fn use_tree_binds(tree: &syn::UseTree, name: &str, glob: &mut bool) -> bool {
            match tree {
                syn::UseTree::Path(path) => use_tree_binds(&path.tree, name, glob),
                syn::UseTree::Name(leaf) => leaf.ident == name,
                syn::UseTree::Rename(leaf) => leaf.rename == name,
                syn::UseTree::Glob(_) => {
                    *glob = true;
                    false
                }
                syn::UseTree::Group(group) => {
                    let mut binds = false;
                    for item in &group.items {
                        binds |= use_tree_binds(item, name, glob);
                    }
                    binds
                }
            }
        }

        pub fn check(file: &File, target: &Target) -> Vec<String> {
            // A `use` at the crate root can bind this name to an item declared
            // somewhere the collection below never looks - a function generated
            // inside a module and re-exported out, with a compliant explicit
            // one left beside it under the opposite cfg. The compiler calls the
            // re-export; this check would read only the compliant copy.
            let mut problems = Vec::new();
            for item in &file.items {
                if let syn::Item::Use(item) = item {
                    let mut glob = false;
                    if use_tree_binds(&item.tree, target.function, &mut glob) {
                        problems.push(format!(
                            "{}: the name is bound by a use declaration at the crate root, so \
                             the item the compiler builds under this name is not necessarily \
                             the function checked here",
                            target.function
                        ));
                    }
                    if glob {
                        problems.push(format!(
                            "{}: a glob import at the crate root can bind this name from a \
                             module this check does not read",
                            target.function
                        ));
                    }
                }
            }

            let definitions: Vec<&ItemFn> = file
                .items
                .iter()
                .filter_map(|item| match item {
                    syn::Item::Fn(function) if function.sig.ident == target.function => {
                        Some(function)
                    }
                    _ => None,
                })
                .collect();

            if definitions.is_empty() {
                problems.push(format!("{}: not found at the crate root", target.function));
                return problems;
            }

            // Every #[cfg] variant is judged on its own. syn does not evaluate
            // conditional compilation and sees both, so a bad variant sitting
            // next to a good one must not be covered by it.
            problems.extend(
                definitions
                    .into_iter()
                    .flat_map(|definition| check_one(definition, target)),
            );
            problems
        }

        fn check_one(function: &ItemFn, target: &Target) -> Vec<String> {
            let name = target.function;

            // Before anything about the body is worth reading: an attribute
            // macro receives this item and returns whatever it likes, so an
            // undeclared attribute means the statements below may describe a
            // function that is never built. Reported on its own and returned
            // early - continuing would attach conclusions to the wrong item.
            let undeclared: Vec<String> = function
                .attrs
                .iter()
                .map(|attribute| {
                    attribute
                        .path()
                        .segments
                        .iter()
                        .map(|segment| segment.ident.to_string())
                        .collect::<Vec<_>>()
                        .join("::")
                })
                // Two built-in exemptions, both narrow on purpose. `cfg` can
                // only include or exclude the item as written, never rewrite
                // it, and both variants are judged separately just below;
                // `doc` is what a /// comment parses to and attaches no code
                // at all. Neither can substitute an item, which is the whole
                // risk being guarded against.
                //
                // `cfg_attr` is deliberately NOT exempt despite the name: it
                // applies an arbitrary attribute conditionally, which is
                // exactly the substitution this list exists to catch.
                .filter(|rendered| rendered != "cfg" && rendered != "doc")
                .filter(|rendered| !target.allowed_attributes.contains(&rendered.as_str()))
                .map(|rendered| {
                    format!(
                        "{name}: attribute #[{rendered}] is not on this function's attribute \
                         allow list, so the item the compiler builds may not be this one"
                    )
                })
                .collect();
            if !undeclared.is_empty() {
                return undeclared;
            }

            // The guard is statement 0 and nothing may precede it: no call, no
            // method call, no macro, no block, no `use`. That is the whole
            // design. With nothing before the guard there is nowhere to put an
            // unlocked read, so the bypass shapes do not each have to be
            // recognised - and recognising shapes has no fixed point, since the
            // set of equivalent ways to spell one in Rust is unbounded.
            let Some(Stmt::Local(local)) = function.block.stmts.first() else {
                return vec![format!("{name}: guard is not the first statement")];
            };
            let Some(init) = &local.init else {
                return vec![format!("{name}: guard is not the first statement")];
            };
            if init.diverge.is_some() {
                return vec![format!("{name}: unsupported wrapper around the guard")];
            }
            if let Some(complaint) = classify_guard_init(&init.expr, target.accessor) {
                return vec![format!("{name}: {complaint}")];
            }

            let Pat::Ident(binding) = &local.pat else {
                return vec![format!("{name}: unsupported wrapper around the guard")];
            };
            if binding.subpat.is_some() {
                return vec![format!("{name}: unsupported wrapper around the guard")];
            }
            let guard = binding.ident.to_string();

            let mut scan = BodyScan {
                accessor: target.accessor,
                read: target.read,
                guard: &guard,
                allowed_macros: target.allowed_macros,
                reads: 0,
                problems: Vec::new(),
            };
            for statement in function.block.stmts.iter().skip(1) {
                scan.visit_stmt(statement);
            }
            // The guard statement itself is re-examined for everything except
            // its own accessor call, which was just accepted above.
            for argument in guard_init_arguments(&init.expr) {
                scan.visit_expr(argument);
            }

            let mut problems: Vec<String> = scan
                .problems
                .into_iter()
                .map(|problem| format!("{name}: {problem}"))
                .collect();
            if scan.reads == 0 {
                problems.push(format!(
                    "{name}: never calls {}, so this check proves nothing here",
                    target.read
                ));
            }
            problems
        }

        /// `None` means accepted. The three complaints stay distinct because
        /// they send a reader to different places: a foreign statement sitting
        /// in front of the guard, a lock taken on some other mutex that wears
        /// the right name, and a wrapper that moves when the guard is released.
        fn classify_guard_init(expr: &Expr, accessor: &str) -> Option<&'static str> {
            if let Expr::Call(call) = expr {
                if call.args.is_empty() {
                    if let Some(called) = plain_call_name(call) {
                        if called == accessor {
                            return None;
                        }
                    }
                }
                // Names the accessor in its last segment but fails the
                // full-form comparison, so it locks something else.
                if last_segment_is(&call.func, accessor) {
                    return Some("accessor mismatch");
                }
            }
            if mentions(expr, accessor) {
                return Some("unsupported wrapper around the guard");
            }
            Some("guard is not the first statement")
        }

        fn last_segment_is(expr: &Expr, name: &str) -> bool {
            match expr {
                Expr::Path(path) => path
                    .path
                    .segments
                    .last()
                    .is_some_and(|segment| segment.ident == name),
                _ => false,
            }
        }

        fn mentions(expr: &Expr, name: &str) -> bool {
            struct Probe<'a> {
                name: &'a str,
                found: bool,
            }
            impl<'ast, 'a> Visit<'ast> for Probe<'a> {
                fn visit_path(&mut self, path: &'ast syn::Path) {
                    if path.segments.iter().any(|segment| segment.ident == self.name) {
                        self.found = true;
                    }
                    syn::visit::visit_path(self, path);
                }
            }

            let mut probe = Probe { name, found: false };
            probe.visit_expr(expr);
            probe.found
        }

        fn guard_init_arguments(expr: &Expr) -> Vec<&Expr> {
            match expr {
                Expr::Call(call) => call.args.iter().collect(),
                _ => Vec::new(),
            }
        }

        /// Full-form comparison: no qualified self, no leading `::`, exactly one
        /// segment, no generic arguments. Matching on the last segment would
        /// accept `unrelated::lock_vault_maintenance_tx()` and destroy the claim
        /// that the guard locks the mutex this row names.
        fn plain_call_name(call: &syn::ExprCall) -> Option<String> {
            let Expr::Path(path) = &*call.func else {
                return None;
            };
            if path.qself.is_some() || path.path.leading_colon.is_some() {
                return None;
            }
            if path.path.segments.len() != 1 {
                return None;
            }
            let segment = &path.path.segments[0];
            if !matches!(segment.arguments, PathArguments::None) {
                return None;
            }
            Some(segment.ident.to_string())
        }

        struct BodyScan<'a> {
            accessor: &'a str,
            read: &'a str,
            guard: &'a str,
            allowed_macros: &'a [&'static str],
            reads: usize,
            problems: Vec<String>,
        }

        impl<'a> BodyScan<'a> {
            fn watched(&self, ident: &syn::Ident) -> bool {
                ident == self.accessor || ident == self.read
            }
        }

        impl<'ast, 'a> Visit<'ast> for BodyScan<'a> {
            fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
                match plain_call_name(call) {
                    Some(called) if called == self.read || called == self.accessor => {
                        if called == self.read {
                            self.reads += 1;
                        }
                        // Accepted as a direct named call, so the callee path is
                        // not walked. Every remaining mention of these two names
                        // is therefore something other than a direct call.
                        for argument in &call.args {
                            self.visit_expr(argument);
                        }
                        return;
                    }
                    _ => {}
                }
                syn::visit::visit_expr_call(self, call);
            }

            fn visit_path(&mut self, path: &'ast syn::Path) {
                for segment in &path.segments {
                    if self.watched(&segment.ident) {
                        self.problems.push(format!(
                            "{} appears somewhere other than a direct named call",
                            segment.ident
                        ));
                    }
                    // Naming the guard again is the only way to end its life
                    // early, so the rule is that it is never named again -
                    // rather than a list of the ways one could do it. An
                    // earlier version looked for a call to `drop`, which said
                    // nothing at all about `std::mem::drop(guard)` or about
                    // `let _ = guard;`. Enumerating spellings loses here for
                    // the same reason it lost in front of the guard.
                    if segment.ident == self.guard {
                        self.problems.push(format!(
                            "the guard {} is named again after it is bound, so it may be \
                             released before the function ends",
                            self.guard
                        ));
                    }
                }
                syn::visit::visit_path(self, path);
            }

            fn visit_macro(&mut self, mac: &'ast syn::Macro) {
                let called = mac
                    .path
                    .segments
                    .last()
                    .map(|segment| segment.ident.to_string())
                    .unwrap_or_default();
                if !self.allowed_macros.contains(&called.as_str()) {
                    self.problems
                        .push(format!("macro {called}! is not on this function's allow list"));
                    return;
                }
                // Being on the list means the check does not expand it, not that
                // it goes unread: a read hidden in the token stream would
                // otherwise walk straight through.
                //
                // The guard is swept for here as well, and the reason is the
                // same one that put the read on this list. Macro tokens are
                // never parsed, so `visit_path` never sees them: a
                // `format!("{}", { drop(_guard); "" })` ends the lock in the
                // middle of the function while every rule above stays satisfied
                // and this check says nothing at all. Sweeping for the read
                // alone left that open, which is the shape an earlier version
                // of this same check was already caught in - an allow list has
                // to cover everything the rules outside it cover, or it is a
                // hole with a name.
                let rendered = mac.tokens.to_string();
                for word in rendered.split(|character: char| !character.is_alphanumeric() && character != '_') {
                    if word == self.accessor || word == self.read {
                        self.problems.push(format!(
                            "{word} appears inside the allowed macro {called}!"
                        ));
                    }
                    if word == self.guard {
                        self.problems.push(format!(
                            "the guard {word} is named inside the allowed macro {called}!, so it \
                             may be released before the function ends"
                        ));
                    }
                }
            }

            fn visit_stmt(&mut self, stmt: &'ast Stmt) {
                if let Stmt::Item(_) = stmt {
                    self.problems.push(
                        "an item declared inside the body is not analysable here".to_string(),
                    );
                    return;
                }
                syn::visit::visit_stmt(self, stmt);
            }
        }
    }

    /// Fixtures the checker must reject, each paired with the phrase it has to
    /// say. Silence is this check's evidence, so it has to be shown to speak
    /// before the silence counts for anything - and the last row is the
    /// positive control, because a checker that rejects everything would pass
    /// all the rows above while proving nothing.
    const LOCK_STRUCTURE_FIXTURES: &[(&str, &str, &str)] = &[
        (
            "a read reached through a helper before the guard",
            r#"fn read_pending_prune() -> u8 {
                let stale = peek();
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "guard is not the first statement",
        ),
        (
            "a macro standing before the guard",
            r#"fn read_pending_prune() -> u8 {
                println!("about to lock");
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "guard is not the first statement",
        ),
        (
            "the guard taken inside a block that ends before the read",
            r#"fn read_pending_prune() -> u8 {
                { let _guard = lock_vault_maintenance_tx(); }
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "guard is not the first statement",
        ),
        (
            "an aliasing use before the guard",
            r#"fn read_pending_prune() -> u8 {
                use other::lock as lock_vault_maintenance_tx;
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "guard is not the first statement",
        ),
        (
            "a same-named accessor from somewhere else",
            r#"fn read_pending_prune() -> u8 {
                let _guard = unrelated::lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "accessor mismatch",
        ),
        (
            "the guard wrapped so its lifetime is no longer the function",
            r#"fn read_pending_prune() -> u8 {
                let _guard = Box::new(lock_vault_maintenance_tx());
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "unsupported wrapper around the guard",
        ),
        (
            "the guard dropped before the read",
            r#"fn read_pending_prune() -> u8 {
                let guard = lock_vault_maintenance_tx();
                drop(guard);
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "released before the function ends",
        ),
        (
            "the guard dropped through a fully qualified path",
            r#"fn read_pending_prune() -> u8 {
                let guard = lock_vault_maintenance_tx();
                std::mem::drop(guard);
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "released before the function ends",
        ),
        (
            "the guard dropped by binding it to a wildcard",
            r#"fn read_pending_prune() -> u8 {
                let guard = lock_vault_maintenance_tx();
                let _ = guard;
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "released before the function ends",
        ),
        (
            "the guard never bound at all, so it dies on the spot",
            r#"fn read_pending_prune() -> u8 {
                let _ = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "unsupported wrapper around the guard",
        ),
        (
            "the accessor handed around as a value",
            r#"fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let deferred = lock_vault_maintenance_tx;
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "appears somewhere other than a direct named call",
        ),
        (
            "a read hidden inside an allowed macro",
            r#"fn unlock_local_secret_vault_locked() -> u8 {
                let _guard = lock_local_vault_tx();
                let vault = read_local_secret_vault_file();
                let _ = format!("{}", read_local_secret_vault_file());
                vault
            }"#,
            "appears inside the allowed macro",
        ),
        (
            "the guard released inside an allowed macro",
            r#"fn unlock_local_secret_vault_locked() -> u8 {
                let _guard = lock_local_vault_tx();
                let vault = read_local_secret_vault_file();
                let _ = format!("{}", { drop(_guard); "" });
                vault
            }"#,
            "named inside the allowed macro",
        ),
        (
            "a re-export that can bind the target name to something else",
            r#"#[cfg(test)]
            pub use hidden::read_pending_prune;
            #[cfg(not(test))]
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "bound by a use declaration",
        ),
        (
            "a glob import that could bind the target name",
            r#"use hidden::*;
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "glob import",
        ),
        (
            "an attribute that can replace the whole item",
            r#"#[some_attribute_macro]
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "attribute allow list",
        ),
        (
            "an attribute applied conditionally, which cfg does not cover",
            r#"#[cfg_attr(test, some_attribute_macro)]
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "attribute allow list",
        ),
        (
            "a macro nobody declared",
            r#"fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                assert!(snapshot > 0);
                snapshot
            }"#,
            "is not on this function's allow list",
        ),
        (
            "a function that no longer reads anything",
            r#"fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                0
            }"#,
            "never calls read_maintenance_snapshot",
        ),
        (
            "a bad cfg variant standing beside a good one",
            r#"#[cfg(test)]
            fn read_pending_prune() -> u8 {
                let snapshot = read_maintenance_snapshot();
                let _guard = lock_vault_maintenance_tx();
                snapshot
            }
            #[cfg(not(test))]
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "guard is not the first statement",
        ),
        (
            "the shape the rules actually ask for",
            r#"fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "",
        ),
    ];

    /// Fixtures for the other half of the check - "code I cannot read fails" -
    /// which none of the rows above can reach. They all go through `check`, and
    /// `check` only ever sees functions spelled out in the source; anything that
    /// would *produce* a function is judged before that point or not at all.
    ///
    /// The first row is the bypass this pair exists for: a macro that could be
    /// declaring the target function next to a compliant explicit one. The
    /// compiler runs whatever the macro expands to, `check` reads only the
    /// spelled-out copy, and every row above stays green.
    const LOCK_STRUCTURE_UNANALYSABLE_FIXTURES: &[(&str, &str, &str)] = &[
        (
            "an item macro that could be declaring the target function",
            r#"declare_reader!{}
            #[cfg(not(test))]
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "is not expanded here",
        ),
        (
            "a module whose body lives in another file",
            r#"mod elsewhere;
            fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "is not inline",
        ),
        (
            "nothing hidden from the parse at all",
            r#"fn read_pending_prune() -> u8 {
                let _guard = lock_vault_maintenance_tx();
                let snapshot = read_maintenance_snapshot();
                snapshot
            }"#,
            "",
        ),
    ];

    #[test]
    fn test_every_lock_protected_function_takes_its_guard_first() {
        // Self-test before the real run. A harness whose quiet output is the
        // evidence has to be shown to say something on input already known to
        // be bad; otherwise "no problems" and "never looked" are the same
        // sentence.
        let probe = &lock_structure::TARGETS[6];
        assert_eq!(probe.function, "read_pending_prune");
        let macro_probe = &lock_structure::TARGETS[2];
        assert_eq!(macro_probe.function, "unlock_local_secret_vault_locked");

        for (label, source, expected) in LOCK_STRUCTURE_FIXTURES {
            let file = syn::parse_file(source).unwrap_or_else(|error| {
                panic!("fixture {label} does not parse: {error}");
            });
            let target = if source.contains("unlock_local_secret_vault_locked") {
                macro_probe
            } else {
                probe
            };
            let problems = lock_structure::check(&file, target);

            if expected.is_empty() {
                assert!(
                    problems.is_empty(),
                    "fixture {label} should have been accepted, got {problems:?}"
                );
            } else {
                assert!(
                    problems.iter().any(|problem| problem.contains(expected)),
                    "fixture {label} should have been rejected with {expected:?}, got {problems:?}"
                );
            }
        }

        for (label, source, expected) in LOCK_STRUCTURE_UNANALYSABLE_FIXTURES {
            let file = syn::parse_file(source).unwrap_or_else(|error| {
                panic!("fixture {label} does not parse: {error}");
            });
            let problems = lock_structure::unanalysable(&file);

            if expected.is_empty() {
                assert!(
                    problems.is_empty(),
                    "fixture {label} should have been accepted, got {problems:?}"
                );
            } else {
                assert!(
                    problems.iter().any(|problem| problem.contains(expected)),
                    "fixture {label} should have been rejected with {expected:?}, got {problems:?}"
                );
            }
        }

        // Now the file that ships.
        let source =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
        let file = syn::parse_file(&source).expect("lib.rs does not parse");

        assert!(
            lock_structure::unanalysable(&file).is_empty(),
            "lib.rs contains code this check cannot read: {:?}",
            lock_structure::unanalysable(&file)
        );

        // The row count is asserted because the list is the check's own weak
        // point: removing a row removes a guarantee and nothing else changes.
        assert_eq!(lock_structure::TARGETS.len(), 11);

        let mut problems = Vec::new();
        for target in lock_structure::TARGETS {
            problems.extend(lock_structure::check(&file, target));
        }
        assert!(problems.is_empty(), "{problems:#?}");

        // The three outer dispatchers stay out of TARGETS on purpose. They open
        // with a backend match, so requiring a guard first would mean holding a
        // global vault lock across every keychain call - a real behaviour
        // change to satisfy a checker, which is the trade this project refuses.
        for outer in [
            "save_secret_value",
            "delete_secret_value",
            "unlock_local_secret_storage",
        ] {
            assert!(
                !lock_structure::TARGETS
                    .iter()
                    .any(|target| target.function == outer),
                "{outer} is covered by the outer-dispatcher exclusion and must not be a target"
            );
        }
    }
}
