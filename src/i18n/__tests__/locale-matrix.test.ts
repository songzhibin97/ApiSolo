import { describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"

import en from "../en"
import zhCN from "../zh-CN"

/**
 * Word-for-word copy, both languages, straight from the spec table.
 *
 * The two weaker shapes this replaces both pass on wrong text: asserting
 * `t(key) !== key` passes when the Chinese entry holds the English sentence,
 * and asserting "the placeholder is still there" passes when the sentence
 * around it says something else entirely.
 *
 * PR-A owns one key. The mechanism is the deliverable here; the remaining
 * nineteen arrive with the keys they describe.
 */
const MATRIX: Record<string, { "zh-CN": string; en: string }> = {
  "auth.queryKeyHidden": {
    "zh-CN": "API key 会在发送时追加到查询串；为避免密钥出现在地址栏，URL 栏不显示它。",
    en: "The API key is appended to the query string when the request is sent. It is not shown in the URL bar so the key does not appear in an address you might copy or screenshot.",
  },
}

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: false as const,
  messages: { "zh-CN": zhCN, en },
})

describe("§56 every key this slice touches matches the spec table word for word", () => {
  it.each(Object.entries(MATRIX))("%s reads as specified in both locales", (key, expected) => {
    for (const locale of ["zh-CN", "en"] as const) {
      i18n.global.locale.value = locale
      expect(`${locale}: ${i18n.global.t(key)}`).toBe(`${locale}: ${expected[locale]}`)
    }
  })
})
