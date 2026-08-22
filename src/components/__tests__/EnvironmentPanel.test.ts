// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

const { t } = vi.hoisted(() => ({
  t: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}))

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t }),
}))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import EnvironmentPanel from "../sidebar/EnvironmentPanel.vue"
import ConfirmDialog from "../ui/ConfirmDialog.vue"
import InlineError from "../ui/InlineError.vue"
import { useEnvironmentsStore } from "../../stores/environments"
import { useProjectsStore } from "../../stores/projects"
import type { SecretKeyCollision } from "../../types"

let pinia: ReturnType<typeof createPinia>

/**
 * Mount → onMounted → loadEnvironments → loadCollisions is a chain of awaits;
 * a couple of microtask ticks are not enough to reach the state under test.
 */
async function settle() {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

/**
 * The real wire shape (all four fields present, none null): the Rust structs
 * carry no Option and no skip_serializing_if, so this is what actually
 * arrives, not what a frontend-side declaration suggests.
 */
function collisionRecord(overrides: Partial<SecretKeyCollision> = {}): SecretKeyCollision {
  return {
    legacyVaultKey: "my-api:__:dG9rZW4",
    variableKey: "token",
    environments: [
      { project: "my-api", environment: "staging" },
      { project: "my-api", environment: "prod" },
    ],
    detectedAt: "2026-08-20T09:30:00+00:00",
    ...overrides,
  }
}

interface BackendOptions {
  collisions?: SecretKeyCollision[] | (() => SecretKeyCollision[])
  collisionsError?: string
  environments?: string[]
  saveError?: string
  acknowledgeError?: string
  onAcknowledge?: () => void
}

function stubBackend(options: BackendOptions = {}) {
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_environments") {
      return options.environments ?? []
    }

    if (command === "get_collection_tree") {
      return []
    }

    if (command === "load_environment") {
      return { name: args?.name, variables: [] }
    }

    if (command === "get_secret_key_collisions") {
      if (options.collisionsError) {
        throw new Error(options.collisionsError)
      }
      const value = options.collisions ?? []
      return typeof value === "function" ? value() : value
    }

    if (command === "acknowledge_secret_key_collision") {
      if (options.acknowledgeError) {
        throw new Error(options.acknowledgeError)
      }
      options.onAcknowledge?.()
      return undefined
    }

    if (command === "save_environment") {
      if (options.saveError) {
        throw new Error(options.saveError)
      }
      return undefined
    }

    throw new Error(`Unexpected invoke: ${command}`)
  })
}

function mountPanel() {
  // The same instance the test writes into — a second createPinia() here would
  // give the component a different store and quietly assert nothing.
  return mount(EnvironmentPanel, {
    global: {
      plugins: [pinia],
      stubs: { Eye: true, EyeOff: true, Lock: true, Plus: true, Trash2: true },
    },
  })
}

function collisionsCallCount() {
  return invokeMock.mock.calls.filter(([command]) => command === "get_secret_key_collisions")
    .length
}

/** The acknowledge dialog, told apart from the delete dialog by its title. */
function ackDialog(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper
    .findAllComponents(ConfirmDialog)
    .find((dialog) => dialog.props("title") === "environment.collisionAckTitle")
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  t.mockClear()
  invokeMock.mockReset()
})

// PROCESS.md P12: prove the harness can say both words before trusting its
// silence. Phase 1 is a correct assertion that must pass; phase 2 is the same
// assertion made wrong, which must fail on the value rather than because the
// mount blew up.
describe("harness self-check", () => {
  it("phase 1 — a correct assertion passes", async () => {
    stubBackend()
    const wrapper = mountPanel()
    await settle()

    // Category ④ (an injected t call) and category ② (a child prop): together
    // they prove the mount ran, pinia injected, and the spy heard it.
    expect(t).toHaveBeenCalledWith("environment.title")
    expect(wrapper.findComponent(ConfirmDialog).props("visible")).toBe(false)
  })

  it("phase 2 — the same assertion made wrong fails on the value", async () => {
    stubBackend()
    const wrapper = mountPanel()
    await settle()

    const visible = wrapper.findComponent(ConfirmDialog).props("visible")
    expect(() => expect(visible).toBe(true)).toThrow(/true/)
  })
})

describe("D08 §1 the records are read when the panel comes up", () => {
  it("reads the collision records exactly once on mount", async () => {
    stubBackend()
    mountPanel()
    await settle()

    // No project is active and no environment loads, so the mount hook is the
    // only reader — exactly one call, not "at least one".
    expect(collisionsCallCount()).toBe(1)
  })
})

describe("D08 §2 a failed read shows nothing and claims nothing", () => {
  it("renders no collision node and looks up no collision key", async () => {
    stubBackend({ collisionsError: "maintenance file unreadable" })
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="collision-section"]').exists()).toBe(false)
    // No positive "no collisions found" claim either: the panel cannot prove
    // that, so it must not say it — in any wording, i.e. via any key.
    expect(
      t.mock.calls.every(([key]) => !String(key).startsWith("environment.collision")),
    ).toBe(true)
  })
})

describe("D08 §3 every record and every environment is listed", () => {
  it("renders one entry per record and one line per shared environment", async () => {
    const second = collisionRecord({
      legacyVaultKey: "my-api:__:c2Vzc2lvbg",
      variableKey: "session",
      environments: [
        { project: "my-api", environment: "staging" },
        { project: "my-api", environment: "prod" },
        { project: "other-api", environment: "dev" },
      ],
      detectedAt: "2026-08-21T10:00:00+00:00",
    })
    stubBackend({ collisions: [collisionRecord(), second] })
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="collision-section"]').exists()).toBe(true)

    const records = wrapper.findAll('[data-testid="collision-record"]')
    expect(records).toHaveLength(2)
    // Listed one by one, not "and 2 more".
    expect(records[1].findAll('[data-testid="collision-environment"]')).toHaveLength(3)

    // The variable name and the detection time reach t() with the record's
    // own values, not with a neighbour's.
    expect(t).toHaveBeenCalledWith("environment.collisionVariable", { name: "token" })
    expect(t).toHaveBeenCalledWith("environment.collisionDetectedAt", {
      at: new Date("2026-08-20T09:30:00+00:00").toLocaleString(),
    })
  })

  it("shows the notice with no active project", async () => {
    // No project is selected anywhere in this test: the records are global,
    // carry their own project names, and missing one costs a credential.
    stubBackend({ collisions: [collisionRecord()] })
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="collision-section"]').exists()).toBe(true)
  })

  it("falls back to the vault key when the variable name did not decode", async () => {
    stubBackend({ collisions: [collisionRecord({ variableKey: "" })] })
    mountPanel()
    await settle()

    expect(t).toHaveBeenCalledWith("environment.collisionVariable", {
      name: "my-api:__:dG9rZW4",
    })
  })
})

describe("D08 §4 the notice states the consequence and what the names are", () => {
  it("looks up the consequence and the disk-name explanation", async () => {
    stubBackend({ collisions: [collisionRecord()] })
    mountPanel()
    await settle()

    expect(t).toHaveBeenCalledWith("environment.collisionConsequence")
    expect(t).toHaveBeenCalledWith("environment.collisionShared")
  })
})

describe("D08 §5 acknowledging asks first", () => {
  it("opens the confirmation dialog without touching the backend", async () => {
    stubBackend({ collisions: [collisionRecord()] })
    const wrapper = mountPanel()
    await settle()

    await wrapper.find('[data-testid="collision-ack"]').trigger("click")

    expect(ackDialog(wrapper)?.props("visible")).toBe(true)
    // The dialog's message names this record's variable.
    expect(t).toHaveBeenCalledWith("environment.collisionAckConfirm", { variable: "token" })
    // Nothing has been deleted yet.
    expect(
      invokeMock.mock.calls.some(([command]) => command === "acknowledge_secret_key_collision"),
    ).toBe(false)
  })
})

describe("D08 §6 confirming deletes the record and the list follows the disk", () => {
  it("acknowledges with the record's key, re-reads, and closes the dialog", async () => {
    const second = collisionRecord({
      legacyVaultKey: "my-api:__:c2Vzc2lvbg",
      variableKey: "session",
    })
    let acknowledged = false
    stubBackend({
      collisions: () => (acknowledged ? [second] : [collisionRecord(), second]),
      onAcknowledge: () => {
        acknowledged = true
      },
    })
    const wrapper = mountPanel()
    await settle()
    expect(wrapper.findAll('[data-testid="collision-record"]')).toHaveLength(2)

    // The first ack button belongs to the first record ("token").
    await wrapper.find('[data-testid="collision-ack"]').trigger("click")
    const dialog = ackDialog(wrapper)
    expect(dialog?.props("visible")).toBe(true)

    const before = collisionsCallCount()
    // ConfirmDialog renders cancel first, confirm second.
    await dialog!.findAll("button")[1].trigger("click")
    await settle()

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === "acknowledge_secret_key_collision" &&
          args?.legacyVaultKey === "my-api:__:dG9rZW4",
      ),
    ).toBe(true)
    // Re-read from disk, not spliced locally.
    expect(collisionsCallCount()).toBe(before + 1)
    expect(wrapper.findAll('[data-testid="collision-record"]')).toHaveLength(1)
    expect(ackDialog(wrapper)?.props("visible")).toBe(false)
  })
})

describe("D08 §7 a failed acknowledgement keeps the record and shows the reason", () => {
  it("keeps the dialog open with the backend's words and the record listed", async () => {
    stubBackend({
      collisions: [collisionRecord()],
      acknowledgeError: "vault maintenance file is locked",
    })
    const wrapper = mountPanel()
    await settle()

    await wrapper.find('[data-testid="collision-ack"]').trigger("click")
    const dialog = ackDialog(wrapper)
    await dialog!.findAll("button")[1].trigger("click")
    await settle()

    expect(dialog!.props("visible")).toBe(true)
    expect(dialog!.props("errorMessage")).toBe("vault maintenance file is locked")
    expect(wrapper.findAll('[data-testid="collision-record"]')).toHaveLength(1)
  })
})

describe("D08 §8 no records, no collision nodes", () => {
  it("renders nothing collision-related over an empty table", async () => {
    stubBackend({ collisions: [] })
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="collision-section"]').exists()).toBe(false)
    // Not even a positive "none found" line: every collision key stayed cold.
    expect(
      t.mock.calls.every(([key]) => !String(key).startsWith("environment.collision")),
    ).toBe(true)
  })
})

describe("D08 §10 a rejected draft's reason is visible on the panel", () => {
  it("passes the backend's words to InlineError", async () => {
    stubBackend({
      environments: ["dev"],
      saveError: "Environment already exists: staging",
    })
    const projects = useProjectsStore()
    projects.activeProject = "demo"
    const wrapper = mountPanel()
    await settle()

    const environmentsStore = useEnvironmentsStore()
    environmentsStore.createEnvironment("STAGING")
    await settle()

    await wrapper.find('[data-testid="environment-save"]').trigger("click")
    await settle()

    expect(wrapper.findComponent(InlineError).props("message")).toBe(
      "Environment already exists: staging",
    )
  })
})
