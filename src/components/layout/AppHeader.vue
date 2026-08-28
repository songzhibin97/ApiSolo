<script setup lang="ts">
import { storeToRefs } from "pinia"
import { Settings } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { useEnvironmentsStore } from "../../stores/environments"
import { useProjectsStore } from "../../stores/projects"
import { useUIStore } from "../../stores/ui"

const projectsStore = useProjectsStore()
const environmentsStore = useEnvironmentsStore()
const uiStore = useUIStore()
const { t } = useI18n()

const { activeProject } = storeToRefs(projectsStore)
const { activeEnv, environments } = storeToRefs(environmentsStore)

const appVersion = __APP_VERSION__

async function handleEnvironmentChange(event: Event) {
  await environmentsStore.setActiveEnv((event.target as HTMLSelectElement).value || null)
}
</script>

<template>
  <header
    class="flex h-10 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-sm"
    data-tauri-drag-region
  >
    <div class="flex min-w-0 items-center gap-3" data-tauri-drag-region>
      <div
        class="flex h-6 w-6 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-xs font-semibold text-[var(--accent)]"
      >
        A
      </div>
      <div class="flex items-baseline gap-2" data-tauri-drag-region>
        <span class="font-semibold tracking-wide text-[var(--text-primary)]">ApiSolo</span>
        <span class="text-xs text-[var(--text-secondary)]" data-testid="app-version">v{{ appVersion }}</span>
      </div>
    </div>
    <div class="flex-1" data-tauri-drag-region></div>
    <div class="flex items-center gap-2">
      <select
        class="h-8 min-w-0 max-w-44 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)] disabled:cursor-not-allowed disabled:opacity-50"
        :value="activeEnv ?? ''"
        :disabled="!activeProject"
        @change="handleEnvironmentChange"
      >
        <option value="">{{ activeProject ? t("layout.none") : t("environment.selectProjectFirst") }}</option>
        <option v-for="name in environments" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
    </div>
    <button
      class="inline-flex h-9 items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--accent)_42%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_16%,var(--bg-primary))] px-3 text-sm font-semibold text-[var(--text-primary)] shadow-[0_10px_30px_-20px_color-mix(in_srgb,var(--accent)_80%,black)] transition hover:border-[color-mix(in_srgb,var(--accent)_75%,white)] hover:bg-[color-mix(in_srgb,var(--accent)_22%,var(--bg-primary))]"
      type="button"
      :aria-label="t('layout.openSettings')"
      @click="uiStore.openSettings()"
    >
      <Settings :size="20" />
      <span>{{ t("settings.title") }}</span>
    </button>
  </header>
</template>
