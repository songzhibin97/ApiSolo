<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import CodeEditor from "../editor/CodeEditor.vue";
import JsonTreeView from "./JsonTreeView.vue";
import { countCodePoints, responseFileName } from "./body-actions";
import { MAX_RESPONSE_WIRE_BYTES, formatBytesAsMib } from "../../utils/limits";
import type { ResponseBodyKind, ResponseBodySource } from "../../types";

const props = defineProps<{
  body: string;
  contentType: string;
  bodyKind?: ResponseBodyKind;
  bodyTruncated?: boolean;
  /**
   * Optional, and absence reads as "unknown" rather than "network": the panel
   * may not call a body complete unless something told it where that body came
   * from. The store makes the field required, so the only way to arrive here
   * without one is a caller that never had the answer.
   */
  bodySource?: ResponseBodySource;
}>();

/**
 * The network cap the notice quotes. Interpolated, not hardcoded in the copy:
 * a copy that names its own number drifts apart from the constant.
 */
const networkCapLabel = formatBytesAsMib(MAX_RESPONSE_WIRE_BYTES);

const { t } = useI18n();
const activeMode = ref<"tree" | "raw">("raw");
const copyState = ref<"idle" | "copied" | "failed">("idle");
const MAX_DISPLAY_SIZE = 500_000

let copyStateTimer: number | null = null;

/**
 * The decision is the flag, never the content type. A response declaring
 * `text/plain` that carries NUL bytes has already been judged binary upstream,
 * and matching the placeholder text instead would call a body binary purely
 * because the server happened to send a sentence that looks like one.
 */
const isBinary = computed(() => props.bodyKind === "binary");

/**
 * Flag only, same rule as `isBinary`: never inferred from the body text, and
 * deliberately independent of `isTruncated` below — that one means "the view
 * cut a body it fully holds", this one means "the bytes never arrived".
 */
const isNetworkTruncated = computed(() => props.bodyTruncated === true);

const normalizedContentType = computed(() => props.contentType.toLowerCase());
const isTruncated = computed(() => props.body.length > MAX_DISPLAY_SIZE)
const hasBody = computed(() => props.body.length > 0);

const viewType = computed(() => {
  const type = normalizedContentType.value;

  if (type.includes("application/json") || type.includes("+json")) {
    return "json";
  }

  if (type.includes("text/html")) {
    return "xml";
  }

  if (type.includes("text/xml") || type.includes("application/xml") || type.includes("+xml")) {
    return "xml";
  }

  return "text";
});

const parsedJsonState = computed(() => {
  if (viewType.value !== "json" || isTruncated.value) {
    return {
      isValid: false,
      value: null as unknown,
    };
  }

  try {
    return {
      isValid: true,
      value: JSON.parse(props.body) as unknown,
    };
  } catch {
    return {
      isValid: false,
      value: null as unknown,
    };
  }
});

const parsedJson = computed(() => parsedJsonState.value.value);
const canUseTreeView = computed(
  () => parsedJsonState.value.isValid && !isTruncated.value && !isBinary.value,
);

const displayBody = computed(() => {
  if (isTruncated.value) {
    return `${props.body.slice(0, MAX_DISPLAY_SIZE)}\n\n${t("response.largeBodyTruncated")}`
  }

  // `isValid` has to be consulted, not just `viewType`. On a parse failure
  // `parsedJson` is null, and `JSON.stringify(null)` does NOT throw — it
  // returns the four characters "null", so the catch below never ran and a
  // server that answered a Content-Type of application/json with broken JSON
  // had its body replaced on screen by that word. That is precisely the moment
  // the raw text matters most.
  if (viewType.value !== "json" || !parsedJsonState.value.isValid) {
    return props.body;
  }

  try {
    return JSON.stringify(parsedJson.value, null, 2);
  } catch {
    // Reachable, and kept for it: `JSON.parse` accepts nesting deep enough to
    // blow the stack on the way back out, so a body can be valid and still
    // have no formatted form. Falling back to the text we were given beats
    // rendering nothing.
    return props.body;
  }
});

/**
 * Code points rather than `length`, which counts UTF-16 units and calls one
 * emoji two characters. Known and deliberately not papered over: a code point
 * is still not a grapheme cluster, so a flag or a combining accent counts more
 * than once. The copy therefore states a number and claims nothing about how
 * it was arrived at.
 */
const bodyLength = computed(() => countCodePoints(props.body));

/**
 * What copy and download actually hand over, in one sentence, used both as the
 * buttons' title and as the visible note.
 *
 * The branches are ordered weakest-claim-first on purpose. "Complete" is the
 * strongest thing this panel can say and the only one that needs a licence:
 * the body must have come straight off the network AND the read must have run
 * to the end. A stored snapshot fails that test even when its own truncation
 * flag is false, because `buildHistoryEntry` shortens long bodies on the way
 * to disk and that cut is recorded nowhere in the row.
 */
const actionScopeText = computed(() => {
  if (!hasBody.value) {
    return t("response.bodyScopeEmpty");
  }

  if (props.bodySource !== "network") {
    return t("response.bodyScopeStored", { count: bodyLength.value });
  }

  if (isNetworkTruncated.value) {
    return t("response.bodyScopeReceived", { count: bodyLength.value });
  }

  return t("response.bodyScopeFull", { count: bodyLength.value });
});

/**
 * Shown where the view holds back part of the body, where the body is itself
 * partial, and wherever the panel is declining to call the body complete —
 * that last one is the whole point, since a withheld claim nobody can see is
 * indistinguishable from the claim being made. Pretty printing alone does not
 * qualify: no content is missing, so a permanent line on every JSON response
 * would be noise.
 */
const showScopeNote = computed(
  () =>
    hasBody.value &&
    (isTruncated.value || isNetworkTruncated.value || props.bodySource !== "network"),
);

const copyLabel = computed(() => {
  if (copyState.value === "copied") {
    return t("response.copied");
  }

  if (copyState.value === "failed") {
    return t("response.copyFailed");
  }

  return t("response.copyBody");
});

/**
 * Which copy attempt is allowed to write the visible state: the newest one,
 * and nothing else. Taken on entry, checked again after the await.
 *
 * Counting attempts rather than responses is the point. "Has the response
 * changed" is only a proxy for "is this still the newest attempt", and the two
 * come apart the moment one body is copied twice — both attempts would read
 * the same response-scoped value, so a late rejection from the first can stamp
 * "Copy failed" over the second's success while the clipboard holds the body.
 * One counter over attempts covers all four ways a stale write can arrive: a
 * new response, a success landing late, a rejection landing late, and two
 * copies racing on one body.
 */
let latestCopyAttempt = 0;

function clearCopyState() {
  // Advancing the counter is what ends any attempt still in flight: it is no
  // longer the newest, so it cannot put its word back over the new response.
  latestCopyAttempt += 1;
  copyState.value = "idle";

  if (copyStateTimer !== null) {
    window.clearTimeout(copyStateTimer);
    copyStateTimer = null;
  }
}

function flashCopyState(state: "copied" | "failed") {
  copyState.value = state;

  if (copyStateTimer !== null) {
    window.clearTimeout(copyStateTimer);
  }

  copyStateTimer = window.setTimeout(() => {
    copyState.value = "idle";
    copyStateTimer = null;
  }, 1600);
}

/**
 * A failure is reported, not swallowed: a button that says "Copy" and leaves
 * the clipboard untouched is the interface claiming something it did not do.
 */
async function copyBody() {
  if (!hasBody.value) {
    return;
  }

  const attempt = ++latestCopyAttempt;

  try {
    if (!navigator?.clipboard) {
      throw new Error("clipboard unavailable");
    }

    await navigator.clipboard.writeText(props.body);

    if (attempt !== latestCopyAttempt) {
      return;
    }

    flashCopyState("copied");
  } catch {
    if (attempt !== latestCopyAttempt) {
      return;
    }

    flashCopyState("failed");
  }
}

function downloadBody() {
  if (!hasBody.value) {
    return;
  }

  const blob = new Blob([props.body], { type: props.contentType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = responseFileName(props.contentType, new Date());
  link.click();
  URL.revokeObjectURL(url);
}

watch(
  () => [canUseTreeView.value, props.body, props.contentType],
  ([value]) => {
    activeMode.value = value ? "tree" : "raw";
    // "Copied" is a statement about the body that was copied, and the
    // clipboard still holds that one.
    clearCopyState();
  },
  { immediate: true },
);

onUnmounted(() => {
  clearCopyState();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <!--
      Above the body area and never concatenated into the body text: appending
      it would pollute what the user copies out of the read-only editor. When
      the display cut also fires, that note sits inside the editor text, so
      this notice is always the upper one of the two.
    -->
    <div
      v-if="isNetworkTruncated"
      data-testid="network-truncated-notice"
      class="shrink-0 rounded border border-amber-500/40 bg-[color-mix(in_srgb,#f59e0b_10%,transparent)] px-3 py-2 text-sm leading-5 text-[var(--text-primary)]"
    >
      {{ t("response.networkTruncated", { limit: networkCapLabel }) }}
    </div>

    <!--
      No action bar on this path, and a sentence saying why. The bytes were
      replaced with a marker upstream and never reached the interface, so a
      copy or download button here would hand over that sentence instead of the
      response - the shape D16 had to remove from the sidebar preview.
    -->
    <div
      v-if="isBinary"
      data-testid="binary-body-notice"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 text-center text-sm leading-6 text-[var(--text-secondary)]"
    >
      <p>{{ t("response.binaryBody") }}</p>
      <p data-testid="binary-no-actions">{{ t("response.binaryNoActions") }}</p>
    </div>

    <template v-else>
    <div
      data-testid="response-body-actions"
      class="flex shrink-0 flex-nowrap items-center gap-2"
    >
      <template v-if="canUseTreeView">
        <button
          type="button"
          data-testid="response-view-tree"
          class="shrink-0 rounded border px-3 py-1.5 text-sm transition"
          :class="
            activeMode === 'tree'
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          @click="activeMode = 'tree'"
        >
          {{ t("response.treeView") }}
        </button>
        <button
          type="button"
          data-testid="response-view-raw"
          class="shrink-0 rounded border px-3 py-1.5 text-sm transition"
          :class="
            activeMode === 'raw'
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          @click="activeMode = 'raw'"
        >
          {{ t("response.rawView") }}
        </button>
      </template>

      <button
        type="button"
        data-testid="response-body-copy"
        class="ml-auto shrink-0 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm whitespace-nowrap text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!hasBody"
        :title="actionScopeText"
        @click="copyBody"
      >
        {{ copyLabel }}
      </button>
      <button
        type="button"
        data-testid="response-body-download"
        class="shrink-0 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm whitespace-nowrap text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!hasBody"
        :title="actionScopeText"
        @click="downloadBody"
      >
        {{ t("response.downloadBody") }}
      </button>
    </div>

    <div
      v-if="showScopeNote"
      data-testid="response-body-status"
      class="shrink-0 text-xs leading-4 text-[var(--text-secondary)]"
    >
      {{ actionScopeText }}
    </div>

    <div
      v-if="canUseTreeView && activeMode === 'tree'"
      class="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3"
    >
      <JsonTreeView :data="parsedJson" />
    </div>

    <CodeEditor
      v-else
      :model-value="displayBody"
      :language="viewType"
      readonly
      class="min-h-0 flex-1"
    />
    </template>
  </div>
</template>
