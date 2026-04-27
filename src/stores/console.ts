import { computed, ref } from "vue"
import { defineStore } from "pinia"

import pinia from "."

export type ConsoleLevel = "log" | "warn" | "error" | "info"
export type ConsoleSource = "app" | "script" | "network" | "system"

export interface ConsoleEntry {
  id: string
  level: ConsoleLevel
  message: string
  timestamp: string
  source?: ConsoleSource
}

const FRAMEWORK_NOISE_PREFIXES = ["[Vue warn]", "[vite]"]

let consoleInterceptorsInstalled = false

function normalizeMessage(input: unknown[]) {
  return input
    .map((item) => {
      if (typeof item === "string") {
        return item
      }

      if (item instanceof Error) {
        return item.stack || item.message
      }

      try {
        return JSON.stringify(item)
      } catch {
        return String(item)
      }
    })
    .join(" ")
    .trim()
}

function shouldCaptureConsoleMessage(message: string) {
  if (!message) {
    return false
  }

  return !FRAMEWORK_NOISE_PREFIXES.some((prefix) => message.startsWith(prefix))
}

export const useConsoleStore = defineStore("console", () => {
  const entries = ref<ConsoleEntry[]>([])
  const isOpen = ref(false)
  const maxEntries = ref(500)

  const errorCount = computed(
    () => entries.value.filter((entry) => entry.level === "error").length,
  )

  function pushEntry(level: ConsoleLevel, message: string, source: ConsoleSource = "app") {
    const trimmedMessage = message.trim()
    if (!trimmedMessage) {
      return
    }

    const nextEntry: ConsoleEntry = {
      id: crypto.randomUUID(),
      level,
      message: trimmedMessage,
      timestamp: new Date().toISOString(),
      source,
    }

    entries.value = [...entries.value, nextEntry].slice(-maxEntries.value)
  }

  function log(message: string, source?: ConsoleSource) {
    pushEntry("log", message, source)
  }

  function warn(message: string, source?: ConsoleSource) {
    pushEntry("warn", message, source)
  }

  function error(message: string, source?: ConsoleSource) {
    pushEntry("error", message, source)
  }

  function info(message: string, source?: ConsoleSource) {
    pushEntry("info", message, source)
  }

  function clear() {
    entries.value = []
  }

  function toggle(force?: boolean) {
    isOpen.value = typeof force === "boolean" ? force : !isOpen.value
  }

  return {
    entries,
    isOpen,
    maxEntries,
    errorCount,
    log,
    warn,
    error,
    info,
    clear,
    toggle,
  }
})

export function recordConsoleEntry(
  level: ConsoleLevel,
  message: string,
  source: ConsoleSource = "app",
) {
  useConsoleStore(pinia)[level](message, source)
}

export function initializeConsoleInterceptors() {
  if (consoleInterceptorsInstalled || typeof window === "undefined") {
    return
  }

  consoleInterceptorsInstalled = true

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args)
    const message = normalizeMessage(args)
    if (shouldCaptureConsoleMessage(message)) {
      recordConsoleEntry("log", message, "app")
    }
  }

  console.info = (...args: unknown[]) => {
    originalConsole.info(...args)
    const message = normalizeMessage(args)
    if (shouldCaptureConsoleMessage(message)) {
      recordConsoleEntry("info", message, "app")
    }
  }

  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args)
    const message = normalizeMessage(args)
    if (shouldCaptureConsoleMessage(message)) {
      recordConsoleEntry("warn", message, "app")
    }
  }

  console.error = (...args: unknown[]) => {
    originalConsole.error(...args)
    const message = normalizeMessage(args)
    if (shouldCaptureConsoleMessage(message)) {
      recordConsoleEntry("error", message, "app")
    }
  }
}
