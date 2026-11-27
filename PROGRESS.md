# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents `story-director`/`story-writer`）打造的本地互动小说与角色扮演创作引擎（Apache-2.0，零反代、零凭据抽取）。
- **当前阶段**：**v0.8.1**（`/rp` 单窗口会话隔离 + 记忆插件 + 审计全量加固）已完成实现、测试、全量构建、本地重装并同步至 GitHub。
- **最近完成**：
  - **`/rp` 快捷入口与会话级零污染隔离**：将技能 `story-engine` 重命名为 `/rp`（`plugin/skills/rp/SKILL.md`）；`SessionRuntime` 新增 `rpModeActive` 字段，在 `hook-pre-invocation.ts` 实现单窗口绑定（`/rp` 仅激活当前 `conversationId` 并自动呼出右侧面板，`/rp off` 退出当前窗口；其他普通 AGY 编程/问答窗口 100% 零注入零污染），并支持 RP 窗口内 OOC 面板呼出直通。
  - **深度审计全量修复与一键安装引导**：修复导演钩子写手隔离/回调防重、`</script>` 沙箱逃逸、XSS/正则/MVU/高度回环/载荷预算/并发写入等 16 项高危与严重缺陷；`README.md` 补充本地插件自动启用引导与 `/rp` 上手说明，`scripts/install-plugin.mjs` 支持悬空软链清理与临时目录自动 `--copy`。
  - **v0.8.0 记忆插件基础版（滑动窗口 + 逐楼小总结）**：新增 `src/core/memory-engine.ts`，支持总开关、每轮末尾提示词约束生成 ~200 字 `<memory_summary>`、精确按楼数切分滑动窗口（最新 N 楼完整正文，默认 10 楼；更早楼层替换为摘要）；侧边栏新增独立「记忆」Tab 与逐楼编辑；已在 `DEVELOPMENT.md` 写入 Phase 2–4 远期路线图。
- **验证状态**：`npm test` **11 套件 / 50 用例全绿（0 skipped）**；`npm run build` & `npm run install:plugin` 通过。

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
