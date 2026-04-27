import { describe, expect, it } from "vitest"
import { resolveTemplate } from "../resolve-template"
import type { EnvVariable } from "../../types"

describe("resolveTemplate", () => {
  it("replaces known variables", () => {
    const variables: EnvVariable[] = [
      { key: "baseUrl", value: "http://localhost:3000", secret: false },
      { key: "apiKey", value: "abc123", secret: false },
    ]

    expect(resolveTemplate("{{baseUrl}}/api?key={{apiKey}}", variables)).toBe(
      "http://localhost:3000/api?key=abc123"
    )
  })

  it("leaves unknown variables unchanged", () => {
    expect(resolveTemplate("{{unknown}}/path", [])).toBe("{{unknown}}/path")
  })

  it("resolves $timestamp to a numeric string", () => {
    const result = resolveTemplate("ts={{$timestamp}}", [])
    const value = result.replace("ts=", "")
    expect(Number.isNaN(Number(value))).toBe(false)
    expect(Number(value)).toBeGreaterThan(1700000000)
  })
})
