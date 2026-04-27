<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"

import type { RequestTimings } from "../../types"

const props = defineProps<{
  timings: RequestTimings
}>()

const { t } = useI18n()

const total = computed(() => Math.max(props.timings.total, 0))
const phases = computed(() => {
  const dnsLookup = Math.max(props.timings.dnsLookup, 0)
  const tcpConnect = Math.max(props.timings.tcpConnect, 0)
  const download = Math.max(props.timings.download, 0)

  return { dnsLookup, tcpConnect, download }
})

const rows = computed(() => {
  const safeTotal = Math.max(total.value, 1)
  const segments = [
    {
      key: "dnsLookup",
      label: t("response.dnsLookup"),
      value: phases.value.dnsLookup,
      barClass: "bg-amber-400",
    },
    {
      key: "tcpConnect",
      label: t("response.tcpConnect"),
      value: phases.value.tcpConnect,
      barClass: "bg-cyan-400",
    },
    {
      key: "download",
      label: t("response.download"),
      value: phases.value.download,
      barClass: "bg-sky-400",
    },
  ]

  let offset = 0

  return segments.map((segment) => {
    const width = Math.min((segment.value / safeTotal) * 100, 100)
    const row = { ...segment, width, offset }
    offset += width
    return row
  })
})

function formatDuration(value: number) {
  return `${value}ms`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <div class="rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_88%,black)] p-5">
      <div class="flex items-end justify-between gap-4 border-b border-[var(--border)] pb-4">
        <div>
          <div class="flex items-center gap-2">
            <div class="text-xs uppercase tracking-[0.24em] text-[var(--text-secondary)]">{{ t("response.timings") }}</div>
            <div class="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              {{ t("response.partialTimings") }}
            </div>
          </div>
          <div class="mt-2 text-3xl font-semibold text-[var(--text-primary)]">{{ formatDuration(total) }}</div>
        </div>
        <div class="text-sm text-[var(--text-secondary)]">{{ t("response.totalTime") }}</div>
      </div>

      <div class="mt-5 space-y-4">
        <div class="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_70%,black)] px-3 py-2 text-sm text-[var(--text-secondary)]">
          {{ t("response.trustworthyTimingsNotice") }}
        </div>

        <div v-for="row in rows" :key="row.key" class="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-4">
          <div class="text-sm font-medium text-[var(--text-primary)]">{{ row.label }}</div>
          <div class="h-3 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--bg-surface)_60%,transparent)]">
            <div class="relative h-full w-full">
              <div
                class="absolute top-0 h-full rounded-full"
                :class="row.barClass"
                :style="{ left: `${row.offset}%`, width: `${row.width}%`, opacity: 0.9 }"
              />
            </div>
          </div>
          <div class="min-w-16 text-right font-mono text-sm text-[var(--text-secondary)]">{{ formatDuration(row.value) }}</div>
        </div>

        <div class="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-4">
          <div class="text-sm font-medium text-[var(--text-primary)]">{{ t("response.totalTime") }}</div>
          <div class="h-3 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--bg-surface)_60%,transparent)]">
            <div
              class="h-full w-full rounded-full"
              style="background: linear-gradient(90deg, rgb(251 191 36) 0%, rgb(34 211 238) 24%, rgb(167 139 250) 48%, var(--accent) 72%, rgb(56 189 248) 100%); opacity: 0.95"
            />
          </div>
          <div class="min-w-16 text-right font-mono text-sm text-[var(--text-secondary)]">
            {{ formatDuration(total) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
