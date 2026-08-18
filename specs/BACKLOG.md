# ApiSolo 交付 backlog

单调递增编号。新会话从**尾部**条目续接，不要从上方的旧快照续接。

来源：`docs/review/REVIEW-2026-08-18.md`（49 条提出 / 43 条通过对抗性验证）+ `docs/review/Q1-cookie-redaction.md` + `docs/review/Q2-history-annotations.md`。

> **勘误（owner，D01 spec 阶段）**：下表各切片里写的 `REVIEW #n` 编号整体偏移 +2（如 D01 的 `#29` 实为报告 §27）。定位一律以 `file:line` 为准，不以编号为准。
>
> **勘误 2**：D01 的 `Q1 #4` 描述有一半不成立。「重放时 URL 栏显示真值」不可复现——`RequestPanel.vue:466` 传给 UrlBar 的是 `buildUrlWithParams(activeTab.url, activeTab.params)`，`splitUrlParts`（`:435`）已先剥掉 `tab.url` 的 query。可证实的部分只有：`url: tab.url` 原样落盘（`request.ts:460`），并被 `HistoryPanel.vue:64` 与 `tabs.ts:499` 显示出来。修复目标相应改为「落盘脱敏 + 面板/标签仍可辨认」。

流程：`owner-pipeline` skill。owner 调度 + 亲验，subagent 实现，codex 独立评审。

## 状态图例

`filed` → `spec` → `frozen` → `impl` → `gates` → `review` → `merged`

## 切片

| id | 标题 | 严重度构成 | 状态 | 分支 |
|---|---|---|---|---|
| D01 | 历史重放毒化与脱敏正确性 | 1 high / 6 med / 1 low | filed | `songzhibin/d01-history-redaction` |
| D02 | HTTP 报文正确性 | 1 high / 5 med / 1 low | filed | `songzhibin/d02-http-wire` |
| D03 | 持久化数据丢失 | 4 high / 3 med | filed | `songzhibin/d03-persistence` |
| D04 | WebSocket 生命周期 | 1 high / 5 med / 2 low | filed | `songzhibin/d04-websocket` |
| D05 | UI 交互缺陷 | 2 high / 3 med / 3 low | filed | `songzhibin/d05-ui` |
| D06 | 导入导出保真 | 1 high / 6 med / 1 low | filed | `songzhibin/d06-import-export` |
| D07 | 历史备注 / 收藏（新功能） | — | filed | `songzhibin/d07-history-annotations` |

排序理由：D01 是用户亲历的 bug 且踩在「UI 不许说谎」红线上；D02 影响每一个请求的正确性；D03 是数据丢失（最贵的回归）；D04–D06 依次递减；D07 是新功能，排在债务之后。

并行约束（按文件独占切分，owner 维护）：

- D01/D02/D03/D04 都写 `src-tauri/src/lib.rs`，**必须串行**。
- **D06 独占 `src/utils/**`**（curl-parser / curl-export / postman-* / openapi-import）——与 D01 无交集，可并行。D01 新建的 `src/utils/redaction.ts` 是新文件，不冲突。
- **D05 独占 `src/components/**` 中除 `KeyValueEditor.vue` 外的部分**，且因 D01 也改 `RequestPanel.vue`，**D05 必须排在 D01 之后**。
- 原属 D06 的 `RequestPanel.vue:225` 已移入 D05，以保住 D06 的 `src/utils/**` 文件独占边界。

---

## D01 — 历史重放毒化与脱敏正确性

**状态**：filed
**为什么是一个切片**：全部围绕同一条边界——「哪些值可以落盘 / 哪些值可以回到 tab 里被再次发送」。

| 来源 | 位置 | 严重度 | 问题 |
|---|---|---|---|
| Q1 #1 | `src/stores/tabs.ts:356` | high | `openHistoryEntry` 把字面量 `[redacted]` 当真值灌回 tab，重放时真的发到线上 |
| Q1 #2 | `src/stores/request.ts:565` | med | `redactSensitiveText` 第三条正则撤销第二条加的引号 → 历史里的 JSON body 变成非法 JSON；`[^"',\s}]+` 不排除 `&` → urlencoded body 被吞掉后续字段 |
| REVIEW #31 | `src/stores/request.ts:549` | med | `isSensitiveKey` 漏 camelCase 与 vendor key（`accessToken`、`Ocp-Apim-Subscription-Key`）→ 明文落盘 |
| Q1 #4 | `src/stores/request.ts:459` | med | 历史 `url` 字段原样落盘未脱敏；且重放时 URL 栏显示真值、线上发 `%5Bredacted%5D` |
| REVIEW #30 | `src/stores/request.ts:565` | med | `redactSensitiveText` 在第一个空白处停止 → `Authorization: Basic <base64>` 凭据原样留存 |
| Q1 #3 | `src/i18n/zh-CN.ts:212` `en.ts:212` | med | `history.securityNotice` 文案与代码行为相反，且不提示重放已丢凭据 |
| REVIEW #29 | `src-tauri/src/lib.rs:2041` | med | history 无 sanitize-on-read、无迁移 → 2026-04-27 之前的明文条目永久留存（用户真实文件中有 19 条） |
| REVIEW #32 | `src/stores/request.ts:384` | med | 脚本可把 secret 变量洗成普通变量，随后明文写进 `.env.json` |
| REVIEW #41 | `src/stores/request.ts:96` | low | console 收到完全变量解析后的 URL，无脱敏 |

**不在本切片**：`redactAuth` 的既定行为（清空而非保留）、Rust `preserve_template_or_empty` 的 `{{var}}` 保留策略——都是既定决策。

---

## D02 — HTTP 报文正确性

**状态**：filed
**边界**：只改 `src-tauri/src/lib.rs` 的 HTTP 执行段（`send_request` 及其被调用方）+ 对应 wiremock 测试。

| 位置 | 严重度 | 问题 |
|---|---|---|
| `lib.rs:2440` | high | 不做响应解压：带 `Accept-Encoding` 的请求返回乱码 |
| `lib.rs:2440` | med | 响应体强制按 UTF-8 解码，非 UTF-8 charset 变乱码、二进制响应被破坏 |
| `lib.rs:2376` | med | form-urlencoded / form-data 追加第二个 `Content-Type`；basic/bearer 与手写 `Authorization` 并存时发两行 |
| `lib.rs:2369` | med | JSON body 经 `serde_json::Value` 重新序列化，改变用户输入的字节 |
| `lib.rs:2410` | med | 丢弃 reqwest error source，所有传输失败报同一条无用信息 |
| `lib.rs:2337` | med | 预连接探测只用第一个解析地址且无超时 |
| `lib.rs:2291` | low | 零查询参数时 URL 仍带尾随 `?` |

---

## D03 — 持久化数据丢失

**状态**：filed

| 位置 | 严重度 | 问题 |
|---|---|---|
| `lib.rs:893` | high | 非 ASCII 项目/环境名产生相同 vault key → 两个环境共用密钥槽，后写覆盖先写，删一个毁另一个 |
| `lib.rs:1081` | high | vault 用截断式 `fs::write` 重写，写盘中崩溃 = 所有密钥全毁 |
| `lib.rs:664` | high | `read_history_entries` 遇任一坏行整体失败，且每次 append 全量重写 → 一行损坏永久变砖，应用内无修复入口 |
| `src/stores/environments.ts:144` | high | 用已存在的名字新建环境静默清空它，下次保存把原环境（含密钥）整个覆盖 |
| `lib.rs:1544` | med | collections 目录里一个无法解析的 `.json` 让整个项目树加载失败 |
| `lib.rs:1981` | med | `save_environment` 覆盖同 slug 的另一个环境，孤立其密钥 |
| `lib.rs:1965` | med | 删除 secret 变量后其值永久留在 vault/keychain |

顺带加固：`write_history_entries` 改 tmp + rename（`lib.rs:672`）。

---

## D04 — WebSocket 生命周期

**状态**：filed

| 位置 | 严重度 | 问题 |
|---|---|---|
| `lib.rs:2093` | high | 事件在前端监听器注册前发出：「已连接」与早期帧永久丢失；服务端立刻 Close 时 UI 仍显示已连接 |
| `lib.rs:2184` | med | `ws_disconnect` 丢弃 sender 但不终止读任务，无响应的 peer 留下僵尸连接 |
| `src/stores/tabs.ts:81` / `websocket.ts:71` | med | 握手中关闭 tab 泄漏 socket、监听器与消息缓冲 |
| `src/stores/tabs.ts:219` | med | `removeTab` 在 await 断连后用陈旧 index splice，关错 tab |
| `src/stores/websocket.ts:66` | med | WS URL 与 header 不解析 `{{变量}}` |
| `WSMessagePanel.vue:34` | med | 深度 watcher + 无上限渲染，高频 socket 冻结 UI |
| `lib.rs:2189` | low | `ws_suppressed_disconnect_pool` 在打包版永久增长 |
| `useKeyboard.ts:28` | low | WS tab 上 Cmd+Enter 触发 HTTP 请求，错误不可见 |

---

## D05 — UI 交互缺陷

**状态**：filed

| 位置 | 严重度 | 问题 |
|---|---|---|
| `EnvironmentPanel.vue:40` | high | 变量行用自身内容做 `:key`，每敲一个字符输入框被销毁重建 |
| `RequestPanel.vue:419` | high | URL 栏重新编码查询串，`{{var}}` 变 `%7B%7B...`，变量提示消失 |
| `UrlBar.vue:51` | med | 回车不判在途请求，重复发送 |
| `HistoryPanel.vue:230` | med | 分组按 label 做 key，模板 URL 下不唯一 |
| `src/stores/tabs.ts:411` | med | `openHistoryEntry` 劫持已打开的 saved-request tab，丢失其项目绑定 |
| `RequestPanel.vue:225` | med | cURL 导入后 query 同时留在 `tab.url` 和 params，导出时重复（**owner 从 D06 移入**：修复点在 `applyCurlImport` / `applyPastedCurl`，属 `RequestPanel.vue`，与 D06 的 `src/utils/**` 文件独占边界冲突） |
| `RequestPanel.vue:251` | low | 粘贴无法解析的 cURL 静默丢弃 |
| `DebugConsole.vue:20` | low | level 过滤缺 info 选项，标签绕过 i18n |
| `src/stores/console.ts:119` | low | `recordConsoleEntry` 全局重绑 activePinia |

---

## D06 — 导入导出保真

**状态**：filed

| 位置 | 严重度 | 问题 |
|---|---|---|
| `curl-parser.ts:329` | high | 不识别 `$'...'` ANSI-C 引用（Chrome DevTools 常见形态） |
| `curl-parser.ts:39` | med | 无法识别的 `-X` 方法变成请求 URL，真 URL 被丢弃 |
| `curl-parser.ts:82` | med | 显式 `-X GET` 在存在 data 标志时被改写成 POST |
| `curl-parser.ts:72` | med | `-d @file` 与 `--data-urlencode` 原样复制 |
| `curl-export.ts:44` | med | Copy as cURL 破坏含 `{{变量}}` 的 URL |
| `openapi-import.ts:300` | med | 自引用 `$ref` 无限递归，整个导入中止 |
| `curl-parser.ts:113` | low | `-b` 与 `-H 'Cookie:'` 各自 push，产生两行 Cookie（真 curl 只发一行） |
| `curl-parser.ts:146` `:411` | 已知债 | Basic 认证密码含冒号被截断 |
| `postman-export.ts:242` `:129` | 已知债 | 内存态文件静默降级成伪路径 |

### D06 spec 阶段的增补（owner 裁定）

起草者实跑验证后，发现四处代码与 review 文档不符或超出其描述，**均已吸收进 D06**（同一批函数，拆开反而制造冲突）：

1. `curl-export.ts` 破坏的是**任何**无协议头的 URL，不止含模板的：`api.example.com/users` → `curl '/api.example.com/users'`，host 直接丢失。review 只描述了模板那一种。
2. **review 完全没发现的新缺陷**：`postman-export.ts` 的 `buildRawUrl` 把 query 拼在 fragment **之后** —— `https://api.example.com/a#frag` + `k=v` → `…/a#frag?k=v`，非法 URL。
3. Basic 认证债有第二种、对中文用户更严重的形态：`atob` 不做 UTF-8 解码，`用户:密码` 解出乱码。
4. backlog 的 low 行只点名 `-b`，但 `-A`/`-e` 是完全相同的缺陷，`-u` 与 `-H 'Authorization:'` 之间还存在顺序依赖。

另：`postman-export.test.ts:140-144` **当前在断言这个 bug**（对内存态文件断言 `src === "hello.txt"`）。这是 D06 唯一一处需要改写既有断言的地方。

`curl-parser.ts:113`（`-b` 与 `-H Cookie` 重复）在 `REVIEW-2026-08-18.md` 里没有对应的编号条目，它来自 `TEST-CHECKLIST-2026-08-18.md` T19 第 8 步——backlog 先前标注的出处对这一项不完整。

### D06 → 其他切片的交接（owner 裁定）

| 交接 | 内容 | 归属 |
|---|---|---|
| C1 | `RequestPanel.vue:222/241` cURL 导入后 query 同时留在 url 与 params 的**根因** | D05（D06 只吸收导出侧症状：两个导出器都以 params 为 query 唯一来源，用户可见的重复因此消失） |
| C2 | `applyPastedCurl` 静默吞掉解析失败 | D05（已在 D05 列为 `RequestPanel.vue:251`） |
| C3 | 渲染 `parsed.warnings` | D05 |
| C4 | 在 `CollectionPanel.vue:303` 调用 `collectPostmanExportWarnings` | D05 |
| C5 | 6 个新 i18n key + 修 `importCurlDescription` | **owner 改判：归 D06 自己**。原提案推给 D01，但那会让 D01 携带一批自己不使用的 key——正是 doc-drift 纪律要杜绝的死键。D06 实现排在 D01 合并之后，届时对 i18n 文件是纯追加编辑，冲突可控 |
| C6 | `buildUrlWithParams` 改为复用 D06 新增的 `encodeQueryComponentPreservingTemplates`，而不是长出第 4 份拷贝 | D05 |
| C7 | README 写明「绝不按路径读 `@file`」这条边界 | **owner 裁定归 D06**：这是 D06 自己引入的产品边界，按项目硬规则「决策必须落到 README 和 UI」，谁引入谁写 |

---

## owner 裁定台账（spec 阶段陆续产生，此处是权威副本）

切片的 ACCEPTANCE 文件记录各自的评审轮次；**跨切片的归属裁定汇总在这里**，避免只存在于某一份 spec 里而让另一份看不到。

| # | 事项 | 裁定 | 影响 |
|---|---|---|---|
| A1 | history 进程内互斥锁 | **归 D01**，不归 D03 | backlog 原将其挂在 D03 的 `lib.rs:664` 行下。第二个写入者由 D01 引入（`update_history_entries`），谁引入谁负责。D03 的 tmp+rename 管崩溃原子性、锁管并发丢写，正交，两者都要且不互相替代。**D03 不得重复设计该锁** |
| A2 | D06 的 6 个 i18n key | **归 D06 自己**，不推给 D01 | 否则 D01 携带一批自己不使用的死键 |
| A3 | 「绝不按路径读 `@file`」的 README 声明 | **归 D06** | 谁引入的产品边界谁写 |
| A4 | `history.corrupt.jsonl` 与 `clear_history` 的 README 声明 | **归 D03** | 同上。写在 D01 的文档里会随 D03 行为改变而失真，而作者不知情 |
| A5 | 删除内容识别层（T2 与 JSON 裸 scheme 扫描） | **采纳，对既定决策的受控修订** | 脱敏回归纯字段名驱动。移除 `request.ts:560` 现存的 Bearer 兜底正则。理由：半吊子内容扫描同时制造假阴性（打标记却不脱敏）与假阳性（正常散文被毁）。D01 用一条负向不变式锁定，其 killer 即「把 T2 加回去」。项目记忆 `redaction-field-name-rules.md` 需同步 |
| A6 | `update_history_entries` 隔离路径的测试 | **归 D03** | 函数是 D01 造的，但断言的是 D03 的不变式，测试跟着不变式走 |
| A7 | 跨 spec 引用 | **禁止引用对方的章节号** | 章节号每轮都变（D01 已 27→34→39）。只能引用行为本身 |
| A8 | D06 的 scope 从 10 项扩到 39 条行为 | **全部保留，不拆分** | 都落在本就要重写的同一批函数里，拆出去意味着同一函数改两次。可追溯性由 D06 在 TECH 里补一张「backlog 原始条目 → 不变式」对照表 |
| A9 | D01 遗留明文清洗对**坏文件用户不可达** | **记录，不设为不变式** | `read_history_entries` 遇任一坏行整体失败，所以 D01 的清洗对这些用户静默失效。它断言的是 D01 的代码，编号进 D03 会破坏 1:1 映射。改为 D03 的一条**显式具名、标注为跨切片**的集成测试，站在 30 条不变式之外。**已核实 owner 本机文件 94/94 可解析、零坏行**，故对 owner 自身不适用 |
| A10 | `HistoryEntry` 的 schema 追加 | D02 的 `responseBodyKind` 归 **D03**；D07b 的 `note`/`starred` 归 **D07** | 三者都是 `#[serde(default)]` 追加字段，磁盘格式向后兼容。**已知缺口**：D02 合并到 D03 合并之间，从历史重放二进制响应会把 marker 当普通文本显示，需记录 |

### spec 阶段新发现（尚未归入任何切片）

- `src/types/index.ts:205` 声明 `vaultKey?: string`，Rust 序列化为 `vault_key`——**两侧都从不填充的死字段**。由 D03 顺带清理或单列一项。

## D07 — 历史备注 / 收藏

**状态**：filed
设计见 `docs/review/Q2-history-annotations.md`。拆两个可独立发布的子切片：

- **D07a** 从历史一键「保存到集合」——纯前端，零 schema 改动。真正解决「以后还想找到这个请求」。
- **D07b** `note` + `starred` 写进 `history.jsonl` 行内（2 个 `#[serde(default)]` 字段 + 1 个 command + trim 逻辑改写）。

明确否决：sidecar 文件（破坏「清空历史」的心理模型、产生永久孤儿、引入第三种生命周期）。
星标只豁免自动 trim，**不豁免显式清空**。
