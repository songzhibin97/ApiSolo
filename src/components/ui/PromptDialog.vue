<script setup lang="ts">
import { ref, watch } from "vue"

const props = defineProps<{
  visible: boolean
  title: string
  placeholder: string
  confirmLabel: string
  cancelLabel: string
  initialValue?: string
  errorMessage?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  confirm: [value: string]
  cancel: []
}>()

const value = ref("")

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      value.value = props.initialValue ?? ""
    }
  },
  { immediate: true },
)

function submit() {
  const trimmed = value.value.trim()
  if (!trimmed) {
    return
  }

  emit("confirm", trimmed)
}
</script>

<template>
  <div
    v-if="props.visible"
    class="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4"
  >
    <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
      <div class="text-lg font-semibold text-[var(--text-primary)]">
        {{ props.title }}
      </div>
      <input
        v-model="value"
        class="mt-4 h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="props.placeholder"
        :disabled="props.busy"
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="emit('cancel')"
      />
      <div v-if="props.errorMessage" class="mt-3 text-sm text-rose-300">
        {{ props.errorMessage }}
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button
          class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
          type="button"
          :disabled="props.busy"
          @click="emit('cancel')"
        >
          {{ props.cancelLabel }}
        </button>
        <button
          class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="!value.trim() || props.busy"
          @click="submit"
        >
          {{ props.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
