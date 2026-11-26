import { TavernStorage } from '../core/storage.js';
import { assembleSessionStart } from '../core/prompt-assembler.js';
import { StoryLogStore } from '../core/story-log.js';
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
  if (convId !== 'default') {
    const shared = storage.getSession('default');
    session.state = { ...session.state, ...shared.state };
    if (shared.statData && Object.keys(shared.statData).length > 0) {
      session.statData = { ...shared.statData };
    }
  }

  // Always auto-resume existing story turns for the active card (or pending fork if staged)
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
        30,
        activeRegexScripts,
      );
    } else {
      const existingTurns = storyLog.readTurns(card.id);
      if (existingTurns.length > 0) {
        resumedStoryBlock = storyLog.formatForForkResume(
          existingTurns,
          card.name,
          config.userName || 'User',
          30,
          activeRegexScripts,
        );
      }
    }

  const bundle = assembleSessionStart({
    config,
    card,
    preset,
    lorebooks,
    session,
    resumedStoryBlock,
  });

  session.variables = bundle.variables;
  session.statData = bundle.statData;
  session.sessionStartCardId = card.id;
  session.sessionStartPresetId = preset?.id ?? '';
  if (config.enablePostHistoryInjection) {
    session.lastPostHistoryTurn = session.turnCount + 1;
  }
  storage.saveSession(session);

  if (!bundle.systemMessage.trim()) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: bundle.systemMessage,
          },
        },
      ],
    }),
  );
}

main().catch(() => {
  // Never crash the agent loop on hook error; fail open cleanly
  process.stdout.write(JSON.stringify({}));
});
