# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents `story-director`/`story-writer`）打造的本地互动小说与角色扮演创作引擎（Apache-2.0，零反代、零凭据抽取）。
- **当前阶段**：**v0.8.1**（已发布 GitHub Release；删除旧 `v0.8.0`），全量 12 套件 / 58 用例全绿，本地插件与 `origin/main` 完全同步。
- **最近完成**：
  - **v0.8.1 导演无回显路由 + 18 项全面捉虫修复 + MVU/状态栏通用兼容性升级**：
    - 导演无回显与防重：`story_app_stage_director_input` 仅写 `stagedSidePaneInput`，经 `hook-pre-invocation.ts` 校验 `rpModeActive` 后提升为 `pendingDirectorInput` 并叠加 `transcript.jsonl` 步号锁 + 暂存时间戳锁 + 提交冷却锁（含 OOC 与非导演模式去重、分叉 `peekPendingFork` 自动绑定）；
    - MVU & 预设 & 记忆：`mvu-engine.ts` 单遍按源码顺序执行 lodash 更新 + 防原型链污染 + 多段 `[InitVar]*` 合并；`macro-engine.ts`/`ejs-engine.ts` 补齐 `display_data`/`delta_data`；`preset-parser.ts` 修复未排入 `prompt_order` 条目误启用；`memory-engine.ts` 避免裸 `<summary>` 劫持 `<details><summary>`；`mcp-server.ts` 统一 `DEFAULT_SESSION_ID`、补扫外部激活世界书 `[initvar]`、返回载荷剥离楼层 `statData` 防撞 1 MiB 上限；
    - 前端与安全：`sandbox-shim.ts` 修复 `runRegisteredSchemas` 返回旧 `STAT`；`regex-engine.ts` 修复 `sanitizeStaticHtml` 脚本体残留与折叠标签内占位符转义；`App.tsx` 补齐中文输入法 `isComposing`、`sendingRef`、草稿恢复、弹窗失败不关窗、切卡防串台与三处 iframe `evt.source` 校验。
  - **`/rp` 快捷入口与单窗口零污染隔离**：技能重命名为 `/rp`（`plugin/skills/rp/SKILL.md`），`SessionRuntime.rpModeActive` 按 `conversationId` 隔离，普通编程窗口 100% 零注入，`/rp off` 随时退出。
  - **v0.8.0 记忆插件基础版 + 16 项高危审计修复**：独立「记忆」Tab + 滑动窗口逐楼小总结；修复导演写手隔离/防重、`</script>` 沙箱逃逸、XSS/正则/高度回环/载荷预算/并发写入等问题。
- **验证状态**：`npm test` **12 套件 / 58 用例全绿（0 skipped）**；`npm run build` & `npm run install:plugin` 通过。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 零 AGY 宿主依赖；`src/agy/` 薄适配层；`src/ui/` 单文件打包（`vite-plugin-singlefile`），暖墨衬线书卷主题固定不随宿主覆盖。
- **核心契约**：
  - `mcp-server.ts`：外链图床 CSP 必须挂在 `resources/read` 的 `contents[0]._meta.ui.csp.resourceDomains`；`story_open_panel`/`story_commit_turn` 保持轻载荷遵守 1 MiB 轨迹限制；
  - `sandbox-shim.ts` + `MvuZodRuntimeHost.tsx`：前端沙箱使用真实 `zod4` 与 `lodash-es`，iframe 高度按 `body` 实际可见子元素底部计算以支持折叠缩高；
  - 严禁提及不存在的 `/agents` 命令；严禁提交私人角色卡/预设文件。
- **环境约束**：Windows PowerShell 5.1 不支持 `&&`（使用 `; if ($LASTEXITCODE -eq 0) { ... }`）。

## 3. 下一步计划（按优先级）
1. 记忆插件进阶路线（已记入 `DEVELOPMENT.md`）：Phase 2 分层滚动大总结（摘要森林）→ Phase 3 结构化记忆簿（人物关系/认知/实体/剧情线）→ Phase 4 外部独立 API / 旁路模型异步总结。
2. 按需实测导演与写手异构模型配对（`inherit` vs `pro`）。

## 4. 核心文件索引
- `DEVELOPMENT.md` & `README.md`：全量开发维护手册与公开安装说明
- `src/core/memory-engine.ts` / `mvu-engine.ts` / `card-parser.ts` / `preset-parser.ts` / `prompt-assembler.ts` / `story-log.ts`：核心记忆滑动窗口/MVU/EJS/多开场白/15 万预算引擎
- `src/agy/mcp-server.ts` & `src/agy/hook-*.ts`：MCP Server（动态 CSP、分片上传、脚本/开场白/记忆摘要工具）与 20 KB 分块钩子
- `src/ui/App.tsx` / `png-unpack.ts` / `FloorRenderer.tsx` / `sandbox-shim.ts` / `MvuZodRuntimeHost.tsx`：暖墨直聊阅读器、记忆管理页与 MVU Zod 沙箱宿主
- `plugin/agents/story-director.md` & `story-writer.md`：单窗口导演调度器与纯净写手子智能体
