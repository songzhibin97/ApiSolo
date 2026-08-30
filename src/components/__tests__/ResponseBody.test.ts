// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"

const tMock = vi.fn((key: string) => key)

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: tMock }),
}))

import ResponseBody from "../response/ResponseBody.vue"
import CodeEditor from "../editor/CodeEditor.vue"
import JsonTreeView from "../response/JsonTreeView.vue"
import { MAX_RESPONSE_WIRE_BYTES, formatBytesAsMib } from "../../utils/limits"
import type { ResponseBodyKind } from "../../types"

function mountBody(props: {
  body: string
  contentType: string
  bodyKind?: ResponseBodyKind
  bodyTruncated?: boolean
}) {
  return shallowMount(ResponseBody, { props })
}

const BINARY_NOTICE = "[data-testid=\"binary-body-notice\"]"
const NETWORK_NOTICE = "[data-testid=\"network-truncated-notice\"]"

describe("the response body view decides by the flag, not by the text", () => {
  beforeEach(() => {
    tMock.mockClear()
  })

  // PROCESS.md P12: the harness has to be shown capable of failing before its
  // green is worth anything.
  describe("harness self-check", () => {
    it("phase 1 — a correct existence assertion passes", () => {
      const wrapper = mountBody({ body: "plain", contentType: "text/plain" })

      expect(wrapper.findComponent(CodeEditor).exists()).toBe(true)
    })

    it("phase 2 — the same assertion made wrong fails on the value", () => {
      const wrapper = mountBody({ body: "plain", contentType: "text/plain" })

      const exists = wrapper.findComponent(CodeEditor).exists()
      expect(() => expect(exists).toBe(false)).toThrow()
    })
  })

  it("§58 renders the binary notice when the kind is binary", () => {
    const wrapper = mountBody({
      body: "[binary 900 bytes]",
      contentType: "image/png",
      bodyKind: "binary",
    })

    expect(wrapper.find(BINARY_NOTICE).exists()).toBe(true)
  })

  it("§58 renders neither the code editor nor the json tree for a binary body", () => {
    const wrapper = mountBody({
      body: "{\"looks\":\"like json\"}",
      contentType: "application/json",
      bodyKind: "binary",
    })

    expect(wrapper.findComponent(CodeEditor).exists()).toBe(false)
    expect(wrapper.findComponent(JsonTreeView).exists()).toBe(false)
  })

  // A server is free to declare text/plain and then send NUL bytes. Rust has
  // already made that call; deciding again from the content type here would
  // overrule it and put the bytes back into a text view.
  it("§58 trusts the flag over a text content type", () => {
    const wrapper = mountBody({
      body: "not really text",
      contentType: "text/plain",
      bodyKind: "binary",
    })

    expect(wrapper.find(BINARY_NOTICE).exists()).toBe(true)
    expect(wrapper.findComponent(CodeEditor).exists()).toBe(false)
  })

  it("§58 explains the binary body through the injected translator", () => {
    mountBody({ body: "x", contentType: "image/png", bodyKind: "binary" })

    expect(tMock).toHaveBeenCalledWith("response.binaryBody")
  })

  it("§58 leaves a text body on the text path", () => {
    const wrapper = mountBody({
      body: "hello",
      contentType: "text/plain",
      bodyKind: "text",
    })

    expect(wrapper.find(BINARY_NOTICE).exists()).toBe(false)
    expect(wrapper.findComponent(CodeEditor).exists()).toBe(true)
  })
})

describe("D09 §12-§15 the network truncation notice", () => {
  beforeEach(() => {
    tMock.mockClear()
  })

  it("§12 shows the notice when the body is network-truncated", () => {
    const wrapper = mountBody({
      body: "partial",
      contentType: "text/plain",
      bodyTruncated: true,
    })

    expect(wrapper.find(NETWORK_NOTICE).exists()).toBe(true)
  })

  it("§12 hides the notice when the body arrived in full", () => {
    const wrapper = mountBody({
      body: "complete",
      contentType: "text/plain",
      bodyTruncated: false,
    })

    expect(wrapper.find(NETWORK_NOTICE).exists()).toBe(false)
  })

  it("§12 keeps the notice out of the text handed to the editor", () => {
    // Concatenating it would pollute what the user copies out of the
    // read-only editor - the flaw the existing display-cut note already has,
    // deliberately not repeated here.
    const wrapper = mountBody({
      body: "partial",
      contentType: "text/plain",
      bodyTruncated: true,
    })

    expect(wrapper.findComponent(CodeEditor).props("modelValue")).toBe("partial")
  })

  it("§13 names the cap through the injected translator", () => {
    mountBody({
      body: "partial",
      contentType: "text/plain",
      bodyTruncated: true,
    })

    // The interpolated value is the formatted production constant, read from
    // the production module - not a retyped literal.
    expect(tMock).toHaveBeenCalledWith("response.networkTruncated", {
      limit: formatBytesAsMib(MAX_RESPONSE_WIRE_BYTES),
    })
  })

  it("§14 shows both notes when the display cut fires on a truncated body", () => {
    // Over the 500k display cap AND network-truncated: only showing one would
    // suggest scrolling reveals the rest.
    const wrapper = mountBody({
      body: "a".repeat(500_001),
      contentType: "text/plain",
      bodyTruncated: true,
    })

    expect(wrapper.find(NETWORK_NOTICE).exists()).toBe(true)
    // The display-cut note keeps its existing place inside the editor text.
    expect(wrapper.findComponent(CodeEditor).props("modelValue")).toContain(
      "response.largeBodyTruncated",
    )
    expect(tMock).toHaveBeenCalledWith("response.networkTruncated", {
      limit: formatBytesAsMib(MAX_RESPONSE_WIRE_BYTES),
    })
    expect(tMock).toHaveBeenCalledWith("response.largeBodyTruncated")
  })

  it("§15 shows binary and truncated together, neither hiding the other", () => {
    const wrapper = mountBody({
      body: "[binary 1024 bytes]",
      contentType: "application/octet-stream",
      bodyKind: "binary",
      bodyTruncated: true,
    })

    expect(wrapper.find(BINARY_NOTICE).exists()).toBe(true)
    expect(wrapper.find(NETWORK_NOTICE).exists()).toBe(true)
  })
})

describe("D15 large JSON display cap", () => {
  it("does not parse a complete JSON body once the display cap applies", () => {
    const body = JSON.stringify({ payload: "x".repeat(500_000) })
    expect(body.length).toBeGreaterThan(500_000)

    const parseSpy = vi.spyOn(JSON, "parse")
    try {
      const wrapper = mountBody({ body, contentType: "application/json" })

      expect(wrapper.findComponent(CodeEditor).props("modelValue")).toBe(
        `${body.slice(0, 500_000)}\n\nresponse.largeBodyTruncated`,
      )
      expect(wrapper.findComponent(JsonTreeView).exists()).toBe(false)
      expect(parseSpy.mock.calls.filter(([input]) => input === body)).toHaveLength(0)
    } finally {
      parseSpy.mockRestore()
    }
  })

  it("still parses a complete small JSON body for the tree view", () => {
    const body = '{"answer":42}'
    const parseSpy = vi.spyOn(JSON, "parse")
    try {
      const wrapper = mountBody({ body, contentType: "application/json" })

      expect(parseSpy.mock.calls.filter(([input]) => input === body)).toHaveLength(1)
      expect(wrapper.findComponent(JsonTreeView).props("data")).toEqual({ answer: 42 })
      expect(wrapper.findComponent(CodeEditor).exists()).toBe(false)
    } finally {
      parseSpy.mockRestore()
    }
  })
})

/**
 * D29, present on `5bf03f5` and user-visible there: a response declaring
 * application/json whose body does not parse had its text replaced on screen by
 * the four characters "null". `displayBody` consulted `viewType` but not
 * `parsedJsonState.isValid`, and `JSON.stringify(null)` returns "null" instead
 * of throwing, so the fallback meant to catch this never ran.
 *
 * The condition is an everyday one — a truncated payload, an error page sent
 * with the wrong content type, a backend emitting half a document — and it hid
 * the body at exactly the moment the raw text is what the user needs.
 */
describe("D29 a JSON body that does not parse is shown, not replaced", () => {
  const BROKEN = '{"ok": tru'

  it("shows the raw text of a broken JSON body", () => {
    const wrapper = mountBody({ body: BROKEN, contentType: "application/json" })

    expect(wrapper.findComponent(CodeEditor).props("modelValue")).toBe(BROKEN)
  })

  it("does not put the word null on screen in its place", () => {
    const wrapper = mountBody({ body: BROKEN, contentType: "application/json" })

    expect(wrapper.findComponent(CodeEditor).props("modelValue")).not.toBe("null")
  })

  // A body whose entire content is the JSON literal null is not a parse
  // failure and must still format as itself — otherwise the fix above would
  // amount to "never trust null", which is a different and wrong rule.
  it("still treats a body that really is the JSON literal null as valid JSON", () => {
    const wrapper = mountBody({ body: "null", contentType: "application/json" })

    expect(wrapper.findComponent(JsonTreeView).exists()).toBe(true)
    expect(wrapper.findComponent(JsonTreeView).props("data")).toBeNull()
  })

  // The neighbouring paths the fix must not disturb: a valid object still
  // pretty-prints, and a broken body under a non-JSON content type was already
  // correct and stays that way.
  it("still pretty-prints a body that does parse", () => {
    const wrapper = mountBody({ body: '{"answer":42}', contentType: "application/json" })

    // Tree view owns the valid case, so the raw view is reached by asking for
    // it rather than by breaking the body.
    expect(wrapper.findComponent(JsonTreeView).props("data")).toEqual({ answer: 42 })
  })

  it("leaves a broken body under a text content type alone", () => {
    const wrapper = mountBody({ body: BROKEN, contentType: "text/plain" })

    expect(wrapper.findComponent(CodeEditor).props("modelValue")).toBe(BROKEN)
  })
})
