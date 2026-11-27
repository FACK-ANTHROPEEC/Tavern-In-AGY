# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents `story-director`/`story-writer`）打造的本地互动小说与角色扮演创作引擎（Apache-2.0，零反代、零凭据抽取）。
- **当前阶段**：**v0.7.5** 已完成测试、全量构建、本地安装并推送至 `origin/main`（`5e14fc5`）。
- **最近完成**：
  - **大卡分片导入与前端解包**：新增 `src/ui/png-unpack.ts`（PNG `tEXt`/`iTXt` 本地解包 + `160px` 缩略图）与 `story_app_upload_chunk` 384 KB 分片上传，修复 `callTool` 吞错假报成功，瘦身 `buildBootstrapPayload()`；
  - **真·通用 MVU Zod v4 + 完整 Lodash 引擎**：引入 `zod4` 别名与 `lodash-es` 挂载至沙箱 `window.z` / `window._`，新增静默后台宿主 `MvuZodRuntimeHost.tsx`，对齐 `registerMvuSchema(schema | () => schema)`、`Mvu.events`（`eventOn` + `document` `CustomEvent` 双发）、`getAllVariables()`、`setChatMessages`（`swipe_id` + `data.stat_data`），后端 `mvu-engine.ts` 补齐 `<json_?patch>` 与 `_.assign`/`_.unset`/`_.add`；
  - **多开场白 + 图床 CSP + 阅读器打磨**：解析 V2/V3 `alternate_greetings`，支持 `#0` 右下角 `‹ 1/N ›` 翻页/点击数字直跳与卡片内跳转，切开场白自动应用开局 `<update>` 初始态；`resources/read` 的 `contents[0]._meta.ui.csp.resourceDomains` 动态放行外链图床；新增每层小铅笔编辑、默认 10 楼分页懒加载（可配）、卡片/预设脚本独立开关、字号/行距 CSS 修复、iframe 折叠精准缩高与 `#send_textarea`/`#send_but` 选项桥接。
- **验证状态**：`npm test` **8 套件 / 34 用例全绿（0 skipped）**；`npm run build` & `npm run install:plugin` 通过。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 零 AGY 宿主依赖；`src/agy/` 薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`），暖墨衬线书卷主题固定不随宿主覆盖。
- **核心契约**：
  - `mcp-server.ts`：外链图床 CSP 必须挂在 `resources/read` 的 `contents[0]._meta.ui.csp.resourceDomains`；`story_open_panel`/`story_commit_turn` 保持轻载荷遵守 1 MiB 轨迹限制；
  - `sandbox-shim.ts` + `MvuZodRuntimeHost.tsx`：前端沙箱使用真实 `zod4` 与 `lodash-es`，iframe 高度按 `body` 实际可见子元素底部计算以支持折叠缩高；
  - 严禁提及不存在的 `/agents` 命令；严禁提交私人角色卡/预设文件。
- **环境约束**：Windows PowerShell 5.1 不支持 `&&`（使用 `; if ($LASTEXITCODE -eq 0) { ... }`）。

## 3. 下一步计划（按优先级）
1. 设计并实现 **v0.8.0 正文摘要 / 剧情压缩模块**（分层记忆 + `pinnedSummary` + 历史上下文预算调节），大幅压缩长篇导演模式 Token 消耗。
2. 按需实测导演与写手异构模型配对（`inherit` vs `pro`）。

## 4. 核心文件索引
- `DEVELOPMENT.md` & `README.md`：全量开发维护手册与公开安装说明
- `src/core/mvu-engine.ts` / `card-parser.ts` / `preset-parser.ts` / `prompt-assembler.ts` / `story-log.ts`：核心 MVU/EJS/多开场白/15 万预算引擎
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP、分片上传、脚本/开场白工具）与 20 KB 分块钩子
- `src/ui/App.tsx` / `png-unpack.ts` / `FloorRenderer.tsx` / `sandbox-shim.ts` / `MvuZodRuntimeHost.tsx`：暖墨直聊阅读器与 MVU Zod 沙箱宿主
- `plugin/agents/story-director.md` & `story-writer.md`：单窗口导演调度器与纯净写手子智能体
