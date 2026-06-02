# MCP 工具配置说明

本目录提供可合并进 agent runtime `config.toml` 的 MCP 服务器配置片段。正式桌面端默认使用
`DESKAGENT_MCP_PROFILE=core`，只自动启用本地 `deskagent` 桥接工具，避免第三方 MCP 首次下载、
申请 Key 或工具数量过多影响一键使用。开发调试时可设置 `DESKAGENT_MCP_PROFILE=full` 启用本目录片段。

这些第三方服务器通过 `npx` / `uvx` / `docker` 在首次运行时自动拉取，**无需用户手动安装**。

## 文件

- `general.toml`：通用工具（文件系统、网页抓取、顺序思考、记忆、时间、Git、浏览器自动化、SQLite、GitHub）。
- `china.toml`：国内常用服务（高德地图、百度地图、12306 火车票、飞常准航班）。

## 运行依赖

| 工具前缀 | 需要安装 | 说明 |
|---------|---------|------|
| `npx`   | Node.js 18+ | 运行 npm 发布的 MCP 服务器 |
| `uvx`   | uv          | 运行 PyPI 发布的 MCP 服务器，见 https://docs.astral.sh/uv/ |
| `docker`| Docker      | 仅 GitHub 官方 MCP 示例使用 |

## 服务器清单

### 通用（general.toml）

| 名称 | 功能 | 是否需 Key | 来源 / 包名 |
|------|------|-----------|------------|
| filesystem | 在指定目录内读写文件 | 否 | `@modelcontextprotocol/server-filesystem` |
| fetch | 抓取网页/接口并转为文本 | 否 | `mcp-server-fetch` (uvx) |
| sequential-thinking | 结构化分步推理 | 否 | `@modelcontextprotocol/server-sequential-thinking` |
| memory | 知识图谱长期记忆 | 否 | `@modelcontextprotocol/server-memory` |
| time | 时间/时区换算 | 否 | `mcp-server-time` (uvx) |
| git | 本地 Git 仓库操作 | 否 | `mcp-server-git` (uvx) |
| playwright | 浏览器自动化/截图/抓取 | 否 | `@playwright/mcp` |
| sqlite | 查询/操作 SQLite 数据库 | 否 | `mcp-server-sqlite` (uvx) |
| github | GitHub 仓库/PR/Issue 操作 | 是（PAT） | `ghcr.io/github/github-mcp-server` (docker) |

### 国内（china.toml）

| 名称 | 功能 | 是否需 Key | 来源 / 包名 |
|------|------|-----------|------------|
| amap | 高德地图：地理编码、路线、周边、天气 | 是 | `@amap/amap-maps-mcp-server`（官方） |
| baidu-map | 百度地图：地理编码、路线、POI | 是 | `@baidumap/mcp-server-baidu-map` |
| train-12306 | 12306 火车票余票/车次/中转查询 | 否 | `12306-mcp`（社区，github.com/Joooook/12306-mcp） |
| variflight | 飞常准：航班查询、实时状态、机场天气 | 是 | `@variflight-ai/variflight-mcp`（官方） |

## 如何启用

桌面端使用 `DESKAGENT_MCP_PROFILE=full` 启动时，会自动把 `mcp/*.toml` 合并进独立 agent home 的
`config.toml`，并把示例中的工作区路径占位符替换为实际工作区路径。需要 Key 的服务仍需在设置或环境中补齐对应值。

手动调试时可直接打开生成后的 `config.toml`，按需删除不需要的 `[mcp_servers.*]` 段落，
或填写高德、百度、飞常准、GitHub 等服务的 API Key 后重启助手。

## 申请 API Key 入口

- 高德地图：https://lbs.amap.com/api/mcp-server/create-project-and-key
- 百度地图：https://lbsyun.baidu.com/apiconsole/key
- 飞常准：https://mcp.variflight.com
- GitHub PAT：https://github.com/settings/personal-access-tokens

> 说明：12306 服务器为社区开源项目，仅用于学习查询，请以 12306 官方渠道为准进行购票。
> 各 Key 与令牌请妥善保管，不要提交到代码仓库。
