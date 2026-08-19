import { describe, expect, it } from "vitest"

import readmeEn from "../../README.md?raw"
import readmeZh from "../../README.zh-CN.md?raw"

/**
 * A text gate, not a behaviour gate. It can only prove the sentence is on disk;
 * it cannot prove anyone reads it. That is the whole job here — the decision in
 * §4 is a deliberate divergence between what is displayed and what is sent, and
 * an undocumented divergence gets rediscovered as a high-severity bug or
 * "fixed" by pasting the key back into the address bar.
 */
describe("§5 the query api key divergence is written down in both READMEs", () => {
  it("the English README states it", () => {
    expect(readmeEn).toContain(
      "appended to the query string only when the request is sent; it is deliberately not shown in the URL bar",
    )
  })

  it("the Chinese README states it", () => {
    expect(readmeZh).toContain("URL 栏不显示它，以免密钥出现在你可能复制或截图的地址里")
  })
})
