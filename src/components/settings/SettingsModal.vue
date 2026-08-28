<script setup lang="ts">
import { computed } from "vue"
import { storeToRefs } from "pinia"
import { X } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { useSettingsStore } from "../../stores/settings"
import { useUIStore } from "../../stores/ui"
import type { Locale, ProxyConfig, ThemeMode } from "../../types"

const uiStore = useUIStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()

const { isSettingsOpen } = storeToRefs(uiStore)
const { fontSize, locale, proxy, theme, tls } = storeToRefs(settingsStore)

const appVersion = __APP_VERSION__

const themeOptions = computed<Array<{ label: string; value: ThemeMode; description: string }>>(() => [
  { label: t("settings.light"), value: "light", description: t("settings.lightDescription") },
  { label: t("settings.dark"), value: "dark", description: t("settings.darkDescription") },
  { label: t("settings.system"), value: "system", description: t("settings.systemDescription") },
])

const localeOptions = computed<Array<{ label: string; value: Locale }>>(() => [
  { label: t("settings.zhCN"), value: "zh-CN" },
  { label: t("settings.en"), value: "en" },
])

const proxyConfig = computed({
  get: () => proxy.value,
  set: (value: ProxyConfig) => settingsStore.setProxy(value),
})

const proxyTypeOptions = computed<Array<{ label: string; value: ProxyConfig["type"] }>>(() => [
  { label: "HTTP", value: "http" },
  { label: "SOCKS5", value: "socks5" },
])

const verifySsl = computed({
  get: () => tls.value.verifySsl,
  set: (value: boolean) => settingsStore.setTls({ verifySsl: value }),
})

function closeModal() {
  uiStore.closeSettings()
}

function onBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    closeModal()
  }
}

function updateProxy(patch: Partial<ProxyConfig>) {
  proxyConfig.value = {
    ...proxyConfig.value,
    ...patch,
    auth: {
      username: patch.auth?.username ?? proxyConfig.value.auth?.username ?? "",
      password: patch.auth?.password ?? proxyConfig.value.auth?.password ?? "",
    },
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isSettingsOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      @click="onBackdropClick"
    >
      <div class="w-full max-w-2xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg">
        <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-4">
          <div>
            <div class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
              {{ t("settings.title") }}
            </div>
            <h2 class="mt-1 text-xl font-semibold text-[var(--text-primary)]">{{ t("settings.workspacePreferences") }}</h2>
          </div>
          <button
            class="flex h-9 w-9 items-center justify-center rounded border border-[var(--border)] text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_45%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :aria-label="t('layout.closeSettings')"
            @click="closeModal"
          >
            <X :size="18" />
          </button>
        </div>

        <div class="grid gap-0 md:grid-cols-[220px_1fr]">
          <aside class="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_68%,transparent)] p-4 md:border-b-0 md:border-r">
            <div class="space-y-3">
              <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.general") }}</div>
                <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.generalDescription") }}</div>
              </div>
              <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.editor") }}</div>
                <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.editorDescription") }}</div>
              </div>
              <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.network") }}</div>
                <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.networkDescription") }}</div>
              </div>
              <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3">
                <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.about") }}</div>
                <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.aboutDescription") }}</div>
              </div>
            </div>
          </aside>

          <div class="max-h-[80vh] overflow-auto p-4">
            <section class="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] p-4">
              <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.general") }}</div>
              <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.workspaceDescription") }}</div>
              <div class="mt-5 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.language") }}</div>
                <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.languageDescription") }}</div>
                <div class="mt-4 grid gap-2 md:grid-cols-2">
                  <button
                    v-for="option in localeOptions"
                    :key="option.value"
                    class="rounded-lg border px-4 py-3 text-left text-sm font-semibold transition"
                    :class="
                      locale === option.value
                        ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    "
                    type="button"
                    @click="settingsStore.setLocale(option.value)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>
              <div class="mt-5 grid gap-3 md:grid-cols-3">
                <button
                  v-for="option in themeOptions"
                  :key="option.value"
                  class="rounded-lg border p-4 text-left transition"
                  :class="
                    theme === option.value
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                      : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]'
                  "
                  type="button"
                  @click="settingsStore.setTheme(option.value)"
                >
                  <div class="text-sm font-semibold text-[var(--text-primary)]">{{ option.label }}</div>
                  <div class="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{{ option.description }}</div>
                </button>
              </div>
            </section>

            <section class="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] p-4">
              <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.editor") }}</div>
              <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.editorPanelDescription") }}</div>
              <div class="mt-5 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div class="flex items-center justify-between gap-4">
                  <label class="text-sm font-semibold text-[var(--text-primary)]" for="font-size-range">{{ t("settings.fontSize") }}</label>
                  <span class="rounded bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-3 py-1 text-sm font-semibold text-[var(--text-primary)]">
                    {{ fontSize }}px
                  </span>
                </div>
                <input
                  id="font-size-range"
                  class="mt-4 w-full accent-[var(--accent)]"
                  type="range"
                  min="12"
                  max="20"
                  step="1"
                  :value="fontSize"
                  @input="settingsStore.setFontSize(Number(($event.target as HTMLInputElement).value))"
                />
              </div>
            </section>

            <section class="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] p-4">
              <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.network") }}</div>
              <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.networkDescription") }}</div>

              <div class="mt-5 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.proxy") }}</div>

                <label class="mt-4 flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
                  <div class="text-sm font-medium text-[var(--text-primary)]">{{ t("settings.enableProxy") }}</div>
                  <button
                    class="relative inline-flex h-7 w-12 shrink-0 rounded transition"
                    :class="proxyConfig.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-surface)]'"
                    type="button"
                    :aria-label="t('settings.enableProxy')"
                    @click="updateProxy({ enabled: !proxyConfig.enabled })"
                  >
                    <span
                      class="absolute top-1 h-5 w-5 rounded bg-white shadow transition"
                      :class="proxyConfig.enabled ? 'left-6' : 'left-1'"
                    />
                  </button>
                </label>

                <div class="mt-4 grid gap-4 md:grid-cols-2">
                  <label class="block">
                    <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">{{ t("settings.proxyType") }}</div>
                    <select
                      class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--accent)]"
                      :value="proxyConfig.type"
                      :title="t('settings.proxyTypeTitle')"
                      @change="updateProxy({ type: ($event.target as HTMLSelectElement).value as ProxyConfig['type'] })"
                    >
                      <option v-for="option in proxyTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                  </label>

                  <label class="block">
                    <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">{{ t("settings.proxyHost") }}</div>
                    <input
                      class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)]"
                      type="text"
                      :value="proxyConfig.host"
                      @input="updateProxy({ host: ($event.target as HTMLInputElement).value })"
                    />
                  </label>
                </div>

                <div class="mt-4 grid gap-4 md:grid-cols-3">
                  <label class="block">
                    <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">{{ t("settings.proxyPort") }}</div>
                    <input
                      class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)]"
                      type="number"
                      min="0"
                      max="65535"
                      :value="proxyConfig.port"
                      @input="updateProxy({ port: Number(($event.target as HTMLInputElement).value) || 0 })"
                    />
                  </label>

                  <label class="block md:col-span-2">
                    <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">
                      {{ t("settings.proxyUsername") }} {{ t("settings.optional") }}
                    </div>
                    <input
                      class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)]"
                      type="text"
                      :value="proxyConfig.auth?.username ?? ''"
                      @input="updateProxy({ auth: { username: ($event.target as HTMLInputElement).value, password: proxyConfig.auth?.password ?? '' } })"
                    />
                  </label>
                </div>

                <label class="mt-4 block">
                  <div class="mb-2 text-sm font-medium text-[var(--text-primary)]">
                    {{ t("settings.proxyPassword") }} {{ t("settings.optional") }}
                  </div>
                  <input
                    class="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[var(--accent)]"
                    type="password"
                    :value="proxyConfig.auth?.password ?? ''"
                    @input="updateProxy({ auth: { username: proxyConfig.auth?.username ?? '', password: ($event.target as HTMLInputElement).value } })"
                  />
                </label>
              </div>

              <div class="mt-5 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.tls") }}</div>

                <label class="mt-4 flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
                  <div>
                    <div class="text-sm font-medium text-[var(--text-primary)]">{{ t("settings.verifySsl") }}</div>
                    <div class="mt-1 text-sm text-[var(--text-secondary)]">{{ t("settings.verifySslWarning") }}</div>
                  </div>
                  <button
                    class="relative inline-flex h-7 w-12 shrink-0 rounded transition"
                    :class="verifySsl ? 'bg-[var(--accent)]' : 'bg-[var(--bg-surface)]'"
                    type="button"
                    :aria-label="t('settings.verifySsl')"
                    @click="verifySsl = !verifySsl"
                  >
                    <span
                      class="absolute top-1 h-5 w-5 rounded bg-white shadow transition"
                      :class="verifySsl ? 'left-6' : 'left-1'"
                    />
                  </button>
                </label>
              </div>
            </section>

            <section class="mt-5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] p-4">
              <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("settings.about") }}</div>
              <div class="mt-4 grid gap-3 md:grid-cols-3">
                <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.version") }}</div>
                  <div class="mt-2 text-lg font-semibold text-[var(--text-primary)]" data-testid="app-version">v{{ appVersion }}</div>
                </div>
                <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.stack") }}</div>
                  <div class="mt-2 text-sm leading-6 text-[var(--text-primary)]">Vue 3, Pinia, Tailwind CSS, Tauri 2</div>
                </div>
                <div class="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{{ t("settings.project") }}</div>
                  <div class="mt-2 text-sm leading-6 text-[var(--text-primary)]">{{ t("app.requestBuilderWorkspace") }}</div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
