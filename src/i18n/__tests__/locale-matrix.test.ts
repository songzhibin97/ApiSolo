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
  "history.saveToCollection": {
    "zh-CN": "保存到集合",
    en: "Save to collection",
  },
  "history.saveNeedsProject": {
    "zh-CN": "先选择一个项目，集合保存在项目里。",
    en: "Select a project first — collections live inside a project.",
  },
  "history.refillTitle": {
    "zh-CN": "以下 {count} 个字段在历史中已脱敏，保存后为空，需要重新填写：",
    en: "These {count} fields were redacted in history and will be saved empty. They must be re-entered:",
  },
  "history.reselectFileTitle": {
    "zh-CN": "以下 {count} 个文件需要重新选择——历史不保存文件内容：",
    en: "These {count} files must be re-selected — history does not store file contents:",
  },
  "history.refillAck": {
    "zh-CN": "我知道保存下来的请求需要重填这些字段",
    en: "I understand the saved request needs these fields re-entered",
  },
  "history.deleteEntry": {
    "zh-CN": "删除这条记录",
    en: "Delete this entry",
  },
  "history.deleteConfirm": {
    "zh-CN": "删除 {method} {url} 这条历史记录？",
    en: "Delete the history entry for {method} {url}?",
  },
  "history.healthBadRows": {
    "zh-CN": "有 {count} 行历史记录无法解析，它们不会显示在列表里。清空历史仍然可用。",
    en: "{count} history lines cannot be parsed and are not shown in the list. Clear History still works.",
  },
  "history.note": {
    "zh-CN": "备注",
    en: "Note",
  },
  "history.notePlaceholder": {
    "zh-CN": "记点什么，例如这次为什么值得留着",
    en: "Note why this one is worth keeping",
  },
  "history.star": {
    "zh-CN": "收藏",
    en: "Star",
  },
  "history.unstar": {
    "zh-CN": "取消收藏",
    en: "Unstar",
  },
  "history.starredOnly": {
    "zh-CN": "只看收藏",
    en: "Starred only",
  },
  "history.clearWithStarred": {
    "zh-CN": "其中有 {starred} 条是收藏，将一并删除。",
    en: "This includes {starred} starred entries, which will be deleted as well.",
  },
  "response.binaryBody": {
    "zh-CN": "这是二进制响应体，不能作为文本显示。",
    en: "This is a binary response body and cannot be shown as text.",
  },
}

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: false as const,
  messages: { "zh-CN": zhCN, en },
})

const SOURCES = { "zh-CN": zhCN, en } as Record<string, unknown>

/**
 * Reads the message as authored, before interpolation. Going through `t()`
 * cannot check a sentence containing `{count}`: vue-i18n resolves a named
 * param that was not supplied to an empty string, so `t()` returns the
 * sentence with a hole in it and every placeholder key would have to assert
 * against text that is not what the spec table says.
 */
function rawMessage(locale: string, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
      SOURCES[locale],
    )
}

describe("§59 every key this slice touches matches the spec table word for word", () => {
  it.each(Object.entries(MATRIX))("%s reads as specified in both locales", (key, expected) => {
    for (const locale of ["zh-CN", "en"] as const) {
      expect(`${locale}: ${rawMessage(locale, key)}`).toBe(`${locale}: ${expected[locale]}`)
    }
  })

  it.each(Object.keys(MATRIX))("%s is reachable through the i18n runtime", (key) => {
    for (const locale of ["zh-CN", "en"] as const) {
      i18n.global.locale.value = locale
      expect(`${locale}: ${i18n.global.t(key)}`).not.toBe(`${locale}: ${key}`)
    }
  })
})
