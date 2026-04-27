<script setup lang="ts">
import { useI18n } from "vue-i18n"

import CodeEditor from "../editor/CodeEditor.vue"

defineProps<{
  preRequestScript: string
  testScript: string
}>()

defineEmits<{
  "update:preRequestScript": [value: string]
  "update:testScript": [value: string]
}>()

const { t } = useI18n()

const preRequestPlaceholder = `// ${t("request.preRequestHint")}
pm.environment.set("token", "your-token")`

const testPlaceholder = `// ${t("request.testHint")}
pm.test("Status is 200", () => {
  pm.expect(pm.response.status).to.equal(200)
})`
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <section class="flex min-h-0 basis-2/5 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-sm font-semibold text-[var(--text-primary)]">
          {{ t("request.preRequestScript") }}
        </div>
        <div class="text-xs text-[var(--text-secondary)]">
          {{ t("request.preRequestHint") }}
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <CodeEditor
          :model-value="preRequestScript"
          language="javascript"
          :placeholder="preRequestPlaceholder"
          show-gutter
          @update:model-value="$emit('update:preRequestScript', $event)"
        />
      </div>
    </section>

    <section class="flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="text-sm font-semibold text-[var(--text-primary)]">
          {{ t("request.testScript") }}
        </div>
        <div class="text-xs text-[var(--text-secondary)]">
          {{ t("request.testHint") }}
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <CodeEditor
          :model-value="testScript"
          language="javascript"
          :placeholder="testPlaceholder"
          show-gutter
          @update:model-value="$emit('update:testScript', $event)"
        />
      </div>
    </section>
  </div>
</template>
