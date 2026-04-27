<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import ConfirmDialog from "../ui/ConfirmDialog.vue"
import { useEnvironmentsStore } from "../../stores/environments"
import { useProjectsStore } from "../../stores/projects"
import type { EnvVariable } from "../../types"

interface EditableEnvVariable extends EnvVariable {
  id: string
}

const projectsStore = useProjectsStore()
const environmentsStore = useEnvironmentsStore()
const { t } = useI18n()

const { activeProject } = storeToRefs(projectsStore)
const { environments, activeEnv, variables } = storeToRefs(environmentsStore)

const errorMessage = ref("")
const showSecrets = ref(false)
const showCreateEnvironment = ref(false)
const newEnvironmentName = ref("")
const deleteDialogVisible = ref(false)

onMounted(async () => {
  try {
    errorMessage.value = ""
    await environmentsStore.loadEnvironments()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
})

const rows = computed<EditableEnvVariable[]>(() => {
  const baseRows = variables.value.map((item, index) => ({
    id: `${item.key}-${index}`,
    ...item,
  }))
  const lastRow = baseRows[baseRows.length - 1]

  if (!lastRow || lastRow.key || lastRow.value) {
    return [
      ...baseRows,
      {
        id: crypto.randomUUID(),
        key: "",
        value: "",
        secret: false,
      },
    ]
  }

  return baseRows
})

const canDelete = computed(() => Boolean(activeProject.value && activeEnv.value))

async function handleEnvChange(event: Event) {
  await environmentsStore.setActiveEnv((event.target as HTMLSelectElement).value || null)
}

function openCreateEnvironment() {
  errorMessage.value = ""
  newEnvironmentName.value = ""
  showCreateEnvironment.value = true
}

function cancelCreateEnvironment() {
  showCreateEnvironment.value = false
  newEnvironmentName.value = ""
  errorMessage.value = ""
}

function createEnvironment() {
  const name = newEnvironmentName.value.trim()
  if (!name) {
    errorMessage.value = t("errors.environmentNameRequired")
    return
  }

  try {
    environmentsStore.createEnvironment(name)
    newEnvironmentName.value = ""
    showCreateEnvironment.value = false
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function commitRows(nextRows: EditableEnvVariable[]) {
  environmentsStore.setVariables(
    nextRows
      .filter((row) => row.key || row.value)
      .map(({ key, value, secret }) => ({ key, value, secret })),
  )
}

function updateRow(id: string, patch: Partial<EditableEnvVariable>) {
  const nextRows = rows.value.map((row) => (row.id === id ? { ...row, ...patch } : row))
  commitRows(nextRows)
}

function removeRow(id: string) {
  commitRows(rows.value.filter((row) => row.id !== id))
}

async function saveEnvironment() {
  errorMessage.value = ""

  try {
    await environmentsStore.saveEnvironment()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function deleteEnvironment() {
  if (!activeEnv.value) {
    return
  }

  errorMessage.value = ""
  try {
    await environmentsStore.deleteEnvironment(activeEnv.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function requestDeleteEnvironment() {
  if (!activeEnv.value) {
    return
  }

  deleteDialogVisible.value = true
}

async function confirmDeleteEnvironment() {
  deleteDialogVisible.value = false
  await deleteEnvironment()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
    <div class="border-b border-[var(--border)] px-4 py-3">
      <div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        {{ t("environment.title") }}
      </div>

      <template v-if="activeProject">
        <div class="flex gap-2">
          <select
            class="h-9 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :value="activeEnv ?? ''"
            @change="handleEnvChange"
          >
            <option value="" disabled>{{ t("environment.selectEnvironment") }}</option>
            <option v-for="name in environments" :key="name" :value="name">
              {{ name }}
            </option>
          </select>
          <button
            class="inline-flex h-9 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
            type="button"
            @click="openCreateEnvironment"
          >
            <Plus :size="14" />
            <span>{{ t("environment.new") }}</span>
          </button>
        </div>
        <form v-if="showCreateEnvironment" class="mt-2 flex gap-2" @submit.prevent="createEnvironment">
          <input
            v-model="newEnvironmentName"
            class="h-9 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('environment.environmentName')"
          />
          <button
            class="inline-flex h-9 items-center justify-center rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
            type="submit"
          >
            {{ t("common.create") }}
          </button>
          <button
            class="inline-flex h-9 items-center justify-center rounded border border-[var(--border)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
            type="button"
            @click="cancelCreateEnvironment"
          >
            {{ t("common.cancel") }}
          </button>
        </form>
      </template>

      <div v-if="errorMessage" class="mt-3 text-sm text-rose-300">
        {{ errorMessage }}
      </div>
    </div>

    <div v-if="!activeProject" class="flex flex-1 items-center justify-center px-6">
      <div class="max-w-xs rounded-lg border border-dashed border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-primary)_92%,white),color-mix(in_srgb,var(--bg-secondary)_72%,transparent))] px-4 py-4 text-center">
        <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("environment.selectProjectFirst") }}</div>
        <div class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {{ t("environment.selectProjectDescription") }}
        </div>
      </div>
    </div>

    <template v-else-if="activeEnv">
      <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        <div class="grid flex-1 grid-cols-[minmax(120px,1fr)_minmax(160px,1.2fr)_44px_44px] gap-2">
          <span>{{ t("keyValue.key") }}</span>
          <span>{{ t("keyValue.value") }}</span>
          <span class="text-center">{{ t("environment.secret") }}</span>
          <span class="text-right">{{ t("keyValue.del") }}</span>
        </div>
        <button
          class="ml-2 inline-flex h-8 w-8 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
          type="button"
          :aria-label="showSecrets ? t('environment.hideSecretValues') : t('environment.showSecretValues')"
          @click="showSecrets = !showSecrets"
        >
          <EyeOff v-if="showSecrets" :size="15" />
          <Eye v-else :size="15" />
        </button>
      </div>

      <div class="flex-1 overflow-auto px-4 py-2">
        <div
          v-for="row in rows"
          :key="row.id"
          class="grid grid-cols-[minmax(120px,1fr)_minmax(160px,1.2fr)_44px_44px] items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_80%,transparent)] py-2"
        >
          <input
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('keyValue.key')"
            :value="row.key"
            @input="updateRow(row.id, { key: ($event.target as HTMLInputElement).value })"
          />
          <input
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :type="row.secret && !showSecrets ? 'password' : 'text'"
            :placeholder="row.secret && !showSecrets ? '****' : t('keyValue.value')"
            :value="row.value"
            @input="updateRow(row.id, { value: ($event.target as HTMLInputElement).value })"
          />
          <button
            class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :class="row.secret ? 'text-amber-300' : ''"
            :aria-label="row.secret ? t('environment.secret') : t('environment.visible')"
            @click="updateRow(row.id, { secret: !row.secret })"
          >
            <Lock :size="15" />
          </button>
          <button
            class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :aria-label="t('keyValue.deleteRow')"
            :title="t('keyValue.deleteRow')"
            @click="removeRow(row.id)"
          >
            <Trash2 :size="15" />
          </button>
        </div>
      </div>

      <div v-if="errorMessage" class="px-4 pb-2 text-sm text-rose-300">
        {{ errorMessage }}
      </div>

      <div class="flex gap-2 border-t border-[var(--border)] p-3">
        <button
          class="flex h-8 flex-1 items-center justify-center rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
          type="button"
          @click="saveEnvironment"
        >
          {{ t("environment.save") }}
        </button>
        <button
          class="flex h-8 flex-1 items-center justify-center rounded border border-[var(--border)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="!canDelete"
          @click="requestDeleteEnvironment"
        >
          {{ t("environment.delete") }}
        </button>
      </div>
    </template>

    <div v-else class="flex flex-1 items-center justify-center px-6">
      <div class="max-w-xs rounded-lg border border-dashed border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-primary)_92%,white),color-mix(in_srgb,var(--bg-secondary)_72%,transparent))] px-4 py-4 text-center">
        <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("environment.noEnvironments") }}</div>
        <div class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {{ t("environment.noEnvironmentsDescription") }}
        </div>
        <button
          class="mt-4 inline-flex h-8 items-center gap-2 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
          type="button"
          @click="openCreateEnvironment"
        >
          <Plus :size="14" />
          <span>{{ t("environment.newEnvironment") }}</span>
        </button>
      </div>
    </div>

    <ConfirmDialog
      :visible="deleteDialogVisible"
      :title="t('environment.delete')"
      :message="t('environment.deleteConfirm', { name: activeEnv ?? '' })"
      :confirm-label="t('environment.delete')"
      :cancel-label="t('common.cancel')"
      danger
      @cancel="deleteDialogVisible = false"
      @confirm="confirmDeleteEnvironment"
    />
  </section>
</template>
