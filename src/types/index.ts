export interface KeyValuePair {
  id: string
  enabled: boolean
  key: string
  value: string
  description: string
  /** In-memory only: the value was redacted in history and needs re-entering. */
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
  /** In-memory only: the body was redacted in history and needs re-entering. */
  bodyRedacted?: boolean
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

export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  size: number
  time: number
  timings: RequestTimings
  contentType: string
}

export interface HistoryEntry {
  id: string
  method: string
  url: string
  status: number
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
  vaultKey?: string
}

export interface Environment {
  name: string
  variables: EnvVariable[]
}

export interface WsMessage {
  id: string
  direction: "sent" | "received" | "system"
  content: string
  timestamp: string
}

export interface WsEventPayload {
  connectionId: string
  eventType: "connected" | "message" | "disconnected" | "error"
  content: string
  timestamp: string
}
