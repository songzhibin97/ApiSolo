<script setup lang="ts">
import { useI18n } from "vue-i18n"

const { t } = useI18n()
</script>

<template>
  <div class="min-h-screen bg-zinc-900 text-zinc-100 flex items-center justify-center">
    <h1 class="text-2xl font-bold">{{ t("app.name") }}</h1>
  </div>
</template>
