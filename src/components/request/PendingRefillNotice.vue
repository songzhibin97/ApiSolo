<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"

import { useSaveGateStore } from "../../stores/save-gate"
import {
  formatPendingField,
  refillFields,
  reselectFileFields,
  type PendingField,
} from "../../utils/pending-refill"

const props = defineProps<{
  fields: PendingField[]
}>()

const { t } = useI18n()
const saveGate = useSaveGateStore()

const refill = computed(() => refillFields(props.fields))
const reselect = computed(() => reselectFileFields(props.fields))
const acknowledged = computed(() => saveGate.isAcknowledged(props.fields))

function toggle(value: boolean) {
  if (value) {
    saveGate.acknowledge(props.fields)
  } else {
    saveGate.withdraw()
  }
}
</script>

<template>
  <div v-if="props.fields.length > 0" class="space-y-3">
    <!--
      Each class is listed in full and the region scrolls rather than truncating.
      A list cut off at the first few rows passes "the fields were listed" while
      leaving the user with no idea how many there are.
    -->
    <div
      v-if="refill.length > 0"
      class="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200"
    >
      <div class="font-semibold">{{ t("history.refillTitle", { count: refill.length }) }}</div>
      <ul class="mt-2 max-h-32 space-y-1 overflow-auto">
        <!--
          Keyed by position, not by text: the same key redacted twice is two
          entries the user has to refill, and collapsing them would promise
          fewer fields than there are.
        -->
        <li v-for="(field, index) in refill" :key="`refill-${index}`" class="font-mono">
          {{ formatPendingField(field) }}
        </li>
      </ul>
    </div>

    <div
      v-if="reselect.length > 0"
      class="rounded border border-sky-500/40 bg-sky-500/10 p-3 text-xs leading-5 text-sky-200"
    >
      <div class="font-semibold">
        {{ t("history.reselectFileTitle", { count: reselect.length }) }}
      </div>
      <ul class="mt-2 max-h-32 space-y-1 overflow-auto">
        <li v-for="(field, index) in reselect" :key="`reselect-${index}`" class="font-mono">
          {{ formatPendingField(field) }}
        </li>
      </ul>
    </div>

    <label class="flex items-start gap-2 text-xs leading-5 text-[var(--text-primary)]">
      <input
        type="checkbox"
        data-testid="refill-acknowledge"
        class="mt-0.5 shrink-0"
        :checked="acknowledged"
        @change="toggle(($event.target as HTMLInputElement).checked)"
      />
      <span>{{ t("history.refillAck") }}</span>
    </label>
  </div>
</template>
