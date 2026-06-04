# agentconfig —— 智界桌面助手的项目级 agent 配置

本目录收录面向**国内用户**（工作 + 生活）的一整套 agent 配置：内置技能（skills）、
MCP 工具、角色（subagents）与行为准则（rules）。目标是让用户**安装即用、免配置**——
常用能力开箱即得，无需自行下载或编写技能；对话中需要新能力时，agent 会优先自动查找本地
skills，再按 `find-skills` 流程搜索可信来源并在用户确认后安装。

> 所有 MCP 服务器均通过 `npx` / `uvx` / `docker` 在首次运行时自动拉取，**用户无需手动安装**。

## 目录结构

```
agentconfig/
├── skills/        内置技能（SKILL.md，含中文工作/生活场景）
├── mcp/           MCP 工具配置片段（可合并进 config.toml）
├── subagents/     中文角色 / 子代理定义（可作角色提示词）
└── rules/         全局行为与安全准则（可注入 AGENTS.md）
```

## 一、技能 skills/

技能为 Anthropic 风格的 `SKILL.md`（frontmatter 仅 `name` / `title` / `description`），
与内置 agent runtime 兼容。桌面端会自动将其复制到独立 agent home 的 `skills/`，对话中按需触发；
前端不展示手动技能栏。

| 目录 | 技能 | 说明 |
|------|------|------|
| `polish` | 文字润色 | 对中文文本进行语法、用词、语气与流畅度的润色，保留原意并提升专业度。 |
| `translate` | 中英互译 | 在中文与英文之间进行准确、地道的翻译，兼顾专业术语与语境。 |
| `summarize` | 内容总结 | 将长文档、文章或会议记录提炼为结构化要点、摘要与行动项。 |
| `data-analysis` | 数据分析 | 读取 CSV / Excel 等表格数据，进行统计、清洗、汇总并给出可视化建议。 |
| `xiaohongshu-copywriting` | 小红书文案 | 种草/分享笔记：吸睛标题、口语化正文、分段排版、emoji 与话题标签。 |
| `wechat-article` | 公众号文章 | 微信公众号推文：双标题、引子、分小标题正文、金句与引导关注。 |
| `work-report` | 工作汇报 | 由零散事项生成日报/周报/月报，突出成果与数据，梳理计划与风险。 |
| `ppt-outline` | PPT大纲 | 按页生成演示文稿大纲：标题、要点与讲述建议。 |
| `resume-optimizer` | 简历优化 | 用 STAR 法则量化成果、匹配岗位 JD，提升简历通过率。 |
| `business-email` | 商务邮件 | 撰写得体的中英文商务邮件，语气专业、结构清晰、目的明确。 |
| `meeting-minutes` | 会议纪要 | 将记录整理为决议、待办（负责人/截止日）与遗留问题。 |
| `code-review` | 代码审查 | 聚焦 bug、安全与逻辑缺陷，给出可执行修改建议。 |
| `web-research` | 联网调研 | 借助 fetch/playwright 检索核对，输出带来源引用的结论。 |
| `excel-helper` | 表格助手 | Excel/WPS 公式、函数与透视表方案，可配合数据分析。 |
| `travel-planner` | 出行规划 | 结合高德/12306/飞常准查询路线、车次、航班并生成行程。 |
| `contract-review` | 合同审阅 | 识别合同风险点与缺失条款（非正式法律意见）。 |
| `find-skills` | 技能发现 | 当本地没有合适能力时，搜索、评估并按用户确认安装外部 skill。 |

对话中如果用户明确要求“记住这个流程 / 做成技能 / 以后都这样”，agent 可以把稳定主题流程写入
`agent-home/skills/<slug>/SKILL.md`。该目录已加入运行时可写根，后续会话会自动扫描并按需触发。

## 二、MCP 工具 mcp/

可直接合并进 agent runtime `config.toml` 的 MCP 服务器配置。详见 [`mcp/README.md`](./mcp/README.md)。

- `general.toml`：filesystem、fetch、sequential-thinking、memory、time、git、playwright、sqlite、github。
- `china.toml`：高德地图、百度地图、12306 火车票、飞常准航班。

需要 API Key 的服务（高德 / 百度 / 飞常准 / GitHub）已在文件内标注申请入口；12306 免 Key。

## 三、角色 / 子代理 subagents/

一组中文角色定义（规划师、调研员、编码工程师、审查员、文案专家、数据分析师）。
可作为角色提示词复用，或在开启多智能体实验特性后登记到 `config.toml`。
详见 [`subagents/README.md`](./subagents/README.md)。

> 说明：当前 agent runtime 没有 Claude Code 式「放文件即生效」的子代理机制，这里以可复用的角色提示词形式提供。

## 四、行为准则 rules/

- `base.md`：默认中文、先结论后细节、不臆测、不编造、用工具验证。
- `safety.md`：隐私凭据、内容合规、高风险操作确认、专业边界。

可在初始化 agent home 时写入或合并到 `AGENTS.md`，使所有会话默认遵循。

## 集成建议

1. **技能**：桌面端启动时整体安装 `agentconfig/`，内置技能会自动出现在 agent home 的 `skills/`，由 agent 自动选择。
2. **动态技能**：对话中沉淀的主题 skill 写入 agent home 的 `skills/<slug>/SKILL.md`，跨会话保留。
3. **MCP**：桌面端启动时自动把 `mcp/*.toml` 合并进 agent home 的 `config.toml`，并替换工作区路径占位符；默认 core profile 也会开启持久化 memory。
4. **准则**：桌面端启动时自动把 `rules/*.md` 合并进 agent home 的 `AGENTS.md`，并追加技能发现、动态 skill 与跨 session memory 规则。
5. **角色**：在 UI 中做成「切换角色」按钮，点击即把对应角色正文作为前置提示发送。

## 来源与可信度

- 通用 MCP：官方 `modelcontextprotocol/servers`、`microsoft/playwright-mcp`、`github/github-mcp-server`。
- 高德地图 / 飞常准：各自官方发布的 MCP 包。
- 百度地图：社区维护的 `@baidumap/mcp-server-baidu-map`。
- 12306：社区开源 `github.com/Joooook/12306-mcp`，仅用于查询，购票请走 12306 官方渠道。

各服务的功能、版本与字段可能随上游更新而变化，集成前建议核对对应仓库的最新文档。
