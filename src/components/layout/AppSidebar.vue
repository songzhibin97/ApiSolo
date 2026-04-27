<script setup lang="ts">
import { computed } from "vue";
import { Braces, FolderOpen, History, Settings } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { useUIStore } from "../../stores/ui";

const uiStore = useUIStore();
const { t } = useI18n();

const items = computed(() => [
  { id: "collections", label: t("layout.collections"), icon: FolderOpen },
  { id: "history", label: t("layout.history"), icon: History },
  { id: "environments", label: t("layout.environments"), icon: Braces },
] as const);

function handleClick(itemId: "collections" | "history" | "environments") {
  if (uiStore.sidebarActiveItem === itemId) {
    uiStore.toggleSidebar()
    return
  }

  uiStore.setSidebarItem(itemId)
  if (uiStore.sidebarCollapsed) {
    uiStore.toggleSidebar()
  }
}
</script>

<template>
  <aside
    class="flex h-full w-12 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]"
  >
    <nav class="flex flex-1 flex-col items-center gap-1 py-2">
      <button
        v-for="item in items"
        :key="item.id"
        class="relative flex h-10 w-full items-center justify-center text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_30%,transparent)] hover:text-[var(--text-primary)]"
        :class="
          uiStore.sidebarActiveItem === item.id
            ? 'bg-[color-mix(in_srgb,var(--bg-surface)_36%,transparent)] text-[var(--text-primary)]'
            : ''
        "
        type="button"
        :aria-label="item.label"
        @click="handleClick(item.id)"
      >
        <span
          v-if="uiStore.sidebarActiveItem === item.id"
          class="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-[var(--accent)]"
        />
        <component :is="item.icon" :size="18" />
      </button>
    </nav>

    <div class="border-t border-[var(--border)] py-2">
      <button
        class="flex h-10 w-full items-center justify-center text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_30%,transparent)] hover:text-[var(--text-primary)]"
        type="button"
        :aria-label="t('layout.openSettings')"
        @click="uiStore.openSettings()"
      >
        <Settings :size="18" />
      </button>
    </div>
  </aside>
</template>
