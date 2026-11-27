import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TavernStorage } from '../core/storage.js';
import {
  assemblePreInvocation,
  assembleSessionStart,
  hashText,
  splitIntoInjectChunks,
} from '../core/prompt-assembler.js';
import { applyMvuUpdates } from '../core/mvu-engine.js';
import { StoryLogStore, resolveStoryKey } from '../core/story-log.js';
import { extractWaveOptions, readLastUserInputStamp, readRecentTranscriptTexts } from './transcript-reader.js';
import type { Lorebook } from '../core/types.js';
import type { HookOutput } from './hook-session-start.js';

export interface PreInvocationInput {
  conversationId?: string;
  lastUserInput?: string;
  transcriptPath?: string;
  invocationNum?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function handlePreInvocation(
  payload: PreInvocationInput,
  storage = new TavernStorage(),
): HookOutput {
  const config = storage.getConfig();

  const lastUserInput = (payload.lastUserInput ?? '').trim();
  if (!lastUserInput) {
    return {};
  }

  const convId = payload.conversationId || 'default';

  // `/rp` / `/rp off` per-conversation binding: activates RP ONLY for this conversation window
  // (even before a card is selected), leaving all other normal AGY chats 100% untouched.
  const rpCmdMatch = /^\/rp(?:\s+(.*))?$/i.exec(lastUserInput);
  if (rpCmdMatch) {
    const arg = (rpCmdMatch[1] ?? '').trim().toLowerCase();
    const session = storage.getSession(convId);
    if (arg === 'off' || arg === 'stop' || arg === 'exit' || arg === 'close') {
      session.rpModeActive = false;
      storage.saveSession(session);
    } else {
      session.rpModeActive = true;
      storage.saveSession(session);
      if (!config.enabled) {
        storage.saveConfig({ enabled: true });
      }
    }
    return {};
  }

  // Skip other slash commands (e.g. /compact, /plan) so invoking a skill or command never triggers RP injection
  if (/^\/[a-z0-9_-]+(?:\s|$)/i.test(lastUserInput)) {
    return {};
  }

  if (!config.enabled || !config.activeCardId) {
    return {};
  }

  const card = storage.getCard(config.activeCardId);
  if (!card) {
    return {};
  }

  const session = storage.getSession(convId);
  const shared = convId === 'default' ? session : storage.getSession('default');

  // Sync latest live state & MVU statData written by MCP server ('default' shared store)
  if (convId !== 'default') {
    session.state = { ...session.state, ...shared.state };
    session.statData = { ...(shared.statData ?? {}) };
  }

  // In Director Mode, story-writer subagent sessions are unlocked by SessionStart and marked `isWriterSubagent`.
  // Never inject [Story Director] prompts into the writer itself or overwrite shared dispatch fields.
  if (config.directorMode && session.isWriterSubagent) {
    return {};
  }

  // Per-conversation isolation: only conversations explicitly bound via `/rp` (or a freshly forked branch / stateless turn) run RP hooks.
  // Normal AGY coding/Q&A windows remain 100% untouched even while the global switch is enabled.
  const pendingForkPeek = storage.peekPendingFork();
  if (!session.rpModeActive && pendingForkPeek && pendingForkPeek.cardId === card.id) {
    session.rpModeActive = true;
    storage.saveSession(session);
  }
  if (!session.rpModeActive && (config.directorMode || !config.statelessPerTurn)) {
    return {};
  }

  // Deduplicate multiple model invocations ONLY within the SAME user turn (explicit invocationNum > 1),
  // so sending the same short message (e.g. "继续") across consecutive turns never drops pendingDirectorInput.
  const inputHash = hashText(lastUserInput);
  if (
    session.lastUserInputHash === inputHash &&
    typeof payload.invocationNum === 'number' &&
    payload.invocationNum > 1
  ) {
    return {};
  }

  // Director Mode: main window acts as a lightweight dispatcher (story-director) and spawns a fresh
  // story-writer subagent per turn. Never inject RP prose/lore into the main window; cache the user input
  // with a 5-min TTL so the spawned story-writer subagent's SessionStart unlocks and injects full context.
  if (config.directorMode) {
    const currentUserStepStamp = readLastUserInputStamp(payload.transcriptPath);
    const hasFreshStagedInput =
      Boolean(shared.stagedSidePaneInput) &&
      Date.now() - (shared.stagedSidePaneInputAt ?? 0) <= 300_000;

    // 1. Exact same-turn deduplication via transcript USER_INPUT step stamp:
    // suppresses ALL follow-up PreInvocation calls within the same user turn
    // (after invoke_subagent, on subagent wakeup, and after manage_subagents kill)
    // without ever touching staged/pending writer input.
    if (currentUserStepStamp && session.lastDispatchedUserStep === currentUserStepStamp) {
      if (shared.directorTurnState === 'committed') {
        shared.directorTurnState = 'idle';
        storage.saveSession(shared);
      }
      return {};
    }

    // 2. Exact same-stage deduplication: if this exact side-pane staged input was already dispatched
    // (e.g. Call 2 after invoke_subagent returns, BEFORE writer SessionStart consumes it), return {} immediately!
    if (
      hasFreshStagedInput &&
      shared.stagedSidePaneInputAt !== undefined &&
      session.lastDispatchedStagedAt === shared.stagedSidePaneInputAt
    ) {
      return {};
    }

    // 3. Fallback same-turn deduplication when transcriptPath is absent:
    // - While directorTurnState === 'dispatched' with same inputHash (even if SessionStart has NOT yet
    //   consumed pendingDirectorInput!), return {} immediately so follow-up tool calls NEVER overwrite
    //   staged input or inject duplicate router prompts.
    // - On reactive wakeup after commit or post-commit kill-tool return (within 30s and no fresh stage),
    //   return {} cleanly.
    const sameInputAsLast = session.lastUserInputHash === inputHash;
    if (sameInputAsLast && !hasFreshStagedInput) {
      if (shared.directorTurnState === 'dispatched') {
        if (!shared.pendingDirectorInput) {
          // Writer already claimed pendingDirectorInput and exited without committing -> reset to idle
          shared.directorTurnState = 'idle';
          storage.saveSession(shared);
        }
        return {};
      }
      if (shared.directorTurnState === 'committed') {
        shared.directorTurnState = 'idle';
        storage.saveSession(shared);
        return {};
      }
      if (
        shared.directorCommittedAt &&
        Date.now() - shared.directorCommittedAt <= 30_000
      ) {
        return {};
      }
    }

    // OOC panel-open request inside an active RP window -> open reader directly without dispatching a writer
    if (
      /^(?:帮我|请)?(?:打开|呼出|显示|重开|开启).*(?:侧边栏|面板|阅读器)|^open\s+(?:the\s+)?(?:side[- ]?pane|panel|reader)\b/i.test(
        lastUserInput,
      )
    ) {
      session.lastUserInputHash = inputHash;
      session.lastDispatchedUserStep = currentUserStepStamp ?? undefined;
      storage.saveSession(session);
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage:
                '[Story Director · OOC] The user is asking to open the side-pane story reader. Call call_mcp_tool(ServerName="tavern-in-agy_tavern-in-agy", ToolName="story_open_panel", Arguments={}) directly. Do NOT dispatch story-writer.',
            },
          },
        ],
      };
    }

    // Direct channel: if side-pane staged the real input, NEVER delete or overwrite it here—
    // SessionStart is the sole consumer of stagedSidePaneInput/pendingDirectorInput, and
    // story_commit_turn is the sole consumer of lastUserInputForCommit.
    if (hasFreshStagedInput) {
      const staged = shared.stagedSidePaneInput!;
      shared.pendingDirectorInput = staged;
      shared.pendingDirectorInputAt = shared.stagedSidePaneInputAt ?? Date.now();
      shared.lastUserInputForCommit = staged;
    } else {
      shared.pendingDirectorInput = lastUserInput;
      shared.pendingDirectorInputAt = Date.now();
      shared.lastUserInputForCommit = lastUserInput;
    }

    shared.directorTurnState = 'dispatched';
    shared.directorCommittedAt = undefined;
    session.lastUserInputHash = inputHash;
    session.lastDispatchedUserStep = currentUserStepStamp ?? undefined;
    session.lastDispatchedStagedAt = hasFreshStagedInput ? shared.stagedSidePaneInputAt : undefined;
    storage.saveSession(shared);
    if (convId !== 'default') {
      storage.saveSession(session);
    }
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              '[Story Director · Turn Router] You act as a lightweight turn dispatcher for the local interactive fiction side-pane. The current turn context and input have already been prepared locally for the writer subagent via SessionStart. Please delegate this turn by calling invoke_subagent(TypeName="story-writer", Role="Story Turn Writer", Prompt="Handle the current story turn using your SessionStart context and commit via story_commit_turn."), wait for completion, clean up the subagent, and reply concisely with only the 1-line floor index returned by the subagent.',
          },
        },
      ],
    };
  }

  // Non-director same-turn deduplication via transcript USER_INPUT step stamp
  // prevents a 2nd PreInvocation injection right after story_commit_turn returns within the same user turn.
  const nonDirectorUserStep = readLastUserInputStamp(payload.transcriptPath);
  if (nonDirectorUserStep && session.lastDispatchedUserStep === nonDirectorUserStep) {
    return {};
  }

  const preset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
  const lorebooks: Lorebook[] = config.activeLorebookIds
    .map((id) => storage.getLorebook(id))
    .filter((b): b is Lorebook => b !== null);

  // Defensively merge transcript texts with local recentMessages cache
  const transcriptTexts = readRecentTranscriptTexts(payload.transcriptPath, 30);
  const latestOptions = extractWaveOptions(transcriptTexts);
  if (latestOptions.length > 0) {
    session.latestOptions = latestOptions;
  }

  // If the previous assistant message emitted `<update>` / `<UpdateVariable>` in plain text, apply it to MVU statData
  const lastText = transcriptTexts[transcriptTexts.length - 1];
  if (lastText && /<update(?:variable)?>/i.test(lastText)) {
    const mvuRes = applyMvuUpdates(session.statData, lastText);
    if (mvuRes.appliedCount > 0) {
      session.statData = mvuRes.statData;
    }
  }

  const nextRecent = [...session.recentMessages, lastUserInput].slice(-20);
  const scanMessages = transcriptTexts.length > 0
    ? [...transcriptTexts.slice(-10), lastUserInput]
    : nextRecent;

  // Fallback: if SessionStart was missed (e.g. user selected card/preset after opening the window,
  // or switched cards mid-session), inject the full SessionStart bundle right before L2/L3!
  const currentPresetId = preset?.id ?? '';
  let sessionStartPrefix = '';
  if (
    session.sessionStartCardId !== card.id ||
    session.sessionStartPresetId !== currentPresetId
  ) {
    let resumedStoryBlock = '';
    const storyLog = new StoryLogStore(storage.rootDir);
    const activeRegexScripts = [
      ...(preset?.regexScripts ?? []),
      ...(card.regexScripts ?? []),
    ];
    const pendingFork = storage.consumePendingFork();
    if (pendingFork && pendingFork.cardId === card.id) {
      session.state = { ...session.state, ...pendingFork.state };
      if (pendingFork.statData) {
        session.statData = { ...pendingFork.statData };
      }
      resumedStoryBlock = storyLog.formatForForkResume(
        pendingFork.turns,
        card.name,
        config.userName || 'User',
        { maxContextTokens: 150_000, memoryPlugin: config.memoryPlugin },
        activeRegexScripts,
      );
    } else {
      const activeSlot = config.activeChatSlots?.[card.id] || 'default';
      const existingTurns = storyLog.readTurns(resolveStoryKey(card.id, activeSlot));
      if (existingTurns.length > 0) {
        resumedStoryBlock = storyLog.formatForForkResume(
          existingTurns,
          card.name,
          config.userName || 'User',
          { maxContextTokens: 150_000, memoryPlugin: config.memoryPlugin },
          activeRegexScripts,
        );
      }
    }

    const startBundle = assembleSessionStart({
      config,
      card,
      preset,
      lorebooks,
      session,
      resumedStoryBlock,
    });
    session.variables = startBundle.variables;
    session.statData = startBundle.statData;
    session.sessionStartCardId = card.id;
    session.sessionStartPresetId = currentPresetId;
    if (config.enablePostHistoryInjection) {
      session.lastPostHistoryTurn = session.turnCount + 1;
    }
    sessionStartPrefix = startBundle.systemMessage;
  }

  const bundle = assemblePreInvocation({
    config,
    card,
    preset,
    lorebooks,
    session,
    recentMessages: scanMessages,
  });

  session.turnCount += 1;
  session.lastUserInputHash = inputHash;
  session.lastDispatchedUserStep = nonDirectorUserStep ?? undefined;
  session.recentMessages = nextRecent;
  session.variables = bundle.variables;
  for (const key of bundle.triggeredLorebookKeys) {
    session.injectedLorebookTurns[key] = session.turnCount;
  }
  if (bundle.injectedPostHistory) {
    session.lastPostHistoryTurn = session.turnCount;
  }
  if (bundle.injectedState) {
    session.lastStateInjectedHash = bundle.stateHash;
  }

  storage.saveSession(session);
  const sharedForCommit = storage.getSession('default');
  sharedForCommit.lastUserInputForCommit = lastUserInput;
  storage.saveSession(sharedForCommit);

  const combinedMessage = [sessionStartPrefix, bundle.systemMessage]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');

  const chunks = splitIntoInjectChunks(combinedMessage, 20480);
  if (chunks.length === 0) {
    return {};
  }

  return {
    injectSteps: chunks.map((chunk) => ({
      systemMessage: {
        systemMessage: chunk,
      },
    })),
  };
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  const payload: PreInvocationInput = raw ? JSON.parse(raw) : {};
  const result = handlePreInvocation(payload);
  process.stdout.write(JSON.stringify(result));
}

const isDirectMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectMain) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({}));
  });
}
