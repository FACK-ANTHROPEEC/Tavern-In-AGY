# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent `tavern-rp`）打造的 SillyTavern 全通用兼容 Roleplay 引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.7.0** 全生态预设与正则渲染引擎已完成测试、构建与安装（Git 标签 `v0.1.0`～`v0.7.0`）。
- **最近完成**：实现通用 ST 正则执行引擎（`src/core/regex-engine.ts`，完整支持 `minDepth`/`maxDepth`、`placement`、`markdownOnly`/`promptOnly`、`trimStrings`、`{{match}}`、`substituteRegex`）、三路楼层分流渲染器（`FloorRenderer.tsx`：暖墨纯文本 / 净化静态 `<details>` HTML / 沙箱 iframe 交互小部件）、ST 高频宏全集补齐（含 `{{roll 1d999999}}`、`{{pick}}`、`globalvar`/`incvar`/`decvar`、`lastUserMessage`/`lastCharMessage`）、深度排序 + Assistant Prefill 软桥接 + `postHistoryText` EJS 编译、分支续写历史压缩、以及侧边栏预设条目在线编辑与正则独立开关。
- **验证状态**：`npm test` 7 套件 / 27 项测试全绿（含 `预设参考/` 下 4 份真实社区预设 `Kemini` / `Meowssiah` / `夏瑾` / `我即浪潮` 及 `卡片参考/` 下 2 张真卡集成回归）；`npm run build`（`dist/ui/index.html` `546.23 kB`）与 `npm run install:plugin` 通过。

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
1. 在 Antigravity MCP Servers 中刷新重启 `tavern-in-agy` 后，重开右侧边栏实测导入 4 份真实预设与 2 张参考卡，验证正则美化开关、内联卡片交互与预设在线编辑。
2. 按实机反馈继续微调 `TavernHelper` 垫片 API（如 `toastr` / `updateVariablesWith`）与预设导出能力。

## 4. 核心文件索引
- `docs/DESIGN.md` & `DEVELOPMENT.md`：架构设计与完整开发维护指南
- `src/core/regex-engine.ts` & `src/core/preset-parser.ts`：ST 正则执行器、三路分流器、深度排序与 Prefill 软桥接
- `src/core/mvu-engine.ts` / `ejs-engine.ts` / `macro-engine.ts`：真 MVU、EJS 与 ST 宏全集
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP + 预设/正则编辑工具）与自动注入钩子
- `src/ui/App.tsx` / `FloorRenderer.tsx` / `MvuTreeView.tsx` / `TavernFrontendHost.tsx`：暖墨直聊阅读器、混合楼层渲染与侧边栏舞台
- `plugin/agents/tavern-rp.md`：单一常驻纯净 RP 模式 Custom Agent
