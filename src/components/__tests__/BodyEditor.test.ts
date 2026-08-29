// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

const { t } = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }))

// Partial: only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t }),
}))

// §22 / 4.4-k observation point, option (a): the reader is a module-level
// export precisely so this spy can count calls. "No emit" alone cannot prove
// the file was never read — a precheck moved to after the read would also
// produce no emit — so the call count is the load-bearing observation.
const { readFileAsBase64Mock } = vi.hoisted(() => ({
  readFileAsBase64Mock: vi.fn(async (_file: File) => "QUJD"),
}))

vi.mock("../../utils/file-reader", () => ({
  readFileAsBase64: readFileAsBase64Mock,
}))

import BodyEditor from "../request/BodyEditor.vue"
import { MAX_UPLOAD_FILE_BYTES, formatBytesAsMib } from "../../utils/limits"
import type { PendingField } from "../../utils/pending-refill"
import type { FormDataItem, RequestBody } from "../../types"

function binaryBody(): RequestBody {
  return { type: "binary", content: "", formData: [], binaryPath: "", binaryContent: undefined }
}

function formDataBody(): RequestBody {
  const row: FormDataItem = {
    id: "row-1",
    enabled: true,
    key: "file1",
    value: "",
    description: "",
    valueType: "file",
    fileName: "",
    filePath: "",
    fileContent: "",
    contentType: "",
  }
  return { type: "form-data", content: "", formData: [row], binaryPath: "", binaryContent: undefined }
}

function mountEditor(modelValue: RequestBody) {
  return mount(BodyEditor, {
    props: { modelValue },
    global: { stubs: { CodeEditor: true, KeyValueEditor: true } },
  })
}

/** A File whose size is faked: the precheck reads `File.size`, never the bytes. */
function fakeFile(name: string, size: number): File {
  const file = new File(["x"], name)
  Object.defineProperty(file, "size", { value: size, configurable: true })
  return file
}

async function selectFile(wrapper: ReturnType<typeof mountEditor>, file: File) {
  const input = wrapper.find('input[type="file"]')
  expect(input.exists()).toBe(true)
  Object.defineProperty(input.element, "files", { value: [file], configurable: true })
  await input.trigger("change")
  await flushPromises()
}

const OVERSIZED = MAX_UPLOAD_FILE_BYTES + 1
const LIMIT_LABEL = formatBytesAsMib(MAX_UPLOAD_FILE_BYTES)

describe("D09 §22 the upload precheck refuses oversized files before reading them", () => {
  beforeEach(() => {
    t.mockClear()
    readFileAsBase64Mock.mockClear()
  })

  // PROCESS.md P12: the harness has to be shown capable of failing before its
  // green is worth anything (4.4-j).
  describe("harness self-check", () => {
    it("phase 1 — a correct call assertion passes", () => {
      mountEditor(binaryBody())

      expect(t.mock.calls.some(([key]) => key === "body.fileSizeLimit")).toBe(true)
    })

    it("phase 2 — the same assertion made wrong fails as an assertion mismatch", () => {
      mountEditor(binaryBody())

      const called = t.mock.calls.some(([key]) => key === "body.fileSizeLimit")
      let failure: unknown
      try {
        expect(called).toBe(false)
      } catch (error) {
        failure = error
      }
      // An assertion mismatch, not a mount crash or a missing translator.
      expect(String(failure)).toContain("expected true to be false")
    })
  })

  it("(i) U1: an oversized binary file is not added and is never read", async () => {
    const wrapper = mountEditor(binaryBody())

    await selectFile(wrapper, fakeFile("big.bin", OVERSIZED))

    expect(wrapper.emitted("update:modelValue")).toBeUndefined()
    expect(readFileAsBase64Mock).toHaveBeenCalledTimes(0)
  })

  it("(ii) U2: an oversized form-data file leaves the row untouched and unread", async () => {
    const wrapper = mountEditor(formDataBody())

    await selectFile(wrapper, fakeFile("big.pdf", OVERSIZED))

    expect(wrapper.emitted("update:modelValue")).toBeUndefined()
    expect(readFileAsBase64Mock).toHaveBeenCalledTimes(0)
  })

  it("(iii) U1: a file within the limit is read and added as before", async () => {
    const wrapper = mountEditor(binaryBody())

    await selectFile(wrapper, fakeFile("ok.bin", 1024))

    // 4.4-k: the non-zero call count here is what makes the zeroes above
    // evidence — a broken spy would also read zero.
    expect(readFileAsBase64Mock).toHaveBeenCalledTimes(1)
    const events = wrapper.emitted("update:modelValue")
    expect(events).toHaveLength(1)
    expect(events![0][0]).toMatchObject({ binaryPath: "ok.bin", binaryContent: "QUJD" })
  })

  it("(iii) U2: a form-data file within the limit is read and lands in the row", async () => {
    const wrapper = mountEditor(formDataBody())

    await selectFile(wrapper, fakeFile("ok.pdf", 1024))

    expect(readFileAsBase64Mock).toHaveBeenCalledTimes(1)
    const events = wrapper.emitted("update:modelValue")
    expect(events).toHaveLength(1)
    const body = events![0][0] as RequestBody
    expect(body.formData[0]).toMatchObject({ fileName: "ok.pdf", fileContent: "QUJD" })
  })

  it("(iv) a rejection explains itself with the name, the size and the limit", async () => {
    const wrapper = mountEditor(binaryBody())

    await selectFile(wrapper, fakeFile("big.bin", OVERSIZED))

    expect(t).toHaveBeenCalledWith("body.fileTooLarge", {
      name: "big.bin",
      size: formatBytesAsMib(OVERSIZED),
      limit: LIMIT_LABEL,
    })
  })

  it("(iv) the form-data rejection explains itself the same way", async () => {
    const wrapper = mountEditor(formDataBody())

    await selectFile(wrapper, fakeFile("big.pdf", OVERSIZED))

    expect(t).toHaveBeenCalledWith("body.fileTooLarge", {
      name: "big.pdf",
      size: formatBytesAsMib(OVERSIZED),
      limit: LIMIT_LABEL,
    })
  })

  it("(v) U1 states the limit before anything is rejected", () => {
    mountEditor(binaryBody())

    expect(t).toHaveBeenCalledWith("body.fileSizeLimit", { limit: LIMIT_LABEL })
  })

  it("(v) U2 states the limit next to the file row before anything is rejected", () => {
    mountEditor(formDataBody())

    expect(t).toHaveBeenCalledWith("body.fileSizeLimit", { limit: LIMIT_LABEL })
  })
})

function mountRowEditor(modelValue: RequestBody, pendingFields: PendingField[] = []) {
  return mount(BodyEditor, {
    props: { modelValue, pendingFields },
    global: { stubs: { CodeEditor: true } },
  })
}

function valueBoxByKey(wrapper: ReturnType<typeof mountRowEditor>, key: string) {
  const keyInputs = wrapper
    .findAll('input[type="text"]')
    .filter((input) => input.attributes("placeholder") === "keyValue.key")
  const row = keyInputs.findIndex((input) => (input.element as HTMLInputElement).value === key)
  expect(row, `no row for ${key}`).toBeGreaterThanOrEqual(0)

  return wrapper
    .findAll('input[type="text"]')
    .filter((input) => {
      const placeholder = input.attributes("placeholder")
      return placeholder === "keyValue.value" || placeholder === "keyValue.redactedPlaceholder"
    })[row]
}

describe("D17 §10-§12 pending body rows point to exactly one amber value box", () => {
  const pending = (segment: number): PendingField[] => [
    { kind: "refill", source: "body", name: "apikey", segment },
  ]

  it.each([
    ["literal sentinel", `page=1&apikey=[redacted]`],
    ["replay-cleared recorded field", "page=1&apikey="],
  ])("marks the urlencoded segment for a %s", (_name, content) => {
    const wrapper = mountRowEditor(
      { type: "form-urlencoded", content, formData: [], binaryPath: "" },
      pending(1),
    )

    expect(valueBoxByKey(wrapper, "apikey").classes()).toContain("border-amber-500")
    expect(valueBoxByKey(wrapper, "page").classes()).not.toContain("border-amber-500")
  })

  it("does not mark an unlisted empty urlencoded row", () => {
    const wrapper = mountRowEditor({
      type: "form-urlencoded",
      content: "page=1&apikey=",
      formData: [],
      binaryPath: "",
    })

    expect(valueBoxByKey(wrapper, "apikey").classes()).not.toContain("border-amber-500")
  })

  it("marks a pending form-data text row and leaves a clean sibling plain", () => {
    const wrapper = mountRowEditor({
      type: "form-data",
      content: "",
      formData: [
        {
          id: "token",
          enabled: true,
          key: "token",
          value: "",
          description: "",
          valueType: "text",
          redacted: true,
        },
        {
          id: "page",
          enabled: true,
          key: "page",
          value: "1",
          description: "",
          valueType: "text",
        },
      ],
      binaryPath: "",
    })

    expect(valueBoxByKey(wrapper, "token").classes()).toContain("border-amber-500")
    expect(valueBoxByKey(wrapper, "page").classes()).not.toContain("border-amber-500")
  })
})
