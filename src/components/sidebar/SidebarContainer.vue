<script setup lang="ts">
import { storeToRefs } from "pinia"

import CollectionPanel from "./CollectionPanel.vue"
import EnvironmentPanel from "./EnvironmentPanel.vue"
import HistoryPanel from "./HistoryPanel.vue"
import { useUIStore } from "../../stores/ui"

const uiStore = useUIStore()
const { sidebarActiveItem } = storeToRefs(uiStore)
</script>

<template>
  <aside class="flex h-full min-h-0 min-w-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]">
    <CollectionPanel v-if="sidebarActiveItem === 'collections'" />
    <HistoryPanel v-else-if="sidebarActiveItem === 'history'" />
    <EnvironmentPanel v-else />
  </aside>
</template>
