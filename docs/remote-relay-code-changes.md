# 远程公网中继与文件下发代码修改记录

日期：2026-06-08

分支：`remote-relay-file-transfer`

## 背景

原远程连接主要依赖桌面本机随机端口和局域网/VPN 可达地址。手机跨 NAT 或不在同一 Wi-Fi 时无法访问桌面端页面；文件下发也只能通过本机直连下载。

本次修改引入中心节点公网中继，保留局域网直连作为 fallback，目标是：

- 手机非局域网也能连接桌面端。
- 连接不是短 20 分钟会话，而是长期保持。
- agent 在用户明确要求时，或桌面端手动选择文件时，可以给手机生成文件下载链接。
- 大文件不走业务服务器 blob，仍支持局域网 Range 下载。

## 核心设计

### 公网远程连接

- 桌面端登录后向 `deskagent-server` 注册 `remote_machines`，获得机器 token。
- 桌面端后台保持心跳，并轮询 `/api/remote/machine/commands`。
- 桌面端刷新二维码时优先调用中心节点 `/api/remote/machines/{machine_id}/pairing`。
- 手机打开 `/remote?code=...` 后调用 `/api/remote/relay/pairings/{code}` 建立 relay session。
- 手机通过 `/api/remote/relay/sessions/{session_id}/commands` 创建任务并轮询结果。
- 桌面端执行任务后通过机器 token 回写 `/api/remote/machine/commands/{command_id}/result`。
- 当前公网路径以可信中心节点为中继，命令 payload 和结果会经过中心节点；局域网直连路径仍保留端到端加密。

### 长连接策略

- 本地直连二维码有效期从 24 小时提升为 365 天。
- 公网 relay session 默认 30 天。
- 桌面端每 15 秒心跳，每 1.8 秒轮询命令。
- 桌面端仍会自动刷新 pairing，中心节点不可用时回退局域网直连。

### 文件下发

- 桌面端 `RemoteHost.sharePaths()` 会生成本地下载项。
- 若公网中继可用：
  - 小文件读取为 base64 上传 `/api/remote/machine/files`，中心节点生成 `/api/remote/files/{file_id}/{name}` 下载链接。
  - 大文件只登记 `direct_url`，下载时中心节点 302 到局域网直链。
- agent 只有在用户要求“把这个文件发到手机端”等明确语义下，才通过 `deskagent_send_file_to_phone` 工具调用本地 bridge 的 `/remote/share-file`，再由 `RemoteHost.sharePaths()` 登记下载项。
- 普通 `file` activity 只作为工具执行状态渲染，不会自动同步所有产物，避免中心节点带宽被无关文件占用。

## 修改文件

- `server/src/routes/remote.rs`
  - 新增公网 relay session API。
  - 新增无 Token 手机远程页面。
  - 新增机器端文件上传、手机端文件列表、文件下载/局域网重定向接口。
  - pairing payload 从 `version=1` 扩展为 `version=3`，包含 `mode=relay-encrypted`、`relay_session_id`、`direct_url(s)`。
  - 支持 `X-Forwarded-Prefix`，中心节点挂在 `/deskagent`、`/relay-e2e` 等子路径时，二维码 URL、手机页 API base 和文件下载链接不会丢失前缀。

- `server/src/db.rs`
  - 兼容迁移新增 `remote_relay_sessions`、`remote_files`。
  - 预留 `remote_relay_messages`、`remote_relay_files` 表，便于后续把公网路径升级为密文逐事件中继。
  - 旧库通过 `ensure_column` 补 `remote_pairings.relay_session_id` 和 `remote_commands.relay_session_id`。

- `server/src/config.rs`
  - 新增 `REMOTE_RELAY_FILE_MAX_BYTES`，默认 `5242880`。

- `app/src/main/remote.js`
  - 接入中心节点机器注册、心跳、命令轮询。
  - 公网 pairing 优先，失败时回退局域网直连。
  - 公网远程命令执行后等待 turn 完成并回写完整事件。
  - 文件分享同步到中心节点，小文件 blob，大文件局域网 fallback。
  - 后端 URL 拼接保留 path prefix，支持 `https://host/deskagent` 这类中心节点配置。
  - 本地 pairing TTL 改为 365 天。

- `app/src/main/index.js`
  - 向 `RemoteHost` 注入当前 `backendUrl()`。
  - 向本地 bridge 注入显式文件发送 callback。

- `app/src/main/bridge.js`
  - 新增 `/remote/share-file`，按工作目录解析相对路径，并调用 `RemoteHost.sharePaths()`。

- `app/src/mcp/deskagent-mcp.js`
  - 新增 `deskagent_send_file_to_phone` 工具，供 agent 在用户明确要求时发送指定文件。

- `app/src/renderer/renderer.js`
  - 远程连接面板文案更新为公网中继/局域网直连两种状态。

- `README.md`
  - 更新远程连接边界、中心节点职责、文件下发说明。

- `server/tests/remote_routes.rs`
  - 扩展公网 pairing、无 Token relay session、relay 命令、文件上传/下载断言。

- `test/remote-relay-host-regression.js`
  - 新增桌面端 RemoteHost relay 注册、轮询、结果回写、文件同步回归。

- `test/remote-direct-share-regression.js`
  - 更新长期连接 TTL 断言。

## 兼容性

旧的 `/api/remote/machines/{machine_id}/commands`、`/api/remote/machine/commands`、`/remote` 路径仍存在。手机页面改为默认公网中继逻辑，但桌面本机直连页面仍由 `app/src/main/remote.js` 本地 server 提供。

## 已知边界

- 公网路径目前不是逐 token 实时流式，桌面端完成 turn 后回写结果；局域网直连仍保留端到端加密 WebSocket/HTTP 事件流。
- 手机扫码 URL 中包含连接码，应视为访问凭证，不应公开传播。
- 超阈值大文件只生成局域网直链，跨网手机会看到文件项，但需要回到同 Wi-Fi/VPN 下载。
