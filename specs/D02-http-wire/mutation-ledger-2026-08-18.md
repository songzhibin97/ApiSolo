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
| `WIRE_PROBE_CONST` | W | 41 | 存活 | — |
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
