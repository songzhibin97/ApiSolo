<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  headers: [string, string][];
}>();

const keyword = ref("");
const { t } = useI18n();

const filteredHeaders = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) {
    return props.headers;
  }

  return props.headers.filter(([name, value]) => {
    return name.toLowerCase().includes(query) || value.toLowerCase().includes(query);
  });
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <input
      v-model="keyword"
      class="h-9 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
      :placeholder="t('response.filterHeaders')"
      type="text"
    />

    <div class="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <table class="min-w-full table-fixed border-collapse font-mono text-sm select-none">
        <thead class="sticky top-0 bg-[color-mix(in_srgb,var(--bg-primary)_92%,black)] text-left text-[var(--text-secondary)]">
          <tr>
            <th class="w-1/3 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.headerName") }}</th>
            <th class="border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.value") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[name, value] in filteredHeaders" :key="`${name}:${value}`">
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-primary)]">
              <span class="select-text">{{ name }}</span>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top break-all text-[var(--text-secondary)]">
              <span class="select-text">{{ value }}</span>
            </td>
          </tr>
          <tr v-if="filteredHeaders.length === 0">
            <td colspan="2" class="px-4 py-10 text-center text-[var(--text-secondary)]">
              {{ t("response.noHeadersMatched") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
