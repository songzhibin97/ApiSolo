# D01 — 验收记录

本文件是「什么通过了」的唯一权威。轮次**只追加不改写**；被撤销的豁免与被推翻的结论保留在原处并标注。

- 切片：D01 历史重放毒化与脱敏正确性
- 分支：`songzhibin/d01-history-redaction`
- 起点：`410b32b`（main）
- 基线（起点处 owner 亲跑）：vitest **15 files / 84 passed**；cargo **68 passed**

## 角色

| 角色 | 承担者 | 产出 |
|---|---|---|
| owner | 本会话 | 裁定、gate 亲跑、合并 |
| implementer | subagent | 代码 + 测试 + 自检报告（自检**不是**验收证据） |
| reviewer | codex CLI（独立模型） | 逐轮 verdict |

三条证据流互不顶替。

---

## 阶段 1 — 立项

已归档于 `specs/BACKLOG.md` D01 条目。9 个 backlog 项。

## 阶段 2 — spec 起草

实现者：spec subagent（仅写 spec，无实现代码；落盘经 `git status` 确认只有 `specs/D01-history-redaction/`）。

产出：`PRODUCT.md`（27 条 Behavior 不变式）+ `TECH.md`（27 行不变式→测试→变异检查映射表）。

### 起草者主动上报的 4 处与来源文档的分歧

| # | 分歧 | owner 独立验证 | 裁定 |
|---|---|---|---|
| A1 | `REVIEW-2026-08-18.md` §28 的对抗验证记录称 `{"authorization":"Basic xxx"}` 脱敏后安全，实为 `{"authorization":[redacted]}`（非法 JSON） | owner 从 `src/stores/request.ts` 抽出 `redactSensitiveText` 原文在 node 中实跑 5 例：3 例 JSON 输入全部 INVALID-JSON | **采纳**。影响面比原报告大：所有含敏感键的 JSON 请求/响应体在历史里都不可解析。另 owner 实测出报告未记的一条：`Authorization: Basic dXNlcjpwYXNzd29yZA==` → `Authorization: [redacted] dXNlcjpwYXNzd29yZA==`，脱掉 scheme、凭据留存，已由 §11 覆盖 |
| A2 | `Q1 #4`「重放时 URL 栏显示真值」不可复现 | owner 读 `RequestPanel.vue:425-470`：传给 UrlBar 的是 `buildUrlWithParams(activeTab.url, activeTab.params)`，`splitUrlParts:434` 先剥 query | **采纳**。`BACKLOG.md` 已加勘误 2；修复目标改为「落盘脱敏 + 面板/标签仍可辨认」 |
| A3 | `BACKLOG.md` 的 `REVIEW #n` 编号整体偏移 +2 | owner 复核：确为 owner 编写 backlog 时的编号错误 | **采纳**。`BACKLOG.md` 已加勘误 1，定位一律以 `file:line` 为准 |
| A4 | `REVIEW #32`（脚本洗白 secret）在 D01 内只能做到「值完全相同的整体复制继承 secret 标记」，派生复制（`token.slice(0,10)`）追不到 | owner 复核：完整污点追踪需要改造 QuickJS 运行时，量级远超本切片；且评审自身的对抗记录已判「覆写既有 secret」为非缺陷（Postman 标准用法） | **采纳**。§22 锁定整体复制传播，§23 锁定既有 secret 不被降级，派生复制列为 non-goal 并**必须写进 README**（项目硬规则：决策不落到 README/UI，下一轮扫描会当高危重报） |

### owner 机械交叉检查（**非独立**，不计作评审轮次）

| id | 问题 | 处置 |
|---|---|---|
| O1 | `PRODUCT.md §16`（「重放时 URL 栏显示的 query 与实际上线一致」）与 `TECH.md 4.1` 第 16 行的测试名 `derives blanked params from a redacted legacy url` 及其变异检查不是同一个命题——映射表这一行对不上不变式 | 移交 reviewer 轮次判定 |
| O2 | `TECH.md 2.1` 要求 Rust 侧用 `include_str!` 读取 `src/utils/__fixtures__/sensitive-keys.json`，但**没说明这是否 `#[cfg(test)]` 门控**。若未门控，`src-tauri` 这个原本自包含的 crate 会在 release 构建期依赖前端 `src/` 目录，任何只打包 `src-tauri/` 的构建路径都会编译失败 | 移交 reviewer 轮次判定；owner 倾向：必须 test-only |

owner 已独立复核并**证实**的 spec 技术假设（非评审轮次，仅记录已验事实）：

| 假设 | 出处 | 验证 |
|---|---|---|
| 从 `request.ts` 导出脱敏函数会形成循环依赖 | `TECH.md 2.2` | 成立。`request.ts:10` 导入 `./tabs`；`tabs.ts` 当前不导入 `request.ts`（`grep '^import' src/stores/tabs.ts`），故反向导入即成环 |
| Rust 侧无 `deny_unknown_fields`，多余字段被静默丢弃 | `TECH.md 2.4` | 成立。`grep -rn deny_unknown_fields src-tauri/src/` 命中 0 处 |
| `recordConsoleEntry` 用模块单例 pinia，测试须绕开 | `TECH.md 4` 陷阱 1 | 成立。`console.ts:114-120` 为 `useConsoleStore(pinia)[level](...)` |

## 阶段 3 — spec 评审轮次

| 轮次 | 评审者 | verdict | 状态 |
|---|---|---|---|
| R1 | codex（独立）+ owner 追加 1C | **REVISE(4C + 6I + 2M)** | 已下发 rev2，待收 |

### R1 — 逐条 disposition

全部 11 条 codex findings + owner 追加 1 条，**无驳回**。

| id | 严重度 | 摘要 | owner 复核 | disposition |
|---|---|---|---|---|
| D01-R1-01 | C | 规格完全漏掉 `requestBodyContent`；§8 修好后 `{"password":"[redacted]"}` 反而从「非法 JSON 拒发」变成「合法 JSON 成功发出」 | 复核 `tabs.ts:363` 恢复 body、`request.ts:314` 原样入 payload，成立 | rev2 采纳 |
| D01-R1-02 | C | 拟定正则链对 Basic 重复脱敏、对 Digest 漏凭据 | **owner 实跑证实**：Basic → `Authorization: [redacted] [redacted]`；Digest → username/realm/nonce/response **全部残留** | rev2 采纳 |
| **D01-R1-12** | **C** | **owner 追加**：§8 的规定实现治不好 §8。`{"password":"hunter2"}` 经拟定三条规则输出 `{"password":[redacted]}`，**仍非法 JSON**。负向先行 `(?!\[redacted\])` 无效——规则 2 产出 `"password":"[redacted]"`，规则 3 在 `"password":` 处匹配时先行断言检查的是 `"` 而非 `[`，断言通过、引号再次被吃 | owner 实跑（`/tmp/spec_regex_probe.mjs`），同批次实测 §9 的 urlencoded 修法**有效**，予以保留 | rev2 采纳；与 C2 合并重新设计，要求改走结构化处理而非继续叠正则 |
| D01-R1-03 | C | merge-by-id 未消除竞态，TECH §3「没有引入新的失败模式」不成立 | 复核 `append_history` `lib.rs:2029`读/`:2037`写，无锁 RMW；codex 给的交错序列成立 | rev2 采纳。**owner 裁定归属**：锁归 D01 不推给 D03——第二个写入者由 D01 引入，谁引入谁负责；D03 的 tmp+rename 解决崩溃原子性，与锁正交，两者都要且不互相替代 |
| D01-R1-04 | I | 即 O1，PRODUCT §16 与映射表第 16 行不同命题 | 成立 | rev2 采纳 |
| D01-R1-05 | I | `redactUrlQuery` 用 `URL`/`URLSearchParams` 重序列化，违反 §15「其余部分原样保留」 | 成立 | rev2 采纳，改按原始字符串切分 |
| D01-R1-06 | I | §1/§4 测试只覆盖部分集合，杀不掉「漏遍历一个集合」 | 成立 | rev2 采纳，改表驱动 |
| D01-R1-07 | I | §26 的测试与 killer 只覆盖 history，未覆盖 `save_request` | 成立 | rev2 采纳 |
| D01-R1-08 | I | Rust 硬名单扩容对既有 collection 的破坏性未落成产品行为与验证 | 成立 | rev2 采纳 |
| D01-R1-09 | I | 「占位符永不上线」是绝对承诺，但 WS 握手 header 绕过闸门 | 成立 | rev2 采纳。**owner 裁定**：承诺收窄为「HTTP 历史重放路径」，WS 列为明确 non-goal，但起草者须**自行验证** `buildHistoryEntry` 只被 HTTP `sendRequest` 调用后才可写该理由 |
| D01-R1-10 | M | `[redacted]` 是 10 字符不是 9 | 成立（owner 先前转述亦沿用了错误字数） | rev2 采纳，改为不写字数 |
| D01-R1-11 | M | `history.legacySanitized` 文案把「所有被改写的条目」说成「早于脱敏功能的条目」 | 成立 | rev2 采纳，改中性文案 |

O2（`include_str!` 是否 `#[cfg(test)]` 门控）codex 未单独列出；owner 保留该项，要求 rev2 明确 test-only 门控。

| R2 | codex（独立） | 待出 | 进行中 |

### R2 — owner 机械交叉检查（**非独立**，在 codex R2 结论回来前先行记录，disposition 待与 R2 合并后一并下发）

| id | 严重度 | 问题 |
|---|---|---|
| O3 | C（与 R1-02 同类） | rev2 的 text 路径 T2 仍会**打上标记却不脱敏**。owner 按 `TECH.md 2.3.4` 的规则原样实现 T1/T2 后跑 7 条探针，3 条泄漏 |

证据（owner 实跑 `/tmp/rev2_probe.mjs`）：

```
输入  Digest username="Mufasa", realm="…", nonce="…", response="…"      （无 Authorization: 锚点）
输出  Digest [redacted]"Mufasa", realm="…", nonce="…", response="…"
泄漏  Mufasa / realm / nonce / response
```

同样形态还有 `Digest realm=…, nonce=…, qop="auth"`（WWW-Authenticate 风格）与 `proxy said Basic "…" ok`。

根因：T2 的字符类 `[^\s"',;]+` 在第一个 `"` 处停止，只吃掉 scheme 后的第一个片段。有 `Authorization:` 锚点的两条由 T1 兜住、确实修好了；**裸 scheme 的没有兜底**。

为什么算 C 而不是可接受的既定边界：「用户手写进普通字段名下的裸凭据仍会落盘」是已裁定的 non-goal，**完全不脱敏是可以接受的**；但打上 `[redacted]` 却把凭据原样留在旁边，是主动发出假信号——正是 §11 当初为消灭它而设立的形态，也是 R1-02 被判 CRITICAL 的同一条理由。

owner 倾向修法：T2 与 T1 采取同一纪律，消费到行尾。

> **⚠️ 该倾向已被 R2-02 推翻，未采纳，保留原文以留痕。** codex R2 指出更根本的问题：T2 按**值的内容**判断敏感性，违反项目硬规则。owner 的修法只堵住假阴性，没有解决假阳性（`{"note":"Digest authentication is required"}` 被按内容改写）。最终裁定见下方 R2 disposition。

### R2 — 逐条 disposition（codex 3C + 7I，全部采纳，无驳回）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R2-01 | C | 裸 Digest 仍泄漏（与 owner O3 同一发现，两边独立跑出同一输出） | rev3 采纳，与 R2-02 合并处置 |
| R2-02 | C | T2 按内容判断敏感性，违反「绝不做内容识别」硬规则 | rev3 采纳。**见下方架构裁定** |
| R2-03 | C | 整体 `JSON.parse`+`JSON.stringify` 破坏非敏感数据：`9007199254740993123456789` → `9.007199254740993e+24`；`{"id":1,"id":2,…}` 重复键被折叠 | rev3 采纳，改为保留原始字节的 span 替换 |
| R2-04 | I | 按 `\n` 切行吃掉 `\r`，已脱敏 CRLF 文本再脱敏非逐字节不变，违反自身 §14 幂等承诺 | rev3 采纳 |
| R2-05 | I | `applyPairEdit` 无条件清 `redacted` 标记，只切 enabled 也会清掉，值仍为空但提示条消失 | rev3 采纳 |
| R2-06 | I | rev2 自称 `load_history` 锁点「无法构造 killer」，实际构造方法与四个写命令完全相同 | rev3 采纳，起草者确认自己判断有误 |
| R2-07 | I | 闸门覆盖 collection，但无测试证明该链路 | rev3 采纳 |
| R2-08 | I | `decodeURIComponent` 遇 malformed percent 抛 `URIError` | rev3 采纳 |
| R2-09 | I | 变异列存在**实测 survivor**，多条 killer 非单行/编译不过 | rev3 采纳。起草者复现后找到更深根因（`exec` 命中即 `return` 留下非零 `lastIndex`，使幂等断言结果取决于调用顺序），改为函数内构造正则从结构上消除共享状态 |
| R2-10 | I | §15 三项取舍只锁定了一项 | rev3 采纳 |

### 架构裁定 A5 — 删除内容识别层（对既定决策的受控修订）

**裁定**：删除 T2 及 JSON 中对非敏感字段字符串值的 scheme 扫描。脱敏回归纯字段名驱动。键锚定的 T1（含作用于自由文本的 `password: xxx`）保留——它是字段名驱动的。

**理由**：半吊子的内容扫描同时制造假阴性（打上 `[redacted]` 却把凭据留在旁边，比不脱敏更危险，因为读历史的人会以为它干净了）与假阳性（正常散文被毁）。项目已裁定的边界本就是「用户手写进普通 header/body 的明文不负责识别」，此举是让实现与该边界一致。

**受控修订的对象**：项目记忆 `redaction-field-name-rules.md` 记录了现存的 Bearer 兜底内容正则（`request.ts:560`）。本切片移除它。README 与 SECURITY.md 同步声明；记忆文件由 owner 更新。

**防回滚保护**：rev3 的 §15 是负向不变式（四行表驱动锁定「不脱敏也不标记」），其 killer 即「把 T2 那一行加回去」——防止本裁定被后续改动悄悄撤销。

| R3 | codex（独立） | **REVISE(3C + 3I + 1M)** | 已处置 → rev4 |
| R4 | codex（独立） | **REVISE(2C + 1I)** | 已处置 → rev5 |
| R5 | codex（独立） | **REVISE(1C)** | 已处置 → rev6 |
| R6 | codex（独立） | **REVISE(1C + 1I)** | 已处置 → rev7 |
| R7 | codex（独立） | **REVISE(1C)** | 已处置 → rev8 |
| R8 | codex（独立） | **APPROVE（0C / 0I / 0M）** | ✅ **已冻结** |

### R8 — APPROVE，规格冻结

**冻结版本**：`rev8`。**冻结时刻**：2026-08-18。**冻结后任何改动都必须是标注理由的受控修订。**

评审核验要点（全部为独立实跑，非静态阅读）：

- **R7 的唯一 CRITICAL 已修复**：独立编写 Rust 模型，`rustc 1.95.0` 同一进程复现——带 `child_ok` 时 `verdict/outcome/final` 三项均通过、仅 `child_ok=false` 导致 RED；**移除 `child_ok` 后同一探测转 GREEN**。承重性成立。
- **汇总可复现**：`TOTAL=41 WRONG=1 EXIT=0`，唯一的 `WRONG` 正是故意移除断言后出现的错误 GREEN，解释成立。
- **中毒路径成立**：首次 `HarnessError`，cleanup 后下一 case 恢复 `LockHeld` 且 `poisoned_now=false`。
- **owner 裁定的前提已被实证**（而非仅被接受）：评审向既有测试**注入 mutant** 逐一验证——append 改 no-op → RED；load 返回空集合 → RED；delete 去掉 retain → RED；clear 改 no-op → RED；`update` 由 §29 独立规定 merge-by-id，`merged → entries` 会删除未列出的行，killer 与 §30 锁测试相互独立。**故「命令语义在别处有自己的不变式与有效 killer」成立，验证缺口的接受裁定有效。**
- TECH 三处明确登记 `outcome`/`final` 未证明及其冗余定位，**无一处声称它们是独立 killer**。
- 1:1 映射通过（PRODUCT 与 TECH 均恰为 1–41）；变异抽查 14 行无 survivor；硬规则与 scope 全部通过。

### 阶段 3 小结

| 轮次 | verdict |
|---|---|
| R1 | REVISE(4C + 6I + 2M) |
| R2 | REVISE(3C + 7I) |
| R3 | REVISE(3C + 3I + 1M) |
| R4 | REVISE(2C + 1I) |
| R5 | REVISE(1C) |
| R6 | REVISE(1C + 1I) |
| R7 | REVISE(1C) |
| R8 | **APPROVE(0C / 0I / 0M)** |

八轮，累计 15 条 CRITICAL 判定（含 owner 追加 1 条），**全部在写实现代码之前拦下**。其中至少 5 条属于同一族：测试会绿，但证明不了它声称的命题。

## 阶段 4 — 实现

**状态**：待开始。冻结 spec 为 `rev8`。

> **账本时效性事故（owner 自记，2026-08-18）**：本文件曾停在「R3 进行中」达五轮，其间 R4–R7 的 verdict、逐条 disposition、两条新裁定与两个已实证漏洞全部未入账。是 D01 起草者在被要求「把某个缺口登记进 ACCEPTANCE」时指出的——它拒绝代笔，理由包括「只补这一条会得到一份记录了一个缺口、却漏了五轮结论的账本，比现在更容易误导」。该判断正确。
>
> owner-pipeline 的纪律是「ACCEPTANCE 是什么通过了的唯一权威，一条 ACCEPTANCE 记录胜过任何人的记忆或转述」。**一份滞后五轮的权威账本，比没有账本更危险**——它看起来是权威的。下方内容为 owner 补记。

### R3 — disposition（3C + 3I + 1M，全部采纳）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R3-01 | C | 删除内容扫描不彻底：`redactValue` 非敏感分支仍走内容扫描，`X-Note: password: hunter2` 被改写且不带待重填标记 | rev4 采纳，`redactValue` 语义写死为两分支 |
| R3-02 | C | JSON 转义键绕过硬名单：`{"\u0070assword":"x"}` 不脱敏，而标准解析后即 `password` | rev4 采纳（**但 R4 查出只是表面修复，见下**） |
| R3-03 | C | 五个 block 测试证明「有锁」，证明不了「锁覆盖 I/O」：把 guard 移到 I/O 之后，五个测试全部继续通过 | rev4 采纳，断言从「返回时机」改为「文件状态」（**R4 查出仍依赖调度**） |
| R3-04 | I | §15 只证明脱敏函数输出不变，未走完整往返 | rev4 采纳 |
| R3-05 | I | §7 的 mutation 是确定性 survivor，实际由 §6 杀死 | rev4 采纳 |
| R3-06 | I | §12 未锁「未命中的对象/数组必须继续递归」 | rev4 采纳 |
| R3-07 | M | 「整列均为单行 patch」声明不实 | rev4 采纳 |

### R4 — disposition（2C + 1I，全部采纳）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R4-01 | C | **锁测试仍非确定性 killer**：`recv_timeout` 只证明「200ms 内没收到结果」，证明不了子线程已完成取锁前的 read。给错误实现的子线程加 250ms 延迟后四种 mutant 全部存活 | rev5 采纳，改为测试专用 I/O checkpoint + `try_lock`，断言中不含任何 timeout |
| R4-02 | C | **转义 fixture 在规格文件里丢了反斜杠**，声称对比「普通键 vs 转义键」实际两边都是普通键，于是 `isSensitiveKey(raw)` mutant 杀不掉 | rev5 采纳。起草者发现反斜杠被吃是其写入链路的**系统性**行为（`String.raw` 无效，`od -c` 才发现），故改为换依赖而非「下次小心」 |
| R4-03 | I | 变异列三处非「最小可编译 patch」 | rev5 采纳 |

**衍生规则**：本轮的两条 C 直接催生了仓库规则 **P6**（会静默退化的 fixture 必须先自检）。

### R5 — disposition（1C，采纳）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R5-01 | C | **checkpoint 不是一次性的**：协议只 resume 一次就 join，而 append/delete/update 都是 read+write 两次 I/O，于是双方永久互等。真 rustc 建模下正确实现与三种 mutant 在 0ms/250ms 全部挂死 | rev6 采纳，改用 `take()` 使一次性成为**机制本身**的性质 |

**owner 记录**：起草者查明 rev5 记录的 PASS 矩阵是真的，但**产生它的 harness 与落盘协议不同**（harness 有一句排空循环，正文漏写）。这直接催生了 **P6 的推广**：任何「我跑过」的记录都必须能从落盘正文原样重放。

### R6 — disposition（1C + 1I，全部采纳）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R6-01 | C | **失败收口未闭合**：锁中毒分支直接 panic 绕过 cleanup；`join` 结果被捕获但从未断言，于是子线程在 checkpoint 后 panic 时测试仍以 `EXIT=0` 通过 | rev7 采纳，RAII cleanup guard + 统一断言四项；起草者自加 `clear_poison()` |
| R6-02 | I | 风险表仍声称字节/内容断言证明锁位点，与正文三处自我限定冲突 | rev7 采纳。**衍生自加纪律**：自我限定必须扫全文 |

### R7 — disposition（1C，采纳）

| id | 严重度 | 摘要 | disposition |
|---|---|---|---|
| R7-01 | C | **panic 用例不是 `child_ok` 的独立 killer**：该用例同时让返回值与终态断言失败，删掉 `child_ok` 后仍 RED，故证明不了 R6 漏洞已被回归锁住 | rev8 采纳，panic 推迟到命令跑完之后；实跑 WITH ⇒ RED / WITHOUT ⇒ GREEN |

**衍生规则**：本轮催生仓库规则 **P9**（断言必须被证明是承重的）。

### 验证缺口登记（owner 已裁定接受）

| 缺口 | 位置 | 状态 | 裁定理由 |
|---|---|---|---|
| §30 统一断言中的 `outcome`（命令返回值）与 `final`（终态）两项**没有各自的单塌用例**，其「独立可杀」性未经实验证明 | `TECH.md` 4.2.3 已写死该缺口 | **owner 已裁定接受，不在冻结前补** | 这两项断的是命令语义，而命令语义在别处有自己的不变式与 killer；它们在 §30 里的角色是**冗余而非证明**。冗余缺少承重证据不构成谎言——只要文档不声称它们是独立 killer，而 TECH 4.2.3 已明确写死。相对地 `verdict` 与 `child_ok` 锁住的是**已被实证存在**的两个漏洞（三种错误锁位点、命令 panic 而测试通过），二者承重均已实跑证明，这是本测试存在的理由。 |
| 补法（若将来要补） | — | — | 构造只让该项失败的 fixture，并实跑「移除该断言 ⇒ 该用例转 GREEN」，与 `child_ok` 本轮做法相同。 |

> **裁定前提的精确化（起草者只读自查，owner 采纳并记录）**：裁定原话是「命令语义在**别处**有自己的不变式和 killer」。对 `append_history` / `load_history` / `delete_history_entry` / `clear_history` 四条，「别处」确指**既有 Rust 测试**（`test_append_and_load_history` `lib.rs:3258`、`test_history_delete_entry`、`test_clear_history` `lib.rs:3777`，另 `test_history_cap` `lib.rs:3335` 覆盖 1000 条上限），与本切片无关，成立得很干净。
>
> **但 `update_history_entries` 是本切片新增的命令**，其语义覆盖来自本切片自己的 §29（`test_update_history_entries_preserves_unlisted_rows`，killer 为 `write_history_entries(&merged)` → `(&entries)`）。§29 与 §30 是两条独立不变式、各有独立 killer，**故前提仍然成立**；但这一条的「别处」指的是**同切片内的另一条不变式**，不是外部既有测试。记录此区别，以免后人从「别处」二字推断成五条都有外部覆盖。
>
> owner 亦已确认：TECH 全文提及 `outcome`/`final` 共五处，方向全部是否定或如实记缺口（0.1(3)、0.2、4.2.3、4.2.4、风险表），统一断言表里那两行写的是「防的是什么」而非「独立可杀」。**无任何一处声称它们是独立 killer。**

> **该裁定本身已交由 R8 核验**：owner 要求评审确认其前提成立——命令语义是否确实由其他不变式覆盖且各自有有效 killer；若否，此缺口不可接受、应标为 CRITICAL。**裁定也要能被证伪。**

### 本切片衍生的仓库规则与裁定

| 产出 | 出处 |
|---|---|
| 规则 **P1**（评审飞行途中产物冻结） | owner 派评审时未交代规约，两个切片同日 mid-flight 修改 |
| 规则 **P4**（他方陈述须验证或标注转述） | 本切片写下一个当时并不存在的对方文件路径 |
| 规则 **P5**（跨文档引用只引行为，不引标识符） | 裁定 A7，判据后由「章节号」放宽至「标识符」（含条目 ID 与文件路径） |
| 规则 **P6**（fixture 自检 / 记录可重放） | R4-02、R5-01 |
| 规则 **P9**（断言必须被证明承重） | R7-01 |
| 裁定 **A1**（history 互斥锁归 D01） | R1-03 |
| 裁定 **A5**（删除内容识别层） | R2-02 |
| 裁定 **A7**（跨文档引用） | 见 P5 |
| 裁定 **A12**（`get_history_health` 而非改签名） | D03 起草者推翻 owner 倾向 |
| 编号冲突修正（规则改用 `P` 前缀） | 本切片起草者发现规则 `R<n>` 与评审轮次 `R<n>` 无法从字面区分 |
