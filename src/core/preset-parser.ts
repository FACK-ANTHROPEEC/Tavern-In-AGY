import crypto from 'node:crypto';
import type { Preset, PresetPromptItem, RegexScript } from './types.js';
import { evaluateMacros, type MacroContext } from './macro-engine.js';
import { extractTavernHelperScripts } from './card-parser.js';

const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'openai_max_context',
  'openai_max_tokens',
  'seed',
];

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const hash = crypto.createHash('sha1').update(name + Date.now()).digest('hex').slice(0, 6);
  return `${base || 'preset'}-${hash}`;
}

export function parsePresetJson(
  raw: unknown,
  opts?: { name?: string; id?: string },
): Preset {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Preset JSON must be an object');
  }

  const obj = raw as Record<string, unknown>;
  const rawPrompts = Array.isArray(obj.prompts) ? (obj.prompts as Array<Record<string, unknown>>) : [];
  const promptMap = new Map<string, Record<string, unknown>>();
  for (const p of rawPrompts) {
    if (typeof p.identifier === 'string') {
      promptMap.set(p.identifier, p);
    }
  }

  // Pick canonical prompt_order (character_id 100001 is ST's global default, otherwise non-empty last)
  const promptOrders = Array.isArray(obj.prompt_order)
    ? (obj.prompt_order as Array<Record<string, unknown>>)
    : [];
  const targetOrderObj =
    promptOrders.find((po) => po.character_id === 100001 && Array.isArray(po.order) && po.order.length > 0) ??
    [...promptOrders].reverse().find((po) => Array.isArray(po.order) && po.order.length > 0) ??
    promptOrders[promptOrders.length - 1];
  const orderEntries = Array.isArray(targetOrderObj?.order)
    ? (targetOrderObj.order as Array<Record<string, unknown>>)
    : [];

  const ordered: PresetPromptItem[] = [];
  const seen = new Set<string>();

  const toItem = (p: Record<string, unknown>, enabledOverride?: boolean): PresetPromptItem => {
    const content = typeof p.content === 'string' ? p.content : '';
    const marker = Boolean(p.marker);
    const roleRaw = String(p.role ?? 'system');
    const role: 'system' | 'user' | 'assistant' =
      roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : 'system';
    return {
      identifier: String(p.identifier ?? ''),
      name: String(p.name ?? p.identifier ?? 'Untitled'),
      role,
      content,
      enabled: enabledOverride !== undefined ? enabledOverride : p.enabled !== false,
      marker,
      injectionPosition: typeof p.injection_position === 'number' ? p.injection_position : 0,
      injectionDepth: typeof p.injection_depth === 'number' ? p.injection_depth : 4,
      injectionOrder: typeof p.injection_order === 'number' ? p.injection_order : 100,
      isSectionHeader: !marker && content.trim().length === 0,
      forbidOverrides: Boolean(p.forbid_overrides),
    };
  };

  for (const entry of orderEntries) {
    const ident = typeof entry.identifier === 'string' ? entry.identifier : '';
    const p = promptMap.get(ident);
    if (!p) continue;
    seen.add(ident);
    ordered.push(toItem(p, Boolean(entry.enabled)));
  }

  // Append any prompts not referenced in prompt_order so nothing is lost
  for (const p of rawPrompts) {
    const ident = typeof p.identifier === 'string' ? p.identifier : '';
    if (!ident || seen.has(ident)) continue;
    ordered.push(toItem(p));
  }

  // Fallback for legacy / simplified presets without `prompts` array
  if (ordered.length === 0) {
    const legacyFields: Array<{ key: string; name: string; afterHistory?: boolean }> = [
      { key: 'main_prompt', name: 'Main Prompt' },
      { key: 'system_prompt', name: 'System Prompt' },
      { key: 'nsfw_prompt', name: 'Auxiliary Prompt' },
      { key: 'jailbreak_prompt', name: 'Post-History Instructions', afterHistory: true },
    ];
    let insertedHistoryMarker = false;
    for (const lf of legacyFields) {
      const val = obj[lf.key];
      if (typeof val === 'string' && val.trim()) {
        if (lf.afterHistory && !insertedHistoryMarker) {
          ordered.push({
            identifier: 'chatHistory',
            name: 'Chat History',
            role: 'system',
            content: '',
            enabled: true,
            marker: true,
            injectionPosition: 0,
            injectionDepth: 4,
            injectionOrder: 100,
            isSectionHeader: false,
          });
          insertedHistoryMarker = true;
        }
        ordered.push({
          identifier: lf.key,
          name: lf.name,
          role: 'system',
          content: val,
          enabled: true,
          marker: false,
          injectionPosition: 0,
          injectionDepth: 4,
          injectionOrder: 100,
          isSectionHeader: false,
        });
      }
    }
  }

  // Extract extensions.regex_scripts (including minDepth / maxDepth / substituteRegex)
  const regexScripts: RegexScript[] = [];
  const ext = obj.extensions as Record<string, unknown> | undefined;
  if (ext && Array.isArray(ext.regex_scripts)) {
    for (const rs of ext.regex_scripts as Array<Record<string, unknown>>) {
      regexScripts.push({
        id: typeof rs.id === 'string' ? rs.id : undefined,
        scriptName: String(rs.scriptName ?? 'Unnamed Regex'),
        findRegex: String(rs.findRegex ?? ''),
        replaceString: String(rs.replaceString ?? ''),
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
    ext?.tavern_helper ?? ext?.TavernHelper,
  );

  const samplingMeta: Record<string, unknown> = {};
  for (const key of SAMPLING_KEYS) {
    if (key in obj) samplingMeta[key] = obj[key];
  }

  const name = opts?.name ?? 'Imported Preset';

  return {
    id: opts?.id ?? slugifyId(name),
    name,
    prompts: ordered,
    regexScripts,
    tavernHelperScripts: tavernHelperScripts.length > 0 ? tavernHelperScripts : undefined,
    samplingMeta,
    importedAt: new Date().toISOString(),
  };
}

export interface PresetSlots {
  worldInfoBefore?: string;
  personaDescription?: string;
  charDescription?: string;
  charPersonality?: string;
  scenario?: string;
  worldInfoAfter?: string;
  dialogueExamples?: string;
}

export interface CompilePresetOptions {
  /** Optional EJS template renderer executed before macro evaluation on every prompt block */
  ejsRender?: (raw: string) => string;
}

export interface CompiledPreset {
  staticText: string;
  postHistoryText: string;
  variables: Record<string, string>;
  stats: {
    enabledCount: number;
    staticBlockCount: number;
    postHistoryBlockCount: number;
    prefillCount: number;
    staticChars: number;
    postHistoryChars: number;
  };
}

interface PositionedBlock {
  text: string;
  depth: number;
  order: number;
  seq: number;
}

/**
 * Evaluates a parsed Preset in strict prompt_order sequence:
 * - Items before `chatHistory` (and injectionPosition === 0) compile into `staticText` (L1 SessionStart)
 * - Items after `chatHistory` (or injectionPosition === 1) compile into `postHistoryText` (L3 PreInvocation),
 *   ordered by `injectionDepth` desc (deeper first, depth 0 closest to end) and `injectionOrder` asc.
 * - Enabled `role: "assistant"` items after `chatHistory` are bridged as structured continuation anchors.
 * - `setvar` / `getvar` state and optional EJS rendering flow seamlessly from top to bottom.
 */
export function compilePreset(
  preset: Preset,
  ctx: MacroContext,
  slots: PresetSlots = {},
  options: CompilePresetOptions = {},
): CompiledPreset {
  const staticBlocks: string[] = [];
  const depthBlocks: PositionedBlock[] = [];
  const trailingPostBlocks: string[] = [];

  let afterChatHistory = false;
  let enabledCount = 0;
  let prefillCount = 0;
  let seq = 0;

  const renderBlock = (raw: string): string => {
    const afterEjs = options.ejsRender ? options.ejsRender(raw) : raw;
    return evaluateMacros(afterEjs, ctx).trim();
  };

  for (const item of preset.prompts) {
    if (!item.enabled) continue;
    enabledCount += 1;

    if (item.marker) {
      if (item.identifier === 'chatHistory') {
        afterChatHistory = true;
        continue;
      }

      const slotValue = resolveSlot(item.identifier, slots);
      if (slotValue && slotValue.trim().length > 0) {
        const renderedSlot = renderBlock(slotValue);
        if (renderedSlot) {
          if (afterChatHistory) {
            trailingPostBlocks.push(renderedSlot);
          } else {
            staticBlocks.push(renderedSlot);
          }
        }
      }
      continue;
    }

    if (item.isSectionHeader) {
      continue;
    }

    const rendered = renderBlock(item.content);
    if (!rendered) continue;

    if (item.injectionPosition === 1) {
      depthBlocks.push({
        text: formatRoleTaggedBlock(item.role, rendered, false),
        depth: item.injectionDepth,
        order: item.injectionOrder,
        seq: seq++,
      });
    } else if (afterChatHistory) {
      if (item.role === 'assistant') {
        prefillCount += 1;
        trailingPostBlocks.push(formatRoleTaggedBlock('assistant', rendered, true));
      } else {
        trailingPostBlocks.push(formatRoleTaggedBlock(item.role, rendered, false));
      }
    } else {
      staticBlocks.push(rendered);
    }
  }

  // Order depth-injected blocks: deeper depth first (e.g. depth 4 before depth 0), then injectionOrder asc
  depthBlocks.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    if (a.order !== b.order) return a.order - b.order;
    return a.seq - b.seq;
  });

  const postHistoryBlocks = [...depthBlocks.map((b) => b.text), ...trailingPostBlocks];
  const staticText = staticBlocks.join('\n\n');
  const postHistoryText = postHistoryBlocks.join('\n\n');

  return {
    staticText,
    postHistoryText,
    variables: { ...ctx.vars },
    stats: {
      enabledCount,
      staticBlockCount: staticBlocks.length,
      postHistoryBlockCount: postHistoryBlocks.length,
      prefillCount,
      staticChars: staticText.length,
      postHistoryChars: postHistoryText.length,
    },
  };
}

function formatRoleTaggedBlock(
  role: 'system' | 'user' | 'assistant',
  rendered: string,
  isAfterHistoryPrefill: boolean,
): string {
  if (isAfterHistoryPrefill && role === 'assistant') {
    return `[Assistant Continuation Anchor]\nAcknowledge and continue seamlessly from this stance/opening:\n${rendered}`;
  }
  return rendered;
}

function resolveSlot(identifier: string, slots: PresetSlots): string | undefined {
  switch (identifier) {
    case 'worldInfoBefore':
      return slots.worldInfoBefore;
    case 'personaDescription':
      return slots.personaDescription;
    case 'charDescription':
      return slots.charDescription;
    case 'charPersonality':
      return slots.charPersonality;
    case 'scenario':
      return slots.scenario;
    case 'worldInfoAfter':
      return slots.worldInfoAfter;
    case 'dialogueExamples':
      return slots.dialogueExamples;
    default:
      return undefined;
  }
}
