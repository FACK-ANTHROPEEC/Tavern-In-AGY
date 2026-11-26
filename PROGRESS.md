# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents）打造的 SillyTavern 兼容 Roleplay 引擎，零反代、零凭据抽取，原生兼容 ST 角色卡（PNG V2/V3 & JSON）、世界书与社区预设。
- **当前阶段**：**v0.4.0** 开发、测试、单文件构建与本地插件安装全部完成（Git 标签 `v0.1.0` / `v0.2.0` / `v0.3.0` / `v0.4.0`）。
- **最近完成**：升级至 `v0.4.0`，新增角色卡一键导出 Custom Agent（`agents/rp-*.md`）、`tavern_commit_turn` MVU 实时状态栏刷新（含衣着 `outfit`）+ 本地 JSONL 剧情流，以及侧边栏「楼层」编辑/删楼重 Roll/一键新分支续写，并安装至 `~/.gemini/config/plugins/tavern-in-agy`。
- **验证状态**：`npm test` 5 套件 / 14 项测试全部通过（含 1MB 真实社区预设 `我即浪潮` 集成测试）；`npm run build` 零错误通过；插件已安装就绪，待用户在 AGY 右侧边栏实机体验反馈。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 保持零 AGY 宿主依赖；`src/agy/` 作为薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`，<10 MiB），不依赖 `localStorage`。
- **三层注入与分支接力契约**：
  - `SessionStart` 注入 L1 静态层，并自动消费 `pending-fork.json` 无损接力侧边栏修剪后的 JSONL 分支剧情；
  - `PreInvocation` 按 `conversationId + lastUserInputHash` 去重，注入 L2 世界书（带 `cooldownTurns` 冷却去重）与 L3 近因锚点/变更状态；
  - `tavern_commit_turn` 声明 `ui.resourceUri = "ui://tavern/app.html"`，写盘 `stories/<cardId>.jsonl` 并实时刷新 MVU 面板；`tavern_open_panel` 省略大体积头像防超 1 MiB 轨迹上限，前端再由 app-only `tavern_app_bootstrap` 拉全量。
- **环境与避坑约束**：
  - Windows PowerShell 5.1 不支持 `&&`；用户私人预设 `我即浪潮-*.json` 已在 `.gitignore` 中排除。

## 3. 下一步计划（按优先级）
1. 用户在 AGY 右侧边栏打开 **TavernInAGY** 实机导卡、导 `我即浪潮` 预设并跑一轮真实对话，收集 UI 手感与实机问题。
2. 按实机体验迭代：侧边栏手动修改状态栏数值、更多 `regex_scripts` 卡片渲染、角色卡/世界书在线编辑。

## 4. 核心文件索引
- `docs/DESIGN.md`：项目级架构与三层注入设计文档
- `src/core/macro-engine.ts` / `card-parser.ts` / `preset-parser.ts` / `lorebook-engine.ts`：ST 兼容核心引擎
- `src/core/story-log.ts` & `src/core/agent-exporter.ts`：JSONL 剧情楼层管理与 Custom Agent 导出器
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（含 `tavern_commit_turn` MVU）与生命周期钩子
- `src/ui/App.tsx`：React 单文件 5-Tab 侧边栏控制台（角色/预设/世界书/MVU状态/楼层分支）
- `plugin/` & `scripts/install-plugin.mjs`：AGY 插件清单、Skill 与一键安装脚本
