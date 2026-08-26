export interface KeyValuePair {
  id: string
  enabled: boolean
  key: string
  value: string
  description: string
  /**
   * In-memory only: the value was redacted in history and needs re-entering.
   *
   * Three rules, because this has been got wrong once per rebuild site. Anything
   * that reconstructs a row must **preserve** it; it may only be **cleared**
   * when that row's value becomes non-empty; and it is **stripped** before the
   * row is persisted or written to history. Dropping it where it should be
   * preserved silently removes a save gate on a blanked credential; keeping it
   * on a row the user just created blocks a request that is already complete.
   *
   * It records where the blank came from, never how far the user has got: the
   * gate reads this *and* the current value, so a marked row holding a value is
   * inert. Do not use it as "this row is pending" on its own.
   */
  redacted?: boolean
}

export type FormDataValueType = "text" | "file"

export interface FormDataItem extends KeyValuePair {
  valueType?: FormDataValueType
  fileName?: string
  filePath?: string
  fileContent?: string
  contentType?: string
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"

export type TabProtocol = "http" | "websocket"
export type WsConnectionStatus = "disconnected" | "connecting" | "connected"

export type BodyType = "none" | "json" | "form-urlencoded" | "form-data" | "raw" | "binary"

export type AuthType = "none" | "basic" | "bearer" | "api-key"
export type ThemeMode = "light" | "dark" | "system"
export type Locale = "zh-CN" | "en"
export type SidebarItem = "collections" | "history" | "environments"
export type SecretStorageBackend = "local-encrypted" | "system-keychain"

export interface ProxyConfig {
  enabled: boolean
  type: "http" | "socks5"
  host: string
  port: number
  auth?: {
    username: string
    password: string
  }
}

export interface TlsConfig {
  verifySsl: boolean
}

export interface AuthConfig {
  type: AuthType
  basic?: { username: string; password: string }
  bearer?: { token: string }
  apiKey?: { key: string; value: string; addTo: "header" | "query" }
}

export interface RequestBody {
  type: BodyType
  content: string
  formData: FormDataItem[]
  binaryPath: string
  binaryContent?: string
}

export interface SavedRequest {
  name: string
  method: HttpMethod
  url: string
  params: KeyValuePair[]
  headers: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  preRequestScript: string
  testScript: string
}

export interface ProjectMeta {
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface CollectionNode {
  name: string
  path: string
  nodeType: "folder" | "request"
  children: CollectionNode[]
  method?: string
}

export interface Tab {
  id: string
  label: string
  method: HttpMethod
  url: string
  protocol: TabProtocol
  wsConnectionId?: string
  wsStatus?: WsConnectionStatus
  isDirty: boolean
  params: KeyValuePair[]
  headers: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  preRequestScript: string
  testScript: string
  projectName: string | null
  savedRequestPath: string | null
  response?: HttpResponse | null
  responseError?: string | null
  scriptResult?: ScriptResult | null
  isLoading?: boolean
  /**
   * In-memory only: which body keys history had redacted, in order and with
   * repeats. It records where the blanks came from, never how far the user has
   * got filling them in -- that is recomputed from the body text, so there is
   * no progress here to keep up to date.
   */
  bodyRedactedFields?: string[]
  /**
   * In-memory only: bumped by every write to `url` or `params` that did not
   * come from the URL bar itself. The URL bar uses it to tell its own echo
   * apart from an outside change; it is never persisted.
   */
  urlRevision: number
}

export interface SettingsState {
  theme: ThemeMode
  fontSize: number
  locale: Locale
  proxy: ProxyConfig
  tls: TlsConfig
}

export interface SecretStorageState {
  configured: boolean
  backend: SecretStorageBackend | null
  locked: boolean
  vaultPath: string
}

export interface RequestTimings {
  dnsLookup: number
  tcpConnect: number
  tlsHandshake: number
  ttfb: number
  download: number
  total: number
}

/**
 * Machine-readable companion to a response body. Declared non-optional because
 * the Rust side always serialises it: reading the producing struct is the only
 * way to get this right, and the previous omission here is exactly why nothing
 * in the frontend could tell a binary body from server text.
 */
export type ResponseBodyKind = "text" | "binary"

export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  size: number
  time: number
  timings: RequestTimings
  contentType: string
  bodyKind: ResponseBodyKind
  /**
   * True when the network read stopped at the wire cap: the rest of the body
   * was never received. Required, not optional — Rust always serialises it,
   * and an optional here would invite the `!== undefined` bug again.
   */
  bodyTruncated: boolean
}

export interface HistoryEntry {
  id: string
  method: string
  url: string
  status: number
  /** Absent on rows written before the field existed; Rust defaults it to "". */
  statusText?: string
  time: number
  size: number
  timings?: RequestTimings
  timestamp: string
  contentType: string
  requestParams?: KeyValuePair[]
  requestHeaders?: KeyValuePair[]
  requestBodyType?: string
  requestBodyContent?: string
  requestAuthType?: string
  requestAuth?: AuthConfig
  requestBodyFormData?: FormDataItem[]
  requestBodyBinaryPath?: string
  requestBodyBinaryContent?: string
  preRequestScript?: string
  testScript?: string
  responseBody?: string
  responseHeaders?: [string, string][]
  note?: string
  starred?: boolean
  responseBodyKind?: ResponseBodyKind
  /** Absent on rows written before the network cap existed; those were read in full. */
  responseBodyTruncated?: boolean
}

export interface ScriptAssertion {
  name: string
  passed: boolean
  message?: string
}

export interface ScriptResult {
  success: boolean
  logs: string[]
  errors: string[]
  assertions: ScriptAssertion[]
  updatedVariables?: Record<string, string>
}

export type HistoryGroupMode = "prefix" | "time" | "method"

export interface HistoryGroup {
  label: string
  entries: HistoryEntry[]
  count: number
}

export interface EnvVariable {
  key: string
  value: string
  secret: boolean
}

export interface Environment {
  name: string
  variables: EnvVariable[]
}

/**
 * Mirrors the Rust `EnvironmentRef` wire shape field for field. Both values
 * are disk identifiers — the project directory name and the environment file
 * stem — not display names, and the UI must say so rather than present them
 * as project names.
 */
export interface SecretKeyCollisionEnvironmentRef {
  project: string
  environment: string
}

/**
 * Mirrors the Rust `SecretKeyCollision` wire shape. All four fields are
 * always present on the wire (no Option, no skip_serializing_if on the
 * producing side). `variableKey` can be an empty string when the vault key's
 * third segment does not decode.
 */
export interface SecretKeyCollision {
  legacyVaultKey: string
  variableKey: string
  environments: SecretKeyCollisionEnvironmentRef[]
  detectedAt: string
}

export interface WsMessage {
  id: string
  direction: "sent" | "received" | "system"
  content: string
  timestamp: string
  /** Set when the content was cut to the per-message character cap. */
  truncated?: boolean
}

export interface WsEventPayload {
  connectionId: string
  eventType: "connected" | "message" | "disconnected" | "error"
  content: string
  timestamp: string
}
