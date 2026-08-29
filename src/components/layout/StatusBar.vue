<script setup lang="ts">
import { storeToRefs } from "pinia"
import { Bug } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { useConsoleStore } from "../../stores/console"

const { t } = useI18n()
const consoleStore = useConsoleStore()
const { errorCount, isOpen } = storeToRefs(consoleStore)

const appVersion = __APP_VERSION__
</script>

<template>
  <footer
    class="flex h-6 min-w-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[11px] text-[var(--text-secondary)]"
  >
    <div class="flex min-w-0 items-center gap-3">
      <button
        type="button"
        data-testid="console-toggle"
        class="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
        :class="isOpen ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : ''"
        @click="consoleStore.toggle()"
      >
        <Bug class="h-3.5 w-3.5 shrink-0" data-testid="console-icon" />
        <span
          v-if="errorCount > 0"
          class="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] leading-4 text-white"
          data-testid="console-error-count"
        >
          {{ errorCount }}
        </span>
        <span data-testid="console-title">{{ t("console.title") }}</span>
      </button>
      <span class="truncate">{{ t("status.ready") }}</span>
    </div>
    <span class="shrink-0" data-testid="app-version">v{{ appVersion }}</span>
  </footer>
</template>
