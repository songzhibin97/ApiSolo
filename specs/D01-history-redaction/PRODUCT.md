# D01 — 历史重放毒化与脱敏正确性（PRODUCT）

> **rev8 — 应 R7 修订**。锁测试的 `child_ok` 断言改用「命令跑完后再 panic」的单塌 fixture，并实跑「移除该断言 ⇒ 转 GREEN」证明其承重。不变式无增减。
>
> **（历史）rev7 — 应 R6 修订**。锁测试的失败路径收口：`Poisoned` 不再直接 panic、`join` 结果纳入统一断言、cleanup 在安装后立即建立并清除中毒；已重跑并新增「子线程在 checkpoint 后 panic」用例证明其变红。不变式无增减。
>
> **（历史）rev6 — 应 R5 修订**。锁测试的 checkpoint 改为一次性消费（原协议对 read→write 两次 I/O 的命令会死锁），liveness 与锁判定严格分离，清理顺序闭合；已重跑 5 命令 × 4 变体 × 2 延迟的完整矩阵。不变式无增减。
>
> **（历史）rev5 — 应 R4 修订**。锁测试改为 I/O checkpoint + `try_lock` 的确定性证明（不再依赖 `recv_timeout` 推断执行进度）；转义键 fixture 修复并实跑 mutant 见红。以下为 rev4 起的沿革。
>
> **rev4 — 应 R3 修订**。补完内容扫描的删除面（键值对的非敏感分支）、JSON 转义键的判定、锁必须覆盖 I/O、未命中容器的递归。另按裁定 A7（跨文档引用不得带外部标识符）与规则 R4（他方陈述须验证或标注转述）清理了对 D03 的引用。不变式重新编号，共 **41** 条。

## Summary

历史记录写盘时按字段名把敏感值换成字面量 `[redacted]`，但从历史打开请求时这个字面量被当作真值灌回可编辑的输入框，用户按 Send 就真的把 `Cookie: [redacted]` 发到了线上。本切片让"从历史重放需要重新填写凭据"这件事变得**诚实且可见**：占位符永不回到 tab、永不上线（header / param / form-data / 请求体四条路径全覆盖）；被脱敏的内容在 UI 上明确标出；脱敏本身改为**纯字段名驱动、逐字节保守**的实现；并清理磁盘上遗留的明文条目。

## Problem

用户 2026-04-27 遇到的真实故障（`docs/review/Q1-cookie-redaction.md`）：从历史点开一条请求 → Cookie 行显示 `[redacted]`，看起来是正常的、可编辑的、有值的字段 → 按 Send → `HeaderValue::from_str("[redacted]")` 在 HTTP 里完全合法（`src-tauri/src/lib.rs:2319`，`:2321` 用 `append` 进 HeaderMap）→ 服务端收到 `Cookie: [redacted]` → 401 → 用户以为 cookie 过期，手工又加一行 Cookie → 网关只读第一行 → 连续 4 次 401 → 删到只剩一行才 200。

诱因不止一个：

- **UI 撒了谎**：一个看起来完整的请求，带着应用自己塞进去的毒化值。踩在项目最高红线上。
- **文案说反了**：`src/i18n/zh-CN.ts:212` / `en.ts:212` 的 `history.securityNotice` 说"历史记录会按编辑态保存请求"，与代码行为正好相反，且完全没提"从历史打开的请求已经不含凭据"。
- **脱敏本身不正确**：现有三条正则互相打架——`{"password":"hunter2"}` 存成非法 JSON；`grant_type=password&password=p&client_secret=xyz` 丢掉 `client_secret`；`Authorization: Basic <base64>` 只脱掉 scheme、凭据留在 `[redacted]` 字样旁边。
- **半吊子的内容扫描比不扫描更糟**：现有那条 `Bearer` 兜底正则试图按值的内容判断敏感性，结果两头不讨好——裸 `Digest username="Mufasa", realm=…, nonce=…, response=…` 会被改写成 `Digest [redacted]"Mufasa", realm=…`（**标记打了、凭据全留**），而正常散文 `{"note":"Digest authentication is required"}` 会被当凭据毁掉。**同一条内容扫描还作用在普通键值对上**：名为 `X-Note`、值为 `password: hunter2` 的 header 会被改写成 `password: [redacted]`——一个普通字段里出现了脱敏字样，却没有任何"待重填"标记，用户既拿不回原值也得不到提示。
- **硬名单漏网**：`isSensitiveKey`（`request.ts:549`）的 `(^|[-_\s])` 锚点让 `accessToken` / `clientSecret` 一律不命中，而 Rust 侧（`lib.rs:1473` 用 `contains`）命中——同一个 header，存进 collection 被清空，存进历史却是明文。
- **请求体一直没人管**：`tabs.ts:363` 原样恢复 body，`request.ts:314-317` 原样送进 payload。今天没出事纯属侥幸——毒化后的 JSON 非法，Rust 直接拒发。一旦把 JSON 脱敏修正确，同一条 body 变成合法 JSON，占位符会被**成功**发给服务端。
- **存量数据没人管**：脱敏是 2026-04-27 当天上线的，之前写入的条目至今以明文躺在 `$HOME/ApiSolo/scratch/history.jsonl` 里（评审实测 94 条中 19 条含明文 Cookie），应用内唯一清理手段是"清空全部历史"。

## 脱敏的边界（本切片对既定决策的受控修订）

**脱敏完全由字段名硬名单驱动，不看值的内容。** 这条对**所有四条路径**一视同仁：header、param、form-data、请求体。

写在**非敏感字段名**下的凭据——raw body 里孤立的一行 `Bearer eyJhbGciOiJIUzI1NiJ9.LEAK`、`{"note":"Digest username=…"}`、名为 `X-Note` 值为 `password: hunter2` 的 header——**不会被脱敏，也不会被打上任何标记**，历史里保存的就是用户原样输入的内容。

这是刻意的收缩，且**删除了一条现有行为**：`src/stores/request.ts:560` 那条扫描裸 `Bearer` 的兜底正则被移除，`:545` 那条把非敏感 value 交给内容扫描的分支也一并移除。理由是按内容猜测同时制造假阴性（打了 `[redacted]` 标记却把凭据留在旁边，比不脱敏更危险，因为读历史的人会以为它干净了）和假阳性（正常散文、普通字段被毁）。宁可边界清晰地不做，也不要做一半。

用户想让敏感值不落盘，正确路径仍然是：**用敏感字段名**（`Authorization` / `Cookie` / `token` / `password` …），或者把值放进环境变量用 `{{变量}}` 引用。

## Behavior

术语：**哨兵** = 字面量 `[redacted]`；**声明类型** = 请求体用 `tab.body.type`、响应体用 `response.contentType`，映射到 `json` / `urlencoded` / `text` 三条路径——**按声明的格式分派，不做内容嗅探**；格式只决定用什么语法定位"字段名"，判定敏感与否的依据始终只有字段名硬名单。

### A. 重放不携带占位符

1. 从历史打开请求时，**header / param / form-data 三个集合各自独立地**把等于哨兵的值还原为空值，键名保留。三个集合行为对称，任一集合被漏掉必须可被发现。
2. 请求体按声明类型结构化清空：`json` 清掉等于哨兵的值；`urlencoded` 清掉等于哨兵的字段值；`text` 清掉「敏感键 + 分隔符 + 哨兵到行尾」的整段值。散文里恰好出现哨兵字样的文本不被改动。
3. 被清空的键值行与请求体各自携带"待重填"标记。标记**只在该行的 value 真的被编辑时**清除——切换 enabled、改 key、改 description 都**不**清除标记（否则会出现"值还是空的、提示条却没了"的说谎状态）。
4. 只要 tab 内还存在任一"待重填"标记，请求面板顶部显示琥珀色提示条，列出具体字段名、以及是否含请求体。标记全部消失后提示条消失。
5. **出站闸门（键值）**：请求发出前，若变量解析**之前**的快照中，任一 enabled 的 header / param / form-data 值 trim 后等于哨兵，请求不发出：tab 显示指明字段名的错误，无网络调用，不写历史。三个集合各自独立生效。
6. **出站闸门（请求体）**：按声明类型解析请求体，当**某个敏感键的完整值**等于哨兵时拒发并指名该键。请求体中作为散文出现的哨兵字样**不**拒发。
7. 闸门同样覆盖**从 collection 打开**的请求：Rust `src-tauri/src/lib.rs:1500` 会把已保存请求的 urlencoded 敏感字段写成 `key=[redacted]`，`openSavedRequest` 原样打开它，这份数据同样不许上线，且错误必须指名**该字段的真实键名**而非笼统的"请求体"。
8. **逃生口**：把哨兵这段字面文本放进环境变量、字段里写 `{{变量名}}`，即可正常发出——闸门只看未解析的快照。
9. 带"待重填"标记但值为空的行**不阻断发送**。空 header 值是合法请求，用户可能就是想看 401；UI 已用琥珀色行 + 提示条讲清楚状态。
10. 从历史还原的 response 快照只用于展示，永远不参与任何出站请求。

### B. 脱敏的正确性

11. **`json` 体逐字节保守**：只替换敏感键对应的值区间，其余字节一字不改。超出 IEEE-754 精度的整数（`9007199254740993123456789`）、重复的非敏感键（`{"id":1,"id":2}`）、缩进与换行、浮点字面量、字符串里的转义序列全部原样保留。未命中任何敏感键时输出与输入逐字节相同。
12. **`json` 体的敏感键值无论类型一律替换**为字符串哨兵——字符串、数字、`true`/`false`、`null`、嵌套对象、数组都一样，且整个值区间被替换（不递归进去）。**未命中的容器必须继续递归**：任意深度的对象嵌套、对象里的数组、数组里的数组，只要内层出现敏感键就必须被替换。已知后果并接受：非字符串值在重放时会被清成空字符串 `""`，类型发生变化；这与 §9「空值按空值发送」是同一条既定取舍。
13. **`json` 键的转义形式不能绕过硬名单**。约定：下文 `~` 代表**一个反斜杠字符**（不写字面反斜杠，理由见 TECH 4.4）。键名 `~u0070assword` 解码后是 `password`，必须与字面 `password` 得到**相同的敏感性判定**；`~u0041uthorization` 同理。判定与错误文案用**解码后**的键名，而落盘**保留原始键字节**——不得把 `~u0070assword` 规范化成 `password`。转义引号、转义代理对、`~/`、`~b` 一律正确跳过；键含**非法转义**（如 `~x`）时整段降级走 `text` 路径，而不是静默按未命中放行。脱敏、清空、闸门三条路径都受这条约束。
14. **`urlencoded` 体**：`&` 分隔的字段数量不变，未命中字段字节不变，只有命中字段的值被替换。
15. **`text` 体**：行内出现「敏感键 + `:` 或 `=`」时，分隔符之后到行尾整段替换为哨兵。`Authorization: Basic <base64>` 与 `Authorization: Digest username=…, realm=…, nonce=…, response=…` 的全部参数都不残留，且只出现一个哨兵。
16. **边界（负向不变式，自由文本）**：非敏感字段名下的内容**不被脱敏、也不被标记**——裸 `Bearer eyJ…`、裸 `Digest username="Mufasa", realm=…`、`{"note":"Bearer abc123"}` 原样保留；`{"note":"Digest authentication is required"}` 这类散文也原样保留。这条不只要求脱敏函数输出不变，还要求**完整往返之后**（写历史 → 从历史打开 → 判定标记 → 判定闸门）原文不变、无"待重填"标记、无提示条、不被拒发。
17. **边界（负向不变式，键值对）**：header / param / form-data 中**键名不敏感**的行，其 value 逐字节原样保留，不做任何内容扫描。名为 `X-Note`、值为 `password: hunter2` 的 header 在历史里就是 `password: hunter2`；值里孤立的 `Bearer …` / `Digest …` 同样原样。三个集合各自独立成立。
18. **行终止符保留**：`\n`、`\r\n`、`\r` 三种终止符在脱敏前后逐字节不变；替换"到行尾"不吃掉终止符。
19. **幂等**：三条路径对已脱敏文本再脱敏一次逐字节不变；且不得在多行输入内部或多次调用之间残留扫描状态（同一段文本单独脱敏与作为多行输入的一部分脱敏，结果必须一致）。
20. **百分号解码永不抛异常**：`urlencoded` 体与 URL query 中形如 `%E0%A4%A`、`pass%word`、`%70assword%ZZ`、`%ZZ` 的键都不会让脱敏失败。否则一次成功的请求会在构建历史时炸掉，含此类旧数据的历史会整体加载失败。
21. **规定的过度脱敏**（设计选择，非缺陷，三项各自被测试锁定）：
    - 选了 `raw` 类型却写入 urlencoded 文本时，命中敏感键后截到行尾：`grant_type=password&password=p&client_secret=xyz` → `grant_type=password&password=[redacted]`；
    - 单行 curl 命令被截到行尾：`curl -H 'Authorization: Basic dXNlcjpwYXNz' https://x` → `curl -H 'Authorization: [redacted]`；
    - 不可解析的 JSON 退化走 `text` 路径：`{"password":"hunter2"` → `{"password":[redacted]`。
    方向都是"多脱不漏脱"。将来要改进必须是一次自觉的决定。

### C. 字段名硬名单

22. camelCase 命中：`accessToken`、`refreshToken`、`idToken`、`authToken`、`sessionToken`、`csrfToken`、`clientSecret`。
23. 前端与 Rust 两份硬名单对同一组字段名判定**完全一致**，由一份共享 fixture 同时喂给 vitest 与 cargo。
24. 名单扩充 `subscription-key`、`signature`、`credential`；裸 `key` **不**命中——两侧都是子串匹配，加它会把 `key` / `keyword` / `monkey` 一起吃掉。

### D. URL

25. 写入历史的 `url` 的 query 值按硬名单脱敏，**URL 其余部分逐字节保留**：`%20` 不变 `+`、host 大小写与默认端口不被规范化、fragment 保留、相对 URL 保留、未命中键上的 `{{变量}}` 不被百分号编码；重复出现的同名敏感参数每一处都被脱敏。
26. URL 栏展示的 query 与最终上线的 query 一致：覆盖「历史条目带 `requestParams`」与「不带、由 URL 反推」两种来源，以及重复 key、被禁用的参数。（fragment 只在 URL 栏出现、不上线，这是 HTTP 的正常语义。）

### E. 存量数据

27. 加载历史时，需要脱敏的既有条目在进入面板或 tab **之前**被脱敏。
28. 若加载时有任一条目被改写，清洗后的条目回写磁盘一次；再次加载时无任何条目需要改写（收敛）。
29. 回写只替换 id 匹配的行；磁盘上 id 不在负载里的行原样保留——**但被判定为损坏的行除外**：据 D03 起草者所述，D03 会引入坏行隔离，把无法解析的行移出历史主文件另行保存、不再放回（本切片未验证该设计，权威表述以 D03 落定的规格为准）。
30. **并发互斥**：历史文件的全部读-改-写命令互斥，且**取锁必须发生在任何文件 I/O 之前**——不是"返回前阻塞"，而是"读之前就已持锁"。清洗回写与"请求完成后追加历史"同时发生时，既不吞掉新条目，也不把已清洗条目还原成明文，更不会基于取锁前读到的旧快照覆盖并发写入。
31. 历史读取失败时面板显示错误，且**不发生任何回写**，`loadHistory` 向调用方抛出失败（不吞异常）。
32. 清洗只作用于历史副本，绝不改写当前 tab 的任何字段。

### F. 既有 collection 的迁移语义

硬名单扩容会同时改变 collections 的行为——`read_saved_request`（`lib.rs:1376`）在**读取时**也过一遍脱敏。裁定：

33. 打开含 `X-Amz-Signature` / `*credential*` / `*subscription-key*` 的既有 collection 请求时，这些字段在 UI 里显示为**空**，但**磁盘文件不被改动**。只看不存的用户不丢数据。
34. 用户在该 tab 上点保存时，按新规则把这些字段永久写空。不为本次扩容开特例。
35. 该迁移与「非敏感字段名下的凭据不脱敏」这条边界都必须写进 README 与 SECURITY.md。

### G. 环境变量

36. 脚本新建的变量，若其值与某个既有 secret 变量的值**完全相同**，则新变量也被标记为 secret。
37. 脚本写入**既有的** secret 变量时该变量保持 secret——Postman 标准用法，既定行为，用测试锁定、不改。

### H. 控制台

38. 控制台的 `[network] ...` 行使用**未解析**的 URL，`{{变量}}` 保持原样。

### I. 文案与格式

39. `src/i18n/zh-CN.ts` 与 `en.ts` 键集完全一致，历史面板安全提示陈述实际行为。
40. "待重填"标记是纯内存态，**既不进 `append_history` 负载，也不进 `save_request` 负载**。`history.jsonl` 行格式不变，既有行继续可解析。
41. 缺失 `requestHeaders` / `requestParams` 的早期条目正常打开：无提示条、无报错、无空行。

## UI 变化

| key | zh-CN | en |
|---|---|---|
| `history.securityNotice`（改写） | 历史记录按字段名脱敏：cookie / authorization / token / password 等字段的值不会写入磁盘；写在其他字段名下的内容按原样保存。从历史打开的请求需要重新填写这些值才能发送成功。 | History redacts by field name: values of cookie / authorization / token / password fields are never written to disk; anything under other field names is saved as-is. A request opened from history needs those values re-entered before it will succeed. |
| `request.historyRedactedBanner`（新增） | 此请求来自历史记录，以下内容在保存时已被脱敏，需要重新填写：{fields}。留空则按空值发送。 | This request came from history. These were redacted when it was saved and need re-entering: {fields}. Left empty, they are sent empty. |
| `request.historyRedactedBody`（新增，用作 `{fields}` 之一） | 请求体 | request body |
| `keyValue.redactedPlaceholder`（新增） | 已脱敏，请重新填写 | Redacted — re-enter |
| `errors.redactionSentinelOnWire`（新增） | 请求未发送：{field} 的值仍是占位符 [redacted]。请填入真实值；若确实要发送这段字面文本，请把它放进环境变量并用 {'{{'}变量名{'}}'} 引用。 | Request not sent: {field} still holds the placeholder [redacted]. Enter a real value; to send this literal text, put it in an environment variable and reference it as {'{{'}name{'}}'}. |
| `history.legacySanitized`（新增） | 已清理 {count} 条历史记录中的明文凭据。 | Removed plaintext credentials from {count} history entries. |

被清空的键值行：value 输入框用琥珀色边框 + `keyValue.redactedPlaceholder` 占位文字。提示条置于 URL 栏与分区按钮条之间。

README / SECURITY.md 同步写明五条边界：脱敏只按字段名、非敏感字段名下的凭据（含普通 header/param 的值）不脱敏也不标记；从历史重放必须重填凭据；脚本沙箱仍能读到明文 secret（只有整体复制会被标记）；升级后既有 collection 里 `signature` / `credential` / `subscription-key` 类字段需要重填；`json` 敏感字段的非字符串值重放时会变成空字符串。

## Non-goals

- `redactAuth` 的清空语义、Rust `preserve_template_or_empty` 的 `{{var}}` 保留策略——既定决策。
- **不把历史脱敏移进 Rust**。`lib.rs:3274` 的 `test_append_history_preserves_replay_fields_on_disk` 是在库契约测试，Rust 对历史是哑管道。
- **不做任何内容识别**（见「脱敏的边界」一节）。
- **不做脚本沙箱的 secret 隔离**。`pm.environment.get` 仍返回明文——签名类脚本的合法用途。§36 只覆盖"值完全相同"的整体复制，`token.slice(0,10)` 这类派生复制追不到。
- **WebSocket 握手 header 不在承诺范围内**，承诺收窄为"HTTP 历史重放路径中的占位符不上线"。依据以下**已验证**事实：(a) `buildHistoryEntry` 全仓唯一调用点 `request.ts:162`，位于 `invoke("send_request")` 成功返回之后，失败请求不写历史；(b) `openHistoryEntry` 经 `createEmptyTab`（`tabs.ts:32-53`）产出的 tab 恒为 `protocol: "http"`，全函数不改写 `protocol`，**历史里的值不可能流进 `ws_connect`**。需如实记下的反例：`useKeyboard.ts:28` 的 Cmd/Ctrl+Enter 不判 `tab.protocol`（D04 在册），WS tab 的 URL 若是 `http(s)://` 请求会成功并写历史——但那种情况下它本就是 HTTP 请求。
- 历史单条删除 UI（`deleteEntry` 是死代码）——D05 / D07。
- `openHistoryEntry` 劫持已打开的 saved-request tab（`tabs.ts:401-417`）——D05。
- cURL 导入产生两行 Cookie（`curl-parser.ts:113`）——D06。
- `read_history_entries` 遇坏行整体失败（`lib.rs:664`）、`write_history_entries` 截断式重写（`:672`）——D03。§30 的互斥锁归本切片，崩溃原子性归 D03，两者正交。
