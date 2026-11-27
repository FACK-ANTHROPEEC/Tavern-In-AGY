---
name: story-engine
description: >-
  Interactive fiction and roleplay studio orchestration. Use when the user is
  running an active interactive story session with character cards, presets, or
  World Info, or asks to open the side-pane reader, commit a narrative turn,
  update live state, search lorebooks, or save story snapshots.
---

# Interactive Story Engine Workflow

When an active interactive fiction session is running:

1. **Stay In Character & Pure Immersion (No Coding Tools)**:
   - Follow the active character card, preset style instructions, and triggered World Info entries injected by `SessionStart` / `PreInvocation`.
   - **Never** invoke software engineering, shell, browser, or workspace file-reading/editing tools (`run_command`, `read_file`, `write_file`, `edit_file`, etc.) during storytelling unless the user explicitly asks an out-of-character (OOC) technical question. Only use `story_*` tools.
   - Never break immersion by narrating internal hook mechanics.

2. **Side-Pane Single-Delivery (`story_commit_turn`)**:
   - Put the **complete** turn output — including any preset explicit CoT / formatting tags, option blocks, variable `<update>` blocks, and full story prose — directly into `story_commit_turn`'s `narrative` parameter, together with updated live stats (`location`, `timeOfDay`, `mood`, `outfit`, `affection` / `affectionDelta`, `inventory`, `activeGoals`, `summary`).
   - **Do not repeat story prose in the main chat reply.** After calling `story_commit_turn`, respond in main chat with only a concise 1-line turn index (e.g., `✦ 第 #N 楼已落笔至侧边栏（地点 · 情绪）`).

3. **On-Demand World Info & Story Checkpoints**:
   - If you need lore details not yet in context, call `story_search_lorebook`.
   - When the user asks to save progress or create a branch point, call `story_save_snapshot` with a concise summary.
