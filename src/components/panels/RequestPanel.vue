<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Check, Copy, Download, MoreHorizontal, Save } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { useProjectsStore } from "../../stores/projects";
import { useRequestStore } from "../../stores/request";
import { isUntitledTabLabel, useTabsStore } from "../../stores/tabs";
import { exportCurl } from "../../utils/curl-export";
import { parseCurl } from "../../utils/curl-parser";
import AuthEditor from "../request/AuthEditor.vue";
import BodyEditor from "../request/BodyEditor.vue";
import KeyValueEditor from "../request/KeyValueEditor.vue";
import ScriptsEditor from "../request/ScriptsEditor.vue";
import UrlBar from "../request/UrlBar.vue";
import type {
  AuthConfig,
  CollectionNode,
  HttpMethod,
  KeyValuePair,
  RequestBody,
  SavedRequest,
  Tab,
} from "../../types";

const tabsStore = useTabsStore();
const projectsStore = useProjectsStore();
const requestStore = useRequestStore();
const { activeTab } = storeToRefs(tabsStore);
const { activeProject, collectionTree } = storeToRefs(projectsStore);
const { t } = useI18n();

type RequestSection = "params" | "headers" | "body" | "auth" | "scripts";

const activeSection = ref<RequestSection>("params");
const isLoading = computed(() => activeTab.value.isLoading ?? false);
const showSaveDialog = ref(false);
const showCurlImportDialog = ref(false);
const saveName = ref("");
const saveCollection = ref("");
const saveError = ref("");
const curlInput = ref("");
const curlError = ref("");
const curlCopied = ref(false);
const requestActionsOpen = ref(false);
const requestActionsRef = ref<HTMLElement | null>(null);

const sections = computed(() => {
  const tab = activeTab.value;

  return [
    { key: "params" as const, label: t("request.params"), count: countEnabled(tab.params) },
    { key: "headers" as const, label: t("request.headers"), count: countEnabled(tab.headers) },
    { key: "body" as const, label: t("request.body"), count: countBody(tab.body) },
    { key: "auth" as const, label: t("request.auth"), count: countAuth(tab.auth) },
    { key: "scripts" as const, label: t("request.scripts"), count: countScripts(tab) },
  ];
});

const collectionOptions = computed(() => [
  { label: t("common.rootCollection"), value: "" },
  ...flattenFolders(collectionTree.value),
]);

function countEnabled(items: KeyValuePair[]) {
  return items.filter((item) => item.enabled && (item.key || item.value)).length;
}

function countBody(body: RequestBody) {
  if (body.type === "none") {
    return 0;
  }

  if (body.type === "form-data") {
    return countEnabled(body.formData);
  }

  if (body.type === "binary") {
    return body.binaryPath ? 1 : 0;
  }

  return body.content.trim() ? 1 : 0;
}

function countAuth(auth: AuthConfig) {
  if (auth.type === "none") {
    return 0;
  }

  if (auth.type === "basic") {
    return Number(Boolean(auth.basic?.username || auth.basic?.password));
  }

  if (auth.type === "bearer") {
    return Number(Boolean(auth.bearer?.token));
  }

  return Number(Boolean(auth.apiKey?.key || auth.apiKey?.value));
}

function countScripts(tab: Tab) {
  return Number(Boolean(tab.preRequestScript.trim())) + Number(Boolean(tab.testScript.trim()))
}

function updateActiveTab(updates: Partial<Tab>) {
  tabsStore.updateTab(activeTab.value.id, {
    ...updates,
    isDirty: true,
  });
}

function updateMethod(method: HttpMethod) {
  updateActiveTab({ method });
}

function updateUrl(url: string) {
  const syncedState = syncParamsFromUrl(url, activeTab.value.params);
  tabsStore.updateTab(activeTab.value.id, {
    url: syncedState.url,
    params: syncedState.params,
    isDirty: true,
  });
}

function updateParams(params: KeyValuePair[]) {
  tabsStore.updateTab(activeTab.value.id, {
    url: buildUrlWithParams(activeTab.value.url, params),
    params,
    isDirty: true,
  });
}

function updateHeaders(headers: KeyValuePair[]) {
  updateActiveTab({ headers });
}

function updateBody(body: RequestBody) {
  updateActiveTab({ body });
}

function updateAuth(auth: AuthConfig) {
  updateActiveTab({ auth });
}

function updatePreRequestScript(preRequestScript: string) {
  updateActiveTab({ preRequestScript })
}

function updateTestScript(testScript: string) {
  updateActiveTab({ testScript })
}

async function sendRequest() {
  if (!activeTab.value.url.trim()) {
    tabsStore.updateTab(activeTab.value.id, {
      responseError: t("request.urlRequired"),
    });
    return;
  }

  tabsStore.updateTab(activeTab.value.id, {
    isDirty: false,
  });

  await requestStore.sendRequest(activeTab.value);
}

async function cancelRequest() {
  const tabId = activeTab.value.id;

  try {
    await requestStore.cancelRequest(tabId);
  } catch (error) {
    tabsStore.updateTab(tabId, {
      responseError: error instanceof Error ? error.message : String(error),
    });
  }
}

function openSaveDialog() {
  saveError.value = "";
  saveName.value = isUntitledTabLabel(activeTab.value.label) ? "" : activeTab.value.label;
  saveCollection.value = deriveCollectionPath(activeTab.value.savedRequestPath);
  showSaveDialog.value = true;
  requestActionsOpen.value = false;
}

async function submitSave() {
  saveError.value = "";

  try {
    await projectsStore.saveRequest(saveCollection.value, buildSavedRequest(activeTab.value), activeTab.value);
    showSaveDialog.value = false;
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}

function closeSaveDialog() {
  showSaveDialog.value = false;
  saveError.value = "";
}

function openCurlImportDialog() {
  curlInput.value = "";
  curlError.value = "";
  showCurlImportDialog.value = true;
  requestActionsOpen.value = false;
}

function closeCurlImportDialog() {
  showCurlImportDialog.value = false;
  curlError.value = "";
}

function applyCurlImport() {
  curlError.value = "";

  try {
    const parsed = parseCurl(curlInput.value);
    const { params } = syncParamsFromUrl(parsed.url, []);
    tabsStore.updateTab(activeTab.value.id, {
      method: parsed.method,
      url: parsed.url,
      params,
      headers: parsed.headers,
      body: parsed.body,
      auth: parsed.auth,
      isDirty: true,
    });
    closeCurlImportDialog();
  } catch (error) {
    curlError.value = error instanceof Error ? error.message : String(error);
  }
}

function applyPastedCurl(curlText: string) {
  try {
    const parsed = parseCurl(curlText);
    const { params } = syncParamsFromUrl(parsed.url, []);
    tabsStore.updateTab(activeTab.value.id, {
      method: parsed.method,
      url: parsed.url,
      params,
      headers: parsed.headers,
      body: parsed.body,
      auth: parsed.auth,
      isDirty: true,
    });
  } catch {
    // Silently fall back — let the paste go through as normal text
  }
}

async function copyAsCurl() {
  const command = exportCurl(activeTab.value);
  await navigator.clipboard.writeText(command);
  curlCopied.value = true;
  requestActionsOpen.value = false;
  window.setTimeout(() => {
    curlCopied.value = false;
  }, 1500);
}

function buildSavedRequest(tab: Tab): SavedRequest {
  return {
    name: saveName.value.trim(),
    method: tab.method,
    url: tab.url,
    params: stripTransientFields(tab.params),
    headers: stripTransientFields(tab.headers),
    body: sanitizeBodyForSave(tab.body),
    auth: {
      type: tab.auth.type,
      basic: tab.auth.basic,
      bearer: tab.auth.bearer,
      apiKey: tab.auth.apiKey,
    },
    preRequestScript: tab.preRequestScript,
    testScript: tab.testScript,
  };
}

function sanitizeBodyForSave(body: RequestBody): RequestBody {
  if (body.type === "form-data") {
    return {
      type: "form-data",
      content: "",
      formData: stripTransientFields(body.formData).map((item) =>
        item.valueType === "file"
          ? {
              ...item,
              fileName: sanitizeFileLabel(item.fileName || item.filePath || item.key),
              filePath: "",
              fileContent: undefined,
            }
          : item,
      ),
      binaryPath: "",
      binaryContent: "",
    }
  }

  if (body.type === "binary") {
    return {
      type: "binary",
      content: "",
      formData: [],
      binaryPath: sanitizeFileLabel(body.binaryPath),
      binaryContent: undefined,
    }
  }

  if (body.type === "none") {
    return {
      type: "none",
      content: "",
      formData: [],
      binaryPath: "",
      binaryContent: undefined,
    }
  }

  return {
      type: body.type,
      content: body.content,
      formData: [],
      binaryPath: "",
      binaryContent: undefined,
    }
  }

function stripTransientFields<T extends KeyValuePair>(items: T[]): T[] {
  return items.map(({ id: _id, ...item }) => ({
    id: "",
    ...item,
  })) as T[]
}

function deriveCollectionPath(path: string | null) {
  if (!path || !path.includes("/")) {
    return "";
  }

  return path.split("/").slice(0, -1).join("/");
}

function sanitizeFileLabel(value: string) {
  if (!value) {
    return ""
  }

  return value.split(/[\\/]/).pop() ?? value
}

function flattenFolders(nodes: CollectionNode[]): { label: string; value: string }[] {
  return nodes.flatMap((node) => {
    if (node.nodeType !== "folder") {
      return [];
    }

    return [
      { label: node.name, value: node.path },
      ...flattenFolders(node.children).map((child: { label: string; value: string }) => ({
        label: `${node.name} / ${child.label}`,
        value: child.value,
      })),
    ];
  });
}

function onSaveShortcut() {
  if (activeProject.value) {
    openSaveDialog();
  }
}

function toggleRequestActions() {
  requestActionsOpen.value = !requestActionsOpen.value;
}

function handleOutsideClick(event: MouseEvent) {
  if (!requestActionsOpen.value) {
    return;
  }

  if (requestActionsRef.value?.contains(event.target as Node)) {
    return;
  }

  requestActionsOpen.value = false;
}

function syncParamsFromUrl(rawUrl: string, currentParams: KeyValuePair[]) {
  try {
    const parsed = new URL(toParsableUrl(rawUrl));
    const params = [...parsed.searchParams.entries()].map(([key, value]) => ({
      id: crypto.randomUUID(),
      enabled: true,
      key,
      value,
      description: "",
    }));
    // Store URL without query string — params are the source of truth
    const { baseUrl, hash } = splitUrlParts(rawUrl);
    return {
      url: `${baseUrl}${hash}`,
      params: [...params, ...currentParams.filter((item) => !item.enabled)],
    };
  } catch {
    return {
      url: rawUrl,
      params: currentParams,
    };
  }
}

function buildUrlWithParams(rawUrl: string, params: KeyValuePair[]) {
  const { baseUrl, hash } = splitUrlParts(rawUrl)
  const searchParams = new URLSearchParams()

  for (const item of params) {
    if (item.enabled && item.key) {
      searchParams.append(item.key, item.value)
    }
  }

  const query = searchParams.toString()
  const urlWithoutHash = query ? `${baseUrl}?${query}` : baseUrl
  return `${urlWithoutHash}${hash}`
}

function splitUrlParts(rawUrl: string) {
  const hashIndex = rawUrl.indexOf("#")
  const hash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf("?")
  const baseUrl = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)

  return {
    baseUrl,
    hash,
  }
}

function toParsableUrl(rawUrl: string) {
  return rawUrl.includes("://") ? rawUrl : `http://placeholder${rawUrl.startsWith("/") || rawUrl.startsWith("?") ? "" : "/"}${rawUrl}`
}

onMounted(() => {
  window.addEventListener("apisolo:save-request", onSaveShortcut as EventListener);
  document.addEventListener("click", handleOutsideClick);
});

onUnmounted(() => {
  window.removeEventListener("apisolo:save-request", onSaveShortcut as EventListener);
  document.removeEventListener("click", handleOutsideClick);
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
    <UrlBar
      :method="activeTab.method"
      :url="buildUrlWithParams(activeTab.url, activeTab.params)"
      :is-loading="isLoading"
      @update:method="updateMethod"
      @update:url="updateUrl"
      @send="sendRequest"
      @cancel="cancelRequest"
      @import-curl="openCurlImportDialog"
      @copy-curl="copyAsCurl"
      @paste-curl="applyPastedCurl"
    />

    <div
      class="flex flex-nowrap items-center gap-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_92%,black)] px-4 py-2.5"
    >
      <div class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div class="flex min-w-max flex-nowrap items-center gap-2 whitespace-nowrap">
          <button
            v-for="section in sections"
            :key="section.key"
            class="inline-flex shrink-0 items-center gap-2 rounded border px-3 py-1.5 text-sm transition"
            :class="
              activeSection === section.key
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            "
            type="button"
            @click="activeSection = section.key"
          >
            <span>{{ section.label }}</span>
            <span
              class="min-w-5 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold"
              :class="
                section.count > 0
                  ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[var(--text-primary)]'
                  : 'bg-[color-mix(in_srgb,var(--bg-primary)_86%,white)] text-[var(--text-secondary)]'
              "
            >
              {{ section.count }}
            </span>
          </button>
        </div>
      </div>

      <div ref="requestActionsRef" class="relative flex shrink-0 items-center gap-2">
        <div
          v-if="curlCopied"
          class="hidden h-8 items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 text-xs font-semibold whitespace-nowrap text-emerald-300 lg:inline-flex"
        >
          <Check :size="14" />
          <span>{{ t("request.curlCopied") }}</span>
        </div>

        <button
          v-if="activeProject"
          class="inline-flex h-8 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-sm font-medium text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
          type="button"
          :title="t('request.save')"
          @click="openSaveDialog"
        >
          <Save :size="14" />
          <span class="hidden md:inline">{{ t("request.save") }}</span>
        </button>

        <button
          class="inline-flex h-8 w-8 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] hover:text-[var(--text-primary)]"
          type="button"
          :title="t('request.moreActions')"
          :aria-label="t('request.moreActions')"
          @click.stop="toggleRequestActions"
        >
          <MoreHorizontal :size="14" />
        </button>

        <div
          v-if="requestActionsOpen"
          class="absolute right-0 top-full z-20 mt-2 min-w-44 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] py-1 shadow-lg"
        >
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] transition hover:bg-[var(--bg-secondary)]"
            type="button"
            @click="openCurlImportDialog"
          >
            <Download :size="14" />
            <span>{{ t("request.importCurl") }}</span>
          </button>
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] transition hover:bg-[var(--bg-secondary)]"
            type="button"
            @click="copyAsCurl"
          >
            <Copy :size="14" />
            <span>{{ t("request.copyAsCurl") }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-auto p-4">
      <div v-show="activeSection === 'params'" class="h-full">
        <KeyValueEditor :model-value="activeTab.params" @update:model-value="updateParams" />
      </div>

      <div v-show="activeSection === 'headers'" class="h-full">
        <KeyValueEditor :model-value="activeTab.headers" @update:model-value="updateHeaders" />
      </div>

      <div v-show="activeSection === 'body'" class="h-full">
        <BodyEditor :model-value="activeTab.body" @update:model-value="updateBody" />
      </div>

      <div v-show="activeSection === 'auth'" class="h-full">
        <AuthEditor :model-value="activeTab.auth" @update:model-value="updateAuth" />
      </div>

      <div v-show="activeSection === 'scripts'" class="h-full">
        <ScriptsEditor
          :pre-request-script="activeTab.preRequestScript"
          :test-script="activeTab.testScript"
          @update:pre-request-script="updatePreRequestScript"
          @update:test-script="updateTestScript"
        />
      </div>
    </div>

    <div
      v-if="showSaveDialog"
      class="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
    >
      <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
        <div class="mb-4 text-lg font-semibold text-[var(--text-primary)]">{{ t("request.saveRequest") }}</div>

        <div class="space-y-3">
          <div>
            <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">
              {{ t("request.saveLocation") }}
            </div>
          </div>
          <select
            v-model="saveCollection"
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          >
            <option v-for="option in collectionOptions" :key="option.value || 'root'" :value="option.value">
              {{ option.label }}
            </option>
          </select>

          <input
            v-model="saveName"
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('request.requestNameExample')"
          />
        </div>

        <div v-if="saveError" class="mt-3 text-sm text-rose-300">
          {{ saveError }}
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            type="button"
            @click="closeSaveDialog"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
            type="button"
            @click="submitSave"
          >
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="showCurlImportDialog"
      class="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
    >
      <div class="w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
        <div class="mb-2 text-lg font-semibold text-[var(--text-primary)]">{{ t("request.importCurlTitle") }}</div>
        <p class="mb-4 text-sm text-[var(--text-secondary)]">
          {{ t("request.importCurlDescription") }}
        </p>

        <textarea
          v-model="curlInput"
          class="min-h-56 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 font-mono text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          placeholder="curl https://api.example.com/users -H 'Authorization: Bearer token' -d '{&quot;name&quot;:&quot;test&quot;}'"
        />

        <div v-if="curlError" class="mt-3 text-sm text-rose-300">
          {{ curlError }}
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            type="button"
            @click="closeCurlImportDialog"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
            type="button"
            @click="applyCurlImport"
          >
            {{ t("request.import") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
section {
  position: relative;
}
</style>
