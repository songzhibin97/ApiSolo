import { describe, expect, it } from "vitest"

import readme from "../../../README.md?raw"
import security from "../../../SECURITY.md?raw"
import en from "../en"
import zhCN from "../zh-CN"

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix]
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe("§39 locale parity", () => {
  it("zh-CN and en expose the same key set", () => {
    expect(flattenKeys(zhCN).sort()).toEqual(flattenKeys(en).sort())
  })

  it("states the actual history behaviour in the security notice", () => {
    expect(zhCN.history.securityNotice).toContain("按字段名脱敏")
    expect(zhCN.history.securityNotice).toContain("重新填写")
    expect(en.history.securityNotice).toContain("redacts by field name")
    expect(en.history.securityNotice).toContain("re-entered")
  })
})

describe("§35 documented boundaries", () => {
  it("readme and security doc state the field-name-only boundary", () => {
    for (const doc of [readme, security]) {
      expect(doc).toContain(
        "Redaction is driven by the field name only; credentials written under a non-sensitive field name — including the value of an ordinary header or param — are neither redacted nor marked, and are stored as-is.",
      )
      expect(doc).toContain("must be re-entered")
      expect(doc).toContain("pm.environment.get")
      expect(doc).toContain("subscription-key")
    }
  })
})
