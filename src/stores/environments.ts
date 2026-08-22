import { defineStore } from "pinia"
import { ref, watch } from "vue"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { useProjectsStore } from "./projects"
import type { Environment, EnvVariable, SecretKeyCollision } from "../types"

export const useEnvironmentsStore = defineStore("environments", () => {
  const projectsStore = useProjectsStore()

  const environments = ref<string[]>([])
  const activeEnv = ref<string | null>(null)
  const variables = ref<EnvVariable[]>([])
  const collisions = ref<SecretKeyCollision[]>([])
  const pendingEnvironmentNames = new Set<string>()

  /**
   * Never throws. This fetch is not a user action: it piggybacks on mounting
   * the panel, loading an environment and saving one, and letting it reject
   * would fail those actions for a reason that has nothing to do with them.
   * On failure the panel simply shows no collision notice — and no "no
   * collisions" claim either, because an unread file proves nothing.
   */
  async function loadCollisions() {
    try {
      collisions.value = await invoke<SecretKeyCollision[]>("get_secret_key_collisions")
    } catch (error) {
      recordConsoleEntry(
        "error",
        `[app] Failed to read secret key collisions: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "app",
      )
    }
  }

  /**
   * Throws: this one is a user action, and the backend's own words must reach
   * the confirmation dialog. On success the list is re-fetched rather than
   * spliced locally — the disk is the truth, and removing the row in memory
   * would show a success the write-back may not have delivered.
   */
  async function acknowledgeCollision(legacyVaultKey: string) {
    await invoke("acknowledge_secret_key_collision", { legacyVaultKey })
    await loadCollisions()
  }

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
      // Draft names belong to the project they were typed in. Carrying them
      // across makes a same-named environment in the next project load as
      // empty, which is the second way a real environment used to get
      // overwritten by a table the user believed was blank.
      pendingEnvironmentNames.clear()
      await loadEnvironments()
    },
    { immediate: true },
  )

  async function loadEnvironments() {
    // The project this round belongs to, captured before the await. Switching
    // projects does not cancel a request already in flight, so without this the
    // slower answer wins on arrival: the previous project's list replaces the
    // current one, and a name the two happen to share then loads the wrong
    // project's variables over the real ones.
    const project = projectsStore.activeProject
    if (!project) {
      environments.value = []
      activeEnv.value = null
      variables.value = []
      return
    }

    const names = await invoke<string[]>("list_environments", { project })
    if (projectsStore.activeProject !== project) {
      return
    }

    environments.value = names

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
    const project = projectsStore.activeProject
    if (!project || !name) {
      variables.value = []
      return null
    }

    if (pendingEnvironmentNames.has(name)) {
      activeEnv.value = name
      variables.value = []
      return null
    }

    const env = await invoke<Environment>("load_environment", { project, name })
    // Two ways to have moved on, and the project is only one of them. Picking
    // another environment inside the same project does not cancel this request
    // either, so a slow answer for A landing after B is on screen would put A's
    // variables back and rename the selection to A with them.
    if (projectsStore.activeProject !== project || activeEnv.value !== name) {
      return null
    }

    activeEnv.value = env.name
    variables.value = env.variables
    // After the staleness check on purpose: loading an environment is one of
    // the two moments that produce a collision record, so the list is
    // re-fetched here — but only for a load the user is still looking at.
    await loadCollisions()
    return env
  }

  async function saveEnvironment() {
    if (!projectsStore.activeProject || !activeEnv.value) {
      throw new Error(i18n.global.t("errors.noActiveEnvironment"))
    }

    const envName = activeEnv.value
    // The only source of truth for "this name has never been saved". Rust
    // needs the caller's intent to tell a first save from an update; guessing
    // from the file's existence is what it does without this flag, and that
    // guess is what lets a save land on someone else's environment.
    const isDraft = pendingEnvironmentNames.has(envName)

    try {
      await invoke("save_environment", {
        project: projectsStore.activeProject,
        env: {
          name: envName,
          variables: variables.value,
        },
        create: isDraft,
      })

      pendingEnvironmentNames.delete(envName)
      await loadEnvironments()
      // Saving is the other moment that produces a collision record. The
      // loadEnvironments() above usually re-fetches once already (via its
      // chained loadEnvironment), but that hop depends on the saved name
      // being selected and listed; this call is the one that does not.
      await loadCollisions()
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
      if (isDraft) {
        // A rejected draft must not stay in the list: it looks like a real
        // environment, loads as an empty table, and can never be saved. The
        // rows typed into that table go with it — the price of the honest
        // list, chosen over keeping a lying entry.
        pendingEnvironmentNames.delete(envName)
        try {
          // From disk, not an in-memory filter: loadEnvironments also moves
          // the selection back to something that really exists (or to none).
          await loadEnvironments()
        } catch (rollbackError) {
          // The rollback's own failure must not replace the save failure —
          // the user asked why the save failed, not what the cleanup hit.
          recordConsoleEntry(
            "error",
            `[app] Failed to reload environments after rejected draft ${envName}: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            "app",
          )
        }
      }
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

    // Ahead of the list edit, the draft mark and the blanking below, all of
    // which are what made this destructive: the table went empty, the user
    // read that as a new environment, and saving it wrote over the existing
    // one. Rust rejects the same collision, but only it knows how a name
    // normalises, so this check is the cheap exact-match half, not the ruling.
    if (environments.value.includes(normalized)) {
      throw new Error(i18n.global.t("errors.environmentAlreadyExists"))
    }

    environments.value = [...environments.value, normalized].sort((left, right) =>
      left.localeCompare(right),
    )

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
    collisions,
    loadEnvironments,
    loadEnvironment,
    loadCollisions,
    acknowledgeCollision,
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
