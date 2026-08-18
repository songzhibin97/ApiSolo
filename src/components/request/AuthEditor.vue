<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { AuthConfig, AuthType } from "../../types";

const props = defineProps<{
  modelValue: AuthConfig;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: AuthConfig];
}>();
const { t } = useI18n();

const authTypes = computed<{ label: string; value: AuthType }[]>(() => [
  { label: t("auth.none"), value: "none" },
  { label: t("auth.basic"), value: "basic" },
  { label: t("auth.bearer"), value: "bearer" },
  { label: t("auth.apiKey"), value: "api-key" },
]);

const selectedType = computed(() => props.modelValue.type);
const authDescription = computed(() => t(`auth.description.${selectedType.value}`));

/**
 * The URL bar deliberately does not render the query API key (its value is
 * usually the secret itself). Without saying so here, a user who picks Query
 * and then sees no parameter in the address cannot tell a safety measure from
 * a broken feature.
 */
const isQueryApiKey = computed(
  () => selectedType.value === "api-key" && (props.modelValue.apiKey?.addTo ?? "header") === "query",
);

function updateAuth(value: AuthConfig) {
  emit("update:modelValue", value);
}

function selectType(type: AuthType) {
  if (type === "none") {
    updateAuth({ type: "none" });
    return;
  }

  if (type === "basic") {
    updateAuth({
      type,
      basic: props.modelValue.basic ?? { username: "", password: "" },
    });
    return;
  }

  if (type === "bearer") {
    updateAuth({
      type,
      bearer: props.modelValue.bearer ?? { token: "" },
    });
    return;
  }

  updateAuth({
    type,
    apiKey: props.modelValue.apiKey ?? { key: "", value: "", addTo: "header" },
  });
}

function updateBasicUsername(event: Event) {
  updateAuth({
    type: "basic",
    basic: {
      username: (event.target as HTMLInputElement).value,
      password: props.modelValue.basic?.password ?? "",
    },
  });
}

function updateBasicPassword(event: Event) {
  updateAuth({
    type: "basic",
    basic: {
      username: props.modelValue.basic?.username ?? "",
      password: (event.target as HTMLInputElement).value,
    },
  });
}

function updateBearerToken(event: Event) {
  updateAuth({
    type: "bearer",
    bearer: { token: (event.target as HTMLInputElement).value },
  });
}

function updateApiKeyKey(event: Event) {
  updateAuth({
    type: "api-key",
    apiKey: {
      key: (event.target as HTMLInputElement).value,
      value: props.modelValue.apiKey?.value ?? "",
      addTo: props.modelValue.apiKey?.addTo ?? "header",
    },
  });
}

function updateApiKeyValue(event: Event) {
  updateAuth({
    type: "api-key",
    apiKey: {
      key: props.modelValue.apiKey?.key ?? "",
      value: (event.target as HTMLInputElement).value,
      addTo: props.modelValue.apiKey?.addTo ?? "header",
    },
  });
}

function updateApiKeyLocation(event: Event) {
  updateAuth({
    type: "api-key",
    apiKey: {
      key: props.modelValue.apiKey?.key ?? "",
      value: props.modelValue.apiKey?.value ?? "",
      addTo: (event.target as HTMLSelectElement).value as "header" | "query",
    },
  });
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <div class="flex flex-wrap gap-2">
      <button
        v-for="option in authTypes"
        :key="option.value"
        class="rounded border px-3 py-1.5 text-sm transition"
        :class="
          selectedType === option.value
            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        "
        type="button"
        @click="selectType(option.value)"
      >
        {{ option.label }}
      </button>
    </div>

    <div class="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] px-4 py-3 text-sm text-[var(--text-secondary)]">
      {{ authDescription }}
    </div>

    <div
      v-if="selectedType === 'none'"
      class="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] text-sm text-[var(--text-secondary)]"
    >
      {{ t("auth.noAuth") }}
    </div>

    <div
      v-else-if="selectedType === 'basic'"
      class="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 md:grid-cols-2"
    >
      <input
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('auth.username')"
        :value="modelValue.basic?.username ?? ''"
        @input="updateBasicUsername"
      />
      <input
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="password"
        :placeholder="t('auth.password')"
        :value="modelValue.basic?.password ?? ''"
        @input="updateBasicPassword"
      />
    </div>

    <div
      v-else-if="selectedType === 'bearer'"
      class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
    >
      <input
        class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('auth.bearerToken')"
        :value="modelValue.bearer?.token ?? ''"
        @input="updateBearerToken"
      />
    </div>

    <div
      v-else
      class="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 md:grid-cols-[1fr_1fr_180px]"
    >
      <input
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('keyValue.key')"
        :value="modelValue.apiKey?.key ?? ''"
        @input="updateApiKeyKey"
      />
      <input
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--text-secondary)_72%,transparent)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        type="text"
        :placeholder="t('keyValue.value')"
        :value="modelValue.apiKey?.value ?? ''"
        @input="updateApiKeyValue"
      />
      <select
        class="h-9 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
        :value="modelValue.apiKey?.addTo ?? 'header'"
        :title="t('auth.addTo')"
        @change="updateApiKeyLocation"
      >
        <option value="header">{{ t("auth.header") }}</option>
        <option value="query">{{ t("auth.query") }}</option>
      </select>

      <p
        v-if="isQueryApiKey"
        class="text-xs leading-relaxed text-[var(--text-secondary)] md:col-span-3"
      >
        {{ t("auth.queryKeyHidden") }}
      </p>
    </div>
  </div>
</template>
