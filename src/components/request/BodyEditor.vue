<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"

import CodeEditor from "../editor/CodeEditor.vue"
import KeyValueEditor from "./KeyValueEditor.vue"
import { readFileAsBase64 } from "../../utils/file-reader"
import { MAX_UPLOAD_FILE_BYTES, formatBytesAsMib } from "../../utils/limits"
import type { BodyType, FormDataItem, KeyValuePair, RequestBody } from "../../types"

const props = defineProps<{
  modelValue: RequestBody
}>()

const emit = defineEmits<{
  "update:modelValue": [value: RequestBody]
}>()
const { t } = useI18n()

const bodyTypes = computed<{ label: string; value: BodyType; title: string }[]>(() => [
  { label: t("body.none"), value: "none", title: t("body.tooltips.none") },
  { label: t("body.json"), value: "json", title: t("body.tooltips.json") },
  {
    label: t("body.formUrlEncoded"),
    value: "form-urlencoded",
    title: t("body.tooltips.formUrlEncoded"),
  },
  { label: t("body.formData"), value: "form-data", title: t("body.tooltips.formData") },
  { label: t("body.raw"), value: "raw", title: t("body.tooltips.raw") },
  { label: t("body.binary"), value: "binary", title: t("body.tooltips.binary") },
])

const defaultJsonBody = `{
  "key": "value"
}`

const jsonPlaceholder = defaultJsonBody

const formUrlencodedRows = ref<KeyValuePair[]>([])

watch(
  () => props.modelValue,
  (value) => {
    if (value.type === "form-urlencoded") {
      formUrlencodedRows.value = deserializeFormUrlencoded(value.content)
    }
  },
  { deep: true, immediate: true },
)

const selectedType = computed(() => props.modelValue.type)

watch(
  () => selectedType.value,
  (type) => {
    if (type !== "json") {
      return
    }

    const normalized = normalizeJsonBodyContent(props.modelValue.content)
    if (normalized !== props.modelValue.content) {
      updateBody({ content: normalized })
    }
  },
  { immediate: true },
)

const formDataRows = computed(() => {
  const rows = props.modelValue.formData.length > 0 ? props.modelValue.formData : []
  const lastRow = rows[rows.length - 1]

  if (!lastRow || hasFormDataValue(lastRow)) {
    return [...rows, createEmptyFormDataItem()]
  }

  return rows
})

function createEmptyPair(): KeyValuePair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    key: "",
    value: "",
    description: "",
  }
}

function createEmptyFormDataItem(): FormDataItem {
  return {
    ...createEmptyPair(),
    valueType: "text",
    fileName: "",
    filePath: "",
    fileContent: "",
    contentType: "",
  }
}

function hasFormDataValue(item: FormDataItem) {
  return Boolean(
    item.key ||
      item.value ||
      item.description ||
      item.fileName ||
      item.filePath ||
      item.fileContent ||
      item.contentType,
  )
}

function deserializeFormUrlencoded(content: string): KeyValuePair[] {
  if (!content.trim()) {
    return []
  }

  return content.split("&").map((segment) => {
    const [rawKey = "", ...rawValue] = segment.split("=")
    return {
      ...createEmptyPair(),
      key: decodeURIComponent(rawKey),
      value: decodeURIComponent(rawValue.join("=")),
    }
  })
}

function serializeFormUrlencoded(rows: KeyValuePair[]) {
  return rows
    .filter((row) => row.key || row.value)
    .map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`)
    .join("&")
}

function updateBody(patch: Partial<RequestBody>) {
  emit("update:modelValue", { ...props.modelValue, ...patch })
}

function normalizeJsonBodyContent(content: string) {
  const trimmed = content.trim()

  if (!trimmed) {
    return defaultJsonBody
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return content
  }
}

function selectType(type: BodyType) {
  if (type === props.modelValue.type) {
    return
  }

  if (type === "form-urlencoded") {
    formUrlencodedRows.value = deserializeFormUrlencoded(props.modelValue.content)
  }

  updateBody(buildBodyStateForType(type, props.modelValue))
}

function updateFormUrlencoded(rows: KeyValuePair[]) {
  formUrlencodedRows.value = rows
  updateBody({ content: serializeFormUrlencoded(rows) })
}

const uploadLimitLabel = formatBytesAsMib(MAX_UPLOAD_FILE_BYTES)
const rejectedBinaryFile = ref<{ name: string; size: number } | null>(null)
const rejectedFormDataFile = ref<{ rowId: string; name: string; size: number } | null>(null)

async function updateBinaryFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    updateBody({ binaryPath: "", binaryContent: undefined })
    return
  }

  // §22: decided on File.size, BEFORE readFileAsBase64 — a rejected file must
  // never enter WebView memory as a data URL, let alone the tab state. No
  // emit on rejection: emitting and then saying "not added" would be a lie.
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    rejectedBinaryFile.value = { name: file.name, size: file.size }
    return
  }
  rejectedBinaryFile.value = null

  updateBody({
    binaryPath: file.name,
    binaryContent: await readFileAsBase64(file),
  })
}

function updateFormDataEnabled(id: string, event: Event) {
  updateFormDataRow(id, { enabled: (event.target as HTMLInputElement).checked })
}

function updateFormDataText(
  id: string,
  field: "key" | "value" | "description",
  event: Event,
) {
  updateFormDataRow(id, { [field]: (event.target as HTMLInputElement).value })
}

function updateFormDataType(id: string, event: Event) {
  const valueType = (event.target as HTMLSelectElement).value as "text" | "file"
  updateFormDataRow(id, {
    valueType,
    value: valueType === "text" ? findFormDataRow(id)?.value || "" : "",
    fileName: valueType === "file" ? findFormDataRow(id)?.fileName || "" : "",
    filePath: valueType === "file" ? findFormDataRow(id)?.filePath || "" : "",
    fileContent: valueType === "file" ? findFormDataRow(id)?.fileContent : undefined,
    contentType: valueType === "file" ? findFormDataRow(id)?.contentType || "" : "",
  })
}

async function updateFormDataFile(id: string, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }

  // Same precheck as the binary exit — both exits or the gap just moves.
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    rejectedFormDataFile.value = { rowId: id, name: file.name, size: file.size }
    return
  }
  rejectedFormDataFile.value = null

  updateFormDataRow(id, {
    valueType: "file",
    value: "",
    fileName: file.name,
    filePath: "",
    fileContent: await readFileAsBase64(file),
    contentType: file.type || "application/octet-stream",
  })
}

function removeFormDataRow(id: string) {
  commitFormDataRows(formDataRows.value.filter((item) => item.id !== id))
}

function findFormDataRow(id: string) {
  return formDataRows.value.find((row) => row.id === id)
}

function updateFormDataRow(id: string, patch: Partial<FormDataItem>) {
  const rows = formDataRows.value.map((row) => (row.id === id ? { ...row, ...patch } : row))
  commitFormDataRows(rows)
}

function commitFormDataRows(rows: FormDataItem[]) {
  const nextRows = rows.filter(hasFormDataValue).map((row) =>
    row.valueType === "file"
      ? {
          ...row,
          valueType: "file" as const,
          value: "",
        }
      : {
          ...row,
          valueType: "text" as const,
          fileName: "",
          filePath: "",
          fileContent: "",
          contentType: "",
        },
  )

  updateBody({ formData: nextRows })
}

function formatFormDataValue(item: FormDataItem) {
  return item.valueType === "file"
    ? item.fileName || t("body.noFileSelected")
    : item.value
}

function buildBodyStateForType(type: BodyType, current: RequestBody): RequestBody {
  const cleared = {
    type,
    content: "",
    formData: [] as FormDataItem[],
    binaryPath: "",
    binaryContent: undefined,
  }

  if (type === "json") {
    const content =
      current.type === "json" || current.type === "raw" || current.type === "form-urlencoded"
        ? current.content
        : ""

    return {
      ...cleared,
      content: normalizeJsonBodyContent(content),
    }
  }

  if (type === "raw" || type === "form-urlencoded") {
    return {
      ...cleared,
      content:
        current.type === "json" || current.type === "raw" || current.type === "form-urlencoded"
          ? current.content
          : "",
    }
  }

  if (type === "form-data") {
    return {
      ...cleared,
      formData: current.type === "form-data" ? current.formData : [],
    }
  }

  if (type === "binary") {
    return {
      ...cleared,
      binaryPath: current.type === "binary" ? current.binaryPath : "",
      binaryContent: current.type === "binary" ? current.binaryContent : undefined,
    }
  }

  return cleared
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <div class="flex flex-wrap gap-2">
      <button
        v-for="option in bodyTypes"
        :key="option.value"
        class="rounded border px-3 py-1.5 text-sm transition"
        :class="
          selectedType === option.value
            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        "
        type="button"
        :title="option.title"
        @click="selectType(option.value)"
      >
        {{ option.label }}
      </button>
    </div>

    <div
      v-if="selectedType === 'none'"
      class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] text-sm text-[var(--text-secondary)]"
    >
      {{ t("body.noBody") }}
    </div>

    <div v-else-if="selectedType === 'json'" class="flex flex-1 min-h-0">
      <CodeEditor
        :model-value="modelValue.content"
        language="json"
        :placeholder="jsonPlaceholder"
        class="flex-1 min-h-0"
        @update:model-value="updateBody({ content: $event })"
      />
    </div>

    <div v-else-if="selectedType === 'raw'" class="flex flex-1 min-h-0">
      <CodeEditor
        :model-value="modelValue.content"
        language="text"
        :placeholder="t('body.rawPlaceholder')"
        class="flex-1 min-h-0"
        @update:model-value="updateBody({ content: $event })"
      />
    </div>

    <KeyValueEditor
      v-else-if="selectedType === 'form-urlencoded'"
      :model-value="formUrlencodedRows"
      @update:model-value="updateFormUrlencoded"
    />

    <div
      v-else-if="selectedType === 'form-data'"
      class="flex h-full min-h-0 flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      <div
        class="grid grid-cols-[36px_minmax(120px,1fr)_112px_minmax(140px,1fr)_44px] border-b border-[var(--border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]"
      >
        <span>{{ t("keyValue.on") }}</span>
        <span>{{ t("keyValue.key") }}</span>
        <span>Type</span>
        <span>{{ t("keyValue.value") }}</span>
        <span class="text-right">{{ t("keyValue.del") }}</span>
      </div>

      <div class="flex-1 overflow-auto">
        <div
          v-if="modelValue.formData.length === 0"
          class="border-b border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          {{ t("keyValue.addPair") }}
        </div>

        <div
          v-for="row in formDataRows"
          :key="row.id"
          class="grid grid-cols-[36px_minmax(120px,1fr)_112px_minmax(140px,1fr)_44px] items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_80%,transparent)] px-3 py-2 transition"
          :class="row.enabled ? '' : 'opacity-45'"
        >
          <label class="flex items-center justify-center">
            <input
              class="h-4 w-4 rounded border-[var(--border)] bg-[var(--bg-primary)] accent-[var(--accent)]"
              type="checkbox"
              :checked="row.enabled"
              @change="updateFormDataEnabled(row.id, $event)"
            />
          </label>

          <input
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('keyValue.key')"
            :value="row.key"
            @input="updateFormDataText(row.id, 'key', $event)"
          />

          <select
            class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :value="row.valueType || 'text'"
            @change="updateFormDataType(row.id, $event)"
          >
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>

          <div v-if="(row.valueType || 'text') === 'file'" class="flex min-w-0 flex-col gap-0.5">
            <div class="flex min-w-0 items-center gap-2">
              <label
                class="inline-flex h-9 shrink-0 cursor-pointer items-center rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
              >
                <input class="hidden" type="file" @change="updateFormDataFile(row.id, $event)" />
                {{ t("body.selectFile") }}
              </label>
              <span class="truncate font-mono text-sm text-[var(--text-secondary)]">
                {{ formatFormDataValue(row) }}
              </span>
            </div>
            <!-- The rule is always on screen, not only after a rejection. -->
            <span
              class="truncate text-[11px] text-[var(--text-secondary)]"
              data-testid="form-data-file-limit"
            >
              {{ t("body.fileSizeLimit", { limit: uploadLimitLabel }) }}
            </span>
            <span
              v-if="rejectedFormDataFile && rejectedFormDataFile.rowId === row.id"
              data-testid="form-data-file-rejected"
              class="truncate text-[11px] text-rose-400"
              :title="rejectedFormDataFile.name"
            >
              {{
                t("body.fileTooLarge", {
                  name: rejectedFormDataFile.name,
                  size: formatBytesAsMib(rejectedFormDataFile.size),
                  limit: uploadLimitLabel,
                })
              }}
            </span>
          </div>

          <input
            v-else
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('keyValue.value')"
            :value="row.value"
            @input="updateFormDataText(row.id, 'value', $event)"
          />

          <button
            class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :aria-label="t('keyValue.deleteRow')"
            @click="removeFormDataRow(row.id)"
          >
            x
          </button>
        </div>
      </div>
    </div>

    <div
      v-else
      class="flex min-h-[280px] flex-1 flex-col justify-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
    >
      <div class="text-sm text-[var(--text-secondary)]">{{ t("body.chooseFile") }}</div>
      <!-- The rule is always on screen, not only after a rejection: a limit
           that only speaks when hit makes every user discover it the hard way. -->
      <div class="text-xs text-[var(--text-secondary)]" data-testid="binary-file-limit">
        {{ t("body.fileSizeLimit", { limit: uploadLimitLabel }) }}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label
          class="inline-flex h-8 cursor-pointer items-center rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
        >
          <input class="hidden" type="file" @change="updateBinaryFile" />
          {{ t("body.selectFile") }}
        </label>
        <span class="font-mono text-sm text-[var(--text-secondary)]">
          {{ modelValue.binaryPath || t("body.noFileSelected") }}
        </span>
      </div>
      <div
        v-if="rejectedBinaryFile"
        data-testid="binary-file-rejected"
        class="text-xs leading-5 text-rose-400"
      >
        {{
          t("body.fileTooLarge", {
            name: rejectedBinaryFile.name,
            size: formatBytesAsMib(rejectedBinaryFile.size),
            limit: uploadLimitLabel,
          })
        }}
      </div>
    </div>
  </div>
</template>
