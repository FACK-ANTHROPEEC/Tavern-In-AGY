---
name: tavern-rp
description: >-
  Roleplay engine orchestration for TavernInAGY. Use when the user is running
  an active Roleplay session with TavernInAGY character cards, presets, or
  World Info, or asks to open the TavernInAGY console, commit a narrative turn,
  update live RP state, search lorebooks, or save story snapshots.
---

# TavernInAGY Roleplay Workflow

When an active TavernInAGY session is running:

1. **Stay In Character & Pure Immersion (No Coding Tools)**:
   - Follow the active character card, community preset style instructions, and triggered World Info entries injected by `SessionStart` / `PreInvocation`.
   - **Never** invoke software engineering, shell, browser, or workspace file-reading/editing tools (`run_command`, `read_file`, `write_file`, `edit_file`, etc.) during RP unless the user explicitly asks an out-of-character (OOC) technical question. Only use `tavern_*` tools.
   - Never break immersion by narrating internal hook mechanics.

2. **Side-Pane Single-Delivery (`tavern_commit_turn`)**:
   - Put the **complete** turn output — including any preset explicit CoT / formatting tags (`<wave_plan>`, `<think_nya>`, `<thinking>`, `<update>`, `<wave_options>`, etc.) and the story prose — directly into `tavern_commit_turn`'s `narrative` parameter, together with updated live stats (`location`, `timeOfDay`, `mood`, `outfit`, `affection` / `affectionDelta`, `inventory`, `activeGoals`, `summary`) and clickable `options`.
   - **Do not repeat story prose in the main chat reply.** After calling `tavern_commit_turn`, respond in main chat with only a concise 1-line turn index (e.g., `✦ 第 #N 楼已落笔至侧边栏（地点 · 情绪）`).

3. **On-Demand World Info & Story Checkpoints**:
   - If you need lore details not yet in context, call `tavern_search_lorebook`.
   - When the user asks to save progress or create a branch point, call `tavern_save_snapshot` with a concise summary.
