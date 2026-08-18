<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue"
import { Send, X } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { detectTemplateVariables, reconcileUrlBarValue } from "../../utils/url-params"
import type { HttpMethod } from "../../types"

const props = defineProps<{
  method: HttpMethod
  url: string
  tabId: string
  urlRevision: number
  isLoading?: boolean
}>()

const emit = defineEmits<{
  "update:method": [value: HttpMethod]
  "update:url": [value: string]
  send: []
  cancel: []
  importCurl: []
  copyCurl: []
  pasteCurl: [value: string]
}>()

const methods: HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
const urlInput = ref<HTMLInputElement | null>(null)
const { t } = useI18n()

const methodClasses = computed<Record<HttpMethod, string>>(() => ({
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-sky-400",
  DELETE: "text-rose-400",
  PATCH: "text-violet-400",
  HEAD: "text-slate-400",
  OPTIONS: "text-slate-400",
}))

/**
 * What the field shows. It is not `props.url` directly: the panel writes every
 * keystroke into the store and hands back the canonical rendering, and echoing
 * that straight back into the field is what used to swallow a freshly typed
 * `?`.
 */
const draft = ref(props.url)
const seen = ref({ tabId: props.tabId, revision: props.urlRevision })

// All three sources are load-bearing. Without `urlRevision` an outside write
// that renders to the identical string — a cURL import that only normalizes
// `%20` to `+` — never wakes this watcher, and the field keeps showing the old
// draft.
watch(
  () => [props.url, props.tabId, props.urlRevision] as const,
  ([url, tabId, revision]) => {
    draft.value = reconcileUrlBarValue(
      { tabId: seen.value.tabId, revision: seen.value.revision, draft: draft.value },
      { tabId, revision, url },
    )
    seen.value = { tabId, revision }
  },
)

const detectedVariables = computed(() => detectTemplateVariables(draft.value))

function onMethodChange(event: Event) {
  emit("update:method", (event.target as HTMLSelectElement).value as HttpMethod)
}

function onUrlInput(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
  emit("update:url", draft.value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") {
    return
  }

  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return
  }

  emit("send")
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text/plain")?.trim()
  if (text && /^curl\s/i.test(text)) {
    event.preventDefault()
    emit("pasteCurl", text)
  }
}

function focusUrlInput() {
  urlInput.value?.focus()
  urlInput.value?.select()
}

onMounted(() => {
  window.addEventListener("apisolo:focus-url", focusUrlInput as EventListener)
})

onUnmounted(() => {
  window.removeEventListener("apisolo:focus-url", focusUrlInput as EventListener)
})
</script>

<template>
  <div
    class="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_55%,transparent)] px-3 py-2.5"
  >
    <div class="flex flex-nowrap items-center gap-2 whitespace-nowrap">
      <select
        class="h-9 shrink-0 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm font-semibold outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        :class="methodClasses[props.method]"
        :value="props.method"
        @change="onMethodChange"
      >
        <option v-for="item in methods" :key="item" :value="item">
          {{ item }}
        </option>
      </select>

      <input
        ref="urlInput"
        class="h-9 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('request.enterUrl')"
        :value="draft"
        @input="onUrlInput"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <button
        class="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
        type="button"
        @click="props.isLoading ? emit('cancel') : emit('send')"
      >
        <X v-if="props.isLoading" :size="16" />
        <Send v-else :size="16" />
        <span>{{ props.isLoading ? t("request.cancel") : t("request.send") }}</span>
      </button>
    </div>

    <div
      v-if="detectedVariables.length > 0"
      data-testid="url-variables"
      class="mt-2 text-xs text-[var(--text-secondary)]"
    >
      {{ t("request.containsVariables") }}
      <span class="font-mono text-[var(--accent)]">{{ detectedVariables.join(", ") }}</span>
    </div>
  </div>
</template>
