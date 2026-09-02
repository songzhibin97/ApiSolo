// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

const tMock = vi.fn((key: string, _params?: Record<string, unknown>) => key)

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: tMock }),
}))

import SaveFromHistory from "../sidebar/SaveFromHistory.vue"
import PendingRefillNotice from "../request/PendingRefillNotice.vue"
import InlineError from "../ui/InlineError.vue"
import { useProjectsStore } from "../../stores/projects"
import { useSaveGateStore } from "../../stores/save-gate"
import { REDACTION_SENTINEL } from "../../utils/redaction"
import { identityTuple, type PendingField } from "../../utils/pending-refill"
import type { CollectionNode, HistoryEntry, KeyValuePair } from "../../types"

let pinia: ReturnType<typeof createPinia>

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h-1",
    method: "POST",
    url: "https://api.example.com/users",
    status: 201,
    time: 42,
    size: 12,
    timestamp: "2026-03-27T10:00:00Z",
    contentType: "application/json",
    requestParams: [],
    requestHeaders: [pair("Accept", "*/*")],
    requestBodyType: "json",
    requestBodyContent: "{\"name\":\"alice\"}",
    requestBodyFormData: [],
    ...overrides,
  } as HistoryEntry
}

const redactedEntry = entry({
  requestHeaders: [pair("Authorization", REDACTION_SENTINEL)],
})

function folder(name: string, path: string, children: CollectionNode[] = []): CollectionNode {
  return { name, path, nodeType: "folder", children }
}

function mountDialog(source: HistoryEntry = entry()) {
  return shallowMount(SaveFromHistory, {
    props: { visible: true, entry: source },
    global: { plugins: [pinia] },
  })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  tMock.mockClear()
})

// PROCESS.md P12: prove the harness can say both words before trusting its
// silence. Phase 1 is a correct assertion that must pass; phase 2 is the same
// assertion made wrong, which must fail on the value rather than because the
// mount blew up.
describe("harness self-check", () => {
  it("phase 1 — a correct prop assertion passes", () => {
    expect(mountDialog().findComponent(InlineError).props("message")).toBe("")
  })

  it("phase 2 — the same assertion made wrong fails on the value", () => {
    const message = mountDialog().findComponent(InlineError).props("message")

    expect(() => expect(message).toBe("a message nothing produces")).toThrow(
      /a message nothing produces/,
    )
  })
})

describe("§3 the name starts from the entry and is what gets saved", () => {
  it("prefills a name derived from the entry", () => {
    const input = mountDialog().find("[data-testid=\"save-from-history-name\"]")

    expect((input.element as HTMLInputElement).value).toBe("POST users")
  })

  it("saves the name the user typed, not the prefilled one", async () => {
    const projects = useProjectsStore()
    const saveRequest = vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const wrapper = mountDialog()

    const input = wrapper.find("[data-testid=\"save-from-history-name\"]")
    await input.setValue("Create user")
    expect((input.element as HTMLInputElement).value).toBe("Create user")

    await wrapper.find("[data-testid=\"save-from-history-submit\"]").trigger("click")

    expect(saveRequest).toHaveBeenCalledTimes(1)
    expect(saveRequest.mock.calls[0][1].name).toBe("Create user")
  })

  it("refuses to submit a name that is only whitespace", async () => {
    const wrapper = mountDialog()
    const submit = wrapper.find("[data-testid=\"save-from-history-submit\"]")

    await wrapper.find("[data-testid=\"save-from-history-name\"]").setValue("   ")

    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("§4 every collection in the project is a possible destination", () => {
  it("offers the root plus every folder, nested ones included", () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    projects.collectionTree = [
      folder("Users", "users", [folder("Admin", "users/admin")]),
      folder("Orders", "orders"),
      { name: "Ping", path: "ping.request.json", nodeType: "request", children: [] },
    ]

    const options = mountDialog().findAll("[data-testid=\"save-from-history-collection\"] option")

    // root + Users + Users/Admin + Orders. The request node is not a destination.
    expect(options).toHaveLength(4)
  })

  it("keeps the root collection among the options", () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    projects.collectionTree = [folder("Users", "users")]

    const values = mountDialog()
      .findAll("[data-testid=\"save-from-history-collection\"] option")
      .map((option) => (option.element as HTMLOptionElement).value)

    expect(values).toContain("")
  })
})

describe("§10 the list of pending fields is complete, and says how many there are", () => {
  const thirty: PendingField[] = Array.from({ length: 30 }, (_unused, index) => ({
    kind: "refill",
    source: "header",
    name: `X-Field-${index}`,
  }))

  it("renders every field rather than the first few", () => {
    const wrapper = mount(PendingRefillNotice, {
      props: { fields: thirty },
      global: { plugins: [pinia] },
    })

    expect(wrapper.findAll("li")).toHaveLength(30)
  })

  it("tells the translator the real count", () => {
    mount(PendingRefillNotice, { props: { fields: thirty }, global: { plugins: [pinia] } })

    expect(tMock).toHaveBeenCalledWith("history.refillTitle", 30)
  })
})

describe("§11 the confirmation is what unlocks the save", () => {
  it("holds the submit button shut while the fields are unacknowledged", () => {
    const wrapper = mountDialog(redactedEntry)

    const submit = wrapper.find("[data-testid=\"save-from-history-submit\"]")
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
  })

  it("opens it once they are acknowledged, and then saves", async () => {
    const projects = useProjectsStore()
    const saveRequest = vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const gate = useSaveGateStore()
    const wrapper = mountDialog(redactedEntry)

    gate.acknowledge(wrapper.findComponent(PendingRefillNotice).props("fields"))
    await wrapper.vm.$nextTick()

    const submit = wrapper.find("[data-testid=\"save-from-history-submit\"]")
    expect((submit.element as HTMLButtonElement).disabled).toBe(false)

    await submit.trigger("click")
    expect(saveRequest).toHaveBeenCalledTimes(1)
  })
})

describe("§12 the confirmation appears exactly when there is something to confirm", () => {
  it("shows neither a list nor a checkbox when nothing is pending", () => {
    const wrapper = mount(PendingRefillNotice, {
      props: { fields: [] },
      global: { plugins: [pinia] },
    })

    expect(wrapper.find("[data-testid=\"refill-acknowledge\"]").exists()).toBe(false)
    expect(wrapper.findAll("li")).toHaveLength(0)
  })

  // A dropped upload is not something a user can type back in, but it is still
  // something they have to be told about before the request lands in a
  // collection unable to be sent.
  it("still asks for confirmation when only files need re-picking", () => {
    const wrapper = mount(PendingRefillNotice, {
      props: {
        fields: [{ kind: "reselect-file", source: "file", name: "avatar" }],
      },
      global: { plugins: [pinia] },
    })

    expect(wrapper.find("[data-testid=\"refill-acknowledge\"]").exists()).toBe(true)
    expect(tMock).toHaveBeenCalledWith("history.reselectFileTitle", 1)
    expect(tMock).not.toHaveBeenCalledWith("history.refillTitle", expect.anything())
  })
})

describe("§16 a failed save says so and stays open", () => {
  // Asserted as the absent `close` event rather than as a still-rendered
  // dialog: `visible` is a prop, so in isolation the dialog stays on screen
  // whether or not it asked to be closed, and the assertion would hold for a
  // component that closes on failure.
  it("does not ask to be closed after a rejection", async () => {
    const projects = useProjectsStore()
    vi.spyOn(projects, "saveRequest").mockRejectedValue(new Error("Request with the same name already exists"))
    const wrapper = mountDialog()

    await wrapper.find("[data-testid=\"save-from-history-submit\"]").trigger("click")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("close")).toBeUndefined()
  })

  it("does ask to be closed when the save succeeded", async () => {
    const projects = useProjectsStore()
    vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const wrapper = mountDialog()

    await wrapper.find("[data-testid=\"save-from-history-submit\"]").trigger("click")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("close")).toHaveLength(1)
  })

  it("hands the failure through verbatim rather than a message of its own", async () => {
    const projects = useProjectsStore()
    vi.spyOn(projects, "saveRequest").mockRejectedValue(
      new Error("Request with the same name already exists"),
    )
    const wrapper = mountDialog()

    await wrapper.find("[data-testid=\"save-from-history-submit\"]").trigger("click")
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(InlineError).props("message")).toBe(
      "Request with the same name already exists",
    )
  })
})

describe("§6 the two save entry points share one list and one acknowledgement", () => {
  it("D17 blocks a legacy URL-only redacted parameter with a non-empty list", () => {
    const legacy = entry({
      url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
      requestParams: undefined,
    })
    const wrapper = mountDialog(legacy)
    const fields = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]

    expect(fields.map(identityTuple)).toEqual([["refill", "query", null, "apikey"]])
    expect(
      (wrapper.find('[data-testid="save-from-history-submit"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("reads as acknowledged after the other entry point confirmed the same fields", async () => {
    const gate = useSaveGateStore()
    const wrapper = mountDialog(redactedEntry)
    const fields = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]

    // Whichever entry point did this, the answer belongs to the request.
    gate.acknowledge(fields)

    expect(gate.blocksSave(fields)).toBe(false)
    const notice = mount(PendingRefillNotice, { props: { fields }, global: { plugins: [pinia] } })
    expect(
      (notice.find("[data-testid=\"refill-acknowledge\"]").element as HTMLInputElement).checked,
    ).toBe(true)
  })

  // Acknowledging one request must not wave a different one through: that is
  // the silent blank save this gate exists to stop.
  it("does not carry the acknowledgement over to a different request", () => {
    const gate = useSaveGateStore()
    gate.acknowledge([{ kind: "refill", source: "header", name: "Authorization" }])

    expect(
      gate.blocksSave([
        { kind: "refill", source: "auth", slot: "bearer-token", name: "" },
      ]),
    ).toBe(true)
  })
})
