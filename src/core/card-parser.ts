import crypto from 'node:crypto';
import type { CharacterCard, Lorebook } from './types.js';
import { parseLorebookJson } from './lorebook-engine.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const hash = crypto.createHash('sha1').update(name + Date.now()).digest('hex').slice(0, 6);
  return `${base || 'card'}-${hash}`;
}

/**
 * Extracts SillyTavern Chara Card V2 (`chara`) or V3 (`ccv3`) metadata from PNG tEXt chunks.
 */
export function parseCharacterCardPng(buffer: Buffer, fallbackName = 'Unnamed Character'): CharacterCard {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG file: missing PNG signature');
  }

  const textChunks = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      break;
    }

    if (type === 'tEXt') {
      const chunkData = buffer.subarray(dataStart, dataEnd);
      const nullIdx = chunkData.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = chunkData.toString('latin1', 0, nullIdx).toLowerCase();
        const text = chunkData.toString('latin1', nullIdx + 1);
        textChunks.set(keyword, text);
      }
    }

    if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  const base64Payload = textChunks.get('ccv3') ?? textChunks.get('chara');
  if (!base64Payload) {
    throw new Error('PNG does not contain SillyTavern character metadata (ccv3 or chara tEXt chunk)');
  }

  const jsonStr = Buffer.from(base64Payload, 'base64').toString('utf8');
  const parsed = JSON.parse(jsonStr);
  const avatarDataUrl = `data:image/png;base64,${buffer.toString('base64')}`;

  return parseCharacterCardJson(parsed, { avatarDataUrl, fallbackName });
}

export function parseCharacterCardJson(
  raw: unknown,
  opts?: { avatarDataUrl?: string; fallbackName?: string; id?: string },
): CharacterCard {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Character card JSON must be an object');
  }

  const obj = raw as Record<string, unknown>;
  // V2 / V3 wrap core fields inside `data`
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;

  const name = String(data.name ?? obj.name ?? opts?.fallbackName ?? 'Unnamed Character').trim();

  let embeddedLorebook: Lorebook | undefined;
  if (data.character_book && typeof data.character_book === 'object') {
    embeddedLorebook = parseLorebookJson(data.character_book, `${name} - Character Book`);
  }

  const tagsRaw = data.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map((t) => String(t)) : [];

  return {
    id: opts?.id ?? slugifyId(name),
    name,
    description: String(data.description ?? ''),
    personality: String(data.personality ?? ''),
    scenario: String(data.scenario ?? ''),
    firstMessage: String(data.first_mes ?? data.firstMessage ?? ''),
    messageExample: String(data.mes_example ?? data.messageExample ?? ''),
    systemPrompt: String(data.system_prompt ?? data.systemPrompt ?? ''),
    postHistoryInstructions: String(data.post_history_instructions ?? data.postHistoryInstructions ?? ''),
    creatorNotes: String(data.creator_notes ?? data.creatorNotes ?? ''),
    tags,
    avatarDataUrl: opts?.avatarDataUrl,
    embeddedLorebook,
    importedAt: new Date().toISOString(),
  };
}
