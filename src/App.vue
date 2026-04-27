<script setup lang="ts">
import { storeToRefs } from "pinia"

import DefaultLayout from "./components/layout/DefaultLayout.vue"
import SecretStorageGate from "./components/settings/SecretStorageGate.vue"
import { useSecretStorageStore } from "./stores/secretStorage"

const secretStorageStore = useSecretStorageStore()
const { isReady } = storeToRefs(secretStorageStore)
</script>

<template>
  <DefaultLayout v-if="isReady" />
  <SecretStorageGate v-else />
</template>
