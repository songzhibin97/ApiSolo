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
    en: "This field was redacted in history and will be saved empty. It must be re-entered: | These {count} fields were redacted in history and will be saved empty. They must be re-entered:",
  },
  "history.reselectFileTitle": {
    "zh-CN": "以下 {count} 个文件需要重新选择——历史不保存文件内容：",
    en: "This file must be re-selected — history does not store file contents: | These {count} files must be re-selected — history does not store file contents:",
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
    en: "{count} history line cannot be parsed and is not shown in the list. Clear History still works. | {count} history lines cannot be parsed and are not shown in the list. Clear History still works.",
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
    en: "This includes {starred} starred entry, which will be deleted as well. | This includes {starred} starred entries, which will be deleted as well.",
  },
  "response.binaryBody": {
    "zh-CN": "这是二进制响应体，不能作为文本显示。",
    en: "This is a binary response body and cannot be shown as text.",
  },
  "environment.collisionTitle": {
    "zh-CN": "有 {count} 个密钥值曾被两个环境共用",
    en: "{count} secret value was shared by two environments | {count} secret values were shared by two environments",
  },
  "environment.collisionConsequence": {
    "zh-CN":
      "这些环境名在升级前生成了相同的密钥标识，后保存的值覆盖了先保存的。被覆盖的那个值不在磁盘上，也没有备份，无法恢复——请在共用过这个格子的每个环境里重新填写这个变量。ApiSolo 不会猜它是什么，也不会用空值顶替。",
    en: "Before the upgrade these environment names produced the same secret identifier, so whichever value was saved later overwrote the earlier one. The overwritten value is not on disk, is not backed up, and cannot be recovered — re-enter this variable in each environment that shared the slot. ApiSolo does not guess what it was, and does not put an empty value in its place.",
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
  "response.bodyCharacterCount": {
    "zh-CN": "{count} 个字符",
    en: "{count} character | {count} characters",
  },
  "response.bodyScopeFull": {
    "zh-CN": "复制与下载给出完整正文（{characters}）；显示的视图可能已格式化或已截断。",
    en: "Copy and download give the complete body ({characters}); the view on screen may be formatted or cut short.",
  },
  "response.bodyScopeReceived": {
    "zh-CN": "复制与下载给出已接收的正文（{characters}）；其余部分从未从网络读到。",
    en: "Copy and download give the part of the body that was received ({characters}); the rest was never read from the network.",
  },
  "response.bodyScopeStored": {
    "zh-CN": "复制与下载给出 ApiSolo 手里的这份正文（{characters}）。ApiSolo 无法确认它就是完整响应：只有直接从网络读到的正文才能被担保，而历史在保存时会把过长的正文截短。",
    en: "Copy and download give this body as ApiSolo holds it ({characters}). ApiSolo cannot confirm it is the whole response: only a body read straight off the network can be vouched for, and history shortens long bodies when it saves them.",
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

/** Every leaf of a catalog as `[dotted key, message]`, in source order. */
function flatten(node: unknown, prefix = ""): Array<[string, string]> {
  if (typeof node === "string") {
    return [[prefix, node]]
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  )
}

/**
 * D44: an English sentence that sets a noun beside a runtime count carries both
 * forms, split on vue-i18n's `|`, and the count goes in as the plural argument.
 * The raw matrix above cannot see this defect -- "{count} requests" is what it
 * is -- so these read the *rendered* sentence at one and at two.
 *
 * Chinese has no form to pick, so its row is one plain sentence. Three things
 * are asserted about it: the rendering at one equals the column; the rendering
 * at two equals the column with its single `1` (the count) swapped for `2`; and
 * the source carries no `|`. No catalog edit reddens the rendering at two on its
 * own, and which assertion it is redundant with depends on the edit. A wording
 * change (项 → 项目) reddens the rendering at one and at two while the source
 * check stays green, so for that edit it is redundant with the rendering at
 * one. A `|` that splits the sentence into two different halves reddens the
 * rendering at two and the source check while the rendering at one stays
 * green, so only for that edit is it redundant with the source check.
 * Identical halves (`X | X`) render whole at two and only the source check sees
 * them. It is kept because it pins the text the user sees at two, not the
 * character. For `response.items` the column is `项`, which carries no `1`, so
 * the `1` → `2` swap is an identity on that row and the renderings at one and
 * at two are held to the same text.
 *
 * `named` marks the one key whose placeholder is not `{count}`. vue-i18n reads
 * the choice from a named `count`/`n` or from the plural argument, nothing
 * else, so that call has to pass the number both ways.
 */
const COUNTED: Record<string, { one: string; many: string; "zh-CN": string; named?: string }> = {
  "response.bodyCharacterCount": {
    one: "1 character",
    many: "2 characters",
    "zh-CN": "1 个字符",
  },
  "response.items": {
    one: "item",
    many: "items",
    "zh-CN": "项",
  },
  "import.requestCount": {
    one: "Will import 1 request",
    many: "Will import 2 requests",
    "zh-CN": "将导入 1 个请求",
  },
  "history.legacySanitized": {
    one: "Removed plaintext credentials from 1 history entry.",
    many: "Removed plaintext credentials from 2 history entries.",
    "zh-CN": "已清理 1 条历史记录中的明文凭据。",
  },
  "history.clearConfirm": {
    one: "Clear 1 history entry? This action cannot be undone.",
    many: "Clear all 2 history entries? This action cannot be undone.",
    "zh-CN": "清除全部 1 条历史记录？此操作无法撤销。",
  },
  "history.clearWithStarred": {
    named: "starred",
    one: "This includes 1 starred entry, which will be deleted as well.",
    many: "This includes 2 starred entries, which will be deleted as well.",
    "zh-CN": "其中有 1 条是收藏，将一并删除。",
  },
  "history.refillTitle": {
    one: "This field was redacted in history and will be saved empty. It must be re-entered:",
    many: "These 2 fields were redacted in history and will be saved empty. They must be re-entered:",
    "zh-CN": "以下 1 个字段在历史中已脱敏，保存后为空，需要重新填写：",
  },
  "history.refillUnparseableBody": {
    one: "The request body is not valid JSON, so ApiSolo cannot tell whether the redacted field in it has been re-entered. Make the body valid JSON, or switch the body type, and this notice goes away.",
    many: "The request body is not valid JSON, so ApiSolo cannot tell whether the 2 redacted fields in it have been re-entered. Make the body valid JSON, or switch the body type, and this notice goes away.",
    "zh-CN":
      "请求体不是合法 JSON，无法确认其中 1 个已脱敏的字段是否已经重新填写。把请求体改成合法 JSON，或换一个请求体类型，这条提示就会消失。",
  },
  "history.reselectFileTitle": {
    one: "This file must be re-selected — history does not store file contents:",
    many: "These 2 files must be re-selected — history does not store file contents:",
    "zh-CN": "以下 1 个文件需要重新选择——历史不保存文件内容：",
  },
  "history.healthBadRows": {
    one: "1 history line cannot be parsed and is not shown in the list. Clear History still works.",
    many: "2 history lines cannot be parsed and are not shown in the list. Clear History still works.",
    "zh-CN": "有 1 行历史记录无法解析，它们不会显示在列表里。清空历史仍然可用。",
  },
  "environment.collisionTitle": {
    one: "1 secret value was shared by two environments",
    many: "2 secret values were shared by two environments",
    "zh-CN": "有 1 个密钥值曾被两个环境共用",
  },
}

function rendered(locale: "zh-CN" | "en", key: string, count: number, named?: string): string {
  i18n.global.locale.value = locale
  return named ? i18n.global.t(key, { [named]: count }, count) : i18n.global.t(key, count)
}

describe("D44 a counted sentence agrees with its count", () => {
  it.each(Object.entries(COUNTED))("%s reads singular at one in English", (key, expected) => {
    expect(`en@1: ${rendered("en", key, 1, expected.named)}`).toBe(`en@1: ${expected.one}`)
  })

  it.each(Object.entries(COUNTED))("%s reads plural at two in English", (key, expected) => {
    expect(`en@2: ${rendered("en", key, 2, expected.named)}`).toBe(`en@2: ${expected.many}`)
  })

  it.each(Object.entries(COUNTED))("%s reads as one plain sentence in zh-CN", (key, expected) => {
    expect(`zh-CN@1: ${rendered("zh-CN", key, 1, expected.named)}`).toBe(
      `zh-CN@1: ${expected["zh-CN"]}`,
    )
  })

  it.each(Object.entries(COUNTED))("%s reads the same sentence at two in zh-CN", (key, expected) => {
    expect(`zh-CN@2: ${rendered("zh-CN", key, 2, expected.named)}`).toBe(
      `zh-CN@2: ${expected["zh-CN"].replace("1", "2")}`,
    )
  })

  it.each(Object.keys(COUNTED))("%s carries no plural split in its zh-CN source", (key) => {
    const source = rawMessage("zh-CN", key)
    expect(typeof source).toBe("string")
    expect(`${key}: ${source}`).not.toContain("|")
  })
})

/**
 * Every placeholder in the English catalog, sorted by what a caller puts in it.
 * The inventory was read out of the catalog, not from memory:
 *
 *   grep -oE '\{[A-Za-z_][A-Za-z0-9_]*\}' src/i18n/en.ts | sort | uniq -c
 *
 * `count`, `starred` and `index` take a number. The rest take a field name, a
 * URL, a method, a timestamp, a file path, a format name, a size already
 * formatted with its unit (`{limit}`, `{size}`), or a sentence already rendered
 * (`{characters}` is `bodyCharacterCount` at its count). Which side a name
 * belongs on is a reading of its call sites, done by hand; that the inventory
 * is complete is asserted, so a new placeholder fails until it is sorted.
 */
const PLACEHOLDERS = {
  numeric: ["count", "starred", "index"],
  text: ["at", "characters", "field", "fields", "format", "key", "limit", "method", "name", "path", "size", "url", "variable"],
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const NUMERIC_PLACEHOLDER = new RegExp(`\\{(${PLACEHOLDERS.numeric.join("|")})\\}`)

/**
 * English messages that interpolate a number but set no noun beside it, so
 * there is no form to agree. An exception is granted to a sentence, not to a
 * key: the text is pinned, and a rewrite that puts a noun after the number
 * ("{count} dropped messages") fails here until the sentence is split and given
 * a COUNTED row, or the pin is moved on purpose. An entry whose key is not in
 * the catalog, whose text carries no number, or whose text carries a `|` fails
 * too, so the list cannot go stale.
 */
const NO_NOUN: Record<string, { text: string; reason: string }> = {
  "ws.droppedMessages": {
    text: "{count} dropped",
    reason: "the count stands alone; nothing follows it to agree with",
  },
  "tabs.untitled": {
    text: "Untitled {index}",
    reason: "a serial suffix (Untitled 3), not a count of anything",
  },
}

/**
 * Guards the guard, and says how far it reaches. The class is derived from the
 * catalog two ways: every English message that carries a `|` must have a
 * COUNTED row and every row must have a `|` message (so a row cannot outlive
 * its split, and a split cannot go unasserted); and every English message that
 * interpolates a number must either carry a `|` or be pinned in NO_NOUN (so a
 * counted sentence written without a split fails instead of shipping as
 * "1 requests").
 *
 * What this does not reach: a sentence that concatenates a number to a
 * translated noun in the template, with no placeholder in the catalog.
 * `response.items` is that shape -- `JsonTreeView.vue` renders
 * `${entries.length} ${t("response.items", entries.length)}` -- and it has a row
 * only because a person read the call site. The catalog carries no number for
 * it, so no scan of the catalog can find the next one. That gap is registered
 * here, not closed.
 */
describe("D44 the counted class is read out of the catalog", () => {
  it("sorts every placeholder in the English catalog as a number or as text", () => {
    const found = new Set(
      flatten(en).flatMap(([, text]) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1])),
    )
    expect([...found].sort()).toEqual([...PLACEHOLDERS.numeric, ...PLACEHOLDERS.text].sort())
  })

  it("has a row for every English message that carries a plural split, and no other", () => {
    const split = flatten(en)
      .filter(([, text]) => text.includes("|"))
      .map(([key]) => key)
    expect(split.sort()).toEqual(Object.keys(COUNTED).sort())
  })

  it("splits every English message that interpolates a number, unless it is pinned as noun-free", () => {
    const unsplit = flatten(en)
      .filter(([key, text]) => NUMERIC_PLACEHOLDER.test(text) && !text.includes("|") && !(key in NO_NOUN))
      .map(([key]) => key)
    expect(unsplit).toEqual([])
  })

  it.each(Object.entries(NO_NOUN))("%s is excepted for exactly the noun-free sentence it was granted for", (key, exception) => {
    expect(`${key}: ${rawMessage("en", key)}`).toBe(`${key}: ${exception.text}`)
    expect(`${key} interpolates a number: ${NUMERIC_PLACEHOLDER.test(exception.text)}`).toBe(
      `${key} interpolates a number: true`,
    )
    expect(`${key}: ${exception.text}`).not.toContain("|")
  })
})

/**
 * D41 defect A: `bodyScopeFull` said "the view above" while the view renders
 * after the note in `ResponseBody.vue`. D44 defect 2: `collisionConsequence`
 * said "each environment listed below". A sentence naming a layout position is
 * a second copy of the template's ordering kept in agreement by nothing but
 * care -- reorder the template and the copy lies with no test turning red --
 * and the scope sentence is also served as a tooltip, where a box floating
 * over the cursor has no "above" to point at.
 *
 * The rule this pins is that copy says *what* something is, never where it
 * sits. It reads the whole catalog rather than one key family, so the next
 * sentence to name a position fails here whichever section it lands in. The
 * places a listed word is not a position are named with their reason, and an
 * entry that stops matching fails too, so the list cannot go stale.
 *
 * A word list is a cost barrier, not a proof: a sentence can encode layout
 * without using any of these words ("the panel that opens next"), and Chinese
 * 以下 / 以上 are left out on purpose -- they name reading order, and the
 * three catalog uses are a same-sentence referent and two colon lead-ins.
 */
const POSITIONAL: Record<string, RegExp> = {
  en: /\b(above|below|beneath|underneath|upper|lower|top|bottom|left|right)\b/i,
  "zh-CN": /上面|下面|上方|下方|左边|右边|左侧|右侧|顶部|底部/,
}

/**
 * An exception is granted to a sentence, not to a key -- the NO_NOUN shape. A
 * key-only exception waves through any listed word under that key, so "Close
 * Tabs to the Right" rewritten as "Close Tabs to the Left" would pass while the
 * command still closes to the right. The text is pinned instead, and the pinned
 * text must itself carry a listed word, so an entry whose sentence stops naming
 * a position fails too and the list cannot go stale.
 */
const NOT_A_POSITION: Record<string, Record<string, { text: string; reason: string }>> = {
  en: {
    "request.historyRedactedBanner": {
      text: "This request came from history. These were redacted when it was saved and need re-entering: {fields}. Left empty, they are sent empty.",
      reason: "'Left empty' is the verb leave, not a side",
    },
    "tabs.closeToRight": {
      text: "Close Tabs to the Right",
      reason: "tab order is what the command does",
    },
  },
  "zh-CN": {
    "tabs.closeToRight": {
      text: "关闭右侧标签页",
      reason: "标签顺序就是这条命令的语义",
    },
  },
}

const POSITIONAL_EXCEPTIONS: Array<[string, string, { text: string; reason: string }]> =
  Object.entries(NOT_A_POSITION).flatMap(([locale, exceptions]) =>
    Object.entries(exceptions).map(
      ([key, exception]): [string, string, { text: string; reason: string }] => [locale, key, exception],
    ),
  )

describe("§59 / D44 the copy never says where anything sits", () => {
  it.each(["zh-CN", "en"] as const)("%s names no position outside the listed exceptions", (locale) => {
    const exceptions = NOT_A_POSITION[locale]

    for (const [key, text] of flatten(SOURCES[locale])) {
      const expected = key in exceptions
      expect(`${key}: ${POSITIONAL[locale].test(text)}`).toBe(`${key}: ${expected}`)
    }
  })

  it.each(POSITIONAL_EXCEPTIONS)(
    "%s %s is excepted for exactly the sentence it was granted for",
    (locale, key, exception) => {
      expect(`${locale} ${key}: ${rawMessage(locale, key)}`).toBe(`${locale} ${key}: ${exception.text}`)
      expect(`${key} names a listed word: ${POSITIONAL[locale].test(exception.text)}`).toBe(
        `${key} names a listed word: true`,
      )
    },
  )
})
