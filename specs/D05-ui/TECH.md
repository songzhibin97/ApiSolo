# D05 — UI 交互缺陷（TECH）

> **rev3 — 应 R1 完整修订（4C + 4I）**。rev2 只回应了 4C + 1I。行为定义见 `PRODUCT.md`（**52** 条不变式）。分支 `songzhibin/d05-ui`，起点 `origin/main@dfb2d2e`。
>
> 本轮改动区域逐项枚举：
>
> | R1 项 / 裁定 | 本文改动区域 |
> |---|---|
> | **I2** `sameParse` 分不清 self-echo 与语义相同的外部更新 | 新增 0.9（实跑复现 + 修法验证）；2.4 的协调器改为 **revision 信号**，`sameParse` **整个删除**；2.9 新增 `updateTab` / `updateTabFromUrlBar` 的默认安全设计；映射表 §6 / §8 / §9 / §10 |
> | **I3** i18n 数量与本地化行为不完整 | 新增 0.10（两处硬编码英文 detail 的实读）；2.6 三类 parser error 改稳定 code；映射表新增 §30、§34；4.7 登记对交接清单的偏离 |
> | **I4** `src/types/index.ts` 越界 + 逆向依赖 | 3.1 按裁定 A19 改写；2.2 / 2.6 把 `CurlImportWarningCode` / `CurlImportWarning` 移入 types 层（已核实全仓无第三方 importer，移动无涟漪） |
> | **A19 / A20 / A21** | 3.1 与 4.1 由「申请」改写为**已裁定事实**；源码 gate 限定在 §22 / §47（rev2 编号的 §21 / §44） |
> | 映射表 | 49 行 → **52 行**，与 PRODUCT 同轮对齐，脚本机械核对 |
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

**承重性的如实限定（P9）**：去掉修复后，「条目出现在调用方 pinia 里」这一句**仍然通过**（activePinia 已被翻走，未绑定的 `useConsoleStore()` 解析到的正是被写入的那个模块单例）。真正承重的是另外两句，且**各自有单塌用例**：第一个用例只断言 `getActivePinia()` 身份（§48）；第二个用例的前一句通过、只塌「模块单例为空」（§49）。

### 0.6 rev1 的「起草期新发现」已作废（R1-C1）

rev1 记录的实测——`fileContent: null` 使 `!== undefined` 恒真、导出产物对每个文件行写入假说明并整个丢掉 `src`——**是真的，且已由导入导出切片在 `32b7100` 修复**（判据改为 `typeof fileContent === "string"`）。该缺陷已入账 `specs/BACKLOG.md` 的「已发布缺陷」表，并催生了规则 P11。

起草者已读过 main 现状并确认：两个谓词均为 `typeof … === "string"`；测试文件含 `IPC_NULL` fixture 与 P6 式自检；非内联时 `src` 被保留。

**因此 rev1 的 §29–§31 全部删除。** rev1 的写法（任何文件行都告警 + 沿用「内容只存在于 ApiSolo」文案）会把刚修掉的那句假话原样重造，并推翻已冻结的回归测试。

**这一轮我是在一个当时正确、后来过期的前提上工作的**——记录在此，因为下一个读这份 spec 的人会看到 backlog 那条缺陷署着「D05 规格阶段发现」，需要同时读到它已经不归本切片修。

### 0.7 未验证的推断（按 P4 标注）

**「后端 `query_pairs_mut()` 把空格编码成 `+`」仍是推断，不是实跑。** 依据是它返回 `form_urlencoded::Serializer`。本工作树无预热 `target/`，冷编译 tauri 代价过大。**这条推断是 §2 的前提**，实现者必须在动 `buildUrlWithParams` 之前跑掉它（4.4-a）。若实测为 `%20`，§2 方向反转、改用 `encodeQueryComponentPreservingTemplates`，设计题二的结论随之改变。

「WebKit 下 `:key` 变化导致输入框卸载、焦点掉到 `<body>`」来自来源评审文档的对抗性验证记录，**起草者未独立复现**；§15 的最终确认落在人工验收。

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

### 0.9 I2 的复现与修法验证（本轮实跑）

评审给的复现原样成立。起草者独立跑了一遍（`/tmp/urlbar-rev3.mjs`）：

```
draft            : https://x/a?q=a%20b
incoming (import): https://x/a?q=a+b
sameParse        : true
rev2 reconciler  : "https://x/a?q=a%20b"  <= STALE（I2 缺陷复现）
rev3 reconciler  : "https://x/a?q=a+b"    <= 已采纳
```

**根因**：rev2 用「解析结果是否相同」来判断「这次回灌是不是我自己引起的」。这个代理量在**语义相同但来源不同**时失效——而 cURL 导入恰好会把 `%20` 规范成 `+`，解析结果完全相同。于是状态更新了，界面停在旧串上，正是本切片要消灭的那类谎言。

**修法**：改用显式的来源信号（revision）。同一轮实跑还得到两个结论：

1. **`sameParse` 可以整个删掉**，不是「再加一个判据」。键入模拟 10 个目标串在新协调器下 `TYPING FAILURES = 0`——因为 revision 未变即可判定为 self-echo，无需再比较字符串。**设计变简单了。**
2. **新不变式（§9）的 killer 具有区分度**：把 revision 判据换回 `sameParse`，「Params 表改值」这一类外部更新**仍然被采纳**（解析结果不同），只有 I2 那一类转红。实跑确认该对照成立。

### 0.10 I3 的实读

`curl-parser.ts` 的 `storeAuthorizationValue` 有两个 push 点，**都用同一个 code、靠英文散文 detail 区分**：

```ts
warnings.push({ code: "authorization-not-byte-preserved", detail: "line breaks" })
warnings.push({ code: "authorization-not-byte-preserved", detail: "separator whitespace" })
```

而交接清单里该 key 的中文文案是「Authorization 请求头的原始写法（{detail}）无法……」——`{detail}` 会把 `line breaks` 原样插进中文句子。两处**可以同时触发**（折叠改变了值 **且** 分隔空白不可复现），所以拆成两个独立 code 后会各出一行，语义更准。

三个 throw 点同理：`Invalid cURL command.` / `Unsupported request method: X` / `Unable to find a request URL in the cURL command.` 全是英文字面量，其中只有第二个在交接清单里有 key。

**另核实**：`grep -rn "CurlImportWarning" src/` 除 `curl-parser.ts` 自身外**零命中**，因此按 A19 把这两个类型移进 `src/types/index.ts` 是一次无涟漪的移动。

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

按裁定 **A19**，`CurlImportWarningCode` / `CurlImportWarning` 由 `curl-parser.ts` **移入 `src/types/index.ts`**，parser 与 `Tab` 共同从 types 导入——否则 `Tab` 会经由 types 反向依赖 utils。已核实全仓无第三方 importer（0.10），移动无涟漪。

```ts
// src/types/index.ts
export type CurlImportWarningCode =
  | "file-reference-not-inlined"
  | "data-segments-discarded"
  | "cookie-file-not-supported"
  | "authorization-line-breaks-not-preserved"      // ← 由散文 detail 拆出（§34）
  | "authorization-separator-not-preserved"        // ← 同上
export interface CurlImportWarning { code: CurlImportWarningCode; detail: string }

export type CurlParseErrorCode = "invalid-command" | "unsupported-method" | "no-url"

export interface CurlImportNotice {
  pasteFailure?: { code: CurlParseErrorCode; detail: string }   // §30：原因也要本地化
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

/**
 * 判据是「这次变化是不是我自己引起的」，用显式 revision 表达；**不是**「新旧值
 * 是否语义相同」。后者（rev2 的 sameParse）在 cURL 导入把 %20 规范成 + 时判定
 * 为 self-echo，界面会停在一个已经不存在的旧串上（0.9）。
 */
export function reconcileUrlBarValue(
  previous: { tabId: string; revision: number; draft: string } | null,
  incoming: { tabId: string; revision: number; url: string },
): string {
  if (!previous) { return incoming.url }
  if (previous.tabId !== incoming.tabId) { return incoming.url }
  if (previous.revision !== incoming.revision) { return incoming.url }   // 外部写入
  return previous.draft                                                  // self-echo
}
```

`sameParse` **不再存在**——revision 未变即可判定 self-echo，无需比较字符串。0.9 实测键入保真在删掉它之后仍是 10/10，**设计变简单了一层**。

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

`tryParseCurl` 包住 `parseCurl` 的三个 throw 点，返回 `{ ok: false, code, detail }` 而**不是字符串**——§30 要求三种原因都能本地化，携带英文消息就做不到。`curl-parser.ts` 的三处 `throw new Error(...)` 改抛带 `CurlParseErrorCode` 与 `detail` 的错误类，**消息文本保留原有关键信息**（已核实既有断言是 `toThrow(new RegExp(verb))`，因此仍绿）。

同时按 §34 把 `storeAuthorizationValue` 的两个 push 点改用两个**独立 code**，`detail` 不再承载散文（0.10）。这两处是本切片对导入导出切片文件的全部改动。

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

- §21（折叠状态）由 branded 类型 + **组件断言**共同保证；
- §22（渲染身份）只由**源码 gate** 保证（裁定 A21），它断的是「模板里 `:key` 绑定到 `group.id`」这一事实，**不是**「重复 key 会导致错误的 patch 行为」。该限制写进测试文件注释，并有对应的人工检查点（4.5-c）。

### 2.9 `urlRevision` 的默认安全设计（R1-I2）

协调器要判断「这次回灌是不是我自己引起的」，就需要一个**由写入方给出**的信号。风险是显而易见的：将来有人新增一个 `tab.url` 的写入点却忘了递增 revision，界面就会停在旧草稿上——又一条静默的谎言。

因此**把默认设成安全的那一侧**：

```ts
// src/stores/tabs.ts
function updateTab(id, updates)            // 只要 updates 含 url 或 params，就递增 tab.urlRevision
function updateTabFromUrlBar(id, updates)  // 唯一不递增的路径，仅供 URL 栏自己的 updateUrl 使用
```

任何新写入点走普通 `updateTab` 就自动拿到正确行为；**忘记的后果是「多采纳一次」（草稿被规范形式替换，纯外观），而不是「少采纳一次」（界面显示已不存在的旧串）。失败方向是安全的**——这正是 P8 说的、把缺陷做成难以表达，而不是靠测试去追。

`urlRevision` 与 `importNotice` 一样是纯内存态，不进任何持久化负载。

### 2.10 其余改动点

| 文件 | 改动 |
|---|---|
| `src/stores/request.ts` | `sendRequest` **第一行**（在 `activeRequestIds.set` 之前）`if (activeRequestIds.has(tab.id)) { return }`。放 store 不放组件：两个调用点加将来任何新入口都被同一条结构性拦截（P8） |
| `src/stores/tabs.ts` | `openHistoryEntry` 复用谓词加 `!candidate.projectName && !candidate.savedRequestPath &&`；新增 2.9 的两条写入路径 |
| `src/types/index.ts`（裁定 A19） | `CurlImportWarningCode` / `CurlImportWarning` / `CurlParseErrorCode` / `CurlImportNotice` 迁入；`HistoryGroup` 改 branded id；`Tab` 追加 `importNotice` 与 `urlRevision` |
| `src/stores/console.ts` | `useConsoleStore(getActivePinia() ?? pinia)`；新增 `export const CONSOLE_LEVELS = [...] as const`，`ConsoleLevel` 由它派生 |
| `src/components/panels/RequestPanel.vue` | 两条导入路径改用 `tabUpdatesFromParsedCurl`；渲染通知条（warning 行 + `pasteFailure` 行 + ✕）；给 `UrlBar` 传 `tab-id`；接 `pasteFallback` |
| `src/components/sidebar/EnvironmentPanel.vue` | `rows` 改 `ref` + 2.7 |
| `src/components/sidebar/HistoryPanel.vue` | 折叠状态改 `Set<HistoryGroupId>`；展示处用 `displayLabel` |
| `src/components/sidebar/CollectionPanel.vue` | `exportCurrentProject` 调 `collectPostmanExportWarnings(requests)` → `exportFeedbackFor(warnings)` → `setFeedback` |
| `src/components/layout/DebugConsole.vue` | `filterOptions` 由 `buildConsoleFilterOptions()` 提供 |
| `src/components/request/BodyEditor.vue` | 三处硬编码英文改 `t()` |
| `src/i18n/*.ts` | 6 个继承 key + 13 个新 key + 改写 `importCurlDescription`（继承的第 7 个被两个新 key 取代，见 4.7） |

## 3. 跨切片与边界

### 3.1 文件边界（已裁定，非申请）

- **A15**：D05 的范围扩至 `src/stores/**`、`src/utils/**`、`src/i18n/**`。
- **A19**：`src/types/index.ts` **加入该范围**，并把 `CurlImportWarningCode` / `CurlImportWarning` 移到 types 层，由 parser 与 `Tab` 共同导入，消除 types → utils 的逆向依赖。rev2 在这里有一个漏洞：它规定了 `Tab.importNotice` 与 branded `HistoryGroupId`，**两者都必然要改 `src/types/index.ts`**，而 A15 并未覆盖该文件。
- **A20**：批准 `@vue/test-utils` + `happy-dom` 作为 devDependency，限定同 A11 / A13——**仅限该声明**。
- `src-tauri/**` 一个字不动。

**仍未实证的一点**：起草者**无法在本工作树验证安装**——`node_modules` 为空，`vue` 解析到父仓库，`@vue/test-utils` / `happy-dom` / `jsdom` 三者 `require.resolve` 全部 MISSING。裁定解决的是**许可**，不是**可行性**；4.3 的 harness 自检仍是它的 fail-closed 前置。

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
| D05 high | `EnvironmentPanel.vue` 的 `rows` | 15–19 |
| D05 high | `buildUrlWithParams` + `UrlBar.detectedVariables` | 1–10 |
| D05 med | `UrlBar.onKeydown` | 11–14 |
| D05 med | `HistoryPanel` 的折叠状态 + `history-grouping.ts` | 20–22 |
| D05 med | `tabs.openHistoryEntry` | 23–24 |
| D05 med（从导入导出切片移入） | `RequestPanel.applyCurlImport` / `applyPastedCurl` | 25–27 |
| D05 low | 同上（空 catch） | 28–32 |
| D05 low | `DebugConsole.filterOptions` | 44–47 |
| D05 low | `console.recordConsoleEntry` | 48–49 |
| 交接 B1 | `UrlBar.onPaste` + 空 catch | 28–32 |
| 交接 B2 | `parseCurl` 的 `warnings` 无渲染点 | 33–40 |
| 交接 B3 | `collectPostmanExportWarnings` 无调用点 | 41–43 |
| 交接（i18n，裁定 A16） | 6 个继承 key + 13 个新 key + `importCurlDescription` | 50–52 |
| R1-I2 | `reconcileUrlBarValue` 的判据 | 9 |
| R1-I3 | 三个 parser throw 点 + `storeAuthorizationValue` 的散文 detail | 30, 34 |

1–52 全部有来源、全部有验证条目，无孤儿。

## 4. Testing and validation

命令：`npm run test`。声称完成前自跑 `npm run release:check`。

### 4.1 组件测试的引入与硬性适用面（R1-C3）

**rev1 的论证只有一半成立，这里更正。** rev1 写的是「DOM 模拟环境的焦点/选区模型不是 WebKit 的，绿灯比没有覆盖更糟」——**这一半仍然成立**，并且正是下面那条禁令的理由。但 rev1 据此拒绝了**全部**组件测试，那是把「不能用它证明 WebKit 焦点行为」错误地推广成「不能用它验证普通的 Vue 接线」。两者不是一回事：前者依赖浏览器实现，后者只依赖 Vue 运行时，而 Vue 运行时在任何 DOM 实现上都一样。

现在的缺口正是接线：`pasteFallback` 的接收、失败原因的渲染、`warningMessageKeys` 的实际调用、告警行的条数、`exportFeedbackFor` 到集合 feedback 的接线、过滤按钮的渲染。**实现者可以把每个 helper 都写对、一个都不接，而纯函数测试与人工清单全部通过**——这正是本切片按 HIGH 处理的那类缺陷落在自己身上。grep 清单不是 gate，它不会红。

**已裁定（A20）：引入 `@vue/test-utils` + `happy-dom`。** 理由：`?raw` 源码 gate 断的是文本而非行为——它无法区分「✕ 真的调用了 `updateTab`」与「源码里出现过这串字符」，一条注释就能满足它；而本切片要挡的恰恰是「看起来接上了、其实没有」。**裁定 A21** 相应把源码 gate 限定在**挂载无法回答**的两处（§22 的 `:key` 绑定、§47 的字面量清除），各自写明限制。

选 `happy-dom` 而非 `jsdom`：更轻、启动更快。**不改 `vitest.config.ts` 的全局 `environment`**——组件测试文件各自用 `// @vitest-environment happy-dom` 文件头 docblock，现存 20 个文件的 `node` 环境零变化。所有组件测试一律 `shallowMount`（子组件全部 stub），避免把 CodeMirror 拉进 DOM 模拟环境。

**硬性适用面（裁定 A20 的一部分，越界按缺陷处理；PRODUCT Non-goals 同文写明）**：组件测试只允许断言 (1) 发出的事件、(2) 传给子组件的 props、(3) `v-if`/`v-for` 的存在性与条数、(4) 对 store 或注入函数的调用。**禁止**断言焦点、选区、光标、布局、`document.activeElement`。owner 采纳该边界时的措辞是「rev1 那半论证成立，现在它是这条禁令的书面理由」——即禁令与许可来自同一条判断，不可只取其一。

**许可 ≠ 可行性**：A20 解决的是能不能装，不是装了能不能跑。起草者仍未实证（3.1）。4.3 的 harness 自检必须先通过，否则本节全部作废、回退源码 gate 并重报 owner。

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
| 6 | url-params | `renders exactly what was typed (%s)`（0.4 的 10 个目标） | 纯函数 | 末态显示串 === 目标串 | `return previous.draft` → `return incoming.url` |
| 7 | url-params | `keeps a pasted plain url byte-identical` | 纯函数 | — | **与 §6 共用 killer，不独立可杀**。登记为 §6 在单次输入下的实例，**不计入独立统计** |
| 8 | url-params | `adopts an external url change while a draft exists` | 纯函数 | Params 表改值后显示新值 | 删掉 `previous.revision !== incoming.revision` 整行 |
| 9 | url-params | `adopts an external write that parses identically to the draft` | 纯函数 | 草稿 `%20` 被导入后的 `+` 取代 | 把 revision 判据换回 rev2 的 `sameParse(previous.draft, incoming.url) ? previous.draft : incoming.url`。**§8 在此 mutant 下仍绿**（Params 改值的解析结果不同）——0.9 实跑确认该对照 |
| 10 | url-params | `never shows another tab's draft` | 纯函数 | 切 tab 后显示新 tab 的 url | 删掉 `previous.tabId !== incoming.tabId` 整行 |
| 11 | request | `refuses a second send while one is in flight` | store | `send_request` 调用次数 === 1 | `if (activeRequestIds.has(tab.id)) { return }` 整行删除 |
| 12 | request | `refuses before minting the new request id` | store | 在途请求的 response 落在 tab 上（`append_history` 恰好一次） | 把该守卫行**移到** `activeRequestIds.set(requestSnapshot.id, requestId)` **之后**（两行 diff）。**§11 在此 mutant 下仍绿**——第二次调用照样早退，被毁的是第一次的账 |
| 13 | request | `allows a new send after the previous one settles` | store | 第二次 `send_request` 发生 | `finally` 里 `activeRequestIds.delete(tabId)` 整行删除 |
| 14 | UrlBar.spec | `does not emit send on Enter while loading` | 组件 | `emitted().send` 为 undefined | `if (props.isLoading) { return }` 整行删除 |
| 15 | env-rows | `keeps row identity across a %s edit`（key/value/secret）+ `commits every character of a key` | 纯函数 | 编辑后 id 不变 | `{ ...row, ...patch }` → `{ ...row, ...patch, id: crypto.randomUUID() }` |
| 16 | env-rows | `removes only the targeted row`（含重名、含空行） | 纯函数 | 剩余行的 key 序列 | `rows.filter((row) => row.id !== id)` → `rows.filter((_row, index) => index !== 0)` |
| 17 | env-rows | `keeps exactly one trailing blank row`（3 行） | 纯函数 | 「末行被清空后不新增」这一行 | `if (!last \|\| last.key \|\| last.value)` → `if (true)` |
| 18 | env-rows | `reseeds when variables are replaced from outside` | 纯函数 | 返回 true | `shouldReseedEnvRows` 函数体 → `return false` |
| 19 | env-rows + environments | `never lets a row id reach the persisted payload` | 纯函数 + store | `save_environment` 负载的变量对象无 `id` 键 | `.map(({ key, value, secret }) => ({ key, value, secret }))` → `.map((row) => row)` |
| 20 | history-grouping | `gives distinct ids when display labels collide`（prefix/method/time 三行） | 纯函数 | 两个分组 id 不等 | `id: key` → `id: displayLabel` |
| 21 | HistoryPanel.spec | `collapsing one group leaves its same-labelled sibling expanded` | 组件 | 第二个分组的条目仍被渲染 | `collapsedGroupIds.has(group.id)` → `collapsedGroupIds.has(group.displayLabel as HistoryGroupId)` |
| 22 | source-gates | `binds the group v-for key to the id` | 源码（A21） | 模板中 `:key="group.id"` 存在 | `:key="group.id"` → `:key="group.displayLabel"`。**限制**：断的是源码文本，**不是** patch 行为（4.5-c 补人工） |
| 23 | tabs-history | `never reuses a collection-bound tab` | store | **tab 数 +1**。`label`/`projectName`/`savedRequestPath`/`isDirty` 四条在同一 mutant 下一起红，**登记为佐证，不声称独立可杀** | 谓词中 `!candidate.projectName && !candidate.savedRequestPath &&` 删除 |
| 24 | tabs-history | `still reuses an unbound empty tab with identical identity` | store | 复用发生（tab 数不变） | `serializeRequestIdentity(candidate) === serializeRequestIdentity(tab)` → `candidate.method === tab.method && candidate.url === tab.url` |
| 25 | curl-import | `leaves no query string in tab.url after an import` | 纯函数 | `url` 不含 `?` | `url,` → `url: parsed.url,` |
| 26 | curl-export | `emits an imported query param exactly once` | 纯函数 | 命令里 `q=cat` 出现 1 次 | `curl-export.ts`：`const { baseUrl, hash } = splitUrlParts(tab.url)` → `const baseUrl = tab.url, hash = ""` |
| 27 | postman-export | `emits an imported query param exactly once in url.raw` | 纯函数 | `url.raw` 里 `q=cat` 出现 1 次 | `postman-export.ts` 的 `buildRawUrl`：`const { baseUrl, hash } = splitUrlParts(url)` → `const baseUrl = url, hash = ""`。**与 §26 是两个独立 killer** |
| 28 | curl-import | `does not swallow a curl-looking paste that fails to parse`（2 行） | 纯函数 | `shouldPreventDefaultPaste` 为 false | `decision.action === "import"` → `true` |
| 29 | curl-import | `reports why the paste was not imported` | 纯函数 | 携带的失败原因非空 | `{ action: "insert", reason: attempt.error }` → `{ action: "insert" }`（§28 仍绿） |
| 30 | curl-import + locale-parity | `localizes every parse failure reason`（invalid-command / unsupported-method / no-url 三行，两个 locale 各断言解析结果 ≠ key 本身） | 纯函数 | 该 code 解析出的文案不是 key 字符串 | `CURL_ERROR_KEYS` 任一值 → `"curlImport.error.nope"` |
| 31 | RequestPanel.spec | `renders the paste failure reason` | 组件 | 通知条内出现该原因文本 | 删掉模板中渲染 `importNotice.pasteFailure` 的那一行 |
| 32 | curl-import | `still imports a parsable curl paste` | 纯函数 | `action === "import"` | `if (!trimmed \|\| !/^curl\s/i.test(trimmed)) { return { action: "insert" } }` → `return { action: "insert" }` |
| 33 | curl-import + locale-parity | `maps every warning code to a resolvable localized key`（5 code） | 纯函数 | 该 code 的 key 在两个 locale 里都解析出非 key 本身的文案 | `CURL_WARNING_KEYS` 任一值 → `"curlImport.warning.nope"`。**完备性另有结构性保证**：`Record<CurlImportWarningCode, string>` 使漏掉一个 code 编译不过 |
| 34 | curl-parser + locale-parity | `never passes prose through a warning detail` | 纯函数 | 两种 Authorization 情形产出**两个不同 code** | 把两个 push 点改回单一 code + 散文 detail：`{ code: "authorization-separator-not-preserved", detail: "" }` → `{ code: "authorization-line-breaks-not-preserved", detail: "separator whitespace" }` → 「两个 code 不同」断言红 |
| 35 | RequestPanel.spec | `renders one line per parser warning` | 组件 | 渲染行数 === warning 数 | `v-for="line in noticeLines"` → `v-for="line in noticeLines.slice(0, 1)"` |
| 36 | curl-import | `replaces the notice on the next import` | 纯函数 | 第二次（无 warning）导入后 `importNotice` 为 undefined | `importNotice: noticeFor(parsed.warnings),` → `...(parsed.warnings.length ? { importNotice: noticeFor(parsed.warnings) } : {}),` |
| 37 | RequestPanel.spec | `clears the notice when dismissed` | 组件 | `updateTab` 被以 `{ importNotice: undefined }` 调用 | ✕ 按钮的 `@click` 整行删除 |
| 38 | request | `sends normally while an import notice is present` | store | `send_request` 被调用 | 在 `sendRequest` 守卫之后插入一行 `if (tab.importNotice) { throw new Error("blocked") }` |
| 39 | request | `never persists the import notice to history` | store | `append_history` 负载无该键 | 在 `buildHistoryEntry` 返回对象加一行 `importNotice: tab.importNotice,` |
| 40 | saved-request | `never persists the import notice to a saved request` | 纯函数 | `buildSavedRequest` 结果无该键 | 在 `buildSavedRequest` 返回对象加一行 `importNotice: tab.importNotice as never,`。**与 §39 是两个独立 killer** |
| 41 | CollectionPanel.spec | `collects export warnings and hands them to feedback` | 组件 | `collectPostmanExportWarnings` 的 spy 被调用，且其返回值到达 `setFeedback` | `exportCurrentProject` 里调用 `collectPostmanExportWarnings(requests)` 的那一行删除 |
| 42 | collection-feedback | `reports plain success when there are no warnings` | 纯函数 | tone === `"success"` 且无次行 | `exportFeedbackFor` 的 `tone: warnings.length > 0 ? "warning" : "success"` → `tone: "warning"` |
| 43 | collection-feedback | `still reports success when warnings exist` | 纯函数 | 主行仍是 `export.success` | `primary: "export.success"` → `primary: ""`（§42 仍绿） |
| 44 | console-filters | `offers a filter for every console level` | 纯函数 | 选项覆盖全部 level | `...CONSOLE_LEVELS` → `...CONSOLE_LEVELS.filter((level) => level !== "info")` |
| 45 | console-filters + locale-parity | `uses an i18n key for every filter label` | 纯函数 | 每个 labelKey 在两个 locale 里存在 | ``labelKey: `console.level.${level}` `` → `labelKey: level` |
| 46 | DebugConsole.spec | `renders one button per filter option` | 组件 | 按钮数 === 选项数 | 模板中过滤按钮的 `v-for` 整行删除 |
| 47 | source-gates | `keeps hard-coded english out of the localized components` | 源码（A21） | 目标字面量不出现在源码里 | `BodyEditor.vue` 的 `{{ t("body.type") }}` → `Type`。**限制**：证明「字面量不在那里」，**不是**「翻译真的被渲染了」（4.5-e 补人工） |
| 48 | console | `does not rebind the caller's active pinia` | store | `getActivePinia()` 身份不变（**该用例只断言这一句**） | `useConsoleStore(getActivePinia() ?? pinia)` → `useConsoleStore(pinia)`。**已实跑**（0.5） |
| 49 | console | `leaves the module singleton untouched` | store | 模块单例条目数 === 0（**该用例前一句在此 mutant 下仍通过，故单塌成立**） | 同 §48 一行。**共用 mutant，但各有单塌用例**——已实跑（0.5） |
| 50 | locale-parity | `defines every inherited key with its placeholder`（6 key） | 纯函数 | 该 key 的文案含约定占位符 | 从 `zh-CN.ts` 的 `curlImport.warning.dataDiscarded` 删掉 `{detail}`（§52 仍绿） |
| 51 | locale-parity | `describes the flags the parser actually supports` | 纯函数 | 文案含 `--data-urlencode` | `importCurlDescription` 改回原文 |
| 52 | locale-parity | `zh-CN and en expose the same key set`（既有） | 纯函数 | 键集相等 | 从 `en.ts` 删掉任一新键 |

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

- **a（§15 的焦点面）**：环境面板空白行连续键入 `baseUrl` 不点别处——键名必须完整、光标不丢；已有变量退格一次焦点仍在。
- **b（§14 的真机面）**：慢接口上按住回车 3 秒，终端侧只有 1 次请求。
- **c（§22 的行为面）**：两个同文案分组，折叠一个另一个不动（源码 gate 只证明了绑定，没证明 patch 行为）。
- **d（§31/§35/§37 的视觉面）**：粘贴带 `-b cookies.txt` 的 curl，通知条出现、切走切回仍在、✕ 后消失。
- **e（§47 的渲染面）**：中文界面下逐一确认控制台四个过滤按钮、cURL 示例、form-data 的 Type/Text/File 均为中文。
- **f（§1–§10 的真实输入）**：逐字符手打 `https://api.test/a?x=1` 必须原样出现；粘贴 `…?api_key={{apiKey}}` 后地址栏显示花括号且出现「包含变量：apiKey」。
- **g**：通知条与告警条出现时，1024×768 下不换行不溢出。

### 4.6 分层统计与自查（P10；rev1 在此报错，rev2 已更正，rev3 重算）

**rev1 的分层是错的**，逐条留痕：

| rev1 的说法 | 实际 |
|---|---|
| 「表 40 行」 | 41 行（40 条 + 一个子编号） |
| 「34 条有可编译 killer」 | 38 条 |
| 「两条属结构性保证」 | 其中一条其实是 MANUAL，分类错误 |
| 「没有一个 killer 落在 `.vue` 里」 | 与当时的字面量 gate **直接矛盾** |
| 两条不变式「多条断言一起红」 | 正是 P9 禁止的形态 |

**一个错误的分层会给出「所有条目均已可靠覆盖」的错误结论——这正是 P10 要防的，只是错在度量端而不是结论端。**

rev3 的度量**由脚本直接从上表逐行解析得出**，不手数（rev2 手数时把 30 写成 31、把 §19 漏在列表外，脚本重数才抓到；这次直接以脚本为准）：

| 类别 | 条数 | 编号 |
|---|---|---|
| 有独立可编译 killer | **51** | 1–6、8–52 |
| 无独立 killer，登记为冗余 | **1** | §7（与 §6 共用，已标注） |
| ——其中 纯函数 | 33 | 1,2,3,5,6,7,8,9,10,15,16,17,18,19,20,25,26,27,28,29,30,32,33,34,36,40,42,43,44,45,50,51,52 |
| ——其中 store | 10 | 11,12,13,19,23,24,38,39,48,49 |
| ——其中 组件 | 8 | 4,14,21,31,35,37,41,46 |
| ——其中 源码 gate（A21 限定） | 2 | 22,47 |
| 另有类型系统附加保护（非 killer） | 2 | §33 的 `Record` 完备性、§21 的 branded `Set` |

（33 + 10 + 8 + 2 = 53；**§19 同时用纯函数与 store 两层，两栏各计一次**，去重后恰为 52。四栏已逐编号列出，可直接复核。）

结论及其适用范围（**与度量分开写**）：

- 52 条里 51 条有可编译 killer，**其中 8 条打在组件上、2 条打在 `.vue` 源码文本上**。
- **仍未被自动化证明的部分**：WebKit 的焦点/选区行为（§15 的真机面）、重复 `:key` 导致的错误 patch 行为（§22 的行为面）、翻译文案的实际渲染（§47 的渲染面）、1024×768 的排版。这四项在 4.5 有对应检查点，**不计入「已被测试证明」**。
- **§7、§23 的四条附属断言、§49 用例里的第一句**是已登记的非承重项，任何汇总不得把它们算作独立证据。
- 组件层那 8 条的有效性**全部以 4.3-1 的 harness 自检通过为前提**；自检未通过之前，它们一条都不成立。
- §2 的成立**以 4.4-a 的后端编码实测为前提**（0.7 仍是推断）。

### 4.7 对交接清单的偏离登记

| 偏离 | 内容 | 理由 |
|---|---|---|
| 继承 key 少落地 1 个 | `curlImport.warning.authorizationNotPreserved` **不落地**，由 `curlImport.warning.authorizationLineBreaks` 与 `…Separator` 两个自足 key 取代 | 其 `{detail}` 的取值是英文散文（`"line breaks"` / `"separator whitespace"`，0.10 实读），插进中文句子会产出半英文的话，违反 §34。两种情形**可以同时发生**，拆开后各出一行，语义也更准 |
| 连带改动 `curl-parser.ts` | 三个 throw 点改抛 `CurlParseErrorCode`；`storeAuthorizationValue` 的两个 push 点改用两个独立 code | §30 要求三种失败原因都本地化，携带英文消息做不到；§34 同理 |
| 类型迁移 | `CurlImportWarningCode` / `CurlImportWarning` 由 `curl-parser.ts` 移入 `src/types/index.ts` | 裁定 A19。已核实全仓零第三方 importer，移动无涟漪 |

## 5. Risks and rollback

| 风险 | 缓解 |
|---|---|
| 0.7 的推断若为假 | 4.4-a 是硬前置，跑在写代码之前 |
| 组件测试工具链装不起来 | 4.3-1 的 harness 自检 fail-closed；失败即回退源码 gate 并重报 owner |
| 组件测试越界去断言焦点 | 裁定 A20 把适用面写进许可本身；PRODUCT Non-goals 与 4.1 同文，越界按缺陷处理 |
| 草稿缓冲引入新的显示/状态分叉 | §8 / §9 锁「外部变化必须被采纳」（含语义相同的那一类），§6 锁「打字期间不被改写」，互为边界 |
| **新增 `urlRevision` 的写入点被漏改** | 2.9 的「默认递增 + 单一豁免路径」：漏改的后果是**多采纳一次**（草稿被规范形式替换，纯外观），不是**少采纳一次**（界面停在已不存在的旧串上）。**失败方向是安全的** |
| `Tab` 又多两个内存态字段（`importNotice` / `urlRevision`） | §39 / §40 两个独立 killer 分别锁历史与已保存请求 |
| branded `HistoryGroupId` 挡不住 `:key` | 已如实写明（2.8），§22 源码 gate + 4.5-c 人工检查点 |

**回滚**：四个互不依赖的单元——URL 栏、环境行、导入告警、导出告警。i18n 键增补跟着各自单元走，回滚时须同步删键，否则 §52 会红。

## 6. 受控裁定申请（不进不变式）

**申请事项**：集合导出时，是否应当对**任何**文件型表单行 / 二进制体提示用户「在 Postman 里需要重新选择该文件」？

**为什么值得问**：按 main 现状，集合导出走 `loadRequest`，内容字段恒为 `null`，因此该告警**永不触发**。用户拿到的产物里 `src` 是一个**文件名而非路径**，Postman 无法解析它——请求在 Postman 里仍然发不出去，而 ApiSolo 什么也没说。这不是缺陷（没有说假话），但是一个沉默的降级。

**为什么不由本切片自行决定**：它会改动一个刚冻结、刚加了回归测试的判据，属于对另一切片的受控修订，必须先经 owner（P1 第 3 条）。**rev1 正是在这里越了线**——以「修 bug」的名义静默覆盖了一份已合并的修法。

**若采纳，需要连带变更**（供裁定参考）：判据由「是否持有字节」改为「是否为文件行」；文案必须重写——现文案「内容存在 ApiSolo 里因此无法导出」对 `null` 行是假话，应改为「集合里不含该文件的内容，请在 Postman 中重新选择」；`src` 必须与说明**并存**而非互斥；`postman-export.test.ts` 中断言「`IPC_NULL` 行不产生告警、保留 `src`」的用例需随之改写。

**起草者倾向**：采纳，但**不在本切片**——它是产品行为变更，应作为一条新的 backlog 条目走完整流程，而不是搭 D05 的车。

## 7. R1 的四条 IMPORTANT — 已全部关闭

rev2 交付时只收到 1 条 IMPORTANT 的正文，其余 3 条未随裁定送达。rev2 按 P4 把它们登记为缺口、拒绝猜测性处置，并声明「rev2 不应被当作对 R1 的完整回应」。三条正文已于本轮补齐，逐条处置如下：

| id | 摘要 | 处置 |
|---|---|---|
| I1 | 「删掉 `label` 就是结构性保证」不成立——实现者可以改用 `displayLabel` 照样过 `vue-tsc` | rev2 已处置：拆成 §21（branded `Set` + 组件断言）与 §22（源码 gate，限制写明） |
| I2 | `sameParse` 分不清 self-echo 与语义相同的外部更新，界面停在旧串上 | rev3 处置：判据改 revision 信号，`sameParse` 整个删除；新增 §9；0.9 实跑复现并验证；2.9 用「默认递增、单一豁免路径」把失败方向做成安全的 |
| I3 | 自有 key 实为 9 非 11，缺两种失败原因，两个 Authorization detail 是硬编码英文 | rev3 处置：自有 key 更正为 13 并逐条列出；三类 parser error 改稳定 code；Authorization 拆成两个自足 key；新增 §30、§34；偏离登记在 4.7 |
| I4 | `src/types/index.ts` 越界，且 `CurlImportWarning` 会形成 types → utils 逆向依赖 | rev3 处置：按裁定 A19 纳入范围并把两个类型迁入 types 层（0.10 已核实零第三方 importer） |

**本节保留而不删除**，因为它记录的是一次**交付链路的失误**（裁定送达但正文未附）以及当时的正确应对方式：登记缺口、拒绝猜测、显式声明产物不完整。这比结论本身更值得留痕。
