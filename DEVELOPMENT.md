# TavernInAGY 开发与维护手册 (`DEVELOPMENT.md`)

> **当前版本**：`v0.7.5`（真·通用 MVU Zod v4 + 完整 Lodash 后台常驻沙箱 + 大卡前端解包/384KB 分片上传 + 多开场白翻页/直跳/初始态初始化 + 外链图床 CSP 修复 + 每层小铅笔编辑 + 10 楼分页懒加载 + 卡片/预设脚本独立开关，Git 标签 `v0.1.0` → `v0.7.4`，主分支最新 `v0.7.5`）
> **定位**：基于 Antigravity 官方原生扩展体系（MCP Apps SEP-1865 + Local MCP Server + Lifecycle Hooks + Skill + Custom Agents）打造的本地互动小说与角色扮演创作侧边栏插件。
> **合规底线**：100% 官方公开扩展路径，零反代、零 OAuth 凭据抽取、零无人自动循环（不使用 `Stop`/`PostInvocation` 续跑，无自动发送），绝不实现或承诺任何内容安全绕过机制。
> **用户核心硬偏好（压缩/换窗绝不可忘）**：
> 1. **永远保留 `story_commit_turn` 侧边栏单通道交付模式**：全部正文与预设显式思维链/规划/选项/状态标签仅通过 `story_commit_turn(narrative)` 提交至右侧暖墨阅读器，主聊天框仅输出 1 行极简楼层索引（如 `✦ 第 #N 楼已落笔至侧边栏`）。
> 2. **除插件名 `TavernInAGY` 外全链路去 `tavern` 化**：所有发往云端的提示词、MCP 工具名（`story_*`）、Agents（`story-director` / `story-writer`）、Skill（`story-engine`）、UI 文案与公开文档均使用中性词汇；仅在纯本地 iframe 沙箱与卡片解析器内部静默保留运行期兼容别名。
> 3. **严禁将私人样本提交进 Git**：`卡片参考/`、`预设参考/`、`我即浪潮-*.json`、`data/`、`*.chara.png` 均已在 `.gitignore` 中排除；全仓库唯一 Git 作者署名为 `FACK-ANTHROPEEC <302725614+FACK-ANTHROPEEC@users.noreply.github.com>`（已公开托管于 `https://github.com/FACK-ANTHROPEEC/Tavern-In-AGY.git`，开源协议 **Apache-2.0**）。
> 4. **先呈报后执行**：任何关键重构或新功能开发前，先向用户呈报方案，获得认可后再动手；重 Roll 等交互遵循「撤回并填回输入框，由用户手动按 Enter 发送」，绝不替用户自动发送。

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
│   │   ├── mvu-engine.ts          # 通用真 MVU（[initvar] / stat_data / RFC 6902 <json_?patch> / _.set/_.assign/_.unset/_.add / _ 只读保护）
│   │   ├── ejs-engine.ts          # 通用 ST-Prompt-Template (EJS) 渲染引擎（支持 static 与 postHistoryText）
│   │   ├── card-parser.ts         # ST PNG (tEXt ccv3/chara) & JSON 解析 + alternate_greetings + 扩展/图床域名采集 + 内嵌世界书解析
│   │   ├── preset-parser.ts       # ST 社区预设解析（prompt_order / 深度排序 / Prefill 软桥接 / 正则与助手脚本提取 / 空内容分组）
│   │   ├── lorebook-engine.ts     # ST 世界书扫描（主/次关键词、正则、递归、预算 + AGY 冷却去重）
│   │   ├── prompt-assembler.ts    # 严格 ST 顺序拼装器（含多开场白选择与开局 MVU 补丁）+ UTF-8 20KB 分块切分器 splitIntoInjectChunks()
│   │   ├── story-log.ts           # 本地 JSONL 剧情楼层读写、编辑、回滚、无损多周目与 15 万上下文动态预算续接（含按深度 promptOnly 正则压缩）
│   │   └── storage.ts             # 原子化本地 JSON 仓储（${PLUGIN_DATA} / TAVERN_DATA_DIR）
│   ├── agy/                       # 【极薄 AGY 适配层】
│   │   ├── transcript-reader.ts   # 防御性解析 transcript.jsonl
│   │   ├── hook-session-start.ts  # SessionStart 钩子（单进程 20KB 多块 injectSteps + 15 万上下文动态续接 + 导演模式 5 分钟 TTL 握手 + 动态世界书扫描）
│   │   ├── hook-pre-invocation.ts # PreInvocation 钩子（跳过 /slash、导演模式 0 设定注入 + 1 行调度锚点、SessionStart 兜底、同轮去重）
│   │   └── mcp-server.ts          # MCP Server（resources/read 动态 CSP resourceDomains、384KB 分片上传、多开场白/编辑/脚本开关、宽容 story_commit_turn）
│   └── ui/                        # 【侧边栏 MCP App】React + Vite 单文件（暖墨衬线书卷风）
│       ├── App.tsx                # 5-Tab 主界面（默认主页=「正文」直聊阅读器 + 10 楼分页懒加载 + 每层小铅笔编辑 + 多开场白翻页/直跳 + 卡片/预设脚本面板 + #send_textarea/#send_but 桥接）
│       ├── png-unpack.ts          # 浏览器端 PNG V2/V3 本地解包（tEXt/iTXt）与 160px Canvas 缩略图压缩
│       ├── FloorRenderer.tsx      # 通用三路楼层渲染器（正则优先 → 未知自定义 XML 标签通用自动折叠 → iframe 沙箱隔离 + 开场白跳转事件桥接）
│       ├── sandbox-shim.ts        # 统一 CSP 安全 iframe srcDoc 底座（正版 Zod v4 / lodash-es / Mvu + registerMvuSchema + events / TavernHelper / getAllVariables / setChatMessages / 精确折叠高度收回）
│       ├── MvuZodRuntimeHost.tsx  # 静默后台沙箱宿主（自动运行已启用助手脚本注册 Zod Schema 并派生回写 stat_data）
│       ├── MvuTreeView.tsx        # 通用可折叠 stat_data 属性树
│       ├── TavernFrontendHost.tsx # 通用侧边栏卡片前端美化 / 悬浮球舞台（全 iframe 沙箱，无 new Function）
│       └── styles.css             # 暖深墨信纸横纹 + 宋体衬线 + 莫兰迪暖棕胶囊开关 + 滑块字号/行距变量绑定
├── plugin/                        # AGY 插件清单模板（由 install:plugin 复制至全局插件目录，安装前自动清理旧 agents/skills）
│   ├── plugin.json                # 仅含官方合法顶层字段（v0.7.3）
│   ├── mcp_config.json            # 挂载 dist/agy/mcp-server.js
│   ├── hooks.json                 # 挂载 SessionStart & PreInvocation（timeout: 20s）
│   ├── agents/story-writer.md     # 纯净互动小说写手 Agent（内联 story_commit_turn 签名，禁止动笔前查库）
│   ├── agents/story-director.md   # 单窗口导演调度 Agent（mainAgent: true + tools 白名单，每轮派发 story-writer 写完即毁）
│   ├── skills/story-engine/SKILL.md # 互动小说协作规范（禁止编程/文件/终端工具）
│   └── assets/logo.svg
├── README.md & LICENSE            # 公开安装文档（含合规叠甲与生态致谢）与 Apache-2.0 协议
├── scripts/install-plugin.mjs     # 一键安装至 ~/.gemini/config/plugins/tavern-in-agy
└── tests/                         # Vitest 全合成单元测试（8套件/34通过/0跳过，零私人文件名）
```

---

## 2. 已实现的核心机制

### 2.1 严格 ST 顺序拼装 + 20 KB UTF-8 分块防截断 & 15 万上下文动态预算
- **`SessionStart` 严格组装顺序**（[prompt-assembler.ts](file:///d:/GeminiWorkX/AAA1/TavernInAGY/src/core/prompt-assembler.ts)）：
  `staticText`（预设前半段 + 角色卡 + 常驻世界书） → `Turn #0 Opening Scene` → `Resumed Story Turns`（自动续接 `stories/<cardId>.jsonl`，无固定楼层数硬上限，按 15 万上下文预算从最新楼层倒序填充，并对旧楼层按真实深度执行 `promptOnly` 正则压缩） → `Triggered World Info`（基于最近 6 楼与本轮输入） → `compactState` → `postHistoryText`（如 `[[WAVE_CONTEXT_END]]` / `output_contract`） → `[TavernInAGY Delivery]`。
- **UTF-8 分块防截断**：`splitIntoInjectChunks(text, 20480)` 按 UTF-8 字节数在段落边界安全拆分成多条 `injectSteps`（每条 ≤ 20 KB），在单次 Hook 进程 stdout 内一次性输出，彻底规避 Antigravity 单步 `systemMessage` 的 ~24 KB 截断上限（实测单次 Hook 输出 **25 块 × 20 KB = 500 KB / `187,883` input tokens**，<1 秒完整送达、0 字节截断、前缀缓存全命中）。
- **AGY 缓存优化**：新建配置默认 `postHistoryRefreshInterval = 0`（`postHistoryText` 仅开局钉死一次，普通续聊轮次 `PreInvocation` 零冗余注入）；首轮注入后自动推进 `lastPostHistoryTurn = turnCount + 1`，防止旧配置 `interval = 1` 在第 1 轮双重注入。

### 2.2 单窗口子智能体导演模式（`story-director` + `directorMode`，默认开启）
为在不污染左侧历史会话列表的前提下，实现「每轮 100% 干净全量上下文（编楼/重Roll/切存档/深度正则压缩即时生效）」：
1. **导演主窗口（`story-director`）**：
   - 在 [story-director.md](file:///d:/GeminiWorkX/AAA1/TavernInAGY/plugin/agents/story-director.md) 的 YAML frontmatter 显式声明 `mainAgent: true` 与 `tools: [invoke_subagent, manage_subagents, send_message]`（既获得子智能体调度权，又从源头剥离编程/查库/写作工具）。
   - 主窗口新开时，由于 `shared.pendingDirectorInput` 为空，`SessionStart` 直接返回 `{}`（**0 字节剧情设定注入**），避免导演被长篇设定洗脑成写手。
2. **5 分钟 TTL 握手与防漏传兜底协议**：
   - 用户发送消息 → 主窗口 `PreInvocation` 捕获 `lastUserInput`，写入共享 `default` 会话的 `pendingDirectorInput`、`pendingDirectorInputAt`（5 分钟 TTL）与 `lastUserInputForCommit`（防止 `story_commit_turn` 漏传 `userMessage` 导致丢气泡/重Roll无法填回），仅向主窗口注入 1 行极短调度锚点（仅当明确 `invocationNum > 1` 时同轮去重，连发“继续”永不吞信号）。
   - 导演立刻调用 `invoke_subagent(TypeName="story-writer", Model="inherit")` → `story-writer` 子智能体启动触发 `SessionStart` → 消费清空 `pendingDirectorInput`，注入完整 20 KB 分块设定（含 Author's Note、15 万上下文预算内的当前周目存档与动态世界书）。
   - `story-writer` 单轮直出调用 `story_commit_turn` 落笔 → 回报 1 行楼层索引 → 导演立刻 `kill` 销毁子智能体，主窗口永远只留 1 行索引（无任何正文残留）。
3. **UI 与交互打磨（v0.7.3）**：
   - 已彻底移除旧版「无状态单轮模式」与旧内置「快捷走法选项」横条，导演模式下自动隐藏多余的「✨ 分支续写」；
   - 新增 **外观与页面尺寸**（缩放 80~130%、正文字号 12~22px、行距 1.4~2.2、阅读版心宽度；滑块本地即时预览+松手防并发写盘）、**作者注释（Author's Note）**、**无损多周目存档（`存档 1 · N轮` / `+ 新存档`）**、以及 **手动填回式 `↻ 重Roll本楼`**；
   - 沙箱 `sandbox-shim.ts` 完整支持 `getCurrentMessageId()`、范围 `getChatMessages(range)`、`/setinput` 填入输入框、`/send` 直接发送与 1600px 自适应高度。

### 2.3 全生态社区预设、正则、MVU、EJS 与侧边栏直聊
- **真·通用无硬编码 ST 正则与三路渲染（`regex-engine.ts` + `FloorRenderer.tsx` + `sandbox-shim.ts`）**：
  - 严格遵循 ST 原生顺序：`预设展示正则 → 卡片展示正则 → 通用未知自定义标签兜底 (foldUnknownCustomTags) → 三路分流 (splitFloorSegments)`。
  - **不再硬编码任何预设的特定标签或抢跑截胡**：预设自带的选项美化、思维链卡片、以及卡片自带的 `<StatusPlaceHolderImpl/>` 楼层状态栏（`mvu-engine.ts` 已保留占位符供卡片正则消费）全部原汁原味由正则渲染。
  - **未知自定义 XML 标签通用兜底**：正则跑完后，对任何未见过的新预设/卡片自定义标签 `<xxx>...</xxx>`，正文容器词（`content`/`story`/`narrative` 等）自动剥壳、未消费的空自闭合占位符静默隐藏，其余全部自动折叠为原生暖纸 `<details>` 抽屉，绝不裸奔污染正文。
  - **统一 CSP 安全 iframe 沙箱（`sandbox-shim.ts`）**：凡含 `<style>` / `<script>` / `<!DOCTYPE` / `on*=` 的正则输出一律隔离进自适应高度 `<iframe sandbox="allow-scripts" srcDoc>`，彻底杜绝样式串扰与 `new Function` CSP 拦截；内置 `TavernHelper`（含 `replaceVariables`/`insertOrAssignVariables`/`updateVariablesWith`/`getLastMessageId`/`triggerSlash`）、`SillyTavern.getContext()`、轻量 `_`（lodash）与 `toastr`，并支持选项按钮点击直发及 MVU 变量双向回写。
  - 解除底部内置选项条强绑定：`story-writer.md` 不再要求模型拆填 `options`，`story_commit_turn` 若未传 `options` 自动清空 `latestOptions` 避免换预设后残留旧选项。
- **净室 MVU Zod & EJS 引擎现状（`mvu-engine.ts` + `ejs-engine.ts` + `MvuZodRuntimeHost.tsx` + `sandbox-shim.ts`）**：
  - **100% 独立净室重写**，不复制任何第三方社区插件源码，零 AGPL 传染；
  - **EJS（ST-Prompt-Template）**：内置真实 `ejs` 渲染，支持 `<% %>`、`<%- %>`、`@@preprocessing`、`getvar`、`setvar`、`getwi`、`getchar`、`stat_data` 与 `_`；
  - **真·通用 MVU Zod 运行时**：
    - 后端 [mvu-engine.ts](file:///d:/GeminiWorkX/AAA1/TavernInAGY/src/core/mvu-engine.ts) 支持 `[initvar]` 初始化、开场白内嵌 `<update>` 初始补丁、`<json_?patch>`（RFC 6902 `replace`/`add`/`remove`）与 `_.set`/`_.assign`/`_.unset`/`_.add`，全程强制 `_` 前缀只读保护；
    - 前端通过 npm 别名引入正版 **`zod4`（Zod v4）**（与后端 MCP SDK 的 `zod v3` 互不冲突）与正版 **`lodash-es`**，经侧边栏挂载到隔离沙箱 `window.z` 与 `window._`，零外网 CDN 依赖；
    - 静默后台宿主 [MvuZodRuntimeHost.tsx](file:///d:/GeminiWorkX/AAA1/TavernInAGY/src/ui/MvuZodRuntimeHost.tsx) 自动运行当前激活卡/预设的助手脚本（自动剥离外网 CDN `import 'https://...'` 行并支持顶层 `await`），完整支持 `registerMvuSchema(schema | () => schema)`、`Mvu`（`events`/`getMvuData`/`replaceMvuData`/`setMvuVariable`/`getRecordFromMvuData`）、`getAllVariables()`、`setChatMessages`（含 `swipe_id` 与 `data.stat_data` 写回）及 `eventOn` + `document` `CustomEvent` 双发事件生命周期。
- **多开场白、大卡导入与阅读器体验（v0.7.5）**：
  - **大卡无上限导入**：[png-unpack.ts](file:///d:/GeminiWorkX/AAA1/TavernInAGY/src/ui/png-unpack.ts) 在浏览器本地解包 PNG `tEXt`/`iTXt` 并用 `<canvas>` 压出 `160px` 轻量缩略图，超过 `384 KB` 自动走 `story_app_upload_chunk` 分片上传；`buildBootstrapPayload()` 仅下发激活卡大字段并对旧版超大头像设总预算，杜绝 4 MB IPC 超限；
  - **多开场白与交互跳转**：解析 V2/V3 `alternate_greetings`，`#0` 开场白右下角提供 `‹ 1/N ›` 翻页与点击数字直跳，同时兼容卡片内置 `setChatMessages([{ message_id: 0, swipe_id }])` 与 `/swipes-go N` 跳转；切换开场白时同步应用该开局自带的 MVU `<update>` 初始态并同步到 `SessionStart` 提示词；
  - **外链图床 CSP 放行**：`mcp-server.ts` 在 `resources/read` 的 `contents[0]._meta.ui.csp.resourceDomains` 实时返回过滤后的合法图床域名（自动排除 `https://...` 等占位符），沙箱内置 `<meta name="referrer" content="no-referrer" />`；
  - **编辑与性能**：每层（含 `#0` 开场白与 `#1..#N` 正文）右上角常驻小铅笔编辑按钮；默认仅渲染最近 **10 楼**（可在设置中按 `2~200` 调整），顶部点击按步长懒加载更早楼层；iframe 高度改为按 `body` 实际可见子元素底部计算，折叠动画后零空白残留；侧边栏挂载 `#send_textarea` / `#send_but` 兼容原版选项脚本填入与直发。
- **宽容单通道交付与实时同步**：
  - `story_commit_turn` 采用全宽容 Zod Schema（所有可选字段支持 `nullish`、数字/字符串互转、`options` 兼容纯字符串数组、`customFields` 兼容任意值），杜绝因小字段格式微差报错导致模型整篇正文重写；返回精简 `delta: true` 载荷避免膨胀对话轨迹。
  - `story-writer.md` 与 `story-director.md` 均明文内联 `story_commit_turn` 精确调用签名，并严格禁止动笔前调用 `story_get_state` / `story_search_lorebook` 或读 schema `.json`，大幅压缩单轮延迟。
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

1. **单条 Hook `systemMessage` 约 24 KB 截断上限（单脚本 stdout 总长无 24 KB 限制）**：
   - 截断仅作用于 `injectSteps` 数组内单条元素，而非整个 Hook 的 stdout。**统一通过 `splitIntoInjectChunks(text, 20480)` 在单次进程内输出多条 20 KB 分块**（已实测 25 块 / 500 KB / 18.7 万 token 零截断、耗时 <1s）。
2. **Subagent 钩子与工具特性**：
   - `invoke_subagent` 拉起的子智能体 **只触发 `SessionStart`，不触发 `PreInvocation`**，且可直接通过 `call_mcp_tool` 调用 MCP 工具。
   - 插件 Custom Agent 默认**不具备** `invoke_subagent` / `manage_subagents` 工具，必须像 `story-director.md` 一样在 frontmatter 显式声明 `tools: [invoke_subagent, manage_subagents, send_message]`。
   - **切换 Agent 方式**：Antigravity **不存在 `/agents` 斜杠命令**，切勿在文档或 UI 中误导用户；正确操作是在新建对话窗口时，通过输入框下方的 **Agent 选择器** 切换 `story-director` 或 `story-writer`。
3. **Subagent 模型档位限制**：
   - `invoke_subagent.Model` 与 Agent frontmatter 的 `model:` **只接受 4 个抽象枚举**：`inherit` / `flash_lite` / `flash` / `pro`，无法填具体模型代号（如 `4 neon`、`4 hydrogen`）。
   - 若想实现「导演用 `4 hydrogen` + 写手用强模型」，只能主窗口左下角手动选 `4 hydrogen` 并让导演派发时传 `Model: "pro"`（具体 `pro` 档映射哪款模型以客户端实测为准）；若要精确锁定 `4 neon` / `4 carbon`，则主窗口选目标模型并保持 `Model: "inherit"`。
4. **空白欢迎页（Welcome back）无 `message` 能力**：
   - 当左侧还是新窗口欢迎页、未发送过任何消息时，没有 `owning conversation`，宿主下发给侧边栏的 `hostCapabilities` 不含 `message`（输入框会禁用）；先在左侧发第一句建立对话后刷新/重开侧边栏即可解锁。
5. **共享 Session 与 Conversation Session 同步**：
   - MCP Server 写入的 `state` 与 `statData` 存在 `sessions/default.json`，而 Hook 按 `payload.conversationId` 读写。Hook 必须先从 `default` 同步最新 `state` 与 `statData`；且 `PreInvocation` 必须跳过 `/^\/[a-z0-9_-]+(?:\s|$)/i` 斜杠命令，避免输入 `/story-engine` 或 `/compact` 触发全量注入。
6. **AGY 1 MiB 轨迹上限与头像/内嵌世界书元信息**：
   - 模型工具返回体必须调用 `buildBootstrapPayload({ omitAvatars: true })` 控制体积，但**必须保留 `embeddedLorebookEntries` 轻元信息**，否则 UI 合并状态时会把角色卡内嵌世界书冲成 `0/N` 无法展开。
7. **Windows / 环境约束**：
   - Windows PowerShell 5.1 不支持 `&&`，串联命令必须用 `; if ($LASTEXITCODE -eq 0) { ... }`。
   - 复杂一次性脚本避免在 PowerShell 里用 `node -e`（引号会被吞），请写临时 `.mjs` 脚本。
   - MCP App 沙箱禁 `localStorage`/`IndexedDB`，所有持久化必须走 `app.callServerTool()`；UI 有意不调用 `applyHostStyleVariables()`，保持暖墨衬线书卷主题。

8. **v0.7.3 两轮深度自审已彻底修掉的 10 处暗坑（切勿回退）**：
   - 50 楼以后轮询卡死 → 改为比对最新楼层 `turnId`（不再比对 `length`）；
   - 连发相同短句（如“继续”）吞握手信号 → 仅当明确 `invocationNum > 1` 时才同轮去重；
   - Windows 滑块并发写盘锁冲突 → 滑块本地即时预览+松手落盘，`writeJsonAtomic` & `rewrite` 加随机后缀防 rename 冲突；
   - 导演 60s TTL 过短 → 放宽至 5 分钟；模型漏传 `userMessage` → `PreInvocation` 兜底补齐；
   - 沙箱高度 820px 截断 → 放宽至 1600px；删当前激活卡残留状态 → 同步清空 `state`/`statData`；
   - 外层 `<div>` 包裹 `<details>` 被劈断 → `hasUnclosedContainerTag` 保护容器完整性；
   - PowerShell 双引号内 `$1` 会被展开为空变量 → 禁止在 PowerShell 双引号 `node -e` 里写正则 `$1` 替换。

9. **v0.7.5 新增避坑铁律（切勿回退）**：
   - **MCP App CSP 必须挂在 `resources/read` 的 `contents[0]._meta.ui.csp`**，仅挂在 `server.resource()` 注册元数据上会被宿主忽略导致所有外链图床被 `default-src 'none'` 拦截；
   - **大 PNG 角色卡严禁整图 Base64 单次直传**，必须走 `png-unpack.ts` 本地解包 + 缩略图压缩 + `story_app_upload_chunk` 384 KB 分片上传，且 `callTool` 必须拦截 `res.isError` 杜绝假报成功；
   - **iframe 折叠缩高不可用 `document.documentElement.scrollHeight`**（它不会小于当前 iframe 视口高度），必须按 `body` 实际可见子元素的 `getBoundingClientRect().bottom` 计算；
   - **`styles.css` 中 `.story-prose` 不得重复硬编码 `font-size` / `line-height`**，必须统一绑定 `--prose-font-size` 与 `--prose-line-height`。

---

## 5. 下一步规划与待办路线图

1. **【v0.8.0 核心计划】正文摘要 / 剧情压缩模块（Story Summary & Compression）**：
   - **目标**：在已支持 15 万上下文（500 KB / 20 KB 分块）的基础上，解决长篇演绎（尤其是导演模式每轮全量重拼）Token 消耗随楼层线性增长的问题，同时统一承载「历史上下文预算 / 保留完整正文楼层数」设置。
   - **设计思路**：
     - 在 `StoryLogStore` / `SessionRuntime` 增加分层记忆结构：`pinnedSummary`（阶段性大总结）+ 最近 `N` 楼完整正文（如保留最近 6～10 楼原汁原味，更早楼层替换为精炼摘要）；
     - 支持自动提取预设自带的 `<wave_summary>` / `<summary>` 标签存入每楼 `turn.summary`，并支持在侧边栏手动编辑或一键触发「整理阶段大总结」；
     - `formatForForkResume` 在注入历史楼层时，对超过阈值深度的旧楼层自动输出 `turn.summary` 而非数千字全文，大幅省额度同时保持长期记忆不丢。
2. **导演与写手异构模型配对实测（按用户需求）**：
   - 若用户需要，可在 `story-director` 配置中增加可切换的派发档位（`inherit` vs `pro`），方便主窗口选 `4 hydrogen` 搭配 `pro` 档写手实测路由。

---

## 6. Git 版本里程碑

- `v0.1.0` ~ `v0.7.2`：核心引擎 → AGY Hooks/MCP → 暖墨单文件阅读器 → 真 MVU/EJS → 正则三路渲染 → 单窗口导演模式 + 12 KB 分块防截断
- `v0.7.3`：默认开启导演模式 + 全链路中性命名（`story_*` / `story-director` / `story-writer` / `story-engine`）+ 真·通用无硬编码渲染管线 + `getCurrentMessageId`/范围 `getChatMessages`/`/setinput` 沙箱垫片 + 外观与页面尺寸调节 + Author's Note + 无损多周目存档 + 手动填回式 `↻ 重Roll本楼` + 两轮 10 处深水区修复 + 隐私清洗与公开 `README.md`
- `v0.7.4`：单进程 20 KB 分块（500 KB / 18.7 万 token 实测零截断）+ 15 万上下文动态历史预算 + Apache-2.0 协议与净室独立实现声明
- `v0.7.5`（当前）：大卡 PNG 前端解包 + 384 KB 分片上传 + 真·通用 MVU Zod v4 / 完整 `lodash-es` 后台常驻沙箱（`registerMvuSchema` 工厂函数、`Mvu.events` 双发、`getAllVariables`、`setChatMessages`）+ 多开场白翻页/直跳/初始态补丁 + `resources/read` 动态外链图床 CSP + 每层小铅笔编辑 + 10 楼分页懒加载 + 卡片/预设脚本独立开关 + iframe 折叠精准缩高与 `#send_textarea`/`#send_but` 桥接
