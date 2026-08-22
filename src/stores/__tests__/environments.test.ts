import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import i18n from "../../i18n"
import { useEnvironmentsStore } from "../environments"
import { useProjectsStore } from "../projects"
import type { SecretKeyCollision } from "../../types"

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Switching projects runs a watcher that awaits list_environments and then
 * load_environment, so two microtask ticks are not enough to reach the state
 * under test.
 */
async function settle() {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

/**
 * A promise the test resolves by hand. Every other mock here settles on the
 * next tick, which is the one ordering that cannot show what happens when an
 * answer arrives after the user has already moved on.
 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settleWith) => {
    resolve = settleWith
  })
  return { promise, resolve }
}

function lastCallFor(command: string) {
  const calls = invokeMock.mock.calls.filter(([name]) => name === command)
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined
}

function callCountFor(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command).length
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

describe("useEnvironmentsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
  })

  it("does not load a newly created unsaved environment", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return {
          name: "dev",
          variables: [{ key: "BASE_URL", value: "https://dev.example.com", secret: false }],
        }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await flushPromises()

    store.createEnvironment("local")
    await flushPromises()

    expect(store.activeEnv).toBe("local")
    expect(store.variables).toEqual([])
    expect(invokeMock.mock.calls.some(([command, args]) => command === "load_environment" && args?.name === "local")).toBe(false)
  })

  it("switches to an existing environment after creating a draft one without stale load errors", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return ["dev", "prod"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        if (args?.name === "dev") {
          return {
            name: "dev",
            variables: [{ key: "API_URL", value: "https://dev.example.com", secret: false }],
          }
        }

        if (args?.name === "prod") {
          return {
            name: "prod",
            variables: [{ key: "API_URL", value: "https://api.example.com", secret: false }],
          }
        }

        throw new Error(`missing environment file: ${String(args?.name)}`)
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await flushPromises()

    store.createEnvironment("local")
    await store.setActiveEnv("prod")
    await flushPromises()

    expect(invokeMock.mock.calls.some(([command, args]) => command === "load_environment" && args?.name === "local")).toBe(false)
    expect(store.activeEnv).toBe("prod")
    expect(store.variables).toEqual([
      { key: "API_URL", value: "https://api.example.com", secret: false },
    ])
  })

  // D03 invariant 19
  it("rejects a duplicate environment name and keeps the loaded variables", async () => {
    const loaded = [{ key: "API_URL", value: "https://dev.example.com", secret: false }]

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: loaded }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    expect(store.activeEnv).toBe("dev")
    expect(store.variables).toEqual(loaded)

    // Guards the key itself: a missing key makes t() return the key string,
    // and comparing t() against t() would pass either way.
    const duplicateMessage = i18n.global.t("errors.environmentAlreadyExists")
    expect(duplicateMessage).not.toBe("errors.environmentAlreadyExists")

    expect(() => store.createEnvironment("dev")).toThrow(duplicateMessage)

    // The rejection has to leave the table alone. Blanking it first was the
    // whole defect: the user reads empty as new and saves over the original.
    expect(store.variables).toEqual(loaded)
    expect(store.activeEnv).toBe("dev")
    expect(store.environments).toEqual(["dev"])
  })

  // D03 invariant 20
  it("clears pending draft names when the active project changes", async () => {
    const betaVariables = [{ key: "API_URL", value: "https://beta.example.com", secret: false }]

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return args?.project === "beta" ? ["local"] : []
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        if (args?.name === "local") {
          return { name: "local", variables: betaVariables }
        }

        throw new Error(`missing environment file: ${String(args?.name)}`)
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "alpha"

    const store = useEnvironmentsStore()
    await settle()

    store.createEnvironment("local")
    await settle()
    expect(store.variables).toEqual([])

    projectsStore.activeProject = "beta"
    await settle()

    // beta owns a real environment called "local". If the draft mark survived
    // the project switch, this one loads as an empty table and the next save
    // overwrites it.
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "load_environment" && args?.name === "local",
      ),
    ).toBe(true)
    expect(store.variables).toEqual(betaVariables)
  })

  it("ignores an environment list that arrives after the project changed", async () => {
    const alphaList = deferred<string[]>()

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return args?.project === "alpha" ? alphaList.promise : ["beta-env"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: args?.name, variables: [] }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "alpha"

    const store = useEnvironmentsStore()
    await settle()

    projectsStore.activeProject = "beta"
    await settle()

    // Without a request genuinely left in flight there is no ordering here to
    // get wrong, and the assertion below would hold for the wrong reason.
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "list_environments" && args?.project === "alpha",
      ),
    ).toBe(true)

    alphaList.resolve(["alpha-env"])
    await settle()

    expect(store.environments).toEqual(["beta-env"])
  })

  it("ignores environment variables that arrive after the project changed", async () => {
    const betaVariables = [{ key: "API_URL", value: "https://beta.example.com", secret: false }]
    const alphaEnvironment = deferred<{ name: string; variables: typeof betaVariables }>()

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return ["shared"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return args?.project === "alpha"
          ? alphaEnvironment.promise
          : { name: "shared", variables: betaVariables }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "alpha"

    const store = useEnvironmentsStore()
    await settle()

    projectsStore.activeProject = "beta"
    await settle()

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "load_environment" && args?.project === "alpha",
      ),
    ).toBe(true)
    expect(store.variables).toEqual(betaVariables)

    // Both projects have an environment called "shared". The slow one now
    // answers for a project nobody is looking at any more.
    alphaEnvironment.resolve({
      name: "shared",
      variables: [{ key: "API_URL", value: "https://alpha.example.com", secret: false }],
    })
    await settle()

    expect(store.variables).toEqual(betaVariables)
  })

  it("ignores environment variables that arrive after another environment was selected", async () => {
    const prodVariables = [{ key: "API_URL", value: "https://api.example.com", secret: false }]
    const devEnvironment = deferred<{ name: string; variables: typeof prodVariables }>()

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return ["dev", "prod"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return args?.name === "dev"
          ? devEnvironment.promise
          : { name: "prod", variables: prodVariables }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    // "dev" sorts first, so the opening load is the slow one and is still in
    // flight. Nothing has changed project here — this is one project's own
    // selection moving on.
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "load_environment" && args?.name === "dev",
      ),
    ).toBe(true)

    await store.setActiveEnv("prod")
    await settle()

    devEnvironment.resolve({
      name: "dev",
      variables: [{ key: "API_URL", value: "https://dev.example.com", secret: false }],
    })
    await settle()

    // Asserted together: the stale answer would restore both the variables and
    // the name they belong to, and splitting them into two assertions would
    // leave neither one proven to carry the case.
    expect({ activeEnv: store.activeEnv, variables: store.variables }).toEqual({
      activeEnv: "prod",
      variables: prodVariables,
    })
  })

  // D03 invariant 21
  it("marks only unsaved draft environments as create", async () => {
    let envList = ["dev"]

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return [...envList]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: args?.name, variables: [] }
      }

      if (command === "save_environment") {
        const saved = (args?.env as { name: string }).name
        if (!envList.includes(saved)) {
          envList = [...envList, saved]
        }
        return undefined
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    // An environment that came back from disk is an update, never a create.
    expect(store.activeEnv).toBe("dev")
    await store.saveEnvironment()
    expect(lastCallFor("save_environment")?.create).toBe(false)

    store.createEnvironment("local")
    await settle()

    // A name that has never been saved is the one case Rust may refuse on
    // conflict.
    await store.saveEnvironment()
    expect(lastCallFor("save_environment")?.create).toBe(true)
  })

  // D08 §1 (ii): loading an environment is one of the two moments that produce
  // a collision record, so the list is re-read right there.
  it("re-reads collision records exactly once after loading an environment", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: [] }
      }

      if (command === "get_secret_key_collisions") {
        return []
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    const before = callCountFor("get_secret_key_collisions")
    await store.loadEnvironment("dev")

    // Exactly one: the fetch rides on this load and nothing else runs here.
    expect(callCountFor("get_secret_key_collisions")).toBe(before + 1)
  })

  // D08 §1 (iii): saving is the other moment that produces a record.
  it("re-reads collision records after a successful save, beyond the reload's own fetch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: [] }
      }

      if (command === "get_secret_key_collisions") {
        return []
      }

      if (command === "save_environment") {
        return undefined
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    const before = callCountFor("get_secret_key_collisions")
    await store.saveEnvironment()

    // Two by construction, asserted exactly: the post-save loadEnvironments()
    // chains into loadEnvironment("dev"), which fetches once; the explicit
    // post-save fetch is the second. Dropping the explicit call leaves one.
    expect(callCountFor("get_secret_key_collisions")).toBe(before + 2)
  })

  // D08 §2: a failed collision read neither breaks the environment load nor
  // invents records — and never throws out of loadCollisions itself.
  it("keeps the environment load intact when the collision read fails", async () => {
    const loaded = [{ key: "API_URL", value: "https://dev.example.com", secret: false }]

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: loaded }
      }

      if (command === "get_secret_key_collisions") {
        throw new Error("maintenance file unreadable")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    // (iii) the read itself resolves rather than rejecting.
    await expect(store.loadCollisions()).resolves.toBeUndefined()

    // (i) the load still resolves and the variables still arrive.
    const env = await store.loadEnvironment("dev")
    expect(env).toEqual({ name: "dev", variables: loaded })
    expect(store.variables).toEqual(loaded)

    // (ii) no records were invented on the failure path.
    expect(store.collisions).toEqual([])
  })

  // D08 §6 (store side): acknowledging re-reads the list from disk instead of
  // splicing locally — the disk is the truth about what was deleted.
  it("acknowledges with the record's own key and re-reads the list from disk", async () => {
    let acknowledged = false

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: [] }
      }

      if (command === "get_secret_key_collisions") {
        return acknowledged ? [] : [collisionRecord()]
      }

      if (command === "acknowledge_secret_key_collision") {
        acknowledged = true
        return undefined
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    await store.loadCollisions()
    expect(store.collisions).toEqual([collisionRecord()])

    const before = callCountFor("get_secret_key_collisions")
    await store.acknowledgeCollision("my-api:__:dG9rZW4")

    expect(lastCallFor("acknowledge_secret_key_collision")).toEqual({
      legacyVaultKey: "my-api:__:dG9rZW4",
    })
    expect(callCountFor("get_secret_key_collisions")).toBe(before + 1)
    expect(store.collisions).toEqual([])
  })

  // D08 §7 (store side): the backend's words must survive the failure path.
  it("propagates a failed acknowledgement verbatim and keeps the record", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: [] }
      }

      if (command === "get_secret_key_collisions") {
        return [collisionRecord()]
      }

      if (command === "acknowledge_secret_key_collision") {
        throw new Error("vault maintenance file is locked")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()
    await store.loadCollisions()

    await expect(store.acknowledgeCollision("my-api:__:dG9rZW4")).rejects.toThrow(
      "vault maintenance file is locked",
    )
    expect(store.collisions).toEqual([collisionRecord()])
  })

  // D08 §10 (i)–(iv): a rejected draft must not stay in the list as a ghost.
  it("removes a rejected draft, moves the selection back to disk, and rethrows", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        if (args?.name === "dev") {
          return { name: "dev", variables: [] }
        }

        throw new Error(`missing environment file: ${String(args?.name)}`)
      }

      if (command === "get_secret_key_collisions") {
        return []
      }

      if (command === "save_environment") {
        throw new Error("Environment already exists: staging")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()

    store.createEnvironment("STAGING")
    await settle()
    expect(store.activeEnv).toBe("STAGING")

    const listCallsBefore = callCountFor("list_environments")

    // (iv) the backend's own words, not a substitute and not a silent success.
    await expect(store.saveEnvironment()).rejects.toThrow("Environment already exists: staging")
    await settle()

    // (i) the ghost is gone from the list.
    expect(store.environments).toEqual(["dev"])
    // (ii) the selection is back on something that exists on disk.
    expect(store.activeEnv).toBe("dev")
    // (iii) the list came from disk again, not from an in-memory filter.
    expect(callCountFor("list_environments")).toBe(listCallsBefore + 1)

    // The draft mark went with the ghost: loading that name now asks the
    // backend instead of short-circuiting into an empty draft table.
    await expect(store.loadEnvironment("STAGING")).rejects.toThrow(
      "missing environment file: STAGING",
    )
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === "load_environment" && args?.name === "STAGING",
      ),
    ).toBe(true)
  })

  // D08 §10 (v): a real environment's failed save must not shuffle the panel.
  it("does not roll back when a non-draft save fails", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return ["dev"]
      }

      if (command === "get_collection_tree") {
        return []
      }

      if (command === "load_environment") {
        return { name: "dev", variables: [] }
      }

      if (command === "get_secret_key_collisions") {
        return []
      }

      if (command === "save_environment") {
        throw new Error("disk full")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const projectsStore = useProjectsStore()
    projectsStore.activeProject = "demo"

    const store = useEnvironmentsStore()
    await settle()
    expect(store.activeEnv).toBe("dev")

    const listCallsBefore = callCountFor("list_environments")
    await expect(store.saveEnvironment()).rejects.toThrow("disk full")
    await settle()

    expect(callCountFor("list_environments")).toBe(listCallsBefore)
    expect(store.activeEnv).toBe("dev")
    expect(store.environments).toEqual(["dev"])
  })
})
