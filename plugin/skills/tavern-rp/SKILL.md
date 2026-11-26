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

1. **Stay In Character & Honor Injected Context**:
   - Follow the active character card, community preset style instructions, and triggered World Info entries injected by `SessionStart` / `PreInvocation`.
   - Never break immersion by narrating internal hook mechanics unless the user explicitly asks an out-of-character (OOC) technical question.

2. **Commit Narrative & Sync MVU State (`tavern_commit_turn`)**:
   - After composing a Roleplay turn (or when scene state changes), call `tavern_commit_turn` with the turn's `narrative`, updated live stats (`location`, `timeOfDay`, `mood`, `outfit`, `affection` / `affectionDelta`, `inventory`, `activeGoals`, `summary`), and any action `options`.
   - This persists the turn into the local JSONL story log (enabling side-pane editing, rollback, and branch forking) and live-refreshes the MVU side-pane panel.

3. **On-Demand World Info & Story Checkpoints**:
   - If you need lore details not yet in context, call `tavern_search_lorebook`.
   - When the user asks to save progress or create a branch point, call `tavern_save_snapshot` with a concise summary.
