<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { EditorView, placeholder as placeholderExtension, ViewUpdate } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";

type EditorLanguage = "json" | "xml" | "text" | "javascript";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language: EditorLanguage;
    placeholder?: string;
    readonly?: boolean;
    showGutter?: boolean;
  }>(),
  {
    placeholder: "",
    readonly: false,
    showGutter: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const container = ref<HTMLDivElement | null>(null);

let editorView: EditorView | null = null;

const customHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#c678dd" },
  { tag: tags.string, color: "#98c379" },
  { tag: tags.number, color: "#d19a66" },
  { tag: tags.bool, color: "#d19a66" },
  { tag: tags.null, color: "#7f848e" },
  { tag: tags.propertyName, color: "#e06c75" },
  { tag: tags.comment, color: "#7f848e", fontStyle: "italic" },
  { tag: tags.punctuation, color: "#abb2bf" },
  { tag: tags.operator, color: "#56b6c2" },
  { tag: tags.function(tags.variableName), color: "#61afef" },
  { tag: tags.variableName, color: "#e06c75" },
  { tag: tags.typeName, color: "#e5c07b" },
]);

const languageExtension = computed(() => {
  switch (props.language) {
    case "json":
      return json();
    case "javascript":
      return javascript();
    case "xml":
      return xml();
    default:
      return [];
  }
});

const themeExtension = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "280px",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    border: "0",
    borderRadius: "0",
    overflow: "hidden",
  },
  ".cm-scroller": {
    display: "flex",
    alignItems: "flex-start",
    height: "100%",
    position: "relative",
    overflow: "auto",
    backgroundColor: "var(--bg-primary)",
    fontFamily:
      'ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.5",
    fontSize: "13px",
  },
  ".cm-content": {
    flexGrow: "1",
    minWidth: "0",
    padding: "0.75rem 0 1rem",
    caretColor: "var(--text-primary)",
  },
  ".cm-line": {
    padding: "0 1rem 0 0.75rem",
  },
  ".cm-gutters": {
    display: "flex",
    alignItems: "stretch",
    flexShrink: "0",
    position: "sticky",
    left: "0",
    zIndex: "2",
    padding: "0.75rem 0 1rem",
    backgroundColor: "var(--bg-primary)",
    color: "color-mix(in srgb, var(--text-secondary) 82%, transparent)",
    borderRight: "1px solid color-mix(in srgb, var(--border) 52%, transparent)",
  },
  ".cm-gutter": {
    display: "flex",
    flexDirection: "column",
    flexShrink: "0",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.25rem",
    padding: "0 0.6rem 0 0.75rem",
    textAlign: "right",
  },
  ".cm-foldGutter": {
    width: "1.15rem",
  },
  ".cm-foldGutter .cm-gutterElement": {
    width: "1.15rem",
    padding: "0",
    textAlign: "center",
    color: "color-mix(in srgb, var(--text-secondary) 58%, transparent)",
  },
  ".cm-activeLineGutter, .cm-activeLine, .cm-selectionLayer, .cm-content, .cm-line": {
    backgroundColor: "transparent",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, var(--bg-primary))",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text-primary)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

function createState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      themeExtension,
      syntaxHighlighting(customHighlight),
      languageExtension.value,
      EditorView.lineWrapping,
      EditorState.readOnly.of(props.readonly),
      EditorView.editable.of(!props.readonly),
      placeholderExtension(props.placeholder),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.docChanged) {
          return;
        }

        const value = update.state.doc.toString();

        if (value !== props.modelValue) {
          emit("update:modelValue", value);
        }
      }),
    ],
  });
}

function mountEditor() {
  if (!props.showGutter || !container.value) {
    return;
  }

  editorView = new EditorView({
    state: createState(props.modelValue),
    parent: container.value,
  });
}

function rebuildEditor() {
  if (!props.showGutter) {
    editorView?.destroy();
    editorView = null;
    return;
  }

  if (!editorView) {
    mountEditor();
    return;
  }

  editorView.setState(createState(props.modelValue));
}

onMounted(() => {
  mountEditor();
});

function updatePlainValue(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

function insertPlainTab(event: KeyboardEvent) {
  if (props.readonly) {
    return;
  }

  event.preventDefault();

  const target = event.target as HTMLTextAreaElement;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const value = target.value;
  const nextValue = `${value.slice(0, start)}  ${value.slice(end)}`;

  target.value = nextValue;
  target.selectionStart = start + 2;
  target.selectionEnd = start + 2;
  emit("update:modelValue", nextValue);
}

watch(
  () => props.modelValue,
  (value) => {
    if (!editorView) {
      return;
    }

    const currentValue = editorView.state.doc.toString();

    if (value === currentValue) {
      return;
    }

    editorView.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  },
);

watch(
  () => [props.language, props.placeholder, props.readonly, props.showGutter],
  () => {
    rebuildEditor();
  },
);

onUnmounted(() => {
  editorView?.destroy();
  editorView = null;
});
</script>

<template>
  <div
    v-if="showGutter"
    ref="container"
    class="code-editor h-full min-h-0 code-editor--with-gutter"
  />
  <textarea
    v-else-if="!readonly"
    class="plain-code-editor h-full min-h-0"
    :value="modelValue"
    :placeholder="placeholder"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    @input="updatePlainValue"
    @keydown.tab="insertPlainTab"
  />
  <textarea
    v-else
    class="plain-code-viewer h-full min-h-0"
    :value="modelValue"
    readonly
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    wrap="off"
  />
</template>

<style scoped>
.code-editor :deep(.cm-editor) {
  height: 100%;
}

.code-editor :deep(.cm-focused) {
  box-shadow: none;
}

.code-editor:not(.code-editor--with-gutter) :deep(.cm-line) {
  padding-left: 1rem !important;
}

.plain-code-editor,
.plain-code-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    "Liberation Mono",
    "Courier New",
    monospace;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  overflow: auto;
  padding: 0.75rem 1rem 1rem;
  tab-size: 2;
  white-space: pre;
}

.plain-code-editor {
  caret-color: var(--text-primary);
  resize: none;
}

.plain-code-editor::placeholder {
  color: color-mix(in srgb, var(--text-secondary) 72%, transparent);
}

.plain-code-viewer {
  caret-color: transparent;
  resize: none;
  user-select: text;
}
</style>
