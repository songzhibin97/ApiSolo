<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ResponseBody from "../response/ResponseBody.vue";
import ResponseCookies from "../response/ResponseCookies.vue";
import ResponseHeaders from "../response/ResponseHeaders.vue";
import ScriptResults from "../response/ScriptResults.vue";
import TimingsWaterfall from "../response/TimingsWaterfall.vue";
import { useTabsStore } from "../../stores/tabs";

type ResponseTab = "body" | "headers" | "cookies" | "tests" | "timings";

const tabsStore = useTabsStore();
const { t } = useI18n();

const activeSection = ref<ResponseTab>("body");
const response = computed(() => tabsStore.activeTab?.response ?? null);
const error = computed(() => tabsStore.activeTab?.responseError ?? null);
const isLoading = computed(() => tabsStore.activeTab?.isLoading ?? false);
const scriptResult = computed(() => tabsStore.activeTab?.scriptResult ?? null);
const sections = computed(() => [
  { key: "body" as const, label: t("response.body") },
  { key: "headers" as const, label: t("response.headers") },
  { key: "cookies" as const, label: t("response.cookies") },
  { key: "tests" as const, label: t("response.tests") },
  { key: "timings" as const, label: t("response.timings") },
]);

watch(
  () => tabsStore.activeTabId,
  () => {
    activeSection.value = "body";
  },
);

const statusClass = computed(() => {
  const code = response.value?.status ?? 0;

  if (code >= 200 && code < 300) {
    return "bg-emerald-500/12 text-emerald-300 border-emerald-500/30";
  }

  if (code >= 300 && code < 400) {
    return "bg-sky-500/12 text-sky-300 border-sky-500/30";
  }

  if (code >= 400 && code < 500) {
    return "bg-amber-500/12 text-amber-300 border-amber-500/30";
  }

  return "bg-rose-500/12 text-rose-300 border-rose-500/30";
});

const responseSummary = computed(() => {
  if (!response.value) {
    return [];
  }

  return [
    `DNS ${response.value.timings.dnsLookup}ms`,
    `TCP ${response.value.timings.tcpConnect}ms`,
    `Download ${response.value.timings.download}ms`,
    `Total ${response.value.timings.total}ms`,
    formatBytes(response.value.size),
  ];
});

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
    <div v-if="!isLoading && !response && !error" class="flex flex-1 items-center justify-center p-6">
      <div
        class="flex max-w-sm flex-col items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-6 text-center"
      >
        <div
          class="flex h-12 w-12 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]"
        >
          <span class="text-lg font-semibold">R</span>
        </div>
        <h2 class="text-sm font-semibold text-[var(--text-primary)]">{{ t("response.emptyTitle") }}</h2>
        <p class="text-sm leading-6 text-[var(--text-secondary)]">
          {{ t("response.emptyDescription") }}
        </p>
      </div>
    </div>

    <div v-else-if="isLoading" class="flex flex-1 p-6">
      <div class="flex w-full flex-col gap-3">
        <div class="h-9 w-40 animate-pulse rounded bg-[color-mix(in_srgb,var(--bg-surface)_45%,transparent)]" />
        <div class="grid gap-3">
          <div class="h-4 w-24 animate-pulse rounded bg-[color-mix(in_srgb,var(--bg-surface)_45%,transparent)]" />
          <div class="h-28 animate-pulse rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_55%,transparent)]" />
          <div class="h-4 w-32 animate-pulse rounded bg-[color-mix(in_srgb,var(--bg-surface)_45%,transparent)]" />
          <div class="h-20 animate-pulse rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_55%,transparent)]" />
        </div>
      </div>
    </div>

    <div v-else-if="error" class="flex flex-1 p-4">
      <div
        class="flex w-full flex-col gap-2 rounded-lg border border-rose-500/25 bg-rose-500/8 p-4"
      >
        <div class="text-sm font-semibold text-rose-300">{{ t("response.requestFailed") }}</div>
        <pre class="overflow-auto whitespace-pre-wrap break-words font-mono text-sm text-rose-100">{{ error }}</pre>
      </div>
    </div>

    <div v-else-if="response" class="flex min-h-0 flex-1 flex-col">
      <div class="flex flex-nowrap items-center gap-3 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 whitespace-nowrap">
        <div
          class="rounded border px-3 py-1 text-sm font-semibold"
          :class="statusClass"
        >
          {{ response.status }} {{ response.statusText }}
        </div>
        <template v-for="item in responseSummary" :key="item">
          <div class="text-[var(--border)]">|</div>
          <div class="text-sm text-[var(--text-secondary)]">{{ item }}</div>
        </template>
      </div>

      <div class="min-w-0 overflow-x-auto overflow-y-hidden border-b border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2.5">
        <div class="flex min-w-max flex-nowrap items-center gap-2 whitespace-nowrap">
          <button
            v-for="section in sections"
            :key="section.key"
            class="shrink-0 rounded border px-3 py-1.5 text-sm capitalize transition"
            :class="
              activeSection === section.key
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            "
            type="button"
            @click="activeSection = section.key"
          >
            {{ section.label }}
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)] p-4">
        <ResponseBody
          v-if="activeSection === 'body'"
          :body="response.body"
          :content-type="response.contentType"
          :body-kind="response.bodyKind"
        />
        <ResponseHeaders v-else-if="activeSection === 'headers'" :headers="response.headers" />
        <ResponseCookies v-else-if="activeSection === 'cookies'" :headers="response.headers" />
        <ScriptResults v-else-if="activeSection === 'tests'" :result="scriptResult" />
        <TimingsWaterfall v-else :timings="response.timings" />
      </div>
    </div>
  </section>
</template>
