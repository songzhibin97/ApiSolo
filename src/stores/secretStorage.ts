import { computed, ref } from "vue"
import { defineStore } from "pinia"

import { invoke } from "../utils/invoke"
import type { SecretStorageBackend, SecretStorageState } from "../types"

const DEFAULT_STATE: SecretStorageState = {
  configured: false,
  backend: null,
  locked: true,
  vaultPath: "",
}

export const useSecretStorageStore = defineStore("secretStorage", () => {
  const state = ref<SecretStorageState>({ ...DEFAULT_STATE })
  const initialized = ref(false)
  const errorMessage = ref("")

  const isReady = computed(() => initialized.value && state.value.configured && !state.value.locked)
  const needsSetup = computed(() => initialized.value && !state.value.configured)
  const needsUnlock = computed(
    () => initialized.value && state.value.configured && state.value.backend === "local-encrypted" && state.value.locked,
  )

  async function loadState() {
    errorMessage.value = ""
    try {
      state.value = normalizeState(await invoke<SecretStorageState>("get_secret_storage_state"))
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
      initialized.value = true
    }
  }

  async function configure(backend: SecretStorageBackend, masterPassword?: string) {
    errorMessage.value = ""
    state.value = normalizeState(
      await invoke<SecretStorageState>("configure_secret_storage", {
        backend,
        masterPassword,
      }),
    )
    initialized.value = true
  }

  async function unlock(masterPassword: string) {
    errorMessage.value = ""
    state.value = normalizeState(
      await invoke<SecretStorageState>("unlock_secret_storage", {
        masterPassword,
      }),
    )
    initialized.value = true
  }

  return {
    state,
    initialized,
    errorMessage,
    isReady,
    needsSetup,
    needsUnlock,
    loadState,
    configure,
    unlock,
  }
})

function normalizeState(value: SecretStorageState): SecretStorageState {
  return {
    configured: Boolean(value.configured),
    backend: value.backend === "system-keychain" ? "system-keychain" : value.backend === "local-encrypted" ? "local-encrypted" : null,
    locked: Boolean(value.locked),
    vaultPath: typeof value.vaultPath === "string" ? value.vaultPath : "",
  }
}
