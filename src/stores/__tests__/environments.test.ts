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
})
