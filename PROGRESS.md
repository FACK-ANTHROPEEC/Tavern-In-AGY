# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent `tavern-rp`）打造的 SillyTavern 全通用兼容 Roleplay 引擎，零反代、零凭据抽取。
- **当前阶段**：**v0.7.3**（默认单窗口导演模式 + 真·通用无硬编码渲染管线 + 去 `tavern` 化中性命名 `story_*` / `story-director` / `story-writer` + 无损多周目存档 + 公开 `README.md` 与 MIT 协议）已完成测试、构建与安装。
- **最近完成**：
  - 默认开启 `directorMode: true`；除插件名 `TavernInAGY` 外，全部 MCP 工具、Agents、Skill、Hook 注入文案与 UI 全面重构为中性命名（`story_*`、`story-director`、`story-writer`、`story-engine`），仅在纯本地 iframe 沙箱静默保留卡片运行期兼容别名；
  - 彻底废除 `FloorRenderer` 硬编码示例标签白名单，回归「正则优先 → 未知自定义 XML 标签通用兜底 → 三路分流（凡含 `<style>`/`<script>` 一律隔离进沙箱 iframe）」；
  - 新增外观与页面尺寸设置（`uiScale` 80~130%、`proseFontSize`、`proseLineHeight`、`maxReadingWidth`）、Author's Note（作者注释）注入、世界书冷却回合设置、正则美化持久化，以及**无损多周目聊天存档**；
  - 清理全部测试文件中的本地私人样本文件名（0 skipped），补齐叠甲充分的公开 `README.md` 与 `LICENSE`。
- **验证状态**：`npm test` 7 套件全绿（0 skipped）；`npm run build` 与 `npm run install:plugin` 通过。

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
1. 推送 `v0.7.3` 至 GitHub 公开仓库 `https://github.com/FACK-ANTHROPEEC/Tavern-In-AGY.git`（历史提交邮箱已全部洗为隐私邮箱，工作区已就绪）。
2. 设计并实现 **v0.8.0 正文摘要 / 剧情压缩模块**（含分层记忆与「历史记忆注入楼层数」控制），大幅压缩长篇导演模式 Token 消耗。

## 4. 核心文件索引
- `docs/DESIGN.md` & `DEVELOPMENT.md`：架构设计与完整开发维护指南
- `src/core/regex-engine.ts` & `src/core/preset-parser.ts`：ST 正则执行器、三路分流器、深度排序与 Prefill 软桥接
- `src/core/mvu-engine.ts` / `ejs-engine.ts` / `macro-engine.ts`：真 MVU、EJS 与 ST 宏全集
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP + 预设/正则编辑工具）与自动注入钩子
- `src/ui/App.tsx` / `FloorRenderer.tsx` / `MvuTreeView.tsx` / `TavernFrontendHost.tsx`：暖墨直聊阅读器、混合楼层渲染与侧边栏舞台
- `plugin/agents/tavern-rp.md`：单一常驻纯净 RP 模式 Custom Agent
