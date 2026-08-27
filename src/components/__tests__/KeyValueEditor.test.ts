// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"

// Keys instead of prose, so an assertion here cannot be satisfied by whatever
// the message files happen to say today.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import KeyValueEditor from "../request/KeyValueEditor.vue"
import type { KeyValuePair } from "../../types"

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

function mountEditor(rows: KeyValuePair[]) {
  return mount(KeyValueEditor, { props: { modelValue: rows } })
}

/**
 * The value box of the row for `key`. The editor renders three text inputs per
 * row plus a trailing blank row, so picking by index alone would silently move
 * the moment a column is added.
 */
function valueBox(wrapper: ReturnType<typeof mountEditor>, key: string) {
  const row = wrapper
    .findAll("input[type=\"text\"]")
    .filter((input) => (input.element as HTMLInputElement).placeholder === "keyValue.key")
    .findIndex((input) => (input.element as HTMLInputElement).value === key)

  expect(row, `no row for ${key}`).toBeGreaterThanOrEqual(0)

  return wrapper
    .findAll("input[type=\"text\"]")
    .filter(
      (input) =>
        (input.element as HTMLInputElement).placeholder !== "keyValue.key" &&
        (input.element as HTMLInputElement).placeholder !== "keyValue.description",
    )[row]
}

function lastEmit(wrapper: ReturnType<typeof mountEditor>): KeyValuePair[] {
  const emitted = wrapper.emitted("update:modelValue")
  expect(emitted, "the editor emitted nothing").toBeDefined()
  return emitted![emitted!.length - 1][0] as KeyValuePair[]
}

/**
 * The editor is where both halves of the marker rule are visible at once: it
 * writes the rows and it is the only place that draws the "re-enter this"
 * signal. The two used to disagree with each other by construction — the write
 * path dropped the marker as soon as anything was typed, and the renderer asked
 * only whether the marker was set — so neither could be corrected without the
 * other going wrong in the opposite direction.
 */
describe("a row history blanked, typed into and emptied again", () => {
  const marked = [pair("apikey", "", { redacted: true }), pair("page", "1")]

  it("keeps the marker on the row it emits, both ways", async () => {
    const wrapper = mountEditor(marked)

    await valueBox(wrapper, "apikey").setValue("REAL")
    const filled = lastEmit(wrapper)
    expect(filled[0]).toEqual(expect.objectContaining({ key: "apikey", value: "REAL", redacted: true }))

    await wrapper.setProps({ modelValue: filled })
    await valueBox(wrapper, "apikey").setValue("")

    // MISSED GATE. Without the marker here the row is indistinguishable from a
    // parameter the user meant to leave blank, and the save goes out with an
    // empty credential in it.
    expect(lastEmit(wrapper)[0]).toEqual(
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
    )
  })

  it("stops flagging the box once it holds a value and flags it again when emptied", async () => {
    const wrapper = mountEditor(marked)

    expect(valueBox(wrapper, "apikey").classes()).toContain("border-amber-500")
    expect(valueBox(wrapper, "apikey").attributes("placeholder")).toBe("keyValue.redactedPlaceholder")

    await wrapper.setProps({ modelValue: [pair("apikey", "REAL", { redacted: true }), pair("page", "1")] })

    // FALSE SIGNAL. The marker outlives the value now, so a renderer reading it
    // alone would keep telling the user to re-enter a credential they have
    // already typed back in.
    expect(valueBox(wrapper, "apikey").classes()).not.toContain("border-amber-500")
    expect(valueBox(wrapper, "apikey").attributes("placeholder")).toBe("keyValue.value")

    await wrapper.setProps({ modelValue: [pair("apikey", "", { redacted: true }), pair("page", "1")] })

    expect(valueBox(wrapper, "apikey").classes()).toContain("border-amber-500")
  })

  it("never flags a row nothing blanked", () => {
    const wrapper = mountEditor(marked)

    expect(valueBox(wrapper, "page").classes()).not.toContain("border-amber-500")
    expect(valueBox(wrapper, "page").attributes("placeholder")).toBe("keyValue.value")
  })
})
