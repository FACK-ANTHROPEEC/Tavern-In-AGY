# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent `tavern-rp`）打造的 SillyTavern 全通用兼容 Roleplay 引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.6.0** 全通用 MVU + EJS + 侧边栏 `TavernHelper` 垫片舞台已完成测试、构建与安装（Git 标签 `v0.1.0`～`v0.6.0`）。
- **最近完成**：实现通用真 MVU 引擎（`[initvar]`、`stat_data` 每楼层快照与回滚、`<update>` RFC 6902 JSON Patch、`_` 只读保护）、通用 EJS 模板引擎（`ST-Prompt-Template`）、酒馆助手多作用域变量宏、动态图床 CSP 白名单采集、暖墨通用 `stat_data` 属性树与侧边栏 `TavernHelper` 垫片/悬浮球舞台。
- **验证状态**：`npm test` 6 套件 / 19 项测试全绿（含真实 1MB 社区预设 `我即浪潮` + 两张真卡《恶女婊子》MVU 卡与《大辰辰皇 V6》集成验收）；`npm run build` 与 `npm run install:plugin` 通过。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 零 AGY 宿主依赖（含 `mvu-engine.ts`、`ejs-engine.ts`、`macro-engine.ts`、`card-parser.ts`、`preset-parser.ts`、`lorebook-engine.ts`、`story-log.ts`）；
  - `src/agy/` 薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`），暖墨衬线书卷主题固定不随宿主冷色覆盖。
- **核心契约**：
  - `card-parser.ts` 通用提取 `regex_scripts`、`tavern_helper.scripts`、`customExtensions` 与 `resourceOrigins`；`mcp-server.ts` 动态注入 `_meta.ui.csp.resourceDomains`；
  - `tavern_commit_turn` 自动执行 `applyMvuUpdates`、绑定 `statData` 到 JSONL 楼层并清洗标签；`tavern_app_rollback_turn` 精确回滚对应楼层的 `statData`；
  - `TavernFrontendHost.tsx` 通过 `Proxy` 将 `window.parent` / `document.body` 重定向至侧边栏内部舞台，不触碰 AGY 主窗口 DOM。
- **环境与避坑约束**：
  - Windows PowerShell 5.1 不支持 `&&`；`卡片参考/` 与 `我即浪潮-*.json` 已在 `.gitignore` 排除。

## 3. 下一步计划（按优先级）
1. 用户在 AGY 右侧边栏重开 **TavernInAGY**，实测导入《恶女婊子》与《大辰辰皇 V6》体验 MVU 属性树、前端状态栏渲染与侧边栏悬浮球舞台。
2. 根据实机运行具体卡前端脚本时的日志反馈，按需补齐更多 `TavernHelper` API 垫片方法或正则渲染细节。

## 4. 核心文件索引
- `docs/DESIGN.md`：项目级架构文档
- `src/core/mvu-engine.ts` & `src/core/ejs-engine.ts`：通用真 MVU（RFC 6902 JSON Patch / `[initvar]`）与 `ST-Prompt-Template` EJS 引擎
- `src/core/card-parser.ts` / `preset-parser.ts` / `lorebook-engine.ts` / `macro-engine.ts` / `story-log.ts`：ST 全生态解析与存储核心
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP + MVU 工具）与自动分层注入钩子
- `src/ui/App.tsx` / `MvuTreeView.tsx` / `TavernFrontendHost.tsx`：暖墨衬线直聊主页、MVU 属性树与侧边栏 `TavernHelper` 垫片舞台
- `plugin/agents/tavern-rp.md`：单一常驻纯净 RP 模式 Custom Agent
