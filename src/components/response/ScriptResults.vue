<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"

import type { ScriptResult } from "../../types"

const props = defineProps<{
  result: ScriptResult | null
}>()

const { t } = useI18n()
const showLogs = ref(false)

const passedCount = computed(
  () => props.result?.assertions.filter((assertion) => assertion.passed).length ?? 0,
)
</script>

<template>
  <div
    v-if="!result"
    class="flex h-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]"
  >
    {{ t("response.noTestResults") }}
  </div>

  <div v-else class="flex h-full min-h-0 flex-col gap-4">
    <section
      v-if="result.assertions.length"
      class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
    >
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("response.tests") }}</div>
        <div class="text-xs text-[var(--text-secondary)]">
          {{ passedCount }}/{{ result.assertions.length }} {{ t("response.testsPassed") }}
        </div>
      </div>

      <div class="space-y-2">
        <div
          v-for="assertion in result.assertions"
          :key="`${assertion.name}-${assertion.message || 'ok'}`"
          class="rounded-lg border px-3 py-2 text-sm"
          :class="
            assertion.passed
              ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-300'
              : 'border-rose-500/25 bg-rose-500/8 text-rose-300'
          "
        >
          <div class="font-medium">
            {{ assertion.passed ? "✓" : "✗" }} {{ assertion.name }}
          </div>
          <div v-if="assertion.message" class="mt-1 text-xs opacity-90">
            {{ assertion.message }}
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="result.logs.length"
      class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
    >
      <button
        class="flex w-full items-center justify-between text-left text-sm font-semibold text-[var(--text-primary)]"
        type="button"
        @click="showLogs = !showLogs"
      >
        <span>{{ t("response.consoleLogs") }}</span>
        <span class="text-xs text-[var(--text-secondary)]">{{ result.logs.length }}</span>
      </button>

      <div v-if="showLogs" class="mt-3 rounded-lg bg-[var(--bg-primary)] p-3">
        <pre class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-[var(--text-secondary)]">{{ result.logs.join("\n") }}</pre>
      </div>
    </section>

    <section
      v-if="result.errors.length"
      class="rounded-lg border border-rose-500/25 bg-rose-500/8 p-4"
    >
      <div class="mb-2 text-sm font-semibold text-rose-300">{{ t("response.scriptErrors") }}</div>
      <div class="space-y-2">
        <pre
          v-for="(scriptError, index) in result.errors"
          :key="`${index}-${scriptError}`"
          class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-rose-100"
        >{{ scriptError }}</pre>
      </div>
    </section>

    <div
      v-if="!result.assertions.length && !result.logs.length && !result.errors.length"
      class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-6 text-sm text-[var(--text-secondary)]"
    >
      {{ t("response.noTestResults") }}
    </div>
  </div>
</template>
