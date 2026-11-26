# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent `tavern-rp`）打造的 SillyTavern 全通用兼容 Roleplay 引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.7.2**（单窗口子智能体导演模式 `tavern-director` + `injectSteps` 分块防截断 + 侧边栏单通道交付）已完成测试、构建与安装（Git 标签 `v0.1.0`～`v0.7.2`）。
- **最近完成**：
  - 新增 **单窗口导演模式（`tavern-director` + `directorMode`）**：主窗口每轮零注入、不新增左侧历史会话，自动派发全新 `tavern-rp` 子智能体全量重拼上下文落笔并写完即毁；`PreInvocation` 在导演模式下仅缓存用户输入供子智能体 `SessionStart` 扫描动态世界书；
  - 新增 **Hook `injectSteps` 分块防截断**（`splitIntoInjectChunks`, ≤12 KB/块），彻底解决 Antigravity 单条 `systemMessage` ~20 KB 截断导致后置指令与交付规则丢失的问题；
  - 保留备选 **无状态单轮模式（`statelessPerTurn`）**、零脚本原生 `<details><summary>` 折叠 CoT、2.5s 自动轮询同步与角色卡内嵌世界书独立开关。
- **验证状态**：`npm test` 7 套件 / 28 项测试全绿；`npm run build`（`dist/ui/index.html` `553.59 kB`）与 `npm run install:plugin` 通过。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 零 AGY 宿主依赖（含 `regex-engine.ts`、`mvu-engine.ts`、`ejs-engine.ts`、`macro-engine.ts`、`card-parser.ts`、`preset-parser.ts`、`lorebook-engine.ts`、`story-log.ts`）；
  - `src/agy/` 薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`），暖墨衬线书卷主题固定不随宿主冷色覆盖。
- **核心契约**：
  - `mcp-server.ts` 严守轨迹 1 MiB 限制：`tavern_open_panel` / `tavern_commit_turn` 省略 base64 头像与完整显示正则，由 `tavern_app_bootstrap`（App-Only）拉取完整 `activeDisplayRegexScripts` 与前端资源；
  - `FloorRenderer.tsx` 将交互式 HTML+JS 正则输出（含 `<script>` / `<!DOCTYPE` / `on*=`）隔离在自动调高 `iframe srcDoc` 中，通过 `postMessage` 桥接 `triggerSlash` 到侧边栏直聊；
  - `StoryLogStore.formatForForkResume` 对分支续写楼层按真实深度执行 `promptOnly` 正则压缩远古楼层。
- **环境与避坑约束**：
  - Windows PowerShell 5.1 不支持 `&&`；`卡片参考/`、`预设参考/` 与 `我即浪潮-*.json` 已在 `.gitignore` 排除。

## 3. 下一步计划（按优先级）
1. 在 Antigravity MCP Servers 中刷新重启 `tavern-in-agy` 后，实测「无状态单轮模式（单轮全量）」开关与多轮正文续写手感。
2. 设计并实现 **正文摘要 / 剧情压缩模块**，在长篇 RP 中自动压缩早期楼层以保持上下文精简。

## 4. 核心文件索引
- `docs/DESIGN.md` & `DEVELOPMENT.md`：架构设计与完整开发维护指南
- `src/core/regex-engine.ts` & `src/core/preset-parser.ts`：ST 正则执行器、三路分流器、深度排序与 Prefill 软桥接
- `src/core/mvu-engine.ts` / `ejs-engine.ts` / `macro-engine.ts`：真 MVU、EJS 与 ST 宏全集
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP + 预设/正则编辑工具）与自动注入钩子
- `src/ui/App.tsx` / `FloorRenderer.tsx` / `MvuTreeView.tsx` / `TavernFrontendHost.tsx`：暖墨直聊阅读器、混合楼层渲染与侧边栏舞台
- `plugin/agents/tavern-rp.md`：单一常驻纯净 RP 模式 Custom Agent
