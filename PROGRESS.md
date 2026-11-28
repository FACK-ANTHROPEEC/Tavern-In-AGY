# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents `story-director`/`story-writer`）打造的本地互动小说与角色扮演创作引擎（Apache-2.0，零反代、零凭据抽取）。
- **当前阶段**：**v0.8.2**（已推送 GitHub 并更新 `v0.8.2` 标签），全量 12 套件 / 68 用例全绿，本地插件已同步最新构建。
- **最近完成**：
  - **v0.8.2 P0/P1 五项严审修复 + 沙箱世界书按需零截断拉取**：
    - `hook-pre-invocation.ts`：严格校验 `isSidePanePlaceholder` 才允许提升 `stagedSidePaneInput`，孤立/过期的侧栏占位符直接拦截返回 `{}` 绝不当作正文输入（P0-3），主窗口直接输入及 `/rp` 绑定时清理残留暂存；
    - `sandbox-shim.ts` & `mcp-server.ts`：世界书改为 `story_app_get_worldbook` 按需零截断拉取；`getWorldbook` 失败/超时（12s）改为 `reject`；`replaceWorldbook` 校验数组、已加载缓存与非空保护（服务端同步拒绝无 `allowEmpty` 的空覆盖，根治 P0-1/P0-2）；
    - `sandbox-shim.ts` / `MvuZodRuntimeHost.tsx` / `TavernFrontendHost.tsx`：`statSync` 携带 `latestTurn` 实时更新可变 `CHAT`/`LAST_MESSAGE_ID`（P1-1），本地写入回显去重且 `MESSAGE_RECEIVED` 仅在新楼到达时触发（P1-2），`srcDoc` 依赖锁定原始 `cardId`/`cardName` 防 iframe 重载。
  - **酒馆助手（JS-Slash-Runner）第一/二梯队高性价比 API 补齐**：
    - `sandbox-shim.ts`：补齐 `TavernHelper.tavern_events`/`iframe_events`、`eventMakeFirst`/`eventMakeLast`/`eventClearEvent`/`eventClearAll`、`insertVariables`/`deleteVariable`/`getVariable`/双签名 `insertOrAssignVariables`、`substitudeMacros`/`substituteMacros`、`getScriptId`/`getScriptName`/`getIframeName`/`getCurrentCharacterName`/`getCharData`、`/setvar`/`/addvar`/`/getvar`/`/echo` 本地斜杠执行、完整世界书读写 API（`getWorldbookNames`/`getCharWorldbookNames`/`getWorldbook`/`replaceWorldbook`/`updateWorldbookWith`/`createWorldbookEntries`/`deleteWorldbookEntries` 及 `Lorebook` 别名）与 `tavern:scriptError` 异常上报；
    - `mcp-server.ts` / `MvuZodRuntimeHost.tsx` / `TavernFrontendHost.tsx` / `FloorRenderer.tsx` / `App.tsx`：打通 `story_app_get_card_frontend` 世界书快照下发、`story_app_replace_worldbook_entries` 写回落盘、`GENERATION_ENDED`/`CHARACTER_MESSAGE_RENDERED`/`CHAT_CHANGED` 事件派发，并在状态页新增脚本异常折叠提示条。
  - **写手纯净瘦身与摘要防泄漏**：
    - `story-writer.md` 移除工程/工具禁用说教，精简为无 `tools:` 声明的纯净英文写作说明；`story-director.md`/`hook-pre-invocation.ts` 精简派单文案；`preset-parser.ts` 移除 `[Assistant Continuation Anchor]` 硬包装；
    - `memory-engine.ts`/`prompt-assembler.ts` 温和约定 `<memory_summary>` 写入 `story_commit_turn(narrative)` 内部，主聊仅留一行楼层索引。
  - **SillyTavern 官方精确队尾排序复刻**：
    - `lorebook-engine.ts` / `types.ts` 新增世界书 `role` / `extensions.role` 解析（`0=system, 1=user, 2=assistant`）；
    - `preset-parser.ts` 导出 `compareInChatDepthBlocks`（`depth` 降序 → 同深度 `user → assistant → system` 硬分组 → `order` 升序）并将 `CompiledPreset` 拆出 `depthBlocks` 与 `trailingPostBlocks`；
    - `prompt-assembler.ts` / `hook-session-start.ts` 将 `currentUserInput` 纳入 `assembleSessionStart` 精确落位：`Opening/History` → `Depth>=1` → `[Current Turn User Input]` → `Depth=0 (世界书+预设合并按 Role+Order 排)` → `Chat History 下方 Relative 预设块 (PHI/Prefill)` → `[Story Panel Delivery]`。
  - **性能优化 + EJS 通用补齐**：
    - `storage.ts` 增加 `mtimeMs + size` 内存缓存（实测 `listCards()` 77.88 ms → 1.89 ms，提速 41x）；`FloorRenderer.tsx`/`App.tsx` 限制历史楼层仅最新 10 楼（`depth < 10`）挂载沙箱 iframe；`sandbox-shim.ts` 正文美化启用 `liteProseMode` 跳过全量历史/开场白序列化；
    - `ejs-engine.ts` 接入真实 `lodash-es` 并补齐 ST-Prompt-Template `variables` 全局对象；`prompt-assembler.ts` 改为逐条世界书独立渲染 EJS，彻底杜绝单条报错连坐整块泄漏原始代码。
  - **ST 通用生态底座收口（YAML `[initvar]` + jQuery/正文美化沙箱 + 65 图床白名单）**：
    - `mvu-engine.ts` 引入 `js-yaml` 支持 YAML 格式 `[initvar]` 解析（避免 JSON 正则误吞内联 `{}`）；
    - `sandbox-shim.ts` / `FloorRenderer.tsx` / `App.tsx` 内置通用轻量级 `window.$`/`jQuery`、`errorCatched`、`tavern_events`、安全内存 `localStorage` 与隔离正文美化沙箱（`#chat > .mes > .mes_block > .mes_text`），自动兼容社区所有 `#chat .mes .mes_text` 排版/词条弹窗脚本；
    - `mcp-server.ts` 预置 65 个主流图床/字体/CDN 域名白名单 + 动态 `card.resourceOrigins` 兜底。
  - **ST V2/V3 世界书解析与槽位精确落位修复**：
    - `lorebook-engine.ts` / `types.ts` 完整解析 `entry.extensions` 中的 `prevent_recursion`、`exclude_recursion`、`delay_until_recursion`、`selectiveLogic`、`position`、`depth`、`scan_depth` 等字段，彻底根除多角色大卡世界书递归雪崩；
    - `prompt-assembler.ts` 将常驻蓝灯与动态触发绿灯统一按 ST `position`（`before_char` / `after_char` / `in_chat`）、`depth` 降序与 `insertion_order` 升序精确回填对应槽位并去掉 `[Lore: ...]` 外壳，完整保留作者配对嵌套块。
  - **v0.8.1 导演无回显路由 + 18 项全面捉虫修复 + MVU/状态栏通用兼容性升级**：
    - 导演无回显与防重：`story_app_stage_director_input` 仅写 `stagedSidePaneInput`，经 `hook-pre-invocation.ts` 校验 `rpModeActive` 后提升为 `pendingDirectorInput` 并叠加 `transcript.jsonl` 步号锁 + 暂存时间戳锁 + 提交冷却锁（含 OOC 与非导演模式去重、分叉 `peekPendingFork` 自动绑定）；
    - MVU & 预设 & 记忆：`mvu-engine.ts` 单遍按源码顺序执行 lodash 更新 + 防原型链污染 + 多段 `[InitVar]*` 合并；`macro-engine.ts`/`ejs-engine.ts` 补齐 `display_data`/`delta_data`；`preset-parser.ts` 修复未排入 `prompt_order` 条目误启用；`memory-engine.ts` 避免裸 `<summary>` 劫持 `<details><summary>`；`mcp-server.ts` 统一 `DEFAULT_SESSION_ID`、补扫外部激活世界书 `[initvar]`、返回载荷剥离楼层 `statData` 防撞 1 MiB 上限；
    - 前端与安全：`sandbox-shim.ts` 修复 `runRegisteredSchemas` 返回旧 `STAT`；`regex-engine.ts` 修复 `sanitizeStaticHtml` 脚本体残留与折叠标签内占位符转义；`App.tsx` 补齐中文输入法 `isComposing`、`sendingRef`、草稿恢复、弹窗失败不关窗、切卡防串台与三处 iframe `evt.source` 校验。
  - **`/rp` 快捷入口与单窗口零污染隔离**：技能重命名为 `/rp`（`plugin/skills/rp/SKILL.md`），`SessionRuntime.rpModeActive` 按 `conversationId` 隔离，普通编程窗口 100% 零注入，`/rp off` 随时退出。
  - **v0.8.0 记忆插件基础版 + 16 项高危审计修复**：独立「记忆」Tab + 滑动窗口逐楼小总结；修复导演写手隔离/防重、`</script>` 沙箱逃逸、XSS/正则/高度回环/载荷预算/并发写入等问题。
- **验证状态**：`npm test` **12 套件 / 68 用例全绿（0 skipped）**；`npm run build` & `npm run install:plugin` 通过。

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
