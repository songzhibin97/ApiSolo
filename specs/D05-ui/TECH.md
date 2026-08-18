# D05 — UI 交互缺陷（TECH）

> **rev2 — 应 R1 修订（4C + 4I）**。行为定义见 `PRODUCT.md`（**49** 条不变式）。分支 `songzhibin/d05-ui`，起点由 `c9221d3` **rebase 到 `dfb2d2e`**。
>
> 改动区域逐项枚举：
>
> | R1 项 | 本文改动区域 |
> |---|---|
> | C1 | 0.6 由「证伪记录」改写为「已被 main 修复的作废记录」；rev1 的 2.9（重写判据）整节删除；映射表 I 组重写为接线；新增 §6「受控裁定申请」 |
> | C2 | 新增 0.8（后端 query 构造的完整读取）；2.4 的过滤条件改 `key.trim()`；映射表新增 §3、§4 |
> | C3 | 新增 4.1「组件测试的引入与硬性适用面」（推翻 rev1 的一半论证）；新增 4.3「harness 自检与 P12 fail-closed 协议」；映射表 8 行改为组件层 |
> | C4 | 4.2 映射表整表重编（49 行，无子编号），新增「承重断言」列；4.6 统计重做并逐条自查 rev1 的错误 |
> | I1 | 2.8 改为 branded `HistoryGroupId` + `Set`；§20 组件断言、§21 源码 gate，限制分别写明 |
> | 其余 3 条 IMPORTANT | 见 §7 |
>
> 全部 `file:line` 基于 `dfb2d2e` 实际读过的代码。来源评审文档的行号已过时，一律按符号定位。

## 0. 起草期的实跑记录

以下全部是起草者在本工作树亲跑的结果，不是转述。

### 0.1 基线（rev2 重跑）

起点 `dfb2d2e`：`npx vitest run` → **20 files / 277 passed**。
rev1 写的 20/276 是 `c9221d3` 上的数字；rebase 后 +1 来自另一切片的回归测试。**两次都实跑，没有沿用旧数字。**

### 0.2 两个编码器的逐字节差异（决定设计题二）

`URLSearchParams` 与 `encodeURIComponent` 对 37 个字符样本比对，**只有 6 个不同**：空格（`+` vs `%20`）、`!`、`~`、`(`、`)`、`'`。后五个同义，**空格不是**。

### 0.3 拟定的 `buildUrlWithParams` 与现实现逐字节等价（模板跨度除外）

35 个非模板值：`NON-TEMPLATE DIFFS=0`。模板值：`k=%7B%7BapiKey%7D%7D` → `k={{apiKey}}`；`{{ a }}` 由 `%7B%7B+a+%7D%7D` 变为原样。**本切片对 URL 栏的改动就是这一个只在模板跨度上开口的手术。**

### 0.4 URL 栏草稿协调器的键入模拟

逐字符模拟 10 个目标串走完整往返：`TYPING FAILURES=0`。并实测确认 `buildUrlWithParams` **不需要**为尾随 `?` 加特例——去掉该分支后 10/10 仍全过，协调器已兜住。

### 0.5 控制台 pinia 修复的实跑

改成 `useConsoleStore((getActivePinia() as never) ?? pinia)` 后全套 20 files / 276 passed（在 `c9221d3` 上），与当时基线一致，既有测试无一被打破。临时探针带修复全绿、去修复全红：

```
去修复   2 failed
  probe > does not hijack the active pinia          → getActivePinia() 被换成模块单例
  probe > writes into the caller's pinia …          → 模块单例里出现了不该有的条目
```

**承重性的如实限定（P9）**：去掉修复后，「条目出现在调用方 pinia 里」这一句**仍然通过**（activePinia 已被翻走，未绑定的 `useConsoleStore()` 解析到的正是被写入的那个模块单例）。真正承重的是另外两句，且**各自有单塌用例**：第一个用例只断言 `getActivePinia()` 身份（§45）；第二个用例的前一句通过、只塌「模块单例为空」（§46）。

### 0.6 rev1 的「起草期新发现」已作废（R1-C1）

rev1 记录的实测——`fileContent: null` 使 `!== undefined` 恒真、导出产物对每个文件行写入假说明并整个丢掉 `src`——**是真的，且已由导入导出切片在 `32b7100` 修复**（判据改为 `typeof fileContent === "string"`）。该缺陷已入账 `specs/BACKLOG.md` 的「已发布缺陷」表，并催生了规则 P11。

起草者已读过 main 现状并确认：两个谓词均为 `typeof … === "string"`；测试文件含 `IPC_NULL` fixture 与 P6 式自检；非内联时 `src` 被保留。

**因此 rev1 的 §29–§31 全部删除。** rev1 的写法（任何文件行都告警 + 沿用「内容只存在于 ApiSolo」文案）会把刚修掉的那句假话原样重造，并推翻已冻结的回归测试。

**这一轮我是在一个当时正确、后来过期的前提上工作的**——记录在此，因为下一个读这份 spec 的人会看到 backlog 那条缺陷署着「D05 规格阶段发现」，需要同时读到它已经不归本切片修。

### 0.7 未验证的推断（按 P4 标注）

**「后端 `query_pairs_mut()` 把空格编码成 `+`」仍是推断，不是实跑。** 依据是它返回 `form_urlencoded::Serializer`。本工作树无预热 `target/`，冷编译 tauri 代价过大。**这条推断是 §2 的前提**，实现者必须在动 `buildUrlWithParams` 之前跑掉它（4.4-a）。若实测为 `%20`，§2 方向反转、改用 `encodeQueryComponentPreservingTemplates`，设计题二的结论随之改变。

「WebKit 下 `:key` 变化导致输入框卸载、焦点掉到 `<body>`」来自来源评审文档的对抗性验证记录，**起草者未独立复现**；§14 的最终确认落在人工验收。

### 0.8 后端 query 构造的完整读取（R1-C2 的依据）

rev1 只读了第一个循环就写下了 §2，**漏了紧随其后的第二段**。完整形态（`src-tauri/src/lib.rs`，`execute_request` 内）：

```rust
{
    let mut pairs = url.query_pairs_mut();
    for param in args.params.iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())   // ← trim
    { pairs.append_pair(&param.key, &param.value); }
}

if let Some(api_key) = args.auth.api_key.as_ref() {
    if args.auth.auth_type == "api-key" && api_key.add_to == "query"
        && !api_key.key.trim().is_empty()
    { url.query_pairs_mut().append_pair(&api_key.key, &api_key.value); }   // ← 第二段
}
```

两处与 rev1 的 §2 冲突：

1. **认证层还会追加一对**，而 `buildUrlWithParams` 只拿到 `tab.url` 与 `tab.params`，不可能知道它。按 rev1 的字面实现只有两条出路：把 API key 渲染进地址栏（**主动泄露密钥**），或者让 §2 与那张 35 字符的表都成为假证明。两条都不可接受。
2. **过滤条件不同**：后端排除 `key.trim().is_empty()`，前端只排除 falsy `item.key`，所以 `key = "   "` 的行**会显示但不会发送**。

处置：§2 收窄为「**由启用的 Params 行生成的那一段**」，过滤条件对齐 `key.trim()`；§3 锁纯空白 key 的两侧一致；§4 用一条负向不变式把「认证 API key 不进 URL 栏」显式钉死，防止后来者为了让 §2「更完整」而把密钥渲染出来。

## 1. Context

### 1.1 URL 栏的三段往返

`UrlBar.vue` 的 `<input>` 是**完全受控**的（`:value` + `@input`，无本地缓冲），每次按键都被 `buildUrlWithParams ∘ syncParamsFromUrl` 重写一遍。往返有损：`{`/`}` → `%7B`/`%7D`；零参数不发 `?`，刚打的 `?` 立刻被删；`?x` 被解析成 `x=""`，回灌时多出 `=`。`detectedVariables` 对着已编码的串跑正则，所以查询串里的变量提示永不出现，而路径里的出现。

### 1.2 两份 URL 工具

`url-params.ts`（历史脱敏切片搬出）与 `url-query.ts`（导入导出切片新建）各有一份 `splitUrlParts`，**算法逐字符相同**，后者多返回 `query`。两个编码器**不是**重复——服务两个不同的正确性目标，见 2.1。

### 1.3 环境变量行

`rows` 是 `computed`，行 id 由 `${item.key}-${index}` 现算，末尾空白行的 id 每次重算都新生成；`commitRows` 把 id 剥掉再写回 store，**身份从未被持有过**。`EnvVariable` 没有 `id` 字段，**也不该加**——加了会写进 `.env.json`。

### 1.4 两处身份键取错

`groupByPrefix` 同时算出唯一的 map key 和可能不唯一的 `label`，而 `HistoryGroup` 只有 `label`，于是三处只能拿 `label` 当键。`openHistoryEntry` 的复用谓词不排除有集合绑定的 tab，随后 `Object.assign` 覆盖 `projectName` / `savedRequestPath` / `isDirty`。

### 1.5 导入与导出的告警

`parseCurl` 的 `warnings` 落地即丢；`onPaste` 先 `preventDefault()` 再 emit，而 `applyPastedCurl` 的 catch 是空的；`collectPostmanExportWarnings` 全仓零调用点。

### 1.6 在途请求

`sendRequest` 无条件 `activeRequestIds.set(tab.id, requestId)`，无早退。两个调用点：`RequestPanel.vue`、`useKeyboard.ts`。`UrlBar.onKeydown` 不读 `props.isLoading`，也不读 `event.repeat`。

## 2. Proposed changes

### 2.1 设计题二：不合并，重切边界，删一份重复，抽一个共享原语

1. **删掉 `url-params.ts` 的 `splitUrlParts`**，从 `url-query.ts` 导入；`url-params.ts` 不再导出该符号。
2. **在 `url-query.ts` 抽出唯一共享原语** `splitTemplateSpans` + `isTemplateSpan`，两个编码器共用。**真正共享的是模板跨度切分，不是编码器。**
3. **两个模块保留，边界按「产物的消费者」重切**并写进模块头注释：

   | 模块 | 职责 | 正确性目标 |
   |---|---|---|
   | `url-query.ts` | URL 字符串外科手术 + **交给外部工具的产物**的编码 | 复现用户输入：`%20`、不经 `new URL` 归一化、保留模板 |
   | `url-params.ts` | **URL 栏 ↔ params ↔ 线上**这条闭环 | 与本应用自己发出的字节一致：form-urlencoded、`+`、保留模板 |

4. **明确驳回交接项 C6**（复用 `encodeQueryComponentPreservingTemplates`）：0.2 实测它把空格编成 `%20`，而本应用上线时编成 `+`（0.7 待验）。照 C6 做会在含空格的参数上重造「显示 ≠ 发出」。C6 的动机成立，正确落法是共享第 2 条的原语。
5. **不改文件名**：重命名波及另一切片刚合并的 import，且买不到可测的东西——用模块头注释承担。

> **对既有测试的受控改动**：`url-params.test.ts` 改为从 `../url-query` 导入 `splitUrlParts` 并断言三字段形状。

### 2.2 设计题一：两类机制、三个渲染点

判据见 PRODUCT。落法：常驻提示条不动；导入通知挂在 `Tab` 的内存态字段上（跨 tab 切换存活，关闭 tab 自然回收，落进已有的「内存态不得进持久化负载」纪律）；导出通知复用集合面板已有的 feedback 条，tone 扩为三值 + 次行。

```ts
export interface CurlImportNotice {
  pasteFailure?: string          // 解析失败并按普通文本粘贴时的原因
  warnings: CurlImportWarning[]
}
// Tab 追加： importNotice?: CurlImportNotice
```

### 2.3 `src/utils/url-query.ts`

新增 `splitTemplateSpans` / `isTemplateSpan`；`splitUrlParts` 成为全仓唯一实现；`encodeQueryComponentPreservingTemplates` 改为走前两者，**行为不变**（其既有回归测试必须继续绿——这本身是 §1 之外的一条保护）。

### 2.4 `src/utils/url-params.ts`

```ts
import { isTemplateSpan, splitTemplateSpans, splitUrlParts } from "./url-query"

export function encodeFormComponentPreservingTemplates(value: string): string {
  return splitTemplateSpans(value)
    .map((segment) => {
      if (isTemplateSpan(segment)) { return segment }
      const encoded = new URLSearchParams()
      encoded.append("k", segment)
      return encoded.toString().slice(2)
    })
    .join("")
}

export function buildUrlWithParams(rawUrl: string, params: KeyValuePair[]): string {
  const { baseUrl, hash } = splitUrlParts(rawUrl)
  const query = params
    .filter((item) => item.enabled && item.key.trim())        // ← 与后端一致（0.8）
    .map((item) =>
      `${encodeFormComponentPreservingTemplates(item.key)}=${encodeFormComponentPreservingTemplates(item.value)}`)
    .join("&")
  return `${baseUrl}${query ? `?${query}` : ""}${hash}`
}

export function detectTemplateVariables(displayedUrl: string): string[]

export function reconcileUrlBarValue(
  previous: { tabId: string; draft: string } | null,
  incoming: { tabId: string; url: string },
): string {
  if (!previous || previous.tabId !== incoming.tabId) { return incoming.url }
  return sameParse(previous.draft, incoming.url) ? previous.draft : incoming.url
}
```

`sameParse(a, b)` 比较 `syncParamsFromUrl(a, [])` 与 `syncParamsFromUrl(b, [])` 的 `{ url, params:[{key,value,enabled}] }` 结构。**用「解析结果相等」而不是「字符串相等」**：用户打 `?q=a b` 时父级回灌 `?q=a+b`，字符串不等但语义相同，字符串比较会在打空格时把输入框改写掉。**这样就够**是因为父级的规范化幂等且保语义，于是「回灌值 = 我这份草稿的规范化」等价于「这次回灌是我自己引起的」。

**`buildUrlWithParams` 绝不接收 `tab.auth`**（§4）。这条要写成模块注释，否则下一个人会为了让 §2「更完整」而把 API key 拼进去。

### 2.5 `src/components/request/UrlBar.vue`

新增 prop `tabId`；`draft` + `draftTabId` 两个 ref，`watch([() => props.url, () => props.tabId])` 里调 `reconcileUrlBarValue`；`<input :value="draft">`；`detectedVariables` 改读 `draft`；`onKeydown` 增加 `if (props.isLoading) { return }`；`onPaste` 改为：

```ts
const decision = interpretPastedText(text)
if (shouldPreventDefaultPaste(decision)) { event.preventDefault(); emit("pasteCurl", decision) }
else { emit("pasteFallback", decision) }       // 不 preventDefault，浏览器照常插入
```

### 2.6 `src/utils/curl-import.ts`（新增，纯函数）

`interpretPastedText` / `shouldPreventDefaultPaste` / `tabUpdatesFromParsedCurl` / `CURL_WARNING_KEYS: Record<CurlImportWarningCode, string>` / `warningMessageKeys`。`tabUpdatesFromParsedCurl` 里 `const { url, params } = syncParamsFromUrl(parsed.url, [])`，**`url` 取 synced 的**，并**无条件**写 `importNotice: noticeFor(parsed.warnings)`（空 warning 时为 `undefined`，从而实现「被下一次导入整体取代」）。

`tryParseCurl` 包住 `parseCurl` 的三个 throw 点。为让 `curlImport.error.unsupportedMethod` 有真正的载体，`curl-parser.ts` 的三处 `throw new Error(...)` 改抛带 `code` 与 `detail` 的错误类，**消息文本保留原有关键信息**（已核实既有断言是 `toThrow(new RegExp(verb))`，因此仍绿）。这是本切片对导入导出切片文件的唯一改动。

### 2.7 `src/utils/env-rows.ts`（新增，纯函数）

`seedEnvRows` / `withTrailingBlankRow` / `updateEnvRow`（只改内容，**绝不重算 id**）/ `removeEnvRow` / `toEnvVariables` / `shouldReseedEnvRows`。面板把 `rows` 由 `computed` 改 `ref`，`watch` 里按 `shouldReseedEnvRows` 决定是否重播种——**必须的**：请求前脚本会从外部调 `setVariables`，而我们自己的 `commitRows` 也走同一个 store 写入。

### 2.8 历史分组的身份（R1-I1）

rev1 声称「删掉 `label` 就是结构性保证」，**这是错的**：实现者完全可以写 `collapsedGroups[group.displayLabel]`、`:key="group.displayLabel"`，照样过 `vue-tsc`，原缺陷原样存在。rev2 改为：

```ts
declare const historyGroupIdBrand: unique symbol
export type HistoryGroupId = string & { readonly [historyGroupIdBrand]: true }
export interface HistoryGroup {
  id: HistoryGroupId
  displayLabel: string
  entries: HistoryEntry[]
  count: number
}
```

`HistoryPanel.vue` 的折叠状态改为 `ref<Set<HistoryGroupId>>`，`toggleGroup(id: HistoryGroupId)`。**`Set<HistoryGroupId>` 的 `has()` / `add()` 只接受 `HistoryGroupId`**，传 `group.displayLabel`（普通 `string`）是类型错误——这一半确实是结构性的。

**如实限定**：`v-for` 的 `:key` 接受任意 `string`，**branded type 挡不住 `:key="group.displayLabel"`**。所以：

- §20（折叠状态）由 branded 类型 + **组件断言**共同保证；
- §21（渲染身份）只由**源码 gate** 保证，它断的是「模板里 `:key` 绑定到 `group.id`」这一事实，**不是**「重复 key 会导致错误的 patch 行为」。该限制写进测试文件注释，并有对应的人工检查点（4.5-c）。

### 2.9 其余改动点

| 文件 | 改动 |
|---|---|
| `src/stores/request.ts` | `sendRequest` **第一行**（在 `activeRequestIds.set` 之前）`if (activeRequestIds.has(tab.id)) { return }`。放 store 不放组件：两个调用点加将来任何新入口都被同一条结构性拦截（P8） |
| `src/stores/tabs.ts` | `openHistoryEntry` 复用谓词加 `!candidate.projectName && !candidate.savedRequestPath &&` |
| `src/stores/console.ts` | `useConsoleStore(getActivePinia() ?? pinia)`；新增 `export const CONSOLE_LEVELS = [...] as const`，`ConsoleLevel` 由它派生 |
| `src/components/panels/RequestPanel.vue` | 两条导入路径改用 `tabUpdatesFromParsedCurl`；渲染通知条（warning 行 + `pasteFailure` 行 + ✕）；给 `UrlBar` 传 `tab-id`；接 `pasteFallback` |
| `src/components/sidebar/EnvironmentPanel.vue` | `rows` 改 `ref` + 2.7 |
| `src/components/sidebar/HistoryPanel.vue` | 折叠状态改 `Set<HistoryGroupId>`；展示处用 `displayLabel` |
| `src/components/sidebar/CollectionPanel.vue` | `exportCurrentProject` 调 `collectPostmanExportWarnings(requests)` → `exportFeedbackFor(warnings)` → `setFeedback` |
| `src/components/layout/DebugConsole.vue` | `filterOptions` 由 `buildConsoleFilterOptions()` 提供 |
| `src/components/request/BodyEditor.vue` | 三处硬编码英文改 `t()` |
| `src/i18n/*.ts` | 7 个继承 key + 11 个新 key + 改写 `importCurlDescription` |

## 3. 跨切片与边界

### 3.1 文件边界

裁定 **A15** 已批准 D05 扩至 `src/stores/**`、`src/utils/**`、`src/i18n/**`。`src-tauri/**` 一个字不动。

**新增申请**：引入 `@vue/test-utils` 与 `happy-dom` 两个 devDependency（见 4.1），需要一次与 A11 / A13 同型的裁定。起草者**无法在本工作树验证安装**——`node_modules` 为空，`vue` 解析到父仓库；`@vue/test-utils` / `happy-dom` / `jsdom` 三者 `require.resolve` 全部 MISSING。因此该方案的**可行性未经实证**，4.3 的 harness 自检是它的 fail-closed 前置。

### 3.2 与仍在飞行的切片的冲突

裁定 **A18**：D05 先、D04 后（同 `src/stores/tabs.ts` 的不同函数）。HTTP 报文切片只动 Rust，无冲突。

### 3.3 与已合并切片的既有测试的交互

| 交互 | 状态 |
|---|---|
| 「URL 栏 query 与线上 query 一致」表驱动测试 | **不受影响**：四行 fixture 全是字面量参数、无空白 key，0.3 已证逐字节等价 |
| 同文件的 `splitUrlParts` 形状断言 | **必须改**（2.1 末尾），受控改动 |
| 控制台网络行测试（从模块单例读条目） | **实测不受影响**（0.5）。仍须在改完 `console.ts` 后复跑全套并把结果写进 ACCEPTANCE |
| 「不得退化成 method+url 去重」测试 | 本切片只**收紧**复用条件，继续成立，并被 §23 重新锁定 |
| `curl-parser` 的 `toThrow(new RegExp(verb))` | 改抛带 code 的错误类后仍绿（消息保留 verb） |
| `postman-export.test.ts` 的 `IPC_NULL` 与内联 fixture | **不受影响**——rev2 不再改判据（0.6） |
| `encodeQueryComponentPreservingTemplates` 的既有测试 | 2.3 只换内部实现、不改行为，必须继续绿 |

### 3.4 追溯：backlog / 交接 → 不变式

| 来源 | 位置（按符号） | 不变式 |
|---|---|---|
| D05 high | `EnvironmentPanel.vue` 的 `rows` | 14–18 |
| D05 high | `buildUrlWithParams` + `UrlBar.detectedVariables` | 1–9 |
| D05 med | `UrlBar.onKeydown` | 10–13 |
| D05 med | `HistoryPanel` 的折叠状态 + `history-grouping.ts` | 19–21 |
| D05 med | `tabs.openHistoryEntry` | 22–23 |
| D05 med（从导入导出切片移入） | `RequestPanel.applyCurlImport` / `applyPastedCurl` | 24–26 |
| D05 low | 同上（空 catch） | 27–30 |
| D05 low | `DebugConsole.filterOptions` | 41–44 |
| D05 low | `console.recordConsoleEntry` | 45–46 |
| 交接 B1 | `UrlBar.onPaste` + 空 catch | 27–30 |
| 交接 B2 | `parseCurl` 的 `warnings` 无渲染点 | 31–37 |
| 交接 B3 | `collectPostmanExportWarnings` 无调用点 | 38–40 |
| 交接（i18n，裁定 A16） | 7 个 key + `importCurlDescription` | 47–49 |

1–49 全部有来源、全部有验证条目，无孤儿。

## 4. Testing and validation

命令：`npm run test`。声称完成前自跑 `npm run release:check`。

### 4.1 组件测试的引入与硬性适用面（R1-C3）

**rev1 的论证只有一半成立，这里更正。** rev1 写的是「DOM 模拟环境的焦点/选区模型不是 WebKit 的，绿灯比没有覆盖更糟」——**这一半仍然成立**，并且正是下面那条禁令的理由。但 rev1 据此拒绝了**全部**组件测试，那是把「不能用它证明 WebKit 焦点行为」错误地推广成「不能用它验证普通的 Vue 接线」。两者不是一回事：前者依赖浏览器实现，后者只依赖 Vue 运行时，而 Vue 运行时在任何 DOM 实现上都一样。

现在的缺口正是接线：`pasteFallback` 的接收、失败原因的渲染、`warningMessageKeys` 的实际调用、告警行的条数、`exportFeedbackFor` 到集合 feedback 的接线、过滤按钮的渲染。**实现者可以把每个 helper 都写对、一个都不接，而纯函数测试与人工清单全部通过**——这正是本切片按 HIGH 处理的那类缺陷落在自己身上。grep 清单不是 gate，它不会红。

**选择：引入 `@vue/test-utils` + `happy-dom`。** 理由：`?raw` 源码 gate 断的是文本而非行为——它无法区分「✕ 真的调用了 `updateTab`」与「源码里出现过这串字符」，一条注释就能满足它；而本切片要挡的恰恰是「看起来接上了、其实没有」。源码 gate 只在**挂载无法回答**的两处保留（§21 的 `:key` 绑定、§44 的字面量清除），并各自写明限制。

选 `happy-dom` 而非 `jsdom`：更轻、启动更快。**不改 `vitest.config.ts` 的全局 `environment`**——组件测试文件各自用 `// @vitest-environment happy-dom` 文件头 docblock，现存 20 个文件的 `node` 环境零变化。所有组件测试一律 `shallowMount`（子组件全部 stub），避免把 CodeMirror 拉进 DOM 模拟环境。

**硬性适用面（越界按缺陷处理，PRODUCT Non-goals 已同文写明）**：组件测试只允许断言 (1) 发出的事件、(2) 传给子组件的 props、(3) `v-if`/`v-for` 的存在性与条数、(4) 对 store 或注入函数的调用。**禁止**断言焦点、选区、光标、布局、`document.activeElement`。

**未实证的可行性**：见 3.1。4.3 的 harness 自检必须先通过，否则本节全部作废、回退源码 gate 并重报 owner。

### 4.2 不变式 → 测试 → 承重断言 → 变异检查

「可测性」四类：**纯函数** / **store**（既有 pinia 测试形态）/ **组件**（4.1 的受限挂载）/ **源码**（`?raw` 文本 gate）。
变异检查一律最小可编译 patch；共用 killer 与非承重断言**如实标注**。

| § | 测试文件 | 测试名 | 可测性 | 承重断言（只让它单独塌的那一条） | 最小可编译 patch |
|---|---|---|---|---|---|
| 1 | url-params | `keeps template spans verbatim (%s)`（5 行） | 纯函数 | 输出等于含花括号的期望串 | `if (isTemplateSpan(segment))` → `if (false)` |
| 2 | url-params | `encodes params exactly as the backend does`（35 字符样本） | 纯函数 | 逐字节相等 | `encoded.toString().slice(2)` → `encodeURIComponent(segment)` → 空格与 `!~()'` 六行红，模板行仍绿 |
| 3 | url-params | `ignores a whitespace-only key like the backend does` | 纯函数 | 输出不含该行 | `item.enabled && item.key.trim()` → `item.enabled && item.key` |
| 4 | RequestPanel.spec | `never renders the query api key into the url bar` | 组件 | 传给 UrlBar 的 `url` prop 不含 apiKey 的值 | `RequestPanel.vue` 模板单行替换为把 apiKey 拼进 params 的版本：`:url="buildUrlWithParams(activeTab.url, [...activeTab.params, { id:'x', enabled:true, key: activeTab.auth.apiKey?.key ?? '', value: activeTab.auth.apiKey?.value ?? '', description:'' }])"` |
| 5 | url-params | `lists template variables from path and query` | 纯函数 | 查询串变量出现在结果里 | `/\{\{\s*([^{}]+?)\s*\}\}/g` → `/^\{\{\s*([^{}]+?)\s*\}\}/g` → 查询行红、路径行绿 |
| 6 | url-params | `renders exactly what was typed (%s)`（0.4 的 10 个目标） | 纯函数 | 末态显示串 === 目标串 | `return sameParse(…) ? previous.draft : incoming.url` → `return incoming.url` |
| 7 | url-params | `keeps a pasted plain url byte-identical` | 纯函数 | — | **与 §6 共用 killer，不独立可杀**。登记为 §6 在单次输入下的实例，**不计入独立统计** |
| 8 | url-params | `adopts an external url change while a draft exists` | 纯函数 | 「Params 表改了值、base 未变」这一行 | `sameParse` 的 `JSON.stringify(pa) === JSON.stringify(pb)` → `pa.url === pb.url` |
| 9 | url-params | `never shows another tab's draft` | 纯函数 | 切 tab 后显示新 tab 的 url | 删掉 `previous.tabId !== incoming.tabId` 分支（保留 `if (!previous) return incoming.url`） |
| 10 | request | `refuses a second send while one is in flight` | store | `send_request` 调用次数 === 1 | `if (activeRequestIds.has(tab.id)) { return }` 整行删除 |
| 11 | request | `refuses before minting the new request id` | store | 在途请求的 response 落在 tab 上（`append_history` 恰好一次） | 把该守卫行**移到** `activeRequestIds.set(requestSnapshot.id, requestId)` **之后**（两行 diff）。**§10 在此 mutant 下仍绿**——第二次调用照样早退，被毁的是第一次的账 |
| 12 | request | `allows a new send after the previous one settles` | store | 第二次 `send_request` 发生 | `finally` 里 `activeRequestIds.delete(tabId)` 整行删除 |
| 13 | UrlBar.spec | `does not emit send on Enter while loading` | 组件 | `emitted().send` 为 undefined | `if (props.isLoading) { return }` 整行删除 |
| 14 | env-rows | `keeps row identity across a %s edit`（key/value/secret）+ `commits every character of a key` | 纯函数 | 编辑后 id 不变 | `{ ...row, ...patch }` → `{ ...row, ...patch, id: crypto.randomUUID() }` |
| 15 | env-rows | `removes only the targeted row`（含重名、含空行） | 纯函数 | 剩余行的 key 序列 | `rows.filter((row) => row.id !== id)` → `rows.filter((_row, index) => index !== 0)` |
| 16 | env-rows | `keeps exactly one trailing blank row`（3 行） | 纯函数 | 「末行被清空后不新增」这一行 | `if (!last \|\| last.key \|\| last.value)` → `if (true)` |
| 17 | env-rows | `reseeds when variables are replaced from outside` | 纯函数 | 返回 true | `shouldReseedEnvRows` 函数体 → `return false` |
| 18 | env-rows + environments | `never lets a row id reach the persisted payload` | 纯函数 + store | `save_environment` 负载的变量对象无 `id` 键 | `.map(({ key, value, secret }) => ({ key, value, secret }))` → `.map((row) => row)` |
| 19 | history-grouping | `gives distinct ids when display labels collide`（prefix/method/time 三行） | 纯函数 | 两个分组 id 不等 | `id: key` → `id: displayLabel` |
| 20 | HistoryPanel.spec | `collapsing one group leaves its same-labelled sibling expanded` | 组件 | 第二个分组的条目仍被渲染 | `collapsedGroupIds.has(group.id)` → `collapsedGroupIds.has(group.displayLabel as HistoryGroupId)` |
| 21 | source-gates | `binds the group v-for key to the id` | 源码 | 模板中 `:key="group.id"` 存在 | `:key="group.id"` → `:key="group.displayLabel"`。**限制**：断的是源码文本，**不是** patch 行为（4.5-c 补人工） |
| 22 | tabs-history | `never reuses a collection-bound tab` | store | **tab 数 +1**。`label`/`projectName`/`savedRequestPath`/`isDirty` 四条在同一 mutant 下一起红，**登记为佐证，不声称独立可杀** | 谓词中 `!candidate.projectName && !candidate.savedRequestPath &&` 删除 |
| 23 | tabs-history | `still reuses an unbound empty tab with identical identity` | store | 复用发生（tab 数不变） | `serializeRequestIdentity(candidate) === serializeRequestIdentity(tab)` → `candidate.method === tab.method && candidate.url === tab.url` |
| 24 | curl-import | `leaves no query string in tab.url after an import` | 纯函数 | `url` 不含 `?` | `url,` → `url: parsed.url,` |
| 25 | curl-export | `emits an imported query param exactly once` | 纯函数 | 命令里 `q=cat` 出现 1 次 | `curl-export.ts`：`const { baseUrl, hash } = splitUrlParts(tab.url)` → `const baseUrl = tab.url, hash = ""` |
| 26 | postman-export | `emits an imported query param exactly once in url.raw` | 纯函数 | `url.raw` 里 `q=cat` 出现 1 次 | `postman-export.ts` 的 `buildRawUrl`：`const { baseUrl, hash } = splitUrlParts(url)` → `const baseUrl = url, hash = ""`。**与 §25 是两个独立 killer**，rev1 只给了前者 |
| 27 | curl-import | `does not swallow a curl-looking paste that fails to parse`（2 行） | 纯函数 | `shouldPreventDefaultPaste` 为 false | `decision.action === "import"` → `true` |
| 28 | curl-import | `reports why the paste was not imported` | 纯函数 | `reason` 非空 | `{ action: "insert", reason: attempt.message }` → `{ action: "insert" }`（§27 仍绿） |
| 29 | RequestPanel.spec | `renders the paste failure reason` | 组件 | 通知条内出现该 reason 文本 | 删掉模板中渲染 `importNotice.pasteFailure` 的那一行 |
| 30 | curl-import | `still imports a parsable curl paste` | 纯函数 | `action === "import"` | `if (!trimmed \|\| !/^curl\s/i.test(trimmed)) { return { action: "insert" } }` → `return { action: "insert" }` |
| 31 | curl-import + locale-parity | `maps every warning code to a resolvable localized key`（4 code） | 纯函数 | 该 code 的 key 在两个 locale 里都解析出非 key 本身的文案 | `CURL_WARNING_KEYS` 任一值 → `"curlImport.warning.nope"`。**完备性另有结构性保证**：`Record<CurlImportWarningCode, string>` 使漏掉一个 code 编译不过 |
| 32 | RequestPanel.spec | `renders one line per parser warning` | 组件 | 渲染行数 === warning 数 | `v-for="line in noticeLines"` → `v-for="line in noticeLines.slice(0, 1)"` |
| 33 | curl-import | `replaces the notice on the next import` | 纯函数 | 第二次（无 warning）导入后 `importNotice` 为 undefined | `importNotice: noticeFor(parsed.warnings),` → `...(parsed.warnings.length ? { importNotice: noticeFor(parsed.warnings) } : {}),` |
| 34 | RequestPanel.spec | `clears the notice when dismissed` | 组件 | `updateTab` 被以 `{ importNotice: undefined }` 调用 | ✕ 按钮的 `@click` 整行删除 |
| 35 | request | `sends normally while an import notice is present` | store | `send_request` 被调用 | 在 `sendRequest` 守卫之后插入一行 `if (tab.importNotice) { throw new Error("blocked") }` |
| 36 | request | `never persists the import notice to history` | store | `append_history` 负载无该键 | 在 `buildHistoryEntry` 返回对象加一行 `importNotice: tab.importNotice,` |
| 37 | saved-request | `never persists the import notice to a saved request` | 纯函数 | `buildSavedRequest` 结果无该键 | 在 `buildSavedRequest` 返回对象加一行 `importNotice: tab.importNotice as never,`。**与 §36 是两个独立 killer**，rev1 只给了前者 |
| 38 | CollectionPanel.spec | `collects export warnings and hands them to feedback` | 组件 | `collectPostmanExportWarnings` 的 spy 被调用，且其返回值到达 `setFeedback` | `exportCurrentProject` 里调用 `collectPostmanExportWarnings(requests)` 的那一行删除 |
| 39 | collection-feedback | `reports plain success when there are no warnings` | 纯函数 | tone === `"success"` 且无次行 | `exportFeedbackFor` 的 `tone: warnings.length > 0 ? "warning" : "success"` → `tone: "warning"` |
| 40 | collection-feedback | `still reports success when warnings exist` | 纯函数 | 主行仍是 `export.success` | `primary: "export.success"` → `primary: ""`（§39 仍绿） |
| 41 | console-filters | `offers a filter for every console level` | 纯函数 | 选项覆盖全部 level | `...CONSOLE_LEVELS` → `...CONSOLE_LEVELS.filter((level) => level !== "info")` |
| 42 | console-filters + locale-parity | `uses an i18n key for every filter label` | 纯函数 | 每个 labelKey 在两个 locale 里存在 | ``labelKey: `console.level.${level}` `` → `labelKey: level` |
| 43 | DebugConsole.spec | `renders one button per filter option` | 组件 | 按钮数 === 选项数 | 模板中过滤按钮的 `v-for` 整行删除 |
| 44 | source-gates | `keeps hard-coded english out of the localized components` | 源码 | 目标字面量不出现在源码里 | `BodyEditor.vue` 的 `{{ t("body.type") }}` → `Type`。**限制**：证明「字面量不在那里」，**不是**「翻译真的被渲染了」（4.5-e 补人工） |
| 45 | console | `does not rebind the caller's active pinia` | store | `getActivePinia()` 身份不变（**该用例只断言这一句**） | `useConsoleStore(getActivePinia() ?? pinia)` → `useConsoleStore(pinia)`。**已实跑**（0.5） |
| 46 | console | `leaves the module singleton untouched` | store | 模块单例条目数 === 0（**该用例前一句在此 mutant 下仍通过，故单塌成立**） | 同 §45 一行。**共用 mutant，但各有单塌用例**——已实跑（0.5） |
| 47 | locale-parity | `defines every inherited key with its placeholder`（7 key） | 纯函数 | 该 key 的文案含约定占位符 | 从 `zh-CN.ts` 的 `curlImport.warning.dataDiscarded` 删掉 `{detail}`（§49 仍绿） |
| 48 | locale-parity | `describes the flags the parser actually supports` | 纯函数 | 文案含 `--data-urlencode` | `importCurlDescription` 改回原文 |
| 49 | locale-parity | `zh-CN and en expose the same key set`（既有） | 纯函数 | 键集相等 | 从 `en.ts` 删掉任一新键 |

### 4.3 harness 自检与 fail-closed 执行协议（P12）

**在跑任何真实变异之前**，先证明度量装置本身能报红：

1. **组件 harness 自检**：写一个必然失败的组件断言（例如断言 `shallowMount(UrlBar)` 渲染出 999 个按钮），运行，**必须**看到 `Tests … failed` 且失败条目里有它。看不到 ⇒ happy-dom / test-utils 没装好 ⇒ **4.1 整节作废，回退源码 gate 并重报 owner**。
2. **纯函数 harness 自检**：把 `splitTemplateSpans` 改成 `return []`，确认相关用例转红。

真实变异台账的判定规则：

- **只有在输出里 positively 匹配到 vitest 的汇总行**（`Test Files …` 与 `Tests …`，且解析出的 `passed + failed > 0`）时，本次运行才产生结论。匹配不到 ⇒ **`INCONCLUSIVE`**，既不记「杀死」也不记「存活」。
- 解析出的 failed 计数与列出的失败用例名数量不一致 ⇒ **`INCONCLUSIVE`**。
- **组件测试专属**：挂载抛异常导致的失败是 `ERROR`，不是「杀死」。必须区分「断言被违反」与「组件根本没挂起来」——后者对该不变式记 `INCONCLUSIVE`。
- 变异后若 `vue-tsc` 编译不过，该 patch 不是合法 killer（P3），改写 patch，**不得**记为「杀死」。

### 4.4 实现者必须先跑掉的两件事

**(a) 后端的空格编码**（0.7，§2 的前提）。临时 Rust 测试断言 `Url::parse("https://x/a").query_pairs_mut().append_pair("q","a b")` 得到 `q=a+b`。结果（无论正反）写进 ACCEPTANCE，**跑完即删**，不留在 `src-tauri/`。

**(b) 依赖裁定**。`@vue/test-utils` + `happy-dom` 未获裁定前不得写入 `package.json`（3.1）。

### 4.5 人工验收（打包版 macOS App，WebKit）

只保留自动化**结构上**覆盖不到的部分：

- **a（§14 的焦点面）**：环境面板空白行连续键入 `baseUrl` 不点别处——键名必须完整、光标不丢；已有变量退格一次焦点仍在。
- **b（§13 的真机面）**：慢接口上按住回车 3 秒，终端侧只有 1 次请求。
- **c（§21 的行为面）**：两个同文案分组，折叠一个另一个不动（源码 gate 只证明了绑定，没证明 patch 行为）。
- **d（§29/§32/§34 的视觉面）**：粘贴带 `-b cookies.txt` 的 curl，通知条出现、切走切回仍在、✕ 后消失。
- **e（§44 的渲染面）**：中文界面下逐一确认控制台四个过滤按钮、cURL 示例、form-data 的 Type/Text/File 均为中文。
- **f（§1–§9 的真实输入）**：逐字符手打 `https://api.test/a?x=1` 必须原样出现；粘贴 `…?api_key={{apiKey}}` 后地址栏显示花括号且出现「包含变量：apiKey」。
- **g**：通知条与告警条出现时，1024×768 下不换行不溢出。

### 4.6 分层统计与自查（P10，rev1 此处报错）

**rev1 的分层本身是错的**，逐条更正：

| rev1 的说法 | 实际 |
|---|---|
| 「表 40 行」 | 41 行（40 条 + §26b） |
| 「34 条有可编译 killer」 | 38 条（§1–§40 中除 §9 / §17 外全部有） |
| 「§25/§28 由类型系统兜底，属第二类结构性保证」 | §26b 才是 MANUAL；把它算成结构性保证是分类错误 |
| 「没有一个 killer 落在 `.vue` 里」 | **与 §35 直接矛盾**——那条 killer 明确改 `BodyEditor.vue` |
| §8 / §18「多条断言一起红」 | 正是 P9 禁止的形态，rev2 已拆 |

**一个错误的分层会给出「所有条目均已可靠覆盖」的错误结论——这正是 P10 要防的，只是这次错在度量端而不是结论端。**

rev2 的度量（可由上表逐行复核，共 **49** 行，无子编号）：

| 类别 | 条数 | 编号 |
|---|---|---|
| 有独立可编译 killer | **48** | 1–6、8–49 |
| 无独立 killer，登记为冗余 | **1** | §7（与 §6 共用，已标注） |
| ——其中 纯函数 | 30 | 1,2,3,5,6,7,8,9,14,15,16,17,18,19,24,25,26,27,28,30,31,33,37,39,40,41,42,47,48,49 |
| ——其中 store | 10 | 10,11,12,18,22,23,35,36,45,46 |
| ——其中 组件 | 8 | 4,13,20,29,32,34,38,43 |
| ——其中 源码 gate | 2 | 21,44 |
| 另有类型系统附加保护（非 killer） | 2 | §31 的 `Record` 完备性、§20 的 branded `Set` |

（30 + 10 + 8 + 2 = 50；**§18 同时用纯函数与 store 两层，两栏各计一次**，故去重后恰为 49。这四栏已逐编号列出，可直接复核——rev1 就是在这一格上报错的，所以这里不写汇总数字而写编号。）

结论及其适用范围（**与度量分开写**）：

- 49 条里 48 条有可编译 killer，**其中 8 条打在组件上、2 条打在 `.vue` 源码文本上**——rev1 那句「没有一个 killer 落在 `.vue` 里」在 rev2 已不成立，不得再被引用。
- **仍未被自动化证明的部分**：WebKit 的焦点/选区行为（§14 的真机面）、重复 `:key` 导致的错误 patch 行为（§21 的行为面）、翻译文案的实际渲染（§44 的渲染面）、1024×768 的排版。这四项在 4.5 有对应检查点，**不计入「已被测试证明」**。
- **§7、§22 的四条附属断言、§46 用例里的第一句**是已登记的非承重项，任何汇总不得把它们算作独立证据。
- 组件层那 8 条的有效性**全部以 4.3-1 的 harness 自检通过为前提**；自检未通过之前，它们一条都不成立。

## 5. Risks and rollback

| 风险 | 缓解 |
|---|---|
| 0.7 的推断若为假 | 4.4-a 是硬前置，跑在写代码之前 |
| 组件测试工具链装不起来 | 4.3-1 的 harness 自检 fail-closed；失败即回退源码 gate 并重报 owner |
| 组件测试越界去断言焦点 | PRODUCT Non-goals 与 4.1 同文写死适用面，越界按缺陷处理 |
| 草稿缓冲引入新的显示/状态分叉 | §8 锁「外部变化必须被采纳」，§6 锁「打字期间不被改写」，互为边界 |
| `Tab` 又多一个内存态字段 | §36 / §37 两个独立 killer 分别锁历史与已保存请求 |
| branded `HistoryGroupId` 挡不住 `:key` | 已如实写明（2.8），§21 源码 gate + 4.5-c 人工检查点 |

**回滚**：四个互不依赖的单元——URL 栏、环境行、导入告警、导出告警。i18n 键增补跟着各自单元走，回滚时须同步删键，否则 §49 会红。

## 6. 受控裁定申请（不进不变式）

**申请事项**：集合导出时，是否应当对**任何**文件型表单行 / 二进制体提示用户「在 Postman 里需要重新选择该文件」？

**为什么值得问**：按 main 现状，集合导出走 `loadRequest`，内容字段恒为 `null`，因此该告警**永不触发**。用户拿到的产物里 `src` 是一个**文件名而非路径**，Postman 无法解析它——请求在 Postman 里仍然发不出去，而 ApiSolo 什么也没说。这不是缺陷（没有说假话），但是一个沉默的降级。

**为什么不由本切片自行决定**：它会改动一个刚冻结、刚加了回归测试的判据，属于对另一切片的受控修订，必须先经 owner（P1 第 3 条）。**rev1 正是在这里越了线**——以「修 bug」的名义静默覆盖了一份已合并的修法。

**若采纳，需要连带变更**（供裁定参考）：判据由「是否持有字节」改为「是否为文件行」；文案必须重写——现文案「内容存在 ApiSolo 里因此无法导出」对 `null` 行是假话，应改为「集合里不含该文件的内容，请在 Postman 中重新选择」；`src` 必须与说明**并存**而非互斥；`postman-export.test.ts` 中断言「`IPC_NULL` 行不产生告警、保留 `src`」的用例需随之改写。

**起草者倾向**：采纳，但**不在本切片**——它是产品行为变更，应作为一条新的 backlog 条目走完整流程，而不是搭 D05 的车。

## 7. 待补：R1 的三条 IMPORTANT

R1 的 verdict 是 **4C + 4I**。本文处置了 4 条 CRITICAL 与 1 条 IMPORTANT（「§17 不是结构性保证」）。**其余 3 条 IMPORTANT 的正文未随裁定一并送达，起草者无法处置。**

按 P4，此处不做任何猜测性处置——不推断它们可能是什么，也不「顺手」改动可能相关的段落。**请补发这 3 条正文，本节将在 rev3 关闭。在此之前，rev2 不应被当作对 R1 的完整回应。**
