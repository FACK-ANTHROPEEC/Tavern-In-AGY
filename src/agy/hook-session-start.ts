import { TavernStorage } from '../core/storage.js';
import { assembleSessionStart, splitIntoInjectChunks } from '../core/prompt-assembler.js';
import { StoryLogStore, resolveStoryKey } from '../core/story-log.js';
import type { Lorebook } from '../core/types.js';

interface SessionStartInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  const payload: SessionStartInput = raw ? JSON.parse(raw) : {};
  const storage = new TavernStorage();
  const config = storage.getConfig();

  if (!config.enabled || !config.activeCardId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const card = storage.getCard(config.activeCardId);
  if (!card) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const preset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
  const lorebooks: Lorebook[] = config.activeLorebookIds
    .map((id) => storage.getLorebook(id))
    .filter((b): b is Lorebook => b !== null);

  const convId = payload.conversationId || 'default';
  const session = storage.getSession(convId);
  // Sync latest live state & MVU statData written by MCP server ('default' shared store)
  let pendingDirectorInput = '';
  const shared = storage.getSession('default');
  if (convId !== 'default') {
    session.state = { ...session.state, ...shared.state };
    if (shared.statData && Object.keys(shared.statData).length > 0) {
      session.statData = { ...shared.statData };
    }
  }

  // In Director Mode, the main window (tavern-director) opens BEFORE any user message is sent,
  // so pendingDirectorInput is absent -> return {} (0 bytes) to keep the director's mind 100% clean.
  // Only the freshly spawned story-writer subagent (within 5 min of PreInvocation) consumes it and receives the full context.
  const hasFreshDirectorInput =
    Boolean(shared.pendingDirectorInput) &&
    Date.now() - (shared.pendingDirectorInputAt ?? 0) <= 300_000;

  if (config.directorMode) {
    if (!hasFreshDirectorInput) {
      if (shared.pendingDirectorInput) {
        shared.pendingDirectorInput = undefined;
        shared.pendingDirectorInputAt = undefined;
        storage.saveSession(shared);
      }
      process.stdout.write(JSON.stringify({}));
      return;
    }
    pendingDirectorInput = shared.pendingDirectorInput!;
    shared.pendingDirectorInput = undefined;
    shared.pendingDirectorInputAt = undefined;
    storage.saveSession(shared);
  } else if (shared.pendingDirectorInput) {
    shared.pendingDirectorInput = undefined;
    shared.pendingDirectorInputAt = undefined;
    storage.saveSession(shared);
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
      30,
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
        30,
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

  const chunks = splitIntoInjectChunks(bundle.systemMessage, 12000);
  if (chunks.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      injectSteps: chunks.map((chunk) => ({
        systemMessage: {
          systemMessage: chunk,
        },
      })),
    }),
  );
}

main().catch(() => {
  // Never crash the agent loop on hook error; fail open cleanly
  process.stdout.write(JSON.stringify({}));
});
