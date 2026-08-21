<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import CodeEditor from "../editor/CodeEditor.vue";
import JsonTreeView from "./JsonTreeView.vue";
import type { ResponseBodyKind } from "../../types";

const props = defineProps<{
  body: string;
  contentType: string;
  bodyKind?: ResponseBodyKind;
}>();

const { t } = useI18n();
const activeMode = ref<"tree" | "raw">("raw");
const MAX_DISPLAY_SIZE = 500_000

/**
 * The decision is the flag, never the content type. A response declaring
 * `text/plain` that carries NUL bytes has already been judged binary upstream,
 * and matching the placeholder text instead would call a body binary purely
 * because the server happened to send a sentence that looks like one.
 */
const isBinary = computed(() => props.bodyKind === "binary");

const normalizedContentType = computed(() => props.contentType.toLowerCase());
const isTruncated = computed(() => props.body.length > MAX_DISPLAY_SIZE)

const viewType = computed(() => {
  const type = normalizedContentType.value;

  if (type.includes("application/json") || type.includes("+json")) {
    return "json";
  }

  if (type.includes("text/html")) {
    return "xml";
  }

  if (type.includes("text/xml") || type.includes("application/xml") || type.includes("+xml")) {
    return "xml";
  }

  return "text";
});

const parsedJsonState = computed(() => {
  if (viewType.value !== "json") {
    return {
      isValid: false,
      value: null as unknown,
    };
  }

  try {
    return {
      isValid: true,
      value: JSON.parse(props.body) as unknown,
    };
  } catch {
    return {
      isValid: false,
      value: null as unknown,
    };
  }
});

const parsedJson = computed(() => parsedJsonState.value.value);
const canUseTreeView = computed(
  () => parsedJsonState.value.isValid && !isTruncated.value && !isBinary.value,
);

const displayBody = computed(() => {
  if (isTruncated.value) {
    return `${props.body.slice(0, MAX_DISPLAY_SIZE)}\n\n${t("response.largeBodyTruncated")}`
  }

  if (viewType.value !== "json") {
    return props.body;
  }

  try {
    return JSON.stringify(parsedJson.value, null, 2);
  } catch {
    return props.body;
  }
});

watch(
  () => [canUseTreeView.value, props.body, props.contentType],
  ([value]) => {
    activeMode.value = value ? "tree" : "raw";
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <div
      v-if="isBinary"
      data-testid="binary-body-notice"
      class="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 text-center text-sm leading-6 text-[var(--text-secondary)]"
    >
      {{ t("response.binaryBody") }}
    </div>

    <template v-else>
    <div v-if="canUseTreeView" class="flex items-center gap-2">
      <button
        type="button"
        class="rounded border px-3 py-1.5 text-sm transition"
        :class="
          activeMode === 'tree'
            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        "
        @click="activeMode = 'tree'"
      >
        {{ t("response.treeView") }}
      </button>
      <button
        type="button"
        class="rounded border px-3 py-1.5 text-sm transition"
        :class="
          activeMode === 'raw'
            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        "
        @click="activeMode = 'raw'"
      >
        {{ t("response.rawView") }}
      </button>
    </div>

    <div
      v-if="canUseTreeView && activeMode === 'tree'"
      class="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3"
    >
      <JsonTreeView :data="parsedJson" />
    </div>

    <CodeEditor
      v-else
      :model-value="displayBody"
      :language="viewType"
      readonly
      class="min-h-0 flex-1"
    />
    </template>
  </div>
</template>
