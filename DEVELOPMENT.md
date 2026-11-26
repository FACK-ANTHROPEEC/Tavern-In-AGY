# TavernInAGY 开发与维护手册 (`DEVELOPMENT.md`)

> **当前版本**：`v0.7.2+`（最新提交 `9a52896`，Git 标签 `v0.1.0` → `v0.7.2`）
> **定位**：基于 Antigravity 官方原生扩展体系（MCP Apps SEP-1865 + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents）打造的 SillyTavern 全通用兼容 Roleplay 引擎。
> **合规底线**：100% 官方公开扩展路径，零反代、零 OAuth 凭据抽取、零无人自动循环（不使用 `Stop`/`PostInvocation` 续跑），绝不实现或承诺任何内容安全绕过机制。
> **用户核心硬偏好（压缩/换窗绝不可忘）**：
> 1. **永远保留 `tavern_commit_turn` 侧边栏单通道交付模式**：全部正文与预设显式思维链/规划标签（`<wave_plan>`、`<think_nya>`、`<thinking>`、`<update>`、`<wave_options>` 等）仅通过 `tavern_commit_turn(narrative)` 提交至右侧暖墨阅读器，主聊天框仅输出 1 行极简楼层索引（如 `✦ 第 #N 楼已落笔至侧边栏`）。
> 2. **严禁将私人样本提交进 Git**：`卡片参考/`、`预设参考/`、`我即浪潮-*.json`、`data/`、`*.chara.png` 均已在 `.gitignore` 中排除。
> 3. **先呈报后执行**：任何关键重构或新功能开发前，先向用户呈报方案，获得认可后再动手。

---

## 1. 架构分层与目录索引

项目严格执行三层解耦，确保 Antigravity 宿主升级时维护成本最小化：

```text
TavernInAGY/
├── docs/DESIGN.md                 # 初版架构设计文档
├── DEVELOPMENT.md                 # 本文档（权威全量开发手册、防忘提醒与路线图）
├── PROGRESS.md                    # 跨会话接力快照（<120行）
├── src/
│   ├── core/                      # 【零 AGY 依赖】纯 TypeScript 核心酒馆引擎
│   │   ├── types.ts               # 统一数据模型（Card/Lorebook/Preset/RegexScript/StoryTurn/SessionRuntime/TavernConfig）
│   │   ├── regex-engine.ts        # 通用 ST 正则引擎（minDepth/maxDepth/placement/markdownOnly/promptOnly/trimStrings/{{match}}/三路分流）
│   │   ├── macro-engine.ts        # O(N) 栈式嵌套多行宏 + roll/pick/globalvar/incvar/lastUserMessage + JS-Slash-Runner 作用域变量宏
│   │   ├── mvu-engine.ts          # 通用真 MVU（[initvar] / stat_data / RFC 6902 JSON Patch / _ 只读保护）
│   │   ├── ejs-engine.ts          # 通用 ST-Prompt-Template (EJS) 渲染引擎（支持 static 与 postHistoryText）
│   │   ├── card-parser.ts         # ST PNG (tEXt ccv3/chara) & JSON 解析 + 扩展/图床域名采集 + 内嵌世界书解析
│   │   ├── preset-parser.ts       # ST 社区预设解析（prompt_order / 深度排序 / Prefill 软桥接 / 正则提取 / 空内容分组）
│   │   ├── lorebook-engine.ts     # ST 世界书扫描（主/次关键词、正则、递归、预算 + AGY 冷却去重）
│   │   ├── prompt-assembler.ts    # 严格 ST 顺序拼装器 + UTF-8 12KB 分块切分器 splitIntoInjectChunks()
│   │   ├── story-log.ts           # 本地 JSONL 剧情楼层读写、编辑、回滚与分支续写（含按深度 promptOnly 正则压缩）
│   │   └── storage.ts             # 原子化本地 JSON 仓储（${PLUGIN_DATA} / TAVERN_DATA_DIR）
│   ├── agy/                       # 【极薄 AGY 适配层】
│   │   ├── transcript-reader.ts   # 防御性解析 transcript.jsonl + <wave_options> 提取
│   │   ├── hook-session-start.ts  # SessionStart 钩子（12KB 多块 injectSteps + 自动续接最多30楼 + 导演模式60s TTL握手 + 动态世界书扫描）
│   │   ├── hook-pre-invocation.ts # PreInvocation 钩子（跳过 /slash、导演模式0设定注入+1行防跑偏锚点、SessionStart兜底、同轮去重）
│   │   └── mcp-server.ts          # MCP Server（动态 CSP、宽容 Schema tavern_commit_turn、瘦身 delta、App-only 全套管理接口）
│   └── ui/                        # 【侧边栏 MCP App】React + Vite 单文件（暖墨衬线书卷风）
│       ├── App.tsx                # 5-Tab 主界面（默认主页=「正文」直聊阅读器 + 2.5s 自动轮询 + 导演/单轮开关 + 预设/正则/内嵌世界书管理）
│       ├── FloorRenderer.tsx      # 三路楼层渲染器 + 零脚本原生 <details><summary> 折叠 CoT/规划/总结标签
│       ├── MvuTreeView.tsx        # 通用可折叠 stat_data 属性树
│       ├── TavernFrontendHost.tsx # 通用侧边栏 TavernHelper 垫片（状态栏 HTML & 悬浮球舞台）
│       └── styles.css             # 暖深墨信纸横纹 + 宋体衬线 + 莫兰迪暖棕胶囊开关
├── plugin/                        # AGY 插件清单模板（由 install:plugin 复制至全局插件目录）
│   ├── plugin.json                # 仅含官方合法顶层字段
│   ├── mcp_config.json            # 挂载 dist/agy/mcp-server.js
│   ├── hooks.json                 # 挂载 SessionStart & PreInvocation
│   ├── agents/tavern-rp.md        # 纯净 Roleplay 写手 Agent（内联 tavern_commit_turn 签名，禁止动笔前查库）
│   ├── agents/tavern-director.md  # 单窗口导演调度 Agent（mainAgent: true + tools 白名单，每轮派发 tavern-rp 写完即毁）
│   ├── skills/tavern-rp/SKILL.md  # Roleplay 协作规范（禁止编程/文件/终端工具）
│   └── assets/logo.svg
├── scripts/install-plugin.mjs     # 一键安装至 ~/.gemini/config/plugins/tavern-in-agy
└── tests/                         # Vitest 单元测试 + 真实社区预设/双真卡集成测试（7套件/28通过/1旧路径跳过）
```

---

## 2. 已实现的核心机制

### 2.1 严格 ST 顺序拼装 + 12 KB UTF-8 分块防截断
- **`SessionStart` 严格组装顺序**（[prompt-assembler.ts](file:///d:/GeminiWorkX/AAA1/TavernInAGY/src/core/prompt-assembler.ts)）：
  `staticText`（预设前半段 + 角色卡 + 常驻世界书） → `Turn #0 Opening Scene` → `Resumed Story Turns`（自动续接 `stories/<cardId>.jsonl` 最多 30 楼，并对旧楼层按真实深度执行 `promptOnly` 正则压缩） → `Triggered World Info`（基于最近 6 楼与本轮输入） → `compactState` → `postHistoryText`（如 `[[WAVE_CONTEXT_END]]` / `output_contract`） → `[TavernInAGY Delivery]`。
- **UTF-8 分块防截断**：`splitIntoInjectChunks(text, 12000)` 按 UTF-8 字节数在段落边界安全拆分成多条 `injectSteps`（每条 ≤ 12 KB），彻底解决 Antigravity 单条 `systemMessage` 在 ~18–20 KB 处触发 `<truncated>` 的问题（实测 11 块完整送达、0 字节截断）。
- **AGY 缓存优化**：新建配置默认 `postHistoryRefreshInterval = 0`（`postHistoryText` 仅开局钉死一次，普通续聊轮次 `PreInvocation` 零冗余注入）；首轮注入后自动推进 `lastPostHistoryTurn = turnCount + 1`，防止旧配置 `interval = 1` 在第 1 轮双重注入。

### 2.2 单窗口子智能体导演模式（`tavern-director` + `directorMode`）
为在不污染左侧历史会话列表的前提下，实现「每轮 100% 干净全量上下文（编楼/重Roll/深度正则压缩即时生效）」：
1. **导演主窗口（`tavern-director`）**：
   - 在 [tavern-director.md](file:///d:/GeminiWorkX/AAA1/TavernInAGY/plugin/agents/tavern-director.md) 的 YAML frontmatter 显式声明 `mainAgent: true` 与 `tools: [invoke_subagent, manage_subagents, send_message]`（既获得子智能体调度权，又从源头剥离编程/查库/写作工具）。
   - 主窗口新开时，由于 `shared.pendingDirectorInput` 为空，`SessionStart` 直接返回 `{}`（**0 字节 RP 设定注入**），避免导演被 70 KB 写作设定洗脑成写手。
2. **60 秒 TTL 握手协议**：
   - 用户发送消息 → 主窗口 `PreInvocation` 捕获 `lastUserInput`，写入共享 `default` 会话的 `pendingDirectorInput` 与 `pendingDirectorInputAt`（60 秒有效期），仅向主窗口注入 1 行极短防跑偏锚点（同轮 `invocationNum > 1` 时去重返回 `{}`，防止子智能体回报后无限套娃）。
   - 导演立刻调用 `invoke_subagent(TypeName="tavern-rp", Model="inherit")` → `tavern-rp` 子智能体启动触发 `SessionStart` → 检测到未过期的 `pendingDirectorInput` 后消费清空，并注入完整 11 块分块设定（含本轮输入触发的动态世界书）。
   - `tavern-rp` 子智能体单轮直出调用 `tavern_commit_turn` 落笔 → 回报 1 行楼层索引 → 导演立刻调用 `manage_subagents(Action="kill")` 销毁子智能体，主窗口永远只留 1 行索引。
3. **备选模式（`statelessPerTurn`）**：
   - 保留在「状态」页，与 `directorMode` 自动互斥；开启后通过 `app.sendMessage({ _meta: { 'com.google.antigravity/message': { target: 'new' } } })` 每轮新建后台会话。

### 2.3 全生态社区预设、正则、MVU、EJS 与侧边栏直聊
- **ST 正则与三路渲染（`regex-engine.ts` + `FloorRenderer.tsx`）**：
  - 完整支持 `minDepth`/`maxDepth`、`placement`、`markdownOnly`/`promptOnly`、`trimStrings`、`{{match}}`、`substituteRegex`。
  - 零脚本原生 `<details><summary>` 折叠常见显式 CoT/规划/总结标签（`<wave_plan>`、`<think_nya>`、`<thinking>`、`<thought>`、`<wave_summary>`、`<wave_review>`、`<wave_comment>`、`<background>`、`<wave_options>`），避免在 MCP App 沙箱 iframe 中因 CSP 拦截脚本导致折叠失效，且使用裸 `<details><summary>` 避免与 Kemini/Meowssiah 的正则碰撞。
- **宽容单通道交付与实时同步**：
  - `tavern_commit_turn` 采用全宽容 Zod Schema（所有可选字段支持 `nullish`、数字/字符串互转、`options` 兼容纯字符串数组、`customFields` 兼容任意值），杜绝因小字段格式微差报错导致模型整篇正文重写；返回精简 `delta: true` 载荷避免膨胀对话轨迹。
  - `tavern-rp.md` 与 `tavern-director.md` 均明文内联 `tavern_commit_turn` 精确调用签名，并严格禁止动笔前调用 `tavern_get_state` / `tavern_search_lorebook` 或读 schema `.json`，大幅压缩单轮延迟。
  - 侧边栏发送消息后自动开启 2.5 秒轻量轮询，新楼层落盘后自动同步显示并清除 `pendingSend`，无需手动点「刷新」；`#0` 开场白楼层常驻置顶不消失。
- **完整资产管理**：
  - 侧边栏支持导入/切换/删除 PNG/JSON 角色卡、社区预设、外部世界书；
  - 支持内联编辑预设条目内容与 Role、独立开关预设正则、展开查看与独立开关角色卡内嵌世界书（`character_book`）每一条词条。

---

## 3. 开发、测试与安装命令

```powershell
# 运行全部单元测试 + 真实社区预设/双真卡集成测试
npm test

# 编译后端 TypeScript + Vite 单文件 MCP App UI (dist/ui/index.html)
npm run build

# 仅编译后端（未改 src/ui/ 时更快）
npm run build:backend

# 安装/更新插件到 C:\Users\<user>\.gemini\config\plugins\tavern-in-agy
npm run install:plugin
```

> **热更新规则（务必牢记）**：
> - 改了 `src/agy/mcp-server.ts`：构建安装后 **必须在 Antigravity 的 MCP Servers 设置中点击刷新/重启 `tavern-in-agy`**，否则旧 Node 进程会静默剥离新字段（曾导致 `directorMode` 按钮点不亮）。
> - 只改了 `src/ui/`：构建安装后重开右侧边栏即可热加载最新 HTML。
> - 只改了 `src/agy/hook-*.ts` 或 `src/core/`（仅影响 Hook）：构建安装后下次 Hook 触发即刻生效，无需重启 MCP Server。
> - 改了 `plugin/agents/*.md`：安装后需 **新开对话窗口** 才会加载新 Agent 的 frontmatter（含 `tools:` 白名单）。

---

## 4. 关键避坑与 Antigravity 底层铁律（血泪经验）

1. **单条 Hook `systemMessage` 约 18–20 KB 截断上限**：
   - 无论主窗口还是子智能体，单条 `injectSteps` 超过 ~20 KB 会被宿主直接截断为 `<truncated N bytes>`。**永远通过 `splitIntoInjectChunks(text, 12000)` 分块输出**。
2. **Subagent 钩子与工具特性**：
   - `invoke_subagent` 拉起的子智能体 **只触发 `SessionStart`，不触发 `PreInvocation`**，且可直接通过 `call_mcp_tool` 调用 MCP 工具。
   - 插件 Custom Agent 默认**不具备** `invoke_subagent` / `manage_subagents` 工具，必须像 `tavern-director.md` 一样在 frontmatter 显式声明 `tools: [invoke_subagent, manage_subagents, send_message]`。
3. **Subagent 模型档位限制**：
   - `invoke_subagent.Model` 与 Agent frontmatter 的 `model:` **只接受 4 个抽象枚举**：`inherit` / `flash_lite` / `flash` / `pro`，无法填具体模型代号（如 `4 neon`、`4 hydrogen`）。
   - 若想实现「导演用 `4 hydrogen` + 写手用强模型」，只能主窗口左下角手动选 `4 hydrogen` 并让导演派发时传 `Model: "pro"`（具体 `pro` 档映射哪款模型以客户端实测为准）；若要精确锁定 `4 neon` / `4 carbon`，则主窗口选目标模型并保持 `Model: "inherit"`。
4. **空白欢迎页（Welcome back）无 `message` 能力**：
   - 当左侧还是新窗口欢迎页、未发送过任何消息时，没有 `owning conversation`，宿主下发给侧边栏的 `hostCapabilities` 不含 `message`（输入框会禁用）；先在左侧发第一句建立对话后刷新/重开侧边栏即可解锁。
5. **共享 Session 与 Conversation Session 同步**：
   - MCP Server 写入的 `state` 与 `statData` 存在 `sessions/default.json`，而 Hook 按 `payload.conversationId` 读写。Hook 必须先从 `default` 同步最新 `state` 与 `statData`；且 `PreInvocation` 必须跳过 `/^\/[a-z0-9_-]+(?:\s|$)/i` 斜杠命令，避免输入 `/tavern-rp` 或 `/compact` 触发全量注入。
6. **AGY 1 MiB 轨迹上限与头像/内嵌世界书元信息**：
   - 模型工具返回体必须调用 `buildBootstrapPayload({ omitAvatars: true })` 控制体积，但**必须保留 `embeddedLorebookEntries` 轻元信息**，否则 UI 合并状态时会把角色卡内嵌世界书冲成 `0/N` 无法展开。
7. **Windows / 环境约束**：
   - Windows PowerShell 5.1 不支持 `&&`，串联命令必须用 `; if ($LASTEXITCODE -eq 0) { ... }`。
   - 复杂一次性脚本避免在 PowerShell 里用 `node -e`（引号会被吞），请写临时 `.mjs` 脚本。
   - MCP App 沙箱禁 `localStorage`/`IndexedDB`，所有持久化必须走 `app.callServerTool()`；UI 有意不调用 `applyHostStyleVariables()`，保持暖墨衬线书卷主题。

---

## 5. 下一步规划与待办路线图

1. **【v0.8.0 核心计划】正文摘要 / 剧情压缩模块（Story Summary & Compression）**：
   - **目标**：解决长篇 RP（尤其是导演子体模式每轮全量重拼）Token 消耗随楼层线性增长的问题。
   - **设计思路**：
     - 在 `StoryLogStore` / `SessionRuntime` 增加分层记忆结构：`pinnedSummary`（阶段性大总结）+ 最近 `N` 楼完整正文（如保留最近 6～10 楼原汁原味，更早楼层替换为精炼摘要）；
     - 支持自动提取预设自带的 `<wave_summary>` / `<summary>` 标签存入每楼 `turn.summary`，并支持在侧边栏手动编辑或一键触发「整理阶段大总结」；
     - `formatForForkResume` 在注入历史楼层时，对超过阈值深度的旧楼层自动输出 `turn.summary` 而非数千字全文，大幅省额度同时保持长期记忆不丢。
2. **导演与写手异构模型配对实测（按用户需求）**：
   - 若用户需要，可在 `tavern-director` 配置中增加可切换的派发档位（`inherit` vs `pro`），方便主窗口选 `4 hydrogen` 搭配 `pro` 档写手实测路由。
3. **测试与小项打磨**：
   - 修正 `tests/preset-parser.test.ts` 中 1 个指向旧根目录路径的 skipped 测试（统一指向 `预设参考/` 或移除重复项，达成 0 skipped）。
   - 按实机反馈补齐 `TavernHelper` 垫片常用扩展 API（如 `toastr`、`updateVariablesWith`）。

---

## 6. Git 版本里程碑

- `v0.1.0`：M1 核心引擎（ST 角色卡/预设/世界书/宏引擎 + 测试）
- `v0.2.0`：M2 AGY Hooks + MCP Server + 插件骨架
- `v0.3.0`：M3 React 单文件侧边栏 MCP App
- `v0.4.0`：`tavern_commit_turn` MVU 实时刷新 + JSONL 剧情流编辑/重 Roll/分支续写
- `v0.4.1`：单一常驻 `tavern-rp` 纯净 RP 模式 Custom Agent
- `v0.4.2`：暖墨衬线书卷风 UI + 莫兰迪暖棕胶囊开关 + 对白竖线排版
- `v0.5.0`：「正文」暖墨直聊阅读器设为默认主页 + 底部常驻发送坞
- `v0.6.0`：全通用真 MVU 引擎 + EJS 模板引擎 + 动态 CSP 白名单 + 侧边栏 `TavernHelper` 垫片舞台
- `v0.7.0`：ST 通用正则引擎、三路楼层渲染器、ST 全集宏、Prefill 软桥接、预设在线编辑与正则开关
- `v0.7.1`：侧边栏单通道交付、`postHistory` 首轮钉死优化、ST 严格顺序、内嵌世界书 UI、2.5s 自动轮询、无状态单轮模式
- `v0.7.2`：`tavern-director` 单窗口子智能体导演模式 + UTF-8 12 KB 分块 `injectSteps` 防截断
- `v0.7.2+`（`f6e7888` / `ee74a58` / `9a52896`）：导演模式 60s TTL 握手防洗脑、`tavern-director` 工具白名单、宽容 `tavern_commit_turn` Schema 与单轮直出提速
