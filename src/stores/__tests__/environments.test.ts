import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import { useEnvironmentsStore } from "../environments"
import { useProjectsStore } from "../projects"

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
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
})
