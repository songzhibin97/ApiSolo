import type { EnvVariable } from "../types"

export function resolveTemplate(template: string, variables: EnvVariable[]) {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey: string) => {
    const key = rawKey.trim()
    if (key === "$timestamp") {
      return String(Math.floor(Date.now() / 1000))
    }
    if (key === "$isoTimestamp") {
      return new Date().toISOString()
    }
    if (key === "$randomUUID") {
      return crypto.randomUUID()
    }

    return variables.find((item) => item.key === key)?.value ?? match
  })
}
