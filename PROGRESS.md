# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent `tavern-rp`）打造的 SillyTavern 全通用兼容 Roleplay 引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.7.1**（全生态预设与正则引擎 + 侧边栏单通道交付 + 无状态单轮全量重构模式）已完成测试、构建与安装（Git 标签 `v0.1.0`～`v0.7.1`）。
- **最近完成**：
  - 侧边栏单通道交付（`tavern_commit_turn` 承载全部正文与 CoT 标签，主聊天仅留 1 行楼层索引）与瘦身 delta 载荷；
  - 严格对齐 ST 提示词顺序（静态设定 → `#0` 开场白 → 自动续接历史楼层 → MVU 状态 → `postHistoryText` 尾注），默认 `postHistoryRefreshInterval = 0`；
  - 新增 **无状态单轮模式（`statelessPerTurn`）**：开启后侧边栏每轮发送通过 `target: 'new'` 拉起干净后台会话并全量重拼上下文（支持最多 30 楼与深度正则压缩），同步修复首轮重复注入 `postHistoryText`、空白欢迎页直聊提示与权限动态刷新；
  - 零脚本原生 `<details><summary>` 折叠思维链/规划标签、2.5s 自动轮询同步新楼层、角色卡内嵌世界书完整展开与独立开关。
- **验证状态**：`npm test` 7 套件 / 27 项测试全绿；`npm run build`（`dist/ui/index.html` `552.61 kB`）与 `npm run install:plugin` 通过。

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
