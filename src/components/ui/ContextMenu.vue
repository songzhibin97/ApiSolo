<script setup lang="ts">
import type { Component } from "vue"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

export interface ContextMenuItem {
  label: string
  action: string
  icon?: Component
  danger?: boolean
}

const props = defineProps<{
  items: ContextMenuItem[]
  position: {
    x: number
    y: number
  }
  visible: boolean
}>()

const emit = defineEmits<{
  select: [action: string]
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
const resolvedPosition = ref({ x: 0, y: 0 })

const menuStyle = computed(() => ({
  left: `${resolvedPosition.value.x}px`,
  top: `${resolvedPosition.value.y}px`,
}))

watch(
  () => [props.visible, props.position.x, props.position.y, props.items.length] as const,
  async ([visible]) => {
    if (!visible) {
      return
    }

    await nextTick()
    updatePosition()
  },
)

onMounted(() => {
  document.addEventListener("mousedown", onDocumentPointerDown)
  window.addEventListener("resize", updatePosition)
  window.addEventListener("keydown", onWindowKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentPointerDown)
  window.removeEventListener("resize", updatePosition)
  window.removeEventListener("keydown", onWindowKeydown)
})

function updatePosition() {
  if (!props.visible || !menuRef.value) {
    return
  }

  const padding = 8
  const { innerWidth, innerHeight } = window
  const { offsetWidth, offsetHeight } = menuRef.value

  let x = props.position.x
  let y = props.position.y

  if (x + offsetWidth + padding > innerWidth) {
    x = Math.max(padding, props.position.x - offsetWidth)
  }

  if (y + offsetHeight + padding > innerHeight) {
    y = Math.max(padding, props.position.y - offsetHeight)
  }

  resolvedPosition.value = {
    x: Math.max(padding, x),
    y: Math.max(padding, y),
  }
}

function onDocumentPointerDown(event: MouseEvent) {
  if (!props.visible) {
    return
  }

  if (menuRef.value?.contains(event.target as Node)) {
    return
  }

  emit("close")
}

function onWindowKeydown(event: KeyboardEvent) {
  if (props.visible && event.key === "Escape") {
    emit("close")
  }
}

function handleSelect(action: string) {
  emit("select", action)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="fixed z-[1000] min-w-44 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] py-1 shadow-lg"
      :style="menuStyle"
      role="menu"
    >
      <button
        v-for="item in items"
        :key="item.action"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] transition hover:bg-[var(--bg-secondary)]"
        :class="item.danger ? 'text-rose-400 hover:text-rose-300' : ''"
        type="button"
        role="menuitem"
        @click="handleSelect(item.action)"
      >
        <component :is="item.icon" v-if="item.icon" :size="14" class="shrink-0" />
        <span class="truncate">{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>
