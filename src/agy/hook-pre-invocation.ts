import { TavernStorage } from '../core/storage.js';
import { assemblePreInvocation, assembleSessionStart, hashText } from '../core/prompt-assembler.js';
import { applyMvuUpdates } from '../core/mvu-engine.js';
import { StoryLogStore } from '../core/story-log.js';
import { extractWaveOptions, readRecentTranscriptTexts } from './transcript-reader.js';
import type { Lorebook } from '../core/types.js';

interface PreInvocationInput {
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

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  const payload: PreInvocationInput = raw ? JSON.parse(raw) : {};
  const storage = new TavernStorage();
  const config = storage.getConfig();

  if (!config.enabled || !config.activeCardId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const lastUserInput = (payload.lastUserInput ?? '').trim();
  if (!lastUserInput) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Skip slash commands (e.g. /tavern-rp, /compact, /plan) so invoking a skill or command never triggers RP injection
  if (/^\/[a-z0-9_-]+(?:\s|$)/i.test(lastUserInput)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const card = storage.getCard(config.activeCardId);
  if (!card) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const convId = payload.conversationId || 'default';
  const session = storage.getSession(convId);

  // Deduplicate multiple model invocations within the same user turn
  const inputHash = hashText(lastUserInput);
  if (session.lastUserInputHash === inputHash) {
    process.stdout.write(JSON.stringify({}));
    return;
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
        15,
        activeRegexScripts,
      );
    } else {
      const existingTurns = storyLog.readTurns(card.id);
      if (existingTurns.length > 0) {
        resumedStoryBlock = storyLog.formatForForkResume(
          existingTurns,
          card.name,
          config.userName || 'User',
          15,
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

  const combinedMessage = [sessionStartPrefix, bundle.systemMessage]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');

  if (!combinedMessage) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: combinedMessage,
          },
        },
      ],
    }),
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
