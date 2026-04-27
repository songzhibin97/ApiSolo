import { describe, expect, it } from "vitest"

import { shouldIgnoreEvent } from "../useKeyboard"

function makeTarget(overrides: Partial<{
  tagName: string
  isContentEditable: boolean
  closest: (selector: string) => unknown
}> = {}) {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: () => null,
    ...overrides,
  }
}

function makeEvent(target: ReturnType<typeof makeTarget>) {
  return { target } as unknown as Pick<KeyboardEvent, "target">
}

describe("shouldIgnoreEvent", () => {
  it("ignores native form controls", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "INPUT" })))).toBe(true)
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "TEXTAREA" })))).toBe(true)
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "SELECT" })))).toBe(true)
  })

  it("ignores contenteditable and CodeMirror targets", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ isContentEditable: true })))).toBe(true)
    expect(
      shouldIgnoreEvent({
        target: makeTarget({
          closest: (selector) => (selector === ".cm-editor" ? {} : null),
        }),
      } as unknown as Pick<KeyboardEvent, "target">),
    ).toBe(true)
  })

  it("allows shortcuts outside editables", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget()))).toBe(false)
  })
})
