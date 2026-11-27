# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents `story-director`/`story-writer`）打造的本地互动小说与角色扮演创作引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.7.4**（单窗口导演模式默认开启 + 20 KB 单进程多分块 / 500 KB 实测零截断 + 15 万上下文动态预算续接 + 独立净室声明）已完成测试、构建、安装并就绪推送。
- **最近完成**：
  - 端到端实测单次 `SessionStart` 吐出 25 块 × 20 KB（500 KB / `187,883` input tokens）零截断、耗时 <1s、缓存全命中；正式将 `splitIntoInjectChunks` 默认上限提至 `20480`，`hooks.json` 超时放宽至 `20s`；
  - 移除 `formatForForkResume` 的 30 楼硬上限，升级为按 **150,000 tokens**（+ 480 KB 安全护栏）从最新楼层倒序填充；
  - 补全 `README.md` 独立净室实现与商标免责声明，中性化 `package.json` 描述。
- **验证状态**：`npm test` **7 套件 / 29 用例全绿（0 skipped）**；`npm run build:backend` 与 `npm run install:plugin` 通过。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 零 AGY 宿主依赖（含 `regex-engine.ts`、`mvu-engine.ts`、`ejs-engine.ts`、`macro-engine.ts`、`card-parser.ts`、`preset-parser.ts`、`lorebook-engine.ts`、`story-log.ts`）；
  - `src/agy/` 薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`），暖墨衬线书卷主题固定不随宿主冷色覆盖。
- **核心契约**：
  - `mcp-server.ts` 严守轨迹 1 MiB 限制：`story_open_panel` / `story_commit_turn` 省略 base64 头像与完整显示正则，由 `story_app_bootstrap`（App-Only）拉取完整 `activeDisplayRegexScripts` 与前端资源；
  - `FloorRenderer.tsx` 将交互式 HTML+JS 正则输出（含 `<script>` / `<!DOCTYPE` / `on*=`）隔离在自动调高 `iframe srcDoc` 中，通过 `postMessage` 桥接 `triggerSlash` 到侧边栏直聊；
  - `StoryLogStore.formatForForkResume` 对分支续写楼层按真实深度执行 `promptOnly` 正则压缩远古楼层。
- **环境与避坑约束**：
  - Windows PowerShell 5.1 不支持 `&&`；`卡片参考/`、`预设参考/` 与 `我即浪潮-*.json` 已在 `.gitignore` 排除。

## 3. 下一步计划（按优先级）
1. 推送 `v0.7.3` 至 GitHub 公开仓库 `https://github.com/FACK-ANTHROPEEC/Tavern-In-AGY.git`（历史提交邮箱已全部洗为隐私邮箱，工作区已就绪）。
2. 设计并实现 **v0.8.0 正文摘要 / 剧情压缩模块**（含分层记忆与「历史记忆注入楼层数」控制），大幅压缩长篇导演模式 Token 消耗。

## 4. 核心文件索引
- `docs/DESIGN.md` & `DEVELOPMENT.md`：架构设计与完整开发维护指南
- `src/core/regex-engine.ts` & `src/core/preset-parser.ts`：ST 正则执行器、三路分流器、深度排序与 Prefill 软桥接
- `src/core/mvu-engine.ts` / `ejs-engine.ts` / `macro-engine.ts`：真 MVU、EJS 与 ST 宏全集
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP + 预设/正则编辑工具）与自动注入钩子
- `src/ui/App.tsx` / `FloorRenderer.tsx` / `MvuTreeView.tsx` / `TavernFrontendHost.tsx`：暖墨直聊阅读器、混合楼层渲染与侧边栏舞台
- `plugin/agents/story-director.md` & `story-writer.md`：单窗口导演调度器与纯净写手子智能体
