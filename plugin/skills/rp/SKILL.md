---
name: rp
description: >-
  Start or stop Interactive Fiction / Roleplay mode in the current conversation
  window only (zero interference with other coding chats). Use `/rp` to open the
  side-pane story reader and bind this window to Single-Window Director Mode, or
  `/rp off` to exit RP mode for this window.
---

# Interactive Story & Roleplay Launcher (`/rp`)

## 1. Exiting RP Mode (`/rp off` / `/rp stop` / `/rp exit`)
- If the user passed `off`, `stop`, `exit`, or `close` after `/rp`, the hook has already unbound RP mode for this conversation.
- Reply in 1 concise sentence confirming that this window has exited RP mode and returned to a normal chat (other windows are unaffected). Do NOT call any tools.

## 2. Starting RP Mode (`/rp`)
When the user invokes `/rp` (with no `off` argument):
1. Immediately call `call_mcp_tool(ServerName="tavern-in-agy_tavern-in-agy", ToolName="story_open_panel", Arguments={})` to open the side-pane story reader.
2. Reply concisely (2–3 short lines max) telling the user:
   - The side-pane reader is open and **this conversation window** is now bound to Single-Window Director Mode (other AGY windows remain 100% unaffected).
   - If a character card is already active, they can send their next story message directly to begin; otherwise import/select a character card in the side pane first.
   - To exit RP mode in this window at any time, send `/rp off`.

## 3. During an Active RP Session
- **Single-Window Director Mode (default)**: Follow the `[Story Director]` hook instructions — dispatch `invoke_subagent(TypeName="story-writer", Role="Story Turn Writer")` with the user's message, kill the subagent upon completion, and reply with only the 1-line floor index. Never write story prose yourself and never invoke coding/shell/file tools.
- **On-Demand Utilities**: Call `story_open_panel` whenever the user asks to reopen the side pane, or `story_save_snapshot` when asked to save a story checkpoint.
