<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { Eye, EyeOff, Lock, LockOpen, Plus, Trash2 } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import ConfirmDialog from "../ui/ConfirmDialog.vue"
import InlineError from "../ui/InlineError.vue"
import { useEnvironmentsStore } from "../../stores/environments"
import { useProjectsStore } from "../../stores/projects"
import type { EnvVariable, SecretKeyCollision } from "../../types"

interface EditableEnvVariable extends EnvVariable {
  id: string
}

const projectsStore = useProjectsStore()
const environmentsStore = useEnvironmentsStore()
const { t } = useI18n()

const { activeProject } = storeToRefs(projectsStore)
const { environments, activeEnv, variables, collisions } = storeToRefs(environmentsStore)

const errorMessage = ref("")
const showSecrets = ref(false)
const showCreateEnvironment = ref(false)
const newEnvironmentName = ref("")
const deleteDialogVisible = ref(false)

// The record being confirmed, or null. Confirming deletes the record from
// disk — irreversibly — so the button never acknowledges directly.
const collisionToAcknowledge = ref<SecretKeyCollision | null>(null)
const acknowledgeError = ref("")
const acknowledgeBusy = ref(false)

onMounted(async () => {
  try {
    errorMessage.value = ""
    await environmentsStore.loadEnvironments()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
  // The panel is unmounted whenever the sidebar shows another tab, so this
  // runs on every entry, not once per app launch. loadCollisions never
  // throws (a failed read shows nothing, and claims nothing).
  await environmentsStore.loadCollisions()
})

/**
 * variableKey can be an empty string when the vault key's third segment does
 * not decode; the identifier is the only honest fallback, never a blank.
 */
function collisionVariableName(record: SecretKeyCollision): string {
  return record.variableKey || record.legacyVaultKey
}

/** RFC 3339 in, locale string out; an unparseable value shows as itself. */
function formatDetectedAt(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function requestAcknowledgeCollision(record: SecretKeyCollision) {
  acknowledgeError.value = ""
  collisionToAcknowledge.value = record
}

function cancelAcknowledgeCollision() {
  collisionToAcknowledge.value = null
  acknowledgeError.value = ""
}

async function confirmAcknowledgeCollision() {
  if (!collisionToAcknowledge.value) {
    return
  }

  acknowledgeBusy.value = true
  try {
    await environmentsStore.acknowledgeCollision(collisionToAcknowledge.value.legacyVaultKey)
    collisionToAcknowledge.value = null
    acknowledgeError.value = ""
  } catch (error) {
    // The dialog stays open and shows the backend's own words: a failed
    // acknowledgement that looks successful would resurface the record on
    // the next visit as a surprise.
    acknowledgeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    acknowledgeBusy.value = false
  }
}

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
        <p
          v-if="showCreateEnvironment"
          class="mt-2 text-xs leading-5 text-[var(--text-secondary)]"
        >
          {{ t("environment.nameNormalizedHint") }}
        </p>
        <!--
          Stacked on purpose: with the input and both buttons on one line, the
          two incompressible buttons squeezed the input down to its 26px
          padding-and-border floor — zero content width in the English locale
          at the default sidebar ratio. The input gets its own line; the
          buttons sit right-aligned on a second one.
        -->
        <form
          v-if="showCreateEnvironment"
          class="mt-2 flex flex-col gap-2"
          @submit.prevent="createEnvironment"
        >
          <input
            v-model="newEnvironmentName"
            class="h-9 w-full min-w-0 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('environment.environmentName')"
          />
          <div data-testid="create-environment-actions" class="flex justify-end gap-2">
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
          </div>
        </form>
      </template>

      <div v-if="errorMessage" class="mt-3">
        <InlineError :message="errorMessage" />
      </div>

      <!--
        Outside the activeProject gate on purpose: collision records are
        global, carry their own project names, and missing one costs an
        unrecoverable credential — so they show with no project active too.
      -->
      <div
        v-if="collisions.length > 0"
        data-testid="collision-section"
        class="mt-3 rounded border border-amber-400/50 bg-[color-mix(in_srgb,#f59e0b_10%,transparent)] p-3"
      >
        <div class="text-sm font-semibold text-amber-300">
          {{ t("environment.collisionTitle", { count: collisions.length }) }}
        </div>
        <div class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {{ t("environment.collisionConsequence") }}
        </div>
        <!-- Keyed by legacyVaultKey: the backend never records the same key twice. -->
        <div
          v-for="record in collisions"
          :key="record.legacyVaultKey"
          data-testid="collision-record"
          class="mt-3 border-t border-[color-mix(in_srgb,var(--border)_80%,transparent)] pt-3"
        >
          <div class="text-sm font-semibold text-[var(--text-primary)]">
            {{ t("environment.collisionVariable", { name: collisionVariableName(record) }) }}
          </div>
          <div class="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            {{ t("environment.collisionShared") }}
          </div>
          <ul class="mt-1 space-y-0.5">
            <!--
              break-all: this markup belongs to the collision-notice slice
              (D08); D13 only fixes its layout. A name with no break point
              (no hyphen, no space) used to overflow ~179px into a region
              that cannot scroll — and this line is the only thing that says
              which two environments shared the slot.
            -->
            <li
              v-for="environmentRef in record.environments"
              :key="`${environmentRef.project}/${environmentRef.environment}`"
              data-testid="collision-environment"
              class="break-all font-mono text-sm text-[var(--text-primary)]"
            >
              {{ environmentRef.project }} / {{ environmentRef.environment }}
            </li>
          </ul>
          <div class="mt-1 text-sm text-[var(--text-secondary)]">
            {{ t("environment.collisionDetectedAt", { at: formatDetectedAt(record.detectedAt) }) }}
          </div>
          <!--
            min-h-8, not h-8: this markup belongs to the collision-notice
            slice (D08); D13 only fixes its layout. The English wording wraps
            to two lines in a narrow sidebar, and a fixed height painted the
            second line outside the button box.
          -->
          <button
            data-testid="collision-ack"
            class="mt-2 inline-flex min-h-8 items-center rounded border border-[var(--border)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
            type="button"
            @click="requestAcknowledgeCollision(record)"
          >
            {{ t("environment.collisionAck") }}
          </button>
        </div>
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
      <!--
        One section label instead of the old four column labels (key / value /
        secret / del): the rows below are two lines each, so column labels have
        no columns to line up with, and the old fixed-minimum header track was
        432px — twice the default sidebar pane. The labels' information lives
        on the controls themselves (title / aria-label).
      -->
      <div
        data-testid="variable-table-header"
        class="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]"
      >
        <div class="min-w-0 flex-1 truncate">{{ t("environment.variables") }}</div>
        <!--
          shrink-0 keeps this button binary — fully visible or clipped. Without
          it a tight header squeezes the 32px box down to the 15px icon first,
          leaving a "half a button" state nobody can judge.
        -->
        <button
          data-testid="toggle-secret-visibility"
          class="ml-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
          type="button"
          :aria-label="showSecrets ? t('environment.hideSecretValues') : t('environment.showSecretValues')"
          @click="showSecrets = !showSecrets"
        >
          <EyeOff v-if="showSecrets" :size="15" />
          <Eye v-else :size="15" />
        </button>
      </div>

      <div class="flex-1 overflow-auto px-4 py-2">
        <!--
          Two lines per variable: key + the two icon buttons on the first, the
          value spanning the second. The old single-line track demanded 392px
          minimum while the default sidebar pane is ~214px, which pushed both
          buttons out of view. The 36px button tracks carry no slack on
          purpose — that width is measured against the buttons' own w-9 boxes,
          not guessed; widening the buttons without widening the tracks makes
          them overdraw their neighbours.
        -->
        <div
          v-for="row in rows"
          :key="row.id"
          data-testid="variable-row"
          class="grid grid-cols-[minmax(0,1fr)_36px_36px] items-center gap-x-2 gap-y-1 border-b border-[color-mix(in_srgb,var(--border)_80%,transparent)] py-2"
        >
          <!--
            A deliberate wrapper, not a leftover: a px-3 input's border-box
            floor is 26px (24px padding + 2px border), so min-width alone
            cannot take it below that — once the 0-minimum track gets narrower
            the input would keep painting 26px and land on the secret toggle
            (measured 18px of overlap at a 120px pane). This cell clips the
            overhang so the input shows less instead. Measured as sufficient
            against the one natural alternative (flex shrink), which pushes
            the buttons out instead; other alternatives were not exhausted.
          -->
          <div data-testid="variable-key-cell" class="min-w-0 overflow-hidden">
            <input
              data-testid="variable-key"
              class="h-9 w-full min-w-0 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
              type="text"
              :placeholder="t('keyValue.key')"
              :aria-label="t('keyValue.key')"
              :value="row.key"
              @input="updateRow(row.id, { key: ($event.target as HTMLInputElement).value })"
            />
          </div>
          <button
            data-testid="secret-toggle"
            class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :class="row.secret ? 'text-amber-300' : ''"
            :title="row.secret ? t('environment.secret') : t('environment.visible')"
            :aria-label="row.secret ? t('environment.secret') : t('environment.visible')"
            @click="updateRow(row.id, { secret: !row.secret })"
          >
            <Lock v-if="row.secret" :size="15" />
            <LockOpen v-else :size="15" />
          </button>
          <button
            data-testid="delete-row"
            class="flex h-9 w-9 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[var(--text-primary)]"
            type="button"
            :aria-label="t('keyValue.deleteRow')"
            :title="t('keyValue.deleteRow')"
            @click="removeRow(row.id)"
          >
            <Trash2 :size="15" />
          </button>
          <input
            data-testid="variable-value"
            class="col-span-3 col-start-1 h-9 w-full min-w-0 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_75%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :type="row.secret && !showSecrets ? 'password' : 'text'"
            :placeholder="row.secret && !showSecrets ? '****' : t('keyValue.value')"
            :aria-label="t('keyValue.value')"
            :value="row.value"
            @input="updateRow(row.id, { value: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>

      <div v-if="errorMessage" class="px-4 pb-2">
        <InlineError :message="errorMessage" />
      </div>

      <div class="flex gap-2 border-t border-[var(--border)] p-3">
        <button
          data-testid="environment-save"
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

    <!--
      v-if, not just :visible — deliberately unlike the delete dialog above,
      and not a candidate for "simplifying" back to that shape. A dialog that
      stays mounted keeps evaluating its prop bindings, so the title, message
      and confirm-label expressions would call t() with collision keys even
      while the dialog is hidden. With zero records the panel must not touch
      any collision key at all — no collision node, and no positive claim in
      any wording (D08 §8; the test pins "no t() call with a collision key").
      Mounting this dialog only while records exist is what keeps that true.
    -->
    <ConfirmDialog
      v-if="collisions.length > 0"
      :visible="collisionToAcknowledge !== null"
      :title="t('environment.collisionAckTitle')"
      :message="
        t('environment.collisionAckConfirm', {
          variable: collisionToAcknowledge ? collisionVariableName(collisionToAcknowledge) : '',
        })
      "
      :confirm-label="t('environment.collisionAck')"
      :cancel-label="t('common.cancel')"
      danger
      :error-message="acknowledgeError"
      :busy="acknowledgeBusy"
      @cancel="cancelAcknowledgeCollision"
      @confirm="confirmAcknowledgeCollision"
    />
  </section>
</template>
