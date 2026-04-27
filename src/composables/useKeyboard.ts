import { onMounted, onUnmounted } from "vue";

import i18n from "../i18n";
import { useProjectsStore } from "../stores/projects";
import { useRequestStore } from "../stores/request";
import { useTabsStore } from "../stores/tabs";
import { useUIStore } from "../stores/ui";

const SIDEBAR_ITEMS = ["collections", "history", "environments"] as const;

export function useKeyboard() {
  const tabsStore = useTabsStore();
  const requestStore = useRequestStore();
  const projectsStore = useProjectsStore();
  const uiStore = useUIStore();

  async function handleKeydown(event: KeyboardEvent) {
    if (shouldIgnoreEvent(event)) {
      return;
    }

    if (!event.metaKey && !event.ctrlKey) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "enter") {
      event.preventDefault();
      if (!tabsStore.activeTab.url.trim()) {
        tabsStore.updateTab(tabsStore.activeTab.id, {
          responseError: i18n.global.t("request.urlRequired"),
        });
        return;
      }

      tabsStore.updateTab(tabsStore.activeTab.id, {
        isDirty: false,
      });
      await requestStore.sendRequest(tabsStore.activeTab);
      return;
    }

    if (key === "n" || key === "t") {
      event.preventDefault();
      tabsStore.addTab();
      return;
    }

    if (key === "w") {
      event.preventDefault();
      await tabsStore.removeTab(tabsStore.activeTab.id);
      return;
    }

    if (key === "s") {
      event.preventDefault();
      if (projectsStore.activeProject) {
        window.dispatchEvent(new CustomEvent("apisolo:save-request"));
      }
      return;
    }

    if (key === "k") {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("apisolo:focus-url"));
      return;
    }

    if (key === ",") {
      event.preventDefault();
      uiStore.openSettings();
      return;
    }

    if (key === "1" || key === "2" || key === "3") {
      event.preventDefault();
      const item = SIDEBAR_ITEMS[Number(key) - 1];
      if (item) {
        uiStore.setSidebarItem(item);
      }
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handleKeydown, true);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown, true);
  });
}

export function shouldIgnoreEvent(event: Pick<KeyboardEvent, "target">) {
  const target = event.target as ShortcutTarget | null;
  if (!target) {
    return false;
  }

  return isEditableTarget(target) || isCodeMirrorTarget(target);
}

type ShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

function isEditableTarget(target: ShortcutTarget) {
  const tagName = target.tagName?.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }

  if (target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

function isCodeMirrorTarget(target: ShortcutTarget) {
  return Boolean(target.closest?.(".cm-editor"));
}
