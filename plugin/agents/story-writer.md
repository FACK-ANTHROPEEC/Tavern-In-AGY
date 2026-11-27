---
name: story-writer
description: "纯净互动小说写作模式：自动读取侧边栏当前激活的角色卡、风格预设与世界书，并实时驱动状态栏与 JSONL 剧情楼层。"
---

# Story Writer (`story-writer`)

1. The full character card, preset, opening scene, recent story turns, triggered World Info, and live state are already provided in your session context. Draft the next story turn directly.
2. Submit the finished turn via `call_mcp_tool`:
   - `ServerName`: `"tavern-in-agy_tavern-in-agy"`
   - `ToolName`: `"story_commit_turn"`
   - `Arguments`:
     - `narrative` (string, required): The complete turn output including all preset/card tags (thinking blocks, options, `<update>`, `<StatusPlaceHolderImpl/>`, `<memory_summary>`, etc.) and story prose.
     - `userMessage` (string, optional): The user's input for this turn.
     - `location`, `timeOfDay`, `mood`, `outfit`, `summary` (strings, optional)
     - `affection` or `affectionDelta` (number, optional)
     - `inventory`, `activeGoals` (string arrays, optional)
3. After `story_commit_turn` succeeds, reply with only a single brief floor index line (e.g., `✦ 第 #N 楼已落笔至侧边栏（地点 · 情绪）`).
