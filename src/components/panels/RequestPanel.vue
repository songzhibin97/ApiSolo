<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Check, Copy, Download, MoreHorizontal, Save } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { useProjectsStore } from "../../stores/projects";
import { useRequestStore } from "../../stores/request";
import { useSaveGateStore } from "../../stores/save-gate";
import { isUntitledTabLabel, useTabsStore } from "../../stores/tabs";
import { flattenCollectionFolders } from "../../utils/collection-options";
import { exportCurl } from "../../utils/curl-export";
import { parseCurl } from "../../utils/curl-parser";
import {
  bannerFields,
  formatPendingField,
  pendingRefillFields,
  refillFields,
  unverifiableFields,
  type PendingField,
} from "../../utils/pending-refill";
import { buildSavedRequest } from "../../utils/saved-request";
import { buildUrlWithParams, syncParamsFromUrl } from "../../utils/url-params";
import AuthEditor from "../request/AuthEditor.vue";
import BodyEditor from "../request/BodyEditor.vue";
import KeyValueEditor from "../request/KeyValueEditor.vue";
import PendingRefillNotice from "../request/PendingRefillNotice.vue";
import ScriptsEditor from "../request/ScriptsEditor.vue";
import UrlBar from "../request/UrlBar.vue";
import InlineError from "../ui/InlineError.vue";
import type {
  AuthConfig,
  HttpMethod,
  KeyValuePair,
  RequestBody,
  Tab,
} from "../../types";

const tabsStore = useTabsStore();
const projectsStore = useProjectsStore();
const requestStore = useRequestStore();
const saveGate = useSaveGateStore();
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
  ...flattenCollectionFolders(collectionTree.value),
]);

/**
 * The same check the history entry point runs, on the same criteria. The gate
 * is on the state of the request, not on which button was pressed: this button
 * is the one that used to have no gate at all, and it is the second step of the
 * path where a request from history gets saved blank and then 401s in silence.
 */
const pendingFields = computed(() => pendingRefillFields(activeTab.value));
const saveBlocked = computed(() => saveGate.blocksSave(pendingFields.value));

/**
 * The always-on notice reads the save gate's own list. It used to derive the
 * same fact separately, and the two had drifted: the gate would hold a save for
 * a blanked Bearer token while the notice said nothing at all, and the user's
 * next move is Send, not Save. One derivation means they cannot disagree —
 * whether the notice appears and what it says now change together.
 */
const noticeFields = computed(() => bannerFields(pendingFields.value));

/**
 * Split by class, using the save dialog's own filters. The two classes are not
 * the same statement and must not be run together into one: "these need
 * re-entering" is a claim we can only make about fields we can see are still
 * blank. When the body will not parse we cannot see that, so saying it there
 * would send the user to fill a field back in and leave the notice standing
 * afterwards, with nothing on screen explaining why or how to clear it.
 */
const refillNotice = computed(() => refillFields(noticeFields.value));
const unverifiableNotice = computed(() => unverifiableFields(noticeFields.value));

function labelsOf(fields: PendingField[]) {
  return fields.map((field) => formatPendingField(field, t)).join(", ");
}

const refillFieldLabels = computed(() => labelsOf(refillNotice.value));
const unverifiableFieldLabels = computed(() => labelsOf(unverifiableNotice.value));

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
  // The URL bar's own echo — the one write that must not bump urlRevision,
  // otherwise every keystroke would replace the text being typed.
  tabsStore.updateTabFromUrlBar(activeTab.value.id, {
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

// No bookkeeping here on purpose. This used to clear the redaction marker
// whenever the body text changed, which meant the body editor reformatting a
// compact JSON payload for display wiped the gate — the values were untouched,
// but the record of what had been blanked was gone. Nothing outside
// `openHistoryEntry` writes that record any more; what still needs re-entering
// is recomputed from the body each time it is asked.
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
  // Depth behind the `disabled` binding, which is what actually stops the
  // click today -- so no test can kill this line on its own, and deleting it
  // changes nothing observable. It stays because `disabled` only guards the one
  // button: anything that calls this function directly (a keyboard shortcut, a
  // form submit, a future third entry point) arrives here with the binding
  // never consulted, and this slice exists because a save that goes through
  // unannounced is silent.
  if (saveBlocked.value) {
    return;
  }

  saveError.value = "";

  try {
    await projectsStore.saveRequest(
      saveCollection.value,
      buildSavedRequest(activeTab.value, saveName.value),
      activeTab.value,
    );
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

function deriveCollectionPath(path: string | null) {
  if (!path || !path.includes("/")) {
    return "";
  }

  return path.split("/").slice(0, -1).join("/");
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
      :tab-id="activeTab.id"
      :url-revision="activeTab.urlRevision"
      :is-loading="isLoading"
      @update:method="updateMethod"
      @update:url="updateUrl"
      @send="sendRequest"
      @cancel="cancelRequest"
      @import-curl="openCurlImportDialog"
      @copy-curl="copyAsCurl"
      @paste-curl="applyPastedCurl"
    />

    <!--
      Two sentences, each rendered only when its own class is present, and both
      when both are. The list of names alone cannot tell the two apart: the same
      "Body · token" row means "type this back in" in one state and "we cannot
      tell whether you already did" in the other.
    -->
    <div
      v-if="noticeFields.length > 0"
      data-testid="history-redacted-banner"
      class="space-y-1 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300"
    >
      <p v-if="refillNotice.length > 0" data-testid="history-redacted-banner-refill">
        {{ t("request.historyRedactedBanner", { fields: refillFieldLabels }) }}
      </p>
      <div v-if="unverifiableNotice.length > 0" data-testid="history-redacted-banner-unverifiable">
        <p>{{ t("history.refillUnparseableBody", { count: unverifiableNotice.length }) }}</p>
        <!--
          The names still get listed. The user needs to know which fields the
          message is about, and the sentence above only carries how many.
        -->
        <p class="font-mono">{{ unverifiableFieldLabels }}</p>
      </div>
    </div>

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

          <PendingRefillNotice :fields="pendingFields" />
        </div>

        <div class="mt-3">
          <InlineError :message="saveError" />
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
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="request-save-submit"
            type="button"
            :disabled="saveBlocked"
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
