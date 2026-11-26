import { TavernStorage } from '../core/storage.js';
import { assembleSessionStart } from '../core/prompt-assembler.js';
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

  const bundle = assembleSessionStart({
    config,
    card,
    preset,
    lorebooks,
    session,
  });

  session.variables = bundle.variables;
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
