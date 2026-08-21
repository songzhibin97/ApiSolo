<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"

import InlineError from "../ui/InlineError.vue"
import PendingRefillNotice from "../request/PendingRefillNotice.vue"
import { useProjectsStore } from "../../stores/projects"
import { useSaveGateStore } from "../../stores/save-gate"
import { flattenCollectionFolders } from "../../utils/collection-options"
import { buildSavedRequestFromHistory, defaultRequestName, historyEntryToRequest } from "../../utils/history-to-request"
import { pendingRefillFields } from "../../utils/pending-refill"
import type { HistoryEntry } from "../../types"

const props = defineProps<{
  visible: boolean
  entry: HistoryEntry | null
}>()

const emit = defineEmits<{
  close: []
}>()

const projectsStore = useProjectsStore()
const saveGate = useSaveGateStore()
const { collectionTree } = storeToRefs(projectsStore)
const { t } = useI18n()

const name = ref("")
const collection = ref("")
const errorMessage = ref("")
const isSaving = ref(false)

const collectionOptions = computed(() => [
  { label: t("common.rootCollection"), value: "" },
  ...flattenCollectionFolders(collectionTree.value),
])

/**
 * The list comes off the request, which is why the existing save button and this
 * dialog agree without either of them knowing about the other.
 */
const pendingFields = computed(() =>
  props.entry ? pendingRefillFields(historyEntryToRequest(props.entry)) : [],
)

const submitDisabled = computed(
  () => !name.value.trim() || isSaving.value || saveGate.blocksSave(pendingFields.value),
)

watch(
  () => [props.visible, props.entry] as const,
  ([visible, entry]) => {
    if (!visible || !entry) {
      return
    }

    name.value = defaultRequestName(entry)
    collection.value = ""
    errorMessage.value = ""
  },
  { immediate: true },
)

async function submit() {
  if (!props.entry || submitDisabled.value) {
    return
  }

  errorMessage.value = ""
  isSaving.value = true

  try {
    // No tab argument: saving from history must not relabel or repoint whatever
    // the user currently has open. Reloading the tree is what puts the request
    // in the collection panel.
    await projectsStore.saveRequest(
      collection.value,
      buildSavedRequestFromHistory(props.entry, name.value.trim()),
    )
    emit("close")
  } catch (error) {
    // Stays open, showing the reason as given. A dialog that closes on failure
    // reads exactly like one that succeeded.
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div
    v-if="props.visible && props.entry"
    class="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4"
  >
    <div
      class="flex max-h-full w-full max-w-md flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg"
    >
      <div class="text-lg font-semibold text-[var(--text-primary)]">
        {{ t("history.saveToCollection") }}
      </div>

      <div class="mt-3 min-h-0 flex-1 space-y-3 overflow-auto">
        <select
          v-model="collection"
          data-testid="save-from-history-collection"
          class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        >
          <option v-for="option in collectionOptions" :key="option.value || 'root'" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <input
          v-model="name"
          data-testid="save-from-history-name"
          class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          type="text"
          :placeholder="t('request.requestNameExample')"
        />

        <PendingRefillNotice :fields="pendingFields" />

        <InlineError :message="errorMessage" />
      </div>

      <div class="mt-5 flex shrink-0 justify-end gap-2">
        <button
          class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
          type="button"
          :disabled="isSaving"
          @click="emit('close')"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="save-from-history-submit"
          type="button"
          :disabled="submitDisabled"
          @click="submit"
        >
          {{ t("common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>
