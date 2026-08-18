import { computed, nextTick, ref } from "vue";
import { defineStore } from "pinia";

import i18n from "../i18n";
import { useWebSocketStore } from "./websocket"
import {
  bodyKindFromBodyType,
  clearSentinelBody,
  clearSentinelPairs,
} from "../utils/redaction"
import type {
  AuthType,
  BodyType,
  HistoryEntry,
  HttpMethod,
  KeyValuePair,
  SavedRequest,
  Tab,
} from "../types";

function createEmptyBody() {
  return {
    type: "none" as const,
    content: "",
    formData: [],
    binaryPath: "",
    binaryContent: "",
  };
}

function createEmptyAuth() {
  return {
    type: "none" as const,
  };
}

const createEmptyTab = (index: number): Tab => ({
  id: crypto.randomUUID(),
  label: formatUntitledTabLabel(index),
  method: "GET",
  url: "",
  protocol: "http",
  wsStatus: undefined,
  wsConnectionId: undefined,
  isDirty: false,
  params: [],
  headers: [],
  body: createEmptyBody(),
  auth: createEmptyAuth(),
  preRequestScript: "",
  testScript: "",
  projectName: null,
  savedRequestPath: null,
  response: null,
  responseError: null,
  scriptResult: null,
  isLoading: false,
  urlRevision: 0,
});

function createSnapshotTab(tab: Pick<Tab, "label" | "method" | "url">): Tab {
  return {
    id: crypto.randomUUID(),
    label: tab.label,
    method: tab.method,
    url: tab.url,
    protocol: "http",
    wsStatus: undefined,
    wsConnectionId: undefined,
    isDirty: false,
    params: [],
    headers: [],
    body: createEmptyBody(),
    auth: createEmptyAuth(),
    preRequestScript: "",
    testScript: "",
    projectName: null,
    savedRequestPath: null,
    response: null,
    responseError: null,
    scriptResult: null,
    isLoading: false,
    urlRevision: 0,
  };
}

async function cleanupWebSocketTab(tab: Tab) {
  if (tab.protocol !== "websocket" || !tab.wsConnectionId) {
    return
  }

  const connectionId = tab.wsConnectionId
  const websocketStore = useWebSocketStore()

  try {
    await websocketStore.disconnect(connectionId)
  } catch {
    // Keep tab cleanup best-effort even if the socket is already gone.
  }

  websocketStore.clearMessages(connectionId)
}

function createEditablePairs<T extends KeyValuePair>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    id: crypto.randomUUID(),
  })) as T[]
}

function clonePairs<T extends KeyValuePair>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    id: crypto.randomUUID(),
  })) as T[]
}

function cloneTabForDuplicate(tab: Tab): Tab {
  return {
    ...tab,
    id: crypto.randomUUID(),
    wsConnectionId: undefined,
    wsStatus: tab.protocol === "websocket" ? "disconnected" : undefined,
    params: clonePairs(tab.params),
    headers: clonePairs(tab.headers),
    body: {
      ...tab.body,
      formData: clonePairs(tab.body.formData),
    },
    auth: {
      ...tab.auth,
      basic: tab.auth.basic ? { ...tab.auth.basic } : undefined,
      bearer: tab.auth.bearer ? { ...tab.auth.bearer } : undefined,
      apiKey: tab.auth.apiKey ? { ...tab.auth.apiKey } : undefined,
    },
    response: null,
    responseError: null,
    scriptResult: null,
    isLoading: false,
  }
}

function sanitizeFileLabel(value: string) {
  if (!value) {
    return ""
  }

  return value.split(/[\\/]/).pop() ?? value
}

function sanitizeHistoryFormData(items: Tab["body"]["formData"]) {
  return createEditablePairs(
    items.map((item) =>
      item.valueType === "file"
        ? {
            ...item,
            fileName: sanitizeFileLabel(item.fileName || item.filePath || item.key),
            filePath: "",
          }
        : item,
    ),
  )
}

function deriveParamsFromUrl(url: string) {
  try {
    return [...new URL(url).searchParams.entries()].map(([key, value]) => ({
      id: crypto.randomUUID(),
      enabled: true,
      key,
      value,
      description: "",
    }))
  } catch {
    return []
  }
}

export const useTabsStore = defineStore("tabs", () => {
  const tabs = ref<Tab[]>([createEmptyTab(1)]);
  const activeTabId = ref(tabs.value[0].id);

  const activeTab = computed(
    () => tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value[0],
  );

  function addTab(initial?: Partial<Tab>) {
    const tab = createEmptyTab(tabs.value.length + 1);
    Object.assign(tab, initial);
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    nextTick(() => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("apisolo:focus-url"))
      }
    });
    return tab;
  }

  function addWsTab() {
    const tab = addTab({
      label: "WebSocket",
      protocol: "websocket",
      wsStatus: "disconnected",
    });

    return tab;
  }

  async function removeTab(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const target = tabs.value[index]
    await cleanupWebSocketTab(target)

    if (tabs.value.length === 1) {
      const replacement = createEmptyTab(1)
      tabs.value = [replacement]
      activeTabId.value = replacement.id
      return
    }

    tabs.value.splice(index, 1);

    if (activeTabId.value === id) {
      const fallbackTab = tabs.value[index] ?? tabs.value[index - 1];
      activeTabId.value = fallbackTab.id;
    }
  }

  function setActiveTab(id: string) {
    if (tabs.value.some((tab) => tab.id === id)) {
      activeTabId.value = id;
    }
  }

  /**
   * The default write path. Any update that touches `url` or `params` bumps
   * `urlRevision`, which is how the URL bar knows the change did not come from
   * its own keystrokes.
   *
   * The default is deliberately the safe side. A new write point that forgets
   * about the revision still gets one, and the cost of a *spurious* bump is
   * cosmetic — the field is replaced by the canonical form of a state that is
   * genuinely current. The cost of a *missing* bump is the failure this slice
   * exists to remove: the field keeps showing a string that no longer
   * corresponds to anything.
   */
  function updateTab(id: string, updates: Partial<Tab>) {
    applyTabUpdates(id, updates, true);
  }

  /**
   * The one path that does not bump the revision: the URL bar writing back what
   * the user just typed. Only `UrlBar`'s own echo may use this — anything else
   * that reaches for it will make the field stop following the state.
   */
  function updateTabFromUrlBar(id: string, updates: Partial<Tab>) {
    applyTabUpdates(id, updates, false);
  }

  function applyTabUpdates(id: string, updates: Partial<Tab>, bumpUrlRevision: boolean) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab) {
      return;
    }

    const touchesUrl = "url" in updates || "params" in updates;
    Object.assign(tab, updates);

    if (bumpUrlRevision && touchesUrl) {
      tab.urlRevision += 1;
    }
  }

  async function closeSavedRequest(projectName: string, requestPath: string) {
    const ids = tabs.value
      .filter((tab) => tab.projectName === projectName && tab.savedRequestPath === requestPath)
      .map((tab) => tab.id)

    for (const id of ids) {
      await removeTab(id)
    }
  }

  async function closeSavedRequestsInPath(projectName: string, pathPrefix: string) {
    const ids = tabs.value
      .filter(
        (tab) =>
          tab.projectName === projectName &&
          tab.savedRequestPath &&
          matchesPathPrefix(tab.savedRequestPath, pathPrefix),
      )
      .map((tab) => tab.id)

    for (const id of ids) {
      await removeTab(id)
    }
  }

  function remapSavedRequestPath(
    projectName: string,
    fromPath: string,
    toPath: string,
    updates: Partial<Tab> = {},
  ) {
    for (const tab of tabs.value) {
      if (tab.projectName === projectName && tab.savedRequestPath === fromPath) {
        updateTab(tab.id, {
          savedRequestPath: toPath,
          ...updates,
        })
      }
    }
  }

  function remapSavedRequestPathPrefix(projectName: string, fromPrefix: string, toPrefix: string) {
    for (const tab of tabs.value) {
      const currentPath = tab.savedRequestPath
      if (
        tab.projectName !== projectName ||
        !currentPath ||
        !matchesPathPrefix(currentPath, fromPrefix)
      ) {
        continue
      }

      const suffix = currentPath.slice(fromPrefix.length).replace(/^\//, "")
      const nextPath = [toPrefix, suffix].filter(Boolean).join("/")
      updateTab(tab.id, { savedRequestPath: nextPath })
    }
  }

  function openSavedRequest(
    projectName: string,
    requestPath: string,
    request: SavedRequest,
  ) {
    const existing = tabs.value.find(
      (tab) => tab.projectName === projectName && tab.savedRequestPath === requestPath,
    );
    if (existing) {
      activeTabId.value = existing.id;
      return;
    }

    const tab: Tab = {
      ...createSnapshotTab({
        label: request.name,
        method: request.method as HttpMethod,
        url: request.url,
      }),
      params: request.params.length > 0 ? createEditablePairs(request.params) : deriveParamsFromUrl(request.url),
      headers: createEditablePairs(request.headers),
      body: {
        type: request.body.type,
        content: request.body.content,
        formData: createEditablePairs(request.body.formData),
        binaryPath: request.body.binaryPath,
        binaryContent: request.body.binaryContent,
      },
      auth: {
        type: request.auth.type,
        basic: request.auth.basic,
        bearer: request.auth.bearer,
        apiKey: request.auth.apiKey,
      },
      preRequestScript: request.preRequestScript,
      testScript: request.testScript,
      projectName,
      savedRequestPath: requestPath,
    };

    tabs.value.push(tab);
    activeTabId.value = tab.id;
  }

  function openHistoryEntry(entry: HistoryEntry) {
    const normalizedMethod = (entry.method.toUpperCase() || "GET") as HttpMethod
    const tab = createEmptyTab(tabs.value.length + 1)
    tab.method = normalizedMethod
    tab.url = entry.url
    tab.label = deriveHistoryLabel(entry.url)

    tab.params = entry.requestParams?.length
      ? createEditablePairs(entry.requestParams)
      : deriveParamsFromUrl(entry.url)

    if (entry.requestHeaders?.length) {
      tab.headers = createEditablePairs(entry.requestHeaders)
    }

    if (entry.requestBodyType && entry.requestBodyType !== "none") {
      tab.body = {
        ...tab.body,
        type: entry.requestBodyType as BodyType,
        content: entry.requestBodyContent || "",
        formData: sanitizeHistoryFormData(entry.requestBodyFormData || []),
        binaryPath: sanitizeFileLabel(entry.requestBodyBinaryPath || ""),
        binaryContent: entry.requestBodyBinaryContent,
      }
    }

    if (entry.requestAuth) {
      tab.auth = {
        type: entry.requestAuth.type,
        basic: entry.requestAuth.basic,
        bearer: entry.requestAuth.bearer,
        apiKey: entry.requestAuth.apiKey,
      }
    } else if (entry.requestAuthType && entry.requestAuthType !== "none") {
      tab.auth = {
        ...tab.auth,
        type: entry.requestAuthType as AuthType,
      }
    }

    tab.preRequestScript = entry.preRequestScript || ""
    tab.testScript = entry.testScript || ""

    // Restore response snapshot from history
    if (entry.status > 0) {
      tab.response = {
        status: entry.status,
        statusText: entry.status >= 200 && entry.status < 300 ? "OK" : "",
        headers: entry.responseHeaders ?? [],
        body: entry.responseBody ?? "",
        size: entry.size,
        time: entry.time,
        contentType: entry.contentType,
        timings: entry.timings ?? { dnsLookup: 0, tcpConnect: 0, tlsHandshake: 0, ttfb: 0, download: 0, total: entry.time },
      }
    }

    // History stores sensitive values as the sentinel. Restore them as empty,
    // marked rows so replaying can never put the placeholder back on the wire.
    tab.params = clearSentinelPairs(tab.params)
    tab.headers = clearSentinelPairs(tab.headers)
    tab.body.formData = clearSentinelPairs(tab.body.formData)
    const cleared = clearSentinelBody(bodyKindFromBodyType(tab.body.type), tab.body.content)
    tab.body.content = cleared.content
    tab.bodyRedacted = cleared.cleared

    const matchingEmptyTab = tabs.value.find(
      (candidate) =>
        !candidate.response &&
        !candidate.responseError &&
        !candidate.isLoading &&
        serializeRequestIdentity(candidate) === serializeRequestIdentity(tab),
    )

    if (matchingEmptyTab) {
      const existingId = matchingEmptyTab.id
      Object.assign(matchingEmptyTab, {
        ...tab,
        id: existingId,
        // Reuse rewrites url and params without going through updateTab, so
        // the bump has to happen here. Without it a draft left in the URL bar
        // would survive an open-from-history that produced the same string.
        urlRevision: matchingEmptyTab.urlRevision + 1,
      })
      activeTabId.value = existingId
      return
    }

    tabs.value.push(tab);
    activeTabId.value = tab.id;
  }

  function reorderTab(dragId: string, targetId: string) {
    const fromIndex = tabs.value.findIndex((t) => t.id === dragId);
    const toIndex = tabs.value.findIndex((t) => t.id === targetId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
    const [moved] = tabs.value.splice(fromIndex, 1);
    tabs.value.splice(toIndex, 0, moved);
  }

  async function closeOtherTabs(id: string) {
    const target = tabs.value.find((tab) => tab.id === id)
    if (!target) {
      return
    }

    const closingTabs = tabs.value.filter((tab) => tab.id !== id)
    for (const tab of closingTabs) {
      await cleanupWebSocketTab(tab)
    }

    tabs.value = [target]
    activeTabId.value = id
  }

  async function closeTabsToRight(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index === -1) {
      return
    }

    const closingTabs = tabs.value.slice(index + 1)
    for (const tab of closingTabs) {
      await cleanupWebSocketTab(tab)
    }

    tabs.value = tabs.value.slice(0, index + 1)
    if (!tabs.value.some((tab) => tab.id === activeTabId.value)) {
      activeTabId.value = id
    }
  }

  function duplicateTab(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index === -1) {
      return
    }

    const duplicated = cloneTabForDuplicate(tabs.value[index])
    tabs.value.splice(index + 1, 0, duplicated)
    activeTabId.value = duplicated.id
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    addTab,
    addWsTab,
    removeTab,
    setActiveTab,
    updateTab,
    updateTabFromUrlBar,
    reorderTab,
    closeOtherTabs,
    closeTabsToRight,
    duplicateTab,
    openSavedRequest,
    openHistoryEntry,
    closeSavedRequest,
    closeSavedRequestsInPath,
    remapSavedRequestPath,
    remapSavedRequestPathPrefix,
  };
});

function deriveHistoryLabel(url: string) {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}` || "/"
    return path === "/" ? parsed.host : path
  } catch {
    return url || formatUntitledTabLabel(1)
  }
}

function matchesPathPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function serializeRequestIdentity(tab: Tab) {
  return JSON.stringify({
    protocol: tab.protocol,
    method: tab.method,
    url: tab.url,
    params: tab.params.map(({ enabled, key, value, description }) => ({
      enabled,
      key,
      value,
      description,
    })),
    headers: tab.headers.map(({ enabled, key, value, description }) => ({
      enabled,
      key,
      value,
      description,
    })),
    body: {
      type: tab.body.type,
      content: normalizeComparableBodyContent(tab.body.type, tab.body.content),
      binaryPath: tab.body.type === "binary" ? sanitizeFileLabel(tab.body.binaryPath) : "",
      binaryContent: tab.body.type === "binary" ? tab.body.binaryContent : undefined,
      formData:
        tab.body.type === "form-data"
          ? tab.body.formData.map(
              ({
                enabled,
                key,
                value,
                description,
                valueType,
                fileName,
                filePath,
                fileContent,
                contentType,
              }) => ({
                enabled,
                key,
                value,
                description,
                valueType,
                fileName: valueType === "file" ? sanitizeFileLabel(fileName || filePath || key) : fileName,
                filePath: "",
                fileContent,
                contentType,
              }),
            )
          : [],
    },
    auth: tab.auth,
    preRequestScript: tab.preRequestScript,
    testScript: tab.testScript,
  })
}

function normalizeComparableBodyContent(type: string, content: string) {
  if (type !== "json") {
    return content
  }

  try {
    return JSON.stringify(JSON.parse(content))
  } catch {
    return content
  }
}

export function formatUntitledTabLabel(index: number) {
  return i18n.global.t("tabs.untitled", { index })
}

export function isUntitledTabLabel(value: string) {
  return /^Untitled \d+$/.test(value) || /^未命名 \d+$/.test(value)
}
