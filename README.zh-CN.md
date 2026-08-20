# ApiSolo

ApiSolo 是一个本地优先的桌面 API 客户端，基于 Tauri、Rust、Vue 和 Pinia 构建。它面向 HTTP 请求编排、WebSocket 调试、项目集合、环境变量、请求历史和内置控制台，不需要托管账号。

[English](./README.md)

## 截图

| HTTP 工作区 | JSON 响应树 |
| --- | --- |
| ![HTTP 工作区](./docs/screenshots/zh-CN/01-http-workspace.png) | ![JSON 响应树](./docs/screenshots/zh-CN/02-response-json-tree.png) |

| 集合与导入导出 | 历史分组 |
| --- | --- |
| ![集合与导入导出](./docs/screenshots/zh-CN/03-collections-import-export.png) | ![历史分组](./docs/screenshots/zh-CN/04-history-grouping.png) |

| 环境变量与密钥 | WebSocket 工作区 |
| --- | --- |
| ![环境变量与密钥](./docs/screenshots/zh-CN/05-environments-secrets.png) | ![WebSocket 工作区](./docs/screenshots/zh-CN/06-websocket-workspace.png) |

| 设置 | 调试控制台 |
| --- | --- |
| ![设置、语言与主题](./docs/screenshots/zh-CN/07-settings-language-theme.png) | ![调试控制台](./docs/screenshots/zh-CN/08-debug-console.png) |

## 功能

- HTTP 请求构建器：方法、URL 参数、请求头、请求体、认证辅助和响应耗时。
- JSON 树与原始响应视图，支持响应头、Cookies、测试和耗时明细。
- 项目集合：保存/读取请求，并提供兼容 Postman 的导入导出路径。
- 环境变量：普通值写入本地项目文件；密钥值默认写入本地加密 Vault，也可以显式选择系统钥匙串。
- Pre-request 和 test 脚本在 QuickJS WebAssembly 沙箱中执行，并带有超时限制。
- WebSocket 连接：握手请求头、收发消息记录和连接状态。
- 请求历史：按 URL 前缀、时间或方法分组，保留可重放的历史条目。
- 内置调试控制台：记录应用、网络和脚本事件。
- 浅色/深色/跟随系统主题，英文/简体中文界面，代理和 TLS 设置。

## 界面导览

- 左侧导航：在集合、历史记录、环境变量之间切换。
- 顶部栏：选择当前环境并打开设置。
- 标签栏：同时保留多个 HTTP 和 WebSocket 标签页；通过 More 创建不同协议标签。
- 请求面板：发送前编辑 URL、参数、请求头、请求体、认证和脚本。
- 响应面板：查看状态码、耗时、响应体、响应头、Cookies、测试和耗时拆解。
- 底部控制台：查看请求生命周期、脚本输出、警告和错误。

## 核心流程

1. 在集合面板创建或选择项目。
2. 新建 HTTP 标签，输入 URL，配置参数/请求头/请求体/认证并发送。
3. 将常用请求保存到集合，需要时导出。
4. 创建环境，将稳定配置保存为普通变量，将 token、密码保存为密钥变量。
5. 在请求里使用 `{{baseUrl}}` 或 `{{apiToken}}` 这类占位符，避免硬编码敏感值。
6. 使用 WebSocket 标签调试本地或远程 socket。
7. 从历史记录查找之前的调用并按需回放。

## 安全与隐私模型

ApiSolo 只在本机保存数据，不依赖云账号。

- 数据目录：`$HOME/ApiSolo`。
- 项目目录：`$HOME/ApiSolo/projects/<project-slug>/`。
- 历史文件：`$HOME/ApiSolo/scratch/history.jsonl`。
- 窗口状态：`$HOME/ApiSolo/scratch/window-state.json` 保存主窗口上次尺寸，便于重启后恢复用户调整过的大小。
- 普通环境变量：项目内 `.env.json` 文件。
- 密钥环境变量：首次启动时 ApiSolo 会询问保存方式。默认使用本地加密 Vault，文件位于 `$HOME/ApiSolo/scratch/secrets.vault.json`；主密码只保存在当前内存会话中，应用重启后需要重新输入。可选的系统钥匙串模式通过 Rust `keyring` 写入操作系统凭据保险库，服务名为 `ApiSolo`，可能触发系统权限确认。
- 密钥存储配置：`$HOME/ApiSolo/scratch/secret-storage.json` 只保存选择的 backend，不保存密钥值或本地 Vault 主密码。
- 密钥元数据：`.env.secrets.json` 只保存变量名和 vault 引用；密钥值会写成空字符串。
- 迁移：如果旧版 `.env.secrets.json` 里有明文密钥，ApiSolo 首次加载时会导入当前选择的密钥 backend，并重写元数据文件去掉明文。
- 认证方式选择 API Key 且「添加到」为 Query 时，该键值只在**发送时**追加到查询串；出于密钥保护，URL 栏不显示它，以免密钥出现在你可能复制或截图的地址里。地址栏看不到它说明它被隐藏了，不是没生效。
- 保存请求和历史记录会保留 `{{token}}` 这类变量占位符，但会脱敏直接写入的认证/请求头密钥值，并在持久化前移除 `fileContent` / `binaryContent` 字节。
- UI 中选择的上传文件属于当前会话数据；保存和历史条目只保留脱敏后的文件标签/占位信息。
- 代理认证密码不会持久化到浏览器 localStorage。
- Pre-request 脚本失败时会中止请求，并在当前标签页和控制台显示错误。
- 脚本运行时：请求脚本在 QuickJS/WASM 中执行，只暴露有限 API（`pm`、`console`、断言、超时和变量更新）。不会暴露 `window`、Node API 或 Tauri API。

安全敏感设置：

- 关闭 TLS 证书校验只适合可信本地调试；它会允许中间人拦截。
- 代理设置会将流量转发到指定代理，可能暴露请求元数据和请求体。
- 导入集合可能包含不可信数据；启用脚本前请先审查脚本内容。

## 开发

前置要求：

- Node.js 22+
- Rust 1.88+ stable
- Tauri 2 所需平台依赖

命令：

```bash
npm install
npm run dev
npm run dev:web
npm run dev:web:client
npm run dev:web:api
```

开发模式：

- `npm run dev` 启动完整 Tauri 应用，并启用 `devtools` 和 `dev-bridge` feature。
- `npm run dev:web` 同时启动 Vite 和 Rust 开发桥接服务，用于浏览器内 UI 测试。
- `npm run dev:web:api` 只启动 Rust 开发桥接服务。
- 开发桥接服务只在 `dev-bridge` feature 下编译，并要求每次会话的 token 请求头。Release 构建不会编译或启动本地控制面。

## 测试

```bash
npm test
npm run build
npm run test:rust
npm run audit
npm run audit:cargo
```

测试覆盖 QuickJS 沙箱、脚本超时、pre-request 失败中止、vault 保存/读取/删除/迁移、历史脱敏、保存请求移除文件内容、HTTP 执行、历史重放响应处理、窗口状态持久化和开发桥接默认关闭。

`cargo audit` 可能报告来自 Tauri/GTK/rand 依赖链的已知 upstream warning。新的直接漏洞仍必须在发布前修复。

## 构建发布

```bash
npm run release:check
npm run tauri:build
```

Release 约束：

- 当前公开发布边界只覆盖 macOS。GitHub Actions 会在 `v*` tag 或手动触发时构建未签名的 macOS DMG/App artifact。
- Tauri devtools 只通过开发脚本显式启用的 `devtools` feature 打开。
- 开发桥接服务受 `dev-bridge` feature 保护，不属于默认 release 构建。
- `npm run tauri:build` 会设置 `CI=true`，避免 macOS 自动化环境在装饰 DMG 窗口时依赖 Finder。

## 已知问题

- 历史条目尚未携带在线响应已有的机器可读 body 类型标记：从历史重放二进制响应时，占位文本会被当作响应体原样显示。计划由历史备注切片（backlog D07b）修复。
- 响应体在网络层被整体读进内存、无大小上限（只有解压后的输出有上限），超大响应可能耗尽内存。已登记为 backlog D09。

## License

Apache-2.0。详见 [LICENSE](./LICENSE)。
