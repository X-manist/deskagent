# DeskAgent / 智界桌面助手

一个面向国内用户的一键安装桌面 AI 助手原型：

- **内核**：内置 agent runtime + 本地 `Responses -> Chat Completions` 适配层
- **桌面壳**：Electron
- **默认模型**：已接入 GLM（`glm-4.6`）
- **内置技能**：文字润色 / 中英互译 / 内容总结 / 数据分析，并支持自动发现/按需安装/主题沉淀
- **交互目标**：中文界面、免技能安装、免复杂配置、打开即聊

## 当前实现

### 架构

1. Electron 主进程负责窗口、设置、工作目录、`agentconfig/` 安装与会话管理。
2. 本地 adapter 对外提供 OpenAI **Responses API** 兼容接口，向上游 GLM 的 `/chat/completions` 转换。
3. 内置 agent runtime 连接 adapter，负责对话、工具调用、技能加载、文件操作。
4. 渲染层提供中文聊天 UI、状态栏、设置面板与会话管理；技能由 agent 自动发现，不在左侧做手动技能栏。
5. 默认 MCP profile 为 `core`：自动启用本地 `deskagent` 桌面桥接工具与持久化 memory，保证邮件、微信、桌面控制、定时任务和跨会话记忆等核心能力在模型侧直接可见；第三方 MCP 示例保留给开发调试，不在正式一键安装中默认打扰用户。

### 已完成能力

- 中文聊天 UI，支持流式回复
- 一键打开工作目录
- 会员套餐控制模型、积分、计费倍率和价格；桌面端不暴露手动 API 配置
- `agentconfig/` 整体同步到独立 agent home（不再只有 skills）
- 默认按 `agentconfig/skills/find-skills` 规则自动查找本地技能、按需联网搜索/安装技能
- 支持把用户确认的稳定主题流程写入 `agent-home/skills/<slug>/SKILL.md`，后续会话自动触发
- 已开启跨 session memory，长期偏好和项目事实沉淀在 `agent-home/memories/`
- 新会话 / 历史会话列表 / 会话恢复
- 自动绕过本机代理访问 `127.0.0.1`
- 打包时自动捆绑本机平台对应的 **native agent runtime**
- 默认 **YOLO 模式**（`approval_policy = never`，`sandbox_mode = workspace-write`）
- macOS 已完成本地打包与启动验证

## 目录

- `adapter/responses-adapter.js`：Responses ↔ Chat 适配器
- `app/`：Electron 应用
- `app/resources/bin/deskagent-core`：内置 agent runtime（已品牌化二进制，签名标识 `com.zhijie.deskagent.core`，不暴露上游名称）
- `core/codex/codex-rs/`：agent runtime 源码（编译产物即 `deskagent-core`）
- `agentconfig/`：预置 skills / MCP / rules / subagents 配置
- `test/e2e.js`：E2E 脚本
- `test/bridge-smoke.js`：本地 bridge 冒烟测试
- `test/shots/`：关键页面截图

## 本地启动

```bash
cd app
npm install
cp ../.env.example ../.env
# 然后把 GLM_API_KEY 等真实值填入 ../.env
npm start
```

> 如果宿主环境存在 `ELECTRON_RUN_AS_NODE=1`，启动前需要先 `unset ELECTRON_RUN_AS_NODE`。

## 配置位置

- **桌面设置**：`~/Library/Application Support/deskagent/settings.json`
- **agent 运行配置**：`~/Library/Application Support/deskagent/agent-home/config.toml`
- **agent 全局规则**：`~/Library/Application Support/deskagent/agent-home/AGENTS.md`
- **本地环境变量**：项目根目录 `.env`
- **打包后环境变量**：安装包资源目录下的 `.env`（`prepare.js` 会在打包前复制）

`.env` 示例见：`/.env.example`

默认 `DESKAGENT_MCP_PROFILE=core`，不自动加载 Playwright、地图、GitHub 等第三方 MCP 示例。开发调试时可改成 `DESKAGENT_MCP_PROFILE=full`，应用会把 `agentconfig/mcp/*.toml` 合并进运行配置。

远程连接不再依赖公网中转服务。桌面端会在本机开启一个随机端口的加密直连页面，二维码里包含局域网/VPN 地址、一次性连接码和一次性密钥；手机或浏览器需要与桌面处于同一 Wi-Fi、VPN，或能直接访问这台电脑的内网 IP。跨 NAT 的公网访问仍应通过 VPN、内网穿透或系统网络能力解决，应用本身不会把远程命令发到公网业务服务器。

## 管理端与中心节点

会员、支付、短信、额度扣减和管理端必须部署在可信中心节点服务器上，不能只放在用户本机。桌面端通过 `DESKAGENT_BACKEND_URL=https://你的后端域名` 连接中心节点；P2P/局域网直连只用于远程控制，不负责会员账本。

推荐部署：

- `deskagent-server`：公网 HTTPS API，例如 `https://api.example.com`
- `admin-web`：同一域名 `/admin` 或独立 `https://admin.example.com`
- 支付回调：由支付平台回调中心节点，再由服务端发放套餐额度

默认管理员只在数据库第一次初始化且 `admins` 表为空时创建：

- 默认账号：`admin`
- 默认密码：`admin123`
- 覆盖变量：`ADMIN_BOOTSTRAP_USER`、`ADMIN_BOOTSTRAP_PASS`

已有数据库不会因为修改 `.env` 自动改旧管理员密码。免费额度由 `FREE_TURNS` 控制，默认 `20` 次；管理端“用户管理”可以添加测试用户并返回桌面端测试登录 token。

## 打包

先准备资源：

```bash
cd app
npm install
npm run prepackage
```

> `prepackage` 会把 agent runtime 捆绑为品牌化的 `resources/bin/deskagent-core`，并在 macOS 上重新签名（默认 ad-hoc，标识 `com.zhijie.deskagent.core`），确保系统权限弹窗显示的是产品名「智界桌面助手」而非上游运行时名称。

### 品牌化 / 签名相关环境变量

- `DESKAGENT_RUNTIME_BIN`：显式指定要捆绑的 runtime 二进制（最高优先级）
- `DESKAGENT_SIGN_IDENTITY`：正式发布时填入自有「Developer ID Application」证书名（默认 `-` 即 ad-hoc，仅供本地）
- `DESKAGENT_BUNDLE_ID`：自定义代码签名标识（默认 `com.zhijie.deskagent.core`）

> runtime 源码位于 `core/codex/codex-rs`，`[[bin]] name = "deskagent-core"`，构建时通过 `cli/build.rs` 将 `cli/Info.plist`（`CFBundleDisplayName = 智界桌面助手`）以 `__TEXT,__info_plist` 段嵌入二进制。重新编译：
>
> ```bash
> cd core/codex/codex-rs
> cargo build --release -p codex-cli --bin deskagent-core
> ```
>
> 产物 `target/release/deskagent-core` 会被 `prepackage` 自动优先采用。正式发布前请用自有证书重签整个 `.app` 并公证。

然后按平台执行：

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

### 三平台策略

- **macOS**：已在当前环境完成 `electron-builder --mac --dir` 验证
- **Windows**：已配置 NSIS 一键安装包；需在 Windows CI/构建机执行产物构建
- **Linux**：已配置 AppImage + deb；需在 Linux CI/构建机执行产物构建

> 当前 `app/scripts/prepare.js` 会自动解析并复制本机平台的 native agent runtime。要正式发布三平台安装包，建议在各自平台 CI 上分别执行构建。

## E2E

### 本地 bridge 冒烟测试

```bash
cd app
npm run smoke:bridge
```

### 已验证场景

1. 应用启动进入“就绪”
2. 中文对话流式回复
3. 自动读取技能 `SKILL.md`
4. 工具调用创建工作区文件 `hello.txt`
5. 新会话与历史会话恢复
6. 设置面板展示
7. 打包后的 macOS `.app` 可直接启动并对话

### 关键截图

位于：

```bash
test/shots/
```

包含：

- `01-ready.png`
- `02-chat-streaming.png`
- `03-chat-reply.png`
- `04-tool-activity.png`
- `05-tool-done.png`
- `06-settings.png`
- `07-desktop-screenshot-tool.png`
- `08-desktop-screenshot-done.png`

## 已验证产物

- macOS `.app`：`app/release/mac-arm64/智界桌面助手.app`
- 打包体积约：`425M`

## 当前能力边界

| 能力 | 当前状态 | 实现方式 |
| --- | --- | --- |
| 浏览器控制 | 开发 profile 可启用 | `DESKAGENT_MCP_PROFILE=full` 后使用 `agentconfig/mcp/general.toml` 中的 `playwright` MCP |
| 文件/命令执行 | 已支持 | 内置 agent runtime + YOLO 模式 |
| 新会话/会话记录保存 | 已支持 | `thread/start` + `thread/list/read/resume` |
| 定时任务后台执行 | 已支持 | 本地 bridge + `node-cron` + 后台 `Engine`，后台任务同样挂载 `deskagent_*` 工具 |
| 发邮件 | 已支持 | 本地 bridge + SMTP；开发版用 `.env`，正式版可由会员后台下发 |
| 查邮件 | 已支持 | 本地 bridge + IMAP，支持未读/关键词筛选和正文预览 |
| 发微信/收微信 | 已支持两种路径 | 优先自有 `WECHAT_BRIDGE_URL`；macOS 可用本机微信 UI 自动化兜底 |
| 电脑级 UI 自动化 | 已接入基础桌面控制 | 打开应用、激活窗口、输入、快捷键、点击、滚动、截图；需要系统权限时按需弹窗引导 |

> 桌面控制和 macOS 本机微信兜底需要系统“辅助功能”权限。用户首次触发相关动作时，应用会弹窗说明并打开系统设置；平时聊天界面不展示能力配置面板。

## 上线前还建议补齐

- 品牌图标（mac/win/linux）
- 会员登录 / 令牌分发页面
- 自动更新
- 安装后首次引导
- Windows / Linux 平台 CI 打包流水线
- 正式支付渠道与套餐充值闭环
