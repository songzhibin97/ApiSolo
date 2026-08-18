# D02 变异台账 — 2026-08-18

## 跑法与判据

逐个把 mutant 打进真实 `src-tauri/src/lib.rs`，跑**全套** `cargo test --lib`（串行），
记录完整杀伤集合再还原。跑全套而非只跑目标用例，是为了保留连带杀伤信息——
本切片最有价值的几条发现全部来自连带杀伤。

**层标注**：`H` = 变异打在 helper 内部；`W` = 变异打在生产调用点。
这一列是本台账的重点。helper 内部全红**推不出**「实现已被验证」：helper 可以写得完美、
测得完美，而生产路径根本没调用它（P8）。

**判据（P12）**：必须在输出里正向匹配到 `test result: … N passed; M failed` 且 `N+M > 0`；
匹配不到、或失败计数与解析出的失败用例数不一致，一律记 `INCONCLUSIVE`，**绝不退化成 `SURVIVED`**。
本台账第一版因 `rustc` 从 PATH 解析到 Homebrew 1.87、每次编译失败，产出 57 行假 `SURVIVED`；
那是一个真实的度量，度量的是一个坏掉的脚本。harness 修好后先用一个已知必红的 mutant
（`KNUL`）验证自身，再开跑。

## 结果：57 个 mutant

| 三态 | 数量 | 含义 |
|---|---|---|
| **VERIFIED** | **52** | 本轮真的跑了，且确实变红 |
| **DESIGNED** | **0** | 写了 patch 但没跑（无） |
| **INCONCLUSIVE** | **0** | 找不到「确实执行了」的正向证据 |
| 存活 | 5 | 跑了、没红——覆盖缺口，逐条列在下方 |

按层：H（helper 内部）43 个，其中 RED 43；
W（生产调用点）14 个，其中 RED 9、存活 5。

## 明细

| mutant | 层 | § | 三态 | 杀死的用例 |
|---|---|---|---|---|
| `K1` | H | 9 | VERIFIED | `test_plan_content_encoding_table` |
| `K2` | H | 9 | VERIFIED | `test_plan_content_encoding_table` |
| `K3` | H | 9,12 | VERIFIED | `test_identity_or_absent_encoding_is_not_decompressed`, `test_plan_content_encoding_table` |
| `K4` | H | 9 | VERIFIED | `test_plan_content_encoding_table` |
| `K5` | H | 9 | VERIFIED | `test_plan_content_encoding_table` |
| `K6` | H | 9 | VERIFIED | `test_plan_content_encoding_table` |
| `K7` | H | 9 | VERIFIED | `test_e2e_api_key_auth_header`, `test_e2e_api_key_auth_query`, `test_e2e_basic_auth`, `test_e2e_bearer_auth`, `test_e2e_binary_body`, `test_e2e_form_data_file_part`, `test_e2e_form_urlencoded`, `test_e2e_full_workflow_with_mock_server`, `test_e2e_query_params`, `test_empty_response_body_is_empty_text`, `test_identity_or_absent_encoding_is_not_decompressed`, `test_plan_content_encoding_table`, `test_send_request_post_json`, `test_send_request_real_http` |
| `K8` | H | 9 | VERIFIED | `test_plan_content_encoding_table`, `test_undecodable_encoding_is_kept_raw_and_marked_binary` |
| `KCASE` | H | 5 | VERIFIED | `test_content_encoding_token_case_and_whitespace` |
| `KXGZIP` | H | 6 | VERIFIED | `test_content_encoding_x_gzip_alias` |
| `KI1` | H | 10 | VERIFIED | `test_non_utf8_content_encoding_is_undecodable` |
| `KDEFLATE` | H | 4 | VERIFIED | `test_decompress_raw_deflate_stream` |
| `KMULTIGZ` | H | 7 | VERIFIED | `test_decompress_multi_member_gzip` |
| `KDROPHDR` | H | 8 | VERIFIED | `test_decoded_response_drops_encoding_headers` |
| `KFORCEBIN` | H | 11 | VERIFIED | `test_undecodable_encoding_is_kept_raw_and_marked_binary` |
| `KLIMIT_GE` | H | 14 | VERIFIED | `test_decompressed_body_at_the_limit_succeeds` |
| `KLIMIT_DEL` | H | 15 | VERIFIED | `test_decompressed_body_over_the_limit_is_rejected` |
| `KENC_IGNORE` | H | 17 | VERIFIED | `test_response_charset_is_honored` |
| `KCHARSET_EQ` | H | 18 | VERIFIED | `test_charset_parameter_parsing` |
| `KCHARSET_SUB` | H | 18 | VERIFIED | `test_charset_parameter_parsing` |
| `KDEFAULT_1252` | H | 19,20 | VERIFIED | `test_decompress_brotli_response_body`, `test_decompress_deflate_zlib_response_body`, `test_decompress_gzip_response_body`, `test_finalize_response_body_is_runtime_independent`, `test_response_without_charset_decodes_as_utf8`, `test_undecodable_bytes_are_reported_as_binary`, `test_unrecognized_charset_label_falls_back_to_utf8` |
| `KLOSSY` | H | 21 | VERIFIED | `test_undecodable_bytes_are_reported_as_binary` |
| `KNUL` | H | 22 | VERIFIED | `test_response_with_nul_byte_is_binary` |
| `KSIZE` | H | 24 | VERIFIED | `test_response_size_is_post_decompression_byte_count` |
| `KCT_FORMDATA` | H | 25 | VERIFIED | `test_form_data_sends_single_content_type_with_real_boundary` |
| `KCT_KEEPLAST` | H | 26,27 | VERIFIED | `test_form_urlencoded_keeps_user_content_type`, `test_json_body_keeps_user_content_type` |
| `KRAW_CT` | H | 28 | VERIFIED | `test_raw_body_adds_no_content_type` |
| `KAUTH_FIRST` | H | 29 | VERIFIED | `test_bearer_auth_replaces_manual_authorization_header` |
| `KAUTH_GUARD` | H | 30 | VERIFIED | `test_auth_none_keeps_every_manual_authorization_header` |
| `KAPIKEY` | H | 31 | VERIFIED | `test_api_key_header_replaces_a_manual_row_of_the_same_name` |
| `KJSON_VALUE` | H | 32 | VERIFIED | `test_json_body_is_sent_verbatim` |
| `KJSON_VALID` | H | 33 | VERIFIED | `test_invalid_json_body_is_rejected_before_sending` |
| `KCHAIN` | H | 34 | VERIFIED | `test_body_read_error_includes_cause_chain`, `test_format_error_chain_joins_every_source`, `test_transport_error_includes_cause_chain` |
| `KBODYERR` | W | 35 | VERIFIED | `test_body_read_error_includes_cause_chain` |
| `KSENDERR` | W | 34 | VERIFIED | `test_transport_error_includes_cause_chain` |
| `KFIRST` | H | 37 | VERIFIED | `test_connect_first_reachable_gives_each_address_a_share`, `test_connect_first_reachable_tries_every_address` |
| `KFAIR` | H | 38 | VERIFIED | `test_connect_first_reachable_gives_each_address_a_share`, `test_per_attempt_budget_is_shared_fairly` |
| `KZERO` | H | 39 | VERIFIED | `test_connect_first_reachable_stops_when_budget_is_exhausted` |
| `KPROBE_TO` | H | 40 | VERIFIED | `test_probe_budget_covers_the_whole_probe` |
| `KPROBE_BUDGET` | H | 41 | VERIFIED | `test_probe_budget_never_exceeds_the_overall_remaining` |
| `KBUDGET` | H | 43 | VERIFIED | `test_execute_request_with_zero_budget_sends_nothing`, `test_exhausted_budget_is_rejected` |
| `KDECODE_TO` | H | 44 | VERIFIED | `test_decode_over_budget_fails_at_the_deadline` |
| `KSUM` | H | 45 | VERIFIED | `test_build_timings_uses_measured_total_not_the_sum` |
| `KTLS` | H | 47 | VERIFIED | `test_build_timings_keeps_tls_and_ttfb_zero` |
| `KQUERY` | H | 48 | VERIFIED | `test_request_target_has_no_trailing_question_mark` |
| `WIRE_NOCHECK` | W | 43 | VERIFIED | `test_execute_request_with_zero_budget_sends_nothing`, `test_request_timeout_is_taken_from_the_remaining_budget` |
| `WIRE_CONST` | W | 42 | VERIFIED | `test_request_timeout_is_taken_from_the_remaining_budget` |
| `WIRE_NOTIMEOUT` | W | 42 | VERIFIED | `test_request_timeout_is_taken_from_the_remaining_budget` |
| `WIRE_NONORM` | W | 25,26,27,29,30 | VERIFIED | `test_bearer_auth_replaces_manual_authorization_header`, `test_form_data_sends_single_content_type_with_real_boundary`, `test_form_urlencoded_keeps_user_content_type`, `test_json_body_keeps_user_content_type` |
| `WIRE_NOFINISH` | W | 42,43 | VERIFIED | `test_bearer_auth_replaces_manual_authorization_header`, `test_execute_request_with_zero_budget_sends_nothing`, `test_form_data_sends_single_content_type_with_real_boundary`, `test_form_urlencoded_keeps_user_content_type`, `test_json_body_keeps_user_content_type` |
| `WIRE_DEADLINE_CONST` | W | 42,43 | VERIFIED | `test_execute_request_honours_a_small_budget`, `test_execute_request_with_zero_budget_sends_nothing` |
| `WIRE_PROBE_CONST` | W | 41 | **重分类：缺陷，非缺口** | — （见文末修订：补丁为语义空操作，掩盖了一个已发布的 bug）|
| `WIRE_DECODE_BYPASS` | W | 44 | 存活 | — |
| `WIRE_DECODE_NOCHECK` | W | 44 | 存活 | — |
| `WIRE_NOBLOCKING` | W | 49 | 存活 | — |
| `WIRE_TOVEC_OUTSIDE` | W | 44 | 存活 | — |
| `WIRE_BUILDURL` | W | 48 | VERIFIED | `test_e2e_api_key_auth_query`, `test_request_target_has_no_trailing_question_mark` |


## 五个存活的 mutant —— 全部在 W 层（生产调用点）

没有一个是 helper 内部的。它们都是同一形状：**helper 本身被证明了，「它有没有被接上」没有。**

| mutant | § | 对应缺口 | 是否预期 |
|---|---|---|---|
| `WIRE_DECODE_BYPASS` 绕过 `run_decode_within_budget` 直接 await | 44 | `TECH.md` §4.3 缺口 **#4** | **预期**，冻结前已登记 |
| `WIRE_DECODE_NOCHECK` 删掉解码前的预算检查 | 44 | 同 #4 的同一处接线 | **预期** |
| `WIRE_PROBE_CONST` 把常量而非 `probe_budget(...)` 传给探测 | 41 | `TECH.md` §4.3 缺口 **#5** | **预期**，冻结前已登记 |
| `WIRE_NOBLOCKING` 解码内联执行、不进 `spawn_blocking` | 49 | `TECH.md` §4.3 §49 那一条 | **预期**，冻结前已登记 |
| `WIRE_TOVEC_OUTSIDE` 把 `bytes.to_vec()` 挪到 timeout 之外 | 44 | **未登记** | **计划外**，见下 |

### `WIRE_TOVEC_OUTSIDE` 是一条新缺口，需要补登记

它对应的是评审 R4-C1② 要求的那处修复：把响应体的完整拷贝移进受 timeout 包裹的 `spawn_blocking`，
因为原始响应字节没有上限、拷贝耗时由远端控制。修复本身做了，**但没有任何用例能区分做没做**——
要区分就得让一次 `to_vec()` 慢到撞破预算，而那需要一个远端可控的巨大响应体，既重又脆。

评审检查点：`bytes` 必须是 `move` 进 `spawn_blocking` 闭包的，`to_vec()` 必须写在闭包**内部**。

## 真实杀伤集合 > 模型杀伤集合

规格阶段的 mutant 跑在仓库外的模型 crate 上。落到真实 `lib.rs` 后，**多条 mutant 的杀伤集合明显变大**，
而且方向是单向的——没有一条在真实代码上比模型上杀得少。

| mutant | 模型上 | 真实代码上 | 多出来的是什么 |
|---|---|---|---|
| `K7` 空 token 列表→`Undecodable` | 1 条（`plan_table` 的三行） | **14 条** | 8 条与压缩无关的既有 e2e。因为「没有 `Content-Encoding` 头」是绝大多数请求的常态，这条分支是主干而非边界 |
| `KDEFAULT_1252` 默认编码→windows-1252 | 3 条 | **7 条** | 三个解压 e2e + `finalize_response_body_is_runtime_independent`。模型没有解压路径，看不到「解压出来的 UTF-8 正文被按单字节编码解掉」这层耦合 |
| `KCHAIN` 只输出最外层 Display | 1 条 | **3 条** | 两条集成用例。模型里没有真实 `reqwest::Error` |
| `KBUDGET` 删 `is_zero` 分支 | 2 条 | 2 条 | 一致 |
| `KFAIR` / `KFIRST` | **杀伤集合完全相同** | **不同** | 真实代码里 §37 与 §38 可区分：`KFIRST` 杀 `tries_every_address`+`gives_each_address_a_share`，`KFAIR` 杀 `gives_each_address_a_share`+`per_attempt_budget_is_shared_fairly` |

**给后续切片的结论**：规格阶段在模型 crate 上跑出来的杀伤集合**系统性地低估真实耦合**。
模型能回答「这个测试形状抓不抓得住这个缺陷形状」，回答不了「这个缺陷在真实代码里会波及多少」。
`KFAIR`/`KFIRST` 那一行还说明它可以在**两个方向**上错——模型上看起来重合的两条不变式，
真实代码里其实是可区分的，于是规格里「它们并不正交」的结论在实现后需要撤回。

## 台账抓到的一个实现缺口

`KAPIKEY`（§31，`header_map.insert` → `append`）**第一轮存活**。

原因：既有的 `test_e2e_api_key_auth_header` 只用 wiremock 的 `header()` 匹配器加 `status == 200`，
从不断言该头**有几个值**；用例里用户没有手写同名头，所以 `insert` 与 `append` 产出完全一样。
冻结规格 `TECH.md` §4.1 的 §31 行明写「扩充既有用例，加『恰好一个值』断言」，实现时被跳过了。

已补 `test_api_key_header_replaces_a_manual_row_of_the_same_name`：用户手写一行同名头 +
Auth 面板同时设值，于是 `insert`（1 个值）与 `append`（2 个值）可区分。重跑该 mutant：**RED**。

这是本台账唯一一条「测试存在、覆盖率真实、唯一没被证明的恰恰是它要区分的那件事」。

---

# 评审 R1 后的修订（2026-08-18，晚）

## 一条分类被推翻：`WIRE_PROBE_CONST` 不是缺口，是 bug

本台账原先写：

> `WIRE_PROBE_CONST` 把常量而非 `probe_budget(...)` 传给探测 —— 存活 —— 预期，冻结前已登记（缺口 #5）

**这条分类是错的。** 独立评审逐行追参数流后发现：调用点算了预算并传进 `measure_connection_timings`，
但那个预算只到达外层 timeout；真正干活的 `probe_connection` **根本不接收预算**，
地址循环里写死 `CONNECTION_PROBE_MAX`。预算在三行之间确定性丢失。

后果正落在这条切分存在的意义上：总预算剩 2 秒、解析到两个地址时，
第一个地址仍按常量拿到 2.5 秒份额，外层 2 秒 timeout 先到，**第二个地址永远没有机会被尝试**。

而那个 mutant 之所以存活，是因为**它把「传常量」打进了一份本来就在传常量的代码里**——
补丁在语义上是空的。而且在全部用例里 `probe_budget(...)` 恰好等于 `CONNECTION_PROBE_MAX`
（预算总是 30 秒，`min(5s, 30s) == 5s`），所以连外层 timeout 都没有差别。

**已修**：预算穿透到 `probe_connection`，DNS 耗时从同一份预算里扣，剩余部分再按地址公平切分。
新增 `test_probe_connection_hands_the_callers_budget_to_the_addresses`，注入 connect 步骤、
断言每个地址实际拿到的预算。把原缺陷重新打回去：**恰好该一条用例变红，其余全绿**。

## 这是一个此前没有枚举过的失败形态

变异台账的价值主张是「存活 ⇒ 那段代码没被测到」。存在第三种可能：

> **存活 ⇒ 补丁是空操作 ⇒ 生产代码已经具有该 mutant 的行为 ⇒ 那不是缺口，那是 bug。**

**光看 `SURVIVED` 这个信号区分不了这三种**，必须去看补丁到底改变了什么。
本轮之所以发现，靠的是独立评审逐行读参数流，不该依赖运气。

harness 已加 P14 守卫：拒绝运行 patch 为空、锚点不唯一、或写回后文件未变的 mutant，
这类情况打印 `REFUSED(...)` 而不是产生任何三态结论。

## 另外四个存活已按同一把尺子复查

逐个确认**生产代码并不具有该 mutant 的行为**，即补丁确实改变了语义：

| mutant | 生产代码现状（行号为复查时） | 结论 |
|---|---|---|
| `WIRE_DECODE_BYPASS` | `run_decode_within_budget(decode_budget, decode)` 确实在调用链上（`:2635`） | 真缺口，非空补丁 |
| `WIRE_DECODE_NOCHECK` | `ensure_budget_remaining(...)` 确实在 spawn 之前（`:2619`） | 真缺口，非空补丁 |
| `WIRE_NOBLOCKING` | `spawn_blocking` 确实包着解码（`:2626`） | 真缺口，非空补丁 |
| `WIRE_TOVEC_OUTSIDE` | `bytes` 确实 move 进闭包、`to_vec()` 确实在闭包内（`:2627`） | 真缺口，非空补丁（owner 已独立核过源码） |

四条都是「补丁改变语义、但没有任何用例能观察到」，与 `WIRE_PROBE_CONST` 的形态**不同**。

## 九条补强断言的单塌验证

评审指出八处「断言存在、但删掉被测的东西依然绿」。逐条补强后，用评审自己的变异复跑，
每一条都**恰好只让一条用例变红**（单塌，P9）：

| 变异 | 层 | § | 变红的用例 |
|---|---|---|---|
| 空 JSON 内容改为参与解析 | W | 33 | `test_json_body_that_is_only_whitespace_sends_no_body` |
| `Undecodable` 分支返回空 `Vec` | H | 11 | `test_undecodable_encoding_preserves_the_original_bytes_and_length` |
| 解码错误丢掉底层原因 | H | 13 | `test_corrupt_stream_error_carries_the_underlying_cause` |
| 剥掉用户提供的 `Accept-Encoding` | W | 16 | `test_user_supplied_accept_encoding_is_sent_unchanged` |
| 生产路径不把 Content-Type 传给解码器 | W | 17 | `test_declared_charset_is_honoured_through_the_request_path` |
| binary body 自动加 Content-Type | H | 28 | `test_binary_and_none_bodies_add_no_content_type` |
| basic 不参与 Authorization 收敛 | H | 29 | `test_basic_auth_replaces_a_manual_authorization_header` |
| api-key 也参与 Authorization 收敛 | H | 30 | `test_api_key_mode_leaves_a_manual_authorization_header_alone` |
| 地址循环忽略调用方预算（**已发布的缺陷**） | H | 38,41 | `test_probe_connection_hands_the_callers_budget_to_the_addresses` |

其中「api-key 也参与收敛」**第一次仍然存活**：补强后的用例只放了**一行**手写 `Authorization`，
而 keep-last 把 1 个值收敛成 1 个值是不可观察的——与最初 `KAPIKEY` 逃脱的是同一个陷阱，
在同一轮里又犯了一次。改成两行后变红。

## 映射表里一个不存在的测试名

`TECH.md` 提到 59 个不同测试名，其中 **`test_execute_flow_attaches_the_remaining_budget` 在仓库中不存在**。
它是规格 §4.6 里**模型 crate** 的接线用例名，从未移植到真实代码；
真实代码里的对应物是 `test_request_timeout_is_taken_from_the_remaining_budget`（存在且通过）。
规格已冻结，此处只记录，不擅改。

## 修订后的计数

| 三态 | 数量 |
|---|---|
| VERIFIED | 60（原 52 + 本轮 9，减去 `WIRE_PROBE_CONST` 由「存活」重分类） |
| DESIGNED | 0 |
| INCONCLUSIVE | 0 |
| 存活（真缺口） | 4 |
| **重分类为缺陷** | **1**（`WIRE_PROBE_CONST`） |

测试数：main 基线 81 → 本切片 142。

---

## 收尾清单 —— 必须实跑，回填真实名单，不打勾

这张清单的存在理由：本轮我在**同一轮里两次**踩了同一个陷阱——
`KAPIKEY` 因为「用例里只有一行同名 header，收敛 1→1 不可观察」而存活；
补强 api-key 那条断言时，我又写了一个只有一行 `Authorization` 的用例，**再次存活**。
中间我已经把这个形态写进了提交信息。**「记住教训」这个机制拦不住它**，
能拦住的只有收尾时的机械动作。

规则：每一条声称「单塌」的断言，收尾时回填**它实际杀死的用例名单**。

- 名单里出现**第二个名字** ⇒ 不是单塌，该断言没有被单独证明
- 名单**为空** ⇒ 没跑，或补丁是空操作（P14）
- **只允许回填名单，不允许打勾**——勾可以在动作之前打，名单不行

### 本轮回填（来源：`/tmp/d02_verify.py` 实跑输出）

| 声称单塌的断言 | 施加的变异 | 实际杀死的用例名单 | 判定 |
|---|---|---|---|
| §33 空 JSON 按无 body 处理 | 空内容改为参与解析 | `test_json_body_that_is_only_whitespace_sends_no_body` | 单塌 ✓ |
| §11 原始字节与长度保留 | `Undecodable` 分支返回空 `Vec` | `test_undecodable_encoding_preserves_the_original_bytes_and_length` | 单塌 ✓ |
| §13 错误带底层原因 | 解码错误丢掉 `{error}` | `test_corrupt_stream_error_carries_the_underlying_cause` | 单塌 ✓ |
| §16 用户的 Accept-Encoding 保留 | 剥掉该头 | `test_user_supplied_accept_encoding_is_sent_unchanged` | 单塌 ✓ |
| §17 生产路径传 Content-Type | 调用点改传空串 | `test_declared_charset_is_honoured_through_the_request_path` | 单塌 ✓ |
| §28 binary/none 不加 Content-Type | binary 分支加该头 | `test_binary_and_none_bodies_add_no_content_type` | 单塌 ✓ |
| §29 basic 参与 Authorization 收敛 | 守卫去掉 `basic` | `test_basic_auth_replaces_a_manual_authorization_header` | 单塌 ✓ |
| §30 api-key 不参与收敛 | 守卫加上 `api-key` | 第一次：**（空）** ／ 修正用例后：`test_api_key_mode_leaves_a_manual_authorization_header_alone` | **第一次失败**，见下 |
| §38/§41 地址循环用调用方预算 | 循环改回常量（已发布缺陷） | `test_probe_connection_hands_the_callers_budget_to_the_addresses` | 单塌 ✓ |

**第八行是这张清单当场抓到的东西。** 名单为空意味着那条补强断言当时并没有承重；
原因是用例只放了一行手写 `Authorization`，keep-last 收敛 1→1 不可观察。
改成两行后名单才出现。若没有「回填名单」这个动作，它会以「已补强」的姿态混过去——
和它要修的那个 `KAPIKEY` 缺陷一模一样。

### 下次收尾还要跑的两条

- 合并到 main 之后确认 `exportPostmanCollection treats a Rust-blanked file field as having no in-memory content` 这条前端回归测试**确实存在**（它随 PR #15 进入 main，本分支从更早的 `c9221d3` 切出，因此当前树内没有它）。回填的是**测试总数**，不是勾。
- 变异 harness 每次开跑前，先用一个**已知必红**的 mutant 验证 harness 自身，回填它杀死的用例名。本轮用的是 `KNUL`。
