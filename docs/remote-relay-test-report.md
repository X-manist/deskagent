# 远程公网中继与文件下发测试记录

日期：2026-06-08

分支：`remote-relay-file-transfer`

## 自动化回归

已通过：

```bash
cargo test --manifest-path server/Cargo.toml --locked
node test/remote-relay-host-regression.js
node test/remote-direct-share-regression.js
node test/account-admin-regression.js
node test/renderer-turn-order-regression.js
node test/agentconfig-updater-smoke.js
node -c app/src/main/remote.js
node -c app/src/main/index.js
node -c app/src/renderer/renderer.js
```

覆盖点：

- server 端公网 pairing、无 Token relay session、手机创建命令、机器轮询、结果回写。
- server 端小文件上传到中心节点、手机下载、中文文件名 `Content-Disposition`。
- 桌面端 RemoteHost 注册机器、生成公网 QR、轮询命令、执行 engine、显式分享文件。
- 原局域网直连文件分享和 Range 下载保持可用。
- 账号/admin/渲染顺序/agentconfig 既有回归未破坏。

## 本地 HTTP E2E

启动命令：

```bash
DATABASE_URL=sqlite:///tmp/deskagent-relay-e2e.db?mode=rwc \
BIND_ADDR=127.0.0.1:18987 \
SMS_PROVIDER=mock \
SMS_EXPOSE_MOCK_CODE=true \
USER_JWT_SECRET=remote-e2e-secret \
ADMIN_JWT_SECRET=remote-e2e-admin \
cargo run --manifest-path server/Cargo.toml --locked
```

验证流程：

- mock SMS 登录，拿用户 token。
- 注册机器 `e2e-machine`，拿 machine token。
- 创建 pairing，生成 `/remote?code=...#k=...`。
- 手机端无 token 调用 `/api/remote/relay/pairings/{code}` 建立 session。
- 手机端创建 remote command。
- 机器端通过 machine token 轮询命令。
- 机器端回写 completed result。
- 机器端上传 `e2e.txt` 小文件。
- 手机端列出文件并下载，响应 `200`，内容为 `hello e2e`。

证据文件：

- `artifacts/remote-relay-e2e/local-http-e2e.json`

## 截图验证

Browser 插件的 in-app browser 当前不可用，Playwright MCP 默认 profile 被占用；因此使用独立 Google Chrome headless + DevTools Protocol 临时 profile 生成截图。

截图文件：

- `artifacts/remote-relay-e2e/01-mobile-connected.png`
- `artifacts/remote-relay-e2e/02-mobile-sent-waiting.png`
- `artifacts/remote-relay-e2e/03-mobile-completed-files.png`
- `artifacts/remote-relay-e2e/04-small2u8g-mobile-connected.png`
- `artifacts/remote-relay-e2e/05-small2u8g-mobile-sent-waiting.png`
- `artifacts/remote-relay-e2e/06-small2u8g-mobile-completed-files.png`

截图覆盖：

- 手机远程页通过公网 relay code 连接。
- 手机发送任务后进入等待桌面端处理状态。
- 命令完成后显示回复；桌面端或 agent 显式发送文件后，手机端显示可下载文件列表。

## small2U8G 验证

使用 remote-sandbox `SMALL2U8G`：

- 已选择 sandbox：`SMALL2U8G`
- 同步代码：`/tmp/deskagent-remote-relay-e2e/server`
- 远程服务端口：`0.0.0.0:19087`
- 公网入口：`https://admin-deskagent.debinxiang.top/relay-e2e`
- 临时 Nginx：在现有 `deskagent-admin.conf` server block 内加入 marker 标记的 `/relay-e2e/` 反代到 `127.0.0.1:19087`，并设置 `X-Forwarded-Prefix /relay-e2e`。

执行情况：

- 用户清理后，`df -h / /tmp /opt` 显示根分区约 19G 可用，编译已能完成。
- 直接访问 `http://121.199.172.195:19087/health` 被云安全组/外部防火墙超时阻断。
- `sslip.io` 临时域名被阿里云备案拦截，返回 Non-compliance ICP Filing 页面。
- 改用已有备案域名 `admin-deskagent.debinxiang.top` 的 `/relay-e2e/` 前缀反代，公网访问 `https://admin-deskagent.debinxiang.top/relay-e2e/health` 返回 `200 ok`。

验证流程：

- mock SMS 登录，拿用户 token。
- 注册机器 `small2u8g-e2e-*`，拿 machine token。
- 创建 pairing，`payload.web_url` 为 `https://admin-deskagent.debinxiang.top/relay-e2e/remote?code=...#k=...`。
- 手机端通过公网 URL 建立 relay session。
- 手机创建 command，机器端轮询到同一 command id。
- 机器端回写 completed result，手机端查到 `completed` 和回复文本。
- 机器端通过显式分享流程上传 `small2u8g-e2e.txt` 小文件。
- 手机端文件列表返回 `/relay-e2e/api/remote/files/...` 下载链接。
- 本机通过公网下载链接获取 `200`，文件内容为 `hello small2u8g relay`。

证据文件：

- `artifacts/remote-relay-e2e/small2u8g-http-e2e.json`
- `artifacts/remote-relay-e2e/small2u8g-screenshot-e2e.json`

结论：small2U8G 作为中间节点的本分支实机验证已完成，覆盖非局域网公网入口、relay 命令、机器端回写、小文件公网下载和手机端页面截图。
