import crypto from 'node:crypto';
import type { CharacterCard, Lorebook, RegexScript, TavernHelperScript } from './types.js';
import { parseLorebookJson } from './lorebook-engine.js';

function extractOriginsFromText(text: string, out: Set<string>): void {
  const matches = text.match(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?/g);
  if (!matches) return;
  for (const m of matches) {
    if (m.includes('w3.org') || m.includes('..')) continue;
    try {
      const u = new URL(m);
      if (
        (u.protocol === 'https:' || u.protocol === 'http:') &&
        u.hostname.includes('.') &&
        !/^\.|\.$/.test(u.hostname)
      ) {
        out.add(u.origin);
      }
    } catch {
      // ignore invalid URL
    }
  }
}

export function extractTavernHelperScripts(
  rawHelper: unknown,
  origins?: Set<string>,
): TavernHelperScript[] {
  let rawList: unknown[] = [];
  if (Array.isArray(rawHelper)) {
    // Support tuple-map format: [["scripts", [...]], ["variables", {...}]]
    const scriptsTuple = rawHelper.find(
      (entry) => Array.isArray(entry) && entry[0] === 'scripts' && Array.isArray(entry[1]),
    ) as [string, unknown[]] | undefined;
    if (scriptsTuple) {
      rawList = scriptsTuple[1];
    }
  } else if (rawHelper && typeof rawHelper === 'object') {
    const obj = rawHelper as Record<string, unknown>;
    if (Array.isArray(obj.scripts)) {
      rawList = obj.scripts;
    }
  }

  const out: TavernHelperScript[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const payload =
      rec.value && typeof rec.value === 'object' ? (rec.value as Record<string, unknown>) : rec;
    const content = String(payload.content ?? '');
    if (!content && !payload.name) continue;
    if (origins) extractOriginsFromText(content, origins);
    out.push({
      name: String(payload.name ?? 'Unnamed Script'),
      content,
      enabled: payload.enabled !== false,
    });
  }
  return out;
}

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

  // Generic extraction of card extensions: regex_scripts, tavern_helper.scripts, custom extensions, and image origins
  const ext = (data.extensions && typeof data.extensions === 'object'
    ? data.extensions
    : {}) as Record<string, unknown>;

  const origins = new Set<string>();
  const regexScripts: RegexScript[] = [];
  if (Array.isArray(ext.regex_scripts)) {
    for (const rs of ext.regex_scripts as Array<Record<string, unknown>>) {
      const replaceString = String(rs.replaceString ?? '');
      extractOriginsFromText(replaceString, origins);
      regexScripts.push({
        id: typeof rs.id === 'string' ? rs.id : undefined,
        scriptName: String(rs.scriptName ?? 'Unnamed Regex'),
        findRegex: String(rs.findRegex ?? ''),
        replaceString,
        disabled: Boolean(rs.disabled),
        placement: Array.isArray(rs.placement) ? rs.placement.map(Number) : [],
        trimStrings: Array.isArray(rs.trimStrings) ? rs.trimStrings.map(String) : undefined,
        markdownOnly: Boolean(rs.markdownOnly),
        promptOnly: Boolean(rs.promptOnly),
        minDepth: typeof rs.minDepth === 'number' ? rs.minDepth : null,
        maxDepth: typeof rs.maxDepth === 'number' ? rs.maxDepth : null,
        substituteRegex: typeof rs.substituteRegex === 'number' ? rs.substituteRegex : 0,
      });
    }
  }

  const tavernHelperScripts = extractTavernHelperScripts(
    ext.tavern_helper ?? ext.TavernHelper,
    origins,
  );

  // Preserve arbitrary non-standard extension payloads (e.g. dch_portraits, dch_maps) generically
  const customExtensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ext)) {
    if (k === 'regex_scripts' || k === 'tavern_helper') continue;
    customExtensions[k] = v;
  }

  const firstMessage = String(data.first_mes ?? data.firstMessage ?? '');
  const rawAlts = data.alternate_greetings ?? data.alternateGreetings;
  const alternateGreetings = Array.isArray(rawAlts)
    ? rawAlts.map((g) => String(g ?? '')).filter((g) => g.length > 0)
    : [];

  extractOriginsFromText(firstMessage, origins);
  for (const g of alternateGreetings) {
    extractOriginsFromText(g, origins);
  }

  return {
    id: opts?.id ?? slugifyId(name),
    name,
    description: String(data.description ?? ''),
    personality: String(data.personality ?? ''),
    scenario: String(data.scenario ?? ''),
    firstMessage,
    alternateGreetings: alternateGreetings.length > 0 ? alternateGreetings : undefined,
    messageExample: String(data.mes_example ?? data.messageExample ?? ''),
    systemPrompt: String(data.system_prompt ?? data.systemPrompt ?? ''),
    postHistoryInstructions: String(data.post_history_instructions ?? data.postHistoryInstructions ?? ''),
    creatorNotes: String(data.creator_notes ?? data.creatorNotes ?? ''),
    tags,
    avatarDataUrl: opts?.avatarDataUrl,
    embeddedLorebook,
    regexScripts: regexScripts.length > 0 ? regexScripts : undefined,
    tavernHelperScripts: tavernHelperScripts.length > 0 ? tavernHelperScripts : undefined,
    customExtensions: Object.keys(customExtensions).length > 0 ? customExtensions : undefined,
    resourceOrigins: origins.size > 0 ? Array.from(origins) : undefined,
    importedAt: new Date().toISOString(),
  };
}
