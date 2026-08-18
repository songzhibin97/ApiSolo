# D05 — UI 交互缺陷（TECH）

> **rev4 — 应 R2 修订（4C + 1I）**。行为定义见 `PRODUCT.md`（**58** 条不变式）。分支 `songzhibin/d05-ui`，起点 `origin/main@dfb2d2e`。
>
> 本轮改动区域逐项枚举：
>
> | R2 项 | 本文改动区域 |
> |---|---|
> | **C1** | 新增 0.11（Vue watcher 源的实跑）；2.5 给 `UrlBar` 加 `urlRevision` prop 并写进 watch 源；2.9 明确「方法切换不递增」；映射表新增 §12，§10 措辞收窄 |
> | **C2** | 4.3 改**两阶段**自检并说明旧判据为何是 fail-open；4.1 补 A20 的第五类禁令（DOM 文本）；映射表 §34 的承重断言改为「注入的翻译函数被以该 key 调用 + 失败行条数」 |
> | **C3** | 3.1 纳入裁定 **A22**（`README.md` / `README.zh-CN.md` / `AuthEditor.vue` + 1 个 locale key）；映射表新增 §5、§6 |
> | **C4** | 新增 0.12（§14/§15 的四种实现实跑矩阵，**推翻 rev3 的 killer**）；映射表 §15 换 killer、§37 换断言、旧两条拆成 §45–§49；**4.6 整节重写为三态台账，不再解析表格** |
> | **I** | 映射表新增 §56（逐字文案矩阵），并给出两条单塌 mutation |
> | **交付切分**（owner 裁定，R2 后追加） | 新增 5.1：规格不拆、实现拆成 PR-A（§1–§13）与 PR-B（§14–§58）；并纠正「PR-A 不依赖组件 harness」这一表述——PR-A 的 §4 / §6 / §12(b) 仍是组件层 |
>
> 全部 `file:line` 基于 `dfb2d2e` 实际读过的代码。

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

**承重性的如实限定（P9）**：去掉修复后，「条目出现在调用方 pinia 里」这一句**仍然通过**（activePinia 已被翻走，未绑定的 `useConsoleStore()` 解析到的正是被写入的那个模块单例）。真正承重的是另外两句，且**各自有单塌用例**：第一个用例只断言 `getActivePinia()` 身份（§54）；第二个用例的前一句通过、只塌「模块单例为空」（§55）。

### 0.6 rev1 的「起草期新发现」已作废（R1-C1）

rev1 记录的实测——`fileContent: null` 使 `!== undefined` 恒真、导出产物对每个文件行写入假说明并整个丢掉 `src`——**是真的，且已由导入导出切片在 `32b7100` 修复**（判据改为 `typeof fileContent === "string"`）。该缺陷已入账 `specs/BACKLOG.md` 的「已发布缺陷」表，并催生了规则 P11。

起草者已读过 main 现状并确认：两个谓词均为 `typeof … === "string"`；测试文件含 `IPC_NULL` fixture 与 P6 式自检；非内联时 `src` 被保留。

**因此 rev1 的 §29–§31 全部删除。** rev1 的写法（任何文件行都告警 + 沿用「内容只存在于 ApiSolo」文案）会把刚修掉的那句假话原样重造，并推翻已冻结的回归测试。

**这一轮我是在一个当时正确、后来过期的前提上工作的**——记录在此，因为下一个读这份 spec 的人会看到 backlog 那条缺陷署着「D05 规格阶段发现」，需要同时读到它已经不归本切片修。

### 0.7 未验证的推断（按 P4 标注）

**「后端 `query_pairs_mut()` 把空格编码成 `+`」仍是推断，不是实跑。** 依据是它返回 `form_urlencoded::Serializer`。本工作树无预热 `target/`，冷编译 tauri 代价过大。**这条推断是 §2 的前提**，实现者必须在动 `buildUrlWithParams` 之前跑掉它（4.4-a）。若实测为 `%20`，§2 方向反转、改用 `encodeQueryComponentPreservingTemplates`，设计题二的结论随之改变。

「WebKit 下 `:key` 变化导致输入框卸载、焦点掉到 `<body>`」来自来源评审文档的对抗性验证记录，**起草者未独立复现**；§18 的最终确认落在人工验收。

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
2. **新不变式（§11）的 killer 具有区分度**：把 revision 判据换回 `sameParse`，「Params 表改值」这一类外部更新**仍然被采纳**（解析结果不同），只有 I2 那一类转红。实跑确认该对照成立。

### 0.10 I3 的实读

`curl-parser.ts` 的 `storeAuthorizationValue` 有两个 push 点，**都用同一个 code、靠英文散文 detail 区分**：

```ts
warnings.push({ code: "authorization-not-byte-preserved", detail: "line breaks" })
warnings.push({ code: "authorization-not-byte-preserved", detail: "separator whitespace" })
```

而交接清单里该 key 的中文文案是「Authorization 请求头的原始写法（{detail}）无法……」——`{detail}` 会把 `line breaks` 原样插进中文句子。两处**可以同时触发**（折叠改变了值 **且** 分隔空白不可复现），所以拆成两个独立 code 后会各出一行，语义更准。

三个 throw 点同理：`Invalid cURL command.` / `Unsupported request method: X` / `Unable to find a request URL in the cURL command.` 全是英文字面量，其中只有第二个在交接清单里有 key。

**另核实**：`grep -rn "CurlImportWarning" src/` 除 `curl-parser.ts` 自身外**零命中**，因此按 A19 把这两个类型移进 `src/types/index.ts` 是一次无涟漪的移动。

### 0.11 Vue watcher 源的实跑（R2-C1）

评审的复现成立，起草者独立跑了一遍（临时用例，跑完即删）：

```
REVISION-ONLY CHANGE -> without: 0  with: 1
```

即：只有 `revision` 变化时，监听 `[url, tabId]` 的 watcher **执行 0 次**，监听 `[url, tabId, revision]` 的执行 **1 次**。

**rev3 的组件方案因此是坏的**：2.4 的纯函数收下了 `revision` 参数，2.5 的 `UrlBar` 却只加了 `tabId` prop、watch 源里也没有 revision。于是 I2 的原始形态换个位置复活——草稿 `%20` self-echo 之后 store 里已是规范的 `+`；随后一次 cURL 导入写入同样的 `+`、只改 revision，**渲染出的 URL 字符串一字未变**，watcher 不触发，界面继续挂着那份 `%20`。

**教训写在这里**：`reconcileUrlBarValue` 的签名里有 `revision` ≠ 组件真的把 revision 传了进去。**纯函数正确 + 调用点未接 = P8**，而这正是本切片自己列为 HIGH 的那一类缺陷。它连着两轮从我手里溜过去，第一次在 rev2（判据错），第二次在 rev3（判据对、接线错）。

### 0.12 §14 / §15 的实现矩阵（R2-C4，**推翻 rev3 的 killer**）

rev3 声称「把守卫移到 `activeRequestIds.set` 之后」是 §15 的 killer 且「§14 仍绿」。**这是错的。** 起草者在真实 store 上跑了四种实现（临时探针，跑完即删，`git status` 已确认干净）：

| 实现 | `send_request` 次数 | 落到 tab 上的响应 | `append_history` 次数 |
|---|---|---|---|
| 守卫在第一行（拟定实现） | 1 | `FIRST` | 1 |
| 无守卫（今日 main） | 2 | `SECOND` | 1 |
| **守卫移到 `set` 之后（rev3 的 killer）** | **0** | null | 0 |
| **守卫早退但先改写追踪表（rev4 的 killer）** | **1** | null | 0 |

第三行解释了 rev3 错在哪：`set` 之后 `has()` 恒为真，于是**每一次调用**都早退，后端一次也没被调到——§14 的「恰好一次」断言同样变红。那不是一个只塌 §15 的 fixture，而且它也不是任何人会写出来的实现。

第四行是 rev4 采用的 killer，**一次单行改动**：

```ts
- if (activeRequestIds.has(tab.id)) { return }
+ if (activeRequestIds.has(tab.id)) { activeRequestIds.set(tab.id, crypto.randomUUID()); return }
```

它是一个**真实的实现者会犯的错**（「早退时顺手记一下最新的尝试」），并且实测 `send_request` 仍然恰好一次（§14 绿）、第一次的响应与历史双双消失（§15 红）。**单塌成立，且是实跑出来的，不是推断出来的。**

### 0.13 R3 要求的独立性复核（本轮实跑，**推翻 rev4 自己的 VERIFIED 桶**）

rev4 把 6 条标成 VERIFIED，判据写的是「该用例转红、且相邻用例不红」。**我没有拿这条判据去查自己。** R3 逐条核完，只剩 2 条站得住。逐项复核结果：

**(1) §11 —— 成立，本轮补测了第二个邻居。** mutant「revision 判据换回 `sameParse`」：

```
§10 case under mutant: GREEN     （Params 表改值，解析结果不同 ⇒ 仍被采纳）
§13 case under mutant: GREEN     （切 tab，tabId 分支未被触碰）
§11 case under mutant: RED
```

与它共用 `reconcileUrlBarValue` 的两条邻居**都保持绿**，只有 §11 塌。✅

**(2) §12(a) —— 本轮由「测量」升级为「对照」。** 0.11 记的是两种 watcher 各跑几次（一次测量），不是「应用 patch ⇒ 用例转红」。本轮改写成真正的用例并跑了 mutant（`MUT=1` 切换 watch 源）：

```
正确（三个源）：Tests 2 passed
mutant（去掉 revision 源）：× runs the reconciler on a revision-only external write
                            Tests 1 failed | 1 passed      ← §13 邻居用例保持绿
```

✅ 单塌成立。**但只覆盖 (a)**；(b)「RequestPanel 真的传了 `url-revision`」**从未运行过**，随组件 harness 结论生效。

**(3) §14 / §15 —— 双双降级为 DESIGNED。** 0.12 的四实现矩阵里就有反证，而我把它当成了正面证据：

| mutant | send_request | 落地响应 | history | §14 用例 | §15 用例 |
|---|---|---|---|---|---|
| 无守卫 | 2 | SECOND | 1 | **RED** | **RED** |
| 守卫早退时改写追踪表 | 1 | null | 0 | GREEN | **RED** |

- **§15 有一个只让它塌的 mutant**（第二行），但该 mutant 下 §15 用例里的**两条断言同时失败**（响应 + 历史），因此**没有任何一条断言被证明单独承重**。
- **§14 没有任何一个只让它塌的 mutant**：唯一能让它红的「无守卫」同时让 §15 红。两条属性经由同一张 `activeRequestIds` 表耦合，**在守卫这一行的变异空间里无法分离**。

**这正是 P9 的原话所禁止的形态，而我上一轮把它用在了别人身上。** 要转 VERIFIED，需要实现存在之后在更大的变异空间里找（例如变异 `isRequestActive` 的回写判据，使响应与历史可以分别塌），规格阶段做不到。

**(4) §54 / §55 —— 双双降级为 DESIGNED。** 生产改动只有一行，实测 `2 failed`：两个用例在同一个 mutant 下一起红。§55 用例内部确有一条断言在该 mutant 下通过（0.5 已记），这证明了**断言层**的单塌，但证明不了**用例层**与 §54 的可分离性——没有任何 patch 能让其中一个红而另一个绿。按判据的第二半，两条都不合格。

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
  | "authorization-line-breaks-not-preserved"      // ← 由散文 detail 拆出（§37）
  | "authorization-separator-not-preserved"        // ← 同上
export interface CurlImportWarning { code: CurlImportWarningCode; detail: string }

export type CurlParseErrorCode = "invalid-command" | "unsupported-method" | "no-url"

export interface CurlImportNotice {
  pasteFailure?: { code: CurlParseErrorCode; detail: string }   // §33：原因也要本地化
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

新增两个 prop：`tabId` 与 **`urlRevision`**。**watch 的源必须三者齐全**——0.11 实测漏掉 revision 会让「URL 字符串不变、来源已变」这一类整个观测不到：

```ts
const draft = ref(props.url)
const seen = ref({ tabId: props.tabId, revision: props.urlRevision })

watch(
  () => [props.url, props.tabId, props.urlRevision] as const,   // ← 三个源缺一不可
  ([url, tabId, revision]) => {
    draft.value = reconcileUrlBarValue(
      { tabId: seen.value.tabId, revision: seen.value.revision, draft: draft.value },
      { tabId, revision, url },
    )
    seen.value = { tabId, revision }
  },
)
```

`<input :value="draft">`；`detectedVariables` 改读 `draft`；`onKeydown` 增加 `if (props.isLoading) { return }`；`onPaste` 改为：

```ts
const decision = interpretPastedText(text)
if (shouldPreventDefaultPaste(decision)) { event.preventDefault(); emit("pasteCurl", decision) }
else { emit("pasteFallback", decision) }       // 不 preventDefault，浏览器照常插入
```

### 2.6 `src/utils/curl-import.ts`（新增，纯函数）

`interpretPastedText` / `shouldPreventDefaultPaste` / `tabUpdatesFromParsedCurl` / `CURL_WARNING_KEYS: Record<CurlImportWarningCode, string>` / `warningMessageKeys`。`tabUpdatesFromParsedCurl` 里 `const { url, params } = syncParamsFromUrl(parsed.url, [])`，**`url` 取 synced 的**，并**无条件**写 `importNotice: noticeFor(parsed.warnings)`（空 warning 时为 `undefined`，从而实现「被下一次导入整体取代」）。

`tryParseCurl` 包住 `parseCurl` 的三个 throw 点，返回 `{ ok: false, code, detail }` 而**不是字符串**——§33 要求三种原因都能本地化，携带英文消息就做不到。`curl-parser.ts` 的三处 `throw new Error(...)` 改抛带 `CurlParseErrorCode` 与 `detail` 的错误类，**消息文本保留原有关键信息**（已核实既有断言是 `toThrow(new RegExp(verb))`，因此仍绿）。

同时按 §37 把 `storeAuthorizationValue` 的两个 push 点改用两个**独立 code**，`detail` 不再承载散文（0.10）。这两处是本切片对导入导出切片文件的全部改动。

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

- §24（折叠状态）由 branded 类型 + **组件断言**共同保证；
- §25（渲染身份）只由**源码 gate** 保证（裁定 A21），它断的是「模板里 `:key` 绑定到 `group.id`」这一事实，**不是**「重复 key 会导致错误的 patch 行为」。该限制写进测试文件注释，并有对应的人工检查点（4.5-c）。

### 2.9 `urlRevision` 的默认安全设计（R1-I2）

协调器要判断「这次回灌是不是我自己引起的」，就需要一个**由写入方给出**的信号。风险是显而易见的：将来有人新增一个 `tab.url` 的写入点却忘了递增 revision，界面就会停在旧草稿上——又一条静默的谎言。

因此**把默认设成安全的那一侧**：

```ts
// src/stores/tabs.ts
function updateTab(id, updates)            // 只要 updates 含 url 或 params，就递增 tab.urlRevision
function updateTabFromUrlBar(id, updates)  // 唯一不递增的路径，仅供 URL 栏自己的 updateUrl 使用
```

任何新写入点走普通 `updateTab` 就自动拿到正确行为；**忘记的后果是「多采纳一次」（草稿被规范形式替换，纯外观），而不是「少采纳一次」（界面显示已不存在的旧串）。失败方向是安全的**——这正是 P8 说的、把缺陷做成难以表达，而不是靠测试去追。

**方法切换不递增**：`updateMethod` 的 updates 里既没有 `url` 也没有 `params`，因此按上面的规则天然不触发递增——这正是想要的。方法切换不改变 URL，用户正在编辑的草稿理应原样留着；把它当成外部写入会无故清掉那份草稿。§10 已相应删去「方法切换」这一项。

`urlRevision` 与 `importNotice` 一样是纯内存态，不进任何持久化负载。

### 2.10 其余改动点

| 文件 | 改动 |
|---|---|
| `src/stores/request.ts` | `sendRequest` **第一行**（在 `activeRequestIds.set` 之前）`if (activeRequestIds.has(tab.id)) { return }`。放 store 不放组件：两个调用点加将来任何新入口都被同一条结构性拦截（P8） |
| `src/stores/tabs.ts` | `openHistoryEntry` 复用谓词加 `!candidate.projectName && !candidate.savedRequestPath &&`；新增 2.9 的两条写入路径 |
| `src/types/index.ts`（裁定 A19） | `CurlImportWarningCode` / `CurlImportWarning` / `CurlParseErrorCode` / `CurlImportNotice` 迁入；`HistoryGroup` 改 branded id；`Tab` 追加 `importNotice` 与 `urlRevision` |
| `src/stores/console.ts` | `useConsoleStore(getActivePinia() ?? pinia)`；新增 `export const CONSOLE_LEVELS = [...] as const`，`ConsoleLevel` 由它派生 |
| `src/components/panels/RequestPanel.vue` | 两条导入路径改用 `tabUpdatesFromParsedCurl`；渲染通知条（warning 行 + `pasteFailure` 行 + ✕）；给 `UrlBar` 传 **`tab-id` 与 `url-revision`**（§12(b)：漏传 `url-revision` 就会重造 R2-C1）；接 `pasteFallback` |
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
- **A22**：`README.md`、`README.zh-CN.md`、`src/components/request/AuthEditor.vue` 及对应的 locale key **加入 D05 范围**。理由是 §4 建立了一个刻意的显示/生效分叉（query API key 上线但不进地址栏），而项目硬规则要求决策必须同时落到 README 与 UI——否则用户无法区分「安全设计」与「功能失效」，下一轮扫描也可能把密钥重新拼回地址栏。
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
| 「不得退化成 method+url 去重」测试 | 本切片只**收紧**复用条件，继续成立，并被 §27 重新锁定 |
| `curl-parser` 的 `toThrow(new RegExp(verb))` | 改抛带 code 的错误类后仍绿（消息保留 verb） |
| `postman-export.test.ts` 的 `IPC_NULL` 与内联 fixture | **不受影响**——rev2 不再改判据（0.6） |
| `encodeQueryComponentPreservingTemplates` 的既有测试 | 2.3 只换内部实现、不改行为，必须继续绿 |

### 3.4 追溯：backlog / 交接 → 不变式

| 来源 | 位置（按符号） | 不变式 |
|---|---|---|
| D05 high | `EnvironmentPanel.vue` 的 `rows` | 18–22 |
| D05 high | `buildUrlWithParams` + `UrlBar` 的协调与提示 | 1–4, 7–13 |
| D05 med | `UrlBar.onKeydown` | 14–17 |
| D05 med | `HistoryPanel` 折叠状态 + `history-grouping.ts` | 23–25 |
| D05 med | `tabs.openHistoryEntry` | 26–27 |
| D05 med（从导入导出切片移入） | `RequestPanel` 的两条导入路径 | 28–30 |
| D05 low | 同上（空 catch） | 31–35 |
| D05 low | `DebugConsole.filterOptions` | 50–53 |
| D05 low | `console.recordConsoleEntry` | 54–55 |
| 交接 B1 | `UrlBar.onPaste` + 空 catch | 31–35 |
| 交接 B2 | `parseCurl` 的 `warnings` 无渲染点 | 36–43 |
| 交接 B3 | `collectPostmanExportWarnings` 无调用点 | 44–49 |
| 交接（i18n，裁定 A16） | 6 继承 + 14 自有 key | 56–58 |
| R1-I2 | `reconcileUrlBarValue` 的判据 | 11 |
| R1-I3 | 三个 parser throw 点 + 散文 detail | 33, 37 |
| R2-C1 | `UrlBar` 未接 `urlRevision` | 12 |
| R2-C3（裁定 A22） | 两个 README + `AuthEditor.vue` | 5, 6 |
| R2-I | 本地化断言过弱 | 56 |

1–58 全部有来源、全部有验证条目，无孤儿。

## 4. Testing and validation

命令：`npm run test`。声称完成前自跑 `npm run release:check`。

### 4.1 组件测试的引入与硬性适用面（R1-C3）

**rev1 的论证只有一半成立，这里更正。** rev1 写的是「DOM 模拟环境的焦点/选区模型不是 WebKit 的，绿灯比没有覆盖更糟」——**这一半仍然成立**，并且正是下面那条禁令的理由。但 rev1 据此拒绝了**全部**组件测试，那是把「不能用它证明 WebKit 焦点行为」错误地推广成「不能用它验证普通的 Vue 接线」。两者不是一回事：前者依赖浏览器实现，后者只依赖 Vue 运行时，而 Vue 运行时在任何 DOM 实现上都一样。

现在的缺口正是接线：`pasteFallback` 的接收、失败原因的渲染、`warningMessageKeys` 的实际调用、告警行的条数、`exportFeedbackFor` 到集合 feedback 的接线、过滤按钮的渲染。**实现者可以把每个 helper 都写对、一个都不接，而纯函数测试与人工清单全部通过**——这正是本切片按 HIGH 处理的那类缺陷落在自己身上。grep 清单不是 gate，它不会红。

**已裁定（A20）：引入 `@vue/test-utils` + `happy-dom`。** 理由：`?raw` 源码 gate 断的是文本而非行为——它无法区分「✕ 真的调用了 `updateTab`」与「源码里出现过这串字符」，一条注释就能满足它；而本切片要挡的恰恰是「看起来接上了、其实没有」。**裁定 A21** 相应把源码 gate 限定在**挂载无法回答**的两处（§25 的 `:key` 绑定、§53 的字面量清除），各自写明限制。

选 `happy-dom` 而非 `jsdom`：更轻、启动更快。**不改 `vitest.config.ts` 的全局 `environment`**——组件测试文件各自用 `// @vitest-environment happy-dom` 文件头 docblock，现存 20 个文件的 `node` 环境零变化。所有组件测试一律 `shallowMount`（子组件全部 stub），避免把 CodeMirror 拉进 DOM 模拟环境。

**硬性适用面（裁定 A20 的一部分，越界按缺陷处理；PRODUCT Non-goals 同文写明）**：组件测试只允许断言 (1) 发出的事件、(2) 传给子组件的 props、(3) `v-if`/`v-for` 的存在性与条数、(4) 对 store 或注入函数的调用。**禁止**断言焦点、选区、光标、布局、`document.activeElement`，**以及 DOM 文本内容**。

> 第五类是 rev4 补的，因为 rev3 自己越了界：它把 §34 的承重断言写成「通知条内出现原因文本」——那是 DOM 文本断言。**我划的边界，我第一个越过去。** 与 P7 记录的那次（用一条正确的原则为一个错误的结论辩护）同源：边界写得对，不代表下笔时会想起它，所以现在把它列成第五类禁令而不是留在散文里。文案是否真的渲染成中文，归 4.5 的真机检查点。

owner 采纳该边界时的措辞是「rev1 那半论证成立，现在它是这条禁令的书面理由」——即禁令与许可来自同一条判断，不可只取其一。

**许可 ≠ 可行性**：A20 解决的是能不能装，不是装了能不能跑。起草者仍未实证（3.1）。4.3 的 harness 自检必须先通过，否则本节全部作废、回退源码 gate 并重报 owner。

### 4.2 不变式 → 测试 → 承重断言 → 变异检查

「可测性」四类：**纯函数** / **store**（既有 pinia 测试形态）/ **组件**（4.1 的受限挂载）/ **源码**（`?raw` 文本 gate）。
变异检查一律最小可编译 patch；共用 killer 与非承重断言**如实标注**。

| § | 测试文件 | 可测性 | 状态 | 承重断言（只让它单独塌的那一条） | 最小可编译 patch |
|---|---|---|---|---|---|
| 1 | url-params | 纯函数 | DESIGNED | 输出等于含花括号的期望串 | `if (isTemplateSpan(segment))` → `if (false)` |
| 2 | url-params | 纯函数 | DESIGNED | 逐字节相等（35 字符样本） | `encoded.toString().slice(2)` → `encodeURIComponent(segment)` |
| 3 | url-params | 纯函数 | DESIGNED | 输出不含纯空白 key 那一行 | `item.enabled && item.key.trim()` → `item.enabled && item.key` |
| 4 | RequestPanel.spec | 组件 | DESIGNED | 传给 UrlBar 的 `url` prop 不含 apiKey 的值 | `RequestPanel.vue` 模板单行改成把 apiKey 拼进 params 的版本 |
| 5 | source-gates | 源码（A21） | DESIGNED | 两个 README 都含该声明句 | 从 `README.md` 删掉该句 |
| 6 | AuthEditor.spec | 组件 | DESIGNED | `addTo === "query"` 时注入的 `t` 被以 `auth.queryKeyHidden` 调用 | 该说明的 `v-if="addTo === 'query'"` 整行删除 |
| 7 | url-params | 纯函数 | DESIGNED | 查询串变量出现在结果里 | `/\{\{…\}\}/g` → `/^\{\{…\}\}/g`（查询行红、路径行绿） |
| 8 | url-params | 纯函数 | DESIGNED | 末态显示串 === 目标串（10 个目标） | `return previous.draft` → `return incoming.url` |
| 9 | url-params | 纯函数 | 冗余 | — | **与 §8 共用 killer，不独立可杀**，登记为 §8 在单次输入下的实例 |
| 10 | url-params | 纯函数 | DESIGNED | Params 表改值后显示新值 | 删掉 `previous.revision !== incoming.revision` 整行 |
| 11 | url-params | 纯函数 | **VERIFIED**（0.9 + 0.13） | 草稿 `%20` 被导入后的 `+` 取代 | 判据换回 `sameParse(...) ? previous.draft : incoming.url`。**§10 在此 mutant 下仍绿**——实跑确认 |
| 12 | url-params-reactivity（**无 DOM**） + RequestPanel.spec | reactivity / 组件 | **VERIFIED 仅 (a)**（0.13）；**(b) DESIGNED，从未运行** | (a) revision-only 变化时协调器执行次数 === 1；(b) RequestPanel 传给 UrlBar 的 `url-revision` prop 存在 | (a) watch 源 `[props.url, props.tabId, props.urlRevision]` → `[props.url, props.tabId]` —— 实跑：mutant 下 (a) 用例 RED、§13 邻居用例 GREEN；(b) 模板里 `:url-revision="activeTab.urlRevision"` 整行删除（**未跑**） |
| 13 | url-params | 纯函数 | DESIGNED | 切 tab 后显示新 tab 的 url | 删掉 `previous.tabId !== incoming.tabId` 整行 |
| 14 | request | store | DESIGNED（0.13：无单塌 mutant） | `send_request` 次数 === 1（**该用例只断言这一项**） | 守卫整行删除 → 实测 2 次 |
| 15 | request | store | DESIGNED（0.13：两条断言同塌） | 在途请求的响应落到 tab 上 + `append_history` 恰好一次（**该用例不断言调用次数**） | `{ return }` → `{ activeRequestIds.set(tab.id, crypto.randomUUID()); return }` → 实测调用次数仍为 1（§14 绿）、响应与历史双双消失 |
| 16 | request | store | DESIGNED | 第二次 `send_request` 发生 | `finally` 里 `activeRequestIds.delete(tabId)` 整行删除 |
| 17 | UrlBar.spec | 组件 | DESIGNED | `emitted().send` 为 undefined | `if (props.isLoading) { return }` 整行删除 |
| 18 | env-rows | 纯函数 | DESIGNED | 编辑后 id 不变（key/value/secret 三行） | `{ ...row, ...patch }` → `{ ...row, ...patch, id: crypto.randomUUID() }` |
| 19 | env-rows | 纯函数 | DESIGNED | 剩余行的 key 序列 | `rows.filter((row) => row.id !== id)` → `rows.filter((_row, index) => index !== 0)` |
| 20 | env-rows | 纯函数 | DESIGNED | 「末行被清空后不新增」这一行 | `if (!last \|\| last.key \|\| last.value)` → `if (true)` |
| 21 | env-rows | 纯函数 | DESIGNED | 返回 true | `shouldReseedEnvRows` 函数体 → `return false` |
| 22 | env-rows + environments | 纯函数 + store | DESIGNED | `save_environment` 负载的变量对象无 `id` 键 | `.map(({ key, value, secret }) => ({ key, value, secret }))` → `.map((row) => row)` |
| 23 | history-grouping | 纯函数 | DESIGNED | 两个分组 id 不等 | `id: key` → `id: displayLabel` |
| 24 | HistoryPanel.spec | 组件 | DESIGNED | 第二个分组的条目 `v-if` 仍为真 | `collapsedGroupIds.has(group.id)` → `…has(group.displayLabel as HistoryGroupId)` |
| 25 | source-gates | 源码（A21） | DESIGNED | 模板中 `:key="group.id"` 存在 | `:key="group.id"` → `:key="group.displayLabel"`。**限制**：断源码文本，非 patch 行为（4.5-c 补人工） |
| 26 | tabs-history | store | DESIGNED | **tab 数 +1**（其余四项登记为佐证，不声称独立可杀） | 谓词中 `!candidate.projectName && !candidate.savedRequestPath &&` 删除 |
| 27 | tabs-history | store | DESIGNED | 复用发生（tab 数不变） | 完整身份比较 → `candidate.method === tab.method && candidate.url === tab.url` |
| 28 | curl-import | 纯函数 | DESIGNED | `url` 不含 `?` | `url,` → `url: parsed.url,` |
| 29 | curl-export | 纯函数 | DESIGNED | 命令里 `q=cat` 出现 1 次 | `const { baseUrl, hash } = splitUrlParts(tab.url)` → `const baseUrl = tab.url, hash = ""` |
| 30 | postman-export | 纯函数 | DESIGNED | `url.raw` 里 `q=cat` 出现 1 次 | `buildRawUrl` 内同形改动。**与 §29 是两个独立 killer** |
| 31 | curl-import | 纯函数 | DESIGNED | `shouldPreventDefaultPaste` 为 false | `decision.action === "import"` → `true` |
| 32 | curl-import | 纯函数 | DESIGNED | 携带的失败原因非空 | `{ action: "insert", reason: attempt.error }` → `{ action: "insert" }` |
| 33 | locale-matrix | 纯函数 | DESIGNED | 三个 code 各自解析出的文案与 §56 矩阵逐字相等 | `CURL_ERROR_KEYS` 任一值 → `"curlImport.error.nope"` |
| 34 | RequestPanel.spec | 组件 | DESIGNED | (a) 注入的 `t` 被以 `curlImport.pasteFailed` 调用；(b) 失败行 `v-if` 为真且条数 === 1。**A20 四类之内，不断言 DOM 文本** | 渲染 `importNotice.pasteFailure` 的那一行整行删除 |
| 35 | curl-import | 纯函数 | DESIGNED | `action === "import"` | 首行条件判断整行删除，恒返回 `{ action: "insert" }` |
| 36 | curl-import + locale-matrix | 纯函数 | DESIGNED | 5 个 code 各自映射到的 key 解析出的文案与矩阵逐字相等 | `CURL_WARNING_KEYS` 任一值 → `"curlImport.warning.nope"`。**完备性另有结构性保证**：`Record<CurlImportWarningCode, string>` 漏一个 code 编译不过 |
| 37 | curl-parser | 纯函数 | DESIGNED | 两种 Authorization 情形产出的 warning 数组**逐字段等于** `[{ code: "authorization-line-breaks-not-preserved", detail: "" }, { code: "authorization-separator-not-preserved", detail: "" }]` | 任一 push 点改回 `detail: "line breaks"` → `detail` 等值断言红。**rev3 只断言「两个 code 不同」，改散文 detail 时照样绿——那条断言杀不掉 §37 存在的理由** |
| 38 | RequestPanel.spec | 组件 | DESIGNED | 告警行 `v-for` 渲染条数 === warning 数 | `v-for="line in noticeLines"` → `v-for="line in noticeLines.slice(0, 1)"` |
| 39 | curl-import | 纯函数 | DESIGNED | 第二次（无 warning）导入后 `importNotice` 为 undefined | `importNotice: noticeFor(...)` → 条件展开 `...(warnings.length ? { importNotice: … } : {})` |
| 40 | RequestPanel.spec | 组件 | DESIGNED | `updateTab` 被以 `{ importNotice: undefined }` 调用 | ✕ 按钮的 `@click` 整行删除 |
| 41 | request | store | DESIGNED | `send_request` 被调用 | 守卫之后插入一行 `if (tab.importNotice) { throw new Error("blocked") }` |
| 42 | request | store | DESIGNED | `append_history` 负载无该键 | `buildHistoryEntry` 返回对象加一行 `importNotice: tab.importNotice,` |
| 43 | saved-request | 纯函数 | DESIGNED | `buildSavedRequest` 结果无该键 | 返回对象加一行 `importNotice: tab.importNotice as never,`。**与 §42 是两个独立 killer** |
| 44 | CollectionPanel.spec | 组件 | DESIGNED | `collectPostmanExportWarnings` 的 spy 被调用，且其返回值到达 `setFeedback` | 调用 `collectPostmanExportWarnings(requests)` 的那一行删除 |
| 45 | collection-feedback | 纯函数 | DESIGNED | 无告警时 `detail` 为 undefined（**该用例只断言这一项**） | `detail: warnings.length ? countLine(warnings) : undefined` → `detail: countLine(warnings)` |
| 46 | collection-feedback | 纯函数 | DESIGNED | 无告警时 `tone === "success"`（**只断言这一项**） | `tone: warnings.length > 0 ? "warning" : "success"` → `tone: "warning"` |
| 47 | collection-feedback | 纯函数 | DESIGNED | 有告警时 `primary === "export.success"`（**只断言这一项**） | `primary: "export.success"` → `primary: "import.error"` |
| 48 | collection-feedback | 纯函数 | DESIGNED | 有告警时 `tone === "warning"`（**只断言这一项**） | `tone: warnings.length > 0 ? "warning" : "success"` → `tone: "success"` |
| 49 | collection-feedback | 纯函数 | DESIGNED | 次行插值的数量 === 告警条数（**只断言这一项**，fixture 用 3 条） | `{ count: warnings.length }` → `{ count: 1 }` |
| 50 | console-filters | 纯函数 | DESIGNED | 选项覆盖全部 level | `...CONSOLE_LEVELS` → `...CONSOLE_LEVELS.filter((l) => l !== "info")` |
| 51 | console-filters + locale-matrix | 纯函数 | DESIGNED | 每个 labelKey 解析出的文案与矩阵逐字相等 | ``labelKey: `console.level.${level}` `` → `labelKey: level` |
| 52 | DebugConsole.spec | 组件 | DESIGNED | 过滤按钮 `v-for` 条数 === 选项数 | 该 `v-for` 整行删除 |
| 53 | source-gates | 源码（A21） | DESIGNED | 目标字面量不出现在源码里 | `BodyEditor.vue` 的 `{{ t("body.type") }}` → `Type`。**限制**：证明字面量不在，非「翻译真的被渲染」（4.5-e 补人工） |
| 54 | console | store | DESIGNED（0.13：与 §55 不可分离） | `getActivePinia()` 身份不变（**该用例只断言这一句**） | `useConsoleStore(getActivePinia() ?? pinia)` → `useConsoleStore(pinia)` |
| 55 | console | store | DESIGNED（0.13：与 §54 不可分离） | 模块单例条目数 === 0（该用例前一句在此 mutant 下仍通过——**断言层单塌成立，用例层不成立**） | 同 §54 一行。**没有任何 patch 能让 §54 与 §55 一红一绿**，故两条都不计 VERIFIED |
| 56 | locale-matrix | 纯函数 | DESIGNED | 20 个 key（14 自有 + 6 继承）× 2 语言的文案与 PRODUCT 表**逐字相等** | 两条各自单塌：(a) 把 `zh-CN.ts` 的 `curlImport.error.noUrl` 换成其 en 文案 → 该行红（旧式 `t(key) !== key` 断言在此 mutant 下**仍绿**）；(b) 把继承的 `curlImport.warning.cookieFile` 改成占位符仍在但语义错的句子 → 该行红（旧式「占位符存在」断言**仍绿**） |
| 57 | locale-matrix | 纯函数 | DESIGNED | 文案含 `--data-urlencode` | `importCurlDescription` 改回原文 |
| 58 | locale-parity | 纯函数 | DESIGNED | 键集相等 | 从 `en.ts` 删掉任一新键 |

### 4.3 harness 自检与 fail-closed 执行协议（P12；rev3 的自检本身是 fail-open）

**rev3 的自检写错了方向，这里更正。** rev3 说：写一条必然失败的组件断言，看到 `Tests … failed` 且失败条目名对得上，就算 harness 可用。评审实跑指出——临时用例在**断言之前**就抛出（`mount failed before assertion`），Vitest 输出**同样**是 `Tests 1 failed`、失败条目名**同样**是那个用例名。**于是 `@vue/test-utils` / `happy-dom` 整个装不起来时，这个自检照样判「通过」。**

P12 的原话是：判据必须**正向匹配「确实执行了」的证据**。rev3 匹配的是「出现了失败」——而失败有两种来源，其中一种恰恰意味着什么都没跑。**这和 D02 那个把编译失败读成「变异存活」的台账是同一形状**，只是我把它写进了那条本该防住它的规则里。

**rev4 的两阶段自检：**

**阶段 1（证明挂载真的发生了）**：写一条**获准四类之内的正确断言**（例如 `shallowMount(UrlBar, { props })` 后断言 `emitted()` 为空对象、或某个子组件 stub 存在），运行，**必须为绿**。绿意味着 import、setup、mount 三步全部走通——**这是「确实执行了」的正向证据**，失败信息给不了它。

**阶段 2（证明红灯能被观测到）**：把**同一条**断言故意改错（期望值改成不可能的值），运行，**必须为红**，并且失败类型必须是 **assertion mismatch**（Vitest 报 `AssertionError` / expected-vs-received 差异），**不是** import error、setup error 或 mount error。

**任一阶段不满足 ⇒ `INCONCLUSIVE` ⇒ 4.1 整节作废、回退源码 gate 并重报 owner。** 阶段 1 绿而阶段 2 红，两者合起来才证明「挂载成功且断言可观测」；单独任何一个都不够。

**纯函数 harness 自检**同理两阶段：先让 `splitTemplateSpans` 的现有用例为绿，再改成 `return []` 确认转红且失败类型是 assertion mismatch。

**§12 的 reactivity 用例不依赖 DOM**（0.11 就是在现有 `environment: "node"` 下跑通的），因此它**不受本节结论影响**——即使组件 harness 整体作废，§12 的 (a) 半边仍然成立。这一点单独记下，避免把「组件测试没跑起来」误读成「revision 接线没有任何 gate」。

真实变异台账的判定规则：

- 只有在输出里 positively 匹配到 vitest 汇总行（`Test Files …` 与 `Tests …`，且解析出的 `passed + failed > 0`）时，本次运行才产生结论。匹配不到 ⇒ **`INCONCLUSIVE`**。
- 解析出的 failed 计数与列出的失败用例名数量不一致 ⇒ **`INCONCLUSIVE`**。
- 失败类型不是 assertion mismatch（import / setup / mount / transform error）⇒ **`INCONCLUSIVE`**，**不得**记为「杀死」。
- 变异后若 `vue-tsc` 编译不过，该 patch 不是合法 killer（P3），改写 patch，不得记为「杀死」。

### 4.4 实现者必须先跑掉的两件事

**(a) 后端的空格编码**（0.7，§2 的前提）。临时 Rust 测试断言 `Url::parse("https://x/a").query_pairs_mut().append_pair("q","a b")` 得到 `q=a+b`。结果（无论正反）写进 ACCEPTANCE，**跑完即删**，不留在 `src-tauri/`。

**(b) 依赖裁定**。`@vue/test-utils` + `happy-dom` 未获裁定前不得写入 `package.json`（3.1）。

### 4.5 人工验收（打包版 macOS App，WebKit）

只保留自动化**结构上**覆盖不到的部分：

- **a（§18 的焦点面）**：环境面板空白行连续键入 `baseUrl` 不点别处——键名必须完整、光标不丢；已有变量退格一次焦点仍在。
- **b（§17 的真机面）**：慢接口上按住回车 3 秒，终端侧只有 1 次请求。
- **c（§25 的行为面）**：两个同文案分组，折叠一个另一个不动（源码 gate 只证明了绑定，没证明 patch 行为）。
- **d（§34/§38/§40 的视觉面）**：粘贴带 `-b cookies.txt` 的 curl，通知条出现、切走切回仍在、✕ 后消失。
- **e（§53 的渲染面）**：中文界面下逐一确认控制台四个过滤按钮、cURL 示例、form-data 的 Type/Text/File 均为中文。
- **f（§1–§13 的真实输入）**：逐字符手打 `https://api.test/a?x=1` 必须原样出现；粘贴 `…?api_key={{apiKey}}` 后地址栏显示花括号且出现「包含变量：apiKey」。
- **g**：通知条与告警条出现时，1024×768 下不换行不溢出。

### 4.6 覆盖台账（三态；rev5 重新核定）

这一格连错四轮，每轮错在不同层次，全部留痕：

| 轮次 | 错法 |
|---|---|
| rev1 | 手数数错，并声称「没有 killer 落在 `.vue` 里」，与自己表里的字面量 gate 矛盾 |
| rev2 | 仍手数，把 30 写成 31、漏一条 |
| rev3 | 改用脚本解析表格——**数字对了，判据错了**：把「填了 patch 栏」当成「单塌已成立」 |
| rev4 | 改成三态——**判据写对了，没拿它查自己**：VERIFIED 桶里 6 条只有 2 条经得起该判据。§14 的反证数据**就在我自己交的那张四实现矩阵里**，我记录了推翻自己分类的证据然后没有回头看 |

**rev4 的错法值得单独说**：我上一轮撤回「51 条独立 killer」，理由是「表里填了 patch」是关于文档的陈述而非关于覆盖的陈述。换成三态之后，VERIFIED 桶犯了**结构完全相同**的错——「我跑了一个变异」被当成了「单塌已成立」，而没有检查邻居。**P9 的原话是「多项同时失败的 fixture 不能作为任何单条断言的承重证据」，我把它用在了别人身上。**

**判据（rev5 起写死，避免再含糊）**：

> **VERIFIED** = 已实跑「应用该 patch ⇒ 该不变式的用例转红」，**并且**已实跑确认**与它共用同一处生产代码**的其他不变式用例**保持绿**。
> 两个条件缺一不可。只跑了前半 ⇒ DESIGNED。

| 状态 | 条数 | 编号 |
|---|---|---|
| **VERIFIED** | **2** | §11、§12(a) |
| **DESIGNED**（有最小可编译 patch，单塌未成立或未运行） | **55** | 其余全部（含 §12(b)、§14、§15、§54、§55） |
| **冗余**（明确不独立可杀） | **1** | §9 |

证据出处：§11 见 0.9 与 0.13(1)（两个共用同一函数的邻居都实测保持绿）；§12(a) 见 0.13(2)（本轮由测量升级为对照，邻居用例实测保持绿）。

**本轮降级的四条及其原因**（0.13 有实跑数据）：

| 条目 | 降级原因 |
|---|---|
| §14 | 唯一能让它红的 mutant 同时让 §15 红；两条属性经同一张 `activeRequestIds` 表耦合，守卫这一行的变异空间里无法分离 |
| §15 | 有专属 mutant，但该 mutant 下用例内**两条断言同时失败**，没有一条被证明单独承重 |
| §54 / §55 | 生产改动只有一行，两个用例在同一 mutant 下一起红，无 patch 能让一红一绿 |
| §12(b) | 从未运行 |

**结论及其适用范围（与度量分开写）**：

- **「58 条中 57 条有 killer」是关于文档的陈述。** 经实验证明单塌的只有 **2** 条。规格阶段的诚实上限就是这个数——rev4 说「六是规格阶段诚实的上限」，那句话本身没有过这把尺子。
- 实现阶段交付要求：每一条 DESIGNED 转 VERIFIED，按 4.3 协议记录，`INCONCLUSIVE` 不计入。**自检报告须给出三态分布**，不得给「N 个变异全红」这类只有分子的数字。
- §14/§15、§54/§55 两组要转 VERIFIED，需要在**更大的变异空间**里找分离点（例如变异 `isRequestActive` 的回写判据，使响应与历史可以分别塌）——那要等实现存在。**在此之前不得声称这两组「已被覆盖」。**
- §12(a) 已 VERIFIED 且**不依赖组件 harness**；§12(b) 随 4.3 结论生效或作废。
- 组件层与源码 gate 各条的有效性**全部以 4.3 两阶段自检通过为前提**。
- §2 的成立**以 4.4-a 的后端编码实测为前提**（0.7 仍是推断）。
- **仍未被任何自动化覆盖**：WebKit 焦点/选区行为（§18）、重复 `:key` 的错误 patch 行为（§25）、翻译文案的实际渲染（§34 / §53）、1024×768 排版，以及 5.1 列出的三条组件降级项。全部在 4.5 有检查点，不计入任何覆盖统计。
- **非承重项**（不得计作独立证据）：§9；§26 除「tab 数 +1」外的四项；§55 用例里的第一句。

### 4.7 对交接清单的偏离登记

| 偏离 | 内容 | 理由 |
|---|---|---|
| 继承 key 少落地 1 个 | `curlImport.warning.authorizationNotPreserved` **不落地**，由 `curlImport.warning.authorizationLineBreaks` 与 `…Separator` 两个自足 key 取代 | 其 `{detail}` 的取值是英文散文（`"line breaks"` / `"separator whitespace"`，0.10 实读），插进中文句子会产出半英文的话，违反 §37。两种情形**可以同时发生**，拆开后各出一行，语义也更准 |
| 连带改动 `curl-parser.ts` | 三个 throw 点改抛 `CurlParseErrorCode`；`storeAuthorizationValue` 的两个 push 点改用两个独立 code | §33 要求三种失败原因都本地化，携带英文消息做不到；§37 同理 |
| 类型迁移 | `CurlImportWarningCode` / `CurlImportWarning` 由 `curl-parser.ts` 移入 `src/types/index.ts` | 裁定 A19。已核实全仓零第三方 importer，移动无涟漪 |

## 5. Risks and rollback

| 风险 | 缓解 |
|---|---|
| 0.7 的推断若为假 | 4.4-a 是硬前置，跑在写代码之前 |
| 组件测试工具链装不起来 | 4.3-1 的 harness 自检 fail-closed；失败即回退源码 gate 并重报 owner |
| 组件测试越界去断言焦点 | 裁定 A20 把适用面写进许可本身；PRODUCT Non-goals 与 4.1 同文，越界按缺陷处理 |
| 草稿缓冲引入新的显示/状态分叉 | §10–§12 锁「外部变化必须被采纳」（含语义相同、以及字符串完全不变的两类），§8 锁「打字期间不被改写」，互为边界 |
| **新增 `urlRevision` 的写入点被漏改** | 2.9 的「默认递增 + 单一豁免路径」：漏改的后果是**多采纳一次**（草稿被规范形式替换，纯外观），不是**少采纳一次**（界面停在已不存在的旧串上）。**失败方向是安全的** |
| `Tab` 又多两个内存态字段（`importNotice` / `urlRevision`） | §42 / §43 两个独立 killer 分别锁历史与已保存请求 |
| branded `HistoryGroupId` 挡不住 `:key` | 已如实写明（2.8），§25 源码 gate + 4.5-c 人工检查点 |

**回滚**：以 5.1 的两个 PR 为单位。PR-A 与 PR-B 之间无代码依赖，任一可单独 revert；PR-B 内部仍可按「环境行 / 历史分组 / 导入告警 / 导出告警 / 控制台」五个子单元分别 revert。i18n 键增补跟着各自单元走，回滚时须同步删键，否则 §56 / §58 会红。

### 5.1 交付切分：一份冻结规格，两个实现 PR（owner 裁定）

规格**不拆**（R2 之后再拆意味着两条评审轨道、两次冻结、两份 ACCEPTANCE，而本轮 4C 全部来自实跑、不是来自「规格太大看不过来」）。**拆的是实现与合并。**

| PR | 内容 | 不变式 | 依赖 |
|---|---|---|---|
| **PR-A** | URL 栏组：协调器与 revision、query 编码、纯空白 key、query API key 不进地址栏，以及 A22 的两个 README 与 `AuthEditor` 说明 | §1–§13 | 只依赖 4.4-a（后端编码实测）。**不依赖** D06 的三条交接 |
| **PR-B** | 告警呈现组：环境行、历史分组、历史打开、cURL 导入与粘贴、导入/导出告警、控制台、文案矩阵 | §14–§58 | 含 D06 的三条发布阻断交接；组件层依赖 4.3 自检 |

**PR-A 不依赖 PR-B**：两组改动的文件交集只有 `src/i18n/*.ts` 与 `src/types/index.ts`，且都是纯追加（PR-A 加 `auth.queryKeyHidden` 与 `urlRevision`，PR-B 加其余）。

#### 一处必须纠正的表述

owner 派单时写的是「PR-A 自足，且不依赖组件 harness」。**前半对，后半只对 PR-A 的行为内核，不对整组**。逐条核对（数据取自 4.2 的可测性列）：

| PR-A 中的组件层条目 | 断言 |
|---|---|
| §4 | RequestPanel 传给 UrlBar 的 `url` prop 不含 query API key |
| §6 | AuthEditor 在 `addTo === "query"` 时调用注入的 `t` |
| §12(b) | RequestPanel 传入 `url-revision` prop |

其余 10 条（§1/§2/§3/§7–§11/§13 纯函数、§5 源码 gate、§12(a) reactivity）**确实与 DOM 无关**，在现有 `environment: "node"` 下就能跑——§12(a) 已在 0.11 实跑验证过。

**因此准确的表述是**：4.3 自检失败时，PR-A **仍可交付**，其行为内核仍被证明；但 §4 / §6 / §12(b) 三条**降级为验证缺口**，各自配 4.5 的人工检查点，并且**必须在 ACCEPTANCE 里登记为缺口，不得计入覆盖**。这三条恰好都是「接线」类断言——也就是 P8 那一类最容易漏、也最难用非组件手段证明的东西，所以降级的代价要写清楚，不能含糊成「PR-A 不受影响」。

#### `§56` 跨 PR 的处理

文案矩阵的**机制**随 PR-A 落地（此时 fixture 只有 `auth.queryKeyHidden` 一条），PR-B 把 fixture 扩到 20 条。这是 §56 唯一一条跨两个 PR 的不变式，其「已证明」状态**以 PR-B 合并为准**；PR-A 阶段只声称「机制已建立并覆盖本 PR 新增的 key」。

#### 顺序

PR-A 先。它体量小、无外部交接依赖、且不受 4.3 结论影响；先合并可以让 PR-B 的组件 harness 结论在一个已经变小的 diff 上判定。

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
| I1 | 「删掉 `label` 就是结构性保证」不成立——实现者可以改用 `displayLabel` 照样过 `vue-tsc` | rev2 已处置：折叠状态改由 branded 类型 + 组件断言共同保证，渲染身份另由源码 gate 保证并写明限制（**此处刻意不写编号**——它跨轮重编过两次，见 IMPORTANT 1 的教训） |
| I2 | `sameParse` 分不清 self-echo 与语义相同的外部更新，界面停在旧串上 | rev3 处置：判据改 revision 信号，`sameParse` 整个删除；新增「解析后等价仍须采纳」这一条；0.9 实跑复现并验证；2.9 用「默认递增、单一豁免路径」把失败方向做成安全的 |
| I3 | 自有 key 实为 9 非 11，缺两种失败原因，两个 Authorization detail 是硬编码英文 | rev3 处置：自有 key 更正为 13 并逐条列出；三类 parser error 改稳定 code；Authorization 拆成两个自足 key；新增「三种失败原因全部本地化」与「detail 永远是数据」两条；偏离登记在 4.7 |
| I4 | `src/types/index.ts` 越界，且 `CurlImportWarning` 会形成 types → utils 逆向依赖 | rev3 处置：按裁定 A19 纳入范围并把两个类型迁入 types 层（0.10 已核实零第三方 importer） |

**本节保留而不删除**，因为它记录的是一次**交付链路的失误**（裁定送达但正文未附）以及当时的正确应对方式：登记缺口、拒绝猜测、显式声明产物不完整。这比结论本身更值得留痕。
