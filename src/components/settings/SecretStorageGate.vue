<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { useSecretStorageStore } from "../../stores/secretStorage"
import type { SecretStorageBackend } from "../../types"

const secretStorageStore = useSecretStorageStore()
const { t } = useI18n()
const { errorMessage, initialized, needsSetup, needsUnlock, state } = storeToRefs(secretStorageStore)

const selectedBackend = ref<SecretStorageBackend>("local-encrypted")
const setupPassword = ref("")
const setupPasswordConfirm = ref("")
const unlockPassword = ref("")
const isSubmitting = ref(false)
const localError = ref("")

const setupBackendOptions = computed<Array<{ value: SecretStorageBackend; label: string; description: string }>>(() => [
  {
    value: "local-encrypted",
    label: t("secretStorage.localEncrypted"),
    description: t("secretStorage.localEncryptedDescription"),
  },
  {
    value: "system-keychain",
    label: t("secretStorage.systemKeychain"),
    description: t("secretStorage.systemKeychainDescription"),
  },
])

onMounted(() => {
  void secretStorageStore.loadState()
})

async function submitSetup() {
  localError.value = ""

  if (selectedBackend.value === "local-encrypted") {
    if (setupPassword.value.length < 8) {
      localError.value = t("secretStorage.passwordMinLength")
      return
    }

    if (setupPassword.value !== setupPasswordConfirm.value) {
      localError.value = t("secretStorage.passwordMismatch")
      return
    }
  }

  isSubmitting.value = true
  try {
    await secretStorageStore.configure(selectedBackend.value, setupPassword.value)
    setupPassword.value = ""
    setupPasswordConfirm.value = ""
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSubmitting.value = false
  }
}

async function submitUnlock() {
  localError.value = ""

  if (!unlockPassword.value) {
    localError.value = t("secretStorage.passwordRequired")
    return
  }

  isSubmitting.value = true
  try {
    await secretStorageStore.unlock(unlockPassword.value)
    unlockPassword.value = ""
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="flex h-screen items-center justify-center bg-[var(--bg-primary)] px-4 text-[var(--text-primary)]">
    <section class="w-full max-w-xl overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
      <div class="border-b border-[var(--border)] px-5 py-4">
        <div class="flex items-center gap-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]">
            <LockKeyhole :size="20" />
          </div>
          <div>
            <div class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-secondary)]">
              {{ t("secretStorage.eyebrow") }}
            </div>
            <h1 class="mt-1 text-lg font-semibold">{{ t("secretStorage.title") }}</h1>
          </div>
        </div>
      </div>

      <div class="px-5 py-5">
        <div v-if="!initialized" class="text-sm text-[var(--text-secondary)]">
          {{ t("common.loading") }}
        </div>

        <form v-else-if="needsSetup" class="space-y-5" @submit.prevent="submitSetup">
          <p class="text-sm leading-6 text-[var(--text-secondary)]">
            {{ t("secretStorage.setupDescription") }}
          </p>

          <div class="grid gap-3">
            <button
              v-for="option in setupBackendOptions"
              :key="option.value"
              class="flex items-start gap-3 rounded-lg border p-4 text-left transition"
              :class="
                selectedBackend === option.value
                  ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
                  : 'border-[var(--border)] bg-[var(--bg-primary)] hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]'
              "
              type="button"
              @click="selectedBackend = option.value"
            >
              <ShieldCheck v-if="option.value === 'local-encrypted'" class="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
              <KeyRound v-else class="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-[var(--text-primary)]">{{ option.label }}</span>
                <span class="mt-1 block text-sm leading-6 text-[var(--text-secondary)]">{{ option.description }}</span>
              </span>
            </button>
          </div>

          <div v-if="selectedBackend === 'local-encrypted'" class="grid gap-3">
            <label class="block">
              <span class="mb-2 block text-sm font-medium">{{ t("secretStorage.masterPassword") }}</span>
              <input
                v-model="setupPassword"
                class="h-10 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm outline-none transition focus:border-[var(--accent)]"
                type="password"
                autocomplete="new-password"
              />
            </label>
            <label class="block">
              <span class="mb-2 block text-sm font-medium">{{ t("secretStorage.confirmPassword") }}</span>
              <input
                v-model="setupPasswordConfirm"
                class="h-10 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm outline-none transition focus:border-[var(--accent)]"
                type="password"
                autocomplete="new-password"
              />
            </label>
          </div>

          <div v-if="localError || errorMessage" class="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {{ localError || errorMessage }}
          </div>

          <button
            class="flex h-10 w-full items-center justify-center rounded bg-[var(--accent)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            :disabled="isSubmitting"
          >
            {{ isSubmitting ? t("common.loading") : t("secretStorage.continue") }}
          </button>
        </form>

        <form v-else-if="needsUnlock" class="space-y-5" @submit.prevent="submitUnlock">
          <p class="text-sm leading-6 text-[var(--text-secondary)]">
            {{ t("secretStorage.unlockDescription") }}
          </p>

          <label class="block">
            <span class="mb-2 block text-sm font-medium">{{ t("secretStorage.masterPassword") }}</span>
            <input
              v-model="unlockPassword"
              class="h-10 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm outline-none transition focus:border-[var(--accent)]"
              type="password"
              autocomplete="current-password"
              autofocus
            />
          </label>

          <div class="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
            {{ t("secretStorage.vaultPath", { path: state.vaultPath }) }}
          </div>

          <div v-if="localError || errorMessage" class="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {{ localError || errorMessage }}
          </div>

          <button
            class="flex h-10 w-full items-center justify-center rounded bg-[var(--accent)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            :disabled="isSubmitting"
          >
            {{ isSubmitting ? t("common.loading") : t("secretStorage.unlock") }}
          </button>
        </form>
      </div>
    </section>
  </div>
</template>
