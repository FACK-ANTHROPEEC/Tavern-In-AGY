import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TavernStorage } from '../core/storage.js';
import { parseCharacterCardJson, parseCharacterCardPng } from '../core/card-parser.js';
import { parsePresetJson } from '../core/preset-parser.js';
import { parseLorebookJson, scanLorebooks } from '../core/lorebook-engine.js';
import { StoryLogStore, resolveStoryKey } from '../core/story-log.js';
import { applyMvuUpdates, extractInitVarFromLorebooks } from '../core/mvu-engine.js';
import { extractMemorySummary, resolveMemoryPluginConfig } from '../core/memory-engine.js';
import { createDefaultState, type CharacterCard, type Lorebook, type TavernConfig } from '../core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://story-studio/app.html';
const DEFAULT_SESSION_ID = 'default';

const storage = new TavernStorage();
const storyLog = new StoryLogStore(storage.rootDir);

function loadAppHtml(): string {
  const envPath = process.env.TAVERN_APP_HTML;
  const candidates = [
    envPath ? path.resolve(envPath) : null,
    path.resolve(__dirname, '../ui/index.html'),
    path.resolve(__dirname, '../../dist/ui/index.html'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8');
    }
  }
  return '<!doctype html><html><body><h2>TavernInAGY UI not built yet</h2><p>Run <code>npm run build:ui</code>.</p></body></html>';
}

function collectDynamicResourceDomains(): string[] {
  // Mainstream, trusted image hosts & public frontend/font CDNs commonly used by ST cards
  const origins = new Set<string>([
    // Global image hosts
    'https://files.catbox.moe',
    'https://litter.catbox.moe',
    'https://catbox.moe',
    'https://i.ibb.co',
    'https://ibb.co',
    'https://i.postimg.cc',
    'https://postimg.cc',
    'https://i.imgur.com',
    'https://imgur.com',
    'https://iili.io',
    'https://cdn.discordapp.com',
    'https://media.discordapp.net',
    'https://telegra.ph',
    'https://i.redd.it',
    'https://preview.redd.it',
    'https://i.pximg.net',
    'https://i.pixiv.re',
    'https://i.pixiv.cat',
    'https://pomf2.lain.la',
    'https://res.cloudinary.com',
    'https://utfs.io',
    'https://files.edgestore.dev',
    // CN / community image hosts
    'https://s2.loli.net',
    'https://s1.ax1x.com',
    'https://s21.ax1x.com',
    'https://z1.ax1x.com',
    'https://s3.bmp.ovh',
    'https://pic.imgdb.cn',
    'https://s1.imagehub.cc',
    'https://img.picui.cn',
    'https://img.picgo.net',
    'https://image.dooo.ng',
    'https://img2.imgtp.com',
    'https://p.sda1.dev',
    'https://i.miji.bid',
    'https://tc.z.wiki',
    'https://pleak.win',
    'https://i0.hdslb.com',
    'https://i1.hdslb.com',
    'https://i2.hdslb.com',
    'https://wx1.sinaimg.cn',
    'https://wx2.sinaimg.cn',
    'https://wx3.sinaimg.cn',
    'https://wx4.sinaimg.cn',
    // Git & public frontend / font CDNs
    'https://raw.githubusercontent.com',
    'https://avatars.githubusercontent.com',
    'https://user-images.githubusercontent.com',
    'https://objects.githubusercontent.com',
    'https://gitgud.io',
    'https://gitee.com',
    'https://cdnjs.cloudflare.com',
    'https://cdn.jsdelivr.net',
    'https://testingcf.jsdelivr.net',
    'https://fastly.jsdelivr.net',
    'https://gcore.jsdelivr.net',
    'https://unpkg.com',
    'https://esm.sh',
    'https://cdn.bootcdn.net',
    'https://cdn.staticfile.org',
    'https://lib.baomitu.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    'https://fonts.loli.net',
    'https://gstatic.loli.net',
  ]);
  for (const card of storage.listCards()) {
    for (const o of card.resourceOrigins ?? []) {
      if (!o || o.includes('..')) continue;
      try {
        const u = new URL(o);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !/^\.|\.$/.test(u.hostname)) {
          origins.add(u.origin);
        }
      } catch {
        // skip invalid origin
      }
    }
  }
  return Array.from(origins);
}

function isHtmlBeautifyRegex(replaceString: string): boolean {
  return /<!doctype|<html|<style|<div|<script/i.test(replaceString);
}

function initCardMvuIfEmpty(
  card: CharacterCard,
  userName: string,
  greetingIndex = 0,
  extraLorebooks: Lorebook[] = [],
): Record<string, unknown> {
  const books = [...(card.embeddedLorebook ? [card.embeddedLorebook] : []), ...extraLorebooks];
  const base = extractInitVarFromLorebooks(books, userName, card.name) ?? {};
  const allGreetings = [card.firstMessage, ...(card.alternateGreetings ?? [])];
  const clamped = Math.max(0, Math.min(Math.max(0, allGreetings.length - 1), greetingIndex));
  const selectedGreeting = allGreetings[clamped] ?? '';
  if (selectedGreeting && /<update(?:variable)?>/i.test(selectedGreeting)) {
    return applyMvuUpdates(base, selectedGreeting, { userName, charName: card.name }).statData;
  }
  return base;
}

function getActiveStoryKey(config: TavernConfig): string {
  const cardId = config.activeCardId || 'default';
  const slotId = config.activeChatSlots?.[cardId] || 'default';
  return resolveStoryKey(cardId, slotId);
}

function syncSessionToStoryKey(config: TavernConfig, storyKey: string): void {
  const session = storage.getSession(DEFAULT_SESSION_ID);
  const turns = storyLog.readTurns(storyKey);
  const lastTurn = turns[turns.length - 1];
  const lastTurnWithStat = [...turns].reverse().find((t) => t.statData && Object.keys(t.statData).length > 0);

  if (lastTurnWithStat?.statData) {
    session.statData = lastTurnWithStat.statData;
  } else if (config.activeCardId) {
    const card = storage.getCard(config.activeCardId);
    const greetingIdx = config.activeGreetingIndices?.[storyKey] ?? 0;
    const activeLorebooks = (config.activeLorebookIds ?? [])
      .map((id) => storage.getLorebook(id))
      .filter((b): b is Lorebook => b !== null);
    session.statData = card
      ? initCardMvuIfEmpty(card, config.userName || 'User', greetingIdx, activeLorebooks)
      : {};
  } else {
    session.statData = {};
  }

  if (lastTurn?.statsSnapshot) {
    session.state = {
      ...createDefaultState(),
      location: lastTurn.statsSnapshot.location ?? '',
      timeOfDay: lastTurn.statsSnapshot.timeOfDay ?? '',
      mood: lastTurn.statsSnapshot.mood ?? '',
      outfit: lastTurn.statsSnapshot.outfit ?? '',
      affection: lastTurn.statsSnapshot.affection ?? 0,
    };
  } else {
    session.state = createDefaultState();
  }
  session.latestOptions = lastTurn?.options ?? [];
  storage.saveSession(session);
}

function buildBootstrapPayload(opts?: { omitAvatars?: boolean; slimForPanelOpen?: boolean }) {
  const config = storage.getConfig();
  const cards = storage.listCards();
  const presets = storage.listPresets();
  const lorebooks = storage.listLorebooks();
  const snapshots = opts?.slimForPanelOpen ? [] : storage.listSnapshots();
  const session = storage.getSession(DEFAULT_SESSION_ID);
  const cardId = config.activeCardId || 'default';
  const activeChatSlot = config.activeChatSlots?.[cardId] || 'default';
  const storyKey = resolveStoryKey(cardId, activeChatSlot);
  const storyTurns = opts?.slimForPanelOpen ? [] : storyLog.readTurns(storyKey);
  const chatSlots = config.activeCardId ? storyLog.listSlots(config.activeCardId, activeChatSlot) : [];

  const activeCardObj = config.activeCardId ? cards.find((c) => c.id === config.activeCardId) : undefined;
  const activePresetObj = config.activePresetId ? presets.find((p) => p.id === config.activePresetId) : undefined;
  const activeDisplayRegexScripts = opts?.omitAvatars
    ? undefined
    : [
        ...(activePresetObj?.regexScripts ?? []),
        ...(activeCardObj?.regexScripts ?? []),
      ].filter((r) => !r.disabled && (r.markdownOnly || !r.promptOnly));

  let remainingAvatarBudget = 1_200_000;
  return {
    config,
    cards: cards.map((c) => {
      const isActiveCard = c.id === config.activeCardId;
      let avatarDataUrl: string | undefined;
      if (!opts?.omitAvatars && c.avatarDataUrl) {
        if (c.avatarDataUrl.length <= remainingAvatarBudget || (isActiveCard && c.avatarDataUrl.length <= 256_000)) {
          avatarDataUrl = c.avatarDataUrl;
          remainingAvatarBudget = Math.max(0, remainingAvatarBudget - c.avatarDataUrl.length);
        }
      }
      const allGreetings = isActiveCard ? [c.firstMessage, ...(c.alternateGreetings ?? [])] : undefined;
      const rawGreetingIdx = isActiveCard ? (config.activeGreetingIndices?.[storyKey] ?? 0) : 0;
      const activeGreetingIndex = allGreetings
        ? Math.max(0, Math.min(allGreetings.length - 1, rawGreetingIdx))
        : 0;
      return {
        id: c.id,
        name: c.name,
        description: '',
        personality: '',
        scenario: c.scenario.slice(0, 120),
        firstMessage: isActiveCard ? c.firstMessage : '',
        allGreetings,
        activeGreetingIndex,
        tags: c.tags,
        avatarDataUrl,
        hasEmbeddedLorebook: Boolean(c.embeddedLorebook),
        embeddedLorebookName: c.embeddedLorebook?.name,
        embeddedLorebookCount: c.embeddedLorebook?.entries.length ?? 0,
        embeddedLorebookEntries: isActiveCard
          ? (c.embeddedLorebook?.entries ?? []).map((e) => ({
              uid: e.uid,
              comment: e.comment,
              keys: e.keys,
              constant: e.constant,
              enabled: e.enabled,
              order: e.order,
            }))
          : undefined,
        hasFrontendHtml: Boolean(
          c.regexScripts?.some((r) => !r.disabled && isHtmlBeautifyRegex(r.replaceString)),
        ),
        hasHelperScripts: Boolean(c.tavernHelperScripts?.some((s) => s.enabled)),
        regexScripts: isActiveCard
          ? (c.regexScripts ?? []).map((r, idx) => ({
              index: idx,
              scriptName: r.scriptName,
              disabled: r.disabled,
              placement: r.placement,
              markdownOnly: Boolean(r.markdownOnly),
              promptOnly: Boolean(r.promptOnly),
              minDepth: r.minDepth ?? null,
              maxDepth: r.maxDepth ?? null,
            }))
          : undefined,
        helperScripts: isActiveCard
          ? (c.tavernHelperScripts ?? []).map((s, idx) => ({
              index: idx,
              name: s.name,
              enabled: s.enabled,
              charLength: s.content.length,
            }))
          : undefined,
        importedAt: c.importedAt,
      };
    }),
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      regexCount: p.regexScripts.length,
      samplingMeta: p.samplingMeta,
      prompts: p.prompts.map((item) => {
        // Estimate realistic post-macro length for prompts containing huge {{random::...}} tables
        const hasRandom = item.content.includes('{{random::');
        const effectiveChars = hasRandom
          ? Math.max(100, Math.round(item.content.length / 80))
          : item.content.length;
        return {
          identifier: item.identifier,
          name: item.name,
          role: item.role,
          enabled: item.enabled,
          marker: item.marker,
          isSectionHeader: item.isSectionHeader,
          charLength: effectiveChars,
        };
      }),
      regexScripts: p.regexScripts.map((r, idx) => ({
        index: idx,
        scriptName: r.scriptName,
        disabled: r.disabled,
        placement: r.placement,
        markdownOnly: Boolean(r.markdownOnly),
        promptOnly: Boolean(r.promptOnly),
        minDepth: r.minDepth ?? null,
        maxDepth: r.maxDepth ?? null,
      })),
      helperScripts: (p.tavernHelperScripts ?? []).map((s, idx) => ({
        index: idx,
        name: s.name,
        enabled: s.enabled,
        charLength: s.content.length,
      })),
      importedAt: p.importedAt,
    })),
    activeDisplayRegexScripts,
    lorebooks: lorebooks.map((b) => ({
      id: b.id,
      name: b.name,
      entryCount: b.entries.length,
      constantCount: b.entries.filter((e) => e.constant && e.enabled).length,
      scanDepth: b.scanDepth,
      tokenBudget: b.tokenBudget,
      importedAt: b.importedAt,
    })),
    snapshots,
    sessionState: session.state,
    statData: session.statData ?? {},
    latestOptions: session.latestOptions,
    storyTurns: storyTurns.slice(-200).map(({ statData: _omitStat, ...slimTurn }) => slimTurn),
    chatSlots,
    activeChatSlot,
    dataDir: storage.rootDir,
  };
}

const server = new McpServer({
  name: 'tavern-in-agy',
  version: '0.8.2',
});

// UI Resource (SEP-1865 MCP App) with dynamic image-host CSP resourceDomains
server.resource(
  'tavern-app',
  APP_URI,
  {
    description: 'TavernInAGY interactive Roleplay console',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          resourceDomains: collectDynamicResourceDomains(),
        },
      },
    },
  } as Record<string, unknown>,
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: loadAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              resourceDomains: collectDynamicResourceDomains(),
            },
          },
        },
      },
    ],
  }),
);

// Side-pane & Global Entrypoint Tool
server.registerTool(
  'story_open_panel',
  {
    title: 'TavernInAGY',
    description: 'Open the TavernInAGY Roleplay console in the side pane.',
    inputSchema: {},
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'TavernInAGY' },
          { type: 'global', title: 'TavernInAGY' },
        ],
      },
    },
  },
  async () => {
    const payload = buildBootstrapPayload({ omitAvatars: true, slimForPanelOpen: true });
    const activeCard = payload.cards.find((c) => c.id === payload.config.activeCardId);
    const activePreset = payload.presets.find((p) => p.id === payload.config.activePresetId);
    return {
      content: [
        {
          type: 'text',
          text: `TavernInAGY panel opened. Active card: ${activeCard?.name ?? 'None'}, Active preset: ${activePreset?.name ?? 'None'}, Lorebooks: ${payload.config.activeLorebookIds.length}.`,
        },
      ],
      structuredContent: payload,
    };
  },
);

// --- Model-Visible RP Engine Tools ---

server.registerTool(
  'story_commit_turn',
  {
    title: 'Commit RP Turn & Refresh MVU Panel',
    description:
      'Primary single-delivery channel for TavernInAGY RP turns. Pass the complete turn output (including all preset/card CoT, option tags, MVU <update> blocks, <StatusPlaceHolderImpl/>, and story prose) in `narrative` so the side-pane renderer applies preset & card display regexes faithfully, persists the JSONL floor, and applies MVU updates. Do not duplicate story prose in the main chat reply—reply with only a 1-line status index after calling this tool.',
    inputSchema: {
      conversationId: z.string().nullish(),
      userMessage: z.string().nullish(),
      narrative: z.string(),
      thought: z.string().nullish(),
      location: z.string().nullish(),
      timeOfDay: z.string().nullish(),
      mood: z.string().nullish(),
      outfit: z.string().nullish(),
      affection: z.union([z.number(), z.string()]).nullish(),
      affectionDelta: z.union([z.number(), z.string()]).nullish(),
      inventory: z.array(z.union([z.string(), z.number()])).nullish(),
      activeGoals: z.array(z.union([z.string(), z.number()])).nullish(),
      summary: z.string().nullish(),
      customFields: z.record(z.unknown()).nullish(),
      options: z
        .array(
          z.union([
            z.string(),
            z.object({
              label: z.string().nullish(),
              category: z.string().nullish(),
              text: z.string().nullish(),
            }),
          ]),
        )
        .nullish(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async (args) => {
    const config = storage.getConfig();
    // Always use the shared canonical session store ('default') so UI, hooks, and subagents never split-brain
    const session = storage.getSession(DEFAULT_SESSION_ID);
    const st = session.state;

    const toNum = (v: number | string | null | undefined): number | undefined => {
      if (v === null || v === undefined || v === '') return undefined;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    if (args.location != null) st.location = args.location;
    if (args.timeOfDay != null) st.timeOfDay = args.timeOfDay;
    if (args.mood != null) st.mood = args.mood;
    if (args.outfit != null) st.outfit = args.outfit;
    const affectionNum = toNum(args.affection);
    if (affectionNum !== undefined) st.affection = affectionNum;
    const deltaNum = toNum(args.affectionDelta);
    if (deltaNum !== undefined) st.affection += deltaNum;
    if (args.inventory != null) st.inventory = args.inventory.map(String);
    if (args.activeGoals != null) st.activeGoals = args.activeGoals.map(String);
    if (args.summary != null) st.summary = args.summary;
    if (args.customFields != null) {
      const normalizedCustom: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.customFields)) {
        if (v !== null && v !== undefined) {
          normalizedCustom[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
      st.customFields = { ...st.customFields, ...normalizedCustom };
    }
    st.updatedAt = new Date().toISOString();

    // Apply generic MVU JSONPatch / _.set / _.add / _.insert / _.remove updates if present in narrative
    const activeCardForMvu = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    const mvuRes = applyMvuUpdates(session.statData ?? {}, args.narrative, {
      userName: config.userName || 'User',
      charName: activeCardForMvu?.name,
    });
    session.statData = mvuRes.statData;

    const normalizedOptions = (args.options ?? [])
      .map((o, idx) => {
        if (typeof o === 'string') {
          return { label: `选项 ${idx + 1}`, category: '行动', text: o };
        }
        const text = (o.text ?? o.label ?? '').trim();
        const label = (o.label ?? o.category ?? `选项 ${idx + 1}`).trim();
        return { label, category: (o.category ?? label).trim(), text };
      })
      .filter((o) => o.text.length > 0);
    const resolvedUserMessage =
      (args.userMessage && args.userMessage.trim()) ||
      (session.lastUserInputForCommit && session.lastUserInputForCommit.trim()) ||
      undefined;
    session.lastUserInputForCommit = undefined;
    session.latestOptions = normalizedOptions;
    session.directorTurnState = 'committed';
    session.directorCommittedAt = Date.now();
    storage.saveSession(session);
    if (session.conversationId !== DEFAULT_SESSION_ID) {
      const shared = storage.getSession(DEFAULT_SESSION_ID);
      shared.directorTurnState = 'committed';
      shared.directorCommittedAt = session.directorCommittedAt;
      shared.lastUserInputForCommit = undefined;
      storage.saveSession(shared);
    }

    const storyKey = getActiveStoryKey(config);
    const cleanedNarrative = mvuRes.cleanedText || args.narrative;
    const extractedMem = extractMemorySummary(cleanedNarrative);
    const persistedNarrative =
      extractedMem.matchedTag === 'memory_summary' ? extractedMem.strippedText : cleanedNarrative;
    const resolvedMemorySummary =
      extractedMem.summary ||
      (args.summary && args.summary.trim()) ||
      undefined;
    const turn = storyLog.appendTurn(storyKey, {
      userMessage: resolvedUserMessage,
      narrative: persistedNarrative,
      thought: args.thought ?? undefined,
      memorySummary: resolvedMemorySummary,
      statsSnapshot: {
        location: st.location,
        timeOfDay: st.timeOfDay,
        mood: st.mood,
        outfit: st.outfit,
        affection: st.affection,
      },
      statData: session.statData,
      options: normalizedOptions.length > 0 ? normalizedOptions : undefined,
    });

    // Return a slim delta payload (~1 KB instead of full bootstrap) to keep conversation trajectory lean;
    // omit per-turn statData snapshot from wire payload (already persisted to JSONL for rollback and returned once at top-level).
    const { statData: _omitTurnStat, ...slimCommittedTurn } = turn;
    return {
      content: [
        {
          type: 'text',
          text: `Committed turn #${turn.index} (${turn.turnId}). MVU patches applied: ${mvuRes.appliedCount}.`,
        },
      ],
      structuredContent: {
        delta: true,
        committedTurn: slimCommittedTurn,
        sessionState: session.state,
        statData: session.statData ?? {},
        latestOptions: session.latestOptions,
      },
    };
  },
);

server.registerTool(
  'story_get_state',
  {
    title: 'Get Live RP State & MVU stat_data',
    description:
      'Read the active character card summary, current live RP state, MVU `stat_data`, and active preset name.',
    inputSchema: {
      conversationId: z.string().optional(),
    },
  },
  async () => {
    const config = storage.getConfig();
    const card = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    const preset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
    const session = storage.getSession(DEFAULT_SESSION_ID);
    const data = {
      enabled: config.enabled,
      activeCard: card ? { id: card.id, name: card.name, scenario: card.scenario } : null,
      activePreset: preset ? { id: preset.id, name: preset.name } : null,
      state: session.state,
      statData: session.statData ?? {},
      turnCount: session.turnCount,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  },
);

server.registerTool(
  'story_update_state',
  {
    title: 'Update Live RP State',
    description:
      'Persist updates to live Roleplay state (location, timeOfDay, mood, outfit, affection, inventory, activeGoals, summary, customFields).',
    inputSchema: {
      conversationId: z.string().optional(),
      location: z.string().optional(),
      timeOfDay: z.string().optional(),
      mood: z.string().optional(),
      outfit: z.string().optional(),
      affection: z.number().optional(),
      affectionDelta: z.number().optional(),
      inventory: z.array(z.string()).optional(),
      activeGoals: z.array(z.string()).optional(),
      summary: z.string().optional(),
      customFields: z.record(z.string()).optional(),
    },
  },
  async (args) => {
    // Always write to canonical shared 'default' session so UI and hooks stay consistent
    const session = storage.getSession(DEFAULT_SESSION_ID);
    const st = session.state;
    if (args.location !== undefined) st.location = args.location;
    if (args.timeOfDay !== undefined) st.timeOfDay = args.timeOfDay;
    if (args.mood !== undefined) st.mood = args.mood;
    if (args.outfit !== undefined) st.outfit = args.outfit;
    if (args.affection !== undefined) st.affection = args.affection;
    if (args.affectionDelta !== undefined) st.affection += args.affectionDelta;
    if (args.inventory !== undefined) st.inventory = args.inventory;
    if (args.activeGoals !== undefined) st.activeGoals = args.activeGoals;
    if (args.summary !== undefined) st.summary = args.summary;
    if (args.customFields !== undefined) {
      st.customFields = { ...st.customFields, ...args.customFields };
    }
    st.updatedAt = new Date().toISOString();
    storage.saveSession(session);

    return {
      content: [{ type: 'text', text: `Live RP state updated: ${JSON.stringify(st)}` }],
      structuredContent: { state: st },
    };
  },
);

server.registerTool(
  'story_search_lorebook',
  {
    title: 'Search Active Lorebooks',
    description: 'Search active World Info / Lorebooks and embedded character book by query text.',
    inputSchema: {
      query: z.string(),
    },
  },
  async ({ query }) => {
    const config = storage.getConfig();
    const card = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    const books: Lorebook[] = config.activeLorebookIds
      .map((id) => storage.getLorebook(id))
      .filter((b): b is Lorebook => b !== null);
    if (card?.embeddedLorebook) books.unshift(card.embeddedLorebook);

    const res = scanLorebooks(books, {
      recentMessages: [query],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });

    const hits = res.triggered.map((x) => ({
      comment: x.entry.comment,
      keys: x.entry.keys,
      content: x.entry.content,
    }));

    return {
      content: [
        {
          type: 'text',
          text: hits.length > 0 ? JSON.stringify(hits, null, 2) : 'No matching lorebook entries found.',
        },
      ],
      structuredContent: { hits },
    };
  },
);

server.registerTool(
  'story_save_snapshot',
  {
    title: 'Save Story Snapshot',
    description:
      'Save a checkpoint snapshot of current RP state and recent summary for branching or resuming in a fresh conversation.',
    inputSchema: {
      title: z.string(),
      summary: z.string().optional(),
      conversationId: z.string().optional(),
    },
  },
  async ({ title, summary }) => {
    const config = storage.getConfig();
    const session = storage.getSession(DEFAULT_SESSION_ID);
    if (summary) {
      session.state.summary = summary;
      storage.saveSession(session);
    }
    const snap = storage.saveSnapshot({
      id: `snap-${Date.now()}`,
      title,
      cardId: config.activeCardId,
      presetId: config.activePresetId,
      state: { ...session.state },
      variables: { ...session.variables },
      recentMessages: session.recentMessages.slice(-10),
      createdAt: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text', text: `Saved snapshot "${snap.title}" (${snap.id}).` }],
      structuredContent: { snapshot: snap },
    };
  },
);

// --- App-Only Tools (hidden from model, called by Side-Pane MCP App) ---

const APP_ONLY_META = { ui: { visibility: ['app'] as const } };

server.registerTool(
  'story_app_bootstrap',
  {
    title: 'Bootstrap App Data',
    description: 'Fetch all cards, presets, lorebooks, config, MVU stat_data, story turns, and session state for the side-pane UI.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: buildBootstrapPayload(),
  }),
);

function serializeWorldbookEntryForSandbox(e: Lorebook['entries'][number]) {
  return {
    uid: e.uid,
    name: e.comment,
    comment: e.comment,
    enabled: e.enabled,
    disable: !e.enabled,
    content: e.content,
    keys: e.keys,
    secondary_keys: e.secondaryKeys,
    constant: e.constant,
    selective: e.selective,
    selective_logic: e.selectiveLogic,
    order: e.order,
    position: e.position,
    depth: e.depth,
    role: e.role,
    case_sensitive: e.caseSensitive,
    match_whole_words: e.matchWholeWords,
    exclude_recursion: e.excludeRecursion,
    prevent_recursion: e.preventRecursion,
    delay_until_recursion: e.delayUntilRecursion,
    strategy: {
      type: e.constant ? ('constant' as const) : ('selective' as const),
      keys: e.keys,
      keys_secondary: {
        logic:
          e.selectiveLogic === 3
            ? 'and_all'
            : e.selectiveLogic === 2
              ? 'not_any'
              : e.selectiveLogic === 1
                ? 'not_all'
                : 'and_any',
        keys: e.secondaryKeys,
      },
      scan_depth: e.scanDepth ?? ('same_as_global' as const),
    },
  };
}

function normalizeSandboxEntryToLorebookEntry(
  raw: Record<string, unknown>,
  fallbackIndex: number,
): Lorebook['entries'][number] {
  const strat =
    raw.strategy && typeof raw.strategy === 'object'
      ? (raw.strategy as Record<string, unknown>)
      : null;
  const stratSec =
    strat?.keys_secondary && typeof strat.keys_secondary === 'object'
      ? (strat.keys_secondary as Record<string, unknown>)
      : null;
  const keys = Array.isArray(raw.keys)
    ? raw.keys.map(String)
    : Array.isArray(strat?.keys)
      ? (strat.keys as unknown[]).map(String)
      : [];
  const secondaryKeys = Array.isArray(raw.secondary_keys)
    ? raw.secondary_keys.map(String)
    : Array.isArray(raw.secondaryKeys)
      ? raw.secondaryKeys.map(String)
      : Array.isArray(stratSec?.keys)
        ? (stratSec.keys as unknown[]).map(String)
        : [];
  const constant =
    typeof raw.constant === 'boolean'
      ? raw.constant
      : strat?.type === 'constant';
  const enabled =
    typeof raw.enabled === 'boolean'
      ? raw.enabled
      : typeof raw.disable === 'boolean'
        ? !raw.disable
        : true;
  const rawLogic = raw.selective_logic ?? raw.selectiveLogic;
  let selectiveLogic: 0 | 1 | 2 | 3 = 0;
  if (rawLogic === 1 || rawLogic === 2 || rawLogic === 3) {
    selectiveLogic = rawLogic;
  } else if (stratSec?.logic === 'and_all') {
    selectiveLogic = 3;
  } else if (stratSec?.logic === 'not_any') {
    selectiveLogic = 2;
  } else if (stratSec?.logic === 'not_all') {
    selectiveLogic = 1;
  }
  const posRaw = String(raw.position ?? 'after_char');
  const position: 'before_char' | 'after_char' | 'in_chat' =
    posRaw === 'before_char' || posRaw === 'in_chat' ? posRaw : 'after_char';
  const roleRaw = raw.role;
  const role: 'system' | 'user' | 'assistant' | undefined =
    roleRaw === 'system' || roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : undefined;
  return {
    uid:
      raw.uid !== undefined && raw.uid !== null && String(raw.uid) !== ''
        ? String(raw.uid)
        : `wb-${Date.now()}-${fallbackIndex}`,
    keys,
    secondaryKeys,
    selective: typeof raw.selective === 'boolean' ? raw.selective : !constant,
    selectiveLogic,
    constant,
    content: typeof raw.content === 'string' ? raw.content : '',
    comment:
      typeof raw.comment === 'string'
        ? raw.comment
        : typeof raw.name === 'string'
          ? raw.name
          : '',
    enabled,
    order: typeof raw.order === 'number' && !Number.isNaN(raw.order) ? raw.order : 100,
    position,
    depth: typeof raw.depth === 'number' ? raw.depth : undefined,
    role,
    caseSensitive:
      typeof raw.case_sensitive === 'boolean'
        ? raw.case_sensitive
        : typeof raw.caseSensitive === 'boolean'
          ? raw.caseSensitive
          : undefined,
    matchWholeWords:
      typeof raw.match_whole_words === 'boolean'
        ? raw.match_whole_words
        : typeof raw.matchWholeWords === 'boolean'
          ? raw.matchWholeWords
          : undefined,
    excludeRecursion:
      typeof raw.exclude_recursion === 'boolean'
        ? raw.exclude_recursion
        : typeof raw.excludeRecursion === 'boolean'
          ? raw.excludeRecursion
          : undefined,
    preventRecursion:
      typeof raw.prevent_recursion === 'boolean'
        ? raw.prevent_recursion
        : typeof raw.preventRecursion === 'boolean'
          ? raw.preventRecursion
          : undefined,
    delayUntilRecursion:
      typeof raw.delay_until_recursion === 'boolean'
        ? raw.delay_until_recursion
        : typeof raw.delayUntilRecursion === 'boolean'
          ? raw.delayUntilRecursion
          : undefined,
    scanDepth:
      typeof strat?.scan_depth === 'number'
        ? strat.scan_depth
        : typeof raw.scanDepth === 'number'
          ? raw.scanDepth
          : undefined,
  };
}

server.registerTool(
  'story_app_get_card_frontend',
  {
    title: 'Get Active Card Frontend Assets',
    description: 'Fetch the active card HTML status-bar regexes, tavern_helper scripts, worldbook snapshots, and custom extensions for the side-pane TavernHelper shim.',
    inputSchema: {
      cardId: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ cardId }) => {
    const config = storage.getConfig();
    const id = cardId ?? config.activeCardId;
    const card = id ? storage.getCard(id) : null;
    if (!card) {
      return {
        content: [{ type: 'text', text: 'no active card' }],
        structuredContent: {
          htmlTemplates: [],
          helperScripts: [],
          customExtensions: {},
          worldbookNames: [],
          charWorldbookName: null,
        },
      };
    }
    const htmlTemplates = (card.regexScripts ?? [])
      .filter((r) => !r.disabled && isHtmlBeautifyRegex(r.replaceString))
      .map((r) => ({
        name: r.scriptName,
        findRegex: r.findRegex,
        html: r.replaceString
          .replace(/^\s*```(?:html)?\s*/i, '')
          .replace(/\s*```\s*$/i, ''),
      }));

    const activePreset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
    const helperScripts = [
      ...(activePreset?.tavernHelperScripts ?? []).filter((s) => s.enabled),
      ...(card.tavernHelperScripts ?? []).filter((s) => s.enabled),
    ];

    // Send only lightweight worldbook names at bootstrap; full entries are fetched on-demand via
    // `story_app_get_worldbook` so huge worldbooks are never truncated or bloat startup payloads.
    const worldbookNames: string[] = [];
    if (card.embeddedLorebook?.name) {
      worldbookNames.push(card.embeddedLorebook.name);
    }
    for (const lbId of config.activeLorebookIds) {
      const lb = storage.getLorebook(lbId);
      if (lb?.name && !worldbookNames.includes(lb.name)) {
        worldbookNames.push(lb.name);
      }
    }

    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        cardId: card.id,
        cardName: card.name,
        htmlTemplates,
        helperScripts,
        customExtensions: card.customExtensions ?? {},
        worldbookNames,
        charWorldbookName: card.embeddedLorebook?.name ?? null,
        charData: {
          name: card.name,
          description: card.description,
          personality: card.personality,
          scenario: card.scenario,
          first_mes: card.firstMessage,
          tags: card.tags,
        },
      },
    };
  },
);

server.registerTool(
  'story_app_get_worldbook',
  {
    title: 'Get Single Worldbook Entries On Demand',
    description: 'Fetch full untruncated entries for a single worldbook (embedded or external) when requested by sandbox getWorldbook().',
    inputSchema: {
      bookName: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ bookName }) => {
    const config = storage.getConfig();
    const target = bookName.trim();
    const card = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    if (
      target &&
      card?.embeddedLorebook &&
      (card.embeddedLorebook.name === target || card.embeddedLorebook.id === target)
    ) {
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          found: true,
          bookName: card.embeddedLorebook.name,
          entries: card.embeddedLorebook.entries.map(serializeWorldbookEntryForSandbox),
        },
      };
    }
    const matched = storage
      .listLorebooks()
      .find((b) => b.name === target || b.id === target);
    if (matched) {
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          found: true,
          bookName: matched.name,
          entries: matched.entries.map(serializeWorldbookEntryForSandbox),
        },
      };
    }
    return {
      content: [{ type: 'text', text: 'not found' }],
      structuredContent: {
        found: false,
        bookName: target,
        entries: [],
      },
    };
  },
);

server.registerTool(
  'story_app_replace_worldbook_entries',
  {
    title: 'Replace Worldbook Entries from Sandbox Script',
    description: 'Persist worldbook entry updates triggered by JS-Slash-Runner worldbook APIs (replaceWorldbook / updateWorldbookWith / createWorldbookEntries / deleteWorldbookEntries).',
    inputSchema: {
      bookName: z.string(),
      entries: z.array(z.record(z.string(), z.unknown())),
    },
    _meta: APP_ONLY_META,
  },
  async ({ bookName, entries }) => {
    const config = storage.getConfig();
    const normalizedEntries = entries.map((e, idx) => normalizeSandboxEntryToLorebookEntry(e, idx));
    const card = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    if (
      bookName &&
      card?.embeddedLorebook &&
      (card.embeddedLorebook.name === bookName || card.embeddedLorebook.id === bookName)
    ) {
      card.embeddedLorebook.entries = normalizedEntries;
      storage.saveCard(card);
      return {
        content: [{ type: 'text', text: `updated embedded worldbook ${card.embeddedLorebook.name}` }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    const allBooks = storage.listLorebooks();
    const matched = allBooks.find((b) => b.name === bookName || b.id === bookName);
    if (matched) {
      matched.entries = normalizedEntries;
      storage.saveLorebook(matched);
      return {
        content: [{ type: 'text', text: `updated worldbook ${matched.name}` }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    return {
      content: [{ type: 'text', text: `worldbook not found: ${bookName}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

const pendingUploads = new Map<string, { chunks: Array<string | undefined>; total: number; createdAt: number }>();

function cleanupExpiredUploads(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, rec] of pendingUploads.entries()) {
    if (rec.createdAt < cutoff) pendingUploads.delete(id);
  }
}

function consumeUploadPayload(uploadId: string): string {
  const rec = pendingUploads.get(uploadId);
  if (!rec) {
    throw new Error(`Upload session not found or expired: ${uploadId}`);
  }
  for (let i = 0; i < rec.total; i += 1) {
    if (typeof rec.chunks[i] !== 'string') {
      throw new Error(`Upload incomplete: missing chunk ${i + 1}/${rec.total}`);
    }
  }
  pendingUploads.delete(uploadId);
  return rec.chunks.join('');
}

server.registerTool(
  'story_app_upload_chunk',
  {
    title: 'Upload Asset Chunk',
    description: 'Upload a single chunk of a large card, preset, or lorebook payload.',
    inputSchema: {
      uploadId: z.string(),
      chunkIndex: z.number().int().min(0),
      totalChunks: z.number().int().min(1).max(200),
      data: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ uploadId, chunkIndex, totalChunks, data }) => {
    cleanupExpiredUploads();
    let rec = pendingUploads.get(uploadId);
    if (!rec || rec.total !== totalChunks) {
      rec = { chunks: new Array(totalChunks), total: totalChunks, createdAt: Date.now() };
      pendingUploads.set(uploadId, rec);
    }
    if (chunkIndex >= totalChunks) {
      throw new Error(`Invalid chunk index ${chunkIndex} for total ${totalChunks}`);
    }
    rec.chunks[chunkIndex] = data;
    rec.createdAt = Date.now();
    const received = rec.chunks.filter((c) => typeof c === 'string').length;
    return {
      content: [{ type: 'text', text: `chunk ${chunkIndex + 1}/${totalChunks}` }],
      structuredContent: { uploadId, received, totalChunks },
    };
  },
);

server.registerTool(
  'story_app_import_card',
  {
    title: 'Import Character Card',
    description: 'Import a Character Card PNG or JSON character card (supports direct JSON, base64, or chunked uploadId).',
    inputSchema: {
      filename: z.string(),
      contentBase64: z.string().optional(),
      jsonText: z.string().optional(),
      uploadId: z.string().optional(),
      avatarDataUrl: z.string().optional(),
      isPng: z.boolean().optional(),
      setActive: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, contentBase64, jsonText, uploadId, avatarDataUrl, isPng, setActive }) => {
    const fallbackName = filename.replace(/\.(png|json)$/i, '');
    let card: CharacterCard;
    if (uploadId || jsonText !== undefined) {
      const resolvedJson = uploadId ? consumeUploadPayload(uploadId) : jsonText!;
      card = parseCharacterCardJson(JSON.parse(resolvedJson), {
        fallbackName,
        avatarDataUrl,
      });
    } else if (contentBase64) {
      const buf = Buffer.from(contentBase64, 'base64');
      card = isPng
        ? parseCharacterCardPng(buf, fallbackName)
        : parseCharacterCardJson(JSON.parse(buf.toString('utf8')), { fallbackName, avatarDataUrl });
    } else {
      throw new Error('Missing card payload (expected jsonText, uploadId, or contentBase64)');
    }
    storage.saveCard(card);
    if (setActive !== false) {
      const cfg = storage.saveConfig({ activeCardId: card.id });
      syncSessionToStoryKey(cfg, getActiveStoryKey(cfg));
    }
    return {
      content: [{ type: 'text', text: `Imported card ${card.name}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_import_preset',
  {
    title: 'Import Community Preset',
    description: 'Import a Character Card Chat Completion Preset JSON.',
    inputSchema: {
      filename: z.string(),
      jsonText: z.string().optional(),
      uploadId: z.string().optional(),
      setActive: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, jsonText, uploadId, setActive }) => {
    const resolvedJson = uploadId ? consumeUploadPayload(uploadId) : jsonText;
    if (!resolvedJson) throw new Error('Missing preset payload');
    const raw = JSON.parse(resolvedJson);
    const name = filename.replace(/\.json$/i, '');
    const preset = parsePresetJson(raw, { name });
    storage.savePreset(preset);
    if (setActive !== false) {
      storage.saveConfig({ activePresetId: preset.id });
    }
    return {
      content: [{ type: 'text', text: `Imported preset ${preset.name}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_import_lorebook',
  {
    title: 'Import World Info Lorebook',
    description: 'Import a Character Card World Info JSON.',
    inputSchema: {
      filename: z.string(),
      jsonText: z.string().optional(),
      uploadId: z.string().optional(),
      activate: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, jsonText, uploadId, activate }) => {
    const resolvedJson = uploadId ? consumeUploadPayload(uploadId) : jsonText;
    if (!resolvedJson) throw new Error('Missing lorebook payload');
    const raw = JSON.parse(resolvedJson);
    const name = filename.replace(/\.json$/i, '');
    const book = parseLorebookJson(raw, name);
    storage.saveLorebook(book);
    if (activate !== false) {
      const cfg = storage.getConfig();
      if (!cfg.activeLorebookIds.includes(book.id)) {
        storage.saveConfig({ activeLorebookIds: [...cfg.activeLorebookIds, book.id] });
      }
    }
    return {
      content: [{ type: 'text', text: `Imported lorebook ${book.name}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_toggle_preset_prompt',
  {
    title: 'Toggle Preset Prompt Item',
    description: 'Enable or disable a single prompt item inside a preset.',
    inputSchema: {
      presetId: z.string(),
      identifier: z.string(),
      enabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ presetId, identifier, enabled }) => {
    const preset = storage.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const target = preset.prompts.find((p) => p.identifier === identifier);
    if (target) {
      target.enabled = enabled;
      storage.savePreset(preset);
    }
    return {
      content: [{ type: 'text', text: 'updated' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_get_preset_prompt',
  {
    title: 'Get Preset Prompt Full Content',
    description: 'Fetch the full content and metadata of a single prompt item inside a preset for inline editing.',
    inputSchema: {
      presetId: z.string(),
      identifier: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ presetId, identifier }) => {
    const preset = storage.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const item = preset.prompts.find((p) => p.identifier === identifier);
    if (!item) throw new Error(`Prompt item not found: ${identifier}`);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { presetId, item },
    };
  },
);

server.registerTool(
  'story_app_edit_preset_prompt',
  {
    title: 'Edit Preset Prompt Content',
    description: 'Update the content or role of a single prompt item inside a preset.',
    inputSchema: {
      presetId: z.string(),
      identifier: z.string(),
      content: z.string(),
      role: z.enum(['system', 'user', 'assistant']).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ presetId, identifier, content, role }) => {
    const preset = storage.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const target = preset.prompts.find((p) => p.identifier === identifier);
    if (target) {
      target.content = content;
      target.isSectionHeader = !target.marker && content.trim().length === 0;
      if (role) target.role = role;
      storage.savePreset(preset);
    }
    return {
      content: [{ type: 'text', text: 'prompt updated' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_toggle_preset_regex',
  {
    title: 'Toggle Preset Regex Script',
    description: 'Enable or disable a regex script inside a preset.',
    inputSchema: {
      presetId: z.string(),
      index: z.number(),
      disabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ presetId, index, disabled }) => {
    const preset = storage.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const target = preset.regexScripts[index];
    if (target) {
      target.disabled = disabled;
      storage.savePreset(preset);
    }
    return {
      content: [{ type: 'text', text: 'regex toggled' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_toggle_preset_helper_script',
  {
    title: 'Toggle Preset Helper Script',
    description: 'Enable or disable a helper script inside a preset.',
    inputSchema: {
      presetId: z.string(),
      index: z.number(),
      enabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ presetId, index, enabled }) => {
    const preset = storage.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const target = preset.tavernHelperScripts?.[index];
    if (target) {
      target.enabled = enabled;
      storage.savePreset(preset);
    }
    return {
      content: [{ type: 'text', text: 'preset helper script toggled' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_toggle_card_regex',
  {
    title: 'Toggle Character Card Regex Script',
    description: 'Enable or disable a regex script inside a character card.',
    inputSchema: {
      cardId: z.string(),
      index: z.number(),
      disabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ cardId, index, disabled }) => {
    const card = storage.getCard(cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    const target = card.regexScripts?.[index];
    if (target) {
      target.disabled = disabled;
      storage.saveCard(card);
    }
    return {
      content: [{ type: 'text', text: 'card regex toggled' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_toggle_card_helper_script',
  {
    title: 'Toggle Character Card Helper Script',
    description: 'Enable or disable a helper script inside a character card.',
    inputSchema: {
      cardId: z.string(),
      index: z.number(),
      enabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ cardId, index, enabled }) => {
    const card = storage.getCard(cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    const target = card.tavernHelperScripts?.[index];
    if (target) {
      target.enabled = enabled;
      storage.saveCard(card);
    }
    return {
      content: [{ type: 'text', text: 'card helper script toggled' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_update_config',
  {
    title: 'Update Tavern Config',
    description: 'Update active card, preset, lorebooks, user persona, or injection settings.',
    inputSchema: {
      enabled: z.boolean().optional(),
      userName: z.string().optional(),
      userPersona: z.string().optional(),
      activeCardId: z.string().nullable().optional(),
      activePresetId: z.string().nullable().optional(),
      activeLorebookIds: z.array(z.string()).optional(),
      cooldownTurns: z.number().optional(),
      postHistoryRefreshInterval: z.number().optional(),
      enablePostHistoryInjection: z.boolean().optional(),
      statelessPerTurn: z.boolean().optional(),
      directorMode: z.boolean().optional(),
      uiScale: z.number().min(80).max(130).optional(),
      proseFontSize: z.number().min(12).max(22).optional(),
      proseLineHeight: z.number().min(1.4).max(2.2).optional(),
      maxReadingWidth: z.number().min(0).max(1400).optional(),
      enableRegexBeautify: z.boolean().optional(),
      unknownTagMode: z.enum(['fold', 'keep', 'hide']).optional(),
      authorsNote: z.string().optional(),
      authorsNoteEnabled: z.boolean().optional(),
      visibleFloorLimit: z.number().int().min(2).max(200).optional(),
      memoryPlugin: z
        .object({
          enabled: z.boolean().optional(),
          recentFullFloors: z.number().int().min(1).max(200).optional(),
          summaryLengthHint: z.number().int().min(50).max(800).optional(),
          customPrompt: z.string().optional(),
          summaryDisplayMode: z.enum(['fold', 'hide']).optional(),
        })
        .optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (patch) => {
    const prev = storage.getConfig();
    const mergedPatch: Partial<TavernConfig> = { ...patch } as Partial<TavernConfig>;
    if (patch.memoryPlugin) {
      mergedPatch.memoryPlugin = resolveMemoryPluginConfig({
        ...prev.memoryPlugin,
        ...patch.memoryPlugin,
      });
    }
    const next = storage.saveConfig(mergedPatch);
    // When switching active card, restore active chat slot's statData or card [initvar]
    if (patch.activeCardId !== undefined && patch.activeCardId !== prev.activeCardId) {
      if (patch.activeCardId) {
        syncSessionToStoryKey(next, getActiveStoryKey(next));
      } else {
        const session = storage.getSession(DEFAULT_SESSION_ID);
        session.statData = {};
        session.state = createDefaultState();
        session.latestOptions = [];
        storage.saveSession(session);
      }
    }
    return {
      content: [{ type: 'text', text: 'config updated' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_select_greeting',
  {
    title: 'Select Opening Greeting (Alternate Greetings)',
    description: 'Switch the active opening greeting index (0 = first_mes, 1..N = alternate_greetings) for the current card/slot.',
    inputSchema: {
      index: z.number().int().min(0),
    },
    _meta: APP_ONLY_META,
  },
  async ({ index }) => {
    const config = storage.getConfig();
    if (!config.activeCardId) {
      return {
        content: [{ type: 'text', text: 'no active card' }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    const card = storage.getCard(config.activeCardId);
    const total = card ? 1 + (card.alternateGreetings?.length ?? 0) : 1;
    const clamped = Math.max(0, Math.min(total - 1, index));
    const storyKey = getActiveStoryKey(config);
    const nextConfig = storage.saveConfig({
      activeGreetingIndices: {
        ...(config.activeGreetingIndices ?? {}),
        [storyKey]: clamped,
      },
    });
    // When no turns have been committed yet, re-initialize MVU stat_data with this opening's embedded <update> patch
    if (storyLog.readTurns(storyKey).length === 0) {
      syncSessionToStoryKey(nextConfig, storyKey);
    }
    return {
      content: [{ type: 'text', text: `selected greeting ${clamped + 1}/${total}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_edit_greeting',
  {
    title: 'Edit Active Opening Greeting Content',
    description: 'Edit the text of the currently selected opening greeting (firstMessage or alternateGreeting) on the active card.',
    inputSchema: {
      index: z.number().int().min(0),
      content: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ index, content }) => {
    const config = storage.getConfig();
    if (!config.activeCardId) {
      throw new Error('No active character card');
    }
    const card = storage.getCard(config.activeCardId);
    if (!card) {
      throw new Error(`Card not found: ${config.activeCardId}`);
    }
    if (index === 0) {
      card.firstMessage = content;
    } else {
      const alts = [...(card.alternateGreetings ?? [])];
      if (index - 1 >= 0 && index - 1 < alts.length) {
        alts[index - 1] = content;
        card.alternateGreetings = alts;
      }
    }
    storage.saveCard(card);
    return {
      content: [{ type: 'text', text: `edited greeting #${index}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_new_chat_slot',
  {
    title: 'Start New Playthrough Chat Slot',
    description:
      'Create a brand-new playthrough chat log for the active card without deleting previous playthroughs, and reset MVU stat_data from [initvar].',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const config = storage.getConfig();
    if (!config.activeCardId) {
      return {
        content: [{ type: 'text', text: 'no active card' }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    const { slotId, storyKey } = storyLog.createSlot(config.activeCardId);
    const next = storage.saveConfig({
      activeChatSlots: {
        ...(config.activeChatSlots ?? {}),
        [config.activeCardId]: slotId,
      },
    });
    syncSessionToStoryKey(next, storyKey);
    return {
      content: [{ type: 'text', text: `created new playthrough slot ${slotId}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_switch_chat_slot',
  {
    title: 'Switch Playthrough Chat Slot',
    description: 'Switch the active character card to an existing saved playthrough chat slot.',
    inputSchema: {
      slotId: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ slotId }) => {
    const config = storage.getConfig();
    if (!config.activeCardId) {
      return {
        content: [{ type: 'text', text: 'no active card' }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    const next = storage.saveConfig({
      activeChatSlots: {
        ...(config.activeChatSlots ?? {}),
        [config.activeCardId]: slotId || 'default',
      },
    });
    syncSessionToStoryKey(next, getActiveStoryKey(next));
    return {
      content: [{ type: 'text', text: `switched to slot ${slotId}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_delete_chat_slot',
  {
    title: 'Delete Playthrough Chat Slot',
    description: 'Permanently delete a specific playthrough chat slot for the active card.',
    inputSchema: {
      slotId: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ slotId }) => {
    const config = storage.getConfig();
    if (!config.activeCardId) {
      return {
        content: [{ type: 'text', text: 'no active card' }],
        structuredContent: buildBootstrapPayload(),
      };
    }
    const storyKey = resolveStoryKey(config.activeCardId, slotId);
    storyLog.deleteSlot(storyKey);
    const currentSlot = config.activeChatSlots?.[config.activeCardId] || 'default';
    let next = config;
    if (currentSlot === slotId) {
      next = storage.saveConfig({
        activeChatSlots: {
          ...(config.activeChatSlots ?? {}),
          [config.activeCardId]: 'default',
        },
      });
    }
    syncSessionToStoryKey(next, getActiveStoryKey(next));
    return {
      content: [{ type: 'text', text: `deleted slot ${slotId}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_set_stat_data',
  {
    title: 'Update MVU stat_data from Side-Pane Shim',
    description: 'Persist stat_data changes triggered by a card frontend or TavernHelper shim.',
    inputSchema: {
      statData: z.record(z.unknown()),
    },
    _meta: APP_ONLY_META,
  },
  async ({ statData }) => {
    const session = storage.getSession(DEFAULT_SESSION_ID);
    session.statData = statData;
    storage.saveSession(session);
    return {
      content: [{ type: 'text', text: 'stat_data saved' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_edit_turn',
  {
    title: 'Edit Story Turn Narrative',
    description: 'Edit a committed turn narrative in the local JSONL story log.',
    inputSchema: {
      turnId: z.string(),
      narrative: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ turnId, narrative }) => {
    const config = storage.getConfig();
    storyLog.editTurn(getActiveStoryKey(config), turnId, narrative);
    return {
      content: [{ type: 'text', text: 'turn edited' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_edit_turn_summary',
  {
    title: 'Edit Story Turn Memory Summary',
    description: 'Edit or backfill the concise memorySummary for a specific turn in the JSONL story log.',
    inputSchema: {
      turnId: z.string(),
      memorySummary: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ turnId, memorySummary }) => {
    const config = storage.getConfig();
    storyLog.editTurnSummary(getActiveStoryKey(config), turnId, memorySummary);
    return {
      content: [{ type: 'text', text: 'turn memory summary updated' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_rollback_turn',
  {
    title: 'Rollback or Delete Story Turn (with MVU stat_data restore)',
    description:
      'Roll back JSONL story log to a specific turn and automatically restore MVU stat_data to that exact floor.',
    inputSchema: {
      turnId: z.string(),
      inclusive: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ turnId, inclusive }) => {
    const config = storage.getConfig();
    const storyKey = getActiveStoryKey(config);
    storyLog.rollbackToTurn(storyKey, turnId, inclusive);

    // Restore MVU stat_data (including alternate greeting index), live state, and latestOptions atomically
    syncSessionToStoryKey(config, storyKey);

    return {
      content: [{ type: 'text', text: 'story and stat_data rolled back' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_prepare_fork',
  {
    title: 'Prepare Branched Session Fork',
    description: 'Stage the current edited/rolled-back JSONL story log and MVU stat_data so the next new conversation resumes seamlessly.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const config = storage.getConfig();
    const cardId = config.activeCardId || 'default';
    const session = storage.getSession(DEFAULT_SESSION_ID);
    const turns = storyLog.readTurns(getActiveStoryKey(config));
    storage.setPendingFork({
      cardId,
      turns,
      state: { ...session.state },
      statData: session.statData ?? {},
      createdAt: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text', text: 'pending fork staged' }],
      structuredContent: {
        ...buildBootstrapPayload(),
        forkReady: true,
        turnCount: turns.length,
      },
    };
  },
);

server.registerTool(
  'story_app_toggle_card_lore_entry',
  {
    title: 'Toggle Embedded Card Lorebook Entry',
    description: 'Enable or disable a single entry inside a character card embedded lorebook.',
    inputSchema: {
      cardId: z.string(),
      uid: z.string(),
      enabled: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ cardId, uid, enabled }) => {
    const card = storage.getCard(cardId);
    if (!card || !card.embeddedLorebook) throw new Error(`Embedded lorebook not found for card: ${cardId}`);
    const entry = card.embeddedLorebook.entries.find((e) => e.uid === uid);
    if (entry) {
      entry.enabled = enabled;
      storage.saveCard(card);
    }
    return {
      content: [{ type: 'text', text: 'embedded lore entry toggled' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'story_app_stage_director_input',
  {
    title: 'Stage Real User Input for Director Mode',
    description:
      'Stages the real user turn text locally so the side-pane reader can send only a minimal floor-trigger signal to the main director chat.',
    inputSchema: {
      text: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ text }) => {
    const trimmed = text.trim();
    const now = Date.now();
    const session = storage.getSession(DEFAULT_SESSION_ID);
    // Stage ONLY into stagedSidePaneInput (never pendingDirectorInput directly) so unbound / failed sends
    // can never hijack unrelated sessions or subagents; PreInvocation promotes it only after verifying rpModeActive.
    session.stagedSidePaneInput = trimmed || undefined;
    session.stagedSidePaneInputAt = trimmed ? now : undefined;
    storage.saveSession(session);
    return {
      content: [{ type: 'text', text: 'staged' }],
      structuredContent: { ok: true },
    };
  },
);

server.registerTool(
  'story_app_delete_asset',
  {
    title: 'Delete Tavern Asset',
    description: 'Delete a card, preset, or lorebook by id.',
    inputSchema: {
      kind: z.enum(['card', 'preset', 'lorebook']),
      id: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ kind, id }) => {
    const prevCardId = storage.getConfig().activeCardId;
    if (kind === 'card') {
      storage.deleteCard(id);
      if (prevCardId === id) {
        const session = storage.getSession(DEFAULT_SESSION_ID);
        session.statData = {};
        session.state = createDefaultState();
        session.latestOptions = [];
        storage.saveSession(session);
      }
    }
    if (kind === 'preset') storage.deletePreset(id);
    if (kind === 'lorebook') storage.deleteLorebook(id);
    return {
      content: [{ type: 'text', text: 'deleted' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('TavernInAGY MCP server error:', err);
  process.exit(1);
});
