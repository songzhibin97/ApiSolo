import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
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

/**
 * §27–§29: three product decisions that are invisible from the interface, so a
 * README is the only place they can live. The repository's existing README gate
 * asserts the two files separately on purpose — writing a decision down in one
 * language means it was not written down for the other half of the users.
 */
describe("§27 starring buys exemption from eviction, not from an explicit clear", () => {
  it("the English README says history can grow without bound", () => {
    expect(readmeEn).toContain(
      "Starred history entries are exempt from automatic eviction, so history can grow without any upper bound",
    )
  })

  it("the Chinese README says history can grow without bound", () => {
    expect(readmeZh).toContain("收藏（星标）的历史条目不参与自动淘汰，因此历史文件可以无上限增长")
  })

  it("the English README says a clear takes starred entries too", () => {
    expect(readmeEn).toContain(
      "Clear History deletes every entry, starred ones included",
    )
  })

  it("the Chinese README says a clear takes starred entries too", () => {
    expect(readmeZh).toContain("「清空历史」删除全部条目，收藏的也一起删")
  })
})

describe("§28 a request saved from history carries no marker for its empty fields", () => {
  it("the English README says so", () => {
    expect(readmeEn).toContain(
      "keeps its redacted fields as empty values and carries no marker for them",
    )
  })

  it("the Chinese README says so", () => {
    expect(readmeZh).toContain("其脱敏字段保存为空值，且不携带任何标记")
  })
})

describe("§29 what a history entry has already lost", () => {
  it("the English README says uploads keep neither bytes nor path", () => {
    expect(readmeEn).toContain(
      "The bytes and the path of an uploaded file are not stored in history",
    )
  })

  it("the Chinese README says uploads keep neither bytes nor path", () => {
    expect(readmeZh).toContain("历史不保存上传文件的字节与路径")
  })

  it("the English README says a disabled row never reaches history", () => {
    expect(readmeEn).toContain(
      "a parameter or header that was disabled when you sent the request is not written to history at all",
    )
  })

  it("the Chinese README says a disabled row never reaches history", () => {
    expect(readmeZh).toContain("发送时被禁用的参数与请求头整行不写进历史")
  })
})

/**
 * §50: notes and stars go in the history row, never into a file beside it. The
 * criterion is the set of history file names the source mentions, checked
 * against a written-out allowlist — asking "is there a sidecar" would need
 * someone to guess what a sidecar would be called.
 */
describe("§50 annotations live in the history row, not in a second file", () => {
  const ALLOWED = ["history.jsonl", "history.corrupt.jsonl"]

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        return item.name === "node_modules" || item.name === "target" ? [] : sourceFiles(path)
      }
      return /\.(ts|vue|rs)$/.test(item.name) ? [path] : []
    })
  }

  function historyFileNames(): string[] {
    const found = new Set<string>()

    for (const file of [...sourceFiles("src"), ...sourceFiles("src-tauri/src")]) {
      for (const match of readFileSync(file, "utf8").matchAll(/history[\w.-]*\.jsonl?\b/gi)) {
        found.add(match[0])
      }
    }

    return [...found].sort()
  }

  it("the scan finds the names it is supposed to find", () => {
    // Fail-closed: an empty result would otherwise read as "no sidecar".
    expect(historyFileNames()).toContain("history.jsonl")
  })

  it("mentions no history file beyond the two that are accounted for", () => {
    expect(historyFileNames().filter((name) => !ALLOWED.includes(name))).toEqual([])
  })
})

/**
 * §51: the annotation command takes an id and the two fields, never a row. This
 * is a structural check rather than a behavioural one on purpose — a signature
 * that cannot carry a whole entry cannot overwrite one, so the defect is not
 * expressible instead of merely untested (PROCESS.md P8).
 */
describe("§51 the annotation command cannot be handed a whole history row", () => {
  function annotationSignature(): string {
    const source = readFileSync("src-tauri/src/lib.rs", "utf8")
    const start = source.indexOf("fn set_history_annotation(")
    expect(start, "set_history_annotation is missing").toBeGreaterThan(-1)
    const end = source.indexOf(")", start)
    return source.slice(start, end + 1)
  }

  it("the scan is looking at the signature it thinks it is", () => {
    // Fail-closed: a slice that happened to be empty or to miss the parameters
    // would pass the check below without having read anything.
    expect(annotationSignature()).toContain("id: String")
    expect(annotationSignature()).toContain("starred: Option<bool>")
  })

  it("names no entry type among its parameters", () => {
    expect(annotationSignature()).not.toContain("HistoryEntry")
  })
})
