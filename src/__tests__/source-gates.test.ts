import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import readmeEn from "../../README.md?raw"
import readmeZh from "../../README.zh-CN.md?raw"
import { MAX_RESPONSE_WIRE_BYTES, MAX_UPLOAD_FILE_BYTES } from "../utils/limits"

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
/**
 * D08 §13: four decisions of the collision notice that are invisible from the
 * interface at the moment they matter — the notice's scope, what acknowledging
 * really does, what was already lost, and how environment names collide. Both
 * READMEs are asserted separately: writing a decision down in one language
 * means it was not written down for the other half of the users.
 */
describe("D08 §13 the collision notice decisions are written down in both READMEs", () => {
  it("the English README says the notice is global and lives only in the environment panel", () => {
    expect(readmeEn).toContain(
      "The collision notice is global: it lists every recorded collision regardless of which project is active, and it appears only in the environment panel",
    )
  })

  it("the Chinese README says the notice is global and lives only in the environment panel", () => {
    expect(readmeZh).toContain(
      "碰撞提示是全局的：无论当前激活哪个项目都列出全部记录，且只出现在环境面板里",
    )
  })

  it("the English README says acknowledging deletes the record irreversibly", () => {
    expect(readmeEn).toContain(
      "deletes that collision record from the maintenance file. This cannot be undone",
    )
  })

  it("the Chinese README says acknowledging deletes the record irreversibly", () => {
    expect(readmeZh).toContain("会从维护文件里删除那条碰撞记录，不可撤销")
  })

  it("the English README says the overwritten value is unrecoverable and never guessed or blanked", () => {
    expect(readmeEn).toContain(
      "cannot be recovered. ApiSolo does not guess what it was and does not write an empty value in its place",
    )
  })

  it("the Chinese README says the overwritten value is unrecoverable and never guessed or blanked", () => {
    expect(readmeZh).toContain("无法恢复；ApiSolo 不猜它是什么，也不会用空值顶替")
  })

  it("the English README says colliding new names are rejected and do not stay in the list", () => {
    expect(readmeEn).toContain(
      "whose name normalises to an existing one is rejected when saved, and the unsaved name does not stay in the list",
    )
  })

  it("the Chinese README says colliding new names are rejected and do not stay in the list", () => {
    expect(readmeZh).toContain(
      "用一个会归一化到已有环境的名字新建时，保存会被拒绝，而那个未保存的名字不会留在列表里",
    )
  })
})

/**
 * D08 §14: a text gate, not a behaviour gate — start_dev_server sits under
 * #[cfg(feature = "dev-bridge")], so no default test run can send an HTTP
 * request to these routes. What can be pinned is that the route literals are
 * on disk and spelled exactly like the command names: a one-letter mismatch is
 * a 404, and under §2 a 404 renders as "no collisions" — indistinguishable
 * from the notice silently dying in dev:web.
 */
describe("D08 §14 the dev bridge declares routes for both collision commands", () => {
  function devBridgeRouteNames(): string[] {
    const source = readFileSync("src-tauri/src/lib.rs", "utf8")
    return [...source.matchAll(/"\/api\/([A-Za-z0-9_-]+)"/g)].map((match) => match[1])
  }

  it("the scan finds a route that predates this slice", () => {
    // Fail-closed: an empty scan would otherwise read as "routes are fine".
    expect(devBridgeRouteNames()).toContain("get_history_health")
  })

  it("declares the collision query route, spelled like the command", () => {
    expect(devBridgeRouteNames()).toContain("get_secret_key_collisions")
  })

  it("declares the acknowledge route, spelled like the command", () => {
    expect(devBridgeRouteNames()).toContain("acknowledge_secret_key_collision")
  })
})

/**
 * D09 §22 (vi): the TS caps and the Rust caps are the same number. There is no
 * cross-language constant sharing in this repository, so this gate replaces
 * "someone remembers to change both" — either value drifting fails the suite.
 */
describe("D09 §22 the TS byte caps equal the Rust byte caps", () => {
  function rustConstBytes(name: string): number {
    const source = readFileSync("src-tauri/src/lib.rs", "utf8")
    const match = source.match(
      new RegExp(`const ${name}: usize = ([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*);`),
    )
    expect(match, `${name} is missing from lib.rs`).not.toBeNull()
    return match![1]
      .split("*")
      .map((part) => Number(part.trim().replace(/_/g, "")))
      .reduce((product, factor) => product * factor, 1)
  }

  it("the parser proves itself on a constant with a known value", () => {
    // Fail-closed: a parser that silently mis-reads would make the equality
    // checks below meaningless.
    expect(rustConstBytes("MAX_DECOMPRESSED_RESPONSE_BYTES")).toBe(64 * 1024 * 1024)
  })

  it("the upload precheck cap equals Rust's MAX_UPLOAD_PART_BYTES", () => {
    expect(MAX_UPLOAD_FILE_BYTES).toBe(rustConstBytes("MAX_UPLOAD_PART_BYTES"))
  })

  it("the response notice cap equals Rust's MAX_RESPONSE_WIRE_BYTES", () => {
    expect(MAX_RESPONSE_WIRE_BYTES).toBe(rustConstBytes("MAX_RESPONSE_WIRE_BYTES"))
  })
})

/**
 * D09 §26: four size-cap decisions, each invisible from the interface at the
 * moment it matters, written down in both READMEs — and the old "no size cap"
 * known-issue sentence gone from both. The negative half matters most: a
 * README claiming both "has a cap" and "has no cap" is worse than either
 * alone, and only-adding patches pass every positive gate.
 */
describe("D09 §26 the size-cap decisions are written down in both READMEs", () => {
  it("(i) the English README states the hard network cap, its number, and what is not offered", () => {
    expect(readmeEn).toContain(
      "The network read of a response body stops at a hard-coded, non-configurable cap of 16 MiB",
    )
    expect(readmeEn).toContain(
      "the remainder is never received and ApiSolo will not fetch it automatically",
    )
    expect(readmeEn).toContain("There is no full-download escape hatch")
  })

  it("(ii) the Chinese README states the hard network cap, its number, and what is not offered", () => {
    expect(readmeZh).toContain("响应体的网络读取有一个写死、不可配置的上限：16 MiB")
    expect(readmeZh).toContain("ApiSolo 也不会自动重取")
    expect(readmeZh).toContain("没有完整下载的出口")
  })

  it("(iii) the English README says the two caps are different numbers and the network one is smaller", () => {
    expect(readmeEn).toContain(
      "two different numbers on purpose, and the network cap is the smaller one",
    )
  })

  it("(iv) the Chinese README says the two caps are different numbers and the network one is smaller", () => {
    expect(readmeZh).toContain("是两个不同的数，且网络上限更小")
  })

  it("(v) the English README says an oversized upload errors instead of truncating", () => {
    expect(readmeEn).toContain(
      "fails with an error instead of being truncated: ApiSolo never sends a truncated request body",
    )
  })

  it("(vi) the Chinese README says an oversized upload errors instead of truncating", () => {
    expect(readmeZh).toContain(
      "上传方向超限是报错，不是截断：ApiSolo 绝不发出一个被截断的请求体",
    )
  })

  it("(vii) the English README says the dev bridge cap is explicit and both modes agree", () => {
    expect(readmeEn).toContain("The dev bridge has an explicit inbound request-body cap (64 MiB)")
    expect(readmeEn).toContain("give the same result for the same upload")
  })

  it("(viii) the Chinese README says the dev bridge cap is explicit and both modes agree", () => {
    expect(readmeZh).toContain("dev bridge 的入站请求体有一个显式上限（64 MiB）")
    expect(readmeZh).toContain("对同一次上传给出相同结果")
  })

  it("(ix) the English README no longer lists the missing cap as a known issue", () => {
    expect(readmeEn).not.toContain("no size cap on the network read")
    expect(readmeEn).not.toContain("Tracked as backlog D09")
  })

  it("(x) the Chinese README no longer lists the missing cap as a known issue", () => {
    expect(readmeZh).not.toContain("无大小上限")
    expect(readmeZh).not.toContain("已登记为 backlog D09")
  })
})

/**
 * D12 §13: two layout decisions that are invisible from the interface at the
 * moment they matter — where the truncation badge's full wording went, and
 * what a narrow sidebar is allowed to take away (with the one deliberate
 * method-name exception that keeps the no-overlap promise honest). Both
 * READMEs are asserted separately, as this file always does.
 */
describe("D12 §13 the history-row layout decisions are written down in both READMEs", () => {
  it("the English README says where the badge's wording lives", () => {
    expect(readmeEn).toContain(
      "hover it for the full wording, which is also what a screen reader announces",
    )
  })

  it("the Chinese README says where the badge's wording lives", () => {
    expect(readmeZh).toContain(
      "把鼠标停在它上面会显示完整说明，读屏器读到它时念的也是同一句",
    )
  })

  it("the English README bounds the no-overlap promise and disclaims persistence", () => {
    expect(readmeEn).toContain(
      "it never lets two pieces of text sit on top of each other — with one exception",
    )
    expect(readmeEn).toContain(
      "The sidebar width is not remembered; every launch starts at the default width",
    )
  })

  it("the Chinese README bounds the no-overlap promise and disclaims persistence", () => {
    expect(readmeZh).toContain("也不会让两段文字叠在一起——只有方法名例外")
    expect(readmeZh).toContain("侧栏宽度不会被记住，每次启动都回到默认宽度")
  })
})

/**
 * D12 §1: the structural premise of "nothing overdraws its siblings" is that
 * every container whose content can outgrow it clips itself. This gate pins
 * that premise to the class strings on disk (the repository's existing
 * scan-gate shape, judged as in A21: it proves the classes are bound in the
 * template, not that the layout converges — the size-facing half of §1 has no
 * automated gate and is carried by the manual acceptance items).
 */
describe("D12 §1 the history row's lines clip their own overflow", () => {
  const panel = readFileSync("src/components/sidebar/HistoryPanel.vue", "utf8")

  function classOf(testid: string): string {
    const anchor = `data-testid="${testid}"`
    const at = panel.indexOf(anchor)
    expect(at, `${anchor} is missing from HistoryPanel.vue`).toBeGreaterThan(-1)
    const tag = panel.slice(panel.lastIndexOf("<", at), panel.indexOf(">", at))
    const match = tag.match(/ class="([^"]*)"/)
    expect(match, `${testid} carries no static class attribute`).not.toBeNull()
    return match![1]
  }

  it("the scan finds an anchor that predates this slice", () => {
    // Fail-closed: a scan that finds nothing would otherwise read as "nothing
    // is missing". history-row predates D12; its class is known to be non-empty.
    expect(classOf("history-row")).toContain("flex")
  })

  it("line 1 clips its own overflow", () => {
    expect(classOf("history-open")).toContain("overflow-hidden")
  })

  it("line 2 clips its own overflow", () => {
    expect(classOf("history-line2")).toContain("overflow-hidden")
  })

  it("the response facts group clips its own overflow", () => {
    expect(classOf("history-facts")).toContain("overflow-hidden")
  })

  it("the response facts group may shrink below its content", () => {
    expect(classOf("history-facts")).toContain("min-w-0")
  })
})

/**
 * D13 §7: the structural premises of "the variable table converges instead of
 * overflowing" — a zero-minimum text track, fixed 36px button tracks, a
 * self-clipping key cell, a value input on its own spanned line, and an eye
 * button that refuses to shrink. Same shape as the D12 gate above: it proves
 * the classes are bound in the template, not that the layout converges — the
 * size-facing half is carried by the manual acceptance items.
 */
describe("D13 §7 the variable table's tracks and cells are the ones that converge", () => {
  const panel = readFileSync("src/components/sidebar/EnvironmentPanel.vue", "utf8")

  function classOf(testid: string): string {
    const anchor = `data-testid="${testid}"`
    const at = panel.indexOf(anchor)
    expect(at, `${anchor} is missing from EnvironmentPanel.vue`).toBeGreaterThan(-1)
    const tag = panel.slice(panel.lastIndexOf("<", at), panel.indexOf(">", at))
    const match = tag.match(/ class="([^"]*)"/)
    expect(match, `${testid} carries no static class attribute`).not.toBeNull()
    return match![1]
  }

  function classTokensOf(testid: string): string[] {
    return classOf(testid).split(/\s+/)
  }

  it("the scan finds an anchor that predates this slice", () => {
    // Fail-closed: a scan that finds nothing would otherwise read as "nothing
    // is missing". environment-save predates D13; its class is known non-empty.
    expect(classOf("environment-save")).toContain("flex")
  })

  it("the variable row uses the zero-minimum two-button track", () => {
    expect(classOf("variable-row")).toContain("grid-cols-[minmax(0,1fr)_36px_36px]")
  })

  it("no fixed-minimum text track is left anywhere in the panel", () => {
    // 120px + 160px minimums are the root cause: 392px of track in a 214px
    // pane. Scanned file-wide so the old track cannot survive in the header.
    expect(panel).not.toContain("minmax(120px")
    expect(panel).not.toContain("minmax(160px")
  })

  it("the key cell clips its own overflow and may shrink below its content", () => {
    expect(classOf("variable-key-cell")).toContain("overflow-hidden")
    expect(classOf("variable-key-cell")).toContain("min-w-0")
  })

  it("the value input spans the full second line", () => {
    expect(classOf("variable-value")).toContain("col-span-3")
    expect(classOf("variable-value")).toContain("col-start-1")
  })

  it("the header labels its section and drops the del column label", () => {
    expect(panel).toContain('t("environment.variables")')
    // Exact call, closing quote included: keyValue.deleteRow (the delete
    // button's own wording, which stays) shares the prefix.
    expect(panel).not.toContain('t("keyValue.del")')
  })

  it("the eye button refuses to shrink", () => {
    expect(classTokensOf("toggle-secret-visibility")).toContain("shrink-0")
  })

  /**
   * D13 §19 §20: the collision area's two layout constraints (this slice fixes
   * only the layout of that D08 markup — wording and behaviour are pinned by
   * the component tests).
   */
  it("§19 the ack button grows with a wrapped label instead of fixing its height", () => {
    const tokens = classTokensOf("collision-ack")
    expect(tokens).toContain("min-h-8")
    // Token comparison, not substring: "min-h-8" contains "h-8".
    expect(tokens).not.toContain("h-8")
  })

  it("§20 the environment list lines may break inside an unbroken name", () => {
    expect(classTokensOf("collision-environment")).toContain("break-all")
  })

  /**
   * D13 §18: the create-environment form stacks the name input above its two
   * buttons, so the two incompressible buttons can no longer squeeze the input
   * to its 26px padding floor.
   */
  it("§18 the create-environment form stacks vertically", () => {
    const form = panel.slice(panel.indexOf("<form"), panel.indexOf("</form>"))
    const match = form.match(/ class="([^"]*)"/)
    expect(match, "the form carries no static class attribute").not.toBeNull()
    expect(match![1]).toContain("flex-col")
  })

  it("§18 both buttons live in their own right-aligned actions row", () => {
    expect(classTokensOf("create-environment-actions")).toContain("justify-end")
    // Both buttons sit after the actions wrapper opens — moving either back
    // beside the input puts it before this anchor and fails the slice check.
    const actions = panel.slice(
      panel.indexOf('data-testid="create-environment-actions"'),
      panel.indexOf("</form>"),
    )
    expect(actions).toContain('t("common.create")')
    expect(actions).toContain('t("common.cancel")')
  })
})

/**
 * D13 §17: the environment-panel layout decisions, written down in both
 * READMEs — and the old "reveal button unreachable" known issue gone from
 * both, in the same PR as the fix that removes the defect it described. The
 * sentences carry no width thresholds on purpose (A52: the README states only
 * what is unconditionally true; the one threshold the old text named was
 * measurably wrong).
 *
 * Element 17.6 (sidebar width is not remembered) is deliberately absent here:
 * both READMEs state it once, in the sentence the D12 gate above already pins
 * for both languages — a second assertion on the same sentence would not be
 * independently load-bearing.
 */
describe("D13 §17 the environment-panel layout decisions are written down in both READMEs", () => {
  it("the scan reads the READMEs it thinks it does", () => {
    // Fail-closed anchors that predate this slice.
    expect(readmeEn).toContain("# ApiSolo")
    expect(readmeZh).toContain("# ApiSolo")
  })

  const ELEMENTS: Array<{ id: string; zh: string; en: string }> = [
    {
      id: "17.1 two lines per variable",
      zh: "每个变量占两行",
      en: "each variable takes two lines",
    },
    {
      id: "17.2 both row buttons stay visible",
      zh: "这两个按钮都完整显示",
      en: "both buttons are fully visible",
    },
    {
      id: "17.3 still reachable once the list scrolls",
      zh: "按钮仍然能滚到",
      en: "still reachable by scrolling",
    },
    {
      id: "17.4 the traded-away row count",
      zh: "一屏能看到的变量数大约少一半",
      en: "about half as many variables fit on screen",
    },
    {
      id: "17.5 narrow sidebar never overlaps controls",
      zh: "不会让两个控件叠在一起",
      en: "never lets two controls sit on top of each other",
    },
  ]

  it.each(ELEMENTS)("$id is stated in the English README", ({ en }) => {
    expect(readmeEn).toContain(en)
  })

  it.each(ELEMENTS)("$id is stated in the Chinese README", ({ zh }) => {
    expect(readmeZh).toContain(zh)
  })

  it("the English README no longer lists the unreachable reveal button as a known issue", () => {
    expect(readmeEn).not.toContain("no amount of dragging reveals it")
    expect(readmeEn).not.toContain("Known issues")
  })

  it("the Chinese README no longer lists the unreachable reveal button as a known issue", () => {
    expect(readmeZh).not.toContain("无论怎么拖都看不到它")
    expect(readmeZh).not.toContain("已知问题")
  })
})

/**
 * D19: the interface's version string comes from package.json through the
 * __APP_VERSION__ define; no shipped frontend source may carry its own version
 * literal, or the next bump ships an interface that introduces itself by the
 * old number. The instrument, declared before use (PROCESS.md P15):
 *
 *   - files: every .ts/.vue under src/, excluding __tests__ directories —
 *     test files do not ship, their fixtures legitimately carry Postman
 *     schema URLs, and this gate's own known-bad sample lives in one;
 *   - pattern: v-prefixed dotted triple, `\bv\d+\.\d+\.\d+\b`, the exact
 *     shape the shipped defect had. The bare dotted triple is deliberately
 *     outside this instrument's calibre: it matches 127.0.0.1 (invoke.ts) and
 *     "curl 8.7.1" (curl-parser.ts comments), and the three surfaces that
 *     actually display a version are pinned to package.json by
 *     VersionString.test.ts;
 *   - allowlist: hits accounted for below, keyed `path:match`. Every entry
 *     must still be hit, so a stale entry fails the gate instead of rotting.
 */
describe("D19 no shipped frontend source carries its own version literal", () => {
  const ALLOWED = [
    // The Postman collection schema URL — a foreign format's version.
    "src/utils/postman-export.ts:v2.1.0",
  ]

  /** Fresh regex per call — a module-level /g regex carries lastIndex state. */
  function versionLiteral(): RegExp {
    return /\bv\d+\.\d+\.\d+\b/g
  }

  function shippedFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        return item.name === "node_modules" || item.name === "__tests__" ? [] : shippedFiles(path)
      }
      return /\.(ts|vue)$/.test(item.name) ? [path] : []
    })
  }

  function versionLiteralHits(): string[] {
    return shippedFiles("src").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(versionLiteral())].map(
        (match) => `${file}:${match[0]}`,
      ),
    )
  }

  it("the walk reaches the three surfaces that carried the defect", () => {
    // Fail-closed: a walk that filtered them out would report a clean tree
    // without having looked at the only files known to have lied.
    const files = shippedFiles("src")
    expect(files).toContain(join("src", "components", "layout", "AppHeader.vue"))
    expect(files).toContain(join("src", "components", "layout", "StatusBar.vue"))
    expect(files).toContain(join("src", "components", "settings", "SettingsModal.vue"))
  })

  it("the pattern kills a known-bad sample", () => {
    // Fail-closed: a pattern that matches nothing would report a clean tree.
    expect('<span class="shrink-0">v0.1.0</span>'.match(versionLiteral())).toEqual(["v0.1.0"])
  })

  it("every allowlist entry is still hit", () => {
    // Doubles as proof the scan reads real file contents; a stale entry means
    // the allowlist no longer describes the tree and must shrink.
    const hits = versionLiteralHits()
    for (const entry of ALLOWED) {
      expect(hits).toContain(entry)
    }
  })

  it("mentions no version literal beyond the ones accounted for", () => {
    expect(versionLiteralHits().filter((hit) => !ALLOWED.includes(hit))).toEqual([])
  })
})

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
