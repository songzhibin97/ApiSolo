import { defineStore } from "pinia"
import { ref, watch } from "vue"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { useProjectsStore } from "./projects"
import type { Environment, EnvVariable } from "../types"

export const useEnvironmentsStore = defineStore("environments", () => {
  const projectsStore = useProjectsStore()

  const environments = ref<string[]>([])
  const activeEnv = ref<string | null>(null)
  const variables = ref<EnvVariable[]>([])
  const pendingEnvironmentNames = new Set<string>()

  watch(activeEnv, async (nextEnv, previousEnv) => {
    if (!projectsStore.activeProject) {
      variables.value = []
      return
    }

    if (!nextEnv) {
      variables.value = []
      return
    }

    if (nextEnv === previousEnv && variables.value.length > 0) {
      return
    }

    await loadEnvironment(nextEnv)
  })

  watch(
    () => projectsStore.activeProject,
    async () => {
      await loadEnvironments()
    },
    { immediate: true },
  )

  async function loadEnvironments() {
    if (!projectsStore.activeProject) {
      environments.value = []
      activeEnv.value = null
      variables.value = []
      return
    }

    environments.value = await invoke<string[]>("list_environments", {
      project: projectsStore.activeProject,
    })

    if (activeEnv.value && environments.value.includes(activeEnv.value)) {
      await loadEnvironment(activeEnv.value)
      return
    }

    activeEnv.value = environments.value[0] ?? null
    if (!activeEnv.value) {
      variables.value = []
    }
  }

  async function loadEnvironment(name = activeEnv.value) {
    if (!projectsStore.activeProject || !name) {
      variables.value = []
      return null
    }

    if (pendingEnvironmentNames.has(name)) {
      activeEnv.value = name
      variables.value = []
      return null
    }

    const env = await invoke<Environment>("load_environment", {
      project: projectsStore.activeProject,
      name,
    })
    activeEnv.value = env.name
    variables.value = env.variables
    return env
  }

  async function saveEnvironment() {
    if (!projectsStore.activeProject || !activeEnv.value) {
      throw new Error(i18n.global.t("errors.noActiveEnvironment"))
    }

    const envName = activeEnv.value

    try {
      await invoke("save_environment", {
        project: projectsStore.activeProject,
        env: {
          name: envName,
          variables: variables.value,
        },
      })

      pendingEnvironmentNames.delete(envName)
      await loadEnvironments()
      recordConsoleEntry(
        "info",
        `[app] Environment saved: ${projectsStore.activeProject}/${envName}`,
        "app",
      )
    } catch (error) {
      recordConsoleEntry(
        "error",
        `[app] Failed to save environment ${envName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "app",
      )
      throw error
    }
  }

  async function deleteEnvironment(name = activeEnv.value) {
    if (!projectsStore.activeProject || !name) {
      return
    }

    await invoke("delete_environment", {
      project: projectsStore.activeProject,
      name,
    })

    const deletedName = name
    await loadEnvironments()
    if (activeEnv.value === deletedName && !environments.value.includes(deletedName)) {
      activeEnv.value = environments.value[0] ?? null
    }
  }

  async function setActiveEnv(name: string | null) {
    activeEnv.value = name
  }

  function createEnvironment(name: string) {
    const normalized = normalizeName(name)
    if (!normalized) {
      throw new Error(i18n.global.t("errors.environmentNameRequired"))
    }

    if (!environments.value.includes(normalized)) {
      environments.value = [...environments.value, normalized].sort((left, right) =>
        left.localeCompare(right),
      )
    }

    pendingEnvironmentNames.add(normalized)
    activeEnv.value = normalized
    variables.value = []
  }

  function setVariables(nextVariables: EnvVariable[]) {
    variables.value = nextVariables
  }

  return {
    environments,
    activeEnv,
    variables,
    loadEnvironments,
    loadEnvironment,
    saveEnvironment,
    deleteEnvironment,
    setActiveEnv,
    createEnvironment,
    setVariables,
  }
})

function normalizeName(value: string) {
  return value.trim()
}
