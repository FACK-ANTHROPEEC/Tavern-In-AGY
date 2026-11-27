# TavernInAGY

> **Interactive Fiction & Character-Card Roleplay Studio Plugin for Google Antigravity**
>
> 基于 Antigravity 官方原生扩展体系（MCP Apps + Local MCP Server + Lifecycle Hooks + Custom Agents + Skills）构建的本地互动小说与角色扮演创作侧边栏插件。

---

## ⚠️ 合规声明与免责叠甲 / Compliance & Disclaimer（使用前必读）

在使用、二次开发或分发本项目前，请务必完整阅读并严格遵守以下条款：

1. **100% 官方原生扩展路径（零修改客户端、零反代、零凭据抽取）**
   - 本项目仅使用 Antigravity 官方公开文档支持的插件扩展面（`plugin.json`、`mcp_config.json`、`hooks.json`、SEP-1865 MCP Apps `ui://`、Custom Agents、Skills）。
   - 本项目**不包含**任何逆向工程、内存注入、网络抓包、API 反向代理、OAuth/Cookie/Token 提取、客户端二进制修改或未公开私有接口调用。
2. **严禁作为第三方 Agent 中继器（Non-Relay / Non-Harness）**
   - 本项目**绝对不是**第三方编程代理（如外部 Agent、外部自动化脚本）的中继器或算力封装（Wrapper/Relay/Harness）。
   - 本项目**不使用** `Stop` / `PostInvocation` 无人自动续跑循环，不包含任何后台定时刷量、并发批处理、GUI 模拟点击或非人类自动化交互逻辑。每一轮交互均由用户本人在界面中手动触发、阅读与确认。
3. **不提供、不内置、不支持任何安全绕过机制**
   - 本项目是纯粹的**本地互动小说排版、角色卡片解析、世界观词条检索、状态追踪与多周目存档管理工具**。
   - 本仓库**不内置任何角色卡、风格预设或世界书内容**，亦**绝不提供、不承诺、不鼓励任何形式的内容安全绕过、越狱或覆盖系统指令的做法**。
4. **用户责任与服务条款（ToS）提醒**
   - 用户须自行确保所导入的本地角色卡、提示词预设与世界书内容完全合法合规，并严格遵守 **Google Antigravity 服务条款与附加服务条款**。
   - 本项目按“现状（AS-IS）”开源提供，作者不对用户因导入第三方提示词、违规内容或高频滥用导致的任何账号限制、风控或损失承担责任。请保持合理、正常的人类创作与阅读节奏。

---

## ✨ 核心特性

- **暖墨书卷风侧边栏阅读器（MCP App）**：
  - 独立右侧暖墨衬线阅读器，主聊天框仅显示 1 行极简楼层索引，正文、折叠思考链与状态卡片全部在侧边栏沉浸呈现；
  - 支持自由调节 **页面整体缩放（80%~130%）**、**正文字号**、**行距** 与 **书卷居中版心宽度**。
- **单窗口导演模式（`story-director` · 默认开启）**：
  - 主窗口作为零污染轻量调度器，每轮自动派发全新干净的 `story-writer` 子智能体全量重拼上下文落笔，完成后即刻清理，彻底告别左侧多会话刷屏；
  - 支持随时在侧边栏编辑任意楼层、回滚重 Roll、切换周目或角色卡，下一轮立即 100% 无缝生效。
- **通用角色卡片、预设、世界书与正则引擎**：
  - 支持导入标准 PNG（V2/V3 元数据）与 JSON 角色卡、多段式风格预设、外部与内嵌世界书（主/次关键词、正则、递归、冷却去重）；
  - 完整支持嵌套宏、EJS 模板渲染、变量树（`[initvar]` + RFC 6902 JSON Patch）与 **作者注释（Author's Note）**；
  - **通用无硬编码渲染管线**：严格优先执行预设与角色卡自带的展示正则，含 `<style>` / `<script>` 的美化卡片自动隔离进 CSP 安全的自适应 `iframe` 沙箱，未匹配正则的残留自定义标签自动折叠不污染正文。
- **无损多周目存档**：
  - 每张角色卡支持创建多个独立聊天存档（周目），点 **`+ 新周目`** 绝不删除旧记录，随时可一键切回任意历史周目继续演绎。

---

## 🚀 快速安装（适用于所有 Antigravity 用户）

> **给 AI 助手（Antigravity Agent）的安装说明**：  
> 本插件是标准的本地目录插件（非 Marketplace 远端包）。请直接克隆到固定目录（建议 `~/Tavern-In-AGY`）并顺序执行下方 3 步命令。`npm run install:plugin` 会将编译产物放入 `~/.gemini/config/plugins/tavern-in-agy`，Antigravity 会**自动发现并默认启用**该本地插件，**无需调用任何受限的 Language Server RPC（如 `InstallCustomization` / `JetboxWriteState`），也无需修改 `~/.gemini/config/config.json`**。

### 前置要求
- 已安装 **Node.js 18+**（推荐 20+）与 **Git**
- 已安装 **Google Antigravity** 最新版

### 3 步安装

```bash
# 1. 克隆仓库（建议放在固定目录，方便后续 git pull 更新）
git clone https://github.com/FACK-ANTHROPEEC/Tavern-In-AGY.git
cd Tavern-In-AGY

# 2. 安装依赖并构建前后端
npm install
npm run build

# 3. 一键安装至 Antigravity 全局插件目录 (~/.gemini/config/plugins/tavern-in-agy)
npm run install:plugin
```

安装完成后：
1. 若当前 AGY 窗口尚未识别到新插件，重启一次 Antigravity 或在 Customizations 页面刷新一下 `tavern-in-agy` 即可；
2. 点击侧边栏或调用 `story_open_panel` 打开右侧创作面板，在「角色」「预设」「世界书」页导入你的本地文件；
3. 新建对话时，在输入框下方的 **Agent 选择器** 中切换至 **`story-director`**（单窗口导演模式），先在左侧发第一句开场指令建立会话，随后即可全程在右侧暖墨阅读器直接畅聊。

---

## 🔄 后续更新

```bash
cd Tavern-In-AGY
git pull
npm install
npm run build
npm run install:plugin
```

更新后在 Antigravity 的 **MCP Servers** 设置中点一下刷新 `tavern-in-agy`，并重开右侧边栏即可生效。

---

## 🧪 开发与测试

```bash
npm test            # 运行全部 Vitest 单元测试
npm run build       # 构建后端 TypeScript 与单文件前端 UI
npm run install:plugin
```

更多架构细节与维护说明请参见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## 🙏 致谢与生态参考

本项目核心引擎为独立净室实现，仅兼容公开的数据格式与接口约定，特向以下社区项目与开放标准致谢：

- **SillyTavern**
- **MagVarUpdate (MVU)**
- **ST-Prompt-Template (EJS)**
- **JS-Slash-Runner**
- **Model Context Protocol (MCP / MCP Apps)**

---

## 📄 开源协议与商标声明

本项目基于 [Apache License 2.0](./LICENSE) 开源。

本项目为独立净室实现（Clean-room Implementation），仅兼容社区公开的角色卡、预设、JSON Patch 与模板数据格式规范，不包含任何第三方项目的源代码，亦与 Antigravity 或任何第三方社区项目无隶属或官方背书关系。所有第三方名称、格式规范及商标均归其各自所有者所有。
