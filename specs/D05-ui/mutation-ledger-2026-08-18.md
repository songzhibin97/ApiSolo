# D05 PR-A — 变异台账（2026-08-18）

范围：**PR-A（§1–§13 + 裁定 A22 的 §5 / §6 / §56 机制）**。§14–§58 属 PR-B，本台账不覆盖。

全部变异跑在 **HEAD `f2c43b6`**（PR-A 最终态），每个 mutant 跑**全套 313 个用例**。台账初稿在 `ce0a33d` 上跑过一次，`f2c43b6` 上**整批重跑**，26 行结果逐字相同。

---

## 0.0 TECH 4.4-a：§2 的硬前置（跑在写代码之前）

冻结规格 0.7 把「后端 `query_pairs_mut()` 把空格编成 `+`」标为**未验证的推断**，并要求实现者在动 `buildUrlWithParams` 之前跑掉它。**结果：推断为真。**

跑的是 `url` crate **本身**（`2.5.8`，取自 `src-tauri/Cargo.lock`），不是我对它的实现——P2 的原话。临时 crate 跑完即删，`src-tauri/` 一个字未动（`git diff d759711 -- src-tauri/` 为空）。

```
Url::parse("https://x/a").query_pairs_mut().append_pair("k", "a b")  ⇒  k=a+b
append_pair("a b", "c d")                                            ⇒  a+b=c+d
```

进一步把 **46 个样本**的 Rust 输出与 Node `URLSearchParams` 的输出逐字节 diff：**46/46 完全相同**，包括空格→`+`、`!`→`%21`、`~`→`%7E`、`(`→`%28`、`)`→`%29`、`'`→`%27`、`*`→`*`、`中`→`%E4%B8%AD`、`😀`→`%F0%9F%98%80`、空串、以及 `a+b`→`a%2Bb`（已有的 `+` 会被转义）。

因此 §2 的方向**不反转**，`encodeFormComponentPreservingTemplates` 走 `URLSearchParams` 是对的。**测试里那张 42 行的 `WIRE` 表就是这次 Rust 运行的输出**，不是照着前端类型声明推出来的（P11）。

> 规格 4.4-a 写的是「结果写进 ACCEPTANCE」。`ACCEPTANCE.md` 冻结后归 owner 维护，我没有往里写；证据放在这里，请 owner 决定是否转录。

判据取自冻结规格 4.6，一字不改：

> **VERIFIED** = ① 已实跑「应用该 patch ⇒ 该不变式的用例转红」；② 已实跑确认与它共用同一处生产代码的其他不变式用例**保持绿**；③ **被变异的是落盘的生产代码，被观测的是落盘的测试**。三者缺一不可。

外加两条本轮自加的硬要求：

- **H / W 标注**：`H` = 变异打在纯函数/helper 内部；`W` = 打在生产调用点。P8 的原话是「测试一个 helper，不等于测试这个 helper 被调用了」，所以这两列必须分开看。
- **P9 对照**：每一条声称「独立可杀」的断言，实跑「删掉该断言 ⇒ 该用例转绿」。冻结规格里 57 条**没有一行**做过这个对照。

---

## 0. 度量装置本身（P12）

台账开跑前先验 harness，不是跑完再解释。

| 自检 | 手段 | 结果 |
|---|---|---|
| **组件 harness 阶段 1**（TECH 4.3） | `shallowMount(UrlBar)` + 一条获准四类内的**正确**断言 | `Tests 1 passed` ⇒ import / setup / mount 三步全部走通 |
| **组件 harness 阶段 2** | 同一条断言故意改错 | `Tests 1 failed`，`AssertionError: expected {} to deeply equal { impossible: [ [ 'never' ] ] }` ⇒ **assertion mismatch**，不是 import / setup / mount error |
| **纯函数 harness**（TECH 4.3） | `splitTemplateSpans` 改 `return []`（已知必红） | `total=296 passed=279 failed=17`，17 条全部 assertion mismatch |
| **fail-closed 反向验证** | 故意给一个**不存在的 anchor** | `INCONCLUSIVE: anchor found 0 times (need exactly 1)`，**不是 SURVIVED** |

两阶段自检**通过**，因此 **§4 / §6 / §12(b) 三条组件类不变式不降级**，正常计入覆盖；`ACCEPTANCE` 里预留的降级落点 h / i / j 本轮**未被触发**（它们作为真机检查点仍然有效，只是不再承担自动化缺口）。

判定规则（全部由脚本正向匹配，不靠反向匹配失败标志）：

1. 用 `vitest --reporter=json` 取 `numTotalTests` / `numPassedTests` / `numFailedTests`。`passed + failed == 0` ⇒ `INCONCLUSIVE`。
2. 解析出的 failed 计数与枚举出的失败用例名数量不一致 ⇒ `INCONCLUSIVE`。
3. 全部失败都不是 assertion mismatch（import / setup / transform error）⇒ `INCONCLUSIVE`，**不得记为杀死**。
4. 打补丁前校验 anchor 在目标文件里**恰好出现 1 次**，否则 `INCONCLUSIVE`。
5. 每个 mutant 先跑 `vue-tsc --noEmit`；编译不过 ⇒ `ILLEGAL-PATCH`（P3），**不得记为杀死**。
6. 每个 mutant 跑**全套** 313 个用例，记录**完整杀伤集合**，不只记「红了」。
7. 跑完 `git status --porcelain` 必须为空，否则整批作废。

全批次运行后工作树 clean，已核对。

---

## 1. 台账

`H/W`：`H` = 变异在纯函数内部；`W` = 变异在生产调用点（接线）。
杀伤集合列出的是**全套 313 用例**里所有转红的用例，不限于目标不变式。

| § | 变异（落盘生产代码，单行/单块，可编译） | H/W | 结果 | 完整杀伤集合 | P9 对照 | 状态 |
|---|---|---|---|---|---|---|
| **§1** | `url-params.ts`：`if (isTemplateSpan(segment))` → `if (isTemplateSpan(""))` | H | RED 5/313 | §1 全 5 条 | ✅ 删断言 ⇒ GREEN | **VERIFIED** |
| **§2** | `url-params.ts`：`encoded.toString().slice(2)` → `encodeURIComponent(segment)` | H | RED 2/313 | §2 全 2 条 | ✅ | **VERIFIED** |
| **§3** | `url-params.ts`：`item.key.trim()` → `item.key` | H | RED 1/313 | §3 | ✅ | **VERIFIED** |
| **§4** | `RequestPanel.vue`：模板把 `auth.apiKey` 拼进传给 `UrlBar` 的 params | **W** | RED 1/313 | §4 | ✅ | **VERIFIED** |
| **§5** | `README.md` 删掉该句 / `README.zh-CN.md` 删掉该句（两个独立 mutant） | — | RED 1/313 各 | 英文条 / 中文条，**互不牵连** | ✅ ×2 | **VERIFIED** |
| **§6** | `AuthEditor.vue`：`v-if="isQueryApiKey"` → `&& false`（正向）／ → `\|\| true`（负向） | **W** | RED 1/313 各 | 「query 时调 t」／「header 时不调 t」，**互不牵连** | ✅ ×2 | **VERIFIED** |
| **§7** | `url-params.ts`：`/\{\{…\}\}/g` → `/^\{\{…\}\}/g` | H | RED 2/313 | §7「查询里的变量」「去重与顺序」；**§7「路径里的变量」保持绿** | ✅ | **VERIFIED** |
| **§8** | `url-params.ts`：`return previous.draft` → `return incoming.url` | H | RED 2/313 | §8、**§9** | ✅ | **VERIFIED**（§9 见下） |
| **§9** | 无独立 killer | — | — | 与 §8 共用 killer | — | **冗余**（冻结规格已如此登记） |
| **§10** | `url-params.ts`：删掉 `previous.revision !== incoming.revision` 整块（冻结 killer） | H | RED 2/313 | §10、**§11** | ✅ 断言承重 | **DESIGNED**（②不满足，见 §2 节） |
| **§11** | `url-params.ts`：revision 判据换回 `sameParse` 单行（冻结 killer） | H | RED 2/313 | §11、**§8** | ✅ 断言承重 | **DESIGNED**（②不满足，见 §2 节） |
| **§12(a)** | `UrlBar.vue`：watch 源 `[url, tabId, urlRevision]` → `[url, tabId, 0]` | **W** | RED 2/313 | §12(a) 两条；**§12(a) 的「url 变」「tab 变」两条邻居保持绿** | ✅ | **VERIFIED** |
| **§12(b)** | `RequestPanel.vue`：`:url-revision="activeTab.urlRevision"` → `:url-revision="0"` | **W** | RED 1/313 | §12(b) | ✅ | **VERIFIED** |
| **§13** | `url-params.ts`：删掉 `previous.tabId !== incoming.tabId` 整块 | H | RED 1/313 | §13 第一条；§13 第二条（previous 为 null）保持绿 | ✅ | **VERIFIED** |
| **§56**（机制） | `zh-CN.ts`：`auth.queryKeyHidden` 换成其英文文案 | H | RED 1/313 | §56 | ✅ | **VERIFIED（仅本 PR 新增的 1 个 key）** |

### 支撑性变异（不对应编号不变式，但锁住 §8/§10/§12 依赖的前提）

| 变异 | H/W | 结果 | 完整杀伤集合 | P9 |
|---|---|---|---|---|
| `tabs.ts`：`tab.urlRevision += 1` → `+= 0` | H | RED 2/313 | 「params 写入递增」「url 写入递增」 | — |
| `tabs.ts`：`updateTabFromUrlBar` 改成递增 | H | RED 1/313 | 「URL 栏回写不递增」 | ✅ |
| `tabs.ts`：`openHistoryEntry` 复用分支不再递增 | H | RED 1/313 | 「历史条目接管空白 tab 时递增」 | ✅ |
| `RequestPanel.vue`：`updateTabFromUrlBar` → `updateTab` | **W** | RED 1/313 | 「回写走不递增的那条路径」 | ✅ |
| `UrlBar.vue`：`onUrlInput` 不写 `draft` | **W** | RED 1/313 | §12(a)「把草稿与新来源交给协调器」 | — |
| `url-query.ts`：`splitTemplateSpans` → `[value]`（共享原语） | H | RED 2/313 | §1 两条（混排、模板旁的字节） | — |

---

## 2. §10 / §11 —— 冻结规格的一条独立性判断在真实代码上不成立

**度量**：

```
K10（删掉 revision 判据）        ⇒ RED: §10、§11
K11（revision 判据换回 sameParse）⇒ RED: §11、§8
```

**结论及其适用范围**：

- **§11 的冻结 killer 在真实代码上多杀一条 §8。** 冻结规格 0.13(1) 记的是「§10 / §13 邻居在该 mutant 下全绿，只有 §11 塌」——那是在 `/tmp/urlbar-rev3.mjs` 的重新实现上跑的。落到真实 `reconcileUrlBarValue` + 真实 `syncParamsFromUrl` 上，**§8 也塌**。
- **原因是实测出来的，不是推断**：mutant 下 §8 的失败输出直接给出了 diff——

  ```
  -   "https://api.test/a?q=hello world"
  +   "https://api.test/a?q=helloworld"
  -   "{{baseUrl}}/users?q=a b"
  +   "{{baseUrl}}/users?q=ab"
  ```

  即 **`sameParse` 会吃掉正在键入的空格**。用户打到 `…?q=hello ` 那一刻，`new URL()` 会把 URL 末尾的空格**剥掉**，于是 `syncParamsFromUrl` 得到 `q=hello`，回灌串是 `…?q=hello`；两侧解析结果**不同**，`sameParse` 判成「外部写入」并采纳，空格就没了，下一个字符接到 `hello` 后面。revision 判据不比较字符串，所以不受影响。
- **因此冻结规格 0.9 的第 1 条结论要收窄**：「`sameParse` 下键入模拟 10/10 全过」在**含空格的目标串**上不成立。这不影响 rev6 的设计选择（revision 判据本来就是对的），但它意味着 `sameParse` 比规格记录的更糟——它不只是「在语义相同的外部写入上失效」，它**还会破坏普通键入**。
- **§10 没有任何隔离它的 mutant。** 唯一能让 §10 红的变异是动 revision 判据那一处，而那一处同时是 §11 的判据。反过来 §11 的 mutant 让 §10 保持绿。**§10 与 §9 同类：它是 §11 在更容易的 fixture 上的实例**，不是一条独立可杀的属性。

**处置**：按判据②，§10 与 §11 **均记 DESIGNED**，不计入 VERIFIED。两条的**断言层**承重性都已用 P9 对照实跑证明（删断言 ⇒ 用例转绿），缺的是**用例层**的可分离性。这是一个需要 owner 裁定的规格问题，我没有自行改规格。

---

## 3. 三条冻结 killer 编译不过（P3）

`tsconfig.json` 开着 `noUnusedLocals`，于是三条冻结 killer 直接被 `vue-tsc` 拒绝，按 P3 它们**不是合法 killer**：

| 冻结 killer | `vue-tsc` 报错 | 本轮改用的合法变体 |
|---|---|---|
| §1：`if (isTemplateSpan(segment))` → `if (false)` | `TS6133: 'isTemplateSpan' is declared but its value is never read` | `if (isTemplateSpan(""))`（恒假，符号仍被使用） |
| §6：该说明的 `v-if` 整行删除 | `TS6133: 'isQueryApiKey' is declared but its value is never read` | `v-if="isQueryApiKey \|\| true"`（语义等价：说明恒显示） |
| §12(b)：`:url-revision="activeTab.urlRevision"` 整行删除 | `TS2345: Property 'urlRevision' is missing …` | `:url-revision="0"` |

**§12(b) 这一条值得单独说**：`urlRevision` 被做成 `Tab` 的必填字段与 `UrlBar` 的必填 prop，所以「忘了传」这个缺陷**在类型上不可表达**——它是编译错误，不是测试红。按 P8 结尾那句「结构性保证优于测试保证」，这比 killer 更强；但它也意味着冻结表给 §12(b) 写的那个 killer 打不出来。两件事都记在这里，任选其一都不足以描述现状。

**§6 的另一处偏差**：冻结表给 §6 的承重断言只有正向一条（「query 时 `t` 被以该 key 调用」），而冻结 killer 是「`v-if` 整行删除」——那个 killer 让说明**恒显示**，正向断言在它下面**仍然绿**。也就是说冻结表里这一行的 killer 与断言对不上。本轮补了负向断言（「header 时不调用该 key」）与第二个 mutant，使**两个方向各有一个单塌**，冻结 killer 因此有了对应的红。

---

## 4. 存活的变异（SURVIVED）—— 已登记的验证缺口

两条 P8 型接线变异**全套 313 用例全绿**。它们是真实的缺口，不是「不重要」。

| 变异 | 后果 | 为什么没被测到 | 落点 |
|---|---|---|---|
| `UrlBar.vue`：`<input :value="draft">` → `:value="props.url"` | **本切片要修的原始缺陷整个回来**：输入框重新变成受控回灌，打 `?` 又会被吃掉 | 要抓它必须断言 `<input>` 的 `value`。裁定 **A20** 把组件断言限死在四类（发出的事件 / 传给子组件的 props / `v-if`·`v-for` 的存在性与条数 / 对 store 或注入函数的调用），输入框的 `value` 不在其中 | **人工检查点 4.5-f**（逐字符手打 `https://api.test/a?x=1` 必须原样出现） |
| `UrlBar.vue`：`detectTemplateVariables(draft.value)` → `(props.url)` | 变量提示按回灌串而非草稿计算 | 同上：要抓它得断言提示条的存在性，而提示条没有可用的稳定选择器；加 `data-testid` 属于为可测性动生产代码，本轮未做 | 影响面小（两串的变量集合通常相同），**未安排检查点**，如实登记 |

第一条的代价必须说清楚：**它能让本切片的核心缺陷完整复发，而全套自动化测试不会红。** 4.5-f 是它当前唯一的防线。

---

## 5. 一条观察（不属 PR-A，供 D06 参考）

`url-query.ts` 的 `splitTemplateSpans` 改成 `return [value]` 后，`curl-export` 与 `postman-export` 的既有模板测试**全部保持绿**——因为它们的 fixture 里模板值都是**整串就是一个模板**（`{{apiToken}}`），这种情况下 `isTemplateSpan(整串)` 仍为真、仍走原样返回。只有**模板与普通文本混排**（`x{{a}}y`）才会暴露。这两个模块的模板覆盖因此比看上去弱。不在本 PR 范围，仅记录。

---

## 6. 三态汇总

| 状态 | 条数 | 编号 |
|---|---|---|
| **VERIFIED**（落盘生产代码上单塌成立，且共用生产代码的邻居保持绿，且有 P9 承重对照） | **11** | §1、§2、§3、§4、§5、§6、§7、§8、§12(a)、§12(b)、§13 |
| **VERIFIED（受限）** | **1** | §56 —— **机制已建立，只覆盖本 PR 新增的 1 个 key**。扩到 20 个 key 属 PR-B，其「已证明」状态**日期归 PR-B** |
| **DESIGNED**（有合法 killer、断言层承重已证，但无隔离用例层的 mutant） | **2** | §10、§11 |
| **冗余**（明确不独立可杀） | **1** | §9 |
| **INCONCLUSIVE** | **0** | —— |
| **SURVIVED**（已登记缺口） | **2** | 两条 P8 接线变异，见第 4 节 |

**度量**：PR-A 的 13 条不变式加 §56 机制，共跑 26 个合法 mutant（另有 3 个冻结 killer 被 `vue-tsc` 判为 ILLEGAL-PATCH 并已换成合法变体），19 条 P9 承重对照全部 `LOAD-BEARING`。

**结论及其适用范围**：PR-A 的行为内核（§1–§8、§12、§13）与 A22 的三项（§5、§6、§56 机制）**已在落盘生产代码上被证明单塌**。**但**：§10 / §11 只到 DESIGNED；URL 栏「输入框绑到草稿而不是 prop」这一条接线**没有任何自动化覆盖**，只有真机检查点 4.5-f；§56 只覆盖 1 个 key，不得读成「文案矩阵已证明」。
