# D02 — HTTP 报文正确性 · 技术方案

> **rev7 — 冻结前文本修正**（在 rev6 的基础上只做 R6 指定的五处文本修正，无设计改动）。以下为 rev6 记录：
> **rev6 — 应 R5 修订**（R5 裁定 REVISE，1C + 3I + 3M，全部采纳）。逐条落点：
> **C**（`KWIRE3` 只证明模型接线）→ 选**方案 1（诚实降级）**，理由见 §2.6.4；删除「预算读取位置已自动化证明」的声明与 ✅，登记进 §4.3 缺口 #6；同时把 build+归一化+读预算+设超时收进 `finish_request_with_deadline` 一个小函数以收紧评审检查点。
> **I1**（计时起点自相矛盾）→ 写死：`execute_request` 只做一行委派，`overall_started_at` / `overall_deadline` 在 `execute_request_with_budget` 的第一行，见 §3.2(6)。
> **I2**（`KBUDGET` mutant 不忠实）→ 已改成忠实的单行删除并**重跑**：真实杀伤集合是 **2 条**（`exhausted_budget_is_rejected` + `execute_flow_does_not_send_when_budget_is_exhausted`），rev5 写的「4 条」撤回。新增 §4.7「mutant 忠实性审计」。
> **I3**（解码前检查删早了）→ **恢复**，且位置在 `spawn_blocking` **创建之前**，见 §2.6.2 与 §3.2(9)。
> **M1 / M2** → PRODUCT §41 措辞拆分；§4.6 未执行清单补齐。
> 不变式条数不变：**49 条**。

行为定义见 `specs/D02-http-wire/PRODUCT.md`，本文不重复。下文 `§n` 均指该文件 `## Behavior` 的编号。

## 1. Context

### 1.1 当前实现

唯一的 HTTP 发送路径是 `send_request`（`src-tauri/src/lib.rs:2225`）→ `execute_request`（`:2249`）。Tauri 命令与 dev bridge（`api_send_request`，`:2915` → `sanitize_dev_bridge_request_args`，`:2603`）共用它，所以改一处即覆盖两条入口。

关键行号（全部实读确认）：

| 位置 | 现状 |
|---|---|
| `lib.rs:2250-2253` | `Client::builder()` 链：`redirect(limited(10))` + `timeout(30s)` + `.no_proxy()` |
| `lib.rs:2255-2273` | 仅当 Settings 显式启用时才 `.proxy(...)` |
| `lib.rs:2288` | `Url::parse(&args.url)` |
| `lib.rs:2290-2299` | **无条件**进入 `url.query_pairs_mut()` 块，之后才 filter 参数 |
| `lib.rs:2301-2309` | api-key 投放 query 的分支，**已有** `!api_key.key.trim().is_empty()` 守卫 |
| `lib.rs:2311-2322` | 用户 header 逐条 `header_map.append(...)` |
| `lib.rs:2324-2335` | api-key 投放 header，用 `header_map.insert(...)`（覆盖语义） |
| `lib.rs:2337-2341` | `measure_connection_timings(&url).await?` — `?` 把探测失败升级成请求失败 |
| `lib.rs:2342` | `client.request(method, url).headers(header_map)` |
| `lib.rs:2344-2363` | auth 分支：`request.basic_auth(...)` / `.bearer_auth(...)` |
| `lib.rs:2365-2404` | body 分支（含 base64 解码、multipart 拼装等**本地准备**工作） |
| `lib.rs:2406-2410` | `request.send().await.map_err(...)` → `format!("Request failed: {error}")` |
| `lib.rs:2412-2429` | 从响应头取 status / content_type / headers 列表 |
| `lib.rs:2430-2438` | `download_started_at` → `response.bytes()` → `total = dns + tcp + started_at.elapsed()` |
| `lib.rs:2439-2440` | `size = bytes.len()`；`body = String::from_utf8_lossy(&bytes)` |
| `lib.rs:2461-2463` | `should_measure_connection_timings`：启用代理时返回 false |
| `lib.rs:194-228` | `measure_connection_timings`：`to_socket_addrs` → `addrs.first()` → 无超时的 `tokio::net::TcpStream::connect` → 两处 `?` |
| `lib.rs:230-241` | `HttpResponse`，`body: String` |

全文件核查：`grep -n "from_utf8_lossy\|charset\|content-encoding\|gzip\|deflate\|brotli\|zstd\|accept-encoding" src-tauri/src/lib.rs` 只命中 `:2440` 一行。前端同样零命中。**后端不存在任何字符集或压缩处理代码。**

`lib.rs:2435-2437` 的 `total` 是 `dns_lookup + tcp_connect + started_at.elapsed()`，即**由分段合成**，而 `started_at`（`:2406`）在探测之后才取——这是 §45 要修的洞。`lib.rs:2252` 的 30 秒是 client 级 timeout，**只覆盖 reqwest 那一段**，探测与解码都在它之外——这是 §41 要修的洞。

### 1.2 依赖现状（实读 `Cargo.toml` / `Cargo.lock` / 本机 vendored 源码 / crates.io API）

- `src-tauri/Cargo.toml:29`：`reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "multipart", "socks"] }` —— 没有 `gzip` / `brotli` / `deflate` / `zstd`，也没有 `charset`。`Cargo.lock:3320` 解析为 reqwest 0.12.28。
- `src-tauri/Cargo.toml:32`：直接声明的 tokio features 是 `["rt-multi-thread", "macros", "sync", "net"]`，**没有 `time`**；但 `reqwest-0.12.28/Cargo.toml:358-364` 对非 wasm 目标声明 `tokio = { features = ["net", "time"] }`，经 Cargo feature 合一，`time` 在当前依赖图里其实是开着的。见 §1.3 第 7 条。tokio 解析为 1.50.0（`Cargo.lock:4497`），其 `Cargo.toml:132` 有 `test-util` feature。
- `src-tauri/Cargo.toml:38`：`tower-http = { version = "0.6", features = ["cors"] }`（0.6.8）。
- `Cargo.lock:302` 已有 `brotli 8.0.2`、`:313` 已有 `brotli-decompressor 5.0.0`、`:1041` 已有 `flate2 1.1.9`、`:2357` 已有 `miniz_oxide 0.8.9`、`:454` 已有 `cfg-if 1.0.4`。`brotli` 是 `tauri-utils`（`Cargo.lock:4324`）的**运行期**依赖，已编译进产物；`flate2` 只经由 `png` → `tauri-codegen` 出现在构建依赖链上。
- **`encoding_rs` 不在 `Cargo.lock` 里**，是本切片**唯一真正新增**的 crate。**缓存状态（rev5 更正，R4-M1）**：锁文件尚未包含它，但**当前评审/开发机的 registry 里已经有 `encoding_rs-0.8.35` 的源码与 `.crate`**（`flate2-1.1.9`、`brotli-decompressor-5.0.0` 同样已缓存），所以在这台机器上 `cargo build` 不需要联网；**干净环境（CI、新克隆）仍需要一次 `cargo fetch`**。rev4 写的「不在本机缓存里」已过时。crates.io API 实查：最新版 `0.8.35`，唯一非可选 normal 依赖是 `cfg-if ^1.0`（`any_all_workaround` 与 `serde` 均 optional，默认关闭）。R3 已实测确认：`Cargo.lock` 恰好 **+12 行、0 删除、只新增 `encoding_rs 0.8.35` 一个包**。
- `reqwest-0.12.28/src/async_impl/request.rs:291` 提供 `RequestBuilder::timeout(Duration)`。**文档明确其覆盖范围是「从开始建连到响应体读完」（`request.rs:288-290`）——它管不到之后的本地解码**，也**管不到它自己被设置之后、`client.execute()` 之前的那段构建工作**（R4-C1 第一条）。`request.rs:117` 的 `Request::timeout()` 是公开 getter（R3 已实编译验证可断言到 `Some(23s)`），`request.rs:123` 的 `Request::timeout_mut()` 允许在 `.build()` **之后**改写超时值——rev5 用它把预算读取点挪到构建之后。

### 1.3 与 review 文档不一致之处（以代码为准）

1. **REVIEW `lib.rs:2440`（high，解压）的证据描述不准确。** 它写「reqwest 0.12.28 entry pulls no async-compression/flate2/brotli/zstd」。结论（当前不解压）成立，但依赖判断是错的：`brotli` 与 `flate2` 今天就在 `Cargo.lock` 里，且 `brotli` 已作为 `tauri-utils` 的运行期依赖编译进产物。缺的是「reqwest 的解压通路」，不是这些 codec。

2. **同一条的「修复」建议说启用 reqwest features 会让它 strip `Accept-Encoding`——这是错的。** reqwest 0.12.28 把解压委托给 `tower_http::decompression::Decompression`（`client.rs:1033`），而 `tower-http-0.6.8/src/decompression/service.rs` 的 `call()` 只在 `header::Entry::Vacant` 时插入 `Accept-Encoding`，**从不覆盖也从不移除**用户已有的那一行。真实效果是给「用户没写」的请求**新增**一个 header。（R1 已独立核验确认。）

3. **REVIEW `lib.rs:2410`（错误链）与 `lib.rs:2337`（预探测）不是两条独立的发现。** 今天「DNS 失败 / 连接被拒」的区分度来自预探测抢先报错；去掉预探测的 `?` 之后区分度会消失。原因链改造是预探测改造不构成回归的前提，两者必须同一次落地。backlog 没有记录这个顺序约束。（R1 已确认。）

4. **REVIEW `lib.rs:2440`（med，UTF-8）建议改用 `response.text()`——不可行。** 它消费 response 并直接产出带替换字符的 `String`：拿不到判定二进制所需的字节、拿不到 `size`、没法加上限、也无法整体挪进 `spawn_blocking`。改为直接对字节调用 `encoding_rs`。该条的自我更正（「`size` 今天是字节精确的」）正确，予以采纳。

5. **REVIEW `lib.rs:2291` 的「修复」要求给 api-key 的 query 分支加守卫——不需要。** `lib.rs:2304` 已有 `!api_key.key.trim().is_empty()`。只改 `lib.rs:2290-2299`。

6. **REVIEW `lib.rs:2376` 的「修复」建议「先取 `form.boundary()` 再手动 insert」——有更简单的做法。** `request.rs:322-337` 中 `.multipart()` 追加的 `Content-Type` 就是**最后一个**且带真实 boundary，「保留最后一个值」即可。该条还漏了 `.multipart()` 同时 `.header(CONTENT_LENGTH, ...)`（`request.rs:328-331`）——不在本切片范围内，记为后续项（§6）。

7. **REVIEW `lib.rs:2337` 的 `tokio::time::timeout` 建议是可行的；rev1 判断错误。** rev1 曾断言「没有 `time` feature 所以编译不过」——**该论证作废**。rev2 起直接使用 `tokio::time::timeout`，并在 `Cargo.toml` 显式补上 `"time"`，不把正确性建立在传递性巧合上。

### 1.4 rev1 / rev2 / rev3 自身的错误（历轮评审指出，已修正）

rev1：DNS 无界；每地址拿全部预算；`Content-Encoding` 只读第一个字段值；四个 killer 无效；64 MiB 的错误定性。

rev2：零预算 tokio 测试结论相反（R2 实测 1000/1000）；`run_probe_within_budget` 与 `JoinHandle` 类型不匹配；`total` 仍由分段合成；§10 契约冲突；非 UTF-8 编码头被静默吞掉；三条 killer 无效；漏列 `Cargo.lock`。

**rev3（本轮修正）：**

- **「统一 30 秒预算」只是表面修复。**（R3-C1）三处：①`RequestBuilder::timeout()` 只覆盖建连到读完响应体，之后的 `spawn_blocking(finalize_response_body)` 不受约束，而 rev3 自己在 §2.5 承认 64 MiB brotli 可能跑数秒——响应体在第 29.9 秒读完再解码几秒就超了；②rev3 那句「探测 ≤5 秒所以 HTTP 阶段剩余 ≥25 秒、timeout 不可能为 ZERO」**不成立**——计时从 `execute_request` 第一行开始，但请求 timeout 是在 client/URL/header 构建、探测、JSON 校验、base64 解码、multipart 拼装**之后**才设置的，这些阶段都能吃掉预算；③净效果只是把「固定 35 秒」变成「网络阶段约 30 秒、完整用户等待仍可超 30 秒」。见 §2.6。
- **§36 的回归测试确定假绿。**（R3-C2）rev3 用「已关闭的 loopback 端口」当 fixture，但 rev3 自己的规格写明「DNS 成功、所有地址连接失败 → `Ok((dns_ms, 0))`」。所以把 `.unwrap_or((0, 0))` 改回 `?` 之后**仍然得到 `Ok`**，请求行为完全不变，测试不会红。真正的 `Err` 路径（DNS 失败 / 超时 / `JoinError`）没有任何用例覆盖。rev3 §4.2 声称该 mutant 会连带杀死 §34b，这个归因同样是错的——同理，它对 §34b 的场景也毫无影响。见 §2.4.1。
- **§9 的九行表与六个 killer 并非一一对应。**（R3-I1）「无头 → None」与「zstd → Undecodable」没有任何对应 killer；「不过滤 identity」同时覆盖两行；「多 token 取首项」同时覆盖三行。rev3「每行各有独立单行 killer、互不遮蔽」的声明不成立。见 §4.1 的 §9 与 §4.6。

**rev4（本轮修正）：**

- **deadline 仍没覆盖全部实际工作，是 R3-C1 的同类再现。**（R4-C1）三处：①HTTP 剩余预算在 `.build()` 与 `normalize_auto_headers` **之前**取值，而 reqwest 的 timeout 到 `client.execute()` 才开始计时，这两段耗时被**重复留给** HTTP 阶段；②解码剩余预算在 `bytes.to_vec()` **之前**取值，但 timeout 在这次完整拷贝**完成后**才启动，而原始响应字节无上限、拷贝耗时远端可控——响应体第 29.9 秒读完、拷贝再花几秒，用户要等拷贝完才收到 timeout；③PRODUCT 声称唯一的不可中断边界只是「用户 body 准备」，但 request build、header 归一化、响应拷贝、返回值组装同样是不可抢占的同步工作。见 §2.6。
- **§43/§44 的测试只证明了 helper 自己，对生产接线假绿。**（R4-C2）删掉生产代码里的 `ensure_budget_remaining(...)`、改回固定 30 秒，§43 仍绿；把 `run_decode_within_budget(...).await?` 改成 `decode.await?`，§44 仍绿。**这是同一个陷阱在本切片的第三次出现**（前两次：关闭端口的假绿 fixture、§36 的归因错误），而且另一个切片也栽过同一形态（测了原子写 helper，却证明不了 9 个生产写入点真的改用了它）。**测试一个 helper，不等于测试这个 helper 被调用了。** 见 §2.6.3 与 §4.6 的 KWIRE1/2/3。
- **§4.6 的「未执行」登记是选择性枚举。**（R4-I1）只列了 wiremock 层与 §40/§44，漏掉大量未执行的 unit mutant，且把 §4 错误归进「wiremock 集成层」。选择性枚举比不枚举更误导。§4.6 已重写为完整分类。
- **`encoding_rs` 的缓存状态过时。**（R4-M1）已更正，见 §1.2 与 §3.1。

## 2. 设计决策

### 2.1 解压：手工解码；`Content-Encoding` 按「全部字段 + 逗号列表」判定

**决定：新增 `flate2` / `brotli-decompressor` 直接依赖，在读到字节之后手工解码；`reqwest` 的 feature 列表一行不改。**

否决 reqwest features 的理由，按权重排序：

1. **它会改变今天正常工作的请求的线上字节**（§1.3 第 2 条）。ApiSolo 的核心承诺是「Headers 表里有几行就发几行」，而本切片同时还在修「零参数时多一个 `?`」这种字节洁癖问题——一边删掉一个多余字符、一边注入一整个 header，自相矛盾。
2. **它对呈现层没有控制权。** `tower-http` 解压成功时会移除 `Content-Encoding` 与 `Content-Length`（`future.rs:70-71`），恰好与 §8 一致；但「解不了的编码」这条路径（§9/§11）完全交给上游语义，我们无法保证头被保留、更无法强制标成二进制。
3. **它解不了多值列表。** `future.rs` 按 `b"gzip"` / `b"br"` 精确比对字节，`content-encoding: gzip, br` 会静默走 identity 分支。
4. **依赖成本反而更高**：额外引入 `async-compression`，`zstd` 还会带进 `zstd-sys`（C 编译）。手工路线只需要 `flate2` + `brotli-decompressor`，两者都已在 `Cargo.lock` 与本机缓存里。

**编码列表判定规则（§9 / §10）：**

```
// I1：任一字段值不是合法 UTF-8 -> 立刻判定为无法解码，绝不退化成「无编码」
for value in headers.get_all(CONTENT_ENCODING) {
    if value.to_str().is_err() { return Plan::Undecodable("(unparsable)".into()); }
}

tokens = headers.get_all(CONTENT_ENCODING)          // 不是 get()
           .flat_map(|v| v.to_str().unwrap().split(','))
           .map(|t| t.trim().to_ascii_lowercase())   // 不在 ';' 处截断
           .filter(|t| !t.is_empty() && t != "identity")
           .collect::<Vec<_>>()                      // 不去重

tokens.is_empty()                          -> Plan::None
tokens.len() == 1 && supported(&tokens[0]) -> Plan::Decode(enc)
tokens.len() == 1                          -> Plan::Undecodable(tokens[0])     // 未知单编码
否则                                        -> Plan::Undecodable(tokens.join(", "))
```

`supported()` 只认 `gzip` / `x-gzip` / `deflate` / `br` 四个**完整** token。`gzip;q=1.0` 落入 `Undecodable`——`Content-Encoding` 语法上不允许参数，带参数就是畸形。**不去重**：`gzip, gzip` 是真实的双重压缩。**「全空 token 等同 `Plan::None`」是有意契约**，写进 §9 与 §4.1 的表驱动用例。

`Plan::Undecodable` 的三条后果（§11）缺一不可：**(a)** 字节不做任何变换；**(b)** `Content-Encoding` 与 `Content-Length` 原样留在返回给 UI 的响应头里；**(c)** `bodyKind` 被**强制**设为 `binary`，完全跳过字符集解码。(c) 是必须的：一段未解码的 br/zstd 字节完全可能碰巧是合法 UTF-8 且不含 NUL。

**`Plan::None` 的契约（§12）**：解压层**只**承诺「不改变字节、不删除任何响应头」，随后正文照常进入 §17–§24。rev2 曾承诺「正文与当前版本逐字节一致」——与 §17–§22 逻辑上不可兼容（`identity` + GBK 旧版给 U+FFFD、新版给正确中文；`identity` + 非法 UTF-8 旧版有损替换、新版给 binary marker），用弱 ASCII fixture 去测那句承诺只会假绿。

**`Content-Encoding` / `Content-Length` 的呈现（§8）**：解压成功时删除这两个头，`size` 改为解压后的字节数。代价是用户看不出「本来是压缩的」；补回它需要新字段 + 前端渲染（§6）。

**zstd 不做。** 唯一需要引入全新 codec crate 的一个，而 §9/§11 已让它退化成「明确标注、不装懂」。

### 2.2 响应体解码：`encoding_rs` + 「解不出就是二进制」

**决定：新增 `encoding_rs` 直接依赖。字符集只从响应 `Content-Type` 的 `charset=` 参数取；取不到就按 UTF-8；解不出合法文本就判定为二进制。**

- **字符集来源**：只解析 `charset=` 参数（§17/§18/§19）。不做 BOM 推断、不做 HTML `<meta>` 嗅探、不做内容嗅探。标签用 `encoding_rs::Encoding::for_label` 解析，走 WHATWG 别名表，所以 `gb2312` 映射到 GBK、`iso-8859-1` 映射到 windows-1252——这是**正确**行为，不要「修」它。
- **标签无法识别**（§20）：退回 UTF-8，不报错、不猜第二候选。
- **文本 / 二进制的判定不看 `Content-Type` 的主类型，只看字节能不能解出来**（§21）。用 `decode_without_bom_handling_and_without_replacement`，遇到非法序列返回 `None`。好处：把 JSON 错标成 `application/octet-stream` 的接口仍能显示文本，把 PNG 错标成 `text/html` 的服务器也能被识别为二进制。额外补 `0x00` 守卫（§22），因为单字节编码形式上接受任意字节。
- **二进制的表示形式**：前端 `HttpResponse.body` 是 `string`（`src/types/index.ts:143-153`），改类型是跨切片涟漪，本切片不碰。因此：
  - `body` 放一行**固定格式、一望即知是应用提示而非服务端内容**的说明：
    - 普通二进制：`[ApiSolo] Binary response not shown as text: {size} bytes, content-type: {ct}`
    - 无法解码的编码（§11）：`[ApiSolo] Compressed response not decoded: content-encoding: {tokens}, {size} bytes, content-type: {ct}`

    `{ct}` 为空时写 `(none)`；`{tokens}` 在畸形头场景下是 `(unparsable)`。不选「把 base64 塞进 `body`」，因为未改造的前端会把它当正文渲染——渲染一串没有标注的 base64 等于告诉用户「服务端返回了 base64」。
  - 新增字段 `bodyKind: "text" | "binary"`。没有它，前端将来唯一的判别手段就是对提示串做字符串匹配。新增字段对现有前端安全（多出的 JSON key 被忽略）。
  - 拿回原始字节、本地化文案、历史持久化与重放，都是跨切片依赖（§6）。

### 2.3 自动附加的请求头：在「已构建好的 Request」上做一次归一

**决定：把 `request.send()` 拆成 `request.build()` → 归一 header → `client.execute(req)`，用一个纯函数按「保留第一个」/「保留最后一个」两种语义收敛重复值。**

现有代码的追加顺序天然把两边分开：用户 header 先经 `.headers(header_map)` 进去（`lib.rs:2342`），应用算出来的那个后经 `.header(...)` / `.basic_auth()` / `.multipart()` 追加。

| 场景 | 语义 | 结果 |
|---|---|---|
| `Content-Type` + form-data（§25） | 保留最后一个 | 应用的真实 boundary 胜出 |
| `Content-Type` + form-urlencoded（§26） | 保留第一个 | 用户的值（含 `charset` 后缀）胜出 |
| `Content-Type` + json（§27） | 保留第一个 | 用户的值胜出 |
| `Content-Type` + raw / binary / none（§28） | 不处理 | 应用本来就不加 |
| `Authorization` + auth 为 basic/bearer（§29） | 保留最后一个 | Auth 面板胜出 |
| `Authorization` + auth 为 none / api-key（§30） | 不处理 | 用户手写的原样发出，几行是几行 |
| api-key 投放 header（§31） | 不处理 | `lib.rs:2333` 本来就是 `insert` 语义 |

`Authorization` 判给 Auth 面板的理由：(a) 让四种 auth 模式一致——api-key 投放 header 今天已是覆盖语义；(b) `auth.type` 默认 `none`，面板被主动选中即明确指令；(c) 用户侧有一键逃生口（面板切回 `none`），反向规则没有逃生口。这是**会改变现存配置线上字节**的一处改动，见 §5.1。

### 2.4 预连接探测：结构上不可能决定请求成败 + 整段有预算 + 地址间公平切分

#### 2.4.1 「探测不决定请求成败」改为类型保证（R3-C2）

rev2/rev3 为了让 killer 是「单行」，刻意保留 `measure_connection_timings -> Result<(u64,u64), String>` 并在调用点写 `.unwrap_or((0, 0))`。R3 证明这是本末倒置：那个 mutant **根本杀不掉**，因为规格自己规定「DNS 成功、所有地址失败 → `Ok((dns_ms, 0))`」，而唯一的测试 fixture（已关闭的 loopback 端口）正好走这条 `Ok` 路径。为一个杀不掉的 mutant 保留一个可失败的返回类型，是纯粹的负资产。

**决定：采用 R3 的方案二——把生产接口收敛成不可失败。**

```rust
/// 对外唯一入口：不可能失败。所有内部失败模式都在这里被吞掉。
async fn measure_connection_timings(url: &Url, budget: Duration) -> (u64, u64);
```

调用点（`lib.rs:2337-2341`）因此**没有任何 `?` / `unwrap_or` / `expect` / `map_err` 可以被改动**：要让探测重新决定请求成败，必须改函数签名 + 改调用点 + 改内部错误传播，是明显的结构性改动，在评审 diff 里一眼可见。

代价如实记录：**§36 因此没有单行 mutant**，这不是遗漏而是设计目标——把 bug 变成不可表达比为它写一个测试更强。它登记在 §4.3，并配一个真正会红的下游单测（`run_probe_within_budget` 注入 `Err` → 断言 `(0, 0)`，见 §4.1 的 §36 行说明）。**rev3 那条用「已关闭 loopback 端口」的用例已删除**——一个永远不会红的测试比没有测试更危险。

#### 2.4.2 预算三层约束

1. **整段预算**（§40）。`spawn_blocking` 出来的 `JoinHandle` 先用一个 async block 消化 `JoinError`（rev2 的类型错误在此修复），再整体交给 `tokio::time::timeout(budget, probe)`。超时、DNS 错误、`JoinError` 一律 → `(0, 0)`。
2. **地址间公平切分**（§38）。每次尝试拿到 `remaining / remaining_addresses`，不是 `remaining`。第一个黑洞地址最多用掉它那一份；快速失败的地址把余额留给后面的。
3. **预算耗尽即停**（§39）。剩余为零时直接返回，不再发起任何连接。

**测试方案**：`#[tokio::test(start_paused = true)]` + probe 内 `tokio::time::sleep(Duration::from_nanos(1))`。R2 已隔离压力验证：tokio 1.50.0 下基线与 `Duration::MAX` mutant 各跑 1000 次、整套重复 10 次，结果稳定（基线 `(0,0)`、mutant `(7,9)`）。**§44 的解码超时复用同一形状**，不再另起炉灶。

**残余风险**：`spawn_blocking` 派生的任务**无法被取消**。timeout 到点后我们停止等待，但卡在 `to_socket_addrs()` 或 `connect_timeout()` 里的 blocking 线程仍会占用到自己返回。不影响请求，只是 blocking 线程池的短期占用（tokio 默认 512 个）。不为此引入自定义 resolver。

### 2.5 解压与解码移进 `spawn_blocking`

最多 64 MiB 的解压 + 一次全量 `encoding_rs` 转换是纯 CPU 工作。放在 async `execute_request` 里会独占一个 tokio worker：高压缩比的 brotli 流可以跑上数秒，期间该 worker 上排队的取消命令、WebSocket 帧派发、其他并发请求全部停摆。

**决定：整体收进纯同步函数 `finalize_response_body`，唯一调用点是 `tokio::task::spawn_blocking`，并且（rev4 新增）该 handle 被剩余预算 timeout 包住（§44）。**

**验证边界（R2-I3 裁定后的选择）**：本条**没有**有效的自动化 mutant——把 `finalize_response_body` 改成 `async fn` 会让生产调用点自己编译失败，测试对这个信号没有贡献。不宣称它有自动化证明，登记在 §4.3。

### 2.6 统一的 30 秒预算（R3-C1 起，R4-C1 补齐）

#### 2.6.1 rev5 的选择：扩大覆盖（两处），并把承诺文本精确化（一处）（R4-C1）

R4 给了两条路：把 deadline 真正覆盖到三处漏口，或者把 PRODUCT 的诚实边界扩大到**所有**不可抢占的同步步骤、并删掉「唯一漏口」「严格在 deadline 结束」两句过强承诺。

**rev5 的选择是逐处判断，而不是整体二选一——因为三处漏口的性质不同**：

| R4-C1 指出的漏口 | rev5 的处理 | 理由 |
|---|---|---|
| ①HTTP 预算在 `.build()` / 归一化**之前**取值 | **扩大覆盖**：改到之后取值，用 `Request::timeout_mut()`（`request.rs:123`）写入最新值后立刻 `execute` | 修法精确、零残余、一行位置调整。而且它顺手把「构建耗时」从「重复留给 HTTP 阶段」变成「被检查点发现」 |
| ②解码预算在 `bytes.to_vec()` **之前**取值，拷贝在 timeout 之外 | **扩大覆盖**：把 `bytes` 整体 move 进 `spawn_blocking` 闭包，`to_vec()` 在闭包内执行，因而落在 timeout 里 | 这是**远端可控**的一段（原始字节无上限），必须封住。修法零残余，且不需要给 `bytes::Bytes` 命名类型、不新增依赖 |
| ③承诺说「唯一不可中断的是 body 准备」，但构建、归一化、拷贝、返回值组装同样不可抢占 | **精确化承诺**：PRODUCT §41 改成**完整枚举**所有不可抢占步骤，删掉「唯一」；同时删掉 §44 的「严格在 deadline 结束」 | 见下 |

**为什么③不采用「解码后再加一次预算检查」**：那一步只是遍历响应头生成键值对（`response_header_pairs`）、几次整数运算（`build_timings`）、以及移动已经分配好的值构造 `HttpResponse`。耗时由响应头数量决定（这一项确实受远端影响，只是被 HTTP 层自身的请求头总量上限所限），量级远小于预算粒度；而它一旦撞线，代价是把一个已经完整收到、完整解码成功的响应整个丢掉。取舍的依据是**代价不对称**，不是「它不可能撞线」。所以把它**列进枚举**（承认它不受约束、且其后没有检查点），而不是假装它被覆盖了——这正是 R4 要求的「选了缩窄就必须同步改承诺文本」。

**为什么删掉「严格在 deadline 结束」**：R2 自己实测过，零时长 `tokio::time::timeout` 在真实（未冻结）时钟下，计时器与内层 future 谁先就绪没有强保证。所以 §44 的结束时刻是「到点后尽快」而不是「精确切断」。承诺文本已改成上界近似。

**保留的判断（来自 rev4，仍然成立）**：契约不能整体缩窄成「只有网络阶段受约束」——界面上只有一个 spinner，用户观察不到阶段边界；一条用户无法据以行动的承诺等于没有承诺。而且解码的预算约束正是压缩炸弹在 CPU 维度上的唯一兜底（§5.2）。

#### 2.6.2 实现

```rust
const REQUEST_TOTAL_BUDGET:  Duration = Duration::from_secs(30);
const CONNECTION_PROBE_MAX:  Duration = Duration::from_secs(5);

// 唯一计时起点：execute_request_with_budget 的前两行（见 §3.2(6)）
let overall_started_at = Instant::now();
let overall_deadline   = overall_started_at + total_budget;   // 用参数，不用常量
```

四个受预算约束的边界（②③相对 rev4 已移位）：

| 边界 | 做什么 | 不变式 |
|---|---|---|
| ①探测前 | `probe_budget(deadline, now)` = `min(5s, remaining)` | §41 |
| ②**`.build()` + `normalize_auto_headers` 之后**、`execute()` 之前 | `ensure_budget_remaining(deadline, Instant::now(), "sending the request")?` → `*built.timeout_mut() = Some(budget)` → 立刻 `client.execute(built)` | §42 §43 |
| ③读完响应体之后、**创建 `spawn_blocking` 之前** | `ensure_budget_remaining(deadline, Instant::now(), "decoding the response")?` → 返回值喂给 `run_decode_within_budget`，**而 `bytes.to_vec()` 在被包裹的闭包内部** | §44 |
| ④组装耗时 | `build_timings(overall_started_at.elapsed(), ...)` | §45 |

②的错误串形如 `Request budget exhausted before sending the request (30s limit)`；③超时的错误串形如 `Request budget exhausted while decoding the response (30s limit)`。

③**保留 `ensure_budget_remaining`，并且必须在 `spawn_blocking` 创建之前**（rev5 曾把它删掉，R5-I3 判定删早了，已恢复）。rev5 的理由「它是近乎不可达的分支」**不成立**，三点：
- `.bytes().await` 完全可以在 deadline **之前**成功返回，随后读 `decode_budget` 时预算已经归零——HTTP 层的 timeout 拦不到这一格。
- rev5 的顺序是「先创建不可取消的 `spawn_blocking`、再用零预算 timeout 包住 join」。`spawn_blocking` 派生的任务**无法被取消**，所以那个解码任务可能已经开跑，并在 timeout 返回错误之后继续烧 CPU——这恰好是本切片想封住的压缩炸弹的 CPU 面。
- 零预算下计时器与内层任务谁先就绪没有强保证（R2 对本 spec 自己的发现，见 §4 开头）。所以「零预算靠 timeout 兜」本身就不可靠。

因此这个检查点的作用**不是重复限制网络**，而是**避免在预算已耗尽之后启动一个不可取消的解码任务**。它同时带来一个附加好处：走到 `run_decode_within_budget` 时 `decode_budget` 必然非零，那个零预算竞态在这个调用点被结构性排除。

`total` 直接取 `overall_started_at.elapsed()`（§45），不再由分段相加。分段字段（`dnsLookup` / `tcpConnect` / `download`）继续只报告各自真正测到的那一段，测不到就是 0——「测不准写 0」和「总耗时等于真实等待」同时成立，不需要任何合成。

#### 2.6.3 生产接线的可测性（R4-C2）

R4 证明：rev4 的 §43/§44 只测了 helper 本身——删掉生产代码里的 `ensure_budget_remaining(...)` 改回固定 30 秒，§43 仍绿；把 `run_decode_within_budget(...).await?` 改成 `decode.await?`，§44 仍绿。**测试一个 helper，不等于测试这个 helper 被调用了。**

**决定：加一个预算注入 seam，让接线本身可观测。**

```rust
async fn execute_request(args: SendRequestArgs) -> Result<HttpResponse, String> {
    execute_request_with_budget(args, REQUEST_TOTAL_BUDGET).await
}

async fn execute_request_with_budget(
    args: SendRequestArgs,
    total_budget: Duration,
) -> Result<HttpResponse, String>;
```

这不是测试后门：公开命令的行为一字不变，只是把一个常量提成参数，好让「预算真的被接上了」这件事在测试里可观测。有了它，两条接线用例成立（见 §4.1 的 §42/§43 行）：

- **§43 接线**：`execute_request_with_budget(args, Duration::ZERO)` 打一个活着的 `MockServer` → 必须返回 `Err` 且含 `budget exhausted`，并且 `mock_server.received_requests()` **为空**。删掉②的检查点 → 请求真的发出去了 → 红。确定性，不看墙钟。
- **§42 接线**：`execute_request_with_budget(args, 500ms)` 打一个 `set_delay(5s)` 的 `MockServer` → 必须返回 `Err`。删掉 `timeout_mut` 赋值（退回 client 级 30 秒）或把常量装上去 → 5 秒后拿到 `Ok(200)` → 红。**这是全套用例里唯一一条依赖时间关系的**（500ms 对 5s，10× 余量）；它断言的是**结果**（`Err` vs `Ok`）而不是时长，且任何「尊重预算」的路径都给 `Err`，只有「忽略预算」才给 `Ok`，因此没有中间态。

#### 2.6.4 「预算读取位置」的验证：选方案 1（诚实降级）+ 收紧评审面（R5-CRITICAL）

R5 判定 rev5 的 `KWIRE3` 只作用在平行的 `execute_flow(clock, trace)` 模型上——模型把 build 前的时刻硬编码成 `Duration::ZERO`，从没执行真实的 `.build()` / 归一化；而规划中唯一的真实用例（500ms 预算对 5s 延迟）**区分不了「预算在 build 前取」和「build 后取」**，两种实现都在约 500ms 超时返回 `Err`。所以生产代码把读取点移回 build 之前，真实测试仍会全绿。**这是 R4-C2 那条 helper/model 假绿换了个位置的复发。**

**选方案 1：把「预算读取位置」登记为结构性验证缺口（§4.3 #6），删除 rev5 的 ✅ 与「已自动化证明」声明。** 三条理由：

1. **方案 2 会逼出实现细节断言。** 要让测试在 build/归一化期间推进注入时钟，就得把一个 `FnMut() -> Instant` 穿过整个 `execute_request_with_budget`，并让用例断言「这个时钟在这几个点、按这个顺序被调用过」。那是典型的实现细节断言（`no-sham-tests` 第 10 条），比它要防的缺陷更脆。
2. **这个缺陷的量级与 R4-C1② 完全不同。** 读取点错位的代价 = build + 归一化的耗时被重复留给 HTTP 阶段，而这两步的成本由请求头数量决定，是毫秒量级、**不受远端放大**。相比之下 gap ②（`bytes.to_vec()` 在 timeout 之外）是远端可控、可无限放大的，所以那一处我做了真正的覆盖修复，这一处不做。用永久的生产复杂度去换一个毫秒级位置细节的自动化，不划算。
3. **可以用结构收紧评审面，而不是靠断言。** 把顺序封进一个小函数（见下），让评审检查点从「在 200 行的 `execute_request_with_budget` 里扫两条语句的相对位置」变成「读 5 行」。

```rust
/// 把「构建 → 归一化 → 读预算 → 设超时」四步的顺序封在一个函数里，
/// 顺序错误在这里是一眼可见的，而不是散落在长函数中。
fn finish_request_with_deadline(
    request: RequestBuilder,
    auth_type: &str,
    body_type: &str,
    deadline: Instant,
) -> Result<Request, String> {
    let mut built = request
        .build()
        .map_err(|error| format_error_chain("Failed to build request", &error))?;
    normalize_auto_headers(built.headers_mut(), auth_type, body_type);
    let budget = ensure_budget_remaining(deadline, Instant::now(), "sending the request")?;
    *built.timeout_mut() = Some(budget);
    Ok(built)
}
```

**仍然成立的部分（不受本条降级影响）**：`KWIRE1`（删掉发送前检查点）与 `KWIRE2`（装常量而非剩余预算）**都有真实用例能抓到**——前者被 §43(b) 的「零预算 + MockServer 没收到请求」抓到，后者被 §42(c) 的「500ms 预算对 5s 延迟必须 `Err`」抓到。模型跑只是预演；这两条的真实覆盖独立成立。**只有 `KWIRE3` 没有真实用例支撑**，因此只有它降级。

**§44 的解码接线仍然无法自动化证明**：要让解码撞线，必须让解码本身慢于剩余预算，而剩余预算同时也是 HTTP 阶段的 timeout——网络先超时，解码就到不了。除非造一个 64 MiB 的病态压缩 fixture 并依赖真实解码耗时，那既重又脆。**如实降级**：§44 的 helper 语义由冻结时钟用例证明，接线登记进 §4.3 的验证缺口，**不再宣称 §44 已由自动化测试证明**（R4 允许的两条路里选后者）。

## 3. Per-file change plan（依赖顺序）

**三个文件**（第三个由 owner 裁定 A11 批准，仅限依赖声明）。

### 3.1 `src-tauri/Cargo.toml`

`[dependencies]`（`Cargo.toml:26-42` 区块）：

```toml
# 新增
flate2 = "1"                    # 默认 features = rust_backend -> miniz_oxide，纯 Rust，无 C
brotli-decompressor = "5"
encoding_rs = "0.8"

# 修改（Cargo.toml:32）：显式补上 "time"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "net", "time"] }
```

`[dev-dependencies]`（`Cargo.toml:53-55` 区块）：

```toml
# 新增：§40 / §44 的 #[tokio::test(start_paused = true)] 需要
tokio = { version = "1", features = ["test-util"] }
```

放在 `[dev-dependencies]`：`Cargo.toml:7` 是 `edition = "2021"`，隐含 resolver 2，dev-dependency 的 feature 不会合一到 `cargo build` / `cargo tauri build` 的产物里。R3 已实测确认 normal/build feature 图不含 `test-util`。

**不改**：`reqwest` features（`:29`）、`tower-http` features（`:38`）、`[features]` 段（`:11-14`）、`[lib]`、`[[example]]`、profile —— A11 例外只覆盖依赖声明。

依赖体积影响：

- **`tokio` 加 `"time"`：零体积影响**（`reqwest-0.12.28/Cargo.toml:358-364` 已经把它拉起来了）。
- **`tokio` dev 加 `"test-util"`：零发布体积影响**（resolver 2，R3 已实测）。
- **`flate2 1.1.9` + `miniz_oxide 0.8.9`**：已在 `Cargo.lock` 与本机缓存，目前只在构建依赖链上；声明为直接依赖后进入运行期产物。纯 Rust，无 C 编译，预计数百 KB。**零新增下载。**
- **`brotli-decompressor 5.0.0`**：已在 `Cargo.lock:313`，其上游 `brotli 8.0.2` 已是 `tauri-utils` 的运行期依赖，**今天就已编译进产物**。产物增量约等于零。**零新增下载。**
- **`encoding_rs 0.8.35`：唯一真正新增的 crate。** 落地第一步必须联网 `cargo fetch`。唯一非可选依赖 `cfg-if` 已在 `Cargo.lock:454`，**不引入任何新的传递依赖**（R3 实测确认）。带 WHATWG 全套 legacy 编码表，预计数百 KB 静态表。这是修 gb2312 的必要成本。
- **明确不引入**：`async-compression`、`zstd` / `zstd-sys`、`ruzstd`、`mime`。

### 3.2 `src-tauri/src/lib.rs`

**(1) `lib.rs:15-16, 20-27` — imports**

`:15` 的 `reqwest::header::{...}` 增补 `AUTHORIZATION`、`CONTENT_ENCODING`、`CONTENT_LENGTH`；`:20` 的 `std::io::{...}` 增补 `Read`；新增 `use std::net::SocketAddr;`、`use std::time::Duration;`；**删除 `:27` 的 `use tokio::net::TcpStream;`**（唯一使用点 `:221` 改造后消失；`:367` 用的是全限定路径）。

**(2) `lib.rs:194-228` — 重写探测**

```rust
const CONNECTION_PROBE_MAX: Duration = Duration::from_secs(5);

fn per_attempt_budget(remaining: Duration, remaining_attempts: usize) -> Duration;

fn connect_first_reachable_with<C>(
    addrs: &[SocketAddr], total_budget: Duration, connect: C,
) -> Option<(usize, u64)>
where C: FnMut(&SocketAddr, Duration) -> std::io::Result<()>;

fn connect_first_reachable(addrs: &[SocketAddr], total_budget: Duration) -> Option<u64>;

/// 一切失败（探测报错 / 预算到点 / JoinError）都收敛成 (0, 0)。
async fn run_probe_within_budget<F>(budget: Duration, probe: F) -> (u64, u64)
where F: std::future::Future<Output = Result<(u64, u64), String>>;

/// 可失败的内部实现。
async fn probe_connection(url: &Url) -> Result<(u64, u64), String>;

/// 【R3-C2】对外入口不可失败 —— 没有任何失败通道能外泄到 execute_request。
async fn measure_connection_timings(url: &Url, budget: Duration) -> (u64, u64);
```

`measure_connection_timings` 的组装（rev2 的 `JoinHandle` 类型错误在此修复）：

```rust
let handle = tokio::task::spawn_blocking(move || -> Result<(u64, u64), String> {
    // to_socket_addrs() + connect_first_reachable() 都在这一个 blocking 任务里
});
let probe = async move {
    match handle.await {
        Ok(result) => result,
        Err(error) => Err(format!("Connection probe task failed: {error}")),
    }
};
run_probe_within_budget(budget, probe).await          // 返回 (u64, u64)，无 Result
```

语义：host/port 缺失 → `(0, 0)`；DNS 成功但所有地址连不上 → `(dns_ms, 0)`（DNS 真测到了就如实上报；那段连接等待由 §45 的 `total` 覆盖，不在 `tcpConnect` 里合成）；DNS 失败 / 超时 / `JoinError` → `(0, 0)`。

`connect_first_reachable_with` 的循环：对第 `i` 个地址 `budget = per_attempt_budget(deadline - now, addrs.len() - i)`；`budget.is_zero()` 时**立即返回 `None`，不调用 `connect`**（§39 的可测点）。

**(3) `lib.rs:230-241` — `HttpResponse` 新增字段 + 新增枚举**

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResponseBodyKind { Text, Binary }   // -> "text" / "binary"

struct HttpResponse { /* ...现有字段不变... */ content_type: String, body_kind: ResponseBodyKind }
```

**(4) 新增纯函数（全部放在 `should_measure_connection_timings`（`lib.rs:2461`）附近，留在 HTTP 段内）**

```rust
const MAX_DECOMPRESSED_RESPONSE_BYTES: usize = 64 * 1024 * 1024; // 64 MiB
const REQUEST_TOTAL_BUDGET: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContentEncoding { Gzip, Deflate, Brotli }

#[derive(Clone, Debug, Eq, PartialEq)]
enum ContentEncodingPlan { None, Decode(ContentEncoding), Undecodable(String) }

fn plan_content_encoding(headers: &HeaderMap) -> ContentEncodingPlan;
fn decompress_response_body(bytes: Vec<u8>, plan: &ContentEncodingPlan) -> Result<(Vec<u8>, bool), String>;
/// 上限可注入 —— 让 §14 / §15 的边界能用 KB 级 fixture 测。
fn decompress_response_body_with_limit(bytes: Vec<u8>, plan: &ContentEncodingPlan, limit: usize)
    -> Result<(Vec<u8>, bool), String>;

fn charset_from_content_type(content_type: &str) -> Option<String>;
fn binary_body_marker(size: usize, content_type: &str, undecoded_encoding: Option<&str>) -> String;
fn decode_response_body(bytes: &[u8], content_type: &str) -> (String, ResponseBodyKind);
fn response_header_pairs(headers: &HeaderMap, drop_encoding_headers: bool) -> Vec<(String, String)>;

struct DecodedResponseBody { size: u64, body: String, body_kind: ResponseBodyKind, dropped_encoding_headers: bool }

/// §2.5：纯同步、可脱离 runtime 调用；唯一调用点在 spawn_blocking 内。
fn finalize_response_body(bytes: Vec<u8>, plan: ContentEncodingPlan, content_type: &str)
    -> Result<DecodedResponseBody, String>;

// ---- §2.6 统一预算 ----
fn remaining_budget(deadline: Instant, now: Instant) -> Duration;                     // saturating
fn probe_budget(deadline: Instant, now: Instant) -> Duration;                         // min(PROBE_MAX, remaining)
/// 预算耗尽时返回统一错误；不返回 Ok(ZERO)。
fn ensure_budget_remaining(deadline: Instant, now: Instant, phase: &str) -> Result<Duration, String>;
/// 【rev6 新增，R5-CRITICAL 的缓解】把 build → normalize → 读预算 → 设超时 四步的顺序封在一处。
fn finish_request_with_deadline(request: RequestBuilder, auth_type: &str, body_type: &str, deadline: Instant)
    -> Result<Request, String>;
/// 解码也受预算约束；形状与 run_probe_within_budget 一致，但错误向上传播而不是吞掉。
async fn run_decode_within_budget<F>(budget: Duration, decode: F) -> Result<DecodedResponseBody, String>
where F: std::future::Future<Output = Result<DecodedResponseBody, String>>;
fn build_timings(overall_elapsed: Duration, dns_lookup: u64, tcp_connect: u64, download: u64) -> RequestTimings;
/// 【rev5 新增，R4-C2】预算注入 seam：让「检查点真的被接上」可观测。
/// 公开命令行为不变，execute_request 只是把常量喂进来。
async fn execute_request_with_budget(args: SendRequestArgs, total_budget: Duration)
    -> Result<HttpResponse, String>;
// 【rev5 删除】apply_request_deadline —— builder 已被 .build() 消费，改用 Request::timeout_mut()

fn build_request_url(raw_url: &str, params: &[KeyValuePair], auth: &AuthInput) -> Result<Url, String>;
fn keep_first_header_value(headers: &mut HeaderMap, name: HeaderName);
fn keep_last_header_value(headers: &mut HeaderMap, name: HeaderName);
fn normalize_auto_headers(headers: &mut HeaderMap, auth_type: &str, body_type: &str);
fn format_error_chain(prefix: &str, error: &(dyn std::error::Error + 'static)) -> String;
```

`finalize_response_body` 的流程：`decompress_response_body(bytes, &plan)?` → 若 `plan` 是 `Undecodable(list)` 则**直接**产出 `(binary_body_marker(size, ct, Some(&list)), Binary)`，**跳过** `decode_response_body`（§11(c)）；否则走 `decode_response_body`。

解码器选型（§1–§7）：gzip / x-gzip → `flate2::read::MultiGzDecoder`（**不是** `GzDecoder`）；deflate → 先 `ZlibDecoder`，失败后对同一份原始字节重试 `DeflateDecoder`；br → `brotli_decompressor::Decompressor`。上限用 `decoder.take((limit + 1) as u64).read_to_end(&mut out)`，读完后 `out.len() > limit` 即报错（`take` 只防止超限后继续分配，**真正的判定是那个 `>` 比较**）。

`format_error_chain` 的签名收成 `&dyn std::error::Error`，便于用手写错误链做单测。实现为 `std::iter::successors(Some(error), |e| e.source())` 收集后用 `": "` 连接。

**(5) `lib.rs:2288-2309` — 换成 `build_request_url` 调用**

只有「启用且键名非空」的参数（或满足条件的 api-key query 对）非空时才进入 `url.query_pairs_mut()` 块（§48）。不能改成「事后剥掉尾随 `?`」，那会连带删掉用户自己敲的 `?`。`url-2.5.8/src/lib.rs:1718` 的 `Serializer::for_suffix` 保证既有查询串逐字节保留。

**(6) `lib.rs:2249` — 拆成委派 + 实现，计时起点只有一处（R5-I1）**

rev5 在这里自相矛盾：§2.6.3 说逻辑在 `execute_request_with_budget`，§3.2 又说在 `execute_request` 第一行计时并用常量算 deadline——照后者实施要么让注入参数失效，要么逼出两个计时起点。**rev6 写死如下，不留第二种读法**：

```rust
// execute_request 只做一行委派，不含任何逻辑、不取任何时间
async fn execute_request(args: SendRequestArgs) -> Result<HttpResponse, String> {
    execute_request_with_budget(args, REQUEST_TOTAL_BUDGET).await
}

async fn execute_request_with_budget(
    args: SendRequestArgs,
    total_budget: Duration,
) -> Result<HttpResponse, String> {
    // ↓ 全流程唯一的计时起点，必须是本函数的前两行，早于 Client::builder()
    let overall_started_at = Instant::now();
    let overall_deadline = overall_started_at + total_budget;   // 用参数，不用常量
    ...
}
```

**唯一计时起点** = `execute_request_with_budget` 的第一行。`execute_request` 内不得出现 `Instant::now()`，`execute_request_with_budget` 内不得出现第二个用于 `total` 的 `Instant::now()`（原 `lib.rs:2406` 的 `started_at` 必须删除）。deadline 必须由 `total_budget` **参数**算出——写成常量会让注入 seam 失效，§43(b) 的用例随之变成假绿。

探测调用点——注意**没有 `?` 也没有 `unwrap_or`**（§2.4.1）：

```rust
let (dns_lookup, tcp_connect) = if should_measure_connection_timings(args.proxy.as_ref()) {
    measure_connection_timings(&url, probe_budget(overall_deadline, Instant::now())).await
} else {
    (0, 0)
};
```

`should_measure_connection_timings`（`:2461-2463`）**一字不改**。

**(7) `lib.rs:2365-2404` — body 分支**

`"json"`（`:2367-2372`）：保留 `serde_json::from_str::<serde_json::Value>` 作为**纯校验**（错误串不变，§33），丢弃解析结果，改成 `request = request.header(CONTENT_TYPE, "application/json").body(args.body.content);`（§32）。其余分支结构不变，重复值交给 (8) 收敛。

**(8) `lib.rs:2406-2410` — build → 归一 → 【此处才】读预算 → 设超时 → execute（R4-C1 ① 的修法）**

```rust
// 四步顺序封在 finish_request_with_deadline 里（§2.6.4）：
//   build -> normalize -> 读剩余预算 -> timeout_mut
let built = finish_request_with_deadline(
    request, &args.auth.auth_type, &args.body.body_type, overall_deadline)?;   // §42 §43
let response = client
    .execute(built)
    .await
    .map_err(|error| format_error_chain("Request failed", &error))?;
```

三处刻意安排：**(i)** 预算读取点在 `.build()` 与 `normalize_auto_headers` **之后**、`execute()` **之前**——reqwest 的 timeout 从 `execute()` 才开始计时，rev4 在构建之前取值等于把构建耗时算了两遍；**(ii)** 用 `Request::timeout_mut()`（`reqwest-0.12.28/src/async_impl/request.rs:123`）而不是 `RequestBuilder::timeout()`，因为此刻 builder 已经被 `.build()` 消费掉了；rev4 的 `apply_request_deadline(request, ...)` 因此**作废并删除**，其单测改为直接断言 `built.timeout()`；**(iii)** 检查点在 body 分支 (7) 之后，让 base64 解码 / multipart 拼装的耗时被计入并在此处被发现（§2.6.1）。

原来的 `let started_at = Instant::now();`（`:2406`）**删除**——`total` 不再从这里起算（§45）。

**(9) `lib.rs:2412-2434` — 响应处理（拷贝 + 解码整体进 spawn_blocking，整体受预算约束）（R4-C1 ② 的修法）**

```rust
let raw_headers = response.headers().clone();
let content_type = /* 同今天，从 raw_headers 取 */;
let plan = plan_content_encoding(&raw_headers);

let download_started_at = Instant::now();
let bytes = response
    .bytes()
    .await
    .map_err(|error| format_error_chain("Failed to read response body", &error))?;
let download = download_started_at.elapsed().as_millis() as u64;

// R5-I3：这个检查必须在创建 spawn_blocking 之前 —— 它防的不是网络超时，
// 而是「预算已耗尽却还去启动一个不可取消的解码任务」。
let decode_budget = ensure_budget_remaining(
    overall_deadline, Instant::now(), "decoding the response")?;        // §44
let decoded = {
    let ct = content_type.clone();
    // bytes 整体 move 进闭包；to_vec() 的那次完整拷贝因此发生在 timeout 内部。
    // rev4 在 spawn 之前 to_vec()，而原始响应字节没有上限、拷贝耗时远端可控 —— 那次拷贝在 timeout 之外。
    let handle = tokio::task::spawn_blocking(move || {
        finalize_response_body(bytes.to_vec(), plan, &ct)
    });
    let decode = async move {
        match handle.await {
            Ok(result) => result,
            Err(error) => Err(format!("Response decode task failed: {error}")),
        }
    };
    run_decode_within_budget(decode_budget, decode).await?              // §44
};
let headers = response_header_pairs(&raw_headers, decoded.dropped_encoding_headers);
```

`bytes` 是 `reqwest` 返回的 `bytes::Bytes`，直接 `move` 进闭包即可，**不需要给它命名类型、不需要新增 `bytes` 依赖**。`download` 仍然只覆盖 `.bytes()`（语义是传输耗时，不含拷贝与解码）。

**顺序是有意的，不能调换**：`ensure_budget_remaining` 在 `spawn_blocking` **之前**。rev5 曾把它删掉、只靠零预算 timeout 兜底，R5-I3 判定该理由不成立（`spawn_blocking` 不可取消，任务一旦启动就会在 timeout 返回之后继续烧 CPU；且零预算下计时器与内层任务的就绪顺序没有强保证）。恢复之后还有一个附带收益：走到 `run_decode_within_budget` 时 `decode_budget` 必然非零，那处零预算竞态被结构性排除。

**(10) `lib.rs:2435-2458` — 组装耗时与返回值**

```rust
let timings = build_timings(overall_started_at.elapsed(), dns_lookup, tcp_connect, download);

Ok(HttpResponse {
    status: status.as_u16(), status_text, headers,
    body: decoded.body, size: decoded.size,
    time: timings.total, timings, content_type,
    body_kind: decoded.body_kind,
})
```

`overall_started_at.elapsed()` 在解压 + 解码**之后**取，所以 `total` 覆盖：client 构建 + URL 构建 + 本地 body 准备 + 预探测（含黑洞地址上白等的时间）+ 建连发送 + 读体 + 解压解码。这正是用户实际等待的时间，且不由任何分段相加合成（§45）。

### 3.3 `src-tauri/Cargo.lock`（owner 裁定 A11 批准）

已跟踪文件，必须与 `Cargo.toml` **同一次提交**。**只允许由 `cargo` 自己生成，不得手工编辑。**

预期 diff（R3 已实测确认与下述预估一致）：

1. `apisolo` 包的 `dependencies` 数组（`Cargo.lock:63-84`）按字母序插入 `"brotli-decompressor"`、`"encoding_rs"`、`"flate2"` —— **+3 行**。
2. 新增一个 `[[package]]` 块，只有 `encoding_rs 0.8.35`（`dependencies = ["cfg-if"]`），含分隔空行 **+9 行**。
3. 其余包块不变；`cfg-if 1.0.4` 已在 `Cargo.lock:454`，无新传递依赖。

**合计 +12 行、0 删除、1 个新包条目、0 个新传递依赖、0 次版本变动。** tokio 的 feature 变更不影响锁文件（锁文件不记录 feature）。

**验收动作**：合并前跑 `git diff --stat src-tauri/Cargo.lock`；若实际 diff 明显大于上述数字（出现版本 bump 或多个新包），说明发生了意外重解析，必须查清再合。

## 4. Testing and validation

全部落在 `lib.rs:3067` 起的 `#[cfg(test)]` 模块内。运行方式恒为 `npm run test:rust`（`package.json:15`，含 `--test-threads=1`）。

**离线约束**：HTTP 用例一律用 `wiremock`；错误链用本机 `TcpListener` 绑 `127.0.0.1:0` 后立即 drop 取一个确定关闭的端口；**任何用例都不断言墙钟耗时**。预算相关的不变式（§38–§45）全部通过**纯函数**、**可注入的 connect 闭包**或 **`start_paused` 冻结时钟**做确定性验证。

**压缩 / 编码 fixture 必须是硬编码字节字面量**，由外部工具生成、注释里记下生成命令。统一负载文本：

```
{"repo":"tauri-apps/tauri","stars":12345,"描述":"跨平台桌面应用框架"}
```

生成命令：`printf '%s' "$PAYLOAD" | gzip -n -c | xxd -i`、`| brotli -c | xxd -i`、`| python3 -c 'import sys,zlib;sys.stdout.buffer.write(zlib.compress(sys.stdin.buffer.read()))'`（zlib）、`... zlib.compressobj(wbits=-15) ...`（裸 deflate）。多成员 gzip 用 `cat a.gz b.gz`。上限边界用 `python3 -c "import sys;sys.stdout.buffer.write(b'a'*1024)" | gzip -n -c`（与 1025 字节两份）。

**wiremock 陷阱（必须写进用例注释）**：`wiremock-0.5.22/src/request.rs:154` 会把 header 值按逗号切开再存进 `HeaderValues`。所以「线上只有一行 `Content-Type`」这类断言必须建立在**不含逗号**的取值上，否则断言会失真、变成假绿。断言方式：`received_requests()[0].headers.get(&name).unwrap().iter().count() == 1`。

`Request.url` 是 `url::Url`（`request.rs:139-143` + `http-1.4.0/src/uri/path.rs:361-371`），所以 `received.url.query()` 能区分 `None` 与 `Some("")`，§48 可在集成层直接断言。

**`tokio::time` 的求值顺序不足以构造确定超时**（R2 实测结论）：`timeout` 确实先 poll inner 再 poll delay，但零时长 timer 首次 poll 时可能返回 Pending，下一轮 inner 已 Ready 便抢先成功。因此 §40 与 §44 **必须**用 `#[tokio::test(start_paused = true)]` 冻结时钟，probe / decode 内用 `tokio::time::sleep(Duration::from_nanos(1))`。R2 已压力验证该方案（各 1000 次 × 10 轮，结果稳定）。

### 4.1 逐条不变式 → 测试 → 变异检查

「变异」列写的是**能编译通过、且只需一行**的实现改动。**标 ✅ 的表示本轮已真的应用并执行过**（见 §4.6）。§36 与 §49 没有有效 mutant，在行内与 §4.3 显式登记。

| § | 测试名 | 类型 | 变异检查（单行） |
|---|---|---|---|
| 1 | `test_decompress_gzip_response_body` | wiremock | `supported()` 表里删掉 `"gzip"` |
| 2 | `test_decompress_brotli_response_body` | wiremock | `supported()` 表里删掉 `"br"` |
| 3 | `test_decompress_deflate_zlib_response_body` | wiremock | deflate 分支跳过 `ZlibDecoder`、直接用 `DeflateDecoder` |
| 4 | `test_decompress_raw_deflate_stream` | unit | 删掉 `DeflateDecoder` 回退，`ZlibDecoder` 失败即 `Err` |
| 5 | `test_content_encoding_token_case_and_whitespace`（`" GZIP "` / `"Br"`）✅ | unit | 去掉 `to_ascii_lowercase()`（KCASE ✅，只杀本条） |
| 6 | `test_content_encoding_x_gzip_alias`（`"x-gzip"`）✅ | unit | 删掉 `"x-gzip"` 别名分支（KXGZIP ✅，只杀本条） |
| 7 | `test_decompress_multi_member_gzip` | unit | `MultiGzDecoder` 改成 `GzDecoder` |
| 8 | `test_decoded_response_drops_encoding_headers` | wiremock | `response_header_pairs` 忽略 `drop_encoding_headers`，恒不删 |
| 9 | `test_plan_content_encoding_table`（九行表，逐行断言并汇总失败行）✅ | unit | **见下方覆盖矩阵**（K1/K2/K3/K4/K5/K6/K7/K8，全部已实机执行） |
| 10 | `test_non_utf8_content_encoding_is_undecodable`（`HeaderValue::from_bytes(b"gzip,\x80")`）✅ | unit | 删掉 `to_str().is_err()` 守卫，让后面的 `unwrap_or("")` 把它变成空串（KI1，已执行） |
| 11 | `test_undecodable_encoding_is_kept_raw_and_marked_binary`（fixture 是**合法 UTF-8 且不含 NUL** 的字节；断言 marker + `bodyKind == binary` + 两个编码头仍在） | wiremock | `finalize_response_body` 里让 `Undecodable` 落到 `decode_response_body`，而不是强制 binary |
| 12 | `test_identity_or_absent_encoding_is_not_decompressed`（断言 `Plan::None` + 编码头**未**被删 + ASCII 正向对照；**不**断言与旧版本正文逐字节一致） | unit + wiremock | `plan_content_encoding` 对 `identity` 返回 `Undecodable`（K3，✅）／`response_header_pairs` 恒删头 |
| 13 | `test_corrupt_gzip_response_fails_with_named_encoding` | wiremock | 解码错误改为 `Ok((bytes, false))` 兜底 |
| 14 | `test_decompressed_body_at_the_limit_succeeds`（`limit = 1024`，解压后恰好 1024 字节）✅ | unit | 上限判定 `out.len() > limit` 改成 `>=`（KLIMIT_GE ✅，只杀本条） |
| 15 | `test_decompressed_body_over_the_limit_is_rejected`（`limit = 1024`，解压后 1025 字节）✅ | unit | **删除**那行 `out.len() > limit` 检查。（KLIMIT_DEL ✅，只杀本条。改 `take(limit+1)` 为 `take(u64::MAX)` **不是** killer） |
| 16 | `test_no_accept_encoding_header_is_added` | wiremock | 在 `execute_request` 里加一行 `.header(ACCEPT_ENCODING, "gzip")` |
| 17 | `test_response_charset_is_honored`（表驱动：`gb2312` / `gbk` / `shift_jis` / `iso-8859-1`，硬编码字节 + 期望文本）✅ | unit | `decode_response_body` 忽略 `content_type`，恒用 `UTF_8`（KENC_IGNORE ✅，只杀本条） |
| 18 | `test_charset_parameter_parsing`（表驱动，含 `xcharset=` 负向行）✅ | unit | 参数名比较去掉 `eq_ignore_ascii_case`（KCHARSET_EQ ✅）／改成 `contains("charset=")`（KCHARSET_CONTAINS ✅）；两者都只杀本条 |
| 19 | `test_response_without_charset_decodes_as_utf8` ✅ | unit | 默认编码 `UTF_8` 改成 `WINDOWS_1252`（KDEFAULT_1252 ✅ —— **实测同时杀掉 §19/§20/§21 三条**，见 §4.2） |
| 20 | `test_unrecognized_charset_label_falls_back_to_utf8` ✅ | unit | KDEFAULT_1252 ✅（非独占）。列出但**未执行**的备选：`for_label` 返回 `None` 时直接判二进制 |
| 21 | `test_undecodable_bytes_are_reported_as_binary`（PNG magic + `image/png`；并断言正文**不含** U+FFFD）✅ | unit | `enc.decode_without_bom_handling_and_without_replacement(bytes)` 改成 `Some(enc.decode_without_bom_handling(bytes).0)` —— 类型兼容的单行替换（KLOSSY ✅，只杀本条） |
| 22 | `test_response_with_nul_byte_is_binary`（`b"ok\0ok"`，合法 UTF-8）✅ | unit | 删掉 `bytes.contains(&0)` 守卫（KNUL ✅，只杀本条） |
| 23 | `test_empty_response_body_is_empty_text` | wiremock | 判定改成「解码结果为空即二进制」 |
| 24 | `test_response_size_is_post_decompression_byte_count` | wiremock | `size` 改回用压缩前的 `bytes.len()` |
| 25 | `test_form_data_sends_single_content_type_with_real_boundary` | wiremock | form-data 分支改用 `keep_first_header_value` |
| 26 | `test_form_urlencoded_keeps_user_content_type` | wiremock | form-urlencoded 分支改用 `keep_last_header_value` |
| 27 | `test_json_body_keeps_user_content_type` | wiremock | json 分支改用 `keep_last_header_value` |
| 28 | `test_raw_body_adds_no_content_type` | wiremock | 在 raw 分支加 `.header(CONTENT_TYPE, "text/plain")` |
| 29 | `test_bearer_auth_replaces_manual_authorization_header` | wiremock | auth 分支改用 `keep_first_header_value` |
| 30 | `test_auth_none_keeps_every_manual_authorization_header`（**两行**手写 `Authorization`，断言恰好两值且顺序不变） | wiremock | 去掉 `matches!(auth_type, "basic" \| "bearer")` 守卫，无条件 keep-last |
| 31 | `test_e2e_api_key_auth_header`（扩充 `lib.rs:4534`） | wiremock | `lib.rs:2333` 的 `insert` 改成 `append` |
| 32 | `test_json_body_is_sent_verbatim`（多行缩进 + 非字典序 key + 重复 key + 超长整数；断言字节完全相等） | wiremock | json 分支改回 `request.json(&parsed_value)` |
| 33 | `test_invalid_json_body_is_rejected_before_sending` | unit | 删掉 `serde_json::from_str` 校验行 |
| 34a | `test_format_error_chain_joins_every_source`（手写三层错误链） | unit | `format_error_chain` 只输出最外层 `Display` |
| 34b | `test_transport_error_includes_cause_chain`（已关闭的 loopback 端口）。断言**结构而非平台文案**：以 `Request failed: error sending request for url (` 开头，且第一个 `)` 之后仍有非空的 `": "` 分段。可选次级断言用 `"tcp connect error"`（`hyper-util-0.1.20/.../http.rs:787`，平台无关）；**不要**断言 OS 文案 | 集成 | 同 34a |
| 35 | `test_body_read_error_includes_cause_chain`（手写 `TcpListener`，回 `Content-Length: 100` 但只发几字节后断开） | 集成 | `lib.rs:2434` 改回 `format!("Failed to read response body: {error}")` |
| 36 | `test_probe_errors_are_swallowed`：`run_probe_within_budget(5s, async { Err("dns exploded".into()) }).await == (0, 0)` | unit | **无有效单行 mutant**——`measure_connection_timings` 的返回类型是 `(u64, u64)`，失败通道不可表达，要违反必须改签名（结构性改动）。本用例只钉住吞错那一支；载荷性保证是类型本身。见 §4.3。**rev3 用「已关闭 loopback 端口」的那条用例是假绿，已删除** |
| 37 | `test_connect_first_reachable_tries_every_address`（注入 connect：下标 0 `Err`、下标 1 `Ok`）✅ | unit | 循环改成只试 `addrs.first()`（KFIRST ✅ —— **实测同时杀掉 §37/§38**，见 §4.2） |
| 38 | `test_per_attempt_budget_is_shared_fairly`（`(5s,2)==2.5s`、`(5s,1)==5s`、`(ZERO,3)==ZERO`、`(5s,0)==ZERO`）+ `test_connect_first_reachable_gives_each_address_a_share`（注入 connect 记录收到的 budget） | unit | `per_attempt_budget` 返回 `remaining` 而不做除法（KFAIR ✅ —— **实测同时杀掉 §37/§38**） |
| 39 | `test_connect_first_reachable_stops_when_budget_is_exhausted`（`ZERO` 预算、两个地址、注入的 connect 一被调用就 `panic!`）✅ | unit | 删掉 `budget.is_zero()` 的提前返回（KZERO ✅，只杀本条） |
| 40 | `test_probe_budget_covers_the_whole_probe`（**`#[tokio::test(start_paused = true)]`**；probe 内 `sleep(1ns)` 后返回 `Ok((7,9))`。断言零预算 → `(0,0)`；同一用例正向对照 5s 预算 → `(7,9)`） | unit（冻结时钟） | `timeout(budget, probe)` 改成 `timeout(Duration::MAX, probe)` —— R2 已压力验证 mutant 确定返回 `(7,9)` |
| 41 | `test_probe_budget_never_exceeds_the_overall_remaining`（`probe_budget` 表：满预算→5s；剩 2s→2s；已过期→ZERO）✅ | unit（构造 `Instant`，不 sleep） | `probe_budget` 恒返回 `CONNECTION_PROBE_MAX`（KPROBE ✅） |
| 42 | **三层**：(a) `test_request_timeout_is_taken_from_the_remaining_budget` —— 造一个不发网络的 `Request`，`*built.timeout_mut() = Some(remaining)` 后断言 `built.timeout() == Some(&23s)`（R2 已实编译验证）；(b) `test_execute_flow_attaches_the_remaining_budget` —— **模型层**接线：断言装上去的是**剩余**预算而非常量 ✅（模型只能预演，见 §4.6 边界声明）；(c) `test_execute_request_honours_a_small_budget` —— `execute_request_with_budget(args, 500ms)` 打 `set_delay(5s)` 的 MockServer，断言 `Err` | (a)(b) unit ／ (c) wiremock | (a) 不写 `timeout_mut`（变 `None`）；(b) 装常量而非剩余（KWIRE2 ✅，且 (c) 也能抓到）；(c) 删掉 `timeout_mut` 赋值、或装常量。**「预算在 build 之前取值」没有任何真实用例能抓到 —— 已降级为 §4.3 缺口 #6，rev5 的 KWIRE3 ✅ 已撤销** |
| 43 | **两层**：(a) `test_exhausted_budget_is_rejected`（`ensure_budget_remaining` 纯函数：耗尽→`Err` 含 `budget exhausted`；剩 4s→`Ok(4s)`）✅；(b) `test_execute_request_with_zero_budget_sends_nothing` —— `execute_request_with_budget(args, ZERO)` 打活的 MockServer，断言 `Err` 含 `budget exhausted` **且 `received_requests()` 为空** | (a) unit ／ (b) wiremock（确定性，不看墙钟） | (a) 删掉 `remaining.is_zero()` 分支、保留 `Ok(remaining)`（KBUDGET ✅ **忠实版重跑：只杀 (a) 与 (b)，不杀 §42(b)**）；(b) 删掉发送前的 `ensure_budget_remaining` 调用、退回固定 30 秒（KWIRE1 ✅ —— **这正是 R4-C2 点名的、rev4 抓不到的那个缺陷**） |
| 44 | **两层**：(a) `test_exhausted_budget_is_rejected` 的同一个 `ensure_budget_remaining` 覆盖「预算耗尽时不启动解码任务」的判定（KBUDGET ✅）；(b) `test_decode_over_budget_fails_at_the_deadline`（**`#[tokio::test(start_paused = true)]`**；decode 内 `sleep(1ns)`。断言零预算 → `Err`；正向对照 5s 预算 → `Ok`） | (a) unit ✅ ／ (b) unit（冻结时钟，复用 §40 已验证的形状） | helper 层：`run_decode_within_budget` 里 `timeout(budget, decode)` 改成 `timeout(Duration::MAX, decode)`。**接线层无有效 mutant** —— 把 `run_decode_within_budget(...).await?` 改成 `decode.await?` 本用例仍绿，登记进 §4.3，不宣称已自动化证明 |
| 45 | `test_build_timings_uses_measured_total_not_the_sum`（`build_timings(500ms, 10, 20, 30)` → `total == 500`；配关系式断言 `total >= dns+tcp+download`）✅ | unit（纯函数） | `total: dns_lookup + tcp_connect + download`（KSUM，已执行——正是 rev2 会漏掉黑洞等待的写法） |
| 46 | `test_should_skip_connection_timings_when_proxy_enabled`（**沿用既有用例** `lib.rs:5218`） | unit | `should_measure_connection_timings` 恒返回 `true` |
| 47 | `test_build_timings_keeps_tls_and_ttfb_zero` ✅ | unit（纯函数） | `tls_handshake: 0` 改成 `tls_handshake: 1`（KTLS，已执行） |
| 48 | `test_request_target_has_no_trailing_question_mark`（含正向对照与「用户自己敲的 `?`」保留） | wiremock（断言 `received.url.query() == None`） | `build_request_url` 去掉「参数非空才进入」的守卫 |
| 49 | `test_finalize_response_body_is_runtime_independent`（普通 `#[test]`，**不带** `#[tokio::test]`） | unit | **无有效 mutant**，见 §4.3。该用例只证明「函数可脱离 runtime 调用」 |

#### §9 的 killer 覆盖矩阵（实机测得，非推理）

九行分别是：①无头 ②`identity` ③`" , , "` ④`identity, gzip` ⑤`gzip, br` ⑥两行 `gzip`+`br` ⑦`gzip, gzip` ⑧`gzip;q=1.0` ⑨`zstd`。

| killer（单行改动） | 实测杀掉的行 |
|---|---|
| K1 `get_all` → `get`（只读第一个字段） | ⑥ |
| K2 多 token 时取 `tokens[0]` 当 `Decode` | ⑤ ⑥ ⑦ |
| K3 不过滤 `identity` | ② ④ |
| K4 对 tokens 去重 | ⑦ |
| K5 在 `;` 处截断 token | ⑧ |
| K6 不过滤空 token | ③ |
| K7 空列表判成 `Undecodable` 而非 `None` | ① ② ③ |
| K8 单个未知 token 判成 `None`（「不认识就当没压缩」） | ⑧ ⑨ |

**如实声明（替换 rev3 那句被 R3 判错的话）**：九行**每一行至少有一个 killer**（①←K7；②←K3/K7；③←K6/K7；④←K3；⑤←K2；⑥←K1/K2；⑦←K2/K4；⑧←K5/K8；⑨←K8），但**并非一一对应，也并非互不遮蔽**。只杀单行的 killer 只有四个：K1→⑥、K4→⑦、K5→⑧、K6→③。因此**①②④⑤⑨ 没有独占 killer**。

特别记一笔：rev3 曾预测 K8 是 ⑨ 的独占 killer；实机执行显示它**同时**杀掉 ⑧（`gzip;q=1.0` 也是单个未知 token）。这条预测错误是执行发现的，不是推理发现的——正是 R3 结语指出的那类陷阱。

### 4.2 共用杀手的诚实声明

- **【rev3 归因撤回】** rev3 曾写「§36 的 mutant（把 `?` 加回）会同时杀死 §34b」。**这是错的**，且错得比表面更彻底：该 mutant 对任何一条都杀不掉。fixture 是已关闭的 loopback 端口，规格规定这种情况下探测返回 `Ok((dns_ms, 0))`，所以加不加 `?` 行为完全相同。rev4 已删除那条假绿用例，并把 §36 改成类型保证（§2.4.1）。§34b 的唯一 killer 就是「去掉原因链遍历」。
- **§8 与 §24** 都涉及解压后的呈现，但 §8 只断言 header 列表、§24 只断言 `size`，killer 互不覆盖。
- **§12 有两个断言、两个各自独立的 killer**（plan 判定 / header 保留），任一被杀即变红。
- **§17 / §19 / §20 / §21【实测修正】**：rev4 声称三者的 killer「互不遮蔽」。**实机执行推翻了这一点**：`KDEFAULT_1252`（默认编码改 windows-1252）**同时**杀掉 §19、§20、§21 三条——§21 之所以被牵连，是因为 PNG 魔数在 windows-1252 下是合法文本，于是被判成 text 而不是 binary。这是推理没想到的耦合。独占关系实测如下：`KENC_IGNORE`→只杀 §17；`KLOSSY`→只杀 §21；`KDEFAULT_1252`→§19+§20+§21。因此 **§19 与 §20 都没有独占 killer**。**§18** 打的是上游的 `charset_from_content_type`（`KCHARSET_EQ` / `KCHARSET_CONTAINS` 实测均只杀 §18），与上面四条正交。
- **§21 与 §22 的 guard-masking【实测确认】**：`KLOSSY` 只杀 §21（§22 仍绿，因为 NUL 守卫在解码之前就拦下了）；`KNUL` 只杀 §22。两者互为独占 killer，rev4 关于此处的判断经实测成立。§22 的用例已构造成「NUL 守卫是唯一能拒绝它的关卡」——`b"ok\0ok"` 本身是合法 UTF-8。
- **§37 与 §38【实测修正】**：rev4 把两者当作独立不变式各配一个 killer。**实测显示 `KFAIR`（不做除法）与 `KFIRST`（只试第一个地址）的杀伤集合完全相同**，都同时杀掉 `connect_first_reachable_tries_every_address` 与 `per_attempt_budget_is_shared_fairly`——因为不做除法时第一个地址吃满预算，第二个地址的预算归零、被 §39 的守卫挡下，于是「试了每个地址」也不成立。所以 **§37 与 §38 没有互相独立的 killer**，两条测试一起构成对「地址循环 + 预算切分」的联合护栏。如实记录，不再声称正交。
- **§42 与 §43 的接线层【实测 + rev6 更正】**：在**模型层**，`KWIRE1`（删掉发送前检查点）杀掉三条模型用例；`KWIRE2`（装常量）与 `KWIRE3`（位置放错）**杀伤集合相同**（都杀 `attaches_the_remaining_budget` + `reads_the_budget_after_build`），因此模型用例**不能区分**是哪一种缺陷。更重要的是 R5 的判定：**模型变红不等于生产接线被覆盖**——`KWIRE1` 与 `KWIRE2` 各自另有真实用例（§43(b)、§42(c)）能抓到，`KWIRE3` **没有**，因此只有 KWIRE1/KWIRE2 算被证明，KWIRE3 降级为 §4.3 缺口 #6。
- **§9 / §10 / §11 的分工**：§9 锁判定规则（覆盖矩阵见上）；§10 锁畸形头不退化（KI1 只杀 §10，已实测）；§11 锁「判定为 Undecodable 之后的三条后果」，其 fixture 刻意是合法 UTF-8 且不含 NUL，因此 §21/§22 的守卫都**放行**它，只有强制分支能让它变 binary。三条互不遮蔽。
- **§14 与 §15** 共用同一个上限判定，**实测确认**独占 killer 分别是 `KLIMIT_GE`（`>`→`>=`）与 `KLIMIT_DEL`（删掉该检查），互不覆盖。
- **§45 与 §47** 共用 `build_timings`。**实测确认互不覆盖**：KSUM 只杀 §45 的用例，KTLS 只杀 §47 的用例。
- **§41 / §43 / §44 三条预算不变式**打的是三个不同函数（`probe_budget` / `ensure_budget_remaining` / `run_decode_within_budget`）。**【rev6 撤回并更正】** rev5 写「`KBUDGET` 同时杀掉全部三条接线用例」，那是**在一个不忠实的 mutant 上测出来的**（rev5 的 KBUDGET 同时做了「删检查」和「返回常量」两件事）。改成忠实的单行删除（保留 `Ok(remaining)`）后重跑，真实杀伤集合是 **2 条**：`exhausted_budget_is_rejected` 与 `execute_flow_does_not_send_when_budget_is_exhausted`；`..._attaches_the_remaining_budget` 与 `..._reads_the_budget_after_build` **保持绿色**。详见 §4.7。§41 的 `KPROBE` 实测只杀 §41。

### 4.3 验证缺口登记（不得同时宣称评审把关与自动化证明）

以下**六处**明确没有有效的自动化变异检查，只由类型或代码评审把关。登记在此以免日后被当成「已被测试覆盖」：

1. **§36 — 「探测不能决定请求成败」。** 载荷性保证是 `measure_connection_timings` 的返回类型 `(u64, u64)`：失败通道在类型上不可表达。要违反它必须同时改签名、改内部错误传播、改调用点——不是单行 mutant。评审检查点：`grep -n "measure_connection_timings" src-tauri/src/lib.rs` 的调用点那一行**不得**出现 `?` / `unwrap_or` / `expect` / `map_err`。配套用例 `test_probe_errors_are_swallowed` 只钉住 `run_probe_within_budget` 的吞错分支，其 mutant 只能是换一个 sentinel 值（弱 mutant，如实标注）。
2. **§49 — `finalize_response_body` 的调用点确实包在 `spawn_blocking` 里。** 唯一想得到的 mutant（改成 `async fn`）会让生产调用点自己编译失败，测试对该信号无贡献。评审检查点：`grep -n "finalize_response_body" src-tauri/src/lib.rs` 应当只有定义、`spawn_blocking` 内的那一次调用、以及测试。
3. **§45 的 `overall_started_at` 取值位置。** `build_timings` 的纯函数语义已被 KSUM 钉死（实测），但「传进去的 `overall_elapsed` 真的是从 `execute_request_with_budget` 第一行起算」是一行赋值，没有非脆弱的自动化断言。评审检查点：`overall_started_at` 的声明必须是 `execute_request_with_budget` 的第一行、早于 `Client::builder()`，且 `overall_deadline` 由 `total_budget` **参数**算出（写成 `REQUEST_TOTAL_BUDGET` 常量会让注入 seam 失效、把 §43(b) 变成假绿）；`execute_request` 内不得出现任何 `Instant::now()`，`execute_request_with_budget` 内不得再出现第二个用于 `total` 的 `Instant::now()`（原 `lib.rs:2406` 的 `started_at` 必须被删除）。配套关系式断言（`total >= dns + tcp + download`）加进 `test_send_request_real_http`（`lib.rs:3824`）作为弱护栏。
4. **【rev5 新增，R4-C2】§44 的解码接线** —— 「`run_decode_within_budget(...)` 真的包住了解码任务」。把它改成 `decode.await?` 之后，§44 的冻结时钟用例**仍然全绿**（它测的是 helper 自己）。无法自动化的原因见 §2.6.3：要让解码撞线就得让解码慢于剩余预算，而剩余预算同时是 HTTP 阶段的 timeout——网络会先超时，解码到不了。评审检查点：`grep -n "run_decode_within_budget\|spawn_blocking" src-tauri/src/lib.rs`，解码那一处必须是 `run_decode_within_budget(decode_budget, decode).await?` 而**不是**裸 `.await?`；并确认 `bytes` 是 move 进闭包的、`to_vec()` 在闭包**内部**。
5. **【rev5 新增】§41 的探测预算接线** —— `probe_budget(...)` 的返回值真的被传给了 `measure_connection_timings`。纯函数已被 `KPROBE` 钉死（实测），但「调用点确实传的是它而不是常量」没有用例覆盖（零预算下探测本来就返回 `(0,0)`，与传常量在可观测行为上无差别）。评审检查点：`measure_connection_timings(&url, probe_budget(overall_deadline, Instant::now()))` 这一行不得退化成 `CONNECTION_PROBE_MAX`。

6. **【rev6 新增，R5-CRITICAL】§42 的「预算读取位置在 build + 归一化之后」。** 没有任何真实用例能区分它与「在之前读取」——500ms/5s 那条用例两种实现都在约 500ms 返回 `Err`。rev5 曾用平行模型的 `KWIRE3` 声称已证明，**该声明已撤销**（理由与不采用注入时钟的权衡见 §2.6.4）。评审检查点：读 `finish_request_with_deadline` 这一个函数，四条语句的顺序必须是 `build()` → `normalize_auto_headers` → `ensure_budget_remaining` → `*timeout_mut() =`；并确认 `execute_request_with_budget` 里没有第二处读取 HTTP 预算的地方。

**另记两处已知的弱 mutant**（不是缺口，但强度不足）：§36 的 `test_probe_errors_are_swallowed`，以及所有「错误串内容」断言——其 mutant 都只能是改字面量，属于弱变异；价值在于锁住契约文本，不在于强度。

### 4.4 现有用例的影响

- `test_serde_frontend_json_compat_response`（`lib.rs:4035-4060`）用结构体字面量，新增 `body_kind` 后**编译不过**，必须补齐；同时加 `assert!(json.contains("\"bodyKind\""))`。
- `test_send_request_post_json`（`lib.rs:3884`）的输入本就紧凑且字典序，改为逐字节透传后 `body_json` 匹配器仍通过。
- `test_e2e_form_urlencoded`（`lib.rs:4732`）没有用户 CT 行，`keep_first` 是空操作，匹配器仍通过。
- `test_send_request_real_http`（`lib.rs:3824`）的 `response.time <= response.timings.total` 仍成立；按 §4.3 第 3 条追加 `total >= dns + tcp + download`。
- `test_send_request_rejects_{binary,form_data}_raw_file_paths_for_local_tauri`（`lib.rs:4884` / `:4928`）与 dev bridge 侧（`:5107` / `:5140`）不受影响——本切片一行都不碰 `resolve_binary_body_bytes`（`:2465`）与 `add_form_data_part`（`:2507`）。

### 4.5 交付前必须自己重跑

`npm run release:check`（`package.json:19`）。声称完成之前，由做这个切片的人自己跑一遍并贴出结果。落地第一步是 `cargo fetch`（`encoding_rs` 是新依赖），最后一步是核对 `git diff --stat src-tauri/Cargo.lock` 是否落在 §3.3 的预估内。

### 4.6 变异实证记录（rev4 新增；rev5 按 R4-I1 改为完整分类；rev6 按 R5-I2/CRITICAL 更正）

R3/R4 反复指出同一个根因：写 killer 时人在**推理**而不是在**执行**。本节记录实际执行结果，并**完整**登记未执行项——R4 判定「选择性枚举比不枚举更误导」，rev4 只列了 wiremock 层与两个冻结时钟用例，且把 §4 错归进 wiremock，已改正。

**方法**：在仓库外（`/tmp`，不入库、不影响工作树）建最小 crate，依赖真实的 `http` / `encoding_rs` / `flate2`（全部离线取自本机 registry 缓存），按本文 §2.1 / §2.2 / §2.6 的算法实现对应函数并写下用例；每个 mutant 用 `#[cfg(kN)]` 表达，`RUSTFLAGS="--cfg kN" cargo test --offline` 逐个应用执行。工具链 rustc 1.95.0。**基线 22 个用例全绿；29 个 mutant 全部产生红灯，无一存活。**

#### 已执行（29 个 mutant，覆盖 20 条不变式）

| mutant | 对应 § | 实测变红的用例 |
|---|---|---|
| K1 `get_all`→`get` | 9 | `plan_table` 第⑥行 |
| K2 多 token 取首项 | 9 | `plan_table` 第⑤⑥⑦行 |
| K3 不过滤 identity | 9, 12 | `plan_table` 第②④行 |
| K4 去重 | 9 | `plan_table` 第⑦行 |
| K5 `;` 截断 | 9 | `plan_table` 第⑧行 |
| K6 不过滤空 token | 9 | `plan_table` 第③行 |
| K7 空列表→Undecodable | 9 | `plan_table` 第①②③行 |
| K8 单个未知→None | 9 | `plan_table` 第⑧⑨行 |
| KCASE 去掉 `to_ascii_lowercase` | 5 | `content_encoding_token_case_and_whitespace` |
| KXGZIP 删掉 `x-gzip` 别名 | 6 | `content_encoding_x_gzip_alias` |
| KI1 删掉非 UTF-8 守卫 | 10 | `non_utf8_content_encoding_is_undecodable` |
| KLIMIT_GE `>` 改 `>=` | 14 | `decompressed_body_at_the_limit_succeeds` |
| KLIMIT_DEL 删掉上限检查 | 15 | `decompressed_body_over_the_limit_is_rejected` |
| KCHARSET_EQ 用 `==` | 18 | `charset_parameter_parsing` |
| KCHARSET_CONTAINS 用子串匹配 | 18 | `charset_parameter_parsing` |
| KENC_IGNORE 忽略 content_type | 17 | `response_charset_is_honored` |
| KDEFAULT_1252 默认改 windows-1252 | 19, 20, 21 | `response_without_charset_decodes_as_utf8`、`unrecognized_charset_label_falls_back_to_utf8`、`undecodable_bytes_are_reported_as_binary` |
| KLOSSY 换成有损解码 | 21 | `undecodable_bytes_are_reported_as_binary` |
| KNUL 删掉 NUL 守卫 | 22 | `response_with_nul_byte_is_binary` |
| KFIRST 只试第一个地址 | 37, 38 | `connect_first_reachable_tries_every_address`、`per_attempt_budget_is_shared_fairly` |
| KFAIR 不做除法 | 37, 38 | 同上 |
| KZERO 删掉预算耗尽提前返回 | 39 | `connect_first_reachable_stops_when_budget_is_exhausted` |
| KPROBE `probe_budget` 恒返回上限 | 41 | `probe_budget_never_exceeds_remaining` |
| KBUDGET 删掉 `remaining.is_zero()` 分支（**rev6 忠实版重跑**） | 43, 44(a) | `exhausted_budget_is_rejected`、`execute_flow_does_not_send_when_budget_is_exhausted` —— **只有 2 条**；rev5 记的「4 条」是不忠实 mutant 的产物，已撤回（§4.7） |
| **KWIRE1 删掉发送前检查点、退回固定 30 秒** | **43 接线** | `execute_flow_does_not_send_when_budget_is_exhausted`、`..._attaches_the_remaining_budget`、`..._reads_the_budget_after_build` |
| **KWIRE2 装常量而非剩余预算** | **42 接线** | `..._attaches_the_remaining_budget`、`..._reads_the_budget_after_build` |
| ~~KWIRE3 预算在 build 之前取值~~ | ~~42 接线~~ | 模型层变红（同 KWIRE2），但**真实用例抓不到** —— R5-CRITICAL 判定该证明无效，已降级为 §4.3 缺口 #6，不再计入「已证明」 |
| KSUM `total` 改回分段相加 | 45 | `build_timings_uses_measured_total_not_the_sum` |
| KTLS `tls_handshake: 1` | 47 | `build_timings_keeps_tls_and_ttfb_zero` |

**KWIRE1/2 是本轮的重点**：它们对应 R4-C2 指出的「漏接」与「绕过」两种生产接线缺陷，而且**各自都有真实用例支撑**——KWIRE1 被 §43(b)「零预算 + MockServer 没收到请求」抓到，KWIRE2 被 §42(c)「500ms 预算对 5s 延迟必须 `Err`」抓到。模型跑是预演，真实覆盖独立成立。

**KWIRE3（位置放错）不同，必须单独说清楚**：它只在平行模型 `execute_flow(total_budget, clock, trace)` 里变红，而那个模型把 build 前的时刻硬编码成 `Duration::ZERO`，从未执行真实的 `.build()` / 归一化；规划中的真实用例也区分不了两种实现。R5 判定这是 R4-C2 那条 helper/model 假绿的复发。**rev6 撤回该证明**，改为 §4.3 缺口 #6 + §2.6.4 的结构收紧。**一般原则记在这里**：平行模型只能证明「测试形状能抓住缺陷形状」，永远不能替代对生产接线本身的覆盖。

#### 执行推翻的预测（推理没发现、执行发现的）

1. **K8** —— rev3 预测它是第⑨行的独占 killer；实测同时杀掉第⑧行（`gzip;q=1.0` 也是单个未知 token）。已在 §4.1 覆盖矩阵改正。
2. **KDEFAULT_1252** —— rev4 预测只杀 §19；实测杀 §19+§20+§21。§21 被牵连是因为 PNG 魔数在 windows-1252 下是合法文本，于是被判 text 而非 binary。已在 §4.2 改正。
3. **KFAIR / KFIRST** —— rev4 把 §37 与 §38 当作正交，各配一个独占 killer；实测两个 mutant 的杀伤集合**完全相同**。已在 §4.2 改正为「联合护栏」。
4. **KBUDGET** —— rev4 预测只杀 §43 的纯函数用例；rev5「实测」为 4 条，**但那次测量用的是不忠实 mutant**（§4.7）。rev6 用忠实的单行删除重跑：真实杀伤集合是 **2 条**（`exhausted_budget_is_rejected` + `execute_flow_does_not_send_when_budget_is_exhausted`）。**这一条同时是「实跑也会骗人」的样本**：mutant 不忠实时，输出与真实测量在形式上完全无法区分。
5. **KWIRE2 与 KWIRE3** —— 杀伤集合相同，两条接线用例无法区分是哪种缺陷。已在 §4.2 如实记录。

#### 未执行清单（完整枚举——本轮**只**执行上表 29 个，其余全部未执行）

**(A) unit / 纯函数，实现落地后可立即执行，本轮未执行**：§4（裸 deflate 回退）、§7（多成员 gzip）、§12 的 header 保留断言、§20 列出的**备选** killer（`for_label` 返回 `None` 时直接判二进制——§20 本轮是被 KDEFAULT_1252 连带杀掉的，这个备选 mutant 本身未跑；**R5-M2 指出的遗漏项**）、§33（非法 JSON 预拒）、§34a（错误链遍历）、§36（`run_probe_within_budget` 吞错）、§42(a)（`Request::timeout()` getter —— **R2 已独立实编译验证过该断言可用**，但本轮未跑 mutant）、§46（`should_measure_connection_timings`，既有用例）。

**(B) 冻结时钟（`#[tokio::test(start_paused = true)]`），本轮未执行**：§40（探测预算覆盖整段）、§44（解码预算，helper 层）。**注**：§40 的方案形状已由 R2 独立压力验证（基线与 `Duration::MAX` mutant 各 1000 次 × 10 轮），但那是 R2 跑的、不是本轮跑的，也不是对本文最终写法跑的。

**(C) wiremock 集成层，依赖尚不存在的产品代码，本轮未执行**：§1、§2、§3、§8、§11、§13、§16、§23、§24、§25、§26、§27、§28、§29、§30、§31、§32、§34b、§35、§42(c)、§43(b)、§48。（§43(b) 的等价逻辑已由 KWIRE1 在模型层验证，但真实的「MockServer 没收到请求」断言未跑。）

**(D) 结构性缺口，没有有效 mutant**：§36 接线、§42 的「预算读取位置在 build + 归一化之后」（rev6 新增，= §4.3 缺口 #6）、§44 接线、§45 的 `overall_started_at` 位置、§41 的探测预算接线、§49。**六项**，全部登记在 §4.3。

**边界声明（rev6 收紧）**：上表的 mutant 是在**模型代码**上执行的，不是在最终产品代码上。模型证明的是「这些算法与这些用例配对时，mutant 会被抓到」，**不是**「产品实现是对的」，**更不是**「生产接线是对的」——KWIRE3 就是模型变红而真实用例抓不到的活例子（见上）。实现落地后必须按 `mutation-ledger` 的口径在真实代码上重跑全表并记录红灯；**本节结果不得冒充全量覆盖**。

### 4.7 mutant 忠实性审计（rev6 新增，应 R5-I2）

R5 发现 rev5 的 `KBUDGET` **不是它自己描述的那个单行改动**：文档写「删掉预算耗尽检查」，实现却是 `return Ok(REQUEST_TOTAL_BUDGET)` —— 同时做了「删检查」和「把剩余预算换成常量」两件事。于是它多杀了两条接线用例，而文档把这个虚高的杀伤集合当成了实测结果。

**这一条比它表面严重**：本切片最近几轮最大的贡献是「实跑推翻推理」，而这里是**实跑本身被一个不忠实的 mutant 污染了**，且污染后的输出与真实测量长得一模一样。

**已做的处置：**

1. **改成忠实形态并重跑**：`ensure_budget_remaining` 保留 `let remaining = remaining_budget(...)` 与 `Ok(remaining)`，只删掉 `if remaining.is_zero() { return Err(...) }` 这一个分支。重跑结果——基线 6/6 绿；忠实 KBUDGET 下 **2 条变红**（`exhausted_budget_is_rejected`、`execute_flow_does_not_send_when_budget_is_exhausted`），`..._attaches_the_remaining_budget` 与 `..._reads_the_budget_after_build` **保持绿色**。与 R5 独立重建的结论一致。
2. **逐个复核其余 28 个 mutant 的忠实性**：K1–K8、KCASE、KXGZIP、KI1、KLIMIT_GE、KLIMIT_DEL、KCHARSET_EQ、KCHARSET_CONTAINS、KENC_IGNORE、KDEFAULT_1252、KNUL、KLOSSY、KFAIR、KZERO、KFIRST、KPROBE、KSUM、KTLS、KWIRE1、KWIRE2、KWIRE3 —— 逐个对照「文档描述的改动」与「`#[cfg]` 分支的实际语义」，**未发现第二处不一致**。KWIRE1 的描述本身就写明「退回固定 30 秒」（R4 原话），所以它捆绑两处效果是**描述与实现一致**的，不算不忠实；但它因此不是最小 mutant，如实标注。
3. **写成规则**：任何写进本文的 killer，`#[cfg]` 分支必须是描述里那一处改动的**最小实现**，不得顺手改第二处；两处改动就要拆成两个 mutant。落地阶段跑 `mutation-ledger` 时同样适用——一个 mutant 多改一行，测出来的杀伤集合就是假的。

4. **规则的唯一已知例外，连同理由一起写在这里**（R6 指出：规则和它自己的例外必须同时可见，否则规则会悄悄豁免自己）：**`KWIRE1` 捆绑了两处效果**（删掉发送前检查点 **且** 退回固定 30 秒），按第 3 条的最小性要求本应拆成两个 mutant。**保留不拆**，因为它复刻的是 R4-C2 原话描述的那个真实生产缺陷形态——「删掉生产代码里的 `ensure_budget_remaining(...)`、改回固定 30 秒」——删掉调用之后总得给 `http_budget` 一个值，固定 30 秒正是最自然的退化写法。它与第 3 条的区别在于：**KBUDGET 的问题是描述与实现不符**（描述只说删检查，实现却多换了一个常量，于是杀伤集合虚高且无人察觉）；**KWIRE1 的描述与实现完全一致**，读者不会被误导。代价如实记：它不是最小 mutant，所以「KWIRE1 变红」不能单独归因于哪一处改动。

## 5. Risks and rollback

### 5.1 会改变「今天就能正常工作的请求」的线上字节 / 可见行为

| 改动 | 谁受影响 | 风险评估 |
|---|---|---|
| 去掉尾随 `?`（§48） | 每一个零参数请求 | 与 curl / Postman 对齐。只有对 request-target 做精确字符串匹配的 CDN 缓存键 / WAF 规则才可能感知。极低。 |
| form-urlencoded 的 `Content-Type` 不再重复（§26） | Headers 表里自带 CT 的请求 | 首值优先的服务端看到的值不变；**末值优先**的服务端此前看到应用的值，现在看到用户的值。这正是要修的东西。 |
| form-data 的 `Content-Type` 收敛到真实 boundary（§25） | Headers 表里自带 multipart CT 的请求 | 只可能把坏的变好。 |
| **`Authorization` 由 Auth 面板胜出（§29）** | 同时手写 `Authorization` **且** Auth 面板不是 `none` 的用户 | **唯一一处真正的回归风险。** 触发条件是自相矛盾的配置，逃生口是把面板切回 `none`（一次点击）。 |
| JSON body 逐字节透传（§32） | 所有 json body 请求 | 字节顺序与空白变化 + `Content-Length` 变化。JSON 语义上顺序无关，能成的仍能成；对原始报文体做签名的接口从「一定失败」变成「能成」。 |
| **HTTP 请求的可用超时缩短为「30 秒减去已用」（§42）** | 探测/准备耗时不可忽略、且服务端响应极慢的请求 | 这是 §41 的必然代价，也是「用户最长等 30 秒」的对价。 |
| **【rev4 新增】预算耗尽时请求根本不发出（§43）** | 本地准备阶段极慢（超大内联附件）的请求 | 今天这类请求会照发不误、总等待可达 60 秒以上；之后会以明确错误快速失败。行为变化明显，但方向是从「无声超时」变成「说清楚为什么」。 |
| **解码超预算时放弃已收到的响应（§44）** | 收到接近 64 MiB 且解码极慢的压缩响应 | 一个本来能成功（只是慢）的响应会失败。实际触发概率很低——常规 gzip/brotli 在 64 MiB 上限内的解码远快于秒级；真正会撞线的是病态压缩流，而那正是要拦的。 |
| **【rev5 新增】HTTP 阶段的可用超时再缩短一点（§42）** | 请求构建 / header 归一化耗时不可忽略的请求（超大 multipart） | 预算改在构建之后取值，构建耗掉的时间不再被重复留给 HTTP 阶段。方向是更诚实，但极端情况下 HTTP 阶段可用时间比 rev4 更短。 |
| **【rev5 新增】响应体拷贝纳入解码预算（§44）** | 收到巨大响应体的请求 | 那次 `to_vec()` 完整拷贝以前在 timeout 之外、耗时远端可控；现在被计入并受约束。可能让一个「拷贝极慢」的巨大响应失败，而 rev4 会让用户一直等。 |
| **`total` 变大**（§45） | 所有请求 | 现在包含探测、黑洞等待、本地准备与解码耗时。数值往上走，但这才是用户实际等待的时间；旧值是偏小的合成量。 |
| 预探测多试一个地址（§37） | 多地址主机 | 第一个地址不可达时会再连一次靠后的地址，服务端连接计数 +1。 |
| 响应头里 `Content-Encoding` / `Content-Length` 在解压成功后消失（§8） | 收到压缩响应的用户 | 显示层变化，不是线上字节变化。 |

**明确不会变的**：`Accept-Encoding` 依旧只由用户决定（§16 是护栏）；`accept: */*`、重定向策略、`.no_proxy()`、代理构造、TLS 校验开关、raw / binary / form-data 的报文体字节、api-key 的两种投放方式——全部不变。预探测仍然每次发送多开一条 TCP 连接（不移除它是 §47 的前提）。

### 5.2 压缩炸弹 —— 本切片新增的失败模式

**如实回答：本切片确实让「响应体无上限、全量读进内存」这条已知债变严重了。** 今天攻击者要耗掉 N 字节内存必须真的传 N 字节；解压之后，一段 10 MB 的全零 gzip 能展开成约 10 GB，brotli 的最坏放大比更高。这是**今天不存在**的失败模式。

**结论：解压输出的上限属于本切片（§14/§15），未压缩响应体的上限交给后续切片。** 上限是本切片自己制造的问题的解药；原样返回路径的上限是继承来的债，给它加上限会改变今天能正常工作的大响应下载行为，且需要前端截断提示（`ResponseBody.vue` 已有 500 000 字符的**显示**截断，那是渲染层不是内存层）。

**64 MiB 是一个明确的安全取舍，不是「大到没人会碰到」**：批量导出、日志查询、大 JSON 报表接口都可能超过它。取舍两端是「最坏单次分配可控」与「拒绝一个本来合法的巨大压缩响应」，本切片选前者，并接受两个可见后果：①超限时报错而不是静默截断；②同一份逻辑正文会出现「identity 成功、gzip 失败」的传输编码差异（未压缩路径不设限、压缩路径限 64 MiB）。彻底消除后者需要给两条路径设统一上限（§6）。

**rev4/rev5 补上的一半**：rev3 曾记录「上限约束内存不约束 CPU，病态 brotli 流仍能烧数秒且取消不生效」。§44 的解码预算给这个残余风险画了上界；rev5 进一步把 `bytes.to_vec()` 那次完整拷贝也移进了受约束的范围（R4-C1②），否则一次远端可控的大拷贝仍能在 timeout 之外跨过 deadline。仍然残留的是：`spawn_blocking` 无法取消，所以超时后那个线程会继续跑到自己结束（我们已经不等它了）；而且结束时刻是「到点后尽快」而非精确切断（§2.6.1）。

**其余残余风险**：`response.bytes()` 读进来的**压缩前**字节仍无上限，10 GB 的压缩流照样能 OOM——与今天完全相同。

### 5.3 其他风险

- **`encoding_rs` 需要一次联网 `cargo fetch`**，且 `Cargo.lock` 必须同步提交（§3.3）。
- **`spawn_blocking` 派生的任务无法取消**（探测与解码都是）。超时后那些线程会继续占用到自己返回；不影响请求结果，只是 blocking 线程池的短期占用。
- **`.build()` + `execute()` 替换 `.send()`**。语义等价，但这是结构改动；`test_cancel_request_aborts_in_flight`（`lib.rs:4978`）依赖的 abort 路径在 `send_request`（`:2233`），不受影响。
- **`decode_without_bom_handling_*` 会保留正文开头的 BOM**（与今天的 `from_utf8_lossy` 一致，不是回归）。列为非目标。
- **二进制 / 未解码占位串是英文**，与后端其余错误串一致，但出现在**正文**位置。本地化需前端消费 `bodyKind` 后自行渲染（§6）。
- **`tokio` 的 `test-util` 依赖 resolver 2 的行为**。若将来有人把 edition 或 resolver 改回 1，`test-util` 会泄进发布二进制。§3.1 已写明理由。
- **本地准备阶段不可中断**（§2.6.1 的诚实边界）。单独一步超过 30 秒的准备工作会跑完；其时长只取决于用户自己给的输入大小。

### 5.4 Rollback

四段可以独立回退：

1. **解压 + 解码**（`Cargo.toml` 三行 + `Cargo.lock` 对应条目 + `plan_content_encoding` / `decompress_*` / `decode_response_body` / `finalize_response_body` / `response_header_pairs` / `HttpResponse.body_kind`）：整体撤掉即回到 `String::from_utf8_lossy`。
2. **header 归一 + JSON 透传 + 尾随 `?`**：撤掉即回到追加语义。
3. **统一预算 + 实测 total**（`remaining_budget` / `probe_budget` / `ensure_budget_remaining` / `run_decode_within_budget` / `build_timings` / `overall_started_at` / `execute_request_with_budget` seam / `timeout_mut` 赋值）：撤掉即回到 client 级 30 秒 + 合成 total。可独立于第 4 段回退。**注意**：若只回退这一段而保留第 1 段，解码就重新失去 CPU 维度的上界（§5.2）。
4. **预探测 + 错误链**：**必须一起回退**。只回退错误链而保留预探测改造，会让「连接被拒 / DNS 失败」重新退化成同一句无用信息（§1.3 第 3 条）。`Cargo.toml` 里的 tokio `"time"` / dev `"test-util"` 可以留着。

## 6. 跨切片依赖与后续项

**必须由别的切片承接（本切片不碰）：**

1. **二进制响应的前端呈现**：消费新增的 `bodyKind`，在 `src/components/response/ResponseBody.vue` 渲染本地化的「二进制响应 / 压缩未解码」提示，并在 `src/types/index.ts:143-153` 的 `HttpResponse` 接口补上该字段。若还要「另存为文件 / 查看 base64」，需要后端再加 `bodyBase64` 字段——本切片刻意不加没人消费的字段。

2. **`bodyKind` 的历史持久化与重放**。当前历史只保存正文字符串（`HistoryEntry.response_body`，结构体在 `lib.rs:245` 起；前端 `buildHistoryEntry` 写入、`openHistoryEntry` 读回）。不同步 `bodyKind` 会导致二进制响应从历史回看时重新被当普通文本渲染——本切片刚修好的谎言在历史面板里原样复活；且 marker 字符串一旦落盘就与真实服务端文本不可区分。完整依赖三处、必须一起做：**(a)** `HistoryEntry` 增加 `responseBodyKind`，用 `#[serde(default)]` 让旧记录默认 `"text"`（与 `lib.rs:4063` 起的旧格式兼容测试同一套路）；**(b)** 前端写历史时带上它；**(c)** 前端从历史恢复时填回。按 R1 裁定归 **D03 边界**；注意 **D07b** 也在往 `history.jsonl` 同一行加字段（`note` / `starred`），两者应合并成一次 schema 变更。

3. **`Authorization` 优先级规则要写进 README 与 UI**：决策不写进 README 和界面，下一轮扫描会当高危 bug 重新报上来。涉及 `README.md` / `README.zh-CN.md` / `src/i18n/*.ts` / Auth 面板组件。

4. **`src/utils/curl-parser.ts:176` 静默丢弃 `--compressed`**：同一个头条 bug 的另一半——导入保留了「请求压缩」的意图，却扔掉了「要解压」的意图。前端缺陷，**应当归入 D06**，而 D06 当前的表里没有它。建议补一行。

**本切片内已识别、明确不做的后续项：**

5. **zstd 解压**（§2.1）。纯增量：`ContentEncoding` 加一个变体 + `supported()` 加一行 + 一个解码器 + §9 表驱动用例加一行。
6. **`.multipart()` 追加的 `Content-Length` 重复**（`reqwest-0.12.28/src/async_impl/request.rs:328-331`）。用同一个 `keep_last_header_value` 一行就能修，但不在 backlog 这一行的范围内。
7. **未压缩响应体的内存上限**，以及给两条路径设**统一上限**以消除 §5.2 的 identity/gzip 不一致。
8. **流式解压 + 分块让出**：消除 §5.3 的「`spawn_blocking` 超时后线程仍在跑」，同时能让 §49 从「评审把关」升级成可自动化验证的不变式。
9. **让本地准备阶段可被中途打断**（§2.6.1 的诚实边界）：把 body 编码工作拆成可让出的分块，消除「单步准备超过 30 秒」这个唯一的预算漏口。
10. **错误信息里回显的 URL 携带查询串密钥**：`Request failed: ... for url (https://x/?api_key=SECRET)` 今天就会外泄，原因链改造不改变这一点。属 D01 的脱敏边界。
