import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TavernStorage } from '../core/storage.js';
import { assembleSessionStart, splitIntoInjectChunks } from '../core/prompt-assembler.js';
import { StoryLogStore, resolveStoryKey } from '../core/story-log.js';
import type { Lorebook } from '../core/types.js';

export interface SessionStartInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
}

export interface HookOutput {
  injectSteps?: Array<{ systemMessage: { systemMessage: string } }>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function handleSessionStart(
  payload: SessionStartInput,
  storage = new TavernStorage(),
): HookOutput {
  const config = storage.getConfig();

  if (!config.enabled || !config.activeCardId) {
    return {};
  }

  const card = storage.getCard(config.activeCardId);
  if (!card) {
    return {};
  }

  const preset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
  const lorebooks: Lorebook[] = config.activeLorebookIds
    .map((id) => storage.getLorebook(id))
    .filter((b): b is Lorebook => b !== null);

  const convId = payload.conversationId || 'default';
  const session = storage.getSession(convId);
  // Sync latest live state & MVU statData written by MCP server ('default' shared store)
  let pendingDirectorInput = '';
  const shared = convId === 'default' ? session : storage.getSession('default');
  if (convId !== 'default') {
    session.state = { ...session.state, ...shared.state };
    session.statData = { ...(shared.statData ?? {}) };
  }

  // In Director Mode, only the freshly spawned story-writer subagent unlocks when PreInvocation
  // (after verifying rpModeActive) has promoted pendingDirectorInput within the last 5 minutes.
  // Unrelated windows or subagents never unlock from stagedSidePaneInput alone.
  const hasFreshDirectorInput =
    Boolean(shared.pendingDirectorInput) &&
    Date.now() - (shared.pendingDirectorInputAt ?? 0) <= 300_000;
  const pendingForkPeek = storage.peekPendingFork();
  const hasMatchingPendingFork = Boolean(pendingForkPeek && pendingForkPeek.cardId === card.id);

  if (config.directorMode) {
    if (!hasFreshDirectorInput) {
      if (shared.pendingDirectorInput) {
        shared.pendingDirectorInput = undefined;
        shared.pendingDirectorInputAt = undefined;
        storage.saveSession(shared);
      }
      // If the user just clicked "Fork Branch" into a new conversation, bind this window to RP mode
      // so the first message in the forked window dispatches normally.
      if (hasMatchingPendingFork && !session.rpModeActive) {
        session.rpModeActive = true;
        storage.saveSession(session);
      }
      return {};
    }
    pendingDirectorInput = shared.pendingDirectorInput!;
    shared.pendingDirectorInput = undefined;
    shared.pendingDirectorInputAt = undefined;
    shared.stagedSidePaneInput = undefined;
    shared.stagedSidePaneInputAt = undefined;
    storage.saveSession(shared);
    session.isWriterSubagent = true;
  } else {
    if (shared.pendingDirectorInput || shared.stagedSidePaneInput) {
      shared.pendingDirectorInput = undefined;
      shared.pendingDirectorInputAt = undefined;
      shared.stagedSidePaneInput = undefined;
      shared.stagedSidePaneInputAt = undefined;
      storage.saveSession(shared);
    }
    // Non-director isolation: only inject into conversations bound via `/rp`, stateless per-turn mode,
    // or a freshly forked story branch; normal coding windows stay 100% untouched.
    if (hasMatchingPendingFork && !session.rpModeActive) {
      session.rpModeActive = true;
    }
    if (!session.rpModeActive && !config.statelessPerTurn) {
      return {};
    }
  }

  // Always auto-resume existing story turns for the active card (or pending fork if staged)
  let resumedStoryBlock = '';
  const recentTurnTexts: string[] = [];
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
    for (const t of pendingFork.turns.slice(-6)) {
      if (t.userMessage) recentTurnTexts.push(t.userMessage);
      if (t.narrative) recentTurnTexts.push(t.narrative);
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
      for (const t of existingTurns.slice(-6)) {
        if (t.userMessage) recentTurnTexts.push(t.userMessage);
        if (t.narrative) recentTurnTexts.push(t.narrative);
      }
      resumedStoryBlock = storyLog.formatForForkResume(
        existingTurns,
        card.name,
        config.userName || 'User',
        { maxContextTokens: 150_000, memoryPlugin: config.memoryPlugin },
        activeRegexScripts,
      );
    }
  }
  if (pendingDirectorInput) {
    recentTurnTexts.push(pendingDirectorInput);
  }

  const bundle = assembleSessionStart({
    config,
    card,
    preset,
    lorebooks,
    session,
    resumedStoryBlock,
    recentTurnTexts,
  });

  session.variables = bundle.variables;
  session.statData = bundle.statData;
  session.sessionStartCardId = card.id;
  session.sessionStartPresetId = preset?.id ?? '';
  if (config.enablePostHistoryInjection) {
    session.lastPostHistoryTurn = session.turnCount + 1;
  }
  storage.saveSession(session);
  // Sync newly initialized MVU statData (e.g. from external active lorebook [initvar]) back to shared 'default' store
  // so story_commit_turn on turn #1 never wipes statData back to {}.
  if (
    convId !== 'default' &&
    Object.keys(shared.statData ?? {}).length === 0 &&
    Object.keys(bundle.statData ?? {}).length > 0
  ) {
    const latestShared = storage.getSession('default');
    if (Object.keys(latestShared.statData ?? {}).length === 0) {
      latestShared.statData = { ...bundle.statData };
      storage.saveSession(latestShared);
    }
  }

  const fullSystemMessage = pendingDirectorInput
    ? `${bundle.systemMessage}\n\n---\n\n[Current Turn User Input]\n${pendingDirectorInput}`
    : bundle.systemMessage;

  const chunks = splitIntoInjectChunks(fullSystemMessage, 20480);
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
  const payload: SessionStartInput = raw ? JSON.parse(raw) : {};
  const result = handleSessionStart(payload);
  process.stdout.write(JSON.stringify(result));
}

const isDirectMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectMain) {
  main().catch(() => {
    // Never crash the agent loop on hook error; fail open cleanly
    process.stdout.write(JSON.stringify({}));
  });
}
