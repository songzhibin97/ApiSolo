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
  "environment.collisionTitle": {
    "zh-CN": "有 {count} 个密钥值曾被两个环境共用",
    en: "{count} secret values were shared by two environments",
  },
  "environment.collisionConsequence": {
    "zh-CN":
      "这些环境名在升级前生成了相同的密钥标识，后保存的值覆盖了先保存的。被覆盖的那个值不在磁盘上，也没有备份，无法恢复——请在下面列出的每个环境里重新填写这个变量。ApiSolo 不会猜它是什么，也不会用空值顶替。",
    en: "Before the upgrade these environment names produced the same secret identifier, so whichever value was saved later overwrote the earlier one. The overwritten value is not on disk, is not backed up, and cannot be recovered — re-enter this variable in each environment listed below. ApiSolo does not guess what it was, and does not put an empty value in its place.",
  },
  "environment.collisionVariable": {
    "zh-CN": "变量 {name}",
    en: "Variable {name}",
  },
  "environment.collisionShared": {
    "zh-CN": "共用同一个格子的环境（磁盘上的项目目录名 / 环境文件名，可能与项目显示名不同）：",
    en: "Environments that shared one slot (project directory / environment file name on disk, which can differ from the project's display name):",
  },
  "environment.collisionDetectedAt": {
    "zh-CN": "发现于 {at}",
    en: "Detected at {at}",
  },
  "environment.collisionAck": {
    "zh-CN": "我已重填，不再提示",
    en: "I have re-entered it — stop showing this",
  },
  "environment.collisionAckTitle": {
    "zh-CN": "不再提示这次碰撞？",
    en: "Stop showing this collision?",
  },
  "environment.collisionAckConfirm": {
    "zh-CN": "这会删除 {variable} 的这条碰撞记录，无法撤销。ApiSolo 此后不会再提到这次碰撞。",
    en: "This deletes the collision record for {variable} and cannot be undone. ApiSolo will not mention this collision again.",
  },
  "environment.variables": {
    "zh-CN": "变量",
    en: "Variables",
  },
  "environment.nameNormalizedHint": {
    "zh-CN": "环境名会按大小写、空格与标点归一化成一个文件名，两种写法可能落到同一个环境上。",
    en: "Environment names are normalised — case, spaces and punctuation — into a single file name, so two spellings can land on the same environment.",
  },
  "response.networkTruncated": {
    "zh-CN": "响应体超过 {limit}，网络读取已在此处停止。剩余部分没有收到，ApiSolo 不会自动重取。",
    en: "The response body exceeded {limit}; the network read stopped there. The rest was never received, and ApiSolo will not fetch it automatically.",
  },
  "response.networkTruncatedBadge": {
    "zh-CN": "未收全",
    en: "Incomplete",
  },
  "body.fileSizeLimit": {
    "zh-CN": "单个文件上限 {limit}。",
    en: "Up to {limit} per file.",
  },
  "body.fileTooLarge": {
    "zh-CN": "「{name}」有 {size}，超过单个文件上限 {limit}，没有添加。",
    en: "\"{name}\" is {size}, over the {limit} per-file limit. It was not added.",
  },
  "response.copyBody": {
    "zh-CN": "复制",
    en: "Copy",
  },
  "response.copyFailed": {
    "zh-CN": "复制失败",
    en: "Copy failed",
  },
  "response.downloadBody": {
    "zh-CN": "下载",
    en: "Download",
  },
  "response.bodyScopeFull": {
    "zh-CN": "复制与下载给出完整正文（{count} 个字符）；上面的视图可能已格式化或已截断。",
    en: "Copy and download give the complete body ({count} characters); the view above may be formatted or cut short.",
  },
  "response.bodyScopeReceived": {
    "zh-CN": "复制与下载给出已接收的正文（{count} 个字符）；其余部分从未从网络读到。",
    en: "Copy and download give the part of the body that was received ({count} characters); the rest was never read from the network.",
  },
  "response.bodyScopeStored": {
    "zh-CN": "复制与下载给出 ApiSolo 手里的这份正文（{count} 个字符）。ApiSolo 无法确认它就是完整响应：只有直接从网络读到的正文才能被担保，而历史在保存时会把过长的正文截短。",
    en: "Copy and download give this body as ApiSolo holds it ({count} characters). ApiSolo cannot confirm it is the whole response: only a body read straight off the network can be vouched for, and history shortens long bodies when it saves them.",
  },
  "response.bodyScopeEmpty": {
    "zh-CN": "响应体为空，没有可复制或下载的内容。",
    en: "The response body is empty — there is nothing to copy or download.",
  },
  "response.binaryNoActions": {
    "zh-CN": "字节在到达界面之前已被这条说明替换，因此这里没有可复制或下载的内容。",
    en: "The bytes were replaced with this note before they reached the interface, so there is nothing here to copy or download.",
  },
  "sidebar.noProjectDescription": {
    "zh-CN": "还没有描述",
    en: "No description yet",
  },
  "request.saveNeedsProject": {
    "zh-CN": "还没有项目。保存下来的请求存放在项目里，先到「集合」面板新建一个项目，再保存这条请求。",
    en: "There is no project yet. A saved request lives inside a project, so create one first in the Collections panel — then save this request.",
  },
  "request.saveNeedsProjectAction": {
    "zh-CN": "打开集合面板",
    en: "Open the Collections panel",
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
