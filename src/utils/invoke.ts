import { recordConsoleEntry } from "../stores/console"

const DEV_API_URL = "http://127.0.0.1:3721/api"
const DEV_BRIDGE_TOKEN = import.meta.env.VITE_APISOLO_DEV_BRIDGE_TOKEN ?? ""

export type UnlistenFn = () => void | Promise<void>

export interface TauriEvent<T> {
  event: string
  id: number
  payload: T
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
    return tauriInvoke<T>(command, args)
  }

  let response: Response

  try {
    response = await fetch(`${DEV_API_URL}/${command}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ApiSolo-Dev-Token": DEV_BRIDGE_TOKEN,
      },
      body: JSON.stringify(args ?? {}),
    })
  } catch (error) {
    const message =
      `Browser mode could not reach the development bridge at ${DEV_API_URL}. ` +
      `Run "npm run dev:web" for the bridged frontend mode.`
    recordConsoleEntry("error", `[system] invoke ${command} failed: ${message}`, "system")
    throw new Error(message)
  }

  const payload = (await response.json()) as { ok: boolean; data?: T; error?: string }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Command failed: ${command}`)
  }

  return payload.data as T
}

export async function listen<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event")
    return tauriListen<T>(event, handler)
  }

  console.warn(`Event listening is unavailable in browser mode: ${event}`)
  return () => {}
}
