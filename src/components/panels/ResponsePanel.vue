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

/**
 * Names the response on screen so `:key` can hold it. The name is derived from
 * the response object itself and from nothing inside it.
 *
 * That distinction is the whole point. The body view carries state that is
 * about one particular response — which copy attempt is in flight, what the
 * copy button is currently saying, which of tree or raw the user picked — and
 * all of it has to be gone the moment a different response is shown. Judging
 * "different" by comparing bodies and content types answers a different
 * question: two tabs can hold byte-identical responses, and a comparison of
 * their contents says "same" while the fact is "another one". A copy that
 * failed on the first tab then wrote "Copy failed" onto the second, over a
 * response nobody had tried to copy.
 *
 * The store never edits a response in place — `tab.response` is replaced whole
 * on every send and on every history restore — so the object reference is the
 * identity, and this map only gives that reference a stable name. Nothing here
 * has to be kept in sync with anything, because nothing is being tracked.
 */
const responseNames = new WeakMap<object, number>();
let lastResponseName = 0;

const responseKey = computed(() => {
  const current = response.value;

  if (!current) {
    return 0;
  }

  const known = responseNames.get(current);

  if (known !== undefined) {
    return known;
  }

  lastResponseName += 1;
  responseNames.set(current, lastResponseName);

  return lastResponseName;
});

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

      <!--
        Keyed on which response this is, so Vue builds these views afresh for a
        new response instead of handing the existing ones different props.
        Every piece of per-response state inside them then starts from nothing
        without anyone having to remember to clear it: the body view's copy
        state and view choice, the header view's filter keyword, and whatever a
        later view keeps. The key sits on the container rather than on each
        child on purpose — a list of which children need it is a list someone
        has to remember to add to.
      -->
      <div :key="responseKey" class="min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)] p-4">
        <ResponseBody
          v-if="activeSection === 'body'"
          :body="response.body"
          :content-type="response.contentType"
          :body-kind="response.bodyKind"
          :body-truncated="response.bodyTruncated"
          :body-source="response.bodySource"
        />
        <ResponseHeaders v-else-if="activeSection === 'headers'" :headers="response.headers" />
        <ResponseCookies v-else-if="activeSection === 'cookies'" :headers="response.headers" />
        <ScriptResults v-else-if="activeSection === 'tests'" :result="scriptResult" />
        <TimingsWaterfall v-else :timings="response.timings" />
      </div>
    </div>
  </section>
</template>
