# D06 — 导入导出保真

> **rev5 — 应 R4 修订**（R4 裁定 REVISE：0C + 1I + 2M）。行为定义**未增减**，仍是 46 条；rev4 → rev5 全部落在验证层：第 30 条的守卫（保真受损就不许提升）此前配的回归用例证明不了自己——换行折叠后的样例恰好也匹配不上提升谓词，于是守卫被删掉测试照样绿；已换成折叠后**恰好合法**的样例，让守卫真正承重。第 29 条里已经写明的「scheme 与 token 之间双空格」也补上了直接回归。
> rev3 → rev4 的实质变化：**「字节可复原」的判定必须落在用户粘进来的原始字节上**——rev3 的谓词是对的，但它拿到的输入已经被 `.trim()` 过了，于是 `Basic dXNlcjpwYXNz␣`（尾随空格）会先被裁掉再「通过」校验，发出去少一个字节；rev4 让 `Authorization` 全程持有未经 trim 的原始 field-value，谓词直接检查它，无法用 `名字: 值` 复原的空白布局改为**可见警告**；Bearer 的匹配收紧成单段非空白 token，与「恰好一个空格」的措辞一致。不变式由 45 条增至 **46 条**并重新编号。
> rev2 → rev3：认证 header 以「字节可复原」为映射前提；多条显式 `Authorization` 不再折叠；`--compressed` 断言集中到单独一条。
> rev1 → rev2：`--data-urlencode` 空格编码由 `%20` 更正为 `+`；补 `--data-ascii`；Authorization 纳入「显式 `-H` 压制生成 header」模型 + `Name:` 删除 / `Name;` 空值；`-b` 连接符 `; ` → `;`；内存态文件判别 `Boolean(x)` → `x !== undefined`；新增 `--compressed`。

## Summary

粘贴 curl 是 ApiSolo 的第一入口。本切片修复 `src/utils/**` 里四条导入导出链路（cURL 解析、Copy as cURL、Postman 导出、OpenAPI 导入）的保真缺陷，并确立一条硬规则：**做不到保真的地方必须可见地失败，绝不静默降级、绝不伪造数据。**

## Problem

用户从 Chrome DevTools 复制一条 curl、粘进 URL 栏、点发送——这是 80% 的真实用法（见 memory `ux-paste-curl-first`）。今天这条路径在多处会**悄悄给出一个和原命令语义不同的请求**，而界面看上去一切正常：

- Chrome 只要 header 值里带 `!` 或 `'`（`sec-ch-ua` 的 GREASE 值 `Not!A_Brand`、多数 session cookie、CSRF token 都会命中），就会输出 `$'...'` 形式。ApiSolo 把 `$` 当普通字符，于是请求头里出现 `$cookie` / `$authorization` 两行垃圾，真正的 Cookie 和 Authorization 一行都没发。用户在真实接口上拿到 401，界面上没有任何线索。
- `curl -X PURGE https://example.com/a` 之后，URL 栏里变成字面量 `PURGE`，真实 URL 被丢弃，没有报错。
- `curl -X GET -d '...'`（Elasticsearch 官方文档写法）被改写成 POST；把 `-d` 挪到 `-X GET` 前面又能得到 GET——同一条命令，flag 顺序不同结果不同。
- `curl -d @payload.json` 把 13 个字符的字符串 `@payload.json` 当请求体发出去。而语义等价的 `--data-binary @payload.json` 会正确变成「二进制 + 发送时要求重新选文件」。同一件事，一个可见失败、一个静默发错。`--data-ascii @f` 更糟：连数据 flag 都没被识别，`@payload.json` 直接顶替掉真实 URL。
- `--data-urlencode 'q=a b&c'` 原样存成 `q=a b&c`，服务端解析出两个参数；真 curl 发的是 `q=a+b%26c`。
- `-u user:pa:ss` 得到的密码是 `pa`；`Authorization: Basic` 里的中文用户名解出来是 `ç¨æ·`。症状是「导入的请求认证失败」，没人会怀疑到解析器（长期已知债，memory `known-issues-open`）。两条显式 `Authorization` 只剩最后一条（真 curl 两行都发）。
- `-b 'a=1' -H 'Cookie: b=2'` 产生两行 Cookie，真 curl 只发一行；`-A`、`-e`、`-u` 同理。`--compressed` 被静默丢弃——导入保留了「我要压缩响应」的意图，却扔掉了「所以要解压」的另一半。
- Copy as cURL 把 `{{baseUrl}}/users` 导成 `curl '/%7B%7BbaseUrl%7D%7D/users'`（主机没了、大括号被编码）；连不带模板的 `api.example.com/users` 也被导成 `/api.example.com/users`——主机同样丢失。粘到终端直接 `URL rejected: No host part`。
- 粘 curl 导入后立刻 Copy as cURL，查询参数出现两次（`q=cat&q=cat`）；导出 Postman 集合同理。
- 在 ApiSolo 里选好的上传文件（内容以 base64 存在应用内，本项目禁止裸文件路径），导出 Postman 时被写成 `src: "报告.pdf"` 这个 Postman 解析不了的伪路径——导出的集合里文件上传请求不可重放，且**没有任何提示**（长期已知债）。
- 一份含自引用 `$ref` 的 OpenAPI（树形/父子模型极常见）导入时抛 `Maximum call stack size exceeded`，整份文档——包括完全无关的其它端点——一个都进不来。

## 验收前置（R1 C1 裁定）

本切片只改 `src/utils/**`，产出的是**正确的数据 + 可枚举的警告**。但「可见失败」这条红线要成立，还需要组件侧把错误与警告显示出来：在 `RequestPanel.vue` 的空 catch 被修好之前，粘贴一条会抛错的 curl（例如 `-X PURGE`）会因为 `UrlBar.vue:63` 先 `preventDefault()` 而让**整段文本凭空消失**；`-b cookies.txt` 也只会静默少掉一个 Cookie。

因此以下三项组件/文案侧改动被列为**发布阻断型跨切片依赖**，未落地前 D06 不得验收通过（D06 本身仍不越过 `src/utils/**` 一步）：

1. cURL 粘贴路径不再吞掉解析错误——要么显示出来，要么让文本按普通粘贴落进 URL 栏。
2. 导入对话框与粘贴路径把本文档定义的保真警告呈现给用户。
3. 上述两项所需的中英文案落地（用户是中文母语者，只有英文不算数）。

## Behavior

### A. 粘贴 / 导入 cURL —— 词法

1. `$'...'`（ANSI-C 引用）被识别为一个整体：结果 token 不含开头的 `$`，引号内的转义被解码。`curl 'https://example.com/a' -H $'cookie: sid=abc!def' -H $'authorization: Bearer xyz'` 导入后，请求头里只有一行 `cookie: sid=abc!def`（键名不以 `$` 开头），`authorization` 被提取进「认证」标签成为 Bearer `xyz`、不再作为请求头存在。
2. `$'...'` 内支持的转义为 `\\`、`\'`、`\"`、`\a`、`\b`、`\e`、`\E`、`\f`、`\n`、`\r`、`\t`、`\v`、`\xHH`（1–2 位十六进制）、`\uHHHH`（1–4 位）、`\UHHHHHHHH`（1–8 位）、`\NNN`（1–3 位八进制）。**无法识别的转义保留反斜杠原样**（例如 `\z` 仍是 `\z`），与 bash 一致。
3. 解码出来的 CR / LF 落到 header 值上时，沿用既有归一化：普通 header 折成单个空格、Cookie 直接删除。导入后的 header 值里既不会出现真实的 CR/LF（否则后端发送时会被拒绝，见 memory `curl-import-header-normalization`），也不会出现字面量的 `\r` `\n` 两字符序列。`-H $'x-note: line1\r\nline2'` 得到值 `line1 line2`。
4. `-b $'sid=abc!def'`（现代 Chrome 实际输出的形态）得到 Cookie 值 `sid=abc!def`，开头没有多余的 `$`。
5. `$` 只在「未被引号包裹、未被反斜杠转义、且紧邻开引号」时才触发 ANSI-C 模式。`\$'x'` 仍得到 token `$x`，普通 `'x'`、`"x"`、无引号 token 的行为完全不变。

### B. 方法

6. `-X` / `--request` 永远消费它的参数。当参数不是 ApiSolo 支持的 7 个方法之一时（`PURGE`、`LOCK`、小写笔误 `pos` 等），导入**失败并报出具体错误**（错误文案含该方法名），不产生任何部分状态：URL 栏不会变成 `PURGE`，方法下拉不会停在 GET，真实 URL 不被丢弃。
7. 显式写了 `-X GET` 时，后续的 `-d` / `--data*` / `-F` / `-T` **不再**把方法改写成 POST / PUT。`curl -X GET -d 'q=1' …` 与 `curl -d 'q=1' -X GET …` 结果相同，都是 GET，body 照常保留（实测真 curl 两种顺序都发 GET + body）。
8. 没有显式 `-X` 时，方法推断维持原样：`-d` / `--data*` / `-F` 推断为 POST，`-T` / `--upload-file` 推断为 PUT。

### C. URL 槽

9. 只含空白的 token 永远不会被当作 URL。`curl -X POST \`（反斜杠后带一个空格）换行 `'https://api.example.com/a'` 导入后 URL 是真实 URL，不是 `" "`。

### D. 数据标志与本地文件引用

10. 五个数据 flag 里凡是会读文件的形态——`-d @f`、`--data @f`、`--data-ascii @f`、`--data-binary @f`、`--data-urlencode name@f`——一律走同一条路：请求体变为「二进制」占位（`binaryPath` 是文件名的 basename、无内容），并产生一条**文件引用警告**。`-d`、`--data`、`--data-ascii`、`--data-binary` 四者对同一个 `@payload.json` 产出**完全相同**的请求体。发送时沿用既有的 `errors.fileSelectionRequired` 提示，要求用户重新选文件——这就是可见失败。ApiSolo 永远不会按路径读取本地文件（memory `no-raw-file-paths`）。
11. `--data-raw @f` 是例外：curl 语义中 `--data-raw` 不解释 `@`，因此请求体就是字面量 `@f`，不产生警告，也不切成二进制。
12. `--data-urlencode` 的编码逐字节对齐真 curl：**空格编码成 `+`**（不是 `%20`）；unreserved 集是 `A-Za-z0-9-._~`，因此 `!` `'` `(` `)` `*` 都被百分号编码（`a!b` → `a%21b`、`a'b` → `a%27b`、`a(b)c*d` → `a%28b%29c%2Ad`）；内容里原有的 `+` 编码成 `%2B`；非 ASCII 按 UTF-8 字节百分号编码（`中文` → `%E4%B8%AD%E6%96%87`）。`'q=a b&c'` → `q=a+b%26c`。
13. `--data-urlencode` 的形态按 curl 规则分派——**先找第一个 `=`，找不到再找第一个 `@`**：`name=content` → `name=<编码后的 content>`，**name 部分原样不编码**（`'na me=x y'` → `na me=x+y`）；`=content` → `<编码后的 content>`，前导 `=` 不保留；`content`（既无 `=` 也无 `@`）→ `<编码后的整串>`；`name@file` / `@file` → 文件引用（走第 10 条）。因此 `name=a@b` 里的 `@` 属于内容，编码成 `%40`，不是文件引用。
14. 同一条命令里既有字面量数据段又有文件引用时，字面量段不会被悄悄保留：请求体变为文件占位，并额外产生一条**数据段被丢弃**的警告，注明被丢弃的段数（丢 1 段报 1，丢 2 段报 2）。
15. `-F 'k=@f'` 与 `-T f` 的既有占位行为不变，但同样产生文件引用警告，使「这次导入有几个文件需要重选」成为可枚举的信息。`-F 'k=v'` 这类纯文本字段不产生警告。

### E. Header 优先级（真 curl 语义）

统一模型：curl 有一批**自己生成**的 header（`Cookie` ← `-b`，`User-Agent` ← `-A`，`Referer` ← `-e`，`Authorization` ← `-u`，`Accept-Encoding` ← `--compressed`）；只要用户用 `-H` 显式指定了同名 header，curl 就不再生成自己那份。ApiSolo 照搬这套。

16. 显式 `-H` 会**抑制**同名（大小写不敏感）的生成 header，与 flag 先后顺序无关。`curl -b 'a=1' -H 'Cookie: b=2'` 只得到一行 `Cookie: b=2`；`-A` 与 `-H 'User-Agent:'`、`-e` 与 `-H 'Referer:'` 同理。（`--compressed` 与 `Accept-Encoding` 的同款抑制归第 23 条，好让压缩相关行为可独立开关。）
17. 两个显式 `-H 'Cookie: …'` 依然产生**两行** Cookie，按原顺序。修复不是「无脑去重」——真 curl 会把用户写的每一个 `-H` 都发出去。
18. 多个 `-b` 合并成**一行** Cookie，各段之间用 `;` 连接、**不加空格**（`-b 'a=1' -b 'b=2'` → `Cookie: a=1;b=2`）。单个 `-b` 内部原有的空格原样保留（`-b 'a=1; b=2'` → `Cookie: a=1; b=2`）。
19. 多个 `-A` / 多个 `-e` 各自只产生一行 header，**后写的值胜出**。
20. 只要出现过显式 `-H 'Authorization: …'`（无论它的值是什么、有几条、写在 `-u` 前还是后），`-u` 就不再产生 Basic 认证。绝不出现「请求头一行 + 认证标签一份」最终发两行 Authorization 的局面。
21. `-H 'Name:'`（冒号后为空或只有空白）是 curl 的**删除语义**：该 header 一行都不输出，同时抑制同名生成 header。`-H 'Authorization:' -u a:b` 得到的请求没有任何 Authorization；`-H 'X-Custom:'` 不会产出一行空的 `X-Custom`。
22. `-H 'Name;'`（分号结尾、无冒号）是**空值语义**：输出一行 `Name`、值为空字符串，同时抑制同名生成 header。header 名里不会残留那个分号（今天会得到一个名叫 `X-Custom;` 的非法 header）。
23. `--compressed` 不再被静默丢弃：它生成一个 `Accept-Encoding` header（内容为 ApiSolo 实际能解压的编码集），并和其它生成 header 一样可被显式 `-H 'Accept-Encoding: …'` 抑制。Chrome 复制的 curl 同时带 `--compressed` 和显式 `accept-encoding` 头，因此其结果与今天完全一致——变化只发生在手写的 `curl --compressed <url>` 上。**本条与其余 45 条互不牵连**：其它任何一条的用例里都不会出现 `--compressed`。
24. `-b` 的参数里不含 `=` 时它是 cookie **文件**引用（curl 会去读那个文件；实测文件不存在时 curl 静默不发 Cookie）。ApiSolo 不读本地文件，因此**不生成任何 Cookie header**（绝不伪造出 `Cookie: cookies.txt`），并**产生一条 cookie 文件警告**——这里刻意比 curl 更吵：curl 是命令行工具、静默可以接受，ApiSolo 是 GUI，静默少一个 Cookie 就是「UI 说谎」。

### F. 凭据保真

总原则：**认证凭据的字节永远不被改写，而且判断「能不能不改写」这件事本身必须拿用户粘进来的原始字节去做。** 真 curl 把 `-H` 的参数逐字节原样发出——实测尾随空格（`Bearer good␣`）、冒号后两个空格、冒号后无空格、冒号后 TAB、scheme 与 token 之间两个空格，全部原封不动上线。因此：

- `Authorization` 的值在 ApiSolo 内部**全程不做 trim**。冒号后的第一个空格是「名字与值的分隔符」（ApiSolo 输出时会补回来），除此之外一个字节都不动。
- 一条 `Authorization` 只有在 ApiSolo 的认证标签能**一字不差**还原它时，才被提升为结构化认证；判据直接作用在上面那个未经 trim 的值上，而不是它的规范化版本。
- 提升失败时它就是一条普通请求头，携带**原始字节**发出。

25. `-u user:pa:ss` 解析为用户名 `user`、密码 `pa:ss`——按**第一个**冒号切分，其余全部归密码（实测真 curl 发 `Basic dXNlcjpwYTpzcw==`，解码正是 `user:pa:ss`）。
26. **恰好一条**显式 `Authorization` 且它可被一字不差还原时，才提升为认证标签并从请求头里移除。出现**两条及以上**显式 `Authorization` 时，一条都不提升，全部按原顺序保留为普通请求头——`-H 'Authorization: Bearer aaa' -H 'Authorization: Bearer bbb'`、`Basic + Bearer`、`Custom + Bearer` 三种组合都得到两行，与真 curl 一致。
27. 可提升的 `Basic` 凭据按**第一个**冒号切分，密码里的冒号不丢：`Basic <base64("api-user:pa:ss")>` 得到密码 `pa:ss`。
28. 可提升的 `Basic` 凭据按 UTF-8 解码：`用户:密码` 的 base64 解出来是 `用户` / `密码`，不是 `ç¨æ·` / `å¯ç `。
29. **不可一字不差还原的 `Authorization` 一律原样保留为请求头，认证标签保持「无」**，且仍然抑制 `-u`；保留下来的那一行的值与用户写的**逐字节相同**（不被 trim、不被裁掉尾随空格）。具体包括：
    - 值前后带空白：`Bearer good␣`（尾随空格）、`Basic dXNlcjpwYXNz␣`（尾随空格）、冒号后两个空格的 `␣Bearer good`；
    - scheme 前缀不精确：自定义 scheme `Custom abc`、小写 `basic dXNlcjpwYXNz`、`Bearer␣␣good`（scheme 与 token 之间两个空格）、`Basic␣␣␣dXNlcjpwYXNz`；
    - base64 解不出合法 UTF-8（`Basic /zph`）、解码后不含冒号（`Basic bG9uZWx5`）、base64 非规范形式（`Basic dXNlcjpwYXNz=`）。

    其中带空白的几种今天会被 trim 掉再「通过校验」并提升，最终**发出去比用户写的少一个字节**；`/zph` 会变成 `w786YQ==`、`bG9uZWx5` 会变成 `bG9uZWx5Og==`（凭空补了个冒号）——**认证字节被静默改变，是本切片最不能接受的一类失败**。
30. 有些空白布局 ApiSolo 的「名字 + `: ` + 值」模型根本表达不出来：冒号后**不是恰好一个空格**（`Authorization:Bearer x`、`Authorization:<TAB>Bearer x`），或值里含有换行（必须折叠，否则后端拒收整条请求）。这两种情况下 ApiSolo **不提升、不假装无事发生**，而是产生一条**明确的警告**告诉用户这条认证头无法被原样保留。绝不静默归一化。

### G. 警告通道

31. 完全可表达的命令导入后警告列表为空——不产生噪音警告。警告只描述保真损失，不改变解析结果本身（同一条命令，有没有人去读警告，得到的请求完全一样）。

### H. 复制为 cURL

32. URL 原样输出，不经过一次 URL 解析与重编码：`{{baseUrl}}/users` 导出为 `curl '{{baseUrl}}/users'`（无 `%7B%7B`）；`https://api.example.com/{{id}}/x` 里的模板保持原样；不带协议的 `api.example.com/users` 导出为 `api.example.com/users`，主机不会被吃掉变成 `/api.example.com/users`。
33. 查询参数按 URL 规则百分号编码，但 `{{…}}` 片段原样保留：参数 `token={{apiToken}}` 导出为 `token={{apiToken}}`，而 `q=a b` 仍然导出为 `q=a%20b`。
34. 查询串不重复：参数表是查询串的唯一来源，`tab.url` 里残留的查询串被忽略。刚粘贴 `curl 'https://api.example.com/s?q=cat'` 之后立刻 Copy as cURL，得到 `curl 'https://api.example.com/s?q=cat'`，`q` 只出现一次。**导出的 URL 与 URL 栏里显示的 URL 一致**。
35. fragment 留在最后：`https://api.example.com/a#frag` 加参数 `k=v` 导出为 `https://api.example.com/a?k=v#frag`。

### I. 导出 Postman 集合

36. form-data 里内容只存在于 ApiSolo 的上传字段，导出时**不写 `src`**（不伪造路径），并在该字段的 `description` 上加一句明确说明，点名文件名：内容存在 ApiSolo 本地、Postman 里需要重新选择该文件。
37. 二进制请求体同理：`mode` 仍是 `"file"`，但不写 `src`，说明加在该请求的 `request.description` 上。
38. 判别「内容是否存在于 ApiSolo」看的是**字段存不存在**，不是内容空不空：用户选中的零字节文件其内联内容是空字符串，它和一个 1MB 的文件受到完全相同的对待——不写 `src`、写说明、进警告列表。绝不因为「内容是空的」就退回伪造路径的老路。
39. 只有文件名、从未有过内联内容的字段（典型来源：从 Postman / cURL 导入的占位）**仍然照原样写出 `src`**——这是我们收到的信息，不是我们编出来的路径。导入 → 导出往返不损失。
40. `url.raw` 不重复查询参数：参数表是唯一来源，`request.url` 里残留的查询串被忽略。
41. `url.raw` 的查询串在 fragment 之前：`https://api.example.com/a#frag` 加 `k=v` 得到 `https://api.example.com/a?k=v#frag`，而不是今天的 `…/a#frag?k=v`（非法 URL）。
42. 导出结果同时可枚举出「哪些文件无法写进这份集合」——每个不可导出的上传对应一条记录，含请求名与文件名，供界面提示使用；零字节文件同样在列。

### J. Postman 往返

43. 一个「内容只在 ApiSolo 里」的上传，导出再导入后得到的是**空文件槽**（文件名为空、需要重新选择），而不是一个指向不存在文件的幻影文件名。

### K. 导入 OpenAPI

44. 含环状 `$ref` 的文档能正常导入，不抛 `RangeError`：直接自引用（`Node.child → Node`）、互相引用（`A.b → B`，`B.a → A`）、数组自引用（`items: {$ref: self}`）三种形态都**在第一层环处**终止为 `null`，且同一份文档里无关的端点（例如 `/health`）照常导入。
45. `$ref` 链超过深度上限时截断为 `null`，而不是耗尽调用栈——这条同时兜住 YAML 锚点/别名构造出的环（JSON 与 YAML 都走同一个 YAML 解析器，别名可以造出真环，`$ref` 集合拦不住）。
46. 非环状 `$ref` 的解析行为完全不变：`#/components/schemas/PetProfile` 这类引用仍然被完整展开成示例。

## Non-goals

明确不做、不重新论证的：

- **不复现的 curl 行为**：`-d` / `--data-urlencode` 隐含的 `Content-Type: application/x-www-form-urlencoded` 不自动补（实测真 curl 确实会补，但这个缺口对普通 `-d` 同样存在、属独立议题，且用户能在「请求头」里自己加）；不复现 curl 输出 header 的精确行序（实测 `-H` 覆盖生成项时 curl 会把该行挪到末尾，我们只保证「显式在前、生成在后」）；不扩展 `HttpMethod` 联合类型去容纳 PURGE/LOCK 等非标准动词（7 成员闭集是既定设计）；不支持 `$"..."`（locale 翻译引用）与 `\cX`（control 转义）；不实现 cookie jar、`-K` 配置文件、`--url`、`@-`（stdin）的真实读取；不做 shell 变量展开、命令替换、通配符；不复现 `-d`/`--data-ascii` 读文件时剥换行、`--data-binary` 保留换行的差异（我们两者都不读文件）；不定义「同一条命令里既有 `-H 'Authorization:'` 删除指令又有 `-H 'Authorization: …'` 赋值」这种病态组合的顺序语义。
- **认证提升的口径刻意收紧**：小写 scheme（`authorization: basic xxx`）、`Bearer` 与 token 之间多一个空格、值带尾随空格，虽然多数在协议上无害，也一律不再被提升进「认证」标签——它们会留在请求头里照常发送。用一条「能否一字不差还原」的单一判据，胜过一份「哪些改写算安全」的例外清单；代价是少数写法不再自动填充认证标签，但发出去的字节永远是用户粘进来的那份。
- **「不 trim」只适用于 `Authorization`**，其余请求头维持今天的行为：值两端的空白按 RFC 9110 §5.5 的规定不属于 field value，裁掉它语义无损，而且现有的换行归一化用例正建立在此之上。凭据头之所以特殊，是因为那里一个字节的差别就是「认证通过」与「认证失败」的差别，不值得为了统一而冒险；反过来也不值得为了 `Accept: ␣application/json` 这种无害差异去改动所有 header 的存储形态。
- **不读本地文件**：任何 `@path` 一律降级为占位 + 警告。这是项目硬禁令（memory `no-raw-file-paths`），不是待补功能。
- **不做响应解压**：`--compressed` 在本切片里只还原成请求头；真正的解压能力属 D02（`lib.rs`）。因此第 23 条必须等 ApiSolo 真的能解压之后才可启用，也正因如此它被隔离成唯一一条涉及压缩的行为。
- **导入的 Postman 脚本仍然整段注释掉、永不执行**（memory `quickjs-sandbox-required`）——本切片不碰 `postman-import.ts` 的脚本处理。
- **header 换行归一化的口子仍在前端 curl 导入阶段**，不挪到后端（memory `curl-import-header-normalization`）。本切片只是把「孤立 CR」补进同一个归一化函数。
- **不改 `redactAuth` 的既定行为**、不碰历史脱敏、不碰 timings。
- **不改 `src/components/**`、`src/stores/**`、`src/i18n/**`、`src-tauri/**`**。因此 cURL 导入后 `tab.url` 里仍会残留查询串（根因在 `RequestPanel.vue:222` / `:241`）；本切片只保证**导出侧不再因此重复参数**，根因交给组件切片。
- 导出到 Postman 的集合里那句说明**用英文硬编码**，与 `postman-import.ts:375-376` 既有的英文注释一致——它是给第三方工具的用户看的产物文本，不进 i18n。

## 新增用户可见文案（i18n 交接给 D01）

`src/i18n/**` 由 D01 持有，本切片**不编辑** i18n 文件。以下 key 与文案作为交接清单提交；在它们落地之前，D06 侧的可见信号是：解析失败仍抛出英文 Error（与 `curl-parser.ts:24` / `:206` 现有两条英文错误一致，导入对话框原样渲染），文件占位在发送时触发既有的 `errors.fileSelectionRequired`，Postman 导出的说明写在产物 JSON 里。

| key | zh-CN | en |
|---|---|---|
| `curlImport.error.unsupportedMethod` | `不支持的请求方法「{method}」。ApiSolo 仅支持 GET、POST、PUT、DELETE、PATCH、HEAD、OPTIONS。` | `Unsupported request method "{method}". ApiSolo supports GET, POST, PUT, DELETE, PATCH, HEAD and OPTIONS.` |
| `curlImport.warningTitle` | `导入完成，但有 {count} 处无法完全还原：` | `Imported with {count} fidelity issue(s):` |
| `curlImport.warning.fileReference` | `无法读取本地文件「{detail}」。请在「请求体」里重新选择该文件后再发送。` | `Cannot read the local file "{detail}". Re-select it in the Body tab before sending.` |
| `curlImport.warning.dataDiscarded` | `命令里另有 {detail} 段内联数据被丢弃，因为同一条命令引用了本地文件。` | `{detail} inline data segment(s) were discarded because the command also references a local file.` |
| `curlImport.warning.cookieFile` | `已忽略 cookie 文件引用「{detail}」：ApiSolo 不会读取本地文件。` | `Ignored the cookie file reference "{detail}": ApiSolo does not read local files.` |
| `curlImport.warning.authorizationNotPreserved` | `Authorization 请求头的原始写法（{detail}）无法在 ApiSolo 中原样保留，已按「名字: 值」重排。请确认凭据仍然有效。` | `The Authorization header's original layout ({detail}) cannot be preserved as-is in ApiSolo and was rewritten as "name: value". Verify the credential still works.` |
| `export.warning.fileContentNotExportable` | `有 {count} 个上传文件的内容只存在于 ApiSolo 本地，无法写进 Postman 集合；在 Postman 里需要重新选择这些文件。` | `{count} uploaded file(s) exist only inside ApiSolo and cannot be written into the Postman collection; re-select them in Postman.` |

另请 D01 顺带修正 `src/i18n/zh-CN.ts:68` / `en.ts:68` 的 `requestPanel.importCurlDescription`——现文案只列了 `-X`、`-H`、`-d`、`--data`、`-u`，与实际支持范围不符。
