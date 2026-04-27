<script setup lang="ts">
import { computed, ref } from "vue"
import { storeToRefs } from "pinia"
import { AlertCircle, LoaderCircle } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import KeyValueEditor from "../request/KeyValueEditor.vue"
import { useTabsStore } from "../../stores/tabs"
import { useWebSocketStore } from "../../stores/websocket"
import type { KeyValuePair } from "../../types"

const tabsStore = useTabsStore()
const websocketStore = useWebSocketStore()
const { activeTab } = storeToRefs(tabsStore)
const { t } = useI18n()

const errorMessage = ref("")
const drafts = ref<Record<string, string>>({})

const messageDraft = computed({
  get: () => drafts.value[activeTab.value.id] ?? "",
  set: (value: string) => {
    drafts.value = {
      ...drafts.value,
      [activeTab.value.id]: value,
    }
  },
})

const canSend = computed(
  () => activeTab.value.wsStatus === "connected" && Boolean(activeTab.value.wsConnectionId),
)

function updateUrl(event: Event) {
  tabsStore.updateTab(activeTab.value.id, {
    url: (event.target as HTMLInputElement).value,
  })
}

function handleSchemaChange(event: Event) {
  const schema = (event.target as HTMLSelectElement).value
  const currentUrl = activeTab.value.url
  const stripped = currentUrl.replace(/^wss?:\/\//, "")
  tabsStore.updateTab(activeTab.value.id, {
    url: `${schema}://${stripped}`,
  })
}

function updateHeaders(headers: KeyValuePair[]) {
  tabsStore.updateTab(activeTab.value.id, { headers })
}

async function handleConnectionToggle() {
  errorMessage.value = ""

  if (activeTab.value.wsStatus === "connected" && activeTab.value.wsConnectionId) {
    try {
      await websocketStore.disconnect(activeTab.value.wsConnectionId)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
    return
  }

  if (!activeTab.value.url.trim()) {
    errorMessage.value = t("ws.enterWsUrl")
    return
  }

  try {
    await websocketStore.connect(activeTab.value.id, activeTab.value.url, activeTab.value.headers)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function sendMessage() {
  const content = messageDraft.value.trim()
  const connectionId = activeTab.value.wsConnectionId

  if (!content || !connectionId) {
    return
  }

  errorMessage.value = ""

  try {
    await websocketStore.send(connectionId, content)
    messageDraft.value = ""
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function handleMessageKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey) {
    return
  }

  event.preventDefault()
  void sendMessage()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[color-mix(in_srgb,var(--bg-primary)_88%,black)]">
    <div class="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
      <select
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 font-mono text-sm text-fuchsia-300 outline-none"
        :value="activeTab.url.startsWith('ws://') ? 'ws' : 'wss'"
        @change="handleSchemaChange($event)"
      >
        <option value="wss">wss://</option>
        <option value="ws">ws://</option>
      </select>
      <input
        class="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('ws.enterWsUrl')"
        :value="activeTab.url"
        @input="updateUrl"
      />
      <button
        class="inline-flex h-9 min-w-28 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-70"
        :class="
          activeTab.wsStatus === 'connected'
            ? 'bg-rose-500 hover:brightness-110'
            : 'bg-emerald-500 hover:brightness-110'
        "
        type="button"
        :disabled="activeTab.wsStatus === 'connecting'"
        @click="handleConnectionToggle"
      >
        <LoaderCircle v-if="activeTab.wsStatus === 'connecting'" :size="15" class="animate-spin" />
        <span v-if="activeTab.wsStatus === 'connecting'">{{ t("ws.connecting") }}</span>
        <span v-else-if="activeTab.wsStatus === 'connected'">{{ t("ws.disconnect") }}</span>
        <span v-else>{{ t("ws.connect") }}</span>
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="border-b border-[var(--border)] px-4 py-3">
        <div class="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {{ t("ws.headers") }}
        </div>
        <div class="h-[220px]">
          <KeyValueEditor :model-value="activeTab.headers" @update:model-value="updateHeaders" />
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {{ t("ws.send") }}
        </div>
        <div class="min-h-0 flex-1">
          <textarea
            v-model="messageDraft"
            class="h-full min-h-32 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :placeholder="t('ws.enterMessage')"
            @keydown="handleMessageKeydown"
          />
        </div>
        <div class="flex items-center justify-between gap-3">
          <div v-if="errorMessage" class="flex items-center gap-2 text-sm text-rose-300">
            <AlertCircle :size="15" />
            {{ errorMessage }}
          </div>
          <div v-else class="text-xs text-[var(--text-secondary)]">
            {{ activeTab.wsStatus === "connected" ? t("ws.connected") : t("ws.disconnected") }}
          </div>
          <button
            class="inline-flex h-9 items-center rounded-lg bg-[var(--accent)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            :disabled="!canSend || !messageDraft.trim()"
            @click="sendMessage"
          >
            {{ t("ws.send") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
