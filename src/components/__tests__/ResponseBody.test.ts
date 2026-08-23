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
