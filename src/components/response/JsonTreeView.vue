<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

defineOptions({
  name: "JsonTreeNode",
});

const props = withDefaults(
  defineProps<{
    data: unknown;
    rootKey?: string;
    depth?: number;
    defaultExpandDepth?: number;
  }>(),
  {
    rootKey: undefined,
    depth: 0,
    defaultExpandDepth: 2,
  },
);

const { t } = useI18n();

const copied = ref(false);
const expanded = ref(props.depth < props.defaultExpandDepth);
let copiedTimer: number | null = null;

const isArrayValue = computed(() => Array.isArray(props.data));
const isObjectValue = computed(
  () => props.data !== null && typeof props.data === "object" && !Array.isArray(props.data),
);
const isCollapsible = computed(() => isArrayValue.value || isObjectValue.value);
const entries = computed(() => {
  if (isArrayValue.value) {
    return (props.data as unknown[]).map((value, index) => ({
      key: String(index),
      value,
    }));
  }

  if (isObjectValue.value) {
    return Object.entries(props.data as Record<string, unknown>).map(([key, value]) => ({
      key,
      value,
    }));
  }

  return [];
});

const itemCountLabel = computed(() => `${entries.value.length} ${t("response.items")}`);
const linePadding = computed(() => ({ paddingLeft: `${props.depth * 20}px` }));

function toggleExpanded() {
  if (!isCollapsible.value) {
    return;
  }

  expanded.value = !expanded.value;
}

function formatKey(key?: string) {
  if (!key) {
    return "";
  }

  return `${key}: `;
}

function formatPrimitiveValue(value: unknown) {
  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (value === null) {
    return "null";
  }

  return String(value);
}

function primitiveClass(value: unknown) {
  if (typeof value === "string") {
    return "text-emerald-300";
  }

  if (typeof value === "number") {
    return "text-amber-300";
  }

  if (typeof value === "boolean") {
    return "text-violet-300";
  }

  if (value === null) {
    return "text-slate-400";
  }

  return "text-[var(--text-primary)]";
}

function getCopyValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

async function copyValue(value: unknown) {
  if (value === undefined || !navigator?.clipboard) {
    return;
  }

  await navigator.clipboard.writeText(getCopyValue(value) ?? "");
  copied.value = true;

  if (copiedTimer !== null) {
    window.clearTimeout(copiedTimer);
  }

  copiedTimer = window.setTimeout(() => {
    copied.value = false;
    copiedTimer = null;
  }, 1200);
}
</script>

<template>
  <div class="font-mono text-sm leading-6 text-[var(--text-primary)]">
    <template v-if="isCollapsible">
      <div
        class="group flex items-start gap-2 rounded px-2 py-0.5 transition hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
        :style="linePadding"
      >
        <button
          type="button"
          class="mt-0.5 text-xs text-[var(--text-secondary)] transition"
          @click="toggleExpanded"
        >
          <span
            class="block transition-transform duration-150"
            :class="expanded ? 'rotate-0' : '-rotate-90'"
          >
            ▼
          </span>
        </button>
        <button
          type="button"
          class="min-w-0 flex-1 text-left"
          @click="toggleExpanded"
        >
          <span v-if="rootKey" class="font-semibold text-[var(--text-secondary)]">{{ formatKey(rootKey) }}</span>
          <span>{{ isArrayValue ? "[" : "{" }}</span>
          <template v-if="!expanded">
            <span>{{ isArrayValue ? " ... ]" : " ... }" }}</span>
            <span class="ml-2 text-xs text-[var(--text-secondary)]">{{ itemCountLabel }}</span>
          </template>
        </button>
      </div>

      <div v-if="expanded">
        <JsonTreeNode
          v-for="entry in entries"
          :key="entry.key"
          :data="entry.value"
          :root-key="entry.key"
          :depth="depth + 1"
          :default-expand-depth="defaultExpandDepth"
        />
        <div
          class="rounded px-2 py-0.5 text-[var(--text-primary)]"
          :style="linePadding"
        >
          {{ isArrayValue ? "]" : "}" }}
        </div>
      </div>
    </template>

    <div
      v-else
      class="group flex items-center gap-2 rounded px-2 py-0.5 transition hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
      :style="linePadding"
    >
      <span v-if="rootKey" class="font-semibold text-[var(--text-secondary)]">{{ formatKey(rootKey) }}</span>
      <button
        type="button"
        class="inline-flex items-center gap-2 text-left"
        :class="primitiveClass(data)"
        @click="copyValue(data)"
      >
        <span>{{ formatPrimitiveValue(data) }}</span>
        <span
          v-if="copied"
          class="text-xs text-[var(--text-secondary)]"
        >
          {{ t("response.copied") }}
        </span>
      </button>
    </div>
  </div>
</template>
