# Project Progress & Context Snapshot

## 1. 当前状态与里程碑
- **项目基底**：`TavernInAGY` — 基于 Antigravity 原生插件体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Skill）打造的 SillyTavern 兼容 Roleplay 引擎，零反代、零凭据抽取，原生兼容 ST 角色卡（PNG V2/V3 & JSON）、世界书与社区预设。
- **当前阶段**：M1～M3 MVP 全栈闭环开发完成（Git 标签 `v0.1.0` / `v0.2.0` / `v0.3.0`）。
- **最近完成**：完成项目级设计文档 `docs/DESIGN.md`、核心引擎（宏求值/角色卡/预设/世界书/编排器/本地仓储）、AGY 适配层（`SessionStart`/`PreInvocation` 钩子 + MCP Server + 插件清单）、React 单文件侧边栏 MCP App 及安装脚本。
- **验证状态**：`npm test` 12/12 全部通过（含工作区真实 1MB 社区预设 `我即浪潮` 集成测试，32ms 编译通过）；`npm run build` 通过（`dist/ui/index.html` 单文件 510.68 kB）；双 Hooks 命令行 stdin/stdout 冒烟通过。尚未执行全局插件安装（待用户确认后运行 `npm run install:plugin`）。

## 2. 架构约束与关键契约
- **目录与分层红线**：
  - `src/core/` 保持零 AGY 宿主依赖，所有 ST 数据解析与算法在此收敛；
  - `src/agy/` 作为薄适配层，读取 `transcript.jsonl` 必须保持宽松防御性解析与失败降级；
  - `src/ui/` 通过 `vite-plugin-singlefile` 打包为单文件 HTML（<10 MiB），严禁依赖 `localStorage` 或外部 CDN，所有持久化统一走 `app.callServerTool()`。
- **三层注入与数据契约**：
  - `SessionStart` 注入 L1（预设 `chatHistory` 之前启用项 + 角色卡 + 蓝灯常驻世界书）；
  - `PreInvocation` 按 `conversationId + lastUserInputHash` 去重，注入 L2（ST 世界书扫描 + `cooldownTurns` 冷却去重）与 L3（预设 `chatHistory` 之后近因锚点 + 变更后的精简实时状态）；
  - MCP App 资源 URI 为 `ui://tavern/app.html`（MIME `text/html;profile=mcp-app`），入口工具 `tavern_open_panel` 声明 `aux_pane` + `global`。
- **环境与避坑约束**：
  - Windows PowerShell 5.1 不支持 `&&`，命令拼接使用 `;` 与 `$LASTEXITCODE`；
  - 用户私人社区预设（`我即浪潮-*.json`）与本地数据目录已写入 `.gitignore`，严禁误提交至 Git；
  - 国内网络下 `npm install` 可使用 `--registry=https://registry.npmmirror.com`。

## 3. 下一步计划（按优先级）
1. 经用户确认后执行 `npm run install:plugin` 将插件挂载至 `~/.gemini/config/plugins/tavern-in-agy`，并在 AGY 右侧边栏实测导入角色卡、社区预设（`我即浪潮`）与世界书。
2. 根据真实 RP 体验按需迭代进阶功能：实时状态栏手动编辑、正则脚本可视化渲染（如 `<thinking>` 折叠与本楼记事卡片）、多存档快照一键读档切换。
3. 补充 `hook-session-start` / `hook-pre-invocation` 带真实激活角色与预设的自动化集成测试。

## 4. 核心文件索引
- `docs/DESIGN.md`：项目级架构、三层注入策略、模块契约与版本规范文档
- `src/core/macro-engine.ts`：O(N) 栈式嵌套多行 ST 宏求值器（`setvar`/`getvar`/`addvar`/`random`/`//`/`trim`）
- `src/core/card-parser.ts`：ST PNG (`tEXt` `ccv3`/`chara`) 与 JSON 角色卡解析器
- `src/core/preset-parser.ts`：ST 社区预设解析器（`prompt_order`、空内容分组、静态/近因分层、`regex_scripts`）
- `src/core/lorebook-engine.ts`：ST 世界书扫描引擎（主/次关键词、正则、递归、预算 + AGY 冷却去重）
- `src/core/prompt-assembler.ts`：L1/L2/L3 提示词组装与精简状态格式化
- `src/core/storage.ts`：基于 `${PLUGIN_DATA}` / `TAVERN_DATA_DIR` 的本地原子 JSON 仓储
- `src/agy/mcp-server.ts`：MCP Server（模型工具 + App-only 管理工具 + `ui://tavern/app.html` 侧边栏入口）
- `src/agy/hook-session-start.ts` & `src/agy/hook-pre-invocation.ts`：AGY 生命周期自动注入钩子
- `src/ui/App.tsx`：React 单文件侧边栏控制台（角色卡/预设手风琴开关/世界书/实时状态与快捷选项）
- `plugin/` & `scripts/install-plugin.mjs`：AGY 插件清单、Skill 与一键安装脚本
