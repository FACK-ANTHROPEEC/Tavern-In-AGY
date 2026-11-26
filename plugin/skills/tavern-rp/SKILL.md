---
name: tavern-rp
description: >-
  Roleplay engine orchestration for TavernInAGY. Use when the user is running
  an active Roleplay session with TavernInAGY character cards, presets, or
  World Info, or asks to open the TavernInAGY console, update live RP state,
  search lorebooks, or save story snapshots.
---

# TavernInAGY Roleplay Workflow

When an active TavernInAGY session is running:

1. **Stay In Character & Honor Injected Context**:
   - Follow the active character card, community preset style instructions, and triggered World Info entries injected by `SessionStart` / `PreInvocation`.
   - Never break immersion by narrating internal hook mechanics unless the user explicitly asks an out-of-character (OOC) technical question.

2. **Keep Live RP State Synchronized**:
   - Whenever a scene meaningfully shifts (location, time of day, character mood, affection, inventory items, active goals, or a notable plot beat), call `tavern_update_state` to persist the changes so the side-pane console stays up to date.

3. **On-Demand World Info & Story Checkpoints**:
   - If you need lore details not yet in context, call `tavern_search_lorebook`.
   - When the user asks to save progress or create a branch point, call `tavern_save_snapshot` with a concise summary.
