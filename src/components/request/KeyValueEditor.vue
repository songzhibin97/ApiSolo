<script setup lang="ts">
import { computed } from "vue";
import { Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { applyPairEdit } from "../../utils/redaction";
import type { KeyValuePair } from "../../types";

const props = defineProps<{
  modelValue: KeyValuePair[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: KeyValuePair[]];
}>();
const { t } = useI18n();

function createEmptyPair(): KeyValuePair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    key: "",
    value: "",
    description: "",
  };
}

const rows = computed(() => {
  const baseRows = props.modelValue.length > 0 ? props.modelValue : [];
  const lastRow = baseRows[baseRows.length - 1];

  if (!lastRow || lastRow.key || lastRow.value || lastRow.description) {
    return [...baseRows, createEmptyPair()];
  }

  return baseRows;
});

function commitRows(nextRows: KeyValuePair[]) {
  const hasFilledRows = nextRows.some((row) => row.key || row.value || row.description);
  const normalizedRows = hasFilledRows
    ? nextRows.filter((row) => row.key || row.value || row.description)
    : [];

  emit("update:modelValue", normalizedRows);
}

function updateRow(id: string, patch: Partial<KeyValuePair>) {
  commitRows(applyPairEdit(rows.value, id, patch));
}

function removeRow(id: string) {
  commitRows(rows.value.filter((row) => row.id !== id));
}

function updateEnabled(id: string, event: Event) {
  updateRow(id, { enabled: (event.target as HTMLInputElement).checked });
}

function updateText(id: string, field: "key" | "value" | "description", event: Event) {
  updateRow(id, { [field]: (event.target as HTMLInputElement).value });
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
    <div
      class="grid grid-cols-[36px_minmax(120px,1fr)_minmax(120px,1fr)_44px] border-b border-[var(--border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)] lg:grid-cols-[36px_minmax(140px,1fr)_minmax(160px,1fr)_minmax(180px,1.1fr)_44px]"
    >
      <span>{{ t("keyValue.on") }}</span>
      <span>{{ t("keyValue.key") }}</span>
      <span>{{ t("keyValue.value") }}</span>
      <span class="hidden lg:block">{{ t("keyValue.description") }}</span>
      <span class="text-right">{{ t("keyValue.del") }}</span>
    </div>

    <div class="flex-1 overflow-auto">
      <div
      v-if="modelValue.length === 0"
      class="border-b border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)]"
    >
      {{ t("keyValue.addPair") }}
    </div>

      <div
        v-for="row in rows"
        :key="row.id"
        class="grid grid-cols-[36px_minmax(120px,1fr)_minmax(120px,1fr)_44px] items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_80%,transparent)] px-3 py-2 transition lg:grid-cols-[36px_minmax(140px,1fr)_minmax(160px,1fr)_minmax(180px,1.1fr)_44px]"
        :class="row.enabled ? '' : 'opacity-45'"
      >
        <label class="flex items-center justify-center">
          <input
            class="h-4 w-4 rounded border-[var(--border)] bg-[var(--bg-primary)] accent-[var(--accent)]"
            type="checkbox"
            :checked="row.enabled"
            @change="updateEnabled(row.id, $event)"
          />
        </label>

        <input
          class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          type="text"
          :placeholder="t('keyValue.key')"
          :value="row.key"
          @input="updateText(row.id, 'key', $event)"
        />

        <input
          class="h-9 w-full rounded border bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          :class="row.redacted ? 'border-amber-500' : 'border-[var(--border)]'"
          type="text"
          :placeholder="row.redacted ? t('keyValue.redactedPlaceholder') : t('keyValue.value')"
          :value="row.value"
          @input="updateText(row.id, 'value', $event)"
        />

        <input
          class="hidden h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)] lg:block"
          type="text"
          :placeholder="t('keyValue.description')"
          :value="row.description"
          @input="updateText(row.id, 'description', $event)"
        />

        <button
          class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
          type="button"
          :aria-label="t('keyValue.deleteRow')"
          @click="removeRow(row.id)"
        >
          <Trash2 :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
