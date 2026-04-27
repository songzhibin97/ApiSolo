import { ref } from "vue";
import { defineStore } from "pinia";

import type { SidebarItem } from "../types";

export const useUIStore = defineStore("ui", () => {
  const sidebarActiveItem = ref<SidebarItem>("collections");
  const sidebarCollapsed = ref(false);
  const isSettingsOpen = ref(false);

  function setSidebarItem(item: SidebarItem) {
    sidebarActiveItem.value = item;
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function openSettings() {
    isSettingsOpen.value = true;
  }

  function closeSettings() {
    isSettingsOpen.value = false;
  }

  return {
    sidebarActiveItem,
    sidebarCollapsed,
    isSettingsOpen,
    setSidebarItem,
    toggleSidebar,
    openSettings,
    closeSettings,
  };
});
