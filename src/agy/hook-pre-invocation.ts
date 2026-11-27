import { TavernStorage } from '../core/storage.js';
import {
  assemblePreInvocation,
  assembleSessionStart,
  hashText,
  splitIntoInjectChunks,
} from '../core/prompt-assembler.js';
import { applyMvuUpdates } from '../core/mvu-engine.js';
import { StoryLogStore, resolveStoryKey } from '../core/story-log.js';
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

  // Sync latest live state & MVU statData written by MCP server ('default' shared store)
  if (convId !== 'default') {
    const shared = storage.getSession('default');
    session.state = { ...session.state, ...shared.state };
    if (shared.statData && Object.keys(shared.statData).length > 0) {
      session.statData = { ...shared.statData };
    }
  }

  // Deduplicate multiple model invocations ONLY within the SAME user turn (explicit invocationNum > 1),
  // so sending the same short message (e.g. "继续") across consecutive turns never drops pendingDirectorInput.
  const inputHash = hashText(lastUserInput);
  if (
    session.lastUserInputHash === inputHash &&
    typeof payload.invocationNum === 'number' &&
    payload.invocationNum > 1
  ) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Director Mode: main window acts as a lightweight dispatcher (story-director) and spawns a fresh
  // story-writer subagent per turn. Never inject RP prose/lore into the main window; cache the user input
  // with a 5-min TTL so the spawned story-writer subagent's SessionStart unlocks and injects full context.
  if (config.directorMode) {
    const shared = storage.getSession('default');
    shared.pendingDirectorInput = lastUserInput;
    shared.pendingDirectorInputAt = Date.now();
    shared.lastUserInputForCommit = lastUserInput;
    storage.saveSession(shared);
    session.lastUserInputHash = inputHash;
    storage.saveSession(session);
    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage:
                '[Story Director] You are the dispatcher ONLY. Do NOT write story prose or call story_search_lorebook/story_commit_turn. Immediately call invoke_subagent(TypeName="story-writer", Role="Story Turn Writer") with the user message, wait for completion, then kill the subagent and reply with only the 1-line floor index.',
            },
          },
        ],
      }),
    );
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
        { maxContextTokens: 150_000 },
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
          { maxContextTokens: 150_000 },
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
  process.stdout.write(JSON.stringify({}));
});
