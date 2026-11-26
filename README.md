# TavernInAGY

将 SillyTavern 核心 Roleplay 体验以 **Antigravity 原生插件（MCP App + Local MCP Server + Lifecycle Hooks + Skill）** 的形式迁移至 Antigravity，零反代、零凭据抽取、开箱兼容酒馆社区生态。

## 核心特性

- **原生合规架构**：全部对话运行于 Antigravity 原生会话流，采用官方公开的 MCP Apps（SEP-1865）与 `hooks.json` 生命周期钩子。
- **ST 角色卡兼容**：支持导入原版 SillyTavern PNG（V2 `chara` / V3 `ccv3` `tEXt` 数据块）与 JSON 角色卡。
- **ST 社区预设兼容**：完整解析 `prompts` + `prompt_order`、空内容分组手风琴开关、嵌套多行宏（`setvar` / `getvar` / `random` / `//` / `char` / `user`）、`extensions.regex_scripts`，并自动以 `chatHistory` 为界切分为「开局静态段」与「近因锚点段」。
- **ST 世界书引擎 + AGY 冷却去重**：复刻常驻条目、主/次关键词与正则触发、递归扫描、`scan_depth`、优先级排序与预算截断，并针对 AGY 追加式上下文增加「冷却去重窗口」，避免重复注水。
- **右侧边栏可视化控制台**：内嵌于 Antigravity 侧边栏（`aux_pane`），支持导卡/导预设/导世界书、预设模块一键开关、实时状态栏与快捷行动选项点击。

## 文档与开发

- 项目级架构与开发文档：[docs/DESIGN.md](./docs/DESIGN.md)

## 快速开始

```bash
npm install
npm test
npm run build
npm run install:plugin
```
