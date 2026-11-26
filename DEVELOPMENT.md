# TavernInAGY 开发与维护手册 (`DEVELOPMENT.md`)

> **当前版本**：`v0.6.0`（Git 标签 `v0.1.0` → `v0.6.0`）
> **定位**：基于 Antigravity 官方原生扩展体系（MCP Apps SEP-1865 + Local MCP Server + Lifecycle Hooks + Skill + Custom Agent）打造的 SillyTavern 全通用兼容 Roleplay 引擎。
> **合规底线**：100% 官方公开扩展路径，零反代、零 OAuth 凭据抽取、零无人自动循环（不使用 `Stop`/`PostInvocation` 续跑）。

---

## 1. 架构分层与目录索引

项目严格执行三层解耦，确保 Antigravity 宿主升级时维护成本最小化：

```text
TavernInAGY/
├── docs/DESIGN.md                 # 初版架构设计文档
├── DEVELOPMENT.md                 # 本文档（最新全量开发与避坑指南）
├── PROGRESS.md                    # 跨会话接力快照（<120行）
├── src/
│   ├── core/                      # 【零 AGY 依赖】纯 TypeScript 核心酒馆引擎（占 ~75% 代码）
│   │   ├── types.ts               # 统一数据模型（Card/Lorebook/Preset/StoryTurn/SessionRuntime）
│   │   ├── macro-engine.ts        # O(N) 栈式嵌套多行宏 + JS-Slash-Runner 作用域变量宏
│   │   ├── mvu-engine.ts          # 通用真 MVU（[initvar] / stat_data / RFC 6902 JSON Patch / _ 只读保护）
│   │   ├── ejs-engine.ts          # 通用 ST-Prompt-Template (EJS) 渲染引擎
│   │   ├── card-parser.ts         # ST PNG (tEXt ccv3/chara) & JSON 解析 + 扩展/图床域名采集
│   │   ├── preset-parser.ts       # ST 社区预设解析（prompt_order / 空内容分组 / 静态与近因分层）
│   │   ├── lorebook-engine.ts     # ST 世界书扫描（主/次关键词、正则、递归、预算 + AGY 冷却去重）
│   │   ├── prompt-assembler.ts    # L1/L2/L3 上下文拼装器
│   │   ├── story-log.ts           # 本地 JSONL 剧情楼层读写、编辑、回滚与分支续写格式化
│   │   └── storage.ts             # 原子化本地 JSON 仓储（${PLUGIN_DATA} / TAVERN_DATA_DIR）
│   ├── agy/                       # 【极薄 AGY 适配层】
│   │   ├── transcript-reader.ts   # 防御性解析 transcript.jsonl + <wave_options> 提取
│   │   ├── hook-session-start.ts  # SessionStart 钩子（L1 静态注入 + pending-fork 分支接力）
│   │   ├── hook-pre-invocation.ts # PreInvocation 钩子（L2 增量世界书 + L3 近因锚点 + 纯文本 <update> 捕获）
│   │   └── mcp-server.ts          # MCP Server（动态 CSP、模型工具、App-only 工具、ui://tavern/app.html）
│   └── ui/                        # 【侧边栏 MCP App】React + Vite 单文件（暖墨衬线书卷风）
│       ├── App.tsx                # 5-Tab 主界面（默认主页=「正文」暖墨直聊阅读器）
│       ├── MvuTreeView.tsx        # 通用可折叠 stat_data 属性树
│       ├── TavernFrontendHost.tsx # 通用侧边栏 TavernHelper 垫片（状态栏 HTML & 悬浮球舞台）
│       └── styles.css             # 暖深墨信纸横纹 + 宋体衬线 + 莫兰迪暖棕胶囊开关
├── plugin/                        # AGY 插件清单模板（由 install:plugin 复制至全局插件目录）
│   ├── plugin.json                # 仅含官方合法顶层字段
│   ├── mcp_config.json            # 挂载 dist/agy/mcp-server.js
│   ├── hooks.json                 # 挂载 SessionStart & PreInvocation
│   ├── agents/tavern-rp.md        # 单一常驻纯净 RP 模式 Custom Agent（/agents 切换）
│   ├── skills/tavern-rp/SKILL.md  # Roleplay 协作规范
│   └── assets/logo.svg
├── scripts/install-plugin.mjs     # 一键安装至 ~/.gemini/config/plugins/tavern-in-agy
└── tests/                         # Vitest 单元测试 + 真实社区预设/双真卡集成测试（6套件/19用例）
```

---

## 2. 已实现的核心机制

### 2.1 三层上下文注入（适配 AGY 追加式会话流）
1. **L1 开局静态层（`SessionStart`）**：
   - 每会话仅触发 1 次，注入预设 `chatHistory` 之前启用项（已展开宏与 EJS）+ 角色卡本体 + 蓝灯常驻世界书。
   - 若存在侧边栏触发的 `pending-fork.json`，自动消费并注入修剪后的 JSONL 历史楼层与 `stat_data`。
2. **L2 动态世界书层（`PreInvocation`）**：
   - 复刻 ST 扫描算法（`scan_depth`、主/次关键词、`/regex/flags`、递归扫描、`order` 排序、Token 预算）。
   - **冷却去重表**：记录 `injectedLorebookTurns[bookId:uid]`，在 `cooldownTurns`（默认 12 轮）内不重复注入，避免撑爆上下文或破坏 Prompt Cache。
3. **L3 近因锚点层（`PreInvocation`）**：
   - 按 `postHistoryRefreshInterval` 注入预设 `chatHistory` 之后的规划/文风锚点，以及发生变更后的精简实时状态。

### 2.2 社区三大生态件通用兼容
- **ST 社区预设**：`macro-engine.ts` 采用 O(N) 括号栈由内向外求值，支持多行 `setvar`、嵌套宏与上千次 `{{random::...}}`（实测 1 MB《我即浪潮》编译仅 ~32ms）；空内容条目在侧边栏自动渲染为可折叠分组。
- **真 MVU 引擎（`mvu-engine.ts`）**：
  - 自动从世界书 `[initvar]`（含禁用条目）初始化 `stat_data`；
  - `tavern_commit_turn` 自动解析 `<update>` / `<UpdateVariable>` 中的 **RFC 6902 JSON Patch**（`replace`/`add`/`remove`）与 `_.set`，强制拦截 `_` 开头只读字段，并将清理后的纯正文与当楼层 `stat_data` 快照写入 `stories/<cardId>.jsonl`；
  - 侧边栏执行「保留至此 / 重Roll」时，自动把 `stat_data` 精确回滚至目标楼层快照。
- **EJS 模板引擎（`ejs-engine.ts`）**：
  - 集成标准 `ejs`（`outputFunctionName: 'print'`），剥离 `@@preprocessing`，提供 `getvar(dotPath, { defaults })`、`setvar`、`getwi`、`getchar`、`_`（lodash 垫片）。
- **酒馆助手多作用域宏 & 侧边栏舞台（`TavernFrontendHost.tsx`）**：
  - 支持 `{{get_message_variable::...}}` / `{{get_chat_variable::...}}` 等宏并自动过滤 `$` 开头隐藏键；
  - `card-parser.ts` 自动收集卡内所有 `https://` 图片域名，由 `mcp-server.ts` 动态写入 `_meta.ui.csp.resourceDomains`；
  - `TavernFrontendHost.tsx` 提供 `TavernHelper` + `SillyTavern.getContext()` 垫片，并通过 `Proxy` 将 `window.parent` / `document.body` 重定向到侧边栏内部舞台，使独立美化状态栏 HTML 与悬浮球脚本均在侧边栏安全渲染，不碰 AGY 主窗口 DOM。

### 2.3 暖墨书卷直聊体验
- 默认主页为 **「正文」** Tab（全高布局：顶部精简栏 + MVU 迷你状态条 + 中部暖墨横纹衬线小说流 + 底部常驻直聊输入框与快捷选项按钮）。
- 视觉风格固定为暖深墨（`#191714`）+ 护眼米白宋体衬线（`Noto Serif SC / Source Han Serif SC / Songti SC / SimSun`）+ 独立对白行左竖线引用 + 莫兰迪暖棕胶囊 Toggle 开关。
- 插件内置单一常驻 Custom Agent：**`tavern-rp`**（聊天框输入 `/agents` 切一次即可进入纯净 RP 模式，切卡仍在侧边栏一键完成）。

---

## 3. 开发、测试与安装命令

```powershell
# 运行全部单元测试 + 真实样本集成测试（若本地存在样本文件）
npm test

# 编译后端 TypeScript + Vite 单文件 MCP App UI (dist/ui/index.html)
npm run build

# 安装/更新插件到 C:\Users\<user>\.gemini\config\plugins\tavern-in-agy
npm run install:plugin
```

> **重要**：只要修改了 `src/agy/mcp-server.ts`（例如新增工具、修改 CSP 白名单），在运行 `npm run build` 和 `npm run install:plugin` 后，**必须在 Antigravity 的 MCP Servers 设置中重启/刷新 `tavern-in-agy` 服务**，新后端才会生效；仅修改 `src/ui/` 时只需重开侧边栏视图即可热加载最新 HTML。

---

## 4. 关键避坑与注意事项（Gotchas）

1. **AGY 1 MiB 轨迹步上限**：
   - 模型可见工具（如 `tavern_open_panel`、`tavern_commit_turn`）的 `CallToolResult` 超过 1 MiB 会被宿主截断。
   - **约定**：模型工具返回体必须调用 `buildBootstrapPayload({ omitAvatars: true })` 省略大体积头像与巨型前端 HTML；前端挂载后再通过 `visibility: ["app"]` 的 `tavern_app_bootstrap` 和 `tavern_app_get_card_frontend` 拉取全量数据。
2. **MCP App 沙箱限制**：
   - 禁止依赖 `localStorage` / `IndexedDB`（关闭视图即清空），所有状态必须通过 `app.callServerTool()` 持久化到本地磁盘。
   - 默认 CSP 禁用外链资源；新增图床域名时依赖 `card.resourceOrigins` 自动汇总到 `_meta.ui.csp.resourceDomains`（导入带新图床的卡后需重启一次 MCP Server 刷新资源元数据）。
   - `global`（左侧导航全屏视图）没有关联会话，`app.sendMessage()` 不可用；直聊发送必须在右侧边栏（`aux_pane`）中打开。
3. **Hook 防重复注入**：
   - `PreInvocation` 在同一回合的多次工具调用前都会触发，必须保持 `lastUserInputHash` 去重逻辑，防止同回合反复注入世界书。
   - `transcript-reader.ts` 必须保持宽松防御性解析，防止 AGY 未来调整 `transcript.jsonl` 内部字段导致钩子崩溃。
4. **环境与隐私约束**：
   - Windows PowerShell 5.1 不支持 `&&`，串联命令请使用 `; if ($LASTEXITCODE -eq 0) { ... }`。
   - 国内网络安装新 npm 包建议使用 `--registry=https://registry.npmmirror.com`。
   - `.gitignore` 已排除 `卡片参考/`、`我即浪潮-*.json`、`data/`、`*.chara.png`，**严禁将私人角色卡/预设提交进 Git**。
   - 视觉样式有意不调用 `applyHostStyleVariables()` 覆写 CSS 变量，以保持暖墨衬线书卷主题稳定。

---

## 5. Git 版本里程碑

- `v0.1.0`：M1 核心引擎（ST 角色卡/预设/世界书/宏引擎 + 测试）
- `v0.2.0`：M2 AGY Hooks + MCP Server + 插件骨架
- `v0.3.0`：M3 React 单文件侧边栏 MCP App
- `v0.4.0`：`tavern_commit_turn` MVU 实时刷新 + JSONL 剧情流编辑/重 Roll/分支续写
- `v0.4.1`：单一常驻 `tavern-rp` 纯净 RP 模式 Custom Agent
- `v0.4.2`：暖墨衬线书卷风 UI + 莫兰迪暖棕胶囊开关 + 对白竖线排版
- `v0.5.0`：「正文」暖墨直聊阅读器设为默认主页 + 底部常驻发送坞
- `v0.6.0`：全通用真 MVU 引擎 + EJS 模板引擎 + 动态 CSP 白名单 + 侧边栏 `TavernHelper` 垫片舞台（双真卡验收通过）
