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
import type { ResponseBodyKind } from "../../types"

function mountBody(props: { body: string; contentType: string; bodyKind?: ResponseBodyKind }) {
  return shallowMount(ResponseBody, { props })
}

const BINARY_NOTICE = "[data-testid=\"binary-body-notice\"]"

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
