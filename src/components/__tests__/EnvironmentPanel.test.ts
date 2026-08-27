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

import { createI18n } from "vue-i18n"
import { Lock, LockOpen } from "lucide-vue-next"

import EnvironmentPanel from "../sidebar/EnvironmentPanel.vue"
import ConfirmDialog from "../ui/ConfirmDialog.vue"
import InlineError from "../ui/InlineError.vue"
import { useEnvironmentsStore } from "../../stores/environments"
import { useProjectsStore } from "../../stores/projects"
import zhCN from "../../i18n/zh-CN"
import type { EnvVariable, SecretKeyCollision } from "../../types"

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
      stubs: { Eye: true, EyeOff: true, Lock: true, LockOpen: true, Plus: true, Trash2: true },
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
  // Back to the key-echo default: one test below (D13 §14, per A50) swaps in
  // the real zh-CN catalog, and mockClear alone does not undo an implementation.
  t.mockImplementation((key: string, _params?: Record<string, unknown>) => key)
  invokeMock.mockReset()
})

/**
 * A panel with an active project, a draft environment and the given variable
 * rows — entirely in memory. createEnvironment marks the name as a draft, so
 * the activeEnv watcher skips load_environment and nothing here touches the
 * (mocked) backend beyond the list read; setVariables is store-local state.
 */
async function mountWithVariables(vars: EnvVariable[]) {
  stubBackend()
  const projects = useProjectsStore()
  projects.activeProject = "demo"
  const wrapper = mountPanel()
  await settle()

  const environmentsStore = useEnvironmentsStore()
  environmentsStore.createEnvironment("draft-env")
  await settle()
  environmentsStore.setVariables(vars)
  await settle()

  return { wrapper, environmentsStore }
}

const TWO_VARS: EnvVariable[] = [
  { key: "base", value: "https://api.example.com", secret: false },
  { key: "token", value: "s3cr3t", secret: true },
]

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

describe("D13 §1 §2 every row carries its two buttons and the header its eye", () => {
  it("renders one secret toggle and one delete button per row, trailing empty row included", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    const rows = wrapper.findAll('[data-testid="variable-row"]')
    // Two variables plus the always-appended empty row.
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.findAll('[data-testid="secret-toggle"]')).toHaveLength(1)
      expect(row.findAll('[data-testid="delete-row"]')).toHaveLength(1)
    }
  })

  it("renders exactly one eye button, in the header", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    expect(wrapper.findAll('[data-testid="toggle-secret-visibility"]')).toHaveLength(1)
    expect(
      wrapper
        .find('[data-testid="variable-table-header"]')
        .find('[data-testid="toggle-secret-visibility"]')
        .exists(),
    ).toBe(true)
  })
})

describe("D13 §13 the header shows a section label, not the four column labels", () => {
  it("labels the section and renders no column-label spans", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    // The section label's wiring (category ④: an injected t call)…
    expect(t).toHaveBeenCalledWith("environment.variables")
    // …and the four old labels' shape gone: they were <span> children of the
    // header; the new header holds one label div and the eye button only.
    const header = wrapper.find('[data-testid="variable-table-header"]')
    expect(header.findAll("span")).toHaveLength(0)
    // keyValue.del was only ever the fourth column label; the delete button
    // uses keyValue.deleteRow, a different key.
    expect(t).not.toHaveBeenCalledWith("keyValue.del")
  })
})

describe("D13 §10 §11 §12 the controls say who they are", () => {
  it("the secret toggle's title and aria-label follow its state", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    const toggles = wrapper.findAll('[data-testid="secret-toggle"]')
    // Row 0 is not secret, row 1 is (TWO_VARS order).
    expect(toggles[0].attributes("title")).toBe("environment.visible")
    expect(toggles[0].attributes("aria-label")).toBe("environment.visible")
    expect(toggles[1].attributes("title")).toBe("environment.secret")
    expect(toggles[1].attributes("aria-label")).toBe("environment.secret")
  })

  it("the toggle's icon changes shape with the state, not only its colour", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    // Three rows: one secret (locked shape), two not (open shape) — the
    // trailing empty row is never secret.
    expect(wrapper.findAllComponents(Lock)).toHaveLength(1)
    expect(wrapper.findAllComponents(LockOpen)).toHaveLength(2)
  })

  it("the delete button keeps its wording on both properties", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    const del = wrapper.find('[data-testid="delete-row"]')
    expect(del.attributes("title")).toBe("keyValue.deleteRow")
    expect(del.attributes("aria-label")).toBe("keyValue.deleteRow")
  })

  it("the eye's aria-label flips between show and hide", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    const eye = wrapper.find('[data-testid="toggle-secret-visibility"]')
    expect(eye.attributes("aria-label")).toBe("environment.showSecretValues")
    await eye.trigger("click")
    expect(eye.attributes("aria-label")).toBe("environment.hideSecretValues")
  })
})

describe("D13 §9 the two inputs carry accessible names", () => {
  it("names the key and value inputs with the existing wordings", async () => {
    const { wrapper } = await mountWithVariables(TWO_VARS)

    expect(wrapper.find('[data-testid="variable-key"]').attributes("aria-label")).toBe(
      "keyValue.key",
    )
    expect(wrapper.find('[data-testid="variable-value"]').attributes("aria-label")).toBe(
      "keyValue.value",
    )
  })
})

describe("D13 §15 the relaid-out buttons still commit the same edits", () => {
  it("clicking the secret toggle flips only that row's secret flag", async () => {
    const { wrapper, environmentsStore } = await mountWithVariables(TWO_VARS)

    const spy = vi.spyOn(environmentsStore, "setVariables")
    // The secret row, so the flip goes true → false: a mutation that hardcodes
    // `secret: true` gives the same answer as a flip on a false row.
    await wrapper.findAll('[data-testid="secret-toggle"]')[1].trigger("click")

    expect(spy).toHaveBeenCalledWith([
      { key: "base", value: "https://api.example.com", secret: false },
      { key: "token", value: "s3cr3t", secret: false },
    ])
  })

  it("clicking delete removes exactly that row from the committed set", async () => {
    const { wrapper, environmentsStore } = await mountWithVariables(TWO_VARS)

    const spy = vi.spyOn(environmentsStore, "setVariables")
    await wrapper.findAll('[data-testid="delete-row"]')[0].trigger("click")

    expect(spy).toHaveBeenCalledWith([{ key: "token", value: "s3cr3t", secret: true }])
  })
})

describe("D13 §14 the ack button's wording still comes from its own key", () => {
  it("renders the collisionAck catalog entry on the button itself", async () => {
    // Real zh-CN catalog (A50): the confirm dialog binds the same key while
    // mounted, so a t-call assertion alone cannot see a rewired button label.
    // Asserting the button's rendered text against the catalog entry can —
    // the wording itself stays owned by the locale matrix.
    const realI18n = createI18n({
      legacy: false,
      locale: "zh-CN",
      fallbackLocale: false as const,
      messages: { "zh-CN": zhCN },
    })
    t.mockImplementation((key: string, params?: Record<string, unknown>) =>
      realI18n.global.t(key, params ?? {}),
    )

    stubBackend({ collisions: [collisionRecord()] })
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="collision-ack"]').text()).toBe(
      zhCN.environment.collisionAck,
    )
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
