# D02 变异台账 — 2026-08-18

跑法：逐个把 mutant 打进真实 `src-tauri/src/lib.rs`，跑**全套** `cargo test --lib`，
记录完整杀伤集合，再还原。全套而非只跑目标用例，是为了保留连带杀伤信息——
规格阶段最有价值的几条发现都来自连带杀伤。

**层标注**：`H` = 变异打在 helper 内部；`W` = 变异打在生产调用点。
这一列是本台账的重点：helper 内部全红**不能**推出「实现已被验证」（P8 / P10）。

**判据（P12）**：必须在输出里正向匹配到 `test result: … N passed; M failed`
且 `N+M > 0`，否则记 `INCONCLUSIVE`，绝不退化成 `SURVIVED`。
本台账的第一版因为 `rustc` 从 PATH 解析到 Homebrew 1.87、每次编译失败，
产出 57 行假 `SURVIVED`——那是一个真实的度量，度量的是一个坏掉的脚本。
harness 修好后先用一个已知必红的 mutant（`KNUL`）验证自身。

## 进度：34/62  —  RED 33 / SURVIVED 1 / INCONCLUSIVE 0

| mutant | 层 | § | 结论 | 杀死的用例 |
|---|---|---|---|---|
| `K1` | H | §9 | RED | `test_plan_content_encoding_table` |
| `K2` | H | §9 | RED | `test_plan_content_encoding_table` |
| `K3` | H | §9,12 | RED | `test_identity_or_absent_encoding_is_not_decompressed`, `test_plan_content_encoding_table` |
| `K4` | H | §9 | RED | `test_plan_content_encoding_table` |
| `K5` | H | §9 | RED | `test_plan_content_encoding_table` |
| `K6` | H | §9 | RED | `test_plan_content_encoding_table` |
| `K7` | H | §9 | RED | `test_e2e_api_key_auth_header`, `test_e2e_api_key_auth_query`, `test_e2e_basic_auth`, `test_e2e_bearer_auth`, `test_e2e_binary_body`, `test_e2e_form_data_file_part`, `test_e2e_form_urlencoded`, `test_e2e_full_workflow_with_mock_server`, `test_e2e_query_params`, `test_empty_response_body_is_empty_text`, `test_identity_or_absent_encoding_is_not_decompressed`, `test_plan_content_encoding_table`, `test_send_request_post_json`, `test_send_request_real_http` |
| `K8` | H | §9 | RED | `test_plan_content_encoding_table`, `test_undecodable_encoding_is_kept_raw_and_marked_binary` |
| `KCASE` | H | §5 | RED | `test_content_encoding_token_case_and_whitespace` |
| `KXGZIP` | H | §6 | RED | `test_content_encoding_x_gzip_alias` |
| `KI1` | H | §10 | RED | `test_non_utf8_content_encoding_is_undecodable` |
| `KDEFLATE` | H | §4 | RED | `test_decompress_raw_deflate_stream` |
| `KMULTIGZ` | H | §7 | RED | `test_decompress_multi_member_gzip` |
| `KDROPHDR` | H | §8 | RED | `test_decoded_response_drops_encoding_headers` |
| `KFORCEBIN` | H | §11 | RED | `test_undecodable_encoding_is_kept_raw_and_marked_binary` |
| `KLIMIT_GE` | H | §14 | RED | `test_decompressed_body_at_the_limit_succeeds` |
| `KLIMIT_DEL` | H | §15 | RED | `test_decompressed_body_over_the_limit_is_rejected` |
| `KENC_IGNORE` | H | §17 | RED | `test_response_charset_is_honored` |
| `KCHARSET_EQ` | H | §18 | RED | `test_charset_parameter_parsing` |
| `KCHARSET_SUB` | H | §18 | RED | `test_charset_parameter_parsing` |
| `KDEFAULT_1252` | H | §19,20 | RED | `test_decompress_brotli_response_body`, `test_decompress_deflate_zlib_response_body`, `test_decompress_gzip_response_body`, `test_finalize_response_body_is_runtime_independent`, `test_response_without_charset_decodes_as_utf8`, `test_undecodable_bytes_are_reported_as_binary`, `test_unrecognized_charset_label_falls_back_to_utf8` |
| `KLOSSY` | H | §21 | RED | `test_undecodable_bytes_are_reported_as_binary` |
| `KNUL` | H | §22 | RED | `test_response_with_nul_byte_is_binary` |
| `KSIZE` | H | §24 | RED | `test_response_size_is_post_decompression_byte_count` |
| `KCT_FORMDATA` | H | §25 | RED | `test_form_data_sends_single_content_type_with_real_boundary` |
| `KCT_KEEPLAST` | H | §26,27 | RED | `test_form_urlencoded_keeps_user_content_type`, `test_json_body_keeps_user_content_type` |
| `KRAW_CT` | H | §28 | RED | `test_raw_body_adds_no_content_type` |
| `KAUTH_FIRST` | H | §29 | RED | `test_bearer_auth_replaces_manual_authorization_header` |
| `KAUTH_GUARD` | H | §30 | RED | `test_auth_none_keeps_every_manual_authorization_header` |
| `KAPIKEY` | H | §31 | SURVIVED | — |
| `KJSON_VALUE` | H | §32 | RED | `test_json_body_is_sent_verbatim` |
| `KJSON_VALID` | H | §33 | RED | `test_invalid_json_body_is_rejected_before_sending` |
| `KCHAIN` | H | §34 | RED | `test_body_read_error_includes_cause_chain`, `test_format_error_chain_joins_every_source`, `test_transport_error_includes_cause_chain` |
| `KBODYERR` | W | §35 | RED | `test_body_read_error_includes_cause_chain` |

## 未跑完

批次 3（32–45）与批次 4（45–57，全部 W 层生产调用点）尚在进行。
本文件随批次追加提交，断连不会丢已跑完的部分。
