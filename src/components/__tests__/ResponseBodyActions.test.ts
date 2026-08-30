// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"
import { createI18n } from "vue-i18n"

import ResponseBody from "../response/ResponseBody.vue"
import CodeEditor from "../editor/CodeEditor.vue"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"
import type { ResponseBodyKind, ResponseBodySource } from "../../types"

/**
 * Why this file sits next to `ResponseBody.test.ts` instead of inside it: that
 * file replaces `useI18n` with `t: key => key` for its whole module. Under that
 * stub every sentence renders as its own key, so "the note says the copy is
 * complete" and "the note says the copy is only what arrived" are the same
 * string and no mutation of that choice can be seen. A50 allows asserting
 * rendered text when the real catalog is loaded and what is load-bearing is the
 * wiring -- which of the sentences the component picked -- rather than the
 * wording, which the locale matrix owns.
 */
function i18nFor(locale: "en" | "zh-CN") {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: { "zh-CN": zhCN, en },
  })
}

/**
 * `bodySource` defaults to "network" only when the caller leaves the key out,
 * so a test can still pass it explicitly as `undefined` to mount the
 * "nobody told me where this came from" case — which is a different state
 * from "it came off the wire", and the one the panel must be most careful in.
 */
function mountBody(
  props: {
    body: string
    contentType: string
    bodyKind?: ResponseBodyKind
    bodyTruncated?: boolean
    bodySource?: ResponseBodySource
  },
  locale: "en" | "zh-CN" = "en",
) {
  return shallowMount(ResponseBody, {
    props: "bodySource" in props ? props : { ...props, bodySource: "network" as const },
    global: { plugins: [i18nFor(locale)] },
  })
}

const ACTIONS = "[data-testid=\"response-body-actions\"]"
const STATUS = "[data-testid=\"response-body-status\"]"
const COPY = "[data-testid=\"response-body-copy\"]"
const DOWNLOAD = "[data-testid=\"response-body-download\"]"
const RAW_VIEW = "[data-testid=\"response-view-raw\"]"
const BINARY_NOTICE = "[data-testid=\"binary-body-notice\"]"
const NO_ACTIONS = "[data-testid=\"binary-no-actions\"]"

const OVER_CAP = 500_001

let writeText: ReturnType<typeof vi.fn>

function installClipboard(value: unknown) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  })
}

/**
 * Queues one clipboard outcome per click. Each entry is a thunk so a rejected
 * promise is only created when the component is already awaiting it, which
 * keeps the rejection handled instead of surfacing as an unhandled one.
 */
function installClipboardSequence(outcomes: Array<() => Promise<void>>) {
  const queue = [...outcomes]

  installClipboard({
    writeText: vi.fn(() => (queue.shift() ?? (() => Promise.resolve()))()),
  })
}

/** Lets an already-settled clipboard write reach the rendered label. */
async function settle(wrapper: { vm: { $nextTick: () => Promise<unknown> } }) {
  await Promise.resolve()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve())
  installClipboard({ writeText })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("D32 the response body action bar", () => {
  // PROCESS.md P12: prove the harness can fail on a value before its green is
  // worth anything. Phase 2 must fail as a mismatch, not as a broken mount.
  describe("harness self-check", () => {
    it("phase 1 — a correct text assertion passes", () => {
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })

      expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
    })

    it("phase 2 — the same assertion made wrong fails on the value", () => {
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })
      const label = wrapper.find(COPY).text()

      expect(() => expect(label).toBe("a label nothing renders")).toThrow(
        /a label nothing renders/,
      )
    })
  })

  describe("copy hands over the body this app holds, not the view", () => {
    it("copies the complete body when the display cap cut the view short", async () => {
      const body = "z".repeat(OVER_CAP)
      const wrapper = mountBody({ body, contentType: "text/plain" })

      // The precondition the assertion below rests on: the editor is showing
      // strictly less than the body. Without it, "copied the body" and "copied
      // the view" would be the same string and the test would prove nothing.
      expect(wrapper.findComponent(CodeEditor).props("modelValue")).not.toBe(body)

      await wrapper.find(COPY).trigger("click")

      expect(writeText).toHaveBeenCalledWith(body)
    })

    it("copies the body as received, not the pretty-printed view", async () => {
      const body = "{\"role\":\"admin\"}"
      const wrapper = mountBody({ body, contentType: "application/json" })

      await wrapper.find(RAW_VIEW).trigger("click")
      expect(wrapper.findComponent(CodeEditor).props("modelValue")).not.toBe(body)

      await wrapper.find(COPY).trigger("click")

      expect(writeText).toHaveBeenCalledWith(body)
    })

    it("reports the copy as done once the clipboard accepted it", async () => {
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copied)
    })

    // A button that says "Copy" and leaves the clipboard untouched is the
    // interface claiming something it did not do.
    it("says the copy failed when there is no clipboard to write to", async () => {
      installClipboard(undefined)
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)
    })

    it("says the copy failed when the clipboard rejects the write", async () => {
      installClipboardSequence([() => Promise.reject(new Error("denied"))])
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)
    })

    it("writes nothing to the clipboard for an empty body", async () => {
      const wrapper = mountBody({ body: "", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")

      expect(writeText).not.toHaveBeenCalled()
    })
  })

  /**
   * The copy state says something about one particular attempt, so only the
   * newest attempt may write it. The four ways a stale write can arrive are
   * separated below because they are four distinct orderings, and the earlier
   * shape of this code — a counter advanced per response — covered only the
   * first three: two copies of the same body shared one value, so the first
   * attempt's late answer was still accepted as current.
   */
  describe("only the newest copy attempt may speak", () => {
    // Path 1: the response is replaced while "Copied" is on screen. The word
    // is about a body the panel is no longer showing.
    it("stops saying Copied once a different response arrives", async () => {
      const wrapper = mountBody({ body: "first body", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)
      expect(wrapper.find(COPY).text()).toBe(en.response.copied)

      await wrapper.setProps({ body: "second body" })

      expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
    })

    // Path 2: clearing the state on change does not cover this on its own — a
    // write already in flight resolves afterwards and would put the word back
    // over the new response.
    it("does not say Copied when the write lands after the response changed", async () => {
      let release: () => void = () => {}
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      installClipboardSequence([() => pending])

      const wrapper = mountBody({ body: "first body", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await wrapper.setProps({ body: "second body" })

      release()
      await pending
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
    })

    // Path 3: same ordering, other branch. A rejection landing late must not
    // stamp "Copy failed" onto a response whose copy was never attempted.
    it("does not say Copy failed when the rejection lands after the change", async () => {
      let reject: () => void = () => {}
      const pending = new Promise<void>((_resolve, rejectFn) => {
        reject = () => rejectFn(new Error("denied"))
      })
      installClipboardSequence([() => pending])

      const wrapper = mountBody({ body: "first body", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await wrapper.setProps({ body: "second body" })

      reject()
      await pending.catch(() => {})
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
    })

    // Path 4: no response change at all — two copies of the same body. The
    // clipboard holds that body, so reporting a failure here would tell the
    // user to try again over a clipboard that already has what they wanted.
    it("keeps the newest attempt's success when an earlier one is rejected late", async () => {
      let rejectFirst: () => void = () => {}
      const first = new Promise<void>((_resolve, rejectFn) => {
        rejectFirst = () => rejectFn(new Error("denied"))
      })
      installClipboardSequence([() => first, () => Promise.resolve()])

      const wrapper = mountBody({ body: "one body", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)
      expect(wrapper.find(COPY).text()).toBe(en.response.copied)

      rejectFirst()
      await first.catch(() => {})
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copied)
    })

    // Same path, mirrored: an earlier success landing late must not claim the
    // clipboard was written when the attempt the user is waiting on failed.
    it("keeps the newest attempt's failure when an earlier one succeeds late", async () => {
      let resolveFirst: () => void = () => {}
      const first = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
      installClipboardSequence([() => first, () => Promise.reject(new Error("denied"))])

      const wrapper = mountBody({ body: "one body", contentType: "text/plain" })

      await wrapper.find(COPY).trigger("click")
      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)
      expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)

      resolveFirst()
      await first
      await settle(wrapper)

      expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)
    })
  })

  describe("download writes the same bytes copy would give", () => {
    let blobs: Blob[]
    let anchors: { element: HTMLAnchorElement; click: ReturnType<typeof vi.fn> }[]
    let revokedUrls: string[]

    beforeEach(() => {
      blobs = []
      anchors = []

      vi.spyOn(URL, "createObjectURL").mockImplementation((source) => {
        blobs.push(source as Blob)
        return "blob:stub"
      })
      revokedUrls = []
      vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
        revokedUrls.push(url)
      })

      const createElement = document.createElement.bind(document)
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        const element = createElement(tag)

        if (tag === "a") {
          // Replaced rather than observed: happy-dom treats a real anchor
          // click as a navigation, which has nothing to do with what is under
          // test and takes the whole document with it.
          const click = vi.fn()
          ;(element as HTMLAnchorElement).click = click
          anchors.push({ element: element as HTMLAnchorElement, click })
        }

        return element
      }) as typeof document.createElement)
    })

    it("puts the complete body in the file even when the view was cut short", async () => {
      const body = "z".repeat(OVER_CAP)
      const wrapper = mountBody({ body, contentType: "text/plain" })

      expect(wrapper.findComponent(CodeEditor).props("modelValue")).not.toBe(body)

      await wrapper.find(DOWNLOAD).trigger("click")

      expect(blobs).toHaveLength(1)
      await expect(blobs[0].text()).resolves.toBe(body)
    })

    it("names the file from the clock and the content type", async () => {
      const wrapper = mountBody({
        body: "{\"ok\":true}",
        contentType: "application/json; charset=utf-8",
      })

      await wrapper.find(DOWNLOAD).trigger("click")

      expect(anchors).toHaveLength(1)
      expect(anchors[0].element.download).toMatch(/^response-\d{8}-\d{6}\.json$/)
    })

    // Building the blob and never clicking would be a button that does
    // nothing while looking exactly like one that works.
    it("actually triggers the anchor and releases the object url", async () => {
      const wrapper = mountBody({ body: "{\"ok\":true}", contentType: "application/json" })

      await wrapper.find(DOWNLOAD).trigger("click")

      expect(anchors[0].element.href).toBe("blob:stub")
      expect(anchors[0].click).toHaveBeenCalledTimes(1)
      expect(revokedUrls).toEqual(["blob:stub"])
    })

    it("downloads nothing for an empty body", async () => {
      const wrapper = mountBody({ body: "", contentType: "text/plain" })

      await wrapper.find(DOWNLOAD).trigger("click")

      expect(blobs).toHaveLength(0)
    })
  })

  describe("the note says which body the buttons hand over", () => {
    // Nothing is missing from the view here, so a permanent line on every
    // ordinary response would be noise. The buttons still carry the sentence.
    it("stays silent when the view already shows the whole body", () => {
      const wrapper = mountBody({ body: "hello", contentType: "text/plain" })

      expect(wrapper.find(STATUS).exists()).toBe(false)
      expect(wrapper.find(COPY).attributes("title")).toBe(
        "Copy and download give the complete body (5 characters); the view above may be formatted or cut short.",
      )
    })

    it("says the copy is complete when only the view was cut short", () => {
      const wrapper = mountBody({ body: "z".repeat(OVER_CAP), contentType: "text/plain" })

      expect(wrapper.find(STATUS).text()).toBe(
        "Copy and download give the complete body (500001 characters); the view above may be formatted or cut short.",
      )
    })

    // The body itself is partial here. Calling the copy "complete" would be
    // the interface promising bytes that were never read off the wire.
    it("says the copy is only what arrived when the network read stopped short", () => {
      const wrapper = mountBody({
        body: "partial",
        contentType: "text/plain",
        bodyTruncated: true,
      })

      expect(wrapper.find(STATUS).text()).toBe(
        "Copy and download give the part of the body that was received (7 characters); the rest was never read from the network.",
      )
    })

    // Both cuts at once. "Complete" would be wrong for the same reason as
    // above, and the display cap does not make it any more complete.
    it("still says only what arrived when both cuts fired", () => {
      const wrapper = mountBody({
        body: "z".repeat(OVER_CAP),
        contentType: "text/plain",
        bodyTruncated: true,
      })

      expect(wrapper.find(STATUS).text()).toBe(
        "Copy and download give the part of the body that was received (500001 characters); the rest was never read from the network.",
      )
    })

    it("carries the same distinction in the other locale", () => {
      const wrapper = mountBody(
        { body: "partial", contentType: "text/plain", bodyTruncated: true },
        "zh-CN",
      )

      expect(wrapper.find(STATUS).text()).toBe(
        "复制与下载给出已接收的正文（7 个字符）；其余部分从未从网络读到。",
      )
    })

    // History does not store long bodies whole -- `buildHistoryEntry` cuts them
    // and records that nowhere -- so a replayed body can be short of the real
    // response while every flag on it says otherwise. "Complete" is a claim
    // about provenance, and this body's provenance does not support it.
    it("refuses to call a replayed body complete", () => {
      const wrapper = mountBody({
        body: "{\"ok\":true}",
        contentType: "application/json",
        bodySource: "history",
      })

      expect(wrapper.find(STATUS).text()).toBe(
        "Copy and download give this body as ApiSolo holds it (11 characters). ApiSolo cannot confirm it is the whole response: only a body read straight off the network can be vouched for, and history shortens long bodies when it saves them.",
      )
      expect(wrapper.find(COPY).attributes("title")).toBe(wrapper.find(STATUS).text())
    })

    // The withheld claim has to be visible. A panel that quietly declines to
    // say "complete" looks exactly like one that said it.
    it("shows the note for a replayed body with nothing else going on", () => {
      const wrapper = mountBody({
        body: "plain text",
        contentType: "text/plain",
        bodySource: "history",
      })

      expect(wrapper.find(STATUS).exists()).toBe(true)
    })

    // Absence of an answer is not the answer "network".
    it("refuses to claim completeness when nobody said where the body came from", () => {
      const wrapper = mountBody({
        body: "plain text",
        contentType: "text/plain",
        bodySource: undefined,
      })

      expect(wrapper.find(STATUS).text()).toContain("cannot confirm it is the whole response")
      expect(wrapper.find(STATUS).text()).not.toContain("the complete body")
    })

    // Two reasons to doubt at once. The weaker claim has to win, or the
    // stronger one is being made on a body that fails its test.
    it("keeps the weaker claim when a replayed body was also network-truncated", () => {
      const wrapper = mountBody({
        body: "partial",
        contentType: "text/plain",
        bodyTruncated: true,
        bodySource: "history",
      })

      expect(wrapper.find(STATUS).text()).toContain("cannot confirm it is the whole response")
      // The stronger sentence must be gone, not merely joined.
      expect(wrapper.find(STATUS).text()).not.toContain("the rest was never read")
      // And the separate network notice still carries that fact.
      expect(wrapper.find("[data-testid=\"network-truncated-notice\"]").exists()).toBe(true)
    })

    // A binary row saved before ApiSolo recorded that distinction restores as
    // text, so it does get the buttons -- and what they hand over is the
    // marker. The panel cannot call that the complete response.
    it("refuses to call a legacy binary row's marker text complete", () => {
      const wrapper = mountBody({
        body: "[ApiSolo] Binary response not shown as text: 900 bytes, content-type: image/png",
        contentType: "image/png",
        bodyKind: "text",
        bodySource: "history",
      })

      expect(wrapper.find(ACTIONS).exists()).toBe(true)
      expect(wrapper.find(STATUS).text()).toContain("cannot confirm it is the whole response")
    })

    it("disables both buttons and says why when the body is empty", () => {
      const wrapper = mountBody({ body: "", contentType: "text/plain" })

      expect(wrapper.find(COPY).attributes("disabled")).toBeDefined()
      expect(wrapper.find(DOWNLOAD).attributes("disabled")).toBeDefined()
      expect(wrapper.find(COPY).attributes("title")).toBe(en.response.bodyScopeEmpty)
    })
  })

  // The bytes were replaced with a marker sentence upstream and never reached
  // the interface. Offering copy or download here would hand over that
  // sentence as though it were the response - the shape D16 removed from the
  // sidebar preview.
  describe("the binary path offers nothing it cannot deliver", () => {
    it("renders no action bar for a binary body", () => {
      const wrapper = mountBody({
        body: "[binary 900 bytes]",
        contentType: "image/png",
        bodyKind: "binary",
      })

      expect(wrapper.find(BINARY_NOTICE).exists()).toBe(true)
      expect(wrapper.find(ACTIONS).exists()).toBe(false)
    })

    it("says why there is nothing to copy or download", () => {
      const wrapper = mountBody({
        body: "[binary 900 bytes]",
        contentType: "image/png",
        bodyKind: "binary",
      })

      expect(wrapper.find(NO_ACTIONS).text()).toBe(en.response.binaryNoActions)
    })

    it("keeps that true for a binary body that is also network-truncated", () => {
      const wrapper = mountBody({
        body: "[binary 1024 bytes]",
        contentType: "application/octet-stream",
        bodyKind: "binary",
        bodyTruncated: true,
      })

      expect(wrapper.find(ACTIONS).exists()).toBe(false)
      expect(wrapper.find(NO_ACTIONS).exists()).toBe(true)
    })
  })

  // D29's fix reaches the buttons too: what is copied is the body, and the
  // body is what is on screen.
  describe("a JSON body that does not parse", () => {
    const BROKEN = "{\"ok\": tru"

    it("copies the broken body rather than the word null", async () => {
      const wrapper = mountBody({ body: BROKEN, contentType: "application/json" })

      await wrapper.find(COPY).trigger("click")

      expect(writeText).toHaveBeenCalledWith(BROKEN)
    })
  })

  describe("the character count counts code points", () => {
    // "😀" is one code point stored as two UTF-16 units. `body.length` says 2.
    it("counts an astral character once", () => {
      const wrapper = mountBody({ body: "😀", contentType: "text/plain", bodyTruncated: true })

      expect(wrapper.find(STATUS).text()).toContain("(1 characters)")
    })

    it("counts an ordinary character once as well", () => {
      const wrapper = mountBody({ body: "ab", contentType: "text/plain", bodyTruncated: true })

      expect(wrapper.find(STATUS).text()).toContain("(2 characters)")
    })
  })
})
