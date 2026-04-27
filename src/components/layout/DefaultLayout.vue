<script setup lang="ts">
import { storeToRefs } from "pinia"
import { Pane, Splitpanes } from "splitpanes"
import "splitpanes/dist/splitpanes.css"

import { useKeyboard } from "../../composables/useKeyboard"
import { useTabsStore } from "../../stores/tabs"
import { useUIStore } from "../../stores/ui"
import AppHeader from "./AppHeader.vue"
import AppSidebar from "./AppSidebar.vue"
import DebugConsole from "./DebugConsole.vue"
import StatusBar from "./StatusBar.vue"
import TabBar from "./TabBar.vue"
import RequestPanel from "../panels/RequestPanel.vue"
import ResponsePanel from "../panels/ResponsePanel.vue"
import WSConnectionPanel from "../panels/WSConnectionPanel.vue"
import WSMessagePanel from "../panels/WSMessagePanel.vue"
import SidebarContainer from "../sidebar/SidebarContainer.vue"
import SettingsModal from "../settings/SettingsModal.vue"
import { useConsoleStore } from "../../stores/console"

useKeyboard()

const uiStore = useUIStore()
const tabsStore = useTabsStore()
const consoleStore = useConsoleStore()
const { activeTab } = storeToRefs(tabsStore)
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
    <AppHeader />
    <div class="flex flex-1 overflow-hidden">
      <AppSidebar />
      <Splitpanes class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Pane
          v-if="!uiStore.sidebarCollapsed"
          class="min-h-0 overflow-hidden"
          :size="22"
          min-size="18"
          max-size="40"
        >
          <SidebarContainer />
        </Pane>
        <Pane class="min-h-0 overflow-hidden" :size="uiStore.sidebarCollapsed ? 100 : 78" min-size="60">
          <div class="flex h-full flex-col overflow-hidden">
            <TabBar />
            <Splitpanes horizontal class="min-h-0 flex-1 overflow-hidden">
              <Pane class="min-h-0 overflow-hidden" :size="45" min-size="20">
                <RequestPanel v-if="activeTab.protocol === 'http'" />
                <WSConnectionPanel v-else />
              </Pane>
              <Pane class="min-h-0 overflow-hidden" :size="55" min-size="20">
                <ResponsePanel v-if="activeTab.protocol === 'http'" />
                <WSMessagePanel v-else />
              </Pane>
            </Splitpanes>
            <DebugConsole v-if="consoleStore.isOpen" />
            <StatusBar />
          </div>
        </Pane>
      </Splitpanes>
    </div>
    <SettingsModal />
  </div>
</template>
