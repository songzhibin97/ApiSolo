# 桌面版手工测试清单 — 2026-08-18

> **勘误 1（2026-08-18，owner）—— T19 第 7 步的期望值本来是错的。**
>
> 初版写 `--data-urlencode 'q=a b&c'` 的正确输出是 `q=a%20b%26c`。**这是错的**，真实输出是 `q=a+b%26c`。
>
> 验证方式：本机 `curl --libcurl` 实跑 curl 8.7.1，得到 `CURLOPT_POSTFIELDS, "q=a+b%26c"`。curl 在 `curl_easy_escape` 之后会再调用 `replace_url_encoded_space_by_plus`，把编码出来的 `%20` 转成 `+`。
>
> 错误源头是 `REVIEW-2026-08-18.md` 的对应条目（见该文件顶部勘误），本清单照抄了它。**若不修正，按本清单验收会把一个正确的实现判为失败。**

按优先级执行。P0 = 确认真实的用户可见 bug；P1 = 确认疑似 bug；P2 = 回归安全网。

每条给出「正常应该怎样 / 有 bug 会怎样」，你只要照着点、照着看即可。


## 准备工作

## 0. 先备份（必做，多条用例会故意破坏磁盘数据）
```
cp -R ~/ApiSolo ~/ApiSolo.backup-$(date +%Y%m%d%H%M)
```
出问题时用 `rm -rf ~/ApiSolo && cp -R ~/ApiSolo.backup-XXXX ~/ApiSolo` 还原。

## 1. 构建并安装到 /Applications（必须真机 WebKit，不能用 npm run dev / 浏览器）
```
cd /Users/songzhibin/go/src/Songzhibin/ApiSolo
npm run tauri:build
rm -rf /Applications/ApiSolo.app
cp -R src-tauri/target/release/bundle/macos/ApiSolo.app /Applications/
open -a /Applications/ApiSolo.app
```
每条用例都从 /Applications 启动这个包。

## 2. 本地 oracle 服务器（先全部写到 /tmp，用到哪个起哪个）

### 2.1 raw_echo.py —— 主 oracle：打印收到的原始报文，并返回 200（保证历史会写盘）
```
cat > /tmp/raw_echo.py <<'PY'
import socket, json, datetime
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 8099)); s.listen(8)
print('raw echo on http://127.0.0.1:8099', flush=True)
while True:
    c, _ = s.accept(); c.settimeout(3.0)
    data = b''; head = b''; rest = b''
    try:
        while b'\r\n\r\n' not in data:
            ch = c.recv(65536)
            if not ch: break
            data += ch
        head, _, rest = data.partition(b'\r\n\r\n')
        n = 0
        for line in head.decode('latin1').split('\r\n')[1:]:
            if line.lower().startswith('content-length:'):
                n = int(line.split(':', 1)[1].strip())
        while len(rest) < n:
            ch = c.recv(65536)
            if not ch: break
            rest += ch
    except Exception as e:
        print('recv error:', e, flush=True)
    print('=' * 25, datetime.datetime.now().strftime('%H:%M:%S'), flush=True)
    print((head + b'\r\n\r\n' + rest).decode('utf-8', 'replace'), flush=True)
    body = json.dumps({'ok': True}).encode()
    c.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '
              + str(len(body)).encode() + b'\r\n\r\n' + body)
    c.close()
PY
python3 /tmp/raw_echo.py
```

### 2.2 gzip_srv.py —— 无条件 gzip 响应（8098）
```
cat > /tmp/gzip_srv.py <<'PY'
import gzip, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = gzip.compress(b'{"message":"hello-gzip","items":[1,2,3]}')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 8098), H).serve_forever()
PY
python3 /tmp/gzip_srv.py
```

### 2.3 gb2312_srv.py —— 非 UTF-8 响应（8097）
```
cat > /tmp/gb2312_srv.py <<'PY'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = '中文测试abc'.encode('gb2312')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=gb2312')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 8097), H).serve_forever()
PY
python3 /tmp/gb2312_srv.py
```

### 2.4 ws_lab.py —— WebSocket 实验台（9111），用环境变量切模式
- `WS_MODE=early`：握手后立刻推一帧 `hello-early`，然后每秒 tick
- `WS_MODE=closenow`：握手后推一帧再立刻发 Close
- `WS_MODE=slow`：延迟 15s 才完成握手
- `WS_MODE=rude`：握手后既不读也不写（永不回应 Close）
```
cat > /tmp/ws_lab.py <<'PY'
import base64, hashlib, os, socket, threading, time
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MODE = os.environ.get("WS_MODE", "early")
def frame(p):
    b = p.encode(); return bytes([0x81, len(b)]) + b
def handle(c):
    data = b""
    while b"\r\n\r\n" not in data:
        ch = c.recv(4096)
        if not ch: return
        data += ch
    key = ""
    for line in data.decode("latin1").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    if MODE == "slow":
        print("upgrade requested, sleeping 15s", flush=True); time.sleep(15)
    acc = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
    c.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % acc).encode())
    print("handshake done (mode=%s)" % MODE, flush=True)
    if MODE in ("early", "closenow"): c.sendall(frame("hello-early"))
    if MODE == "closenow":
        c.sendall(bytes([0x88, 0x00])); print("sent close", flush=True)
    if MODE == "rude":
        time.sleep(3600); return
    i = 0
    while True:
        try: c.sendall(frame("tick %d" % i))
        except OSError: print("client gone", flush=True); return
        i += 1; time.sleep(1)
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 9111)); s.listen(5)
print("ws lab on ws://127.0.0.1:9111 mode=%s" % MODE, flush=True)
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
PY
WS_MODE=early python3 /tmp/ws_lab.py
```

## 3. 应用内观察位置
- 调试控制台：窗口底部状态栏左侧的 bug 图标「控制台」。
- 历史记录 / 集合 / 环境变量：左侧边栏三个图标。
- 请求面板子标签：参数 / 请求头 / 请求体 / 认证 / 脚本。
- 「更多操作」（…）按钮：导入 cURL、复制为 cURL。

## 4. 需要盯的磁盘文件（不要直接 cat 含密文件，用各用例给出的 python3 片段只打印长度/布尔）
- `~/ApiSolo/scratch/history.jsonl`
- `~/ApiSolo/scratch/secrets.vault.json`、`~/ApiSolo/scratch/secret-storage.json`
- `~/ApiSolo/projects/<slug>/environments/*.env.json`、`*.env.secrets.json`
- `~/ApiSolo/projects/<slug>/collections/**/*.request.json`

## 5. 通用注意
- 每条用例开始前确认「设置 → 网络 → 代理」处于关闭状态（启用代理会跳过预连接探测，影响 T17）。
- 测完 T06 / T07 之类的破坏性用例后，按用例末尾的清理步骤恢复。


## 用例

### T01 · [P0] 历史重放 / 脱敏（焦点区域 A）

**目的**：验证从历史记录打开的请求会把字面量 "[redacted]" 当成真值发到线上（header），以及 URL 栏显示真值、线上却发 %5Bredacted%5D（query 参数）——UI 与线上不一致。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 从 /Applications 启动；无代理。

**步骤**

1. 新建请求 tab，方法 GET，URL 填 http://127.0.0.1:8099/replay?access_token=REALTOKEN123
2. 打开「请求头」子标签，加一行：键 Cookie，值 sid=abcdef123456; theme=dark，保持启用。
3. 点「发送」，等待 200 返回。
4. 切到 Terminal 看 raw_echo 打印的第一份报文，记下 cookie 行的值和请求行里的 access_token 值。
5. 打开左侧「历史记录」面板，点击刚生成的那条 GET 记录（会打开一个新 tab）。
6. 在新 tab 里看：URL 栏里的 access_token 显示成什么；「请求头」子标签里 Cookie 那行显示成什么、有没有任何标记/禁用/提示；「参数」子标签里 access_token 的值是什么。
7. 不做任何修改，直接点「发送」。
8. 回到 Terminal 看第二份报文的请求行和 cookie 行。

**正常表现**：第 4 步报文里 cookie 是真值 sid=abcdef123456; theme=dark（这是既定设计，不是 bug）。第 6 步重放 tab 中的 Cookie 行值为空并有明显的「凭据已脱敏、需要重新填写」标记，URL 栏与「参数」表内容一致。第 8 步报文里绝不出现字面量 [redacted] 或 %5Bredacted%5D，或者应用在发送前就报错拦截。

**有 bug 的表现**：第 6 步：Cookie 行是一个普通可编辑输入框，值就是字面量 [redacted]，无任何标记或提示；URL 栏显示 access_token=REALTOKEN123（真值），而「参数」表里是 [redacted]。第 8 步报文里出现 `cookie: [redacted]`，请求行是 /replay?access_token=%5Bredacted%5D —— 即 UI 展示的和线上发出的是两个不同的请求（真实场景表现为反复 401）。

**去哪看**：Terminal 里 raw_echo.py 的原始报文输出；再运行以下命令确认磁盘上的历史条目（只打印长度/布尔，不打印明文）：
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/ApiSolo/scratch/history.jsonl')
e = json.loads([l for l in open(p) if l.strip()][-1])
print('url_has_plaintext_token =', 'REALTOKEN123' in e.get('url',''))
for h in e.get('requestHeaders', []):
    v = h.get('value','')
    print('header', h.get('key'), 'len=%d' % len(v), 'is_literal_redacted=%s' % (v == '[redacted]'))
for q in e.get('requestParams', []):
    print('param', q.get('key'), 'is_literal_redacted=%s' % (q.get('value') == '[redacted]'))
PY


---

### T02 · [P0] 响应解码

**目的**：验证响应体既不做 gzip 解压也不按 charset 解码：带 Accept-Encoding 的请求返回乱码；gb2312 页面全变成 U+FFFD。

**前置**：gzip_srv.py 在 8098、gb2312_srv.py 在 8097 运行；ApiSolo 已启动。

**步骤**

A. gzip：
1. 新建 tab，方法 GET，URL http://127.0.0.1:8098/ ，点「发送」。
2. 看响应面板：状态码、「响应头」里的 content-encoding、「响应体」的原始视图内容、底部的 Size 数值。
3. 对照组：新建 tab，URL 同上，但在「请求头」里显式加一行 accept-encoding: identity，再发送，对比响应体是否可读。（本服务器无条件 gzip，所以两次都应乱码——说明与请求头无关，是客户端不解压。）
B. gb2312：
4. 新建 tab，GET http://127.0.0.1:8097/ ，点「发送」。
5. 看「响应体」原始视图，以及「响应头」里的 Content-Type。
6. 在 Terminal 跑对照：curl -s http://127.0.0.1:8097/ | iconv -f gb2312 -t utf-8

**正常表现**：A：响应体显示 {"message":"hello-gzip","items":[1,2,3]}，树形视图可解析。B：响应体显示「中文测试abc」，与 iconv 输出一致。

**有 bug 的表现**：A：状态 200（绿色，无任何失败提示），响应头有 content-encoding: gzip，但响应体是一堆 U+FFFD 乱码，树形/JSON 视图无法解析，Size 是压缩后的字节数。B：响应体显示 6 个 U+FFFD 替换字符 + abc，而 Content-Type 里明明带着 charset=gb2312；Terminal 的 iconv 输出是正确中文。

**去哪看**：响应面板的「响应体」原始视图与「响应头」；Terminal 的 curl+iconv 输出作为 ground truth。另可确认乱码也被写进历史：
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/ApiSolo/scratch/history.jsonl')
e = json.loads([l for l in open(p) if l.strip()][-1])
b = e.get('responseBody') or ''
print('body_len =', len(b), 'replacement_char_count =', b.count('�'))
PY


---

### T03 · [P0] 环境变量面板

**目的**：验证环境变量行的 key/value 输入框在每敲一个字符后就被销毁重建，导致失焦、无法连续输入。

**前置**：ApiSolo 已启动并已解锁密钥存储；已选中一个项目。

**步骤**

1. 左侧边栏点「环境变量」。
2. 若无环境，点「新建」，名字填 dev，点「创建」；已有则从下拉里选一个。
3. 鼠标点进最后一行（空行）的「键」输入框。
4. 用键盘正常速度连续输入 baseUrl（不要粘贴，不要中途点击别处）。
5. 观察输入框里最终留下的文本，以及光标/焦点边框是否还在。
6. 再测重命名：先用粘贴（Cmd+V）方式把 token 一次性写进某行的键，然后点进该输入框，把光标放到末尾，按一次 Backspace，观察焦点。

**正常表现**：第 4 步输入框里完整显示 baseUrl，焦点一直在该输入框内。第 6 步按 Backspace 后变成 toke 且焦点仍在，可继续删除。

**有 bug 的表现**：第 4 步只留下一个字符 b，焦点框消失（后续 aseUrl 全部丢失），必须每输入一个字符就重新点一次输入框。第 6 步删掉一个字符后立即失焦，再按 Backspace 无反应。

**去哪看**：直接看输入框内容与焦点高亮；也可在输入一个字符后立刻按 Tab/继续敲键，验证按键是否落到页面其它位置。


---

### T04 · [P0] 密钥保管库 / 环境

**目的**：验证中文（非 ASCII）环境名会生成相同的 vault key，导致两个环境共用一个密钥槽：后写的覆盖先写的，删其一会摧毁另一个。

**前置**：ApiSolo 已启动，密钥存储使用默认「本地加密保管库」并已解锁；已选中项目（例如 my-api）。

**步骤**

1. 左侧「环境变量」→「新建」，名称输入 生产，点「创建」。
2. 加一行：键 token，值 PROD-SECRET；点该行的锁图标标记为密钥（值变为遮蔽/琥珀色）；点「保存」。
3. 再点「新建」，名称输入 测试，点「创建」。
4. 加一行：键 token，值 TEST-SECRET；同样标记为密钥；点「保存」。
5. 环境下拉切回 生产，点「显示密钥值」（眼睛图标）。
6. 记录 token 显示的值。
7. 破坏性变体：切到 测试，点「删除」并确认；再切回 生产，显示密钥值。

**正常表现**：第 6 步 生产 的 token 仍是 PROD-SECRET；第 7 步删除 测试 后 生产 的 token 依然是 PROD-SECRET。

**有 bug 的表现**：第 6 步 生产 的 token 显示成 TEST-SECRET（被后保存的环境覆盖），界面没有任何警告——此时用 生产 环境发请求会把测试凭据发到生产。第 7 步删除 测试 后，生产 的 token 变成空，且不可恢复。

**去哪看**：环境面板的显示值；再确认保管库里只多了一条记录：
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/ApiSolo/projects')
for proj in os.listdir(p):
    d = os.path.join(p, proj, 'environments')
    if not os.path.isdir(d): continue
    for f in sorted(os.listdir(d)):
        if f.endswith('.env.secrets.json'):
            data = json.load(open(os.path.join(d, f)))
            print(proj, f, [v.get('vaultKey') or v.get('vault_key') for v in data])
PY
两个环境的 vaultKey 若完全相同即命中（注意打印的是 key 名，不是密钥值）。


---

### T05 · [P0] 环境面板 / 数据丢失

**目的**：验证用已存在的名字「新建环境」不会报错，面板会显示成空环境，随后保存会把原环境（含密钥变量）整个覆盖删除。

**前置**：ApiSolo 已启动，已选中项目 demo，密钥存储已解锁。

**步骤**

1. 左侧「环境变量」→「新建」，名称 dev，「创建」。
2. 加两行：API_URL = https://dev（普通）；TOKEN = t（点锁图标标记为密钥）。点「保存」。
3. 切走再切回 dev，确认两行都在。
4. 再次点「新建」，名称仍输入 dev，点「创建」。
5. 观察：有没有「已存在」的报错？下拉里是几个 dev？变量表格里有几行、内容是什么？
6. 在空白行输入 ONLY_NEW = 1，点「保存」。
7. 观察表格内容，并检查磁盘文件。
8. 变体（无需打错字）：建 A、B 两个项目；在 B 里建 staging 环境含 REAL=v 并保存；切到项目 A，点「新建环境」输入 staging 但不保存；再把项目切回 B，观察 staging 的变量表。

**正常表现**：第 4 步应被拒绝并提示名称已存在（对照：新建两个同 slug 的项目会明确报「A project directory with the same slug already exists」）；或至少加载出既有的 API_URL / TOKEN 两行。第 8 步切回项目 B 后 staging 正常显示 REAL=v。

**有 bug 的表现**：第 5 步无任何提示，变量表格是空的（面板在说谎）；第 7 步保存后 dev.env.json 只剩 ONLY_NEW，dev.env.secrets.json 变成 []，API_URL 与密钥 TOKEN 永久丢失且无确认弹窗、无法撤销。第 8 步项目 B 的 staging 也显示为空，保存即摧毁 REAL=v。

**去哪看**：环境面板 + 磁盘：
python3 - <<'PY'
import json, os, glob
for f in glob.glob(os.path.expanduser('~/ApiSolo/projects/*/environments/dev.env*.json')):
    d = json.load(open(f))
    print(os.path.relpath(f, os.path.expanduser('~/ApiSolo')), '->', [v.get('key') for v in d])
PY


---

### T06 · [P0] 历史记录持久化

**目的**：验证 history.jsonl 只要有一行 JSON 损坏（崩溃/强杀/写盘中断都会造成），历史面板永久报错且之后所有请求都不再写历史，应用内没有任何修复入口。

**前置**：已按 setup 备份 ~/ApiSolo；ApiSolo 已启动。

**步骤**

1. 在 URL 栏输入 https://example.com，点「发送」3 次，确保历史里有新条目。
2. 左侧「历史记录」面板确认能看到这些条目。
3. Cmd+Q 退出 ApiSolo。
4. Terminal 执行（模拟一次写盘被打断留下的半行 JSON）：
   truncate -s -40 ~/ApiSolo/scratch/history.jsonl
5. 重新从 /Applications 启动 ApiSolo，打开「历史记录」面板。
6. 观察：列表内容、面板底部有没有红色错误、「清空历史」按钮是否可点。
7. 再发一次请求（任意 URL），观察响应是否正常、历史面板有没有新增条目。
8. Terminal 执行 wc -l ~/ApiSolo/scratch/history.jsonl 两次（发请求前后）比较行数。
9. 重启应用，重复第 5-7 步，确认是否永久性。
10. 清理：rm ~/ApiSolo/scratch/history.jsonl 或从备份恢复。

**正常表现**：坏行被跳过，其余历史条目照常显示；新请求继续追加写入，行数增长；即使无法读取也应提供可点击的修复/重置入口。

**有 bug 的表现**：历史面板空白 + 红色错误「Failed to parse history entry: EOF while parsing ...」；「清空历史」按钮因列表为空而置灰不可点，应用内无任何修复手段；第 7 步响应正常但历史面板毫无反应，第 8 步行数不增长（写入静默失败，UI 无任何提示）；重启后症状永久重现。

**去哪看**：历史面板底部的错误行与置灰按钮；Terminal 的 wc -l 行数对比。


---

### T07 · [P0] 集合树加载

**目的**：验证 collections 目录里出现一个无法解析的 .json（导出的 OpenAPI、编辑器备份、半截写入的文件）会让整个项目的集合树加载失败，所有已保存请求在 UI 里彻底不可达。

**前置**：ApiSolo 已启动；已按 setup 备份。

**步骤**

1. 左侧「集合」面板新建项目 Demo（目录 ~/ApiSolo/projects/demo）。
2. 在该项目下新建集合 col。
3. 在请求 tab 里填 GET https://example.com，Cmd+S 保存到 Demo / col，名称 Good One。确认侧边栏能看到它。
4. Terminal 执行：
   echo '{"openapi":"3.0.0"}' > ~/ApiSolo/projects/demo/collections/col/openapi.json
5. Cmd+Q 退出并重新从 /Applications 启动，选中项目 Demo。
6. 观察集合树内容与面板下方是否有红色错误；错误里有没有指出是哪个文件。
7. 尝试打开/重命名/删除 Good One。
8. 变体（不重启）：再建一个项目 Other 并保存一个请求 Other Req；在应用运行状态下把同样的 openapi.json 放进 demo 的集合目录，然后在项目下拉里从 Other 切到 Demo，观察侧边栏显示的是哪个项目的请求。
9. 清理：rm ~/ApiSolo/projects/demo/collections/col/openapi.json

**正常表现**：无关的 openapi.json 被忽略（或单独标记为无法识别），col / Good One 正常显示可用。第 8 步切换项目后侧边栏显示 Demo 的内容或明确报错。

**有 bug 的表现**：第 6 步集合树整个空白，只有一行红字「Failed to parse saved request: missing field ...」，且不指明是哪个文件；Good One 文件完好却无法从 UI 打开、导出、重命名、删除。第 8 步更糟：没有任何错误提示，侧边栏仍列着 Other 项目的 Other Req，而下拉显示的是 Demo，点它会解析到错误路径而失败。

**去哪看**：侧边栏集合树与其下方的红色错误行；ls ~/ApiSolo/projects/demo/collections/col/ 确认 Good One 的 .request.json 文件其实还在。


---

### T08 · [P0] 请求头构造 / URL 构造

**目的**：验证 Content-Type 与 Authorization 是被追加而不是覆盖（报文里出现两行），以及无查询参数时 URL 仍带一个多余的尾随 ?。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 已启动。

**步骤**

A. 尾随 ?：
1. 新建 tab，方法 GET，URL http://127.0.0.1:8099/v1/users ；打开「参数」子标签确认一行都没有（或全部未勾选）。
2. 点「发送」，看 Terminal 打印的请求行。
3. 对照：在「参数」加一行 a=1 并勾选，再发送，看请求行。
B. 重复 Content-Type（表单）：
4. 新建 tab，URL http://127.0.0.1:8099/login ，点进 URL 栏粘贴：
   curl 'http://127.0.0.1:8099/login' -H 'Content-Type: application/x-www-form-urlencoded;charset=UTF-8' --data-raw 'user=a&pass=b'
5. 确认「请求头」只有一行 Content-Type，「请求体」是表单编码。点「发送」。
6. 看 Terminal 报文里有几行 content-type。
C. 重复 boundary（multipart，真会打挂服务端）：
7. 新建 tab，POST http://127.0.0.1:8099/upload ；「请求头」加一行 Content-Type = multipart/form-data; boundary=----WebKitFormBoundaryAbc ；「请求体」选表单数据，加一个文本项 a=1。发送。
8. 看 Terminal：几行 content-type？正文实际用的是哪个 boundary？
D. 重复 Authorization：
9. 新建 tab，GET http://127.0.0.1:8099/me ；「请求头」加 Authorization = Bearer stale-token；「认证」子标签选 Bearer，令牌填 fresh-token。发送。
10. 看 Terminal 里有几行 authorization、顺序如何。

**正常表现**：A：请求行是 GET /v1/users HTTP/1.1（无尾随 ?），带参数时是 /v1/users?a=1。B/C/D：报文里 content-type、authorization 各只有一行，且是用户在 UI 里能看到的那一个（multipart 的 boundary 与正文一致）。

**有 bug 的表现**：A：请求行是 GET /v1/users? HTTP/1.1，多出一个 ?。B：两行 content-type（用户填的 charset=UTF-8 一行 + 应用追加的一行），UI 里只显示了第一行。C：两行 content-type，第一行是用户填的假 boundary，正文却用真 boundary —— 服务端按第一行解析会读到 0 个 part。D：两行 authorization，stale-token 在前、认证标签里的 fresh-token 在后，先值优先的服务端会用旧 token，「认证」标签看起来完全没生效。

**去哪看**：全部看 Terminal 里 raw_echo.py 打印的原始报文（请求行 + 每一行 header + 正文的 boundary 分隔符）。


---

### T09 · [P0] URL 栏 / 变量

**目的**：验证 URL 栏会把查询串重新编码：{{var}} 变成 %7B%7Bvar%7D%7D、变量提示消失，并且手打的 ? 会被立刻吃掉。

**前置**：ApiSolo 已启动，已选中项目。

**步骤**

1. 新建 HTTP tab。把下面文本复制到剪贴板（不要手打）：https://httpbin.org/get?api_key={{apiKey}}
2. 点进 URL 输入框，Cmd+V。
3. 观察 URL 框里现在显示的字符串。
4. 观察 URL 框正下方有没有灰色的「包含变量：」提示。
5. 对照：把 URL 框全选替换成 {{baseUrl}}/get，观察「包含变量：」提示是否出现。
6. 重新粘贴第 1 步的 URL，点「参数」子标签，看 api_key 那行的值是什么。
7. 手打测试：全选清空 URL 框，用键盘逐字符输入 https://api.test/a?x=1 ，观察最终留下的字符串。

**正常表现**：第 3 步 URL 框显示的就是粘贴的原文；第 4 步出现「包含变量：apiKey」；第 6 步参数表值为 {{apiKey}}（与 URL 栏一致）；第 7 步能正常打出 https://api.test/a?x=1。

**有 bug 的表现**：第 3 步显示 https://httpbin.org/get?api_key=%7B%7BapiKey%7D%7D（既不是输入的也不是实际发送的）；第 4 步没有变量提示（第 5 步路径变量却有提示，说明查询串变量的提示是死的）；第 6 步参数表里是 {{apiKey}}，与 URL 栏显示的百分号编码不一致；第 7 步键入的 ? 被瞬间删除，结果变成 https://api.test/ax=1，根本无法手打查询串。

**去哪看**：URL 输入框内容、其下方的变量提示行、「参数」子标签表格；三处字符串互相对照。


---

### T10 · [P0] WebSocket 事件时序

**目的**：验证 ws_connect 的事件在前端监听器注册之前就发出：握手后立刻推送的帧和「已连接」系统行永远丢失；服务端握手后立刻 Close 时 UI 仍显示「已连接」（UI 说谎）。

**前置**：WS_MODE=early python3 /tmp/ws_lab.py 在 9111 运行；ApiSolo 从 /Applications 启动。

**步骤**

A. 早期帧丢失：
1. 在 tab 栏点「+」旁的「▼」，选「新建 WebSocket」。
2. URL 填 ws://127.0.0.1:9111，点「连接」。
3. 观察消息面板：有没有「Connected/已连接」系统行？有没有那条 hello-early 的接收帧？（tick N 会正常每秒进来，说明连接本身没问题。）
4. 打开底部「控制台」，看有没有 [network] WebSocket connected 这条。
B. 握手后立刻 Close：
5. Ctrl+C 停掉服务器，改用 WS_MODE=closenow python3 /tmp/ws_lab.py 重启。
6. 在 ApiSolo 里再次连接 ws://127.0.0.1:9111。
7. 观察 tab 的状态点/文字和按钮文案。
8. 在消息输入框随便输入一段文字并发送，观察提示。

**正常表现**：A：消息列表首行是「已连接」系统行，随后是收到的 hello-early，再是 tick 0/1/2…；控制台有 WebSocket connected 记录。B：连接被服务端关闭后，tab 状态变成「已断开」，按钮回到「连接」。

**有 bug 的表现**：A：没有「已连接」系统行，hello-early 这一帧永久丢失（只从 tick N 开始显示），控制台也没有 connected 记录。B：tab 仍显示「已连接」、按钮仍是「断开」，但发送消息时报「Connection not found or already closed」—— 界面展示了一个根本不存在的连接，只能手动点「断开」才能清掉状态。

**去哪看**：WS 消息面板列表首几行；底部「控制台」面板；tab 上的状态点与按钮文案；Terminal 里 ws_lab.py 打印的 handshake done / sent close 时间点。


---

### T11 · [P1] cURL 导入

**目的**：验证 Chrome DevTools 常见的 $'...' ANSI-C 引用没有被识别：header 名带上多余的 $ 前缀、转义未解码、Bearer 令牌不再被提取到「认证」。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 已启动。

**步骤**

1. 把下面这一整行复制到剪贴板（注意每个引号前的 $）：
   curl 'http://127.0.0.1:8099/headers' -H $'cookie: sid=abc!def' -H $'authorization: Bearer secret-token-123'
2. 新建 tab，点进 URL 输入框，Cmd+V（会自动识别为 cURL 导入）。
3. 看「请求头」子标签里两行的键名。
4. 看「认证」子标签的类型与令牌。
5. 点「发送」，看 Terminal 报文里实际发出的 header 名。
6. 变体（转义未解码）：同样方式粘贴 curl 'http://127.0.0.1:8099/h' -H $'x-note: line1\r\nline2' ，看「请求头」里该行的值是不是字面量的 \r\n 两个反斜杠序列。
7. 变体（-b 路径）：粘贴 curl 'http://127.0.0.1:8099/h' -b $'sid=abc!def' ，看 Cookie 行的值开头有没有多余的 $。
8. 对照：用「更多操作 → 导入 cURL」对话框粘贴第 1 步命令，结果应与第 3 步相同（说明不是粘贴路径特有）。

**正常表现**：header 键名是 cookie；authorization 被提取进「认证」标签（Bearer / secret-token-123），请求头里不再有 authorization 行；转义序列被解码；-b 的值是 sid=abc!def。

**有 bug 的表现**：「请求头」出现 $cookie 和 $authorization 两行；「认证」类型是「无」（令牌没被提取）；第 5 步报文里真的发出 $cookie / $authorization，真正的 Cookie 和 Authorization 一个都没发（真实 API 上就是无从解释的 401）；第 6 步值是字面量 line1\r\nline2；第 7 步 Cookie 值是 $sid=abc!def。

**去哪看**：「请求头」「认证」两个子标签；Terminal 里 raw_echo.py 打印的 header 行。


---

### T12 · [P1] JSON 请求体

**目的**：验证 JSON body 会被重新序列化：键被按字母排序、格式被压掉、重复键被丢弃、大整数退化为浮点——线上发出的字节与编辑器里显示的不一致（会打挂原始 body 签名的接口）。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 已启动。

**步骤**

1. 新建 tab，方法 POST，URL http://127.0.0.1:8099/sign。
2. 「请求体」子标签选 JSON，逐字粘贴（保留换行和缩进）：
{
  "timestamp": 1700000000,
  "nonce": "ab",
  "amount": "1.00",
  "sign": "xx"
}
3. 点「发送」，在 Terminal 看空行之后的正文字节。
4. 把 body 换成 {"a":1,"a":2} 再发送，看正文。
5. 把 body 换成 {"id":123456789012345678901} 再发送，看正文。
6. 脚本视角：回到第 2 步的 body，在「脚本」子标签的「请求前脚本」写 console.log(request.body)，发送后打开底部「控制台」看打印内容，与 Terminal 里的正文对比。
7. 对照组：「请求体」改选「原始」，贴同样文本，并在「请求头」加 Content-Type: application/json，发送后看正文是否与输入逐字节一致。

**正常表现**：第 3 步 Terminal 里的正文与编辑器里的文本逐字节相同（键序、换行、缩进都保留）；第 4 步保留原样；第 5 步大整数原样；第 6 步脚本打印与线上一致。

**有 bug 的表现**：第 3 步正文变成 {"amount":"1.00","nonce":"ab","sign":"xx","timestamp":1700000000}（字母序、去掉了换行缩进）；第 4 步变成 {"a":2}；第 5 步变成 {"id":1.2345678901234568e20}；第 6 步控制台打印的是原始文本，与线上字节不一致（原始 body 签名必然失败）；第 7 步「原始」模式却完全一致，证明是 JSON 分支特有。

**去哪看**：Terminal 里 raw_echo.py 打印的正文（空行之后的部分）；底部「控制台」面板的脚本输出。


---

### T13 · [P1] 历史脱敏（落盘 + 屏幕）

**目的**：一次发送体检多处脱敏缺陷：Basic 凭据在被标注为 [redacted] 的同时原样留在历史里；被脱敏的 JSON body 变成非法 JSON；camelCase 的 accessToken 完全不被识别；控制台把已解析出的密钥 URL 明文打印。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 已启动，已选中项目，密钥存储已解锁。

**步骤**

1. 左侧「环境变量」建环境 prod，加变量 apiKey = AIzaSyD-TEST-SECRET-12345，点锁图标标为密钥，保存，并在顶部环境下拉里选中 prod。
2. 新建 tab，方法 POST，URL http://127.0.0.1:8099/audit?key={{apiKey}}
3. 「请求头」加一行：accessToken = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.LEAKME
4. 「请求体」选「原始」，输入两行：
   Authorization: Basic dXNlcjpwYXNzd29yZA==
   {"user":"a","password":"hunter2"}
5. 点「发送」。
6. 打开底部「控制台」，看 [network] ... started 那行里的 URL——key= 后面是变量占位符还是真实密钥？
7. 打开「历史记录」，点开刚才那条，看它的「请求头」里 accessToken 显示的是什么，「请求体」显示的是什么。
8. 跑下方的磁盘检查命令。

**正常表现**：控制台里的 URL 保持 key={{apiKey}}（与历史一致）；历史里 accessToken 的值为空或 [redacted]；历史 body 里不含 dXNlcjpwYXNzd29yZA==；被脱敏后的 JSON 仍是合法 JSON（可 JSON.parse）。

**有 bug 的表现**：控制台打印 key=AIzaSyD-TEST-SECRET-12345（明文，同一个值在环境面板里是 **** 遮蔽的、在历史里是 {{apiKey}}——只有控制台漏了）；历史里 accessToken 是完整 JWT 明文（对照：把同一个 tab 保存进集合再重新打开，该 header 值会被清空，两边行为不一致）；历史 body 显示 `Authorization: [redacted] dXNlcjpwYXNzd29yZA==`（打着「已脱敏」的标签却把 base64 凭据完整留着），且 JSON 部分变成 {"user":"a","password":[redacted]} —— 非法 JSON，重放时会直接报 Invalid JSON body。

**去哪看**：底部「控制台」面板；历史条目打开后的「请求头」「请求体」；磁盘检查（只打印布尔和长度）：
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/ApiSolo/scratch/history.jsonl')
e = json.loads([l for l in open(p) if l.strip()][-1])
for h in e.get('requestHeaders', []):
    v = h.get('value','')
    print('header', h.get('key'), 'len=%d' % len(v), 'redacted=%s' % (v == '[redacted]'))
b = e.get('requestBodyContent') or ''
print('body_keeps_basic_b64 =', 'dXNlcjpwYXNzd29yZA==' in b)
print('body_len =', len(b))
line = [x for x in b.splitlines() if x.strip().startswith('{')]
if line:
    try:
        json.loads(line[-1]); print('json_line_parsable = True')
    except Exception as ex:
        print('json_line_parsable = False', type(ex).__name__)
print('url_field =', e.get('url','').split('key=')[-1][:12] + '...(前12字符)')
PY


---

### T14 · [P1] 脚本沙箱 / 密钥

**目的**：验证脚本可以把保管库里的密钥变量「洗」成普通变量，随后保存会把生产令牌明文写进 <env>.env.json（完全绕过 Argon2/ChaCha20 保管库）。

**前置**：ApiSolo 已启动，使用默认「本地加密保管库」并已解锁；已选中项目。

**步骤**

1. 左侧「环境变量」新建环境 prod，加一行 prodApiToken = sk-live-SECRET-123，点锁图标标为密钥，点「保存」。
2. Terminal 先确认基线（不打印密钥值）：
   python3 -c "import os,glob;print([ (f, 'sk-live-SECRET-123' in open(f).read()) for f in glob.glob(os.path.expanduser('~/ApiSolo/projects/*/environments/prod.env*.json'))])"
   两个文件都应为 False。
3. 新建请求 tab，URL https://example.com ，顶部环境选 prod。
4. 「脚本」子标签的「请求前脚本」粘贴：
   pm.environment.set("debugInfo", pm.environment.get("prodApiToken"))
5. 点「发送」。
6. 打开「环境变量」面板，看有没有新出现的 debugInfo 行、它的锁图标状态、值是否明文可见。
7. 点「保存」，再跑一次第 2 步的命令。

**正常表现**：脚本无法读到解密后的密钥值，或写出的 debugInfo 继承 secret 标记进入保管库；第 7 步两个文件仍为 False。

**有 bug 的表现**：第 6 步 debugInfo 以普通变量出现，锁图标关闭，明文显示 sk-live-SECRET-123；第 7 步 prod.env.json 变成 True —— 生产令牌以明文躺在磁盘上，整个密钥保管库形同虚设，全程无任何确认或警告。

**去哪看**：环境面板的变量行 + 上面 python3 一行命令的布尔输出（只打印 True/False，不打印内容）。


---

### T15 · [P1] 密钥保管库 / 钥匙串

**目的**：验证删除一个密钥变量后，其值仍永久留在钥匙串/保管库里，应用内没有任何界面能看到或清除它。

**前置**：退出 ApiSolo，执行 rm -f ~/ApiSolo/scratch/secret-storage.json 让首启动的密钥存储选择界面重新出现（先确认已备份）。

**步骤**

1. 启动 ApiSolo，在密钥存储选择界面选「系统钥匙串」并确认，同意 macOS 的钥匙串授权。
2. 选中/新建项目 Demo，新建环境 prod。
3. 加一行 prodToken = SUPER-SECRET-VALUE-12345，点锁图标标为密钥，点「保存」。
4. 打开「钥匙串访问」App（或「密码」），搜索 ApiSolo，确认存在一条账户名形如 demo:prod:cHJvZFRva2Vu 的条目。
5. 回到 ApiSolo，点该变量行的删除按钮，再点「保存」。确认表格里已没有 prodToken。
6. Terminal 确认元数据已清空：
   python3 -c "import json,os;p=os.path.expanduser('~/ApiSolo/projects/demo/environments/prod.env.secrets.json');print(len(json.load(open(p))))"
7. 回到「钥匙串访问」，Cmd+R 刷新后再搜 ApiSolo。
8. 变体：重新加回 prodToken 并保存，然后把键名改成 prodTokenV2 再保存，看钥匙串里有几条。
9. 对照：加一个密钥 tmpToken 保存后，直接用「删除环境」按钮删掉整个环境，再看钥匙串——这条路径是会清理的。

**正常表现**：第 7 步 demo:prod:cHJvZFRva2Vu 条目已消失（与第 9 步删整个环境的行为一致）。

**有 bug 的表现**：第 6 步元数据长度为 0（UI 上确实删了），但第 7 步钥匙串条目仍在且密码仍是 SUPER-SECRET-VALUE-12345；第 8 步钥匙串里同时留着旧键和新键两条——用户以为删掉的密钥永久残留，应用内无任何入口可以看到或清除。

**去哪看**：钥匙串访问 App 里搜索 ApiSolo 的条目数量与账户名（不需要展示密码内容，条目存在即命中）；第 6 步的 python3 只打印数组长度。


---

### T16 · [P1] 发送流程 / 键盘

**目的**：验证在 URL 栏按回车不做在途请求判重：一次请求未结束时再按回车会真的再发一次，而 UI 只显示一个响应、历史也只记一条。

**前置**：启动一个慢速并打印命中的服务器：
python3 -c "
import http.server, time, datetime
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        print('HIT', datetime.datetime.now().isoformat(), flush=True)
        time.sleep(6)
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(b'{\"ok\":true}')
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',8096),H).serve_forever()"

**步骤**

1. 新建 tab，方法 POST，URL http://127.0.0.1:8096/orders，「请求体」选 JSON 填 {"item":"A"}。
2. 点进 URL 输入框让光标停在里面。
3. 按一次回车，按钮变成「取消」。
4. 在它仍显示「取消」的 6 秒内，再按一次回车。
5. 看 Terminal 打印了几行 HIT。
6. 看 ApiSolo 显示了几个响应。
7. 打开「历史记录」，看新增了几条 POST /orders。
8. 打开底部「控制台」，数 started 行与 → 200 行各几条。
9. 加剧变体：重复第 2-3 步，然后按住回车约 3 秒，看 Terminal 打印多少行 HIT。

**正常表现**：第二次回车被忽略（与「发送」按钮在加载中变成「取消」的行为一致）；Terminal 只有 1 行 HIT，历史 1 条，控制台 1 started / 1 → 200。

**有 bug 的表现**：Terminal 出现 2 行 HIT（真的向服务端下了两次单），但界面只显示一个响应、历史只有一条、控制台有 2 条 started 却只有 1 条 → 200 —— 第一次请求的响应/日志/历史被静默丢弃，用户完全不知道自己发了两次。第 9 步按住回车会打出十几到几十行 HIT。

**去哪看**：Terminal 里 HIT 的行数；ApiSolo 的响应面板、历史面板、底部控制台面板。


---

### T17 · [P1] 网络 / 预连接探测

**目的**：验证发送前的 TCP 预探测没有超时且只试第一个解析地址：请求会卡到 ~75 秒（而不是 30 秒客户端超时），curl 能成功的多地址域名在 ApiSolo 里直接失败。

**前置**：ApiSolo 已启动；「设置 → 网络」里代理处于关闭状态（开启代理会跳过探测）。

**步骤**

A. 超时不受控：
1. 新建 tab，GET http://10.255.255.1:8443/health（该地址会静默丢弃 SYN）。
2. 点「发送」并开始计时。
3. 记录多久后才报错，以及错误文案的原文。
4. 对照：在「设置 → 网络」里配置并启用一个代理（比如 127.0.0.1:9，无需真的存在），再发一次，看失败时间与文案是否不同；测完关掉代理。
B. 只试第一个地址：
5. Terminal 启动 python3 -m http.server 8080 --bind 127.0.0.1
6. sudo nano /etc/hosts 追加两行（顺序不能反）：
   240.0.0.1   multi.test
   127.0.0.1   multi.test
7. Terminal 验证参考行为：curl -s -o /dev/null -w '%{http_code}\n' http://multi.test:8080/ 应打印 200。
8. 在 ApiSolo 里 GET http://multi.test:8080/ ，点「发送」。
9. 清理：删掉那两行 hosts 记录，停掉 http.server。

**正常表现**：A：约 30 秒后报超时（与客户端 30s 超时一致）。B：与 curl 一样返回 200。

**有 bug 的表现**：A：转圈远超 30 秒，约 75 秒后才失败，且错误文案是「TCP connect failed: Operation timed out」（这个文案本身就是证据——它来自预探测而不是 HTTP 客户端）；启用代理后失败时间明显不同。B：ApiSolo 报「TCP connect failed: No route to host」，而同一主机名 curl 能拿到 200。

**去哪看**：秒表/手机计时 + 响应面板的错误文案原文；Terminal 里 curl 的对照输出。补充观察：跑 sudo tcpdump -i lo0 -n 'tcp port 8080 and tcp[tcpflags] & tcp-syn != 0'，在 ApiSolo 里点一次「发送」应该只看到一次 SYN（若看到两次说明每次发送都多开一条连接）。


---

### T18 · [P1] WebSocket 生命周期

**目的**：验证两个 WS 生命周期缺陷：握手中关闭 tab 会漏掉一个永久存活的 socket；断开时不终止读循环，对不回应 Close 的服务端会留下僵尸连接；以及关闭 WS tab 期间关别的 tab 会关错 tab。

**前置**：ApiSolo 从 /Applications 启动；Terminal 里先记下 PID：pgrep -x ApiSolo。

**步骤**

A. 握手中关闭 → socket 泄漏：
1. 启动 WS_MODE=slow python3 /tmp/ws_lab.py（延迟 15s 完成握手）。
2. 在 ApiSolo 新建 WebSocket tab，URL ws://127.0.0.1:9111，点「连接」，按钮变成「连接中...」。
3. 在这 15 秒内点该 tab 的 x 关掉它（或 Cmd+W）。
4. 等超过 15 秒，看 Terminal 是否打印 handshake done。
5. Terminal 执行 lsof -nP -p $(pgrep -x ApiSolo) | grep 9111，看有没有 ESTABLISHED。
6. 重复第 2-3 步三次，再数一次 socket 条数。
7. 对照：这次等到「已连接」后再关 tab，服务器应打印 client gone 且 lsof 无残留。
B. 断开后僵尸连接：
8. 换成 WS_MODE=rude python3 /tmp/ws_lab.py（永不回应 Close）。
9. 新建 WS tab 连接 ws://127.0.0.1:9111，等状态变为已连接；lsof 确认 1 条。
10. 点「断开」，tab 状态变为已断开。
11. 再跑一次 lsof。重复连接/断开 5 次后再数一次。
C. 关 tab 时的索引竞态（仍用 rude 模式，服务端不读数据）：
12. 依次准备 4 个 tab：HTTP tab A（URL 填 https://example.com/A）、HTTP tab B、WS tab（连上 9111）、最后新建 HTTP tab 填 https://example.com/IMPORTANT。
13. 在 WS tab 的消息框粘贴一段约 20MB 的文本（python3 -c "print('x'*20000000)" | pbcopy 后 Cmd+V），点发送——发送会卡住但 UI 仍可操作。
14. 点 WS tab 的 x（它不会立刻消失）。
15. 在它还没消失时，点最左边 tab A 的 x（A 立即消失）。
16. 观察最终 tab 栏里剩下哪几个。

**正常表现**：A：第 4 步之后不应残留 socket（关闭 tab 应取消或随即断开握手完成的连接）。B：第 11 步 lsof 无残留。C：最终剩下 B 和 IMPORTANT，被点 x 的 WS tab 消失。

**有 bug 的表现**：A：Terminal 打印 handshake done，lsof 显示一条永久 ESTABLISHED，重复 3 次就有 3 条，界面上却一个 WS tab 都没有、无从关闭（只能退出应用）。B：点了「断开」、UI 显示已断开，lsof 里的连接仍在；5 次循环留 5 条僵尸连接。C：tab 栏最后剩下 B 和 WS —— 用户从未点过的 IMPORTANT 被静默关掉（未保存内容不可恢复），而点了 x 的 WS tab 还赖着不走，且已是断开状态、消息被清空的半废 tab。

**去哪看**：Terminal 的 ws_lab.py 输出（handshake done / client gone）；lsof -nP -p $(pgrep -x ApiSolo) | grep -c 9111 的计数；ApiSolo 的 tab 栏。


---

### T19 · [P2] cURL 导入 / 导出（回归网）

**目的**：一次性覆盖 cURL 解析与导出的多个已知缺陷，作为后续修复的回归基线。

**前置**：raw_echo.py 在 8099 运行；ApiSolo 已启动。

**步骤**

逐条粘贴到 URL 输入框（每条用一个新 tab），记录结果：
1. curl -X PURGE https://example.com/a → 看 URL 栏内容与方法下拉。
2. curl -X pos https://example.com/a → 同上。
3. curl -X GET -d '{"q":1}' -H 'Content-Type: application/json' https://example.com/s → 看方法下拉。
4. 把第 3 条的 -d 挪到 -X GET 前面再试一次，看方法下拉是否不同。
5. printf '{"name":"apisolo"}' > ~/payload.json 之后粘贴 curl -X POST -H 'Content-Type: application/json' -d @payload.json http://127.0.0.1:8099/p ，看「请求体」显示什么，然后发送并看 Terminal 收到的正文。
6. 对照：curl --data-binary @payload.json http://127.0.0.1:8099/p ，看「请求体」是否切成「二进制」并在发送时明确报「请重新选择文件」。
7. curl --data-urlencode 'q=a b&c' http://127.0.0.1:8099/p 发送后看 Terminal 正文，并与 Terminal 里直接跑同一条 curl 的结果对比。
8. curl -b 'a=1' -H 'Cookie: b=2' http://127.0.0.1:8099/p → 看「请求头」里有几行 Cookie，发送后 Terminal 报文里有几行；再在 Terminal 直接跑同一条 curl 对比。
9. 粘贴 curl 'https://api.example.com/s?q=cat'（不要再改动 URL 栏和参数表），然后「更多操作 → 复制为 cURL」，粘到文本编辑器看查询参数出现几次。
10. URL 栏改成 {{baseUrl}}/users，再「复制为 cURL」，粘出来看。
11. 粘贴 curl -H 'Accept: application/json'（整条命令里没有 URL）到空的 URL 栏，观察发生了什么。

**正常表现**：1/2：报错或提示无法解析，URL 与方法都不被破坏。3/4：两种写法都得到 GET。5：请求体是文件引用并在发送时明确报错（与第 6 条一致）。7：正文是 `q=a+b%26c`（**空格是 `+` 不是 `%20`** —— 真 curl 在百分号编码之后会把 `%20` 再转成 `+`；本文件初版写的 `%20` 是错的，见顶部勘误）。8：只有一行 Cookie: b=2（与真 curl 一致）。9：复制出的命令里 q=cat 只出现一次。10：复制出 curl '{{baseUrl}}/users'。11：文本被正常粘贴进 URL 栏，或弹出明确的解析失败提示。

**有 bug 的表现**：1：URL 栏变成字面量 PURGE，方法仍是 GET，真实 URL 被丢弃且无任何报错。2：URL 变成 pos。3：方法变成 POST（405 现场）；4：同语义的命令却得到 GET —— 结果依赖 flag 顺序。5：请求体是字面量 @payload.json，发送后服务端收到 13 字节的 @payload.json 字符串。7：正文是未编码的 q=a b&c，服务端会解析出两个参数。8：出现两行 Cookie，报文里也是两行（真 curl 只发一行）。9：复制出 curl 'https://api.example.com/s?q=cat&q=cat'，参数重复。10：复制出 curl '/%7B%7BbaseUrl%7D%7D/users'，主机名没了，粘到终端直接 URL rejected。11：粘贴内容凭空消失，URL 栏依旧为空且无任何错误提示。

**去哪看**：URL 输入框、方法下拉、「请求头」「请求体」「参数」子标签；Terminal 里 raw_echo.py 的报文；剪贴板粘贴到文本编辑器的内容。


---

### T20 · [P2] 历史记录标注/收藏（焦点区域 B 可行性勘察）

**目的**：在动手做「历史备注/收藏」之前，实测现有历史存储与面板能否承载这个功能：是否有单条操作入口、条数上限行为、以及每次追加全量重写整个文件带来的延迟。

**前置**：已按 setup 备份 ~/ApiSolo；ApiSolo 已启动。

**步骤**

1. 打开「历史记录」面板，逐一确认现有交互：鼠标悬停在一条记录上有哪些按钮？右键有没有菜单？有没有单条删除、备注、收藏、置顶？除了底部的「清空历史」还有别的操作吗？
2. 记录当前条数：wc -l ~/ApiSolo/scratch/history.jsonl
3. 造压力数据：把当前文件复制放大到接近 1000 条并带上较大的响应体（每条 ~50KB），例如：
   python3 - <<'PY'
import json, os, shutil
p = os.path.expanduser('~/ApiSolo/scratch/history.jsonl')
shutil.copy(p, p + '.orig')
lines = [l for l in open(p) if l.strip()]
base = json.loads(lines[-1]); base['responseBody'] = 'x' * 50000
out = []
for i in range(1000):
    e = dict(base); e['id'] = 'perf-%d' % i; out.append(json.dumps(e))
open(p, 'w').write('\n'.join(out) + '\n')
print('bytes =', os.path.getsize(p))
PY
4. 重启 ApiSolo，打开「历史记录」面板，记录面板出现内容前的等待时间，滚动是否流畅。
5. 在一个 tab 里发一次普通请求（例如 http://127.0.0.1:8099/x 或 https://example.com），从点「发送」到响应出现的时间与第 3 步之前相比是否变长；连发 5 次感受是否稳定变慢。
6. 观察发第 5 步请求期间文件大小变化：ls -l ~/ApiSolo/scratch/history.jsonl 多跑几次。
7. 确认上限行为：条数是否停在 1000、最老的条目是否被丢弃。
8. 清理：mv ~/ApiSolo/scratch/history.jsonl.orig ~/ApiSolo/scratch/history.jsonl

**正常表现**：面板有单条操作入口（至少单条删除），大文件下打开/滚动/发送都无可感知延迟，追加写不需要重写全文件——这种情况下「备注/收藏」可以直接挂在现有历史条目上。

**有 bug 的表现**：面板只有「清空历史」一个全局操作，单条既不能删也不能标记；1000 条 × 50KB（约 50MB）下面板打开明显卡顿、每次发送都要读全量+全量重写整个文件（发送到响应的耗时肉眼可见变长，文件被整体重写）；加上 T06 已证明的「一行坏了全废」，说明在当前 history.jsonl 单文件全量重写的模型上直接加标注/收藏是不可行的——结论应是：标注/收藏需要独立的旁路索引文件（按 entry id 关联，与历史正文解耦），或先把历史改成按行容错 + 追加写。

**去哪看**：历史面板的悬停/右键交互；秒表计时（面板打开、发送耗时）；ls -l 的文件大小与 wc -l 的行数；Activity Monitor 里 ApiSolo 的 CPU 峰值。


---


## 应该改成自动化测试的部分

以下这些完全不需要在真机 UI 里手测，应当固化为自动化测试；手测清单里保留它们只是因为当前仓库还没有对应用例，且部分需要先确认真机行为。

**前端 vitest（已有目录，直接加文件/用例）**
- `src/utils/__tests__/curl-parser.test.ts`（已存在）：T11 的 `$'...'` ANSI-C 解码（断言 header key 不以 `$` 开头、`\r\n` 被解码、authorization 被提取进 auth）；T19 的 `-X PURGE` / `-X pos`（断言抛错或方法/URL 都不被破坏）、`-X GET -d` 两种 flag 顺序都得到 GET、`-d @file` 与 `--data-binary @file` 行为一致、`--data-urlencode` 输出 `q=a+b%26c`（见顶部勘误）、`-b` 与 `-H 'Cookie:'` 同时存在时只保留 `-H` 那条。
- `src/utils/__tests__/curl-export.test.ts`（已存在）：T19 第 9/10 步——`{{baseUrl}}/users` 导出后不含 `%7B%7B`、host 不丢失；导入后 url 仍带 query 时导出不重复参数。
- `src/utils/__tests__/openapi-import.test.ts`（已存在）：自引用 `$ref`（`Node.child -> Node`）不再抛 `RangeError`，且同文件里无关的 `/health` 端点仍能被导入（这条我从手测清单里删掉了，因为纯逻辑、无 UI 依赖）。
- `src/stores/__tests__/request.test.ts`（已存在）：T13 全部可断言——`redactSensitiveText("Authorization: Basic dXNlcjpwYXNzd29yZA==")` 的输出 `not.toContain("dXNlcjpwYXNzd29yZA==")`；该函数幂等（跑两遍结果相同）；JSON 输入脱敏后仍 `JSON.parse` 得通；`grant_type=password&password=p&client_secret=xyz` 脱敏后仍保留 `client_secret` 字段名；`isSensitiveKey("accessToken"/"clientSecret"/"Ocp-Apim-Subscription-Key")` 为 true；`buildHistoryEntry` 产出的 `url` 字段不含明文敏感 query 值。注意现有断言只写了 `toContain("[redacted]")`，正是它让套件保持绿色——新用例要断言「敏感值不存在」而不是「出现了 redacted 字样」。
- `src/stores/__tests__/tabs-history.test.ts`（已存在）：T01 的前端半边——`openHistoryEntry` 还原出的 tab 里，值为 `"[redacted]"` 的 header/param/body 必须被清空并打标；`serializeRequestIdentity` 必须把 `projectName`/`savedRequestPath` 纳入比较，避免劫持已绑定集合的 tab。
- `src/stores/__tests__/tabs-close.test.ts`（已存在）：T18-C 的确定性版本——把 `websocketStore.disconnect` mock 成手动 resolve 的 pending promise，`removeTab(wsTab)` 不 await，再 `await removeTab(firstTab)`，最后 resolve，断言剩余 tab 为 `[B, IMPORTANT]`；`closeOtherTabs`/`closeTabsToRight` 同理。
- `src/stores/__tests__/environments.test.ts`（已存在）：T05 的 Route A/B——`createEnvironment('dev')` 对已存在名字必须拒绝（或加载既有变量而非清空）；切换项目时 `pendingEnvironmentNames` 必须被清理。
- 新建 `src/stores/__tests__/console-pinia.test.ts`：断言 `recordConsoleEntry` 不会改变 `getActivePinia()`（这是所有 store 测试可信度的前提，目前它会把 activePinia 换成模块单例，导致后续断言打在幽灵 store 上——先修这个，其它 store 用例才有意义）。

**Rust（`src-tauri/src/lib.rs` 的 `#[cfg(test)] mod tests`，用 `npm run test:rust`，串行 + wiremock，不断言墙钟耗时）**
- T04：`assert_ne!(vault_key_for(dir, "生产", "token"), vault_key_for(dir, "测试", "token"))`，以及 `订单服务` vs `用户服务` 的跨项目变体——今天必失败。
- T08-A：用空 params 走一遍 URL 构造，断言 `url.as_str()` 不以 `?` 结尾。
- T08-B/C/D：构造带显式 `Content-Type` / `Authorization` 的请求，断言最终 HeaderMap 里这两个 header 各只有一个值（form-urlencoded、form-data、basic/bearer 四个分支各一条）。
- T06：`read_history_entries` 遇到坏行应跳过并继续，断言 999 条好行仍能读出；再断言 `append_history` 在存在坏行时仍能成功写入。
- T07：`build_collection_tree` 遇到无法解析的 `.json` 应跳过（或返回带文件名的告警），断言其余 saved request 仍在树里。
- T05（Rust 侧）：`save_environment` 对已存在的 slug 应像 `create_project` 一样报冲突，而不是静默覆盖。
- T15：`save_environment` 带一个 secret 变量 → 再次调用时该变量缺席 → 断言 `load_secret_value(&vault_key_for(dir, "prod", "prodToken"))` 返回空。
- T02：给 reqwest 打开 gzip/br/deflate 特性后，用 wiremock 返回 `content-encoding: gzip` 的响应，断言 `body` 是解压后的明文；另加一条按 `charset=gb2312` 解码的用例。
- T12：断言 json body 分支发出的字节与输入逐字节相同（键序、重复键、大整数）。
- 保管库原子写：断言 `write_local_secret_map` 走的是 tmp+rename（例如注入一个写失败点后原文件仍可解析）——这条在手测里只能靠 `: > secrets.vault.json` 模拟，自动化更可靠。

**只能手测、不要试图自动化的**：T03（WebKit 下 `<input>` 重挂载导致的失焦，jsdom 复现不了真实焦点行为）、T09-C（键入 `?` 被吞的输入法/光标行为）、T10 的 UI 状态说谎、T17 的 ~75s 系统级 TCP 超时、T18 的 lsof 级 socket 残留、T20 的卡顿手感。
