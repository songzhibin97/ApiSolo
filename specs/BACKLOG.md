# ApiSolo 交付 backlog

单调递增编号。新会话从**尾部**条目续接，不要从上方的旧快照续接。

来源：`docs/review/REVIEW-2026-08-18.md`（49 条提出 / 43 条通过对抗性验证）+ `docs/review/Q1-cookie-redaction.md` + `docs/review/Q2-history-annotations.md`。

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

并行约束：D01/D02/D03/D04 都写 `src-tauri/src/lib.rs`，**必须串行**。D05（纯组件）与 D06（纯 utils）文件不重叠，可与 Rust 切片并行。

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
| `RequestPanel.vue:225` | med | cURL 导入后 query 同时留在 `tab.url` 和 params，导出时重复 |
| `curl-export.ts:44` | med | Copy as cURL 破坏含 `{{变量}}` 的 URL |
| `openapi-import.ts:300` | med | 自引用 `$ref` 无限递归，整个导入中止 |
| `curl-parser.ts:113` | low | `-b` 与 `-H 'Cookie:'` 各自 push，产生两行 Cookie（真 curl 只发一行） |
| `curl-parser.ts:146` `:411` | 已知债 | Basic 认证密码含冒号被截断 |
| `postman-export.ts:242` `:129` | 已知债 | 内存态文件静默降级成伪路径 |

---

## D07 — 历史备注 / 收藏

**状态**：filed
设计见 `docs/review/Q2-history-annotations.md`。拆两个可独立发布的子切片：

- **D07a** 从历史一键「保存到集合」——纯前端，零 schema 改动。真正解决「以后还想找到这个请求」。
- **D07b** `note` + `starred` 写进 `history.jsonl` 行内（2 个 `#[serde(default)]` 字段 + 1 个 command + trim 逻辑改写）。

明确否决：sidecar 文件（破坏「清空历史」的心理模型、产生永久孤儿、引入第三种生命周期）。
星标只豁免自动 trim，**不豁免显式清空**。
