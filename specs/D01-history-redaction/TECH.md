# D01 — 历史重放毒化与脱敏正确性（TECH）

> **rev8 — 应 R7 修订**。行为定义见 `PRODUCT.md`（41 条不变式，本轮无增减）。R7 的 CRITICAL：rev7 新增的 panic 回归用例**三项断言同时失败**，因此删掉 `child_ok` 断言它仍然 RED——该断言写在那里，但没有任何东西证明它承重。rev8 把 fixture 改成只让 `child_ok` 失败，并实跑了「删掉该断言 ⇒ 转 GREEN」。见 0.1。
>
> **（历史）rev7 — 应 R6 修订**。R6 的 CRITICAL 是失败路径未闭合（`Poisoned` 直接 panic 绕过清理；`join` 结果捕获后无人断言，导致子线程 panic 也能 `EXIT=0`），IMPORTANT 是风险表仍留着已被我自己推翻的旧结论。0.1 是按新协议重跑的结果，含子线程 panic 与锁中毒两个失败路径用例。
>
> **（历史）rev6 — 应 R5 修订**。R5 的唯一 CRITICAL 是 checkpoint 不是一次性的导致协议死锁——**并且我上一轮记录的实跑结果，从落盘的协议正文里重放不出来**。0.1 是修订后重跑的完整矩阵。
>
> **（历史）rev5 — 应 R4 修订**。R3/R4 连续两轮都是**证明力缺陷**：产物本身对，用来证明它的东西不对。rev5 把两处证明换成不依赖调度、不依赖作者手写转义的形式，并**实跑了 mutant**——结果记在 0.1。所有 `file:line` 基于分支 `songzhibin/d01-history-redaction` 起点实际读过的代码。

## 0. rev8 对 R7 的处置

| R7 id | 处置 |
|---|---|
| C1 panic 用例不是 `child_ok` 的独立 killer | 4.2.3 改 fixture：命令**跑完**（终态已是 `[A, N]`、返回值已记录）**之后**才由 wrapper 主动 panic，使四项断言中**只有 `child_ok` 失败**；并实跑「删掉该断言 ⇒ 该用例转 GREEN」作为承重证据。另补 `NoGuard + 完成后 panic`，验证双失败同时报告 |

### 0.1 rev8 实跑结果（`rustc 1.95.0`，同一进程一次跑完，`TOTAL=41 WRONG=1`，`EXIT=0`）

**(1) 主矩阵 36 组**：Correct 全 GREEN；`NoGuard` / `AfterRead` / `AfterAllIo` 全 RED（`verdict=LockFree`）。0ms 与 250ms 逐行一致。

**(2) `child_ok` 的承重证明**——fixture 让命令先跑完再 panic，四项断言只塌一项：

```
WITH    child_ok assertion   verdict=LockHeld  child_ok=false  outcome=Some("append completed")  final=["A","N"]  => RED  [child panicked]
WITHOUT child_ok assertion   verdict=LockHeld  child_ok=false  outcome=Some("append completed")  final=["A","N"]  => GREEN
```

**verdict / outcome / final 三项全部通过，只有 `child_ok` 失败**；删掉该断言后同一次探测转为 **GREEN**，汇总 `WRONG=1`。这就是「该断言承重」的直接证据——rev7 的旧 fixture 三项同时失败，给不出这个证据。

**(3) 双失败的诊断**：

```
NoGuard+panic  verdict=LockFree  child_ok=false  => RED  [verdict=LockFree + child panicked]
```

两项**同时**出现在错误信息里，不会把「子线程崩了」误读成「锁位点错了」。

**(4) 中毒路径（同一次运行内复跑）**：

```
after-poison  verdict=HarnessError  note="history lock poisoned"  child_ok=true   (无 panic、无挂死)
next-case     verdict=LockHeld      poisoned_now=false                            (未被污染)
```

### 0.2 本轮的教训归位

R7 这条是第 2 条纪律（记录必须可从正文重放）的**同族变奏，对象换成了断言本身**：断言写在正文里、也确实执行了，但**没有任何实验证明它在承重**。一个多项同时失败的 fixture，无法区分「四道断言」和「三道断言 + 一句注释」。

因此把第 2 条扩写为（0.3 已同步）：

> **每一条声称「独立可杀」的断言，都必须有一个只让它单独失败的用例；并且至少实跑一次「移除该断言 ⇒ 该用例转 GREEN」。** 多项同时失败的 fixture 不能作为任何单条断言的承重证据。

按这条自查了统一断言的其余三项：`verdict` 由主矩阵 36 组单独证明（那些用例的 `child_ok`/outcome/final 全部通过，只塌 verdict）；`outcome` 与 `final` 目前**没有**各自的单塌用例——如实记录在 4.2.3，作为已知的证明缺口，不谎称已覆盖。

## （历史）0. rev7 对 R6 的处置

| R6 id | 处置 |
|---|---|
| C1-a `Poisoned` 直接 panic 绕过清理 | 4.2.2 判定四值化，`Poisoned` 记为 `HarnessError`，**窗口内一律不 panic** |
| C1-b `join` 结果捕获后无人断言 | 4.2.3 统一断言含 `child_ok`；实跑证明「lock 判定正确但子线程 panic」现在会 RED |
| C1-c cleanup 未在安装后立即建立 | 4.2.3 安装 slot 后**立即**建 RAII `Cleanup`，覆盖 unwind 路径；并在 drop 里 `clear_poison()`，防止一次 panic 污染后续表驱动 case |
| I1 风险表留着旧结论 | 已改；全文扫描确认该说法只此一处，见 0.3 |

### 0.1 rev7 实跑结果（`rustc 1.95.0`，`TOTAL=38 WRONG=0`）

**(1) 主矩阵 36 组**（5 命令 × 可表达变体 × 0ms/250ms）：Correct 全部 `LockHeld` → GREEN；`NoGuard` / `AfterRead` / `AfterAllIo` 全部 `LockFree` → RED。两组延迟逐行一致。

**(2) R6 要求的失败路径用例——子线程在首次 checkpoint 之后 panic**：

```
append+panic  verdict=LockHeld  child_ok=false  final=["A"]  => RED  [child panicked]
```

**锁判定本身是正确的（`LockHeld`），测试仍然 RED**，原因记为 `child panicked`。rev6 的协议在这里会 GREEN——这正是 R6 指出的洞。

**(3) 锁中毒路径**：先让一个线程持锁 panic 制造中毒，再跑一个 `NoGuard` 变体（此时锁空闲且中毒，`try_lock` 返回 `Err(Poisoned)`）：

```
after-poison  verdict=HarnessError  note="history lock poisoned"  child_ok=true   (无 panic、无挂死)
next-case     verdict=LockHeld                                                    (未被污染)
```

`Cleanup::drop` 调用 `clear_poison()`，所以中毒不会向后传染——否则一次子线程 panic 会让后面所有 case 都报 `HarnessError`。

### 0.2 本轮我自己犯并自查出的一处记录错误

第一次跑矩阵时，我的 `judge()` 传的是「该变体是否**如其本性**表现」，而不是「**测试**是否通过」。于是 mutant 行被标成 GREEN、汇总打出 `WRONG=26`。数字明显不对才回头看，改成「测试恒断言 `LockHeld`」后得到 `WRONG=0`。

记下来是因为它正是 0.3 那条规则要防的东西：**如果我没看汇总数字就把那张表抄进 spec，交付的就是一份行标全部反了的矩阵**——而每一行的原始数据都是真的。

### 0.3 三条自加纪律（累积）

1. **fixture 必须自检**（R4）：会静默退化的输入，先断言输入本身，再断言行为。
2. **记录必须可从正文重放**（R5），且**每条声称独立可杀的断言必须有单塌用例 + 一次「移除后转 GREEN」的实跑**（R7 扩写）：落盘的协议/fixture/patch 是唯一事实来源；多项同时失败的 fixture 不能作为任何单条断言的承重证据。
3. **自我限定必须扫全文**（R6，本轮新增）：一旦缩小某个断言的证明力，必须全文搜索同一说法的所有出处并一起改。否则同一份文档里会同时存在两种读法，而其中一种是错的。本轮按此扫了「字节/内容断言证明锁位点」这一说法，全文仅风险表一处，已改。

## （历史）0. rev6 对 R5 的处置

| R5 id | 处置 |
|---|---|
| C1 checkpoint 非一次性 → 协议死锁 | 4.2.1 改 `take()` 一次性消费；第二次 I/O 直接通过。已首手复现旧协议死锁、并重跑修订后的完整矩阵，见 0.1 |
| C1-a 另一个永久阻塞入口（命令未到达 I/O） | 4.2.2 引入**有界 liveness**：`recv_timeout` 只用于判「从未到达 I/O」，其结果**绝不参与锁状态判定**。判定三值化：`LockHeld` / `LockFree` / `NeverReachedIo` |
| C1-b 失败清理未闭合 | 4.2.3 固定顺序：捕获判定 → drop `Ok` guard → resume → join（捕获而非 unwrap）→ RAII 清空 slot → **最后**才 assert |
| C1-c 重跑并记录完整终态 | 0.1 给出 5 命令 × 4 变体 × 2 延迟的完整矩阵，含终态与退出状态 |

### 0.1 rev6 实跑结果

**(1) 先复现 R5 指出的缺陷**：按 rev5 **正文写下的**协议（resume 一次后 join）跑 `append` 的**正确实现**——3 秒内未完成，**DEADLOCK 确认**。这是我自己跑出来的，不是转述评审。

**(2) 修订后的完整矩阵**（真实 `rustc 1.95.0` 编译运行，进程 `EXIT=0`，无挂死）：

`load` 只读，`clear` 只写，故 `AfterRead` 对二者不可表达，已按实际可表达的变体枚举（36 组）。

| 命令 | 变体 | 首次 I/O 时判定 | 终态 | 结论 |
|---|---|---|---|---|
| append（播种 `[A]`） | Correct / NoGuard / AfterRead / AfterAllIo | LockHeld / LockFree / LockFree / LockFree | 四者均 `[A, N]` | PASS / 杀死 ×3 |
| delete（播种 `[A,B]`） | 同上四种 | LockHeld / LockFree ×3 | 四者均 `[B]` | PASS / 杀死 ×3 |
| update（播种 `[A,B]`） | 同上四种 | LockHeld / LockFree ×3 | 四者均 `[A', B]` | PASS / 杀死 ×3 |
| clear（播种 `[A,B]`） | Correct / NoGuard / AfterAllIo | LockHeld / LockFree ×2 | 三者均 `[]` | PASS / 杀死 ×2 |
| load（播种 `[A]`） | Correct / NoGuard / AfterAllIo | LockHeld / LockFree ×2 | 三者均 `[A]`（文件未变） | PASS / 杀死 ×2 |

**子线程延迟 0ms 与 250ms 两组逐行一致**，无一组挂死。

**(3) 必须如实记下的一条**：上表「终态」一列在正确实现与三种 mutant 之间**完全相同**——无竞争时锁放哪都不影响单命令的最终结果。因此**终态断言不是 lock 变体的 killer**，它只保证命令语义（播种/合并/删除/清空）没被写错。**杀伤完全来自首次 I/O 时的 `try_lock` 判定这一条断言。** 不得把终态断言算进 §30 的杀伤力。

### 0.2 自加的一条纪律：记录必须可从正文重放

R5 指出我上一轮「记录了完整 PASS/杀死结果，而正文写下的协议产生不了那些结果」——原因是我实跑的 harness 里有一个 `while n_rx.recv_timeout(50ms).is_ok() { resume }` 的排空循环，写进 spec 时漏掉了。**跑过的东西和落盘的东西发生了偏移，而记录只反映前者。**

这与 R4 的 fixture 退化同族。因此把规则推广（owner 在 R5 里也是这么概括的）：

> **任何「我跑过」的记录，都必须能从落盘的正文原样重放出来。** 落盘的协议/fixture/patch 是唯一事实来源；实跑脚本若比正文多做了任何一步，要么补进正文，要么记录作废。

本轮的做法：0.1(2) 的矩阵由 4.2 正文所述协议**逐字实现**后跑出，排空循环已被 `take()` 一次性语义取代——不再需要额外步骤。

## （历史）0. rev5 对 R4 的处置

| R4 id | 处置 |
|---|---|
| C1 `recv_timeout` 证明不了子线程执行进度 | 4.2 整节重建：加 `#[cfg(test)]` I/O checkpoint，把子线程**驻留在第一次 I/O 内部**，然后由测试断言 `history_lock().try_lock()` 必须失败。**不用任何 timeout 做断言**，因此不受调度影响。已用真实 rustc 建模验证，含 250ms 子线程延迟场景，见 0.1 |
| C1 附带：四个写命令的播种/终态不能共用 | 4.2 给出四条命令**各自**的播种状态与终态断言（append/delete/update/clear 的正确终态互不相同，rev4 统一写成「A、B、N」对其中三条是错的） |
| C2 转义 fixture 丢反斜杠 | 4.4 引入 `~` 代表反斜杠的书写约定 + **运行时构造** + **fixture 自检**；1.3(b) 全表按此重写。已对 `isSensitiveKey(raw)` mutant 实跑，见 0.1 |
| I1 三条变异不是可编译 patch | 4.1 §10 / §19 / §21-b 改为完整 diff；§19、§21-b **已实跑**，§10 无实现故只给 diff 并如实标注未执行 |

### 0.1 本轮实跑结果（两条 CRITICAL 的证明）

**C1 — 锁协议**（用真实 `rustc 1.95.0` 建模三种实现 + 协议本体，非推理）：

| 实现 | 首次 I/O 时 `try_lock()` | 判定 |
|---|---|---|
| append 正确（guard 在首行） | WouldBlock（锁被持有） | PASS |
| append 无 guard | Ok（锁空闲） | **杀死** |
| append guard 在 read 之后 | Ok | **杀死** |
| append guard 在全部 I/O 之后 | Ok | **杀死** |
| load 正确 / load 无 guard | WouldBlock / Ok | PASS / **杀死** |
| clear 正确 / clear 无 guard（只有 write） | WouldBlock / Ok | PASS / **杀死** |

**子线程延迟 0ms 与 250ms 两组结果完全一致**——250ms 正是 R4 用来击穿 rev4 设计的那个偏移量。协议不含 timeout 断言，故与调度无关。

**C2 — 转义键 mutant**（把键判定从解码后改为原始 slice，即 `isSensitiveKey(raw)`）：**RED**，被 4 条 fixture 杀死。

| fixture（`~` = 反斜杠） | 正确实现 | mutant | 结论 |
|---|---|---|---|
| `{"~u0070assword":"hunter2"}` | `"[redacted]"`，gate 报 `password` | **原样 `hunter2` 落盘**，gate 空 | **杀死**（这就是漏洞本体） |
| `{"~u0041uthorization":"Basic eHh4"}` | `"[redacted]"` | 原样落盘 | **杀死** |
| `{"api~/password":"p","n":1}` | gate 报 `api/password` | gate 报 `api~/password` | **杀死**（gate 断言） |
| `{"pa~xss":"1","password":"y"}` | 降级 text 路径 → `{"pa~xss":"1","password":[redacted]` | 继续 JSON 扫描 → `{"pa~xss":"1","password":"[redacted]"}` | **杀死**；两分支输出不同，这正是 R4 要求的可区分性 |
| `{"pass~ud83d~ude00word":…}`、`{"pa~"ss":…}`、`{"pa~bssword":…}` | 均正确 | 与正确实现相同 | **不是 killer**，只是覆盖（如实标注，不计入杀伤） |

**C2 的根因比「写错了」更严重**：我在自己的测试脚本里重建 fixture 时，反斜杠**又一次**被吃掉，字节级核对（`od -c`）才发现。进一步探针显示这是**系统性**的——我的写入链路会解释 `~u0070` 这类合法转义（变成 `p`），而 `~x` 这类非法转义原样保留。也就是说「下次小心点」根本不成立，**规格与测试都不能依赖作者手写字面反斜杠**。4.4 的书写约定与 fixture 自检就是为此而设。

## （历史）rev4 对 R3 的处置

| R3 id | 处置 |
|---|---|
| C1 `redactValue` 非敏感分支仍走内容扫描 | 2.3.1 明确定义 `redactValue` 语义并明令禁止对非敏感 value 调用文本路径；PRODUCT 新增 §17；4.1 §17 三集合表驱动负例 |
| C2 JSON 转义键绕过硬名单 | 2.3.3 增加「键解码后判定、输出保留原始字节、非法转义降级」；PRODUCT 新增 §13；4.1 §13 覆盖 redaction / clear / gate 三组 |
| C3 锁测试无法区分「正确的锁」与「无作用的锁」 | 4.2 重建测试设计：写命令加「外部持锁期间文件字节未变」+「持锁期间外部改盘、释放后新旧都在」；`load_history` 改为内容判定；mutation 明列「把 guard 移到第一次 I/O 之后」。PRODUCT §30 加「取锁必须发生在任何文件 I/O 之前」 |
| I1 §16 只证明函数输出不变 | 4.1 §16 改完整往返（`sanitizeHistoryEntry → openHistoryEntry → marker/banner/gate/send`），并给了只作用于闸门半边的独立 killer |
| I2 §7 的 mutation 是确定性 survivor | 4.1 §7 换成 collection 链路专属 mutant（`openSavedRequest` 丢掉 body content），并要求断言错误字段精确为 `password` |
| I3 §12 未锁住未命中容器的递归 | PRODUCT §12 增加递归要求；4.1 §12 补三行深层 fixture，mutant 是让非敏感容器不再登记内层 span |
| M1 §19 的 mutation 不是单行 | 4.1 表头改「最小可编译 patch」，该行直接给两行 diff |
| A7（owner 裁定） | §29 及 TECH 内共 4 处跨 spec 章节号引用全部改为引用行为本身，见 3.2 |

## 1. Context

### 1.1 两条脱敏路径的现状

| | 保存的请求 | 历史 |
|---|---|---|
| 脱敏位置 | Rust `sanitize_saved_request_for_persistence`（`lib.rs:1379`），**读写双向**（`read_saved_request:1371-1377` 读时也过一遍） | **前端** `buildHistoryEntry`（`request.ts:456`），**只在写时** |
| 硬名单 | `is_sensitive_key`（`lib.rs:1473`），`normalized.contains(needle)` | `isSensitiveKey`（`request.ts:549`），带 `(^\|[-_\s])` 锚点的正则 |
| 敏感值写成 | `preserve_template_or_empty`（`lib.rs:1465`）：含 `{{}}` 保留，否则空串 | `"[redacted]"` 字面量（`request.ts:545`） |
| 非敏感值 | `redact_sensitive_text`（`lib.rs:1491`，只拆 urlencoded） | **也过内容扫描**（`request.ts:545` 的 else 分支）——C1 要删的就是它 |
| 落盘 | `save_request`（`lib.rs:1690`） | `append_history`（`lib.rs:2024`），**不做二次 sanitize** |

`lib.rs:3274` 的 `test_append_history_preserves_replay_fields_on_disk` 逐字断言 `append_history` 原样落盘。**Rust 对历史是哑管道，本切片不动这条边界。**

`lib.rs:1500` 是 PRODUCT §7 的根据：**已保存的 collection 里，urlencoded 体本来就带字面哨兵**，闸门必须覆盖 collection 来源。

### 1.2 毒化的完整链路

`buildHistoryEntry`（`request.ts:467-468`）→ `redactKeyValuePairs` → `redactValue`（`:544`）→ 命中写 `"[redacted]"`、**未命中走内容扫描** → `append_history`（`:164`）落盘 → `openHistoryEntry`（`tabs.ts:344`）用 `createEditablePairs`（`:97-102`，只换 id 不换值）还原，body 走 `:363` 直接赋值 → 用户按 Send → `buildPayload`（`:248-251`）无过滤 → `lib.rs:2319` `HeaderValue::from_str("[redacted]")` 合法 → `:2321` `append` → 线上。

### 1.3 rev4 实测记录（本轮新增部分；rev3 已验证的结论继续有效）

**(a) C1 的泄漏形态**（亲跑确认）

| 输入 | 现行 `redactValue` 非敏感分支 | rev4 要求 |
|---|---|---|
| key=`X-Note`, value=`password: hunter2` | value 变成 `password: [redacted]`——普通字段里出现脱敏字样、无「待重填」标记、清空与闸门都不管它 | 逐字节返回 `password: hunter2` |

**(b) C2 转义键**（rev5 重跑；**`~` 代表一个反斜杠字符**，见 4.4 的书写约定与构造规则）

rev4 这张表的 fixture 全部丢了反斜杠、退化成普通键，等于用反例的对照组冒充反例——已按约定重写并重跑：

| 输入 | 输出 | 是否 killer |
|---|---|---|
| `{"~u0070assword":"hunter2"}` | `{"~u0070assword":"[redacted]"}`（命中；**原始键字节保留**，未被规范化成 `password`） | **是** |
| `{"~u0041uthorization":"Basic eHh4"}` | `{"~u0041uthorization":"[redacted]"}` | **是** |
| `{"api~/password":"p","n":1}` | 值被替换；gate 报解码后的 `api/password` | **是**（gate 断言） |
| `{"pa~xss":"1","password":"y"}`（非法转义） | 扫描失败 → 降级 `text` 路径 → `{"pa~xss":"1","password":[redacted]` | **是**（与「继续扫描」输出不同） |
| `{"pass~ud83d~ude00word":"x","password":"y"}` | 转义代理对键不命中、`password` 命中 | 否，仅覆盖 |
| `{"pa~"ss":"1","token":"t"}` | 转义引号键正确跳过，`token` 命中 | 否，仅覆盖 |
| `{"pa~bssword":"x","cookie":"c"}` | `~b` 键不命中、`cookie` 命中 | 否，仅覆盖 |
| 闸门 / 清空 | `{"~u0070assword":"[redacted]"}` 的 gate 报 **`password`**（解码后）；清空得到 `{"~u0070assword":""}`（键字节仍保留） | — |

`isSensitiveKey(raw)` mutant 对本表实跑结果见 0.1：**RED，4 条 killer**。后三条不是 killer，如实标注，不计入杀伤。

**(c) I3 未命中容器的递归**（亲跑确认）

`{"a":[{"b":{"clientSecret":"x"}}]}` → `{"a":[{"b":{"clientSecret":"[redacted]"}}]}`；`{"a":{"b":{"c":{"password":"p"}}}}`、`{"a":[[{"token":"t"}]]}`、`{"list":[{"n":1},{"cookie":"c"}]}` 同样正确下降。

**(d) rev3 已验证、本轮未改动的结论**：span 字节保守（大整数 / 重复键 / 缩进 / 浮点 / 转义 / 未命中逐字节相同）、六种敏感值类型、删 T2 后的四条负向边界、CRLF 与孤立 CR、畸形百分号、§21 三项过度脱敏、全路径幂等、闸门无散文误报。

**(e) 已知残留**：非敏感字段名下的凭据不脱敏（PRODUCT 声明的边界，现已扩展到键值对）；`{"token":null}` 重放后变 `""`；§21 三项；`tokenizer` 因子串命中（既有行为，方向安全）。

### 1.4 I6：WebSocket（结论不变）

`buildHistoryEntry` 唯一调用点 `request.ts:162`，在 `invoke("send_request")` 成功返回（`:120`）与 `isRequestActive`（`:124`）之后，失败请求不写历史。`openHistoryEntry` 经 `createEmptyTab`（`:32-53`）产出的 tab 恒为 `protocol: "http"` 且全函数不改写——历史里的值不可能流进 `ws_connect`。反例：`useKeyboard.ts:28` 的 Cmd/Ctrl+Enter 不判 `tab.protocol`（D04 在册）。

### 1.5 与来源文档的分歧（代码为准）

1. `REVIEW-2026-08-18.md` §28 的对抗记录称 `{"authorization":"Basic xxx"}` 脱敏后安全，实测为 `{"authorization":[redacted]}`（非法 JSON）。
2. `Q1 #4` 的「重放时 URL 栏显示真值」不成立：`RequestPanel.vue:466` 传的是 `buildUrlWithParams(...)`，`splitUrlParts`（`:434`）先剥 query。可证实的是 `url: tab.url` 原样落盘（`request.ts:460`）并被 `HistoryPanel.vue:61-68` 与 `deriveHistoryLabel`（`tabs.ts:496-504`）显示。
3. `BACKLOG.md` 的 REVIEW 编号整体偏移 +2（已由 owner 加勘误）。
4. `Q1 #1` 建议在 `buildPayload` 加断言，位置不对：它收到 `resolvedTab`，会堵死 §8 的逃生口。

## 2. Proposed changes（按依赖序）

### 2.1 `src/utils/__fixtures__/sensitive-keys.json`（新增）

```json
{
  "sensitive": ["Cookie","Set-Cookie","Authorization","access_token","accessToken","refreshToken",
                "idToken","authToken","sessionToken","csrfToken","clientSecret","X-API-Key","apikey",
                "X-Api-Token","password","passwd","Ocp-Apim-Subscription-Key","subscription-key",
                "X-Amz-Signature","aws-credential"],
  "insensitive": ["key","Content-Type","Accept","page","keyword","monkey","X-Request-Id","user-agent"]
}
```

`keyword` / `monkey` 必须判 false —— §24「不加裸 `key`」的锁。

**（O2）Rust 侧 `include_str!` 必须 `#[cfg(test)]` 门控**：常量声明在 `mod tests` 内，路径 `../../src/utils/__fixtures__/sensitive-keys.json`（相对 `src-tauri/src/lib.rs`）。release 构建因此不对前端 `src/` 产生编译期依赖。

### 2.2 `src/utils/url-params.ts`（新增，纯搬运）

把 `RequestPanel.vue:395-450` 的 `syncParamsFromUrl` / `buildUrlWithParams` / `splitUrlParts` / `toParsableUrl` 与 `request.ts:263-266` 的 `stripQueryFromUrl` 集中，两处改为导入。**唯一动机是让 §26 可测**——仓库无 `@vue/test-utils`、`environment` 为 `node`，组件挂载不了。搬运不改逻辑。

已核对：Rust `lib.rs:2291-2296` 的过滤条件 `item.enabled && !item.key.trim().is_empty()` 与 `buildUrlWithParams` 的 `item.enabled && item.key` 一致——§26 是真命题。

### 2.3 `src/utils/redaction.ts`（新增，核心）

必须独立成模块：`request.ts:10` 已 `import { useTabsStore } from "./tabs"`，而 `tabs.ts` 要用这些函数，从 `request.ts` 导出会成环。

```ts
export const REDACTION_SENTINEL = "[redacted]"
export type BodyKind = "json" | "urlencoded" | "text"

export function isSensitiveKey(key: string): boolean
export function lenientDecodeKey(rawKey: string): string
export function bodyKindFromBodyType(bodyType: string): BodyKind
export function bodyKindFromContentType(contentType: string): BodyKind

export function redactBodyText(kind: BodyKind, content: string): string
export function redactValue(key: string, value: string): string
export function redactKeyValuePairs<T extends KeyValuePair>(items: T[]): T[]
export function redactUrlQuery(rawUrl: string): string
export function sanitizeHistoryEntry(entry: HistoryEntry): HistoryEntry

export function clearSentinelPairs<T extends KeyValuePair>(items: T[]): T[]
export function clearSentinelBody(kind: BodyKind, content: string): { content: string; cleared: boolean }
export function findSentinelFields(tab: Tab): string[]
export function hasPendingRedactedFields(tab: Tab): boolean
export function applyPairEdit<T extends KeyValuePair>(rows: T[], id: string, patch: Partial<T>): T[]
```

#### 2.3.1 `isSensitiveKey` 与 `redactValue`（C1）

`isSensitiveKey`：与 Rust 同构的规范化子串匹配（去掉 `(^|[-_\s])` 锚点）。名单 = Rust `lib.rs:1474-1486` 现有 10 项 + `subscription-key` / `signature` / `credential`，写成与 Rust 逐行对应的字符串数组。

**`redactValue` 只有两个分支，没有第三种可能：**

```ts
export function redactValue(key: string, value: string): string {
  return isSensitiveKey(key) && value ? REDACTION_SENTINEL : value
}
```

**明令禁止**在非敏感分支调用 `redactBodyText("text", value)` 或任何内容扫描。今天 `request.ts:545` 的 else 分支正是这么做的，实测会把 `X-Note: password: hunter2` 改写成 `password: [redacted]`——普通字段里出现脱敏字样，却没有「待重填」标记、清空路径不认它、闸门也不拦它。那正是我们花两轮消灭的假信号形态。搬运这段代码时**不能照抄结构再删 T2**，必须按上面的两分支重写。

`redactKeyValuePairs` / `redactResponseHeaders` / `sanitizeHistoryFormData` 三处都走这个 `redactValue`，因此三个集合行为一致。

#### 2.3.2 类型分派

`bodyKindFromBodyType`：`json`→`json`；`form-urlencoded`→`urlencoded`；其余→`text`。
`bodyKindFromContentType`：含 `json`→`json`；含 `x-www-form-urlencoded`→`urlencoded`；其余→`text`。

格式分派不是内容识别：格式只决定用什么语法定位字段名，敏感与否始终只由硬名单决定。

#### 2.3.3 `json` 路径 —— span 字节替换

**不做 `JSON.parse` + `JSON.stringify` 往返。** 手写一个只做定位的扫描器，在**原始文本**上求出每个敏感键对应 value 的 `[start, end)`，从后往前替换成 `"[redacted]"`（含引号），其余字节一字不动。

扫描器要点：

- 读对象成员的 key token 时按 JSON 转义规则跳过（`\\` 一律跳 2 字符，因此 `\"` / `\\` / `\uXXXX` 都能正确越过）；
- **（C2）键必须解码后再判定**：把 key token 按完整 JSON 字符串语义解码（含 `\uXXXX` 与代理对），解码结果**只用于**两件事——`isSensitiveKey` 判定、以及闸门要报出的字段名。**输出永远保留原始 key 字节**，不得把 `password` 规范化成 `password`。键含非法转义时解码失败 → 整段扫描失败 → 降级 `text` 路径（不得静默按未命中放行）；
- `skipValue` 记录 value 起点，按首字符分派到字符串 / 对象 / 数组 / 字面量（数字、`true`、`false`、`null` 统一按「读到 `,` `]` `}` 或空白为止」），返回时记录终点；
- 命中敏感键时把整个 value 区间登记为一个 span，并且**不再递归进去**登记内层 span（避免区间重叠导致替换互相破坏）；
- **（I3）未命中时必须继续下降**——对象成员的值是对象或数组时要递归进去，数组元素是对象时也要递归，任意深度都要能发现内层敏感键。`{"a":[{"b":{"clientSecret":"x"}}]}` 必须命中；
- 数组元素本身没有键名，元素只在其内部对象出现敏感键时才登记；
- 扫描失败（非法 JSON、非法转义、尾随内容）→ 抛错 → 调用方降级 `text` 路径（§21-c）；
- span 为空 → **直接返回原字符串**，不做任何重建（§11）。

`clearSentinelBody` / `findSentinelFields` 复用同一个扫描器，因此 C2 的键解码同时保护清空与闸门两条路径。

#### 2.3.4 `text` 路径 —— 只有 T1（键锚定）

先按 `/(\r\n|\n|\r)/` 带捕获组切分成 `[行, 终止符, …]`，**只处理偶数下标**，最后 `join("")`——终止符逐字节保留（§18）。

每行用 `/["']?([A-Za-z0-9_.\-]+)["']?[ \t]*[:=][ \t]*/g` 扫描，取**第一个** `isSensitiveKey(key)` 为真的匹配，把分隔符之后到行尾整段替换为哨兵。

**正则必须在函数内部构造**：带 `g` 的正则在 `exec` 循环里提前 `return` 会留下非零 `lastIndex`，跨行、跨调用串状态（见 4.3）。

**没有 T2**，也没有对 JSON 非敏感键字符串值的 scheme 扫描——两者在 rev3 已按裁定删除。

#### 2.3.5 `urlencoded` 与 `redactUrlQuery`

都按原始字符串切分，绝不经 `URL` / `URLSearchParams` 重序列化：body `split("&")` → 每段取第一个 `=` → key 经 `lenientDecodeKey` 判定 → 命中则 `原始key + "=" + 哨兵`，未命中段原样；`redactUrlQuery` 先切 `#` 留 hash、再切第一个 `?`，无 `?` 原样返回，query 复用逐段处理后拼回。

**`lenientDecodeKey` 永不抛异常**：先整体 `decodeURIComponent(raw.replace(/\+/g," "))`；抛错则退化为逐个 `%XX` 单独解码、能解的解、解不了的原样。实测 `%70assword%ZZ` → `password%ZZ`（仍判敏感，不漏脱）；`%E0%A4%A` → 原样。

### 2.4 `src-tauri/src/lib.rs`

1. **`is_sensitive_key`（`:1473-1489`）**：数组追加 `"subscription-key"`、`"signature"`、`"credential"`。

2. **（C3/C4）历史文件的进程内互斥锁**。`lib.rs:24` 已有 `use std::sync::{Arc, Mutex as StdMutex, OnceLock};` —— **复用 `StdMutex` 别名**；该 `use` 行追加 `MutexGuard`。

```rust
fn history_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

fn lock_history() -> MutexGuard<'static, ()> {
    history_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
```

**取锁位置是本条的全部内容，不是形式要求**：`let _guard = lock_history();` 必须是 `append_history`（`:2024`）、`load_history`（`:2041`）、`clear_history`（`:2048`）、`delete_history_entry`（`:2053`）与新增 `update_history_entries` 的**第一条语句**，且必须**先于任何文件 I/O**。

放在 `read_history_entries()` 之后就等于没锁：两个命令仍会各自读到同一份旧快照、再依次覆盖，丢写照旧发生；`clear_history` 更会先把盘清了再去阻塞。R3 实测证明「只断言命令在返回前阻塞」的测试无法区分这两种实现，4.2 因此重建了测试。

中毒恢复用 `into_inner`，与 `env_lock()`（`:3078-3084`）一致。这些是同步 `#[tauri::command]`，跑在阻塞线程池上。

**锁的层次是硬契约（与 D03 的接口）**：锁只在 `#[tauri::command]` 层取，私有 helper `read_history_entries()`（`:651`）与 `write_history_entries()`（`:672`）**保持无锁**。`std::sync::Mutex` 不可重入，任一方在 helper 里再取一次锁都会让五个命令死锁。已核对两个 helper 的全部调用点为 `:2029` / `:2037` / `:2042` / `:2049` / `:2054` / `:2056`，都在命令内部。helper 无锁同时是 4.2 测试成立的前提——测试要在持锁期间直接改盘。

3. **新命令 `update_history_entries`**（紧邻 `delete_history_entry`）：

```rust
#[tauri::command]
fn update_history_entries(entries: Vec<HistoryEntry>) -> Result<(), String>
```

取锁 → `read_history_entries()?` → 按 id 逐行替换，id 不在负载内的行原样保留 → `write_history_entries(&merged)`。**Rust 不做任何脱敏**，保持哑管道。锁与 merge-by-id 都要：锁管「不丢写」，merge 管「旧快照不抹掉没见过的行」。

**D01 按上面这个形态实现**（今天的 `read_history_entries() -> Result<Vec<HistoryEntry>, String>` 与 `write_history_entries(&[HistoryEntry])`），因为 `lib.rs` 的串行顺序是 D01 先落地。

**D03 落地时的改写形态**（下述形状由 D03 起草者给出并与我确认过接口约定，**但其规格本身不在本工作树中，我未验证**；以 D03 落定的实现为准）：两个 helper 的签名都会变，`read_history_entries` 返回同时携带条目与坏行原文的结构，`write_history_entries` 增加一个坏行参数。`update_history_entries` 相应改为先取结构、在其条目集合上 merge、写回时**把读到的坏行原样传回去**。**必须传真实的坏行集合，绝不能传空**——传空会让隔离行被静默丢弃，而隔离行恰恰可能携带 2026-04-27 之前的明文凭据，那正是隔离机制存在的理由。**该改写与其 quarantine 测试覆盖 `update_history_entries` 这条路径，由 D03 负责**；D01 不预写该测试（它断言的是 D03 的不变式），此处显式登记以免两边都以为对方做了。

4. **注册**：`invoke_handler`（`:3041` 后）+ dev bridge `api_update_history_entries`（仿 `:2942`）与路由（`:2988` 后）。

### 2.5 `src/types/index.ts`

`KeyValuePair`（`:1-7`）加 `redacted?: boolean`；`Tab`（`:96-117`）加 `bodyRedacted?: boolean`。均为纯前端内存态。Rust 的 `KeyValuePair`（`lib.rs:79-85`）无 `deny_unknown_fields`（全仓 0 处），多余字段被丢弃；即便如此仍在前端显式剥离（§40）。

### 2.6 `src/utils/saved-request.ts`（新增，纯搬运）+ 标记清除规则

把 `RequestPanel.vue:266-283` 的 `buildSavedRequest`、`:285-333` 的 `sanitizeBodyForSave`、`:334-339` 的 `stripTransientFields` 搬出，签名改 `buildSavedRequest(tab: Tab, name: string): SavedRequest`。`stripTransientFields` 同时剥离 `id` 与 `redacted`。动机同 2.2：§40 要求 `save_request` 路径有独立断言与独立 killer。

**`applyPairEdit` 只在 patch 真的含 `value` 时清标记**：

```ts
export function applyPairEdit<T extends KeyValuePair>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) =>
    row.id === id
      ? { ...row, ...patch, ...("value" in patch ? { redacted: false } : {}) }
      : row,
  )
}
```

`KeyValueEditor` 的同一个 `updateRow` 也处理 enabled / key / description（`:56-62`），无条件清标记会让「切一下 enabled」就抹掉待重填提示而值还是空的。同理 `RequestPanel.updateBody` 只在 `content` 变化时写 `bodyRedacted: false`。

### 2.7 `src/stores/tabs.ts`

`openHistoryEntry`（`:344-421`）在组装完 `tab`、进入 `:401` 匹配空 tab 逻辑**之前**插入：

```ts
tab.params  = clearSentinelPairs(tab.params)
tab.headers = clearSentinelPairs(tab.headers)
tab.body.formData = clearSentinelPairs(tab.body.formData)
const cleared = clearSentinelBody(bodyKindFromBodyType(tab.body.type), tab.body.content)
tab.body.content = cleared.content
tab.bodyRedacted = cleared.cleared
```

放在 `:351-353` 两个分支（`createEditablePairs(entry.requestParams)` 与 `deriveParamsFromUrl(entry.url)`）**汇合之后**。`serializeRequestIdentity`（`:510-563`）显式列举字段、不含新字段，无需改动。

### 2.8 `src/stores/request.ts`

- 删掉 `:263-266`、`:533-569` 的私有函数，改从 `../utils/redaction` 与 `../utils/url-params` 导入。**`redactValue` 按 2.3.1 重写，不是搬运。**
- `:94` 改 `formatRequestLabel(requestSnapshot.method, requestSnapshot.url)`（§38）；`:158` 复用同一 `requestLabel`。
- `buildHistoryEntry`（`:456-484`）：`url: redactUrlQuery(tab.url)`；`requestBodyContent` / `responseBody` 改走 `redactBodyText(kind, …)`；末尾 `return sanitizeHistoryEntry(raw)`。响应体截断（`:478-481`）仍在 builder 内、发生在脱敏之前。
- 新增送出前闸门，在 `:77` `cloneTabSnapshot` 之后、`:93` `resolveTabVariables` **之前**：

```ts
const sentinelFields = findSentinelFields(requestSnapshot)
if (sentinelFields.length > 0) {
  throw new Error(i18n.global.t("errors.redactionSentinelOnWire", { field: sentinelFields.join(", ") }))
}
```

放在 `try` 内落进 `:169` 现有 catch → `responseError`，与 `errors.fileSelectionRequired`（`:281`）同一通道。放在解析之前即是 §8 的逃生口。
- `mergeVariables`（`:374-392`）：新建分支 `secret: false` 改为 `secret: knownSecretValues.has(value)`（§36）；既有 key 分支（`:379-381`）**不动**（§37）。

### 2.9 `src/stores/history.ts`

```ts
async function loadHistory() {
  const raw = await invoke<HistoryEntry[]>("load_history")   // 失败整体抛出，不吞、不回写（§31）
  const sanitized = raw.map(sanitizeHistoryEntry)
  const changed = sanitized.filter((entry, i) => JSON.stringify(entry) !== JSON.stringify(raw[i]))
  entries.value = sortEntries(sanitized)
  if (changed.length === 0) return
  try {
    await invoke("update_history_entries", { entries: changed })
    recordConsoleEntry("info", i18n.global.t("history.legacySanitized", { count: changed.length }), "app")
  } catch (error) {
    recordConsoleEntry("error", `[app] History sanitize write-back failed: ${error}`, "app")
  }
}
```

`entries.value` 先赋值，保证回写失败时 UI 已是干净数据。`appendEntry`（`:42-49`）不变。

### 2.10 组件与文档

- `KeyValueEditor.vue`：`updateRow`（`:47-50`）改调 `applyPairEdit`；value 输入框（`:108-114`）在 `row.redacted` 时用琥珀边框 + `t('keyValue.redactedPlaceholder')`。
- `RequestPanel.vue`：UrlBar（`:463-475`）与分区按钮条之间插提示条，`v-if="hasPendingRedactedFields(activeTab)"`。
- `src/i18n/zh-CN.ts` / `en.ts`：5 个新键 + 改写 `securityNotice`（两文件均 `:212`）。`errors.redactionSentinelOnWire` 的字面花括号写成 `{'{{'}变量名{'}}'}`。
- `README.md:69` / `SECURITY.md:21`：改写并补 PRODUCT 列的五条边界，其中**「非敏感字段名下的凭据不脱敏也不标记，含普通 header/param 的值」必须写明**。

## 3. 跨切片依赖与归属裁定

**（C4 归属，采纳 owner 裁定）** 历史文件互斥锁归 **D01**：第二个写入者 `update_history_entries` 由 D01 引入，谁引入谁负责。D03 的 tmp + rename 解决**崩溃原子性**，锁解决**并发丢写**，正交、都要、互不替代。

仍属 D03、本切片不修：`write_history_entries`（`:672`）截断式重写——`append_history` 今天每次请求都走一遍同样的读-改-截断写，§28 的回写**不引入新失败模式**；`read_history_entries`（`:651`）遇坏行整体 `Err`——读失败时 `loadHistory` 今天就已抛错、面板显示 `errorMessage`（`HistoryPanel.vue:31-33`），§31 只要求此时绝不回写。

**与 D03 已商定的五点：**

1. **坏行不再「原样保留」**。据 D03 起草者所述，D03 会引入坏行隔离，把无法解析的行移出历史主文件另行保存、不再放回。PRODUCT §29 已加自包含限定并标注了转述来源，权威表述以 D03 落定的规格为准。
2. **helper 签名变更与 `update_history_entries` 的改写**：见 2.4 第 3 条末尾，含「必须传真实坏行集合而非空」的硬约束及其测试归属。
3. **本切片的清洗/迁移够不到被隔离的行**——它们之所以被隔离，正是因为反序列化不成 `HistoryEntry`，永远不会进入 `sanitizeHistoryEntry` 的输入。两面都要如实理解：
   - §27「进入面板或 tab 之前被脱敏」仍然成立——坏行不会变成条目，用户看不到它；
   - 但 REVIEW §27 追求的「把明文清出磁盘」对这部分数据**不成立**：明文换了个文件仍在磁盘上。据 D03 起草者所述，收口手段是让「清空历史」一并删除隔离文件（本切片未验证）。

   **隔离不是安全改进，spec 不许读起来像是**：今天坏行躺在 `history.jsonl` 里「够不着但存在」，D03 之后它躺在隔离文件里**仍然存在**。同一块磁盘、同一用户、同样权限，字节本来就在那儿——没有新增暴露，但**也不是减少**。隔离是一次数据保全动作，安全代价由「清空历史」偿还。
4. **D01 的存量清洗在 D03 落地之前，对「文件里有坏行」的用户完全不会执行。** `read_history_entries`（`lib.rs:658-666`）在第一条无法解析的行上就 `return Err`，`load_history` 整体失败，§28 的回写走不到。§31 在这种情况下成立（这是设计），但它掩盖了更重要的事实——**§27/§28 这条 REVIEW §27 的正面修复对这批用户静默不生效**。D01 单独合并只能修好「文件完好」的用户。**owner 已实测本机 `history.jsonl`：94 行全部可解析、严格形状检查 0 行不合法**，因此手工验收步骤 5 的前提在本机成立、不需要等 D03。
5. **README 归属**：隔离文件及其生命周期、「清空历史」的删除语义，README 文案**归 D03**，D01 不复述这些语义，也不加指向 D03 段落的前向引用（D01 先落地，那段文字彼时不存在，加了就是悬空引用）。

### 3.1 对 `BACKLOG.md` 并行约束的影响

- **新增文件**：`src/utils/redaction.ts`、`url-params.ts`、`saved-request.ts`、`__fixtures__/sensitive-keys.json`。四个都是新文件，与 D06 独占的 `curl-parser` / `curl-export` / `postman-*` / `openapi-import` 无交集，**D06 仍可并行**。
- **`RequestPanel.vue` 改动较大**（插提示条 + 搬走 `:266-339` 与 `:395-450` 两组函数），**「D05 排在 D01 之后」是硬约束**。
- **与 D06 移交给 D05 的「cURL 导入后 query 同时留在 url 与 params」那一项相关**：其修复点 `RequestPanel.vue:222/241` 调用的正是被搬走的 `syncParamsFromUrl`；D05 开工时按 `src/utils/url-params.ts` 定位。

### 3.2 A7：跨 spec 引用不带编号

按 owner 裁定 A7（修订后的判据）：**跨文档引用只能引用行为本身，不得引用任何外部标识符**——章节号、条目 ID、文件路径全部在内。判据不是「它是不是号码」，而是**它的身份是否由另一个文档单方面决定、且可能在我不知情时改变**。本切片自己的编号走过 27 → 34 → 39 → 41，正是这条判据的现成例证。

两类**不受限**：本 spec 内部的自引用（`§26` / `§30` 之类）；以及 owner 维护的裁定台账（`A1`–`A10`）——那张表只追加、不重编号，稳定性由 owner 负责，这也是它存在的意义。切片内部的局部枚举（例如各切片自己排的 `C1`/`X5`）**不属于**这一类，会随 scope 调整重排，一律改成描述行为。

rev4 已改的五处（改后一列为**当前正文的实际措辞**，随 R4 的转述改写一并更新）：

| 位置 | 改前（历史引文） | 现状 |
|---|---|---|
| PRODUCT §29 | 「权威表述见 D03 PRODUCT §21/§22」 | 「据 D03 起草者所述……权威表述以 D03 落定的规格为准」——去标识符 + 标注转述 |
| TECH 3 引言 | 「`specs/D03-persistence/TECH.md` §2.2 记录了本切片的锁契约」 | 整句删除；根因另见 3.3 的事故记录 |
| TECH 3 第 1 条 | 「指向 D03 PRODUCT §21/§22 作为权威出处」 | 「据 D03 起草者所述……以 D03 落定的规格为准」 |
| TECH 3 第 3 条 | 「D03 PRODUCT 交叉项 X5」 | 去掉条目 ID，直接陈述该事实 |
| TECH 3.1 末条 | 「D06→D05 交接项 C1」 | 改为描述该缺陷的行为（cURL 导入后 query 同时留在 url 与 params） |

上表「改前」一列是**历史引文**，用于记录改了什么，不是活引用——那些标识符已经不在正文里，全仓扫描时应按此排除。

对 `BACKLOG.md` 里**切片局部枚举**的引用（3.1 最后一条）已改成描述行为；对 `REVIEW-2026-08-18.md` 的编号引用**保留**——它是已完成、不再修订的存档文档，与「移动的 spec」不是一类。

### 3.3 R4：他方陈述不得当作事实

按规则 R4，**不得把其他 agent 的口头陈述当作事实写进持久产物，除非自己验证过**。本切片对 D03 的全部引述已按此重写：涉及 D03 设计与文件布局的语句一律标注「据 D03 起草者所述 / 未验证」，不再用陈述句。

**事故记录（本切片造成）**：rev2–rev3 期间我写下「`specs/D03-persistence/TECH.md` 记录了本切片的锁契约」。写下的那一刻该目录在本工作树中并不存在（对方在独立 worktree 里），一条 `ls specs/` 即可发现。根因不是引用方式，而是把对方的口头陈述直接当成了既成事实。同一轮里我和 D03 互相把对方的陈述写进各自的 spec，两份文档因此在没有任何一方验证的情况下产生了耦合——这也是「跨切片结论先经 owner」那条规则的真正价值：只有 owner 同时看得到两份 spec 的真实状态。

## 4. Testing and validation

命令：`npm run test`（vitest）/ `npm run test:rust`（cargo，`--test-threads=1` 串行、离线）。声称完成前自跑 `npm run release:check`。

**四个陷阱：**

1. `recordConsoleEntry`（`src/stores/console.ts:114-120`）用**模块单例 pinia**。§38 的测试必须从 `../console` 取模块单例 store 断言，否则断的是永远为空的影子 store（该行为是 REVIEW §37，属 D05，不修但必须绕开）。
2. 既有测试 `request.test.ts:582` 只断言 `toContain("[redacted]")`，其输出实为非法 JSON 却一直绿。**必须收紧为相等断言**：新输出是 `{"authorization":"[redacted]","token":"[redacted]"}`。
3. §1 / §5 / §17 / §40 必须**表驱动**：headers / params / form-data 三集合各一行，让「只改了 headers」单独可杀。
4. Rust 并发测试中 `HomeGuard`（`:3088-3110`）设进程级 `HOME`，派生线程共享；`lock_env()`（`:3078`）保证同一时刻只有一个测试改 `HOME`。`--test-threads=1` 限制测试间并行，不影响测试内部 `thread::spawn`。

新增测试文件：`src/utils/__tests__/redaction.test.ts`、`url-params.test.ts`、`saved-request.test.ts`、`src/stores/__tests__/history-sanitize.test.ts`、`src/i18n/__tests__/locale-parity.test.ts`。扩展：`request.test.ts`、`tabs-history.test.ts`、`lib.rs` 的 `mod tests`。

### 4.1 不变式 → 测试映射

变异检查一律是**最小可编译 patch**，格式「把 X 改成 Y → 哪条断言红」；需要多于一行时直接给 diff。

| § | 文件 | 测试名 | 类型 | 最小可编译 patch |
|---|---|---|---|---|
| 1 | tabs-history | `blanks sentinel values in %s`（headers/params/formData） | vitest | `clearSentinelPairs` 的 `value.trim() === REDACTION_SENTINEL` 改 `false` → 三行全红；删掉 `tab.body.formData = clearSentinelPairs(...)` 一行 → 仅 formData 行红 |
| 2 | tabs-history | `clears sentinel body for %s body`（json/urlencoded/raw） | vitest | `tab.body.content = cleared.content` 改 `tab.body.content = tab.body.content` → 三行全红 |
| 3 | redaction | `keeps the marker when %s changes`（enabled/key/description）+ `clears the marker when value changes` | vitest | `..."value" in patch ? { redacted: false } : {}` 改 `...{ redacted: false }` → 三条负例红，正例仍绿 |
| 4 | redaction | `reports pending redacted fields until every marker is cleared` | vitest | `hasPendingRedactedFields` 的 `\|\| tab.bodyRedacted` 删掉 → body-only 用例红 |
| 5 | request | `refuses to send a sentinel value in %s`（三集合） | vitest | `findSentinelFields` 中遍历 `tab.params` 的一行删掉 → params 行红；断言 `send_request` 与 `append_history` 均未调用 |
| 6 | request | `refuses a sentinel body value under a sensitive key` + `sends a body whose prose contains the sentinel` | vitest | body 分支改 `content.includes(REDACTION_SENTINEL) ? ["body"] : []` → 散文用例红 |
| 7 | request | `refuses a sentinel restored from a saved collection request` | vitest | **collection 链路专属**：`tabs.ts:321-327` 的 `content: request.body.content` 改 `content: ""` → 本行红而 §6 不受影响。断言错误字段**精确等于 `password`**（笼统的 `body` 也算红），因此 §6 的 `includes` mutant 在这里同样红 |
| 8 | request | `sends a variable that resolves to the literal sentinel` | vitest | 闸门入参 `requestSnapshot` 改 `resolvedTab` |
| 9 | request | `sends a redacted-marked field as empty instead of blocking` | vitest | 闸门条件 `v.trim() === REDACTION_SENTINEL` 改 `v.trim() === REDACTION_SENTINEL \|\| item.redacted` |
| 10 | tabs-history | `keeps restored response headers out of the request headers` | vitest | 在 `openHistoryEntry` 的响应快照还原之后插入一行（**未执行：该实现尚不存在，仅给 diff**）：<br>`  }` <br>`+ tab.headers.push(...createEditablePairs((entry.responseHeaders ?? []).map(([k, v]) => ({ id: "", enabled: true, key: k, value: v, description: "" }))))` <br>断言 `openedTab.headers` 长度为 0 的用例变红 |
| 11 | redaction | `preserves non-matching json bytes for %s`（大整数/重复非敏感键/缩进/浮点/转义/未命中 六行） | vitest | span 替换的 `out.slice(spans[k].end)` 改 `out.slice(spans[k].end + 1)` → 前五行红；`if (spans.length === 0) return text` 改 `return JSON.stringify(JSON.parse(text))` → 未命中行红 |
| 12 | redaction | `redacts a sensitive json value of type %s`（string/number/bool/null/object/array）+ `descends into non-matching %s`（多层对象/对象内数组/数组内数组） | vitest | 类型半边：`if (sensitiveKey) spans.push(...)` 改 `if (sensitiveKey && c === '"') spans.push(...)` → 后五行红。递归半边：`skipValue` 里 `else if (c === "{") obj(Boolean(sensitiveKey))` 改 `obj(true)` → 三行深层 fixture 全红（顶层六行仍绿，证明两半独立） |
| 13 | redaction | `treats an escaped json key as its decoded name`（redaction / clear / gate 三组，fixture 见 4.4） | vitest | **已实跑，RED**。键判定 `isSensitiveKey(decodeJsonKey(raw))` 改 `isSensitiveKey(raw)` → 4 条 fixture 杀死（`~u0070assword` 与 `~u0041uthorization` 的值原样落盘、`api~/password` 的 gate 名字不同、`pa~xss` 的降级分支输出不同）。另：非法转义分支从「抛错降级」改 `return raw` → `pa~xss` 用例红。**冻结前必须复跑此 mutant 并留红灯记录** |
| 14 | redaction | `keeps every urlencoded field and non-matching bytes` | vitest | 命中分支 `` `${rawKey}=${S}` `` 改 `` `${rawKey}=${S}&` `` → 字段数断言红；`part.indexOf("=")` 改 `part.lastIndexOf("=")` → 值含 `=` 的 fixture 红 |
| 15 | redaction | `redacts %s to end of line`（basic/digest/spacey） | vitest | T1 的 `m.index + m[0].length` 改 `m.index` → 三行全红 |
| 16 | redaction + tabs-history + request | `leaves credentials under non-sensitive keys untouched end to end`（裸 Bearer / 裸 Digest / json note / 散文 四行，每行走 `sanitizeHistoryEntry → openHistoryEntry`，断言原文、无 marker、无 banner、`findSentinelFields` 为空、`send_request` 被调用） | vitest | 文本半边：text 路径 return 前加一行 `.replace(/\b(Bearer\|Basic\|Digest\|Token)[ \t]+[^\s"',;]+/gi, "$1 [redacted]")` → 前两行原文断言红。闸门半边：`sentinelTextKeys` 的 `line.slice(h.cut) === S` 改 `line.includes(S) \|\| /Bearer/i.test(line)` → 裸 Bearer 行的 gate/send 断言红 |
| 17 | redaction + request | `keeps a non-sensitive %s value byte-identical`（headers/params/formData 三行，fixture 含 `X-Note=password: hunter2`、裸 Bearer、裸 Digest） | vitest | `redactValue` 非敏感分支 `: value` 改 `: redactBodyText("text", value)` → 三行全红 |
| 18 | redaction | `preserves %s line terminators`（LF/CRLF/lone CR） | vitest | `split(/(\r\n\|\n\|\r)/)` 改 `split("\n")` → CRLF 与 lone-CR 行红 |
| 19 | redaction | `is idempotent across all paths` + `produces the same result for a line alone and inside a multi-line body` + `is unaffected by a preceding call` | vitest | **已实跑**。把 T1 的扫描正则从函数内提到模块作用域（3 个编辑点）：<br>`+ const SCAN_RE = /["']?([A-Za-z0-9_.\-]+)["']?[ \t]*[:=][ \t]*/g` （模块顶层新增）<br>`  function firstSensitiveCut(line) {` <br>`-   const re = /["']?([A-Za-z0-9_.\-]+)["']?[ \t]*[:=][ \t]*/g` <br>`    let m` <br>`-   while ((m = re.exec(line)) !== null)` <br>`+   while ((m = SCAN_RE.exec(line)) !== null)` <br>实测：多行单次调用 `"Cookie: sid=…\nAuthorization: Bearer tok\npassword: hunter2"` 下**第二行原样残留**；连续三次不同输入下**第二条原样残留**。两条断言均红 |
| 20 | redaction | `never throws on malformed percent escapes`（body 与 url 两条） | vitest | `lenientDecodeKey(rawKey)` 改 `decodeURIComponent(rawKey)` → 两条红 |
| 21 | redaction | `over-redacts %s (documented)`（raw-urlencoded / 单行 curl / 非法 json 三行，断言 1.3 的具体输出） | vitest | 第一行：text 路径开头加一行 `if (!/\s/.test(content) && content.includes("=")) return redactUrlencoded(content)`。<br>第二行（**已实跑**）：把 T1 的替换改成截到下一个单引号——<br>`- return hit ? line.slice(0, hit.cut) + REDACTION_SENTINEL : line` <br>`+ if (!hit) return line` <br>`+ const q = line.indexOf("'", hit.cut)` <br>`+ return line.slice(0, hit.cut) + REDACTION_SENTINEL + (q === -1 ? "" : line.slice(q))` <br>实测输出由 `curl -H 'Authorization: [redacted]` 变成 `curl -H 'Authorization: [redacted]' https://x`，该行断言红。<br>第三行：`return r === null ? redactText(content) : r` 改 `: content` |
| 22 | redaction | `matches camelCase sensitive keys` | vitest | `n.includes(x)` 改 `n.startsWith(x)` |
| 23 | redaction + `lib.rs` `test_is_sensitive_key_matches_shared_fixture` | 两侧同名，读同一 fixture | vitest + cargo | 任一侧名单删 `"subscription-key"` → 该侧红 |
| 24 | 同 §23 fixture 用例 | — | vitest + cargo | 任一侧名单追加 `"key"` → `insensitive` 组红 |
| 25 | redaction | `preserves every non-matching byte of the url`（%20 / `+` / host 大小写 / `:80` / fragment / 相对 / `{{var}}` / 重复 key 八行） | vitest | `redactUrlencoded(before.slice(qi + 1))` 改 `redactUrlencoded(decodeURIComponent(before.slice(qi + 1)))` → `%20` 与 `{{var}}` 行红 |
| 26 | url-params | `url bar query matches the wire query for %s`（带 requestParams / URL 反推 / 重复 key / 含 disabled 四行） | vitest | `if (item.enabled && item.key)` 改 `if (item.key)` → disabled 行红 |
| 27 | history-sanitize | `sanitizes legacy plaintext entries before exposing them` | vitest | `raw.map(sanitizeHistoryEntry)` 改 `raw.map((e) => e)` |
| 28 | history-sanitize | `writes back exactly once and then converges` | vitest | `changed` 过滤条件改 `true` → 「恰好一次」断言红 |
| 29 | `lib.rs` | `test_update_history_entries_preserves_unlisted_rows` | cargo | `write_history_entries(&merged)` 改 `write_history_entries(&entries)` |
| 30 | `lib.rs` | `test_history_lock_held_at_first_io_in_%s`（append/load/clear/delete/update）+ `test_child_panic_after_completion_fails_the_test` | cargo | **lock killer**：首次 I/O checkpoint 内 `try_lock()` 必须 `Err(WouldBlock)`；三种错误锁位点由**同一条** `LockFree` 断言杀死。实跑（`rustc 1.95.0`，`TOTAL=41 WRONG=1`，`EXIT=0`）：主矩阵 36 组 Correct=GREEN / 三 mutant=RED，0ms 与 250ms 逐行一致。**`child_ok` 断言的承重已单独证明**：命令跑完后再 panic 的用例只塌 `child_ok`（verdict/outcome/终态均通过）⇒ RED；**移除该断言后同一探测转 GREEN**（`WRONG=1`）。双失败诊断同时报告两项。中毒 ⇒ `HarnessError`，不 panic、不挂死、`clear_poison` 后下一 case 恢复。**终态断言不计入 lock 杀伤**，且其自身承重性未经证明（见 4.2.3 的缺口记录）|
| 31 | history-sanitize | `does not write back and rethrows when history cannot be read` | vitest | `await invoke(...)` 改 `await invoke(...).catch(() => [])` → `rejects` 断言红，`update_history_entries` 未调用的断言仍绿 |
| 32 | request | `never rewrites live tab values while building history` | vitest | `:162` 之后加一行 `tabsStore.updateTab(requestSnapshot.id, { headers: historyEntry.requestHeaders })` |
| 33 | `lib.rs` | `test_read_saved_request_blanks_new_keys_without_touching_disk` | cargo | 在 `Ok(sanitize_saved_request_for_persistence(request))` 前插入一行 `let _ = fs::write(file_path, "{}");` → 字节不变断言红 |
| 34 | `lib.rs` | `test_save_request_persists_blanked_new_keys` | cargo | `is_sensitive_key` 名单删 `"signature"` → 红 |
| 35 | locale-parity | `readme and security doc state the field-name-only boundary` | vitest | 删掉 README 中那句 → 红 |
| 36 | request | `marks a script-copied secret value as secret` | vitest | `secret: knownSecretValues.has(value)` 改 `secret: false` |
| 37 | request | `keeps an existing secret variable secret when a script overwrites it` | vitest | `current.value = value` 改 `variableMap.set(key, { key, value, secret: false })` |
| 38 | request | `logs the unresolved url to the console` | vitest | `formatRequestLabel(requestSnapshot.…)` 改 `formatRequestLabel(resolvedTab.…)` |
| 39 | locale-parity | `zh-CN and en expose the same key set` | vitest | 从 `en.ts` 删掉任一新键 |
| 40 | request + saved-request | `never persists the redacted marker to history` / `… to a saved request` | vitest | 前者：`sanitizeHistoryEntry` 中剥离 `redacted` 的一行删掉；后者：`stripTransientFields` 的解构 `{ id: _id, redacted: _r, ...item }` 改回 `{ id: _id, ...item }` |
| 41 | tabs-history | `opens a legacy entry without headers or params cleanly` | vitest | `entry.requestHeaders?.length` 改 `entry.requestHeaders!.length` |

### 4.2 §30 的锁测试（R5-C1 修订版）

**三轮的失败史，写下来是为了别再走回去。** rev3 断言「外部持锁时命令没返回」——把取锁移到 I/O 之后照样阻塞，全绿。rev4 改断文件字节，但用 `recv_timeout(200ms)` 推断「子线程已读完旧快照」——子线程延迟 250ms 即可让四种坏实现全部通过。rev5 换成 checkpoint + `try_lock`，判定逻辑正确，但 **checkpoint 每次 I/O 都阻塞而协议只放行一次**，而 append/delete/update 都是 read→write 两次 I/O，于是子线程卡在第二次 checkpoint、测试卡在 `join`，**双方永久互等**。我已首手复现该死锁（3 秒未完成），见 0.1(1)。

#### 4.2.1 一次性 checkpoint

在 `read_history_entries` / `write_history_entries` 入口各加一行 `io_checkpoint(...)`。release 下是空的内联函数，编译后消失：

```rust
#[cfg(not(test))]
#[inline(always)]
fn io_checkpoint(_tag: &'static str) {}

#[cfg(test)]
fn io_checkpoint(tag: &'static str) {
    // take() ⇒ 每次安装最多触发一次；命令的第二次 I/O 直接通过，不会再阻塞。
    // 内层 block 保证 slot 的 MutexGuard 在 notify/recv 之前就被释放，
    // 否则子线程驻留期间测试线程碰不到 slot。
    let taken = { checkpoint_slot().lock().unwrap_or_else(|p| p.into_inner()).take() };
    if let Some(cp) = taken {
        let _ = cp.notify.send(tag);
        let _ = cp.resume.recv();
    }
}
```

`take()` 是这条的全部要点：它把「一次性」写进机制本身，而不是靠测试端记得排空。rev5 的实跑脚本正是靠一个额外的排空循环才没死锁，而那个循环没写进正文——0.2 记的就是这件事。

#### 4.2.2 判定四值化，liveness 与锁判定严格分离

```rust
enum Outcome { LockHeld, LockFree, NeverReachedIo, HarnessError }
```

- 测试线程**不持锁**，派生子线程执行命令。
- 对 notify channel 做 `recv_timeout(LIVENESS)`（5s）。**该 timeout 的唯一含义是「命令从未到达 I/O」**（提前返回、panic、不再调 helper），判 `NeverReachedIo`，失败原因记为 liveness，**不得**据此推断任何锁状态。
- 收到通知 ⇒ 子线程正驻留在**第一次** I/O 内部 ⇒ `history_lock().try_lock()`：
  - `Err(WouldBlock)` ⇒ `LockHeld` ⇒ 锁在 I/O 时被持有；
  - `Ok(g)` ⇒ 立即 `drop(g)`，记 `LockFree` ⇒ 取锁发生在 I/O 之后；
  - `Err(Poisoned(_))` ⇒ 记 `HarnessError`（语义上锁**已被取得**、只是中毒，因此不是 `LockHeld`；但它说明上一个 case 的子线程 panic 过，环境不可信）。**窗口内一律不 panic**——rev6 在这里直接 panic，会绕过 resume/join/cleanup，把子线程留在 checkpoint 里继续跑 I/O，污染后续 case。

**边界写死**：锁正确性**只**由 `try_lock` 判定；timeout 只防挂死。`NeverReachedIo` 与 `HarnessError` 都**不是** `LockFree` 的同义词，四值互斥——否则 timeout 会从「防挂死」悄悄爬回「判定依据」，那正是 rev4 栽的地方。

#### 4.2.3 清理与统一断言（失败路径也必须闭合）

```rust
struct Cleanup { resume: Option<Sender<()>>, handle: Option<JoinHandle<()>> }
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(tx) = self.resume.take() { let _ = tx.send(()); }   // 放行仍驻留的子线程
        if let Some(h)  = self.handle.take() { let _ = h.join(); }      // 不留游离线程
        *checkpoint_slot().lock().unwrap_or_else(|p| p.into_inner()) = None;
        history_lock().clear_poison();                                   // 阻断中毒向后传染
    }
}
```

顺序固定为：

1. 安装 checkpoint slot 之后**立即**创建 `Cleanup`——它覆盖 unwind 路径，任何提前返回或 panic 都不会留下驻留的子线程或被占用的全局 slot；
2. 捕获判定到变量，**此窗口内不得出现任何 assert、任何 panic**；
3. `Ok(guard)` 立即 `drop`；
4. `resume.send(())`（从 `Cleanup` 中 `take()` 走，正常路径消费，异常路径由 `Drop` 兜底）；
5. `join` 并**保存** `child_ok = join_result.is_ok()`，不 `unwrap`；
6. `drop(cleanup)`：清空 slot、清除中毒；
7. **清理全部完成后**，才做统一断言。

**统一断言四项**（缺一不可）：

| 断言 | 防的是什么 |
|---|---|
| `verdict == LockHeld` | 锁位点错误（唯一的 lock killer） |
| `child_ok == true` | 命令 panic 却被判定「通过」——rev6 实测可 `EXIT=0` 漏过 |
| 命令返回值符合预期 | 例如 `load_history()` 返回的条目 |
| 终态符合 4.2.4 的表 | 命令语义（播种/合并/删除/清空）写错 |

`verdict` 与 `child_ok` 同时失败时，错误信息必须**同时**报告两者，否则会把「子线程崩了」误读成「锁位点错了」（已实跑：`NoGuard + 完成后 panic` ⇒ `RED [verdict=LockFree + child panicked]`）。

**`child_ok` 的承重用例（构造方式是关键）**：子线程 wrapper 让命令**先跑完**——guard 已随命令返回而释放、终态已是 `[A, N]`、返回值已写入 outcome slot——**然后**才主动 panic：

```rust
fn complete_then_panic(v: V) {
    append(v, "N");                                   // 跑完：终态与返回值都已就绪
    *outcome_slot().lock()… = Some("append completed".into());
    panic!("child panics AFTER the command completed"); // 只塌 child_ok
}
```

这样四项断言里 `verdict` / outcome / 终态**全部通过**，只有 `child_ok` 失败。rev7 的旧 fixture 在 checkpoint 处就 panic，三项同时塌，因此**证明不了** `child_ok` 承重——删掉它用例照样 RED。

**已知的证明缺口（如实记录，不谎称覆盖）**：`verdict` 的承重由主矩阵 36 组证明（那些用例只塌 verdict）；`child_ok` 由上面的用例 + 「移除后转 GREEN」证明；但 **outcome 断言与终态断言目前没有各自的单塌用例**，它们的承重性未经实验证明。实现时若要补，做法同上——构造一个只让该项失败的 fixture，并实跑「移除该断言 ⇒ 转 GREEN」。


#### 4.2.4 五条命令各自的播种与终态

| 命令 | 播种 | checkpoint 落在 | 终态断言 |
|---|---|---|---|
| `append_history(N)` | `[A]` | 首次 read | `[A, N]` |
| `delete_history_entry(A.id)` | `[A, B]` | 首次 read | `[B]`，A 不在 |
| `update_history_entries([A'])` | `[A, B]` | 首次 read | `[A', B]`，B 未被动 |
| `clear_history()` | `[A, B]` | 首次 **write**（该命令不读） | **空** |
| `load_history()` | `[A]` | 首次 read | 返回 `[A]`，文件字节未变 |

`clear_history` 只调 `write_history_entries(&[])`（`lib.rs:2049`），若按 read 等 checkpoint 会永久阻塞——这是 rev4 漏掉、rev5 补上的区分，此处保留。

**终态断言的定位（0.1(3) 的结论，不要误用）**：实测四种变体的终态**完全相同**，因为无竞争时锁放哪都不影响单命令结果。**终态断言不是 lock 变体的 killer**，它只保证命令语义没写错；§30 的杀伤完全来自 4.2.2 的 `try_lock` 那一条。

#### 4.2.5 保留的补充用例（非确定性，如实标注）

`Barrier` 同步两线程、一个 `append_history`、一个 `update_history_entries`，重复 30 轮，断言新行在且旧行是清洗后的版本。有锁必过，无锁高概率失败但**不确定**。仅作端到端补充，**确定性杀伤完全来自 4.2.2**。


### 4.3 §19 的测试形态（为什么「跑两次比较」不够）

实测：把 T1 的正则提到模块作用域后，`redact(x)` 与 `redact(redact(x))` 在**单行、单次**输入上仍可能相等——`exec` 循环命中即 `return`，留下的 `lastIndex` 使后续调用行为取决于**调用顺序**，所以单行幂等断言是顺序相关的、不可靠。有确定性差异的两种形态：

- **多行单次调用**：`"Cookie: sid=abcdef123456\nAuthorization: Bearer tok\npassword: hunter2"` → 正确实现三行全脱敏；模块级正则版本**第二行原样残留**。
- **连续多次调用不同输入**：`["Cookie: a=1", "Authorization: Basic xyz", "password: hunter2"]` 依次调用 → 正确实现三条全脱敏；模块级版本**第二条原样残留**。

两条都断言字面量输出相等。

### 4.4 测试数据

**转义字面量的书写约定（R4-C2 的根因修复）**：本规格与测试中，**`~` 一律代表一个反斜杠字符**。规格文本里不写字面反斜杠转义，测试里也**不得手写** `"\uXXXX"` 这类字面量——必须在运行时构造：

```ts
const B = String.fromCharCode(92)            // 真正的反斜杠，不经任何转义层
const esc = (s: string) => s.split("~").join(B)
const ESCAPED_PASSWORD_KEY = esc(`{"~u0070assword":"hunter2"}`)
```

**理由不是洁癖，是实测**：rev4 的 fixture 在写入规格时反斜杠被吃掉，退化成普通 `password`；我在重建测试脚本时**又被吃了一次**，字节级核对（`od -c`）才发现。探针显示这是系统性的——合法转义（`~u0070`）会被解释成 `p`，非法转义（`~x`）反而原样保留。因此**任何依赖作者手写字面反斜杠的方案都不可靠**。

**每个转义键用例必须先自检 fixture、再断言行为**，否则 fixture 一旦退化，测试会绿着通过而什么都没测：

```ts
expect(ESCAPED_PASSWORD_KEY).toContain(String.fromCharCode(92) + "u0070")  // fixture 自检
expect(redactBodyText("json", ESCAPED_PASSWORD_KEY)).toBe(esc(`{"~u0070assword":"[redacted]"}`))
```

**固定数据**：cookie `sid=abcdef123456; theme=dark`；JWT `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123`；Basic `dXNlcjpwYXNzd29yZA==`；Digest `username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e", uri="/dir/index.html", response=6629fae49393a05397450978507c4ef1`；urlencoded `grant_type=password&password=p&client_secret=xyz`；大整数 `9007199254740993123456789`；深层 `{"a":[{"b":{"clientSecret":"x"}}]}`；非敏感键值 `X-Note` = `password: hunter2`；畸形百分号 `%E0%A4%A` / `pass%word` / `%70assword%ZZ`；legacy 行 `{"key":"Cookie","value":"sessionid=abc123","enabled":true}` + 2026-04-09 时间戳。

**§13 的七条转义键 fixture**（全部经 `esc()` 构造，前四条是 killer、后三条仅覆盖，见 0.1）：`{"~u0070assword":"hunter2"}`、`{"~u0041uthorization":"Basic eHh4"}`、`{"api~/password":"p","n":1}`、`{"pa~xss":"1","password":"y"}`、`{"pass~ud83d~ude00word":"x","password":"y"}`、`{"pa~"ss":"1","token":"t"}`、`{"pa~bssword":"x","cookie":"c"}`。三条路径（redaction / clear / gate）各自断言精确结果。

§11–§21 / §25 一律断言**具体输出字符串相等**，不用 `toContain`（fixture 自检除外）。负例集：§3（三条不该清标记）、§6 §7（该拒与不该拒）、§16 §17（不该脱敏）、§21（规定的过度脱敏）、§24（不该命中的 key）、§31（读失败）、§37（不该降级）、§41（缺字段）。

### 4.5 手工验收（打包版）

组件渲染在 `environment: "node"` 的 vitest 下无法覆盖，本切片**不引入组件测试工具链**；驱动 UI 的状态由 §3 §4 单测锁定，像素部分在打包后的 `/Applications/ApiSolo.app`（WebKit）里验：

1. 发一条带 `Cookie: sid=abcdef123456; theme=dark` 且 JSON body 含 `"password"` 的请求 → 历史面板 → 点开。**期望**：Cookie 行值为空、琥珀色、占位文字「已脱敏，请重新填写」；body 里 `password` 的值为 `""`；提示条同时列出 `Cookie` 与「请求体」。
2. 直接 Send。**期望**：发出（不拦），服务端收到空 Cookie 与空 password；不再出现 `Cookie: [redacted]`。
3. **只切换 Cookie 行的启用勾选**（不动值）。**期望**：琥珀色与提示条**仍在**。再输入字符 → 该行标记消失；再改 body → 提示条消失。
4. 手工加 `X-Test: [redacted]` 并 Send。**期望**：不发出，报错指名 `X-Test`。把该文本放进环境变量 `lit`、字段改 `{{lit}}` 再 Send。**期望**：正常发出。
5. 用户自己的 `history.jsonl`（19 条 2026-04-27 前的明文 Cookie）：**先备份**。启动 → 历史面板 → Console 出现「已清理 N 条…」 → 退出后 `grep -c 'sessionid=' "$HOME/ApiSolo/scratch/history.jsonl"` 为 0 → 再启动，Console 不再出现。（前提已由 owner 实测确认：本机 94 行全部可解析、严格形状检查 0 行不合法。）
6. 打开含 `X-Amz-Signature` 的既有 collection 请求 → 该 header 显示为空 → **不点保存**直接关闭 → 文件字节 / mtime 未变（§33）。
7. 在 raw body 里写一行裸 `Bearer eyJhbGciOiJIUzI1NiJ9.LEAK`，并加一个 header `X-Note: password: hunter2`，发送 → 历史里**两者都原样保留**（§16 / §17 的边界，确认是设计而非回归）。

## 5. Risks and rollback

| 风险 | 影响 | 缓解 |
|---|---|---|
| 删掉内容扫描后，非敏感字段名下的凭据会明文落盘（含普通 header/param 的值） | 中 | owner 裁定的边界，理由是半吊子扫描更危险（1.3(a)）。由 §16 §17 正向锁定 + README/SECURITY 声明（§35）+ 验收步骤 7 确认 |
| span 扫描器是手写 JSON 解析，出错会改坏用户 body | 高 | 只做定位不做重建，失败即抛错降级 text 路径；§11 六行字节保守 + §12 六类型 + 三层递归 + §13 转义键 + 边界变异（`end + 1`）覆盖 |
| 锁的位置错了等于没锁 | 高 | **唯一确定性 killer 是 4.2.2 首次 I/O checkpoint 内的 `try_lock`**：三种错误锁位点（无 guard / guard 在 read 后 / guard 在全部 I/O 后）**由同一条 `LockFree` 断言杀死**，不是各有独立死法。终态断言**不证明锁位点**，只验证命令语义（播种、合并、删除、清空）没写错——实跑四种变体终态完全相同（0.1(3)）|
| §28 回写用既有截断式写盘（`:672`），启动时崩溃可能毁掉历史 | 高 | 只在检测到变化时触发、之后收敛；锁 + merge-by-id 消并发丢写；崩溃原子性归 D03。验收步骤 5 要求先备份 |
| §21 三项过度脱敏会真的丢历史内容 | 中 | 方向安全；三项各有具体输出断言 |
| `json` 敏感字段非字符串值重放时变成 `""` | 中 | PRODUCT §12 显式声明并写进 README |
| Rust 名单扩容改变 collections 行为 | 中 | §33-§35 裁定为产品行为；两条 cargo 测试锁定；D06 用例需回归 |
| 清洗改变 `openHistoryEntry` 匹配空 tab 的判据（`:401-407` 比较 `value`） | 中 | 既有测试 `opens a new tab when method and url match but history snapshots differ` 与 §41 覆盖边界；该逻辑本身的缺陷属 D05，实现者需确认既有 3 条相关测试仍绿 |
| 三个新 util 模块是搬运，可能悄悄改行为 | 中 | 搬运不改逻辑（**`redactValue` 例外，它是重写**）；新测试充当搬运回归网；`vue-tsc --noEmit` 覆盖签名变更 |
| `KeyValuePair` 新字段顺着导出路径漏出 | 低 | §40 覆盖两条路径；`postman-export.ts` / `curl-export.ts` 只读 `key`/`value`/`enabled`，实现者目视确认 |

**回滚**：改动集中在一个 PR。若只回滚存量清洗（§27-§31），单独 revert `src/stores/history.ts` 与 `lib.rs` 的 `update_history_entries` 即可，§1-§26 不依赖它们；**锁必须保留**（它同时保护既有的 `append_history` / `delete_history_entry` / `clear_history`）。已清洗的 `history.jsonl` 不可逆。
