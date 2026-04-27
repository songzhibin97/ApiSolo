<script setup lang="ts">
const props = defineProps<{
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  errorMessage?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
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
      <div class="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
        {{ props.message }}
      </div>
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
          class="h-8 rounded px-3 text-sm font-semibold text-white transition hover:brightness-110"
          :class="props.danger ? 'bg-rose-500' : 'bg-[var(--accent)]'"
          type="button"
          :disabled="props.busy"
          @click="emit('confirm')"
        >
          {{ props.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
