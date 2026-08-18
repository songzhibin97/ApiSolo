# D06 — 导入导出保真 · TECH

> **rev5 — 应 R4 修订**（R4 裁定 REVISE：0C + 1I + 2M）。实现与验证，按编号引用 PRODUCT 的 Behavior 条目（46 条，未增减）。
> rev4 → rev5：测试 #30 的第三个 fixture 是**已证明的假绿**——`Bearer ey\r\n  Jhb` 折叠后是 `Bearer ey Jhb`，含内部空格、匹配不上 `/^Bearer (\S+)$/`，所以删掉 `&& !authNotPreserved` 这个 guard 它**照样不会被提升**，测试继续绿；实现者可以整个漏掉「保真受损⇒禁止提升」的守卫而全套通过。换成 `Bearer\r\n  eyJhb`（折叠后**恰好**是合法的 `Bearer eyJhb`），并把 `authNotPreserved` 的置位条件写死（R4 I1）。另：#19 的杀手引用了拟定实现里不存在的 `pair` 标识符、编译不过，改成只替换 `set()` 的 key 实参（R4 M1）；#29 补第 ⑨ 例 `Bearer␣␣good`，给 Behavior 29 里已列出的「scheme 与 token 之间双空格」补上直接回归（R4 M2）。
> rev3 → rev4：`Authorization` 全程持有**未经 trim 的原始 field-value**，「字节可复原」谓词直接作用于它——rev3 的谓词本身没错，错在它被喂了 `createHeaderPair` 归一化后的输入（`curl-parser.ts:359/:363/:383/:387` 两级 `.trim()`），于是尾随空格先被裁掉再「通过」校验（R3 C1）；无法用 `名字: 值` 复原的空白布局改为可见警告而非静默归一化；`--compressed` 的独立性验证改写成确定性 mutation 步骤，不再是会产生假绿的 commit revert（R3 I1）；`Bearer` 匹配收紧为 `/^Bearer (\S+)$/`，与「恰好一个空格」措辞一致（R3 M1）。
> rev2 → rev3：认证 header 改为「字节可复原才提升」模型；`--compressed` 断言收进单条；`DECODABLE_ENCODINGS` 补 feature → token 映射；三条不成立的杀手换掉；追溯表补齐孤儿；文件归属补齐；工具披露自查；章节引用修正。

**引用口径**（按 R2 裁定 A7/R5）：本文件对 PRODUCT 的引用一律只用 **Behavior 编号**，不引用 PRODUCT 的章节号或标题；PRODUCT 不再引用本文件的任何章节号。本文件内部的自引用（§n）不受限。源码 `file:line` 是证据锚点，不是跨文档导航，照常保留。

## 0. 文件边界与验证方法

### 0.1 文件边界

D06 拥有 `src/utils/**` 与 `src/utils/__tests__/**`，但**以下三个 `src/utils/` 下的文件属于 D01，D06 一律不得创建、修改或删除**（R2 M1）：

```
src/utils/redaction.ts        ← D01 新建
src/utils/url-params.ts       ← D01 新建
src/utils/saved-request.ts    ← D01 新建
```

本切片改动的全部文件：

```
src/utils/url-query.ts                      (新增)
src/utils/curl-parser.ts
src/utils/curl-export.ts
src/utils/postman-export.ts
src/utils/openapi-import.ts
src/utils/__tests__/curl-parser.test.ts     (扩写)
src/utils/__tests__/curl-export.test.ts     (扩写)
src/utils/__tests__/postman-export.test.ts  (扩写 + 改写 1 处既有断言)
src/utils/__tests__/postman-import.test.ts  (扩写)
src/utils/__tests__/openapi-import.test.ts  (扩写)
```

⚠️ **命名邻接风险**：D06 新建的 `url-query.ts` 与 D01 新建的 `url-params.ts` 主题相邻，两条切片各自独立时可能出现功能重叠的两个 URL 工具模块。D06 不看、不改、不依赖 `url-params.ts`；是否合并由 owner 在两条切片都合入后裁定（记为 §8 N6）。

`src/utils/postman-import.ts` **不改**（往返不变式由测试锁住即可，Behavior 43）。任何 `src/components/**`、`src/stores/**`、`src/i18n/**`、`src-tauri/**` 的改动一律不在本切片内，见 §8。

### 0.2 每一条经验性断言用什么得到的（R1 C3 + R2 M2 重新自查）

rev1 里 `--data-urlencode` 的空格编码写成 `%20` 是**错的**——那不是实跑结论，是照抄了两份 review 文档的说法。这一节的全部价值在于它诚实：**包装一处，整节不可信**。rev3 逐条重新过了一遍，把「实跑」「静态推导」「转引」三类彻底分开。

| # | 断言 | 得到方式 | 备注 |
|---|---|---|---|
| V1 | 真 curl 的编码规则（§1.1 上表 11 行） | **实跑 curl 8.7.1**（`x86_64-apple-darwin25.0`, libcurl/8.7.1）：`curl --libcurl <out.c> --data-urlencode <arg> --connect-timeout 1 http://127.0.0.1:9/`，读 `CURLOPT_POSTFIELDS` | — |
| V2 | 真 curl 的 header 优先级 / cookie 连接符 / `-X GET`+`-d` / `--compressed`（§1.1 中表） | **实跑 curl 8.7.1**：python3 裸 TCP echo server 收原始请求报文 | — |
| V3 | 真 curl 对显式 `Authorization` 从不加工（多条保留、`/zph`、`bG9uZWx5`、小写 scheme、多空格） | **实跑 curl 8.7.1**（同 V2） | R2 C1/C2 的依据，rev3 自行复跑，未采信评审转述 |
| V4 | `Basic /zph` 经「逐字节回落 + `basic_auth` 重编码」会变成 `w786YQ==`；`Basic bG9uZWx5` 会变成 `bG9uZWx5Og==` | **实算 base64**（python3 `base64`：自行算出解码字节 `b'\xff:a'` / `b'lonely'` 与重编码结果）+ **静态**（reqwest `basic_auth` 拼 `u + ":" + p` 后 base64） | 数值自行复算，非转引 |
| V5 | ApiSolo 今天的解析 / 导出输出（§1.2–§1.4 各表） | **`node --experimental-strip-types`** 直接 import 仓库真实 `.ts`（本 worktree 未装 `node_modules`，跑不了 vitest；仅剥掉 `import type` 行，函数体一字未改） | — |
| V6 | 「自定义 scheme + `-u` 最终在线上发两行 Authorization」 | **Node 探针只证到解析态**（`headers` 里留着 `Authorization: Custom abc` 且 `auth.type === "basic"`）；**「因此线上发两行」是 Rust 侧静态追踪**：`lib.rs:2317-2321` 逐条 `HeaderMap` 装填 + `lib.rs:2351` `request.basic_auth(...)`。**未实跑后端** | R2 M2 点名的那处包装，已改标 |
| V7 | `HeaderValue::from_str` 拒收含 CR 的值 | **静态**：grep 到调用点 `lib.rs:2319`，语义引自 memory `curl-import-header-normalization`。未实跑 Rust | — |
| V8 | `filePath` 全应用恒为 `""` | **静态**：`BodyEditor.vue:214`、`projects.ts:271` | — |
| V9 | 零字节文件的 `fileContent` 是 `""` 而非 `undefined` | **静态推导，且不依赖 data-URL 的具体形状**：`readFileAsBase64`（`BodyEditor.vue:260-271`）里 `const [, base64 = ""] = result.split(",", 2)`——无论 `readAsDataURL` 对空文件返回 `data:…;base64,`、`data:,` 还是空串，解构默认值都让结果是 `""`，永远取不到 `undefined`；而导入占位显式写 `undefined` | 未实跑 FileReader |
| V10 | `openapi-import.ts` 的 `seenRefs` 每次调用重置、无深度上限 | **静态**：逐行追踪 `:264` / `:366` / `:389` 三个调用点与 `:287/:291/:295/:300/:305` 五处递归。本 worktree 未装 `yaml`，跑不了 | 与 review 的复现记录一致 |
| V11 | Chrome `escapeStringPosix` 只对控制字符 / DEL-C1 / `!` / `'` 触发 `$'…'` | **转引**自 `docs/review/REVIEW-2026-08-18.md` 第 2 条的对抗验证记录，本次**未自行核对** devtools-frontend 源码 | 只影响用例选材（用 `!` 而非 `中`），不影响任何实现判据 |
| V12 | 真 curl 把 `-H` 参数**逐字节原样**发出，不做任何空白规整（§1.1 第三表） | **实跑 curl 8.7.1**：裸 TCP echo server 按 `%r` 打印每一行原始字节，避免终端吃掉尾随空格 | R3 C1 的依据 |
| V13 | ApiSolo 今天在 `Authorization` 到达认证谓词之前已经 trim 过两次 | **静态**：`createHeaderPair`（`curl-parser.ts:357-372`）先 `key.trim()`（`:359`），再把冒号后的整串交给 `normalizeHeaderValueByKey`（`:363`），后者的两个实现 `normalizeHeaderValue`（`:383`）与 `normalizeCookieValue`（`:387`）末尾都是 `.trim()`；`parseAuthorizationHeader`（`:390`）收到的是这个 trim 后的值。**未实跑**（不需要——两级 `.trim()` 是字面可读的） | rev3 谓词失效的根因 |
| V14 | 测试 #30 / #29⑨ 的 fixture 确实能杀掉各自的 guard | **实跑 node**：按 §2.2(e) 的三步（ANSI-C 解码 → `FOLD` 正则 → 剥分隔空格）逐字符复算 `rawValue / folded / storedValue / warnings`，并分别计算「带 guard」与「删掉 guard」两种情形下是否提升。实跑输出见 §5.1 #30 行下方的对照表 | R4 I1 判定 rev4 的 fixture 是确定性假绿，本行是替换 fixture 的成立证据 |

## 1. Context —— 现状

### 1.1 真 curl 8.7.1 的基准行为（V1 / V2 / V3）

`--data-urlencode` 编码矩阵（V1）：

| 参数 | curl 8.7.1 实际发出 | 说明 |
|---|---|---|
| `q=a b&c` | `q=a+b%26c` | **空格是 `+`，不是 `%20`** |
| `q=a!b` | `q=a%21b` | `!` 被编码（`encodeURIComponent` 不编码） |
| `q=a'b` | `q=a%27b` | `'` 被编码 |
| `q=a(b)c*d` | `q=a%28b%29c%2Ad` | `(` `)` `*` 都被编码 |
| `q=a+b` | `q=a%2Bb` | 内容里原有的 `+` 变 `%2B`，证明是「先转义、再把 `%20` 换成 `+`」 |
| `q=a~b-c_d.e` | `q=a~b-c_d.e` | unreserved = `A-Za-z0-9-._~` |
| `q=中文` | `q=%E4%B8%AD%E6%96%87` | UTF-8 字节 |
| `=a b` | `a+b` | 前导 `=` 不保留 |
| `a b` | `a+b` | 无 name |
| `name=a@b` | `name=a%40b` | 先找 `=`，`@` 属内容 |
| `na me=x y` | `na me=x+y` | **name 部分不编码**（空格原样） |

数据 flag 的 `@file` 语义（V1，文件内容 `{"name":"apisolo"}`）：`--data-ascii @f` → POSTFIELDS 是文件内容；`--data @f` → 同；`--data-raw @f` → 字面量 `@/tmp/…/payload.json`；`--data-urlencode body@f` → `body=%7B%22name%22%3A%22apisolo%22%7D`。**`--data-ascii` 确实读文件**。

header 优先级（V2，读服务端原始报文）：

| 命令 | 服务端收到 |
|---|---|
| `-b 'a=1' -H 'Cookie: b=2'` / 反序 | 一行 `Cookie: b=2` — 与顺序无关 |
| `-b 'a=1' -b 'b=2'` | 一行 `Cookie: a=1;b=2` — **`;` 无空格** |
| `-b 'a=1; b=2'` | 一行 `Cookie: a=1; b=2` — 单 flag 内部空格原样 |
| `-H 'Cookie: a=1' -H 'Cookie: b=2'` | **两行** Cookie |
| `-A 'ua-from-A' -H 'User-Agent: ua-from-H'` | 一行 `User-Agent: ua-from-H` |
| `-A 'x' -A 'y'` | 一行 `User-Agent: y` |
| `-e 'ref-from-e' -H 'Referer: ref-from-H'` | 一行 `Referer: ref-from-H` |
| `-H 'X-Custom:'` | 不输出该 header |
| `-H 'X-Custom;'` | 输出 `X-Custom:` 空值 |
| `-H 'Cookie;' -b 'a=1'` | 一行 `Cookie:` 空值，`-b` 被抑制 |
| `--compressed` | `Accept-Encoding: deflate, gzip`（本机 build 无 brotli） |
| `--compressed -H 'Accept-Encoding: gzip'` | `Accept-Encoding: gzip` — 生成项同样被 `-H` 抑制 |
| `-b /tmp/不存在的文件` | **不发 Cookie，也不报错**（静默） |
| `-X GET -d 'q=1'` / 反序 | 两者都是 `GET` + body `q=1` + `Content-Type: application/x-www-form-urlencoded` |

**显式 `Authorization`：curl 一律原样、一律不加工**（V3，R2 C1/C2 的直接依据）：

| 命令 | 服务端收到 |
|---|---|
| `-H 'Authorization: Bearer aaa' -H 'Authorization: Bearer bbb'` | **两行**：`Bearer aaa` / `Bearer bbb` |
| `-H 'Authorization: Basic dXNlcjpwYXNz' -H 'Authorization: Bearer bbb'` | **两行**，各自原样 |
| `-H 'Authorization: Custom ccc' -H 'Authorization: Bearer bbb'` | **两行**，各自原样 |
| 上面任意一条再加 `-u a:b` | 仍是那两行，**`-u` 的 Basic 不出现** |
| `-H 'Authorization: Basic /zph'` | 原样 `Basic /zph`（解码是 `b'\xff:a'`，非法 UTF-8） |
| `-H 'Authorization: Basic bG9uZWx5'` | 原样 `Basic bG9uZWx5`（解码是 `lonely`，**无冒号**） |
| `-H 'Authorization: basic dXNlcjpwYXNz'` | 原样，scheme 保持**小写** |
| `-H 'Authorization: Basic   dXNlcjpwYXNz'` | 原样，**三个空格**都在 |
| `-u 'user:pa:ss'` | `Basic dXNlcjpwYTpzcw==`，解码 = `user:pa:ss` |

另注 `-A 'x' -H 'User-Agent: y'` 那一例里 `User-Agent` 行被挪到了 `Accept` 之后——curl 是「删掉生成项、把 `-H` 追加在末尾」。这个精确行序**不复现**（PRODUCT 已在 Non-goals 声明）。

**空白布局：curl 逐字节原样发送**（V12，R3 C1 的直接依据。echo server 按 `%r` 打印，尾随空格不会被终端吃掉）：

| `-H` 参数 | 服务端收到的原始行 |
|---|---|
| `Authorization: Bearer good` | `b'Authorization: Bearer good'` |
| `Authorization: Bearer good␣` | `b'Authorization: Bearer good '` ← **尾随空格保留** |
| `Authorization: Basic dXNlcjpwYXNz␣` | `b'Authorization: Basic dXNlcjpwYXNz '` ← **尾随空格保留** |
| `Authorization:␣␣Bearer good` | `b'Authorization:  Bearer good'` ← 两个空格都在 |
| `Authorization:Bearer good` | `b'Authorization:Bearer good'` ← **冒号后无空格** |
| `Authorization:<TAB>Bearer good` | `b'Authorization:\tBearer good'` |
| `Authorization: Bearer␣␣good` | `b'Authorization: Bearer  good'` |
| `Accept:␣␣application/json` | `b'Accept:  application/json'` ← 非认证头同样原样 |
| `X-Probe: v␣` | `b'X-Probe: v '` |

推论：ApiSolo 的数据模型只能输出 `名字 + ": " + 值` 这一种形状，所以**当且仅当**冒号后恰好是一个空格时，`值 = 冒号后去掉那一个空格`的存法能逐字节还原原始行；冒号后无空格、是 TAB、或是多个空格中的第一个不是空格时无法还原（多个空格是可以还原的——多出来的空格属于「值」的一部分）。

### 1.2 `src/utils/curl-parser.ts`（V5，另标注处除外）

- 入口只有 `parseCurl`（`:21`），要么返回 `ParsedCurlRequest`（`:3` 定义但**未 export**），要么 throw（`:24`、`:206`）。没有第三种出口。
- `tokenizeCurlCommand`（`:310-355`）：`:315` 先把 `\`+换行折成空格；`:324` 的 `char === "\\" && quote !== "'"` 使单引号内反斜杠保持字面量；`:329` 的开引号分支对 `'` / `"` 无条件触发，而前面的 `$` 已在 `:347` 被追加进 `current`。
  - `-H $'cookie: sid=abc!def' -H $'authorization: Bearer xyz'` → headers `[["$cookie","sid=abc!def"],["$authorization","Bearer xyz"]]`，auth `{"type":"none"}`（`:391` 比较 `key.toLowerCase() !== "authorization"`，`$authorization` 不匹配）。
  - `-H $'x-n: a\r\nb'` → 值是字面量 6 字符 `a\r\nb`。
  - `-b $'sid=abc!def'` → `["Cookie","$sid=abc!def"]`。
- `-X` 分支（`:39-46`）只在 `isHttpMethod` 为真时 `index += 1`。`curl -X PURGE …` → `{method:"GET", url:"PURGE"}`；`-X pos` → `{method:"GET", url:"pos"}`。
- 数据标志分支（`:63-88`）**只列了 5 个 flag 中的 4 个**（`:64-68`），`--data-ascii` 不在其中，整条 flag 都不被识别：`curl --data-ascii @payload.json https://api.example.com/a` → `{method:"GET", url:"@payload.json", body:{type:"none"}}`，真实 URL 被丢弃且无警告。
- `@` 只对 `token === "--data-binary"` 特判（`:72`）。`-d @payload.json` → `{type:"raw", content:"@payload.json"}`；`--data-urlencode 'q=a b&c'` → `{type:"raw", content:"q=a b&c"}`。
- `method === "GET"` 改写出现在 `:82`、`:95`、`:108`，没有「方法是否显式指定」的标记。`-X GET -d 'q=1'` → POST；`-d 'q=1' -X GET` → GET；`-X GET -T ./f.bin` → PUT。
- URL 槽（`:200-202`）无 `trim()` 守卫。`"curl -X POST \\ \n 'https://example.com/a'"` → `{method:"POST", url:" "}`。
- `-b`（`:116-123`）/ `-A`（`:125-132`）/ `-e`（`:134-141`）各自无条件 `headers.push`：`-b 'a=1' -H 'Cookie: b=2'` → 两行 Cookie；`-A 'x' -H 'User-Agent: y'` → 两行 User-Agent；`-b 'a=1' -b 'b=2'` → 两行；`-A 'x' -A 'y'` → 两行。
- **认证相关的三个缺陷**：
  1. `-u`（`:143-154`）与 `parseAuthorizationHeader`（`:390-419`）都写同一个 `auth`，后写胜出：`-H 'Authorization: Bearer t' -u a:b` → basic；反序 → bearer。
  2. `parseAuthorizationHeader` 对无法识别的 scheme 返回 `null`（`:405-407`），于是 `Authorization: Custom abc` 作为普通 header 留下、`-u` 又照样生成 Basic。**「因此线上发两行」是 Rust 侧静态追踪（V6），不是 Node 探针能证的**。
  3. 每个能识别的 Authorization 值都被写进单一 `auth` 变量（`:52-54`）且不进 headers，因此**两条 `-H 'Authorization: …'` 只剩最后一条**（V5 复现）——真 curl 发两行（V3）。
- 冒号截断：`:146` 与 `:411` 都是 `.split(":")` 解构前两段。`-u user:pa:ss` → password `pa`；`Authorization: Basic base64("user:pa:ss")` → password `pa`。
- `atob` 返回逐字节字符串，无 UTF-8 解码：`Authorization: Basic base64("用户:密码")` → `{"username":"ç¨æ·","password":"å¯ç "}`。
- `--compressed` 在忽略清单里（`:176`），被静默丢弃。
- 归一化（`:374-388`）：两处正则 `/\r?\n[ \t]*/g` 不覆盖**孤立 CR**——今天无所谓（转义没被解码），Behavior 2 上线后就有所谓了（V7）。
- `-H 'X-Custom:'`：`createHeaderPair`（`:357-372`）会产出一行 key=`X-Custom`、value=`""` 的 header；`-H 'X-Custom;'` 更糟——`indexOf(":")` 为 -1，key 变成字面量 `X-Custom;`（非法 header 名）。两者都与 curl 不符。

### 1.3 `src/utils/curl-export.ts`（V5）

`buildUrl`（`:42-63`）把 `tab.url` 塞进 `new URL(tab.url || "http://localhost", "http://localhost")`，再 `searchParams.append` 每个启用参数（`:47`）：

| 输入 | 输出 |
|---|---|
| `{{baseUrl}}/users` | `curl '/%7B%7BbaseUrl%7D%7D/users'` |
| `https://api.example.com/{{id}}/x` | `curl 'https://api.example.com/%7B%7Bid%7D%7D/x'` |
| url `…/x` + 参数 `token={{apiToken}}` | `curl '…/x?token=%7B%7BapiToken%7D%7D'` |
| url `…/s?q=cat` + 参数 `q=cat` | `curl '…/s?q=cat&q=cat'` |
| `api.example.com/users`（无协议、**无模板**） | `curl '/api.example.com/users'` ← 主机丢失，review 只说了模板场景 |
| `https://api.example.com/a#frag` + `k=v` | `curl '…/a?k=v#frag'`（今天是对的，改动后必须保住） |
| `https://API.Example.com:443/a` | `curl 'https://api.example.com/a'`（`new URL` 顺手归一化） |

### 1.4 `src/utils/postman-export.ts`（V5 + V8 + V9）

`filePath` 恒为空串（V8），所以 `:241-244` 的 `item.filePath || item.fileName` 永远取到 `fileName`，`src` 一定是伪路径。二进制侧 `:132` 的 `binaryPath` 同样只是 `BodyEditor.vue:175` 写进去的 `file.name`。

**零字节文件（V9）**：判别式必须用 `fileContent !== undefined` 而非 `Boolean(fileContent)`，否则用户选中的零字节文件会被误判成「没有内联内容」，退回伪造 `src` 的老路。`binaryContent` 同理（`BodyEditor.vue:176` 写 `""`，`postman-import.ts:221` 写 `undefined`）。`JSON.stringify` 丢 `undefined`、留 `""`，所以这个区分在磁盘往返后依然成立。

V5 实跑（内联内容 + 中文文件名）：

```
Upload      body {"mode":"formdata","formdata":[{"key":"file","type":"file","src":"报告.pdf",...}]}
Bin         body {"mode":"file","file":{"src":"报告.pdf"}}
Dup         url  "https://api.example.com/s?q=cat&q=cat"
Hash        url  "https://api.example.com/a#frag?k=v"   ← 查询串跑到 fragment 后面，非法 URL（review 未提）
Tmpl        url  "{{baseUrl}}/users?t={{tok}}"          ← 模板在 Postman 侧本来就没问题，改动后必须保住
```

`normalizeSavedRequest`（`projects.ts:253-278`）保留 `fileContent`（`...normalized` 展开）与 `binaryContent`（`:271` 显式保留），所以 `CollectionPanel.vue:303` 从磁盘读回来的 `SavedRequest` 确实带内联内容。

### 1.5 `src/utils/openapi-import.ts`（V10）

`resolveSchemaRef`（`:370-374`）的 `seenRefs` 是**默认参数**，三个调用点（`:264`、`:366`、内部递归 `:389`）都没往下传，所以它只挡得住「一次调用内的纯 `$ref` 链」。`generateSchemaExample` 在 `:287`（oneOf）、`:291`（anyOf）、`:295`（allOf）、`:300`（properties）、`:305`（items）递归，每次都以空集重进 `:264`。`parseOpenApiSpec`（`:59`）到递归之间没有 try/catch，也没有深度上限 → 自引用 schema 爆栈，整份文档失败。`:60` 对 JSON 和 YAML 都走 `parseYaml`，所以 YAML 锚点能造出**不含任何 `$ref` 的真环**——这是深度上限的存在理由。

## 2. Proposed changes（依赖序）

### 2.1 新增 `src/utils/url-query.ts`

```ts
export interface UrlParts {
  baseUrl: string
  query: string
  hash: string
}

/** 与 RequestPanel.vue:433-444 的 splitUrlParts 语义一致：不解析 URL，纯字符串切分。 */
export function splitUrlParts(rawUrl: string): UrlParts

/** 逐段 encodeURIComponent，但 {{…}} 片段原样保留。 */
export function encodeQueryComponentPreservingTemplates(value: string): string
```

`splitUrlParts` 先按第一个 `#` 切出 hash，再在 hash 之前按第一个 `?` 切出 query；`encodeQueryComponentPreservingTemplates` 用 `value.split(/(\{\{[^{}]*\}\})/)`（捕获组保留分隔符），非模板段过 `encodeURIComponent`。

### 2.2 `src/utils/curl-parser.ts`

**(a) 导出类型 + 警告通道**（`:3-9`）

```ts
export type CurlImportWarningCode =
  | "file-reference-not-inlined"
  | "data-segments-discarded"
  | "cookie-file-not-supported"
  | "authorization-not-byte-preserved"

export interface CurlImportWarning {
  code: CurlImportWarningCode
  /** 供 i18n 插值：文件名 / 被丢弃的数据段数 / cookie 文件名 / "line breaks" | "separator whitespace" */
  detail: string
}

export interface ParsedCurlRequest {
  method: HttpMethod
  url: string
  headers: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  warnings: CurlImportWarning[]
}
```

`ParsedCurlRequest` 由未导出改为导出。新增字段是**加法**，`RequestPanel.vue:221/240` 只解构既有字段，编译与运行都不受影响。

**(b) 词法：ANSI-C 引用**（改 `:310-355`，新增私有函数 `decodeAnsiCEscapes(raw: string): string`）

`tokenizeCurlCommand` 内新增局部状态：`pendingDollar`（仅在「无引号、未转义」路径追加 `$` 时置真；追加其它任何字符、push token、进入转义分支时一律置假）、`ansiC`、`ansiBuffer`。
- `:329` 开引号分支之前插入：`if (char === "'" && !quote && pendingDollar) { current = current.slice(0, -1); quote = "'"; ansiC = true; ansiBuffer = ""; continue }`。
- ANSI-C 模式下不做转义求值，只保证 `\'` 不被当成闭合引号：遇到 `\` 时把 `\` 与下一个字符**原样**收进 `ansiBuffer`。
- 闭合引号（`:334`）时 `current += decodeAnsiCEscapes(ansiBuffer)`，清 `ansiC`。
- `decodeAnsiCEscapes` 支持 Behavior 2 列出的全部转义；`\x` 贪心吃 1–2 位十六进制、`\u` 1–4 位、`\U` 1–8 位、八进制 1–3 位；无法识别的转义**保留反斜杠 + 原字符**。

**(c) header 归一化补孤立 CR**（`:382-388`）

两处正则由 `/\r?\n[ \t]*/g` 改为 `/(?:\r\n|\r|\n)[ \t]*/g`。对既有输入等价，只多接住解码出来的孤立 CR。其余控制字符不清洗——留给 `lib.rs:2319` 报明确错误（V7），属可见失败。

**(d) `-H` 的三种语义**（改 `:48-61` 与 `createHeaderPair :357-372`）

```ts
type ExplicitHeaderDirective =
  | { kind: "set"; pair: KeyValuePair; rawValue: string }  // Name: value
  | { kind: "empty"; pair: KeyValuePair }                  // Name;  → 输出空值 header
  | { kind: "delete"; name: string }                       // Name:  → 不输出，仅抑制生成项

function parseHeaderDirective(rawHeader: string): ExplicitHeaderDirective | null
```

分派（与 §1.1 实测一致）：含 `:` 且冒号后归一化+trim 非空 → `set`；含 `:` 且冒号后为空/纯空白 → `delete`；不含 `:` 但以 `;` 结尾 → `empty`（name 去掉尾部 `;` 并 trim）；其余 → `null`，按今天的宽松行为忽略。

**`rawValue` 是新增的关键字段（R3 C1）**：它等于 `rawHeader.slice(colonIndex + 1)`，**一个字节都不动**——不折叠换行、不 trim。`pair.value` 仍是今天那条归一化+trim 后的值，普通 header 继续用它（见 PRODUCT 的 Non-goals：RFC 9110 §5.5 规定 OWS 不属于 field value，裁掉语义无损，而且现有换行归一化用例建立在此之上）。**只有 `Authorization` 走 `rawValue` 这条路**，见 (e)。`kind` 的分派仍然看归一化后的值（`Name:` 的删除语义要靠 trim 才判得出「冒号后只有空白」），这不影响 `rawValue` 的完整性。

**(e) 认证：拿原始字节判、也拿原始字节存**（R2 C1/C2 + **R3 C1**；改 `:48-61`、`:143-154`、`:390-419`）

> rev3 的谓词本身是对的，但它的输入是 `createHeaderPair` 归一化+trim 之后的值（V13），所以 `Basic dXNlcjpwYXNz␣` 会先被裁成 `Basic dXNlcjpwYXNz` 再顺利「通过」round-trip 校验并提升，上线时比用户写的少一个字节；即使提升失败，留在 headers 里的也已经是被 trim 过的值。**rev4 的修法：`Authorization` 从头到尾只碰 `rawValue`。**

三步，顺序不可换：

**第 1 步 —— 换行折叠（唯一被允许的改动，且必须告警）。**
`HeaderValue::from_str` 拒收含 CR/LF 的值（V7），所以带换行的 header 值无法原样送达。对 `Authorization`：

```ts
let authNotPreserved = false                                    // ← 见下方置位条件
const folded = rawValue.replace(/(?:\r\n|\r|\n)[ \t]*/g, " ")   // 不 trim
if (folded !== rawValue) {
  warnings.push({ code: "authorization-not-byte-preserved", detail: "line breaks" })
  authNotPreserved = true
}
```

**第 2 步 —— 剥掉那一个分隔空格，并判断能否复原。**
ApiSolo 只能输出 `名字 + ": " + 值`，因此原始行可复原 ⟺ `folded` 以恰好一个空格开头：

```ts
const reproducible = folded.startsWith(" ")
const storedValue = reproducible ? folded.slice(1) : folded.replace(/^[ \t]+/, "")
if (!reproducible) {
  warnings.push({ code: "authorization-not-byte-preserved", detail: "separator whitespace" })
  authNotPreserved = true
}
```
注意 `Authorization:␣␣Bearer x`（两个空格）**是**可复原的：剥掉第一个之后 `storedValue = " Bearer x"`，输出行仍是 `Authorization:  Bearer x`。不可复原的只有「冒号后不是空格」（`Authorization:Bearer x`、`Authorization:<TAB>Bearer x`）——§1.1 第三表逐条对过。

> **`authNotPreserved` 的置位条件（R4 要求写死）**：处理某条 `Authorization` 的 `set` 指令时，**当且仅当**下面任一成立就置 `true`，此后不再复位：
> 1. 换行折叠改变了值 —— `folded !== rawValue`（detail `"line breaks"`）；
> 2. 折叠后的值不以恰好一个分隔空格开头 —— `!folded.startsWith(" ")`（detail `"separator whitespace"`）。
>
> 两者可同时成立，此时推两条警告、旗标仍是一次置位。因为提升只在 `authSetIndices.length === 1` 时才发生，一个 parse 作用域内的布尔量足够表达；实现者若改成多条 Authorization 也能提升的形态，必须把它改成随 directive 走的字段。**这个旗标是「保真已受损 ⇒ 禁止提升」的唯一承重件**，测试 #30 就是专门用来压它的。

**第 3 步 —— 只有第 1、2 步都没告警时才允许提升，且谓词吃的就是 `storedValue`。**

```ts
/** 能一字不差还原时返回 AuthConfig，否则返回 null（调用方据此把 header 原样留下）。 */
function liftAuthorizationHeader(value: string): AuthConfig | null
```

- `/^Bearer (\S+)$/`（**精确大小写、恰好一个空格、token 是单段非空白**）→ `{type:"bearer"}`。还原式 `"Bearer " + token` 与 `value` 逐字节相等。
  R3 M1：rev3 写的 `/^Bearer (.+)$/` 会匹配 `Bearer␣␣good`（把第二个空格算进 token）与 `Bearer good␣`，与同句「恰好一个空格」的措辞矛盾，且会让「认证」标签里出现带不可见前后空格的 token——那是用户看不见、一编辑就坏的陷阱。`\S+` 同时排掉这两种，也与 RFC 6750 的 token 语法（不含空白）一致。既有用例 `Bearer token123`（`curl-parser.test.ts:34`）仍然匹配。
- `/^Basic ([A-Za-z0-9+/]+={0,2})$/`（**精确大小写、恰好一个空格**）且以下全部成立 → `{type:"basic"}`：
  1. `atob` 不抛错；
  2. 字节是合法 UTF-8（`new TextDecoder("utf-8", { fatal: true })` 不抛）；
  3. 解码结果**含冒号**（否则 `u + ":" + p` 会凭空补一个冒号——`bG9uZWx5` → `bG9uZWx5Og==`，V4）；
  4. 把解码结果重新 UTF-8 编码再 base64，**与捕获到的 token 逐字节相等**（挡掉非规范 base64 / 内嵌空白）。

  用户名密码按**第一个**冒号切分：`u = decoded.slice(0, i)`、`p = decoded.slice(i + 1)`，因此 `u + ":" + p === decoded` 恒成立。
- 其余一切 → `null`。因为正则锚定在 `^`/`$` 且中间不允许空白，尾随空格（`Bearer good␣`、`Basic dXNlcjpwYXNz␣`）现在会**如实地**落进这一支，而不是先被 trim 掉再蒙混过关。

主循环里的用法：
- `-H` 遇到名为 `authorization` 的 `set` 指令时，把 **`storedValue`**（不是 `pair.value`）作为该 header 的值 push 进 `explicitHeaders`，把下标记进 `authSetIndices: number[]`，并 `explicitNames.add("authorization")`。
- 收尾时：
  ```ts
  if (authSetIndices.length === 1 && !authNotPreserved) {
    const lifted = liftAuthorizationHeader(explicitHeaders[authSetIndices[0]].value)
    if (lifted) {
      auth = lifted
      explicitHeaders.splice(authSetIndices[0], 1)   // 提升成功才从 header 列表里摘掉
    }
  }
  ```
  两条及以上 → 一条都不提升，全部按原顺序留在 headers（Behavior 26）。第 1/2 步告过警、或谓词返回 `null` → 原样留下（Behavior 29 / 30）。

**不变式（实现者必须自检）**：对任何一条 `Authorization`，最终要么它被提升且 `重建值 === storedValue`，要么它留在 `headers` 里且 `值 === storedValue`。两条路都以 `storedValue` 为准，因此「校验的东西」与「发出去的东西」**是同一个字符串**——这正是 rev3 缺的那一环。

新增警告码：

```ts
| "authorization-not-byte-preserved"   // detail: "line breaks" | "separator whitespace"
```
- `-u`：循环内只把候选存进 `pendingBasicAuth`；收尾时 `if (!explicitNames.has("authorization") && pendingBasicAuth) auth = { type: "basic", basic: pendingBasicAuth }`。**判据只看名字出现过没有**，与值、与顺序、与条数都无关（Behavior 20；§1.1 实测 `-u` 在任何 Authorization 存在时都不发）。`-u` 自身按第一个冒号切分：
  ```ts
  const i = credentials.indexOf(":")
  const username = i === -1 ? credentials : credentials.slice(0, i)
  const password = i === -1 ? "" : credentials.slice(i + 1)
  ```

`parseAuthorizationHeader`（`:390-419`）被 `liftAuthorizationHeader` 取代；`:404` 原来的 `/^Basic\s+(.+)$/i` 松匹配一并去掉。

**(f) `parseCurl` 主循环其余改动**（`:36-215`）

局部状态：

```ts
let methodExplicit = false
const explicitHeaders: KeyValuePair[] = []                  // -H 实际输出的，保序、允许重名
const explicitNames = new Set<string>()                     // 所有出现过的 -H 名字（含 delete/empty），小写
const authSetIndices: number[] = []                         // explicitHeaders 里 Authorization 的下标
const generatedHeaders = new Map<string, KeyValuePair>()    // Map 保序；set 覆盖不移位
const cookieSegments: string[] = []
const warnings: CurlImportWarning[] = []
let pendingBasicAuth: { username: string; password: string } | null = null
let fileRefSeen = false
```

- `-X`（`:39-46`）→ 无条件 `index += 1`；`isHttpMethod` 为假时 `throw new Error(\`Unsupported request method: ${raw}\`)`（保留用户原始大小写）；为真时 `method = nextValue; methodExplicit = true`。
- 数据标志（`:63-88`）→ flag 集合补 `--data-ascii`。判别式
  `const isFileRef = nextValue.startsWith("@") && token !== "--data-raw" && token !== "--data-urlencode"`
  （`--data-urlencode` 的文件形态由 `parseDataUrlEncode` 判定）。`isFileRef` 时 `bodyType = "binary"`、`binaryPath = nextValue.slice(1)`、`fileRefSeen = true`、push `file-reference-not-inlined`（detail = basename）。方法推断改为 `if (!methodExplicit && method === "GET")`（`:95`、`:108` 同改）。
- `-F`（`:90-101`）→ item `valueType === "file"` 时 push `file-reference-not-inlined`（detail = `fileName`）。
- `-T`（`:103-114`）→ push 同码警告（detail = basename）。
- `-b`（`:116-123`）→ 参数不含 `=` 时不生成 header，push `cookie-file-not-supported`（detail = 原参数）；否则 `cookieSegments.push(normalizeCookieValue(v))`。
- `-A` / `-e`（`:125-141`）→ `generatedHeaders.set("user-agent" | "referer", createHeaderPair(...))`。
- URL 槽（`:200-202`）→ `if (!token.startsWith("-") && !url && token.trim())`。
- 收尾（`:205-215`）→
  ```ts
  if (cookieSegments.length) {
    generatedHeaders.set("cookie", createHeaderPair(`Cookie: ${cookieSegments.join(";")}`))  // 无空格，§1.1 实测
  }
  const headers = [
    ...explicitHeaders,
    ...[...generatedHeaders.values()].filter((h) => !explicitNames.has(h.key.toLowerCase())),
  ]
  if (fileRefSeen && bodySegments.length) {
    warnings.push({ code: "data-segments-discarded", detail: String(bodySegments.length) })
    bodySegments.length = 0
  }
  ```
  顺序上，(e) 的 Authorization 提升必须在构造 `headers` **之前**完成。`buildRequestBody` 接收合并后的 `headers`。

**(g) `--data-urlencode`**

```ts
function parseDataUrlEncode(arg: string):
  | { kind: "value"; value: string }
  | { kind: "file"; fileName: string }

function urlEncodeCurlStyle(value: string): string
```

`parseDataUrlEncode` 复刻 curl `tool_getparam.c` 的分派：先 `indexOf("=")`，没有再 `indexOf("@")`，都没有则整串是内容且无 name。有 name 时输出 `` `${name}=${urlEncodeCurlStyle(content)}` ``，**name 原样不编码**。

```ts
function urlEncodeCurlStyle(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")
}
```

三步顺序不可换：`encodeURIComponent` 已把 `+` 变成 `%2B`（所以最后一步不会和内容里原有的 `+` 混淆），再补齐 curl unreserved 集之外的 `!'()*`，最后把空格的 `%20` 换成 `+`。逐条对照 §1.1 的矩阵。

**(h) `--compressed`**（scope 追加；**独立 commit**，见 §6）

从 `:161-181` 的忽略清单里移除 `--compressed`（`:176`），改为 `generatedHeaders.set("accept-encoding", createHeaderPair(\`Accept-Encoding: ${DECODABLE_ENCODINGS}\`))`。

```ts
/**
 * --compressed 在 curl 里同时意味着「请求压缩」和「客户端会解压」。
 * ApiSolo 的解压能力由 src-tauri 的 reqwest 特性决定（D02 负责）。
 * 注意 Cargo feature 名与 Accept-Encoding 的 wire token 不是一回事：
 *     reqwest feature "gzip"    -> token "gzip"
 *     reqwest feature "deflate" -> token "deflate"
 *     reqwest feature "brotli"  -> token "br"      ← 没有名为 "br" 的 feature
 *     reqwest feature "zstd"    -> token "zstd"
 * 只列 ApiSolo 确实能解开的编码。
 */
const DECODABLE_ENCODINGS = "gzip, deflate, br"
```

`src-tauri/Cargo.toml:29` 当前是 `features = ["rustls-tls", "json", "multipart", "socks"]`——**没有任何解压特性**。启用门槛见 §6（R2 I2：只核对 feature 字符串**不充分**）。

### 2.3 `src/utils/curl-export.ts`

只改 `buildUrl`（`:42-63`），彻底移除 `new URL`：

```ts
const { baseUrl, hash } = splitUrlParts(tab.url)
const pairs = enabledPairs(tab.params).map(({ key, value }) => ({ key, value }))
if (tab.auth.type === "api-key" && tab.auth.apiKey?.addTo === "query" && tab.auth.apiKey.key) {
  // 保持既有 searchParams.set 语义：同名替换，不追加
  const key = tab.auth.apiKey.key
  const index = pairs.findIndex((p) => p.key === key)
  const entry = { key, value: tab.auth.apiKey.value ?? "" }
  if (index === -1) pairs.push(entry); else pairs[index] = entry
}
const query = pairs
  .map((p) => `${encodeQueryComponentPreservingTemplates(p.key)}=${encodeQueryComponentPreservingTemplates(p.value)}`)
  .join("&")
return `${baseUrl}${query ? `?${query}` : ""}${hash}`
```

`hasProtocol`（`:96-98`）与 `fallbackBase` 随之删除。

### 2.4 `src/utils/postman-export.ts`

```ts
export interface PostmanExportWarning {
  code: "file-content-not-exportable"
  requestName: string
  fileName: string
}

export function collectPostmanExportWarnings(requests: SavedRequest[]): PostmanExportWarning[]
```

`exportPostmanCollection` 签名**不变**。共用判别式（按字段存在性，不按真值）：

```ts
function hasInlinedFileContent(item: FormDataItem): boolean {
  return item.valueType === "file" && item.fileContent !== undefined
}
function hasInlinedBinaryContent(body: RequestBody): boolean {
  return body.type === "binary" && body.binaryContent !== undefined
}
```

- `toPostmanFormData`（`:234-249`，`src` 在 `:241-244`）：`src` 改为 `hasInlinedFileContent(item) ? undefined : (item.filePath || item.fileName || undefined)`；`description` 改为 `[note, item.description].filter(Boolean).join(" ") || undefined`，note 仅在 `hasInlinedFileContent` 时为
  `` `[ApiSolo] The content of "${item.fileName}" is stored inside ApiSolo and cannot be exported; select the file again in Postman.` ``
- `buildBody` 二进制分支（`:128-135`）：`src` 改为 `hasInlinedBinaryContent(request.body) ? undefined : (request.body.binaryPath || undefined)`。`src` 省略时 `file` 仍写成 `{}`，保住 `mode: "file"` 的语义。
- `buildRequestItem`（`:89-121`）：`hasInlinedBinaryContent` 时给 `item.request.description` 写同形态的英文说明（Postman v2.1 的 `request` 对象允许 `description`）。
- `buildRawUrl`（`:262-277`）：改用 `splitUrlParts`——`return queryItems.length ? \`${baseUrl}?${queryItems.join("&")}${hash}\` : \`${baseUrl}${hash}\``。参数值**仍不编码**。

### 2.5 `src/utils/openapi-import.ts`

```ts
const MAX_SCHEMA_DEPTH = 20

function generateSchemaExample(
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec,
  seenRefs: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown
```

函数体开头：

```ts
if (depth > MAX_SCHEMA_DEPTH) return null
const ref = schema?.$ref?.trim()
if (ref && seenRefs.has(ref)) return null
const nextSeen = ref ? new Set([...seenRefs, ref]) : seenRefs
```

`:287`/`:291`/`:295`/`:300`/`:305` 五处递归全部改为 `generateSchemaExample(child, spec, nextSeen, depth + 1)`。顶层调用点（`:176`、`:190`、`:222`、`:345`）保持两参调用。`resolveSchemaRef`（`:370-390`）与 `isBinarySchema`（`:365`）不动。

终止性：每往下一层，要么 `seenRefs` 至少多一个元素（`$ref` 有限），要么这一层是内联对象。纯内联对象图从 `JSON.parse` 出来必然有限；只有 YAML 锚点能造出内联真环，由 `MAX_SCHEMA_DEPTH` 兜住。

## 3. 与 review / backlog / 前序 rev 的分歧

| 位置 | 原说法 | 实测结论 |
|---|---|---|
| **`--data-urlencode` 的空格编码** | REVIEW #17 写 `curl's q=a%20b%26c`；`TEST-CHECKLIST` T19 第 7 步同；**rev1 照抄了这个错误** | **V1：`q=a+b%26c`**。curl 在 `curl_easy_escape` 之后显式做 `%20 → +` 替换。**两份 review 文档都需要更正**（§8 N4） |
| **多条显式 `Authorization`** | rev2 把每个可识别值写进单一 `auth`、不进 headers | **V3：真 curl 两条都发**（两 Bearer / Basic+Bearer / Custom+Bearer 三组皆然）。rev2 会静默只剩最后一条（R2 C1） |
| **非 UTF-8 / 无冒号的 Basic** | rev2 让非法 UTF-8 回落逐字节串再交给 UI Basic | **V3 + V4：真 curl 原样发 `Basic /zph`、`Basic bG9uZWx5`；rev2 的路径会发出 `Basic w786YQ==`、`Basic bG9uZWx5Og==`——认证字节被静默改写**（R2 C2） |
| `--data-ascii` | backlog / review 都未提 | V1：它是 `--data` 的别名、保留 `@file` 语义。V5：今天 ApiSolo 连 flag 都不认，`@payload.json` 顶替真实 URL |
| `curl-export.ts:44` | 「破坏含 `{{变量}}` 的 URL」 | V5：更广——**任何**不带协议的 URL 都被吃掉主机，与模板无关 |
| `postman-export.ts` | 只记了伪路径降级 | V5：另有 review 未记的缺陷——`buildRawUrl:275` 把查询串拼到 fragment **之后**，产出非法 URL |
| `curl-parser.ts:146` `:411` | 「Basic 密码含冒号被截断」 | V5：同两行还有 `atob` 无 UTF-8 解码，`用户:密码` 解成 `ç¨æ·` / `å¯ç ` |
| backlog `curl-parser.ts:113`（low） | 只点名 `-b` 与 `-H 'Cookie:'` | V5：`-A` / `-e` 是同一缺陷；`-u` 与 `-H 'Authorization:'` 是顺序依赖 |
| 多个 `-b` 的连接符 | rev1 写 `"; "`（带空格） | **V2：`a=1;b=2`，无空格** |
| 内存态文件判别 | rev1 写 `Boolean(fileContent)` | V9：零字节文件的 `fileContent` 是 `""`，会被误判 |
| reqwest brotli 的 feature 名 | rev2 的 `DECODABLE_ENCODINGS` 注释暗示 feature 与 token 同名 | reqwest 0.12 的 feature 是 `brotli`，wire token 才是 `br`（R2 I2），已在 §2.2(h) 写成显式映射表 |
| REVIEW #2 描述 | `-H $'x-t: 中'` 会命中 `$'…'` | V11（转引 review 自己的更正）：Chrome 只对控制字符 / DEL-C1 / `!` / `'` 触发；用例改用 `!` 与 `\r\n` |
| REVIEW #13 修法建议 | 「抛 unsupported method **或**保住 URL」 | 选「抛错」。`HttpMethod` 是 7 成员闭集，静默降成 GET 就是「UI 说谎」。代价见 §8 B1/B2 |

另：backlog 顶部当前（HEAD `410b32b`）**没有** prompt 里提到的两条 owner errata。`REVIEW #n` 偏移 +2 按 `file:line` 独立复核成立（backlog `REVIEW #31 / request.ts:549` = review 索引 #29，`#30 / request.ts:565` = #28，`#29 / lib.rs:2041` = #27，`#41 / request.ts:96` = #39）。D06 表格本身全部按 `file:line` 索引。

## 4. 可追溯性：backlog 条目 → 不变式（R1 I3 / R2 I4）

46 条不变式全部保留、不拆分（R1 裁定：全部落在本来就要重写的同一批函数里）。`BACKLOG.md` 由 owner 更新登记，此处提供正向对照。

| backlog / 追加来源 | 位置 | 覆盖的不变式 |
|---|---|---|
| D06 行 1（high） | `curl-parser.ts:329` | 1, 2, 3, 4, 5 |
| D06 行 2（med） | `curl-parser.ts:39` | 6, 9 |
| D06 行 3（med） | `curl-parser.ts:82` | 7, 8 |
| D06 行 4（med） | `curl-parser.ts:72` | 10, 11, 12, 13, 14, 15 |
| D06 行 5（med） | `RequestPanel.vue:225` | 34, 40（两个导出器的去重）+ 交接 §8 N1（根因，**判定为归档错位**） |
| D06 行 6（med） | `curl-export.ts:44` | 32, 33, **35**（35 是本次重写 `buildUrl` 时必须保住的 fragment 回归护栏；R2 I4 指出 rev2 漏了它） |
| D06 行 7（med） | `openapi-import.ts:300` | 44, 45, 46 |
| D06 行 8（low） | `curl-parser.ts:113` | 16, 17, 18, 19, 20, 21, 22, 24, 26 |
| D06 行 9（已知债） | `curl-parser.ts:146` `:411` | 25, 27, 28, 29, **30**（30 是 R3 C1 引出的：修「密码被截断」必须连带保证凭据头的**全部**字节不被改写，否则同一条债只补了一半） |
| D06 行 10（已知债） | `postman-export.ts:242` `:129` | 36, 37, 38, 39, 42, 43 |
| **R1 scope 追加**（来自 D02 的发现） | `curl-parser.ts:176` | 23 |
| 重写同一函数时新发现（§3 已列） | `postman-export.ts:275` | 41 |
| 新增警告通道的反向护栏 | — | 31 |

覆盖集合 = {1…46}，无孤儿、无重复。

## 5. Testing and validation

全部 vitest（`npm run test`）。「杀手」= 让该条测试**变红**的**单行、可编译**实现改动（R2 I3：不可编译的改动不算杀手）。用例一律用真实数据（中文文件名、真实 Chrome 形态的 curl、带冒号的密码）。

### 5.1 `src/utils/__tests__/curl-parser.test.ts`（扩写）

| # | 测试名 | 断言要点 | 杀手（单行、可编译） |
|---|---|---|---|
| 1 | `decodes $'...' ANSI-C quoted headers copied from DevTools` | header 只有一行、key === `"cookie"`（`not.toMatch(/^\$/)`）、value === `"sid=abc!def"`；`auth.type === "bearer"`、token === `"xyz"`、headers 里没有 authorization | `tokenizeCurlCommand` 里把 `pendingDollar` 分支条件改成 `false` |
| 2 | `decodes every documented ANSI-C escape class` | 表驱动，逐类覆盖：`\\`→`\`、`\'`→`'`、`\"`→`"`、`\a`/`\b`/`\e`/`\E`/`\f`/`\v` 各自对应控制字符、`\t`→TAB、`\n`→LF、`\r`→CR、`\x7`（1 位）、`\x21`→`!`（2 位）、`中`（4 位）、`\u41`→`A`（短位）、`\U0001F600`→`😀`（8 位）、`\101`→`A`（3 位八进制）、`\7`（1 位八进制）、`\z`→`\z`（未知）、`\xZZ`→`\xZZ`（非法十六进制）、末尾孤立 `\`→`\`。断言落在 body content 上（`-d $'…'`）以避开 header 归一化 | `decodeAnsiCEscapes` 的 `\x` 分支改成只取 1 位十六进制（`hex.slice(0, 1)`）→ `\x21` 解成控制字符 + `"1"` |
| 3 | `folds decoded CR and LF inside header values` | `-H $'x-note: line1\r\nline2'` → `"line1 line2"`；`not.toContain("\r")`、`not.toContain("\\r")`；`-H $'x-note: a\rb'`（孤立 CR）→ `"a b"`；`-H $'cookie: a=1\r\n  b=2'` → `"a=1b=2"` | `normalizeHeaderValue` 正则改回 `/\r?\n[ \t]*/g` → 孤立 CR 用例红 |
| 4 | `decodes $'...' on the -b cookie flag` | `-b $'sid=abc!def'` → 一行 `Cookie`、值 `"sid=abc!def"` | **与 #1 共用杀手**（同一 `pendingDollar` 分支）。诚实披露：本条不提供独立杀手，价值在于覆盖 `-b → normalizeCookieValue` 这条现代 Chrome 实际走的下游路径 |
| 5 | `treats an escaped dollar as a literal dollar` | `curl -d \$'x' …` → body content `"$x"`；`-d '$x'` → `"$x"` | `escapeNext` 分支里也置 `pendingDollar = true` → 得到 `"x"` |
| 6 | `throws on a request method outside the supported set` | `it.each(["PURGE", "pos", "LOCK"])`：`toThrow(/PURGE|pos|LOCK/)`；显式断言不会返回 `url === "PURGE"` | 删掉 `-X` 分支里的 `throw` 行 |
| 7 | `honors an explicit -X GET regardless of data flag order` | `-X GET -d 'q=1'` 与 `-d 'q=1' -X GET` 都得 `"GET"`；`-X GET -T ./f.bin` 得 `"GET"`；body 仍在 | `-d` 分支的 `if (!methodExplicit && method === "GET")` 改回 `if (method === "GET")` |
| 8 | `still infers POST and PUT when no method is given` | `-d 'q=1'` → POST；`-F 'a=b'` → POST；`-T f.bin` → PUT | 删掉 `-d` 分支里的 `method = "POST"` |
| 9 | `ignores whitespace-only tokens when picking the URL` | `"curl -X POST \\ \n 'https://api.example.com/a'"` → url === `"https://api.example.com/a"` | URL 槽守卫去掉 `&& token.trim()` |
| 10 | `routes every @file data flag to the same binary placeholder` | `it.each(["-d","--data","--data-ascii","--data-binary"])` 对 `@payload.json` 的 `body` **深相等**于 `{type:"binary", content:"", formData:[], binaryPath:"payload.json"}`；各含一条 `file-reference-not-inlined`、detail `"payload.json"`；另断言 `--data-ascii` 不再把 `@payload.json` 当 URL | 从 flag 集合里删掉 `"--data-ascii"` → 该行红（也是 R1 C2 的回归护栏）。第二杀手：文件判别式改回 `token === "--data-binary" && …` → 前三行红 |
| 11 | `keeps --data-raw @file literal` | `--data-raw @payload.json` → `body.type === "raw"`、content `"@payload.json"`、`warnings` 为空 | 判别式去掉 `&& token !== "--data-raw"` |
| 12 | `url-encodes --data-urlencode byte-for-byte like curl` | 表驱动逐条对齐 §1.1：`'q=a b&c'`→`q=a+b%26c`、`'q=a!b'`→`q=a%21b`、`"q=a'b"`→`q=a%27b`、`'q=a(b)c*d'`→`q=a%28b%29c%2Ad`、`'q=a+b'`→`q=a%2Bb`、`'q=a~b-c_d.e'`→原样、`'q=中文'`→`q=%E4%B8%AD%E6%96%87` | `urlEncodeCurlStyle` 去掉 `.replace(/%20/g, "+")` → 第一行得到 `q=a%20b%26c`（正是 rev1 的错误值） |
| 13 | `splits --data-urlencode forms on the first = then the first @` | `'=a b'`→`"a+b"`；`'a b'`→`"a+b"`；`'name=a@b'`→`"name=a%40b"`；`'na me=x y'`→`"na me=x+y"`；`'body@payload.json'`→ binary 占位 + 文件警告 | 分派顺序反过来（先找 `@` 再找 `=`）→ `name=a@b` 变成文件引用 |
| 14 | `warns with the exact count of dropped inline data segments` | `it.each`：`-d 'a=1' -d @payload.json` → detail `"1"`；`-d 'a=1' -d 'b=2' -d @payload.json` → detail `"2"`。两例 body 都是 binary 占位 | 条件由 `bodySegments.length > 0` 改成 `> 1` → **单段那一行红** |
| 15 | `warns for every file reference and only for file parts` | `-F 'note=hi' -F 'file=@报告.pdf' -T upload.bin` → 恰好 2 条 `file-reference-not-inlined`，detail `"报告.pdf"` / `"upload.bin"`；`note` 不产生警告 | `-F` 的告警条件由 `item.valueType === "file"` 改成 `true` → 变成 3 条 |
| 16 | `lets an explicit -H suppress the header curl would generate` | `it.each` **三组**（Cookie / User-Agent / Referer）× 两种 flag 顺序 → 该名 header 恰好 1 行、值取 `-H` 的那个。**本行不出现 `--compressed`**（R2 I1） | 收尾处删掉生成项的 `.filter((h) => !explicitNames.has(...))` |
| 17 | `keeps two explicit -H Cookie headers as two headers` | `-H 'Cookie: a=1' -H 'Cookie: b=2'` → 2 行，顺序 `a=1`、`b=2` | 收尾处把 `...explicitHeaders` 换成 `...new Map(explicitHeaders.map((h) => [h.key.toLowerCase(), h])).values()`（单行、可编译）→ 只剩 1 行 |
| 18 | `merges multiple -b flags with a bare semicolon` | `-b 'a=1' -b 'b=2'` → 1 行、值 `"a=1;b=2"`（`not.toContain("; ")`）；`-b 'a=1; b=2'` 单 flag → `"a=1; b=2"` | `cookieSegments.join(";")` 改回 `join("; ")` → 第一行红 |
| 19 | `collapses repeated -A and -e to a single last-wins header` | `-A 'x' -A 'y'` → 1 行 `User-Agent: y`；`-e 'r' -e 's'` → 1 行 `Referer: s` | 只改 `-A` 分支那次 `generatedHeaders.set(...)` 的**第一个实参**：字面量 `"user-agent"` → 模板串 `` `user-agent-${index}` ``，第二个实参（`createHeaderPair(...)` 整个表达式）原样不动。`index` 是 `parseCurl` 主循环的循环变量，作用域内可见，**可编译**（R4 M1：rev4 写成 `set(..., pair)` 引用了拟定实现里不存在的 `pair` 标识符）。两次 `-A` 落成两个不同 map key → 输出 2 行 User-Agent → 断言「1 行、值为 `y`」红 |
| 20 | `suppresses -u whenever any Authorization header is present` | `it.each` 两种 flag 顺序 × 四种值（`Bearer t` / `Custom abc` / `basic <b64>` / 两条 Bearer）→ 全部断言最终**不存在**「`auth.type === "basic"` 且用户名是 `-u` 里那个」 | `-u` 收尾判断由 `!explicitNames.has("authorization")` 改成 `auth.type === "none"`（单行、可编译）→ `Custom abc`、小写 `basic`、两条 Bearer 三种情形都会被 `-u` 补上 Basic |
| 21 | `treats -H 'Name:' as curl's delete directive` | `-H 'X-Custom:'` → 无该 header；`-H 'Authorization:' -u a:b` → `auth.type === "none"` 且无 Authorization；`-H 'Cookie:' -b 'a=1'` → 无 Cookie 行 | `parseHeaderDirective` 的空值分支由 `delete` 改成 `set` → 出现一行空 `X-Custom` |
| 22 | `treats -H 'Name;' as an empty-valued header` | `-H 'X-Custom;'` → 一行 key `"X-Custom"`（`not.toContain(";")`）、value `""`；`-H 'Cookie;' -b 'a=1'` → 一行空 `Cookie`、`-b` 被抑制 | 删掉 `;` 分支 → key 变成字面量 `"X-Custom;"`（今天的行为） |
| 23 | `turns --compressed into an Accept-Encoding header` | `curl --compressed https://…` → 恰好一行 `Accept-Encoding`，值 === **字面量** `"gzip, deflate, br"`（**测试不得 import `DECODABLE_ENCODINGS`**，否则常量被改时断言跟着变，成为自证）；`--compressed -H 'Accept-Encoding: gzip'` → 一行、值 `"gzip"`。**本行是全套测试里唯一出现 `--compressed` 的地方**（R2 I1） | `DECODABLE_ENCODINGS` 的值改成 `"gzip"`（单行、可编译）→ 字面量断言红 |
| 24 | `treats a -b argument without = as an unreadable cookie file` | `-b cookies.txt` → 无 Cookie 行；`warnings` 一条 `cookie-file-not-supported`、detail `"cookies.txt"` | 判别式 `!cookieValue.includes("=")` 改成 `false` → 出现 `Cookie: cookies.txt` |
| 25 | `keeps colons inside a -u password` | `-u 用户:pa:ss:word` → username `"用户"`、password `"pa:ss:word"`；`-u lonely` → username `"lonely"`、password `""` | `-u` 分支改回 `credentials.split(":")` 解构 |
| 26 | `never folds multiple explicit Authorization headers into one` | `it.each` 三组：两 Bearer / Basic+Bearer / Custom+Bearer。每组断言 `headers.filter(h => h.key.toLowerCase() === "authorization")` **长度为 2**、两个 value 逐字节等于原始输入、且 `auth.type === "none"` | 收尾处的 `if (authSetIndices.length === 1)` 改成 `if (authSetIndices.length >= 1)`（单行、可编译）→ 第一条被提升并摘除，只剩 1 行 |
| 27 | `keeps colons inside a lifted Basic password` | `Authorization: Basic <base64("api-user:pa:ss")>` → `auth.type==="basic"`、password `"pa:ss"`、headers 里已无 Authorization | `liftAuthorizationHeader` 的切分改回 `decoded.split(":")` 解构 |
| 28 | `decodes UTF-8 credentials in a lifted Basic header` | `Authorization: Basic 55So5oi3OuWvhueggQ==`（`用户:密码`）→ username `"用户"`、password `"密码"` | 删掉 `TextDecoder` 那段，直接用 `atob` 结果 → 得到 `ç¨æ·` |
| 29 | `leaves an Authorization header byte-identical when it cannot be lifted` | `it.each` **九种**，每种的 `-H` 参数写成 `` `Authorization: ${value}` ``，断言 **headers 里恰好一行 Authorization 且 `value` 与输入的 `${value}` 逐字节相同**（`toBe`，不是 `toContain`；这就是最终上线的那一行——`lib.rs:2317-2321` 原样装填，V6 静态）、`auth.type === "none"`、且同一条命令加上 `-u a:b` 后仍不产生 Basic。九种：① `Basic /zph`（非法 UTF-8）② `Basic bG9uZWx5`（无冒号）③ `Custom abc` ④ `basic dXNlcjpwYXNz`（小写 scheme）⑤ `Basic␣␣␣dXNlcjpwYXNz`（scheme 后多空格）⑥ `Basic dXNlcjpwYXNz=`（非规范 base64）⑦ **`Bearer good␣`（尾随空格，R3 C1）** ⑧ **`Basic dXNlcjpwYXNz␣`（尾随空格，R3 C1）** ⑨ **`Bearer␣␣good`（scheme 与 token 之间双空格，R4 M2）**。⑦⑧ 必须写成模板串或显式拼接，别让编辑器/格式化工具吃掉尾随空格——建议 `` `Bearer good${" "}` `` 这种不会被 trim 掉的写法。⑨ 另外断言**不产生** `authorization-not-byte-preserved` 警告（它是可复原的，只是不该被提升——这一条把「不提升」与「保真受损」两件事区分开） | 让 `Authorization` 走回 `pair.value`（即把 `explicitHeaders.push` 的值由 `storedValue` 换成 `directive.pair.value`，单行、可编译）→ ⑦⑧ 两行红：值被 trim 成 `Bearer good` / `Basic dXNlcjpwYXNz`，⑧ 还会被提升导致该行整个消失。**第二杀手**：`/^Bearer (\S+)$/` 改回 `/^Bearer (.+)$/` → ⑦⑨ 两行红（⑨ 的 loose 捕获是 `" good"`，重建 `"Bearer " + " good"` 逐字节相等，所以 round-trip 谓词挡不住它，**只有 `\S+` 挡得住**——正是 R3 M1 指出的那一格）。第三杀手：`/^Basic ([A-Za-z0-9+/]+={0,2})$/` 改回 `/^Basic\s+(.+)$/i` → ④⑤ 红 |
| 30 | `warns instead of silently normalizing an Authorization layout it cannot reproduce` | `it.each` 三种：① `-H 'Authorization:Bearer good'`（冒号后无空格）② `-H $'Authorization:\tBearer good'`（TAB）③ **`-H $'Authorization: Bearer\r\n  eyJhb'`**（值含换行；`\r\n` 在测试源码里必须写成字面反斜杠 `\\r\\n`，让 ANSI-C 解码器把它变成真 CR LF，走的才是 Chrome 折行的真实路径）。每种断言恰好一条 `authorization-not-byte-preserved` 警告、detail 为 `"separator whitespace"`（①②）或 `"line breaks"`（③）、**且 `auth.type === "none"`**、**且 headers 里保留一行 Authorization**。反向断言：`-H 'Authorization: Bearer good'`（规范写法，会被提升）与 `-H 'Authorization:  Bearer good'`（两个空格，可复原、不提升）都**不**产生这条警告 | 第 2 步的 `if (!reproducible)` 改成 `if (false)`（单行、可编译）→ ①② 的警告断言红。**第二杀手（guard 承重件）**：收尾提升条件里删掉 `&& !authNotPreserved` → ③ 的 `storedValue` 恰好是合法的 `Bearer eyJhb`，谓词放行、被提升，`auth.type === "none"` 与「headers 里仍有一行」两条断言同时红 |

**#29⑨ / #30 的 fixture 实算对照表（V14，node 实跑；实现者可照抄断言，不必重新推导）**

三步管道：ANSI-C 解码 → `folded = rawValue.replace(/(?:\r\n|\r|\n)[ \t]*/g, " ")` → `storedValue = folded.startsWith(" ") ? folded.slice(1) : folded.replace(/^[ \t]+/, "")`。最后两列是**同一条 fixture 在「保留 guard」与「删掉 `&& !authNotPreserved`」两种实现下**是否被提升——最后一列（第 7 列，「删 guard 提升」）必须为 `true`，否则这条用例压不住 guard。

| fixture（`-H` 参数） | `rawValue` | `folded` | `storedValue` | warnings | 带 guard 提升 | **删 guard 提升** |
|---|---|---|---|---|---|---|
| ~~`authorization: Bearer ey\r\n  Jhb`~~（rev4 旧例，**已删**） | `" Bearer ey\r\n  Jhb"` | `" Bearer ey Jhb"` | `"Bearer ey Jhb"` | `["line breaks"]` | false | **false ← 假绿** |
| #30③ `Authorization: Bearer\r\n  eyJhb` | `" Bearer\r\n  eyJhb"` | `" Bearer eyJhb"` | `"Bearer eyJhb"` | `["line breaks"]` | false | **true ✓** |
| #30① `Authorization:Bearer good` | `"Bearer good"` | `"Bearer good"` | `"Bearer good"` | `["separator whitespace"]` | false | **true ✓** |
| #30② `Authorization:<TAB>Bearer good` | `"\tBearer good"` | `"\tBearer good"` | `"Bearer good"` | `["separator whitespace"]` | false | **true ✓** |
| #30 反向 `Authorization: Bearer good` | `" Bearer good"` | 同左 | `"Bearer good"` | `[]` | true（应被提升） | — |
| #30 反向 `Authorization:  Bearer good` | `"  Bearer good"` | 同左 | `" Bearer good"` | `[]` | false（前导空格，谓词挡住） | — |
| #29⑨ `Authorization: Bearer  good` | `" Bearer  good"` | 同左 | `"Bearer  good"` | `[]` | false（`\S+` 挡住） | — |

最后一行同时验证了 R3 M1 的必要性：`"Bearer  good"` 在宽松式 `/^Bearer (.+)$/` 下捕获 `" good"`，重建 `"Bearer " + " good"` 与 `storedValue` **逐字节相等**，所以 round-trip 谓词放行——挡住它的只有 `\S+`。

| # | 测试名 | 断言要点 | 杀手（单行、可编译） |
|---|---|---|---|
| 31 | `reports no warnings for a fully representable command` | Chrome 形态 curl（`-H` + `-b` + `-d 'k=v'`，**不含 `--compressed`**，R2 I1）→ `warnings` 为 `[]` | `-F` / `-d` 的告警条件改成无条件 push → 数组非空。与 #15 是一对反向变异：#15 证「该报时会报」，#31 证「不该报时不报」 |

既有 9 条用例（`curl-parser.test.ts:5-140`）全部保留且必须继续通过——尤其 `:34`（`Bearer token123` 提升）与 `:43`（`-u` → basic），它们是 §2.2(e) 收紧后的护栏；以及 `:100` / `:114` / `:128` 三条换行归一化用例。

### 5.2 `src/utils/__tests__/curl-export.test.ts`（扩写）

| # | 测试名 | 断言要点 | 杀手 |
|---|---|---|---|
| 32 | `exports templated and protocol-less URLs verbatim` | `{{baseUrl}}/users` → `curl '{{baseUrl}}/users'`（`not.toContain("%7B")`）；`https://api.example.com/{{id}}/x` 原样；`api.example.com/users` → `curl 'api.example.com/users'`（`not.toContain("'/api.example.com")`） | `buildUrl` 的返回值外面套 `encodeURI(...)` |
| 33 | `percent-encodes params but keeps {{templates}} intact` | 参数 `token={{apiToken}}` → `token={{apiToken}}`；同一条里 `q=a b` → `q=a%20b` | `encodeQueryComponentPreservingTemplates` 换成 `encodeURIComponent` |
| 34 | `does not duplicate a query string left in tab.url` | url `…/s?q=cat` + params `[q=cat]` → `curl.match(/q=cat/g)` 长度为 1 | `splitUrlParts(tab.url).baseUrl` 改回 `tab.url` |
| 35 | `keeps the fragment after the query string` | url `https://api.example.com/a#frag` + `k=v` → `'https://api.example.com/a?k=v#frag'` | 拼接顺序改成 `${baseUrl}${hash}${query}` |

既有 6 条用例保留；`roundtrips: export then parse preserves key fields`（`:60`）在两侧都改之后仍必须绿——它是跨 parser/exporter 的集成护栏。

### 5.3 `src/utils/__tests__/postman-export.test.ts`（扩写 + 改写既有断言）

> **必须改写既有断言**：`postman-export.test.ts:140-144` 现在断言 `body.file.src === "payload.bin"` 与 `formdata[0].src === "hello.txt"`。前者 fixture 是 `binaryContent: ""`、后者是 `fileContent: "aGVsbG8="`——**两个都是内存态文件，这条既有测试正在给 bug 背书**（前者恰好就是零字节形态）。按 Behavior 36/37/38 改写为「不写 `src` + 有说明」，并新增 #39 覆盖「只有文件名、无内联内容」仍应写 `src` 的分支。这是本切片唯一一处修改既有断言，实现者必须在 commit message 里说明原因。

| # | 测试名 | 断言要点 | 杀手 |
|---|---|---|---|
| 36 | `does not fabricate a src for an in-memory multipart file` | `fileName:"报告.pdf"` + `fileContent:"aGVsbG8="` → `formdata[0].src === undefined`、`type === "file"`、`description` 含 `"报告.pdf"` 与 `"ApiSolo"` | `src` 改回 `item.filePath \|\| item.fileName \|\| undefined` |
| 37 | `does not fabricate a src for an in-memory binary body` | `binaryPath:"报告.pdf"` + `binaryContent:"aGVsbG8="` → `body.mode === "file"`、`body.file.src === undefined`、`item.request.description` 含 `"报告.pdf"` | `src` 改回无条件 `request.body.binaryPath \|\| undefined` |
| 38 | `treats a zero-byte upload exactly like a non-empty one` | `it.each` 三处：① multipart `fileContent: ""` → `src === undefined` 且有 description；② binary `binaryContent: ""` → `file.src === undefined` 且 request 有 description；③ `collectPostmanExportWarnings` 对这两个请求各返回一条 | `hasInlinedFileContent` 的 `item.fileContent !== undefined` 改回 `Boolean(item.fileContent)` → ①③ 红；`hasInlinedBinaryContent` 同改 → ② 红 |
| 39 | `keeps the src of a file field that never had in-memory content` | `fileName:"hello.txt"`、`fileContent: undefined` → `src === "hello.txt"`、`description === undefined`；binary `binaryPath:"payload.bin"`、`binaryContent: undefined` → `file.src === "payload.bin"` | `hasInlinedFileContent` 的判别改成 `item.fileName !== undefined` → src 被吞 |
| 40 | `does not duplicate a query string left in the saved url` | url `…/s?q=cat` + params `[q=cat]` → `url.raw === "https://api.example.com/s?q=cat"` | `splitUrlParts(url).baseUrl` 改回 `url` |
| 41 | `keeps the fragment after the query string in url.raw` | url `…/a#frag` + `k=v` → `"https://api.example.com/a?k=v#frag"` | 拼接顺序改成 `${baseUrl}${hash}?${query}` |
| 42 | `collectPostmanExportWarnings lists every unexportable upload` | #36/#37 两个请求 + 一个 #39 占位 → 恰好 2 条，`requestName`/`fileName` 对得上；纯文本请求返回 `[]` | 判别式改成 `Boolean(item.filePath)`（该字段全应用恒为 `""`，V8）→ 返回 `[]` |
| — | 既有 `generates valid Postman collection JSON`（`:21`） | 保持不变（模板 URL、raw body、event 数量） | — |

### 5.4 `src/utils/__tests__/postman-import.test.ts`（扩写）

| # | 测试名 | 断言要点 | 杀手 |
|---|---|---|---|
| 43 | `round-trips an in-memory upload into an empty file slot` | 用 `exportPostmanCollection` 导出内存态上传（`报告.pdf` + base64），再 `parsePostmanCollection` 读回：`valueType === "file"`、`fileName === ""`、`filePath === ""`、`fileContent === undefined` | `postman-import.ts:304` 的 `return src ?? ""` 改成 `return src ?? "unknown"` → `fileName` 变 `"unknown"`（杀手落在 import 侧，与 #36 的 export 侧杀手相互独立） |

### 5.5 `src/utils/__tests__/openapi-import.test.ts`（扩写）

| # | 测试名 | 断言要点 | 杀手 |
|---|---|---|---|
| 44 | `imports specs whose schema graph is cyclic` | `it.each` 三种环：① `Node.child → Node`；② `A.b → B` / `B.a → A`；③ `Node.children.items → Node`。每种断言不抛错、同文档 `/health` 端点在、且**第一层环处**就是 `null`（①：`JSON.parse(body.content).child === null`；③：`children` 深相等 `[null]`） | `if (ref && seenRefs.has(ref)) return null` 改成 `if (false)`。**注意失败模式**：`MAX_SCHEMA_DEPTH` 会先于爆栈生效，所以它**不会**抛 `RangeError`，而是让示例在第 21 层才变 `null`——测试因「`child` 是一个深层嵌套对象而非 `null`」的结构断言而红（R2 I3 更正 rev2 的错误描述）。因此断言必须写成 `child === null`，**不能**写成 `expect(() => …).not.toThrow()` |
| 45 | `truncates a  chain deeper than the depth cap` | 构造 25 个互不相同的 schema 串成链（`S0.next → S1 → … → S24`），断言导入成功且第 21 层为 `null` | `depth > MAX_SCHEMA_DEPTH` 改成 `depth > 1000` → 该层不再是 `null` |
| 46 | 既有的 `resolves local component schema refs when generating request body examples`（`openapi-import.test.ts:164`，**不改**） | 非环状 `$ref` 仍被完整展开：`PetProfile` 的 nickname/age 示例照旧 | 环判别改成 `seenRefs.size > 0` → 第一层嵌套 ref 就返回 `null`，既有断言红 |

### 5.6 交付前必跑

- `npm run test`（全量，不加 filter；确认 `Executed N > 0`，别让过滤器匹配 0 条测试假绿——memory `no-sham-tests` §13）
- `npm run build`（`vue-tsc --noEmit`）
- 声称完成前自己重跑 `npm run release:check`（memory `release-check-is-the-gate`）
- **`--data-urlencode` 与 header/认证优先级的用例，实现者必须用本机真 curl 重新对一遍**（`curl --libcurl` + 裸 TCP echo），不要以本 spec 的表格为唯一依据——rev1 就是因为照抄 review 文档而写错了 `%20`
- **独立性验证（确定性 mutation，不是 commit revert）**（R2 I1 + **R3 I1**）。
  R3 I1 指出 rev3 的写法有洞：`--compressed` 是独立 commit，执行者照着「临时 revert §2.2(h)」多半会跑 `git revert <commit>`，那会把实现**和测试 #23 一起**撤掉，全套可能全绿——步骤能完整照做，却证明不了任何事。改成下面这套，任何一步都不许碰测试文件：

  1. 工作区停在最终 HEAD，`src/utils/__tests__/curl-parser.test.ts` **原样不动**（测试 #23 必须在场）。
  2. 只对实现做一处临时改动：把 `"--compressed"` 加回 `curl-parser.ts:161-181` 的忽略清单，并删掉 §2.2(h) 里 `generatedHeaders.set("accept-encoding", …)` 那一行。**不 commit、不 revert、不动任何 `*.test.ts`。**
  3. `npm run test`（全量、不加 filter），记录 vitest 汇总行 `Tests  N failed | M passed (T)`。
  4. 判据三条同时成立才算通过：
     - `T > 0`（跑到了测试，不是过滤器匹配了 0 条）；
     - **`N === 1`**（恰好一条失败）；
     - 失败用例名精确等于 `turns --compressed into an Accept-Encoding header`。
     `N === 0` → 测试 #23 没有真正在跑（查是否被 skip/filter），证据无效；`N > 1` → `--compressed` 渗进了别的用例，把它从那些用例里清出去再重来。
  5. 撤销第 2 步的临时改动，再跑一次全量，必须全绿。
- 手测回归以 `docs/review/TEST-CHECKLIST-2026-08-18.md` 的 T11 与 T19 为准，须在**打包后的 macOS 应用**里做（memory `acceptance-in-native-app`）。注意 T19 第 7 步的期望值 `q=a%20b%26c` **是错的**，正确期望是 `q=a+b%26c`

## 6. Risks

| 风险 | 说明 | 缓解 |
|---|---|---|
| **`--compressed` 早于 D02 合入会造成回归** | 今天 `src-tauri/Cargo.toml:29` 的 reqwest 没有任何解压特性，`lib.rs:2440` 也不解压。一旦让 `curl --compressed <url>` 带上 `Accept-Encoding`，原本可读的响应会变成 U+FFFD 乱码 | **双重门槛（R2 I2：只核对 Cargo feature 字符串必要但不充分）**：① `src-tauri/Cargo.toml` 的 reqwest features 含 `gzip` / `deflate` / `brotli`（注意是 `brotli` 不是 `br`），并据此确定 `DECODABLE_ENCODINGS` 的 wire token；② **D02 针对真实 gzip / deflate / br 响应体的解压测试已通过**——只有实际解出明文才算数。两条都满足前，§2.2(h) 与测试 #23 保持未合入状态 |
| **「其余 45 条可独立发布」必须是真的独立** | rev2 声称可独立，但 #16 的抑制矩阵和 #31 的零警告命令里都含 `--compressed`，只回退 §2.2(h) 会让这两条红——独立是假的（R2 I1） | 已按裁定收口：`--compressed` 只出现在 Behavior 23 / 测试 #23，#16 只测 Cookie / User-Agent / Referer，#31 的命令不含 `--compressed`。**R3 I1 又指出 rev3 的验证步骤本身有洞**（`git revert` 会连测试一起撤掉，可能全绿），§5.6 已改写成「保留测试、只改实现、断言 failed 恰好为 1 且失败用例名精确匹配」的确定性 mutation |
| 认证提升口径收紧带来的 UX 变化 | 小写 `basic`、多空格 `Basic   x` 等写法不再自动填充「认证」标签 | 凭据照常按原字节发送，功能不受损；PRODUCT 已把它写成显式的既定取舍而非意外 |
| `url-query.ts` 与 D01 的 `url-params.ts` 主题重叠 | 两条切片各建一个 URL 工具模块 | D06 不看不改不依赖 D01 的文件；合并与否由 owner 在两切片都合入后裁定（§8 N6） |
| 导出侧丢掉 `tab.url` 里的查询串 | Behavior 34/40 让参数表成为查询串唯一来源。若某个历史存盘 request 是「url 带 query 但 params 为空」，导出会少掉这段 query | 这段 query 今天已是死数据：URL 栏渲染走 `buildUrlWithParams`（`RequestPanel.vue:466`）剥掉它，发送走 `stripQueryFromUrl`（`request.ts:248`）也剥掉它。导出改动只是把第三处对齐到前两处 |
| `-X` 抛错让粘贴路径静默丢文本 | `applyPastedCurl`（`RequestPanel.vue:251-253`）的 catch 是空的 | 已升级为发布阻断依赖 §8 B1/B2；今天的替代品是「URL 栏被改成字面量 `PURGE`、真 URL 丢失」，并不更好 |
| ANSI-C 解码引入真实控制字符 | 解码后可能出现 CR/LF 之外的 C0 字符，`HeaderValue::from_str` 会拒收（V7） | 刻意不清洗：报错时错误信息点名该 header，属可见失败 |
| `MAX_SCHEMA_DEPTH = 20` 截断合法深 schema | 超过 20 层的示例本来也没有可用性 | 集中定义为模块常量，调整只需一行；#45 随之调整 |
| 去掉 `new URL` 后不再做 URL 归一化 | `https://API.Example.com:443/a` 不再被规整 | 这是**期望**行为：Copy as cURL 应该输出用户写的东西 |
| `-u` 与 Authorization 改为收尾结算 | 从「循环内立即写 auth」改成「暂存、收尾判定」，若实现者漏改某条早退路径会让 `-u` 整个失效 | 既有测试 `parses -u flag as basic auth`（`curl-parser.test.ts:43`）与 `extracts Bearer auth from Authorization header`（`:34`）是护栏，必须继续绿 |

## 7. Rollback

六个改动点互不耦合，可单独回退：

1. `curl-parser.ts` 词法（ANSI-C）——回退 `tokenizeCurlCommand` + 删 `decodeAnsiCEscapes`
2. `curl-parser.ts` 主循环（方法 / 数据标志 / header 优先级 / 认证 / 警告）
3. `curl-parser.ts` 的 `--compressed`（**独立 commit**，§6 的双重门槛 + §5.6 的独立性验证）
4. `curl-export.ts` 的 `buildUrl`
5. `postman-export.ts`
6. `openapi-import.ts`

`url-query.ts` 只被 4、5 引用，二者都回退即可删。`ParsedCurlRequest.warnings` 是加法字段，即使 2 回退也不会破坏调用方。无数据迁移、无磁盘格式变更（memory `persistence-files-no-db`）。

## 8. Cross-slice dependencies

D06 只能做到「产出正确的数据 + 可枚举的警告」。以下都在 D06 的文件边界之外，**不由本切片改**。

### 8.1 发布阻断型（R1 C1 裁定：这三条未落地，D06 不得验收）

| # | 需要的改动 | 文件 | 归属 | 为什么阻断 |
|---|---|---|---|---|
| **B1** | `applyPastedCurl` 不再吞异常：显示 `parseCurl` 的错误，或让 paste 按普通文本落进 URL 栏 | `src/components/panels/RequestPanel.vue:251-253` | **D05**（backlog 已立项：`RequestPanel.vue:251`，low） | `UrlBar.vue:63` 会先 `preventDefault()`，因此空 catch 的结果是**整段粘贴文本凭空消失**。Behavior 6 的「失败并报出具体错误」在粘贴路径上根本不成立 |
| **B2** | 渲染 `parseCurl` 返回的 `warnings`：导入对话框里列出来，粘贴路径给一个非阻塞提示 | `src/components/panels/RequestPanel.vue`（`applyCurlImport` / `applyPastedCurl`） | **D05** | Behavior 10 / 14 / 15 / 24 / 30 全都以「用户被告知」为前提。尤其 Behavior 24：`-b cookies.txt` 会**删掉一个 Cookie** 只留一条没人读的 warning。契约已定：`CurlImportWarning { code, detail }` |
| **B3** | 新增 7 个 i18n key（zh-CN + en，文案见 PRODUCT），并修正 `importCurlDescription` | `src/i18n/zh-CN.ts`、`src/i18n/en.ts` | **D01**（持有 `src/i18n/**`） | B1/B2 的文案载体。缺席时无法用中文呈现，而用户是中文母语者 |

### 8.2 非阻断型

| # | 需要的改动 | 文件 | 归属 | 说明 |
|---|---|---|---|---|
| N1 | `const { url, params } = syncParamsFromUrl(parsed.url, [])`，两处 `updateTab` 用 synced 的 `url` | `src/components/panels/RequestPanel.vue:222`、`:241`（`updateTab` 在 `:225`、`:244`） | **D05** | backlog 把这条列在 D06 表里（`RequestPanel.vue:225`），但文件不在 D06 边界内——**判定为归档错位**。D06 已让两个导出器对「url 里残留 query」免疫（Behavior 34/40），用户可见的重复参数即使 N1 不落地也消失了；N1 修的是根因 |
| N2 | 导出 Postman 后调用 `collectPostmanExportWarnings(requests)`，并入现有 `setFeedback` | `src/components/sidebar/CollectionPanel.vue:303-306` | **D05** | 在它落地前，用户被告知的渠道是产物 JSON 里的英文说明（Behavior 36/37） |
| N3 | `buildUrlWithParams` 改用 `encodeQueryComponentPreservingTemplates` | `src/components/panels/RequestPanel.vue:419` | **D05**（backlog 已立项，high） | D06 把原语放在 `src/utils/url-query.ts` 里导出，D05 直接 import 即可 |
| N4 | 更正 `--data-urlencode` 的期望值：REVIEW #17 与 TEST-CHECKLIST T19 第 7 步都写着 `q=a%20b%26c`，真 curl 8.7.1 发的是 `q=a+b%26c` | `docs/review/REVIEW-2026-08-18.md`、`docs/review/TEST-CHECKLIST-2026-08-18.md` | **owner** | 不改的话，手测执行者会照着错误期望判 D06 失败 |
| N5 | README / 应用内文档补一句既定边界：「导入的 curl 中任何 `@文件` 引用都不会被读取，需在应用内重新选择文件」 | `README.md` | 归属未定 | memory `document-decisions-in-readme-and-ui` |
| N6 | 裁定 `src/utils/url-query.ts`（D06）与 `src/utils/url-params.ts`（D01）是否合并 | 两个新文件 | **owner**，两切片都合入之后 | 主题相邻，各自独立时可能出现重叠的 URL 工具模块（R2 M1 引出） |
