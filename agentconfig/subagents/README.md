# 子代理 / 角色（Subagents）

本目录提供一组中文角色（persona）定义，可作为 agent 的角色提示词复用。

## 关于 agent 的子代理

当前 agent runtime **没有** 类似 Claude Code `.claude/agents/*.md` 那样「放文件即生效」的子代理机制。
实践中有两种使用方式：

1. **作为角色提示词（推荐，开箱即用）**
   把某个角色文件的正文注入到对话或 `AGENTS.md` 中，让助手以该角色的职责与边界工作。
   桌面端可把它做成「切换角色 / 快捷指令」按钮，点击后将对应角色正文作为系统/前置提示发送。

2. **作为多智能体配置（实验特性）**
   agent runtime 在开启 `features.multi_agent = true` 后，支持 `spawn_agent` 等工具按 `agent_type`
   派生子代理。可在 `config.toml` 中按如下方式登记角色（键名以实际 runtime 版本为准）：

   ```toml
   [features]
   multi_agent = true

   [agents.reviewer]
   description = "高信噪比代码/方案审查"
   config_file = "subagents/reviewer.md"
   ```

   > 注意：多智能体为实验能力，不同 runtime 版本字段可能变化，启用前请核对当前版本文档。

## 角色清单

| 文件 | 角色 | 适用场景 |
|------|------|---------|
| `planner.md` | 规划师 | 需求拆解、制定可执行计划 |
| `researcher.md` | 调研员 | 联网检索、事实核查、竞品调研 |
| `coder.md` | 编码工程师 | 按计划实现代码改动并自验证 |
| `reviewer.md` | 审查员 | 代码/方案审查，找 bug 与安全问题 |
| `copywriter.md` | 文案专家 | 小红书/公众号/汇报/邮件等中文文案 |
| `data-analyst.md` | 数据分析师 | 本地表格数据清洗、统计与可视化建议 |

每个文件含 frontmatter（`name` / `role` / `description`）与职责、工作方式、边界三部分，
可直接作为提示词使用，也便于程序按字段解析展示。
