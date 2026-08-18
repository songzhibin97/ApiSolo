# 问题 1 深挖：cookie 显示 [redacted] 与「没正常载荷到」

## 结论

是，真实 cookie 确实发到了线上。你在 tab 里手打/粘贴的 header 值，从编辑器到 reqwest 的 HeaderMap 全程没有任何脱敏——脱敏只发生在 buildHistoryEntry 生成的那一份"历史副本"上（src/stores/request.ts:468 → :545），tab 自身的 state 在发送后完全没被改写（request.ts:149-154 只写 response/scriptResult/isLoading）。我用真实代码跑了一次端到端验证：发送时 send_request 的 payload 里 header 值是 "sid=abcdef123456; theme=dark"（原值），而同一次写进 history 的是 "[redacted]"。

但你的直觉指向了一个真实的 bug，只是位置不同：**从历史记录点开的那个 tab，会把字符串 "[redacted]" 当成真值再发出去**。src/stores/tabs.ts:356 用 createEditablePairs 原样还原 entry.requestHeaders，Rust 侧 HeaderValue::from_str("[redacted]") 是合法的（http-1.4.0/src/header/value.rs:557），于是线上真的出现 `Cookie: [redacted]`。你自己的 history.jsonl 第 87-91 行就是现场：87（17 个 header、1 个 Cookie）401 → 88-91（18 个 header、2 个 Cookie，第 18 个是你手工补的）连续 4 次 401 → 93（删到只剩 1 个 Cookie）200。

## 完整代码追踪

【A. 你输入的 cookie → 线上（结论：原值上线，无脱敏）】
1. src/components/request/KeyValueEditor.vue:113 `:value="row.value"` + :60-62 updateText → emit update:modelValue（普通可编辑 input，没有任何只读/占位标记）
2. src/components/panels/RequestPanel.vue:134-136 updateHeaders → updateActiveTab({headers})
3. src/stores/tabs.ts:233-240 updateTab → Object.assign 写进 tab.headers
4. src/stores/request.ts:76 sendRequest → :77 cloneTabSnapshot → :398 `headers: tab.headers.map(item => ({...item}))`（值逐字复制）
5. request.ts:93 resolveTabVariables → :329-333 对 key/value 跑 resolveTemplate；src/utils/resolve-template.ts:16 对未定义的 {{x}} 返回 match 原样，不含 {{}} 的 cookie 值等于恒等变换
6. request.ts:119 buildPayload → :250 `headers: tab.headers`（**没有任何 redact 调用**）
7. request.ts:120-122 invoke("send_request", { args: payload }) → src/utils/invoke.ts:18-21 → Tauri
8. src-tauri/src/lib.rs:2225 send_request → :2233 execute_request
9. lib.rs:2311-2322 `HeaderMap::new()` + 遍历 enabled 且 key 非空的 header：:2317 HeaderName::from_str、:2319 HeaderValue::from_str、:2321 **header_map.append**
10. lib.rs:2342 `client.request(method, url).headers(header_map)` → :2407 send()
实测（用真实 store + mock invoke 跑通）：WIRE#1 headers = [{"key":"cookie","value":"sid=abcdef123456; theme=dark"}]；发送后 tab.headers[0].value 仍是原值。

【B. 同一次发送 → history 文件（结论：只影响这一份副本）】
1. request.ts:162 buildHistoryEntry(requestSnapshot, result)（注意入参是 snapshot，不是 resolvedTab）
2. :468 requestHeaders = redactKeyValuePairs(...) → :533-538 → :544-546 redactValue → :548-552 isSensitiveKey 正则命中 cookie → 返回字面量 "[redacted]"
3. :164 invoke("append_history", { entry }) → lib.rs:2024 append_history → write_history_entries → $HOME/ApiSolo/scratch/history.jsonl
4. :165 useHistoryStore().appendEntry 只更新内存列表（src/stores/history.ts:42-49），不回写 tab
实测：HISTORY headers = [{"key":"cookie","value":"[redacted]"}]。

【C. 点历史条目 → 新 tab → 再点 Send（结论：字面量 "[redacted]" 真的上线）】
1. src/components/sidebar/HistoryPanel.vue:57-59 openEntry → src/stores/tabs.ts:344 openHistoryEntry
2. tabs.ts:355-357 `tab.headers = createEditablePairs(entry.requestHeaders)`；:97-102 createEditablePairs **只重新生成 id，value 原样保留**
3. 用户按 Send → 回到 【A】的第 4 步起全程无差别
4. lib.rs:2319 HeaderValue::from_str("[redacted]")：http-1.4.0/src/header/value.rs:557-559 `is_valid(b) = b>=32 && b!=127`，'[' 0x5B / ']' 0x5D 全部合法 → **不报错，直接进 HeaderMap**
实测：WIRE#2 headers = [{"key":"cookie","value":"[redacted]"}]。definitively：会发，且服务端会看到 `Cookie: [redacted]`。

【D. body / params / response headers】
- body：request.ts:470 requestBodyContent = redactSensitiveText(tab.body.content) → tabs.ts:359-368 还原到 tab.body.content → request.ts:314-317 buildBody 原样带出 → lib.rs:2365-2404。实测 `{"username":"alice","password":"hunter2"}` 存成 `{"username":"alice","password":[redacted]}`（**引号被第三条正则吃掉，已经不是合法 JSON**），重放时 lib.rs:2369 serde_json::from_str 失败 → "Invalid JSON body"（json 类型会响；raw / form-urlencoded 类型则静默发出去）。你的 history.jsonl 第 84 行就是这个形态。
- params：request.ts:467 → tabs.ts:351-353 还原 → buildPayload:249 → lib.rs:2291-2299 `pairs.append_pair` → 线上出现 `?access_token=%5Bredacted%5D`。实测 WIRE#2 params = access_token=[redacted]。
- response headers：request.ts:482 redactResponseHeaders → :540-542；tabs.ts:389-398 只还原进 tab.response（展示用），永远不会上线。副作用是 ResponseCookies.vue:24-28 会显示一个名叫 "[redacted]"、值为空的 cookie。

【E. UI 有没有告诉你这是"缺凭据的重放"】
没有。tabs.ts:344-421 里 label 只取 URL path（:349 deriveHistoryLabel），Tab 类型没有来源字段，TabBar/RequestPanel/ResponsePanel 里 grep "history" 零命中；KeyValueEditor 的行就是普通 input。唯一一条相关文案 src/i18n/zh-CN.ts:212-213 还说反了："历史记录会按编辑态保存请求"——实际是按字段名脱敏后保存。

【F. 一条请求上两个 Cookie 是怎么来的、Rust 怎么处理】
- 来源 1（你这次几乎可以肯定是这个）：手工加行。RequestPanel.vue:222-231 / :242-249 的 curl 导入是 **整体替换** headers，不可能叠加；而你的 88-91 行 = 87 行那 17 个 header 原封不动 + 末尾追加 1 个 Cookie，只能是 KeyValueEditor 里新增了一行。88-91 的前 17 个 header 与 7-27 那条（第 83 行）的 key/值哈希逐一相同，而 tab 不做任何持久化（全仓只有 settings 用 localStorage，src/stores/settings.ts:93），所以那 17 个 header 只能来自 openHistoryEntry 还原第 83 条 —— 也就是说第 4 个位置那个 Cookie 就是 "[redacted]"。
- 来源 2（代码层真实存在）：src/utils/curl-parser.ts:47-59（-H）和 :113-119（-b/--cookie）各自 push，无去重。实测真 curl：`curl -b 'a=1' -H 'Cookie: b=2'` 只发一行 `Cookie: b=2`（-H 覆盖 -b），而 ApiSolo 会产生两行。
- Rust 侧：lib.rs:2321 用 `append` 而不是 `insert`，两行 Cookie 都会进 HeaderMap，HTTP/1.1 下就是两行 `Cookie:` 报文头（我用 python http.server 实测服务端确实收到两条）。append 本身是对的（UI 上有两行就该发两行，改成 insert 反而是"UI 说谎"），问题在于第一行是被污染的那行：很多网关/中间件用 Header.Get("Cookie") 只取第一行，你连吃 4 个 401、删到只剩一行才 200，与此完全吻合（仅凭历史文件无法 100% 证明服务端读了哪一行，但时间线只支持这一个解释）。

## 由此定位到的缺陷

### [高] `src/stores/tabs.ts:356` — 从历史记录重放会把字面量 "[redacted]" 当真值发出去（header/param/body）

openHistoryEntry 用 createEditablePairs(tabs.ts:97-102) 原样还原 entry.requestHeaders/requestParams，而这些值在写入历史时已被 request.ts:545 换成字符串 "[redacted]"。还原后的 tab 与普通请求毫无区别（普通 input，无标记、无禁用、无提示），按 Send 后 buildPayload(request.ts:250) 直接带上，Rust 侧 HeaderValue::from_str("[redacted]") 合法（http-1.4.0 value.rs:557），lib.rs:2321 append 进 HeaderMap 并发出。失败现场：用户 history.jsonl 第 87 行（17 header/1 Cookie）401 → 88-91 行（用户手工补了第二个 Cookie，18 header/2 Cookie）连续 4 次 401 → 93 行（删到 1 个 Cookie）200。对比证据：Rust 侧同一套脱敏（lib.rs:1457-1471 preserve_template_or_empty）对敏感字段写的是空串、并保留 {{var}}，即天然可重放；前端写的却是一个看起来像真值的毒化字面量——两边不对称说明这是疏漏而非既定设计。直接违反“UI 不许说谎”：UI 展示了一个可编辑、看似完整的请求，实际发出去的是占位符。

**修复**：在 openHistoryEntry 里对 value === "[redacted]" 的 header/param/formData 清空并标记（保留 key，让用户知道原来有这个字段），UI 上给该行 amber 占位符 + tab 顶部一行提示；另在 buildPayload 加一道 send-time 断言：任何将要上线的 header/param/body 含哨兵值就抛错，覆盖 Postman/OpenAPI 等其他导入路径。

### [中] `src/stores/request.ts:565` — redactSensitiveText 第三条正则撤销第二条加的引号，历史里的 JSON body 变成非法 JSON；urlencoded body 被截断

第二条正则(:561-564)把 "password":"hunter2" 换成 "password":"[redacted]"，第三条(:565-568)紧接着又匹配到刚生成的结果并按 $1[redacted] 替换，把引号吃掉，产出 {"password":[redacted]}。实测 5 个样例全部变成非法 JSON，用户 history.jsonl 第 84 行就是 "password": [redacted]。后果：(a) 历史里存了一份永远无法解析、也从未真实发送过的 body；(b) 重放该条目时 lib.rs:2369 serde_json::from_str 直接失败报 "Invalid JSON body"；(c) 同一函数还作用于 responseBody(:481)，凡是响应体里含 "token":"..." 的历史记录，JSON 树视图都会解析失败退化成纯文本。另外第三条的 [^"',\s}]+ 不排除 &，输入 grant_type=password&password=p&client_secret=xyz 会被整段吞成 grant_type=password&password=[redacted]，client_secret 字段凭空消失——历史记录里显示的请求与实际发送的请求不一致。

**修复**：给第三条正则加负向先行 (?!\[redacted\]) 或让它先于第二条执行且只匹配无引号值；同时把字符类从 [^"',\s}]+ 改成 [^"',&\s}]+，避免跨 & 吞掉后续字段。补一个断言 redactSensitiveText 幂等且 JSON 输入仍产出可 JSON.parse 的输出的测试。

### [中] `src/i18n/zh-CN.ts:212` — 历史面板的安全提示与代码行为相反，且不提示重放已丢失凭据

文案是“历史记录会按编辑态保存请求。对于不希望持久化到磁盘的敏感值，请使用环境变量。”（en.ts:212-213 同）。实际行为相反：cookie/authorization/token 等按字段名硬名单被替换成 [redacted]（request.ts:548-552）。用户据此文案会形成两个错误预期：(1) 以为历史里存的是原值，于是不敢用历史、或误以为泄漏；(2) 完全没有被告知“从历史打开的请求已经不含凭据、直接发会失败”。这正是用户这次误判“cookie 没发出去”的直接诱因，也是 HistoryPanel.vue:209-211 唯一一处相关说明。

**修复**：改成陈述实际行为：“历史记录会对 cookie / authorization / token 等字段做脱敏，从历史打开的请求需要重新填写这些值。”并在 openHistoryEntry 生成的 tab 上加一行同义提示（这也是 fix #1 的 UI 部分）。

### [中] `src/stores/request.ts:459` — 历史条目的 url 字段保留完整 query string 未脱敏，且与 params 表不一致（URL 栏显示真值、线上发的是 [redacted]）

buildHistoryEntry 里 `url: tab.url` 是原样写入的，而同一批数据的 requestParams 走了 redactKeyValuePairs(:467)。tab.url 始终携带 query（RequestPanel.vue:118-123 syncParamsFromUrl 只同步不剥离），所以 GET https://api/x?access_token=REAL 会以明文落到 $HOME/ApiSolo/scratch/history.jsonl 的 url 字段，硬名单形同虚设。更糟的是重放时的不一致：openHistoryEntry(tabs.ts:348) 把带真 token 的 URL 放进 UrlBar（UrlBar.vue:106 显示 props.url 原值），而 params 表里是 [redacted]；发送时 buildPayload(:248) 用 stripQueryFromUrl 丢掉 URL 上的 query、改用 params 重新拼（lib.rs:2291-2299）——UI 上明明写着 access_token=REAL，线上发出去的却是 access_token=%5Bredacted%5D。

**修复**：buildHistoryEntry 里对 url 也做处理：解析 query，按同一套 isSensitiveKey 重写后再拼回（或干脆只存 stripQueryFromUrl(tab.url)，反正 requestParams 已经是权威来源）。顺带让 openHistoryEntry 用 params 重建 URL，保证 URL 栏与线上一致。

### [低] `src/utils/curl-parser.ts:113` — cURL 导入把 -b 和 -H 'Cookie:' 同时展开成两行 Cookie，真 curl 只发一行

-H 分支(:47-59) 与 -b/--cookie 分支(:113-119) 各自 headers.push，无去重也无覆盖。实测真 curl：`curl -b 'a=1' -H 'Cookie: b=2'` 只发送一行 Cookie: b=2（-H 覆盖 cookie 引擎），而 ApiSolo 会产生两行，经 lib.rs:2321 的 append 变成报文里两行 Cookie。失败场景：粘贴一条同时带 -b 与 -H Cookie 的命令（手工拼过的、或工具生成的），ApiSolo 复现不出 curl 的结果，服务端按第一行取 cookie 时鉴权失败，用户只能靠肉眼在 header 表里发现重复行。注：两个显式 -H 'Cookie:' 时 curl 确实发两行，所以 Rust 的 append 是对的，不要改成 insert。

**修复**：parseCurl 收尾时若存在 -H 来源的 Cookie，丢弃 -b 来源的那条（与 curl 语义一致）；另外在 KeyValueEditor 对 cookie/authorization/content-type 这类不该重复的 header 出现重复 key 时给一个行内 warning 图标。

## 给你的说明

先给结论：**你那次的 cookie 是真发出去了**。header 的值从 KeyValueEditor 一路到 reqwest 的 HeaderMap 全程没被碰过——request.ts:250 的 buildPayload 里就是 `headers: tab.headers`，没有任何 redact 调用；lib.rs:2311-2322 直接 HeaderValue::from_str 后 append。我用你自己的 store 跑了一遍端到端（mock 掉 invoke，打印 payload）：发送时 payload 里是 `sid=abcdef123456; theme=dark`，写进 history 的同一条是 `[redacted]`，发送后 tab 里的值也还是原值。你看到的 `[redacted]` 只是 buildHistoryEntry 另做的那份持久化副本（request.ts:468 → :545），两条路径完全独立。

但你的直觉没白响，只是指错了位置：**从历史记录点开的那个 tab，会把 `[redacted]` 这个字符串当真值发出去**。tabs.ts:356 的 createEditablePairs 只换 id 不换值，`[redacted]` 在 HTTP 里是合法 header 值（`[`/`]` 都在可见 ASCII 内），Rust 不会报错，服务端就真收到了 `Cookie: [redacted]`。

你的 history.jsonl 把这个过程完整录下来了（我只读了 key 和值长度，没打印任何真值）：

- 第 87 行 08:55:06，17 个 header、1 个 Cookie → 401。这 17 个 header 的 key 和值哈希跟 7-27 的第 83 行**逐一相同**，而 tab 不做持久化（全仓只有 settings 进 localStorage），所以它只能是从历史里点开第 83 条还原出来的 —— 那个 Cookie 就是 `[redacted]`。
- 第 88-91 行 08:55:56~08:59:01，变成 18 个 header、**两个 Cookie**，末尾多出来的那个是你手工加的行（curl 导入是整体替换 headers，RequestPanel.vue:222-231，加不出重复行）。连续 4 次 401：你补的新 cookie 排在第二行，被污染的 `[redacted]` 排第一行，走 Header.Get("Cookie") 的中间件只看第一行。
- 第 93 行 09:01:24，删到只剩一个 Cookie → 200。

所以那 4 分钟的 401 不是你 cookie 过期，是 UI 给了你一个看起来完整、实际带毒的请求，你又在它旁边加了一行正确的，两行一起发了出去。

顺带三个同源问题：

1. body 也中招，而且更难看。redactSensitiveText 的第三条正则会把第二条刚加上的引号又吃掉：`{"password":"hunter2"}` 存成 `{"password":[redacted]}`，已经不是合法 JSON 了（你 8-11 那条 create-forex-account 就是这个样子）。重放时 Rust 报 "Invalid JSON body"，raw / form-urlencoded 类型则是静默发出去。同一条正则还会跨 `&` 吞掉后面所有字段：`grant_type=password&password=x&client_secret=y` 存成 `grant_type=password&password=[redacted]`，client_secret 直接消失——历史里那条请求你从来没发过。

2. `entry.url` 是原样存的（request.ts:459），只有 params 做了脱敏。URL 里带 token 的话明文落盘，硬名单等于绕过去了；重放时更拧巴：URL 栏显示真 token，params 表显示 `[redacted]`，而 buildPayload 会剥掉 URL 的 query 改用 params —— 屏幕上写着 REAL，线上发的是 `[redacted]`。

3. 历史面板那句提示（zh-CN.ts:212）说的是"历史记录会按编辑态保存请求"，跟代码正好相反，而且完全没提"从历史打开的请求已经不含凭据"。这条文案是你这次误判的直接推手，按"UI 不许说谎"该优先改。

一个有说服力的旁证：Rust 侧同一套脱敏（lib.rs:1465-1471）对敏感字段写的是**空串**、并且保留 `{{var}}` 模板，天生可重放；前端却写了一个长得像真值的字面量。两边不对称，说明这是当初漏掉的一手，不是"重放需要重填凭据"那条既定设计的一部分——既定设计只要求值没了，没要求塞一个假值进去。

## 消除歧义的设计选项

四个方案，按"改动量 / 是否能修好磁盘上已有的 94 条历史"排列：

A. 只在还原时消毒（改 tabs.ts:openHistoryEntry）
在 openHistoryEntry 里遍历 headers/params/formData/body，凡 value === "[redacted]" 就清空（key 保留），并在 tab 上记一个 `restoredFromHistory: true` + 被清字段列表。
优点：一处改动；对磁盘上已有的 94 条历史立即生效（含你那 4 条双 Cookie）；不动历史文件格式。
缺点：只堵住历史这一条路，别的路径（将来的导入器）还能塞进哨兵值。

B. 前端脱敏对齐 Rust（改 request.ts:545 redactValue）
敏感字段写空串、保留 {{var}}，跟 lib.rs:1465 preserve_template_or_empty 一致。
优点：从源头不再产生毒化值，两侧脱敏语义统一。
缺点：只对新写入的历史生效，旧文件还得靠 A；另外空值会丢掉"这里原本有值"的信号，需要配合 UI 占位符。

C. 发送前置断言（改 request.ts:buildPayload）
出站的任何 header/param/body 命中哨兵值就抛错，走现有的 responseError 通道，文案指明是哪个字段。
优点：兜底，覆盖所有路径，且永远失败得很响。
缺点：如果用户真想发一个字面量 "[redacted]"（几乎不存在）会被误伤，可以用一个更不可能的哨兵（如 " apisolo:redacted"）规避——但那样历史面板就没法直接展示，权衡后我倾向保留可读文案 + 允许用户改掉该行后重发。

D. UI 层的诚实化（i18n + RequestPanel + KeyValueEditor）
改掉 zh-CN.ts:212 / en.ts:212 那句反话；从历史打开的 tab 顶部加一行 amber 条 "此请求来自历史记录，cookie / authorization 等字段已脱敏，需重新填写"；被清空的行用 amber 占位符而不是普通 placeholder。

推荐组合：**A + D + C**，B 可选。
理由：A 立刻修好你磁盘上已有的历史（这是你现在最痛的点），D 兑现"UI 不许说谎"（错的文案比缺文案更贵），C 是廉价兜底、防止以后新增导入路径重蹈覆辙。B 属于锦上添花——A 落地后哨兵值不会再上线，把它改成空串只是让两侧语义整齐，可以并到同一个 PR 也可以缓。

另外两个独立的小修（不要塞进同一个 commit）：
1. request.ts:565 那条正则加 `(?!\[redacted\])` 负向先行，字符类改 `[^"',&\s}]+`；补一个"脱敏后仍是合法 JSON 且幂等"的测试。
2. curl-parser.ts 收尾时让 -H 的 Cookie 覆盖 -b 的 Cookie（与真 curl 一致，我已实测），并在 KeyValueEditor 对 cookie/authorization/content-type 的重复 key 显示行内 warning。lib.rs:2321 的 append **不要**改成 insert——UI 上有两行就该发两行，改了才是说谎。
