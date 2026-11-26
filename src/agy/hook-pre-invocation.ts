import { TavernStorage } from '../core/storage.js';
import { assemblePreInvocation, hashText } from '../core/prompt-assembler.js';
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

  const nextRecent = [...session.recentMessages, lastUserInput].slice(-20);
  const scanMessages = transcriptTexts.length > 0
    ? [...transcriptTexts.slice(-10), lastUserInput]
    : nextRecent;

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
  process.stdout.write(JSON.stringify({}));
});
