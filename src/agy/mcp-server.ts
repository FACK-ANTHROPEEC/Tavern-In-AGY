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
import { StoryLogStore } from '../core/story-log.js';
import type { Lorebook } from '../core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://tavern/app.html';
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

function buildBootstrapPayload(opts?: { omitAvatars?: boolean }) {
  const config = storage.getConfig();
  const cards = storage.listCards();
  const presets = storage.listPresets();
  const lorebooks = storage.listLorebooks();
  const snapshots = storage.listSnapshots();
  const session = storage.getSession(DEFAULT_SESSION_ID);
  const storyKey = config.activeCardId || 'default';
  const storyTurns = storyLog.readTurns(storyKey);

  return {
    config,
    cards: cards.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      personality: c.personality,
      scenario: c.scenario,
      firstMessage: c.firstMessage,
      tags: c.tags,
      avatarDataUrl: opts?.omitAvatars ? undefined : c.avatarDataUrl,
      hasEmbeddedLorebook: Boolean(c.embeddedLorebook),
      embeddedLorebookCount: c.embeddedLorebook?.entries.length ?? 0,
      importedAt: c.importedAt,
    })),
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      regexCount: p.regexScripts.length,
      samplingMeta: p.samplingMeta,
      prompts: p.prompts.map((item) => ({
        identifier: item.identifier,
        name: item.name,
        role: item.role,
        enabled: item.enabled,
        marker: item.marker,
        isSectionHeader: item.isSectionHeader,
        charLength: item.content.length,
      })),
      importedAt: p.importedAt,
    })),
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
    latestOptions: session.latestOptions,
    storyTurns: storyTurns.slice(-50),
    dataDir: storage.rootDir,
  };
}

const server = new McpServer({
  name: 'tavern-in-agy',
  version: '0.5.0',
});

// UI Resource (SEP-1865 MCP App)
server.resource(
  'tavern-app',
  APP_URI,
  {
    description: 'TavernInAGY interactive Roleplay console',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: false } },
  } as Record<string, unknown>,
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: loadAppHtml(),
      },
    ],
  }),
);

// Side-pane & Global Entrypoint Tool
server.registerTool(
  'tavern_open_panel',
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
    // Keep trajectory step payload under 1 MiB; App.tsx fetches full avatars via app-only bootstrap
    const payload = buildBootstrapPayload({ omitAvatars: true });
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
  'tavern_commit_turn',
  {
    title: 'Commit RP Turn & Refresh MVU Panel',
    description:
      'Persist the current Roleplay narrative turn to the local JSONL story log, update live character stats (location, timeOfDay, mood, outfit, affection, inventory, goals, summary), and live-refresh the TavernInAGY side-pane MVU panel.',
    inputSchema: {
      conversationId: z.string().optional(),
      userMessage: z.string().optional(),
      narrative: z.string(),
      thought: z.string().optional(),
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
      options: z
        .array(
          z.object({
            label: z.string(),
            category: z.string().optional(),
            text: z.string(),
          }),
        )
        .optional(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async (args) => {
    const config = storage.getConfig();
    const session = storage.getSession(args.conversationId || DEFAULT_SESSION_ID);
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

    const normalizedOptions = (args.options ?? []).map((o) => ({
      label: o.label,
      category: o.category ?? o.label,
      text: o.text,
    }));
    if (normalizedOptions.length > 0) {
      session.latestOptions = normalizedOptions;
    }
    storage.saveSession(session);

    const storyKey = config.activeCardId || 'default';
    const turn = storyLog.appendTurn(storyKey, {
      userMessage: args.userMessage,
      narrative: args.narrative,
      thought: args.thought,
      statsSnapshot: {
        location: st.location,
        timeOfDay: st.timeOfDay,
        mood: st.mood,
        outfit: st.outfit,
        affection: st.affection,
      },
      options: normalizedOptions.length > 0 ? normalizedOptions : undefined,
    });

    const payload = buildBootstrapPayload({ omitAvatars: true });
    return {
      content: [
        {
          type: 'text',
          text: `Committed turn #${turn.index} (${turn.turnId}). Live state: location="${st.location}", mood="${st.mood}", outfit="${st.outfit}", affection=${st.affection}.`,
        },
      ],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  'tavern_get_state',
  {
    title: 'Get Live RP State',
    description:
      'Read the active character card summary, current live RP state (location, mood, outfit, affection, inventory, goals, summary), and active preset name.',
    inputSchema: {
      conversationId: z.string().optional(),
    },
  },
  async ({ conversationId }) => {
    const config = storage.getConfig();
    const card = config.activeCardId ? storage.getCard(config.activeCardId) : null;
    const preset = config.activePresetId ? storage.getPreset(config.activePresetId) : null;
    const session = storage.getSession(conversationId || DEFAULT_SESSION_ID);
    const data = {
      enabled: config.enabled,
      activeCard: card ? { id: card.id, name: card.name, scenario: card.scenario } : null,
      activePreset: preset ? { id: preset.id, name: preset.name } : null,
      state: session.state,
      turnCount: session.turnCount,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  },
);

server.registerTool(
  'tavern_update_state',
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
    const session = storage.getSession(args.conversationId || DEFAULT_SESSION_ID);
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
  'tavern_search_lorebook',
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
  'tavern_save_snapshot',
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
  async ({ title, summary, conversationId }) => {
    const config = storage.getConfig();
    const session = storage.getSession(conversationId || DEFAULT_SESSION_ID);
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
  'tavern_app_bootstrap',
  {
    title: 'Bootstrap App Data',
    description: 'Fetch all cards, presets, lorebooks, config, story turns, and session state for the side-pane UI.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: buildBootstrapPayload(),
  }),
);

server.registerTool(
  'tavern_app_import_card',
  {
    title: 'Import Character Card',
    description: 'Import a SillyTavern PNG or JSON character card.',
    inputSchema: {
      filename: z.string(),
      contentBase64: z.string(),
      isPng: z.boolean(),
      setActive: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, contentBase64, isPng, setActive }) => {
    const buf = Buffer.from(contentBase64, 'base64');
    const fallbackName = filename.replace(/\.(png|json)$/i, '');
    const card = isPng
      ? parseCharacterCardPng(buf, fallbackName)
      : parseCharacterCardJson(JSON.parse(buf.toString('utf8')), { fallbackName });
    storage.saveCard(card);
    if (setActive !== false) {
      storage.saveConfig({ activeCardId: card.id });
    }
    return {
      content: [{ type: 'text', text: `Imported card ${card.name}` }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'tavern_app_import_preset',
  {
    title: 'Import Community Preset',
    description: 'Import a SillyTavern Chat Completion Preset JSON.',
    inputSchema: {
      filename: z.string(),
      jsonText: z.string(),
      setActive: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, jsonText, setActive }) => {
    const raw = JSON.parse(jsonText);
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
  'tavern_app_import_lorebook',
  {
    title: 'Import World Info Lorebook',
    description: 'Import a SillyTavern World Info JSON.',
    inputSchema: {
      filename: z.string(),
      jsonText: z.string(),
      activate: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ filename, jsonText, activate }) => {
    const raw = JSON.parse(jsonText);
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
  'tavern_app_toggle_preset_prompt',
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
  'tavern_app_update_config',
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
    },
    _meta: APP_ONLY_META,
  },
  async (patch) => {
    storage.saveConfig(patch);
    return {
      content: [{ type: 'text', text: 'config updated' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'tavern_app_edit_turn',
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
    storyLog.editTurn(config.activeCardId || 'default', turnId, narrative);
    return {
      content: [{ type: 'text', text: 'turn edited' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'tavern_app_rollback_turn',
  {
    title: 'Rollback or Delete Story Turn',
    description: 'Roll back JSONL story log to a specific turn (inclusive=true keeps it; inclusive=false deletes it for re-roll).',
    inputSchema: {
      turnId: z.string(),
      inclusive: z.boolean(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ turnId, inclusive }) => {
    const config = storage.getConfig();
    storyLog.rollbackToTurn(config.activeCardId || 'default', turnId, inclusive);
    return {
      content: [{ type: 'text', text: 'story rolled back' }],
      structuredContent: buildBootstrapPayload(),
    };
  },
);

server.registerTool(
  'tavern_app_prepare_fork',
  {
    title: 'Prepare Branched Session Fork',
    description: 'Stage the current edited/rolled-back JSONL story log so the next new conversation resumes seamlessly.',
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const config = storage.getConfig();
    const cardId = config.activeCardId || 'default';
    const session = storage.getSession(DEFAULT_SESSION_ID);
    const turns = storyLog.readTurns(cardId);
    storage.setPendingFork({
      cardId,
      turns,
      state: { ...session.state },
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
  'tavern_app_delete_asset',
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
    if (kind === 'card') storage.deleteCard(id);
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
