<script setup lang="ts">
/**
 * Renders a failure verbatim. The text comes from the backend, not from the
 * message catalogue, so it is a value this component is handed rather than
 * something it looks up -- which also makes "the dialog showed the real reason"
 * checkable as a prop instead of as rendered text.
 */
const props = defineProps<{
  message: string
}>()
</script>

<template>
  <div v-if="props.message" class="text-sm break-words text-rose-300">
    {{ props.message }}
  </div>
</template>
