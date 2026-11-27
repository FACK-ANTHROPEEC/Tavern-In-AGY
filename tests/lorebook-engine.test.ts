import { describe, it, expect } from 'vitest';
import { parseLorebookJson, scanLorebooks } from '../src/core/lorebook-engine.js';
import { assembleSessionStart } from '../src/core/prompt-assembler.js';
import type { CharacterCard, Preset, SessionRuntime, TavernConfig } from '../src/core/types.js';

describe('lorebook-engine', () => {
  const rawBook = {
    name: 'Test World',
    scan_depth: 3,
    token_budget: 2048,
    recursive_scanning: true,
    entries: {
      '0': {
        uid: 0,
        key: ['ignored'],
        constant: true,
        position: 0,
        content: 'The world has two moons.',
        comment: 'Two Moons',
        order: 50,
        disable: false,
      },
      '1': {
        uid: 1,
        key: ['银月城', '/silver\\s+city/i'],
        constant: false,
        content: '银月城由秘银议会统治。',
        comment: 'Silver City',
        order: 100,
        disable: false,
      },
      '2': {
        uid: 2,
        key: ['秘银议会'],
        constant: false,
        content: '秘银议会共有七位大法师。',
        comment: 'Mithril Council',
        order: 90,
        disable: false,
      },
      '3': {
        uid: 3,
        key: ['酒馆'],
        keysecondary: ['暗号'],
        selective: true,
        selectiveLogic: 0, // AND_ANY
        constant: false,
        content: '酒馆地下室有密道。',
        comment: 'Tavern Basement',
        order: 80,
        disable: false,
      },
    },
  };

  it('separates constant entries, matches regex/recursive entries, and applies cooldown', () => {
    const book = parseLorebookJson(rawBook);
    expect(book.entries).toHaveLength(4);

    // Turn 1: mention "Silver City" -> triggers entry 1, recursively triggers entry 2
    const res1 = scanLorebooks([book], {
      recentMessages: ['We just arrived at the Silver City gates.'],
      currentTurn: 1,
      cooldownTurns: 10,
      injectedLorebookTurns: {},
    });

    expect(res1.constantBefore).toHaveLength(1);
    expect(res1.triggered.map((x) => x.entry.comment)).toEqual(['Silver City', 'Mithril Council']);

    // Turn 5: mention again within cooldown -> both skipped!
    const injectedTurns: Record<string, number> = {};
    for (const item of res1.triggered) injectedTurns[item.entryKey] = 1;

    const res2 = scanLorebooks([book], {
      recentMessages: ['Tell me more about 银月城'],
      currentTurn: 5,
      cooldownTurns: 10,
      injectedLorebookTurns: injectedTurns,
    });
    expect(res2.triggered).toHaveLength(0);
    expect(res2.skippedByCooldown).toHaveLength(2);

    // Turn 12: past cooldown -> triggers again!
    const res3 = scanLorebooks([book], {
      recentMessages: ['Back to 银月城'],
      currentTurn: 12,
      cooldownTurns: 10,
      injectedLorebookTurns: injectedTurns,
    });
    expect(res3.triggered).toHaveLength(2);
  });

  it('enforces selective secondary keys', () => {
    const book = parseLorebookJson(rawBook);
    const miss = scanLorebooks([book], {
      recentMessages: ['我去酒馆喝一杯'],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(miss.triggered).toHaveLength(0);

    const hit = scanLorebooks([book], {
      recentMessages: ['我去酒馆对暗号'],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(hit.triggered.map((x) => x.entry.comment)).toEqual(['Tavern Basement']);
  });

  it('parses ST V2/V3 entry.extensions recursion & scan_depth flags and prevents cross-character cascade', () => {
    const stV3Book = parseLorebookJson({
      name: 'ST V3 Character Book',
      scan_depth: 4,
      recursive_scanning: true,
      entries: [
        {
          id: 1,
          keys: ['玄明宗'],
          comment: '徐圆圆简介',
          content: '徐圆圆是玄明宗灵兽峰峰主。',
          enabled: true,
          constant: false,
          insertion_order: 50,
          extensions: {
            position: 0,
            prevent_recursion: true,
            exclude_recursion: false,
          },
        },
        {
          id: 2,
          keys: ['徐圆圆'],
          comment: '徐圆圆激活',
          content: '【【徐圆圆】】',
          enabled: true,
          constant: false,
          insertion_order: 60,
          extensions: {
            position: 0,
            prevent_recursion: false,
            exclude_recursion: true,
          },
        },
        {
          id: 3,
          keys: ['【【徐圆圆】】'],
          comment: '徐圆圆完整设定',
          content: '徐圆圆完整人设详情',
          enabled: true,
          constant: false,
          insertion_order: 70,
          extensions: {
            position: 4,
            depth: 1,
            prevent_recursion: true,
            exclude_recursion: false,
          },
        },
        {
          id: 4,
          keys: ['古老记忆'],
          comment: '仅扫最近1条',
          content: '单条目 scan_depth=1 命中',
          enabled: true,
          constant: false,
          insertion_order: 40,
          extensions: {
            scan_depth: 1,
          },
        },
      ],
    });

    expect(stV3Book.entries[0].preventRecursion).toBe(true);
    expect(stV3Book.entries[1].excludeRecursion).toBe(true);
    expect(stV3Book.entries[2].position).toBe('in_chat');
    expect(stV3Book.entries[2].depth).toBe(1);
    expect(stV3Book.entries[3].scanDepth).toBe(1);

    // Mentioning "玄明宗" triggers ONLY "徐圆圆简介", NEVER cascading into "徐圆圆激活" or "徐圆圆完整设定"
    const res = scanLorebooks([stV3Book], {
      recentMessages: ['古老记忆在很久以前', '主角来到玄明宗大殿'],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(res.triggered.map((x) => x.entry.comment)).toEqual(['徐圆圆简介']);

    // Explicitly mentioning "徐圆圆" in chat triggers "徐圆圆激活" -> recursively triggers "徐圆圆完整设定"
    const resDirect = scanLorebooks([stV3Book], {
      recentMessages: ['徐圆圆走了过来'],
      currentTurn: 2,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(resDirect.triggered.map((x) => x.entry.comment)).toEqual(['徐圆圆完整设定', '徐圆圆激活']);
  });

  it('places both constant and triggered lorebook entries into exact ST slots (before_char, after_char, in_chat) sorted by order/depth', () => {
    const book = parseLorebookJson({
      name: 'Slot Routing Book',
      scan_depth: 4,
      recursive_scanning: true,
      entries: [
        {
          id: 1,
          keys: [],
          constant: true,
          enabled: true,
          insertion_order: 10,
          content: 'BEFORE_CONST_START',
          comment: 'before start',
          extensions: { position: 0 },
        },
        {
          id: 2,
          keys: ['叶婉君'],
          constant: false,
          enabled: true,
          insertion_order: 20,
          content: 'BEFORE_TRIGGERED_CHAR',
          comment: 'before triggered',
          extensions: { position: 0, prevent_recursion: true },
        },
        {
          id: 3,
          keys: [],
          constant: true,
          enabled: true,
          insertion_order: 30,
          content: 'BEFORE_CONST_END',
          comment: 'before end',
          extensions: { position: 0 },
        },
        {
          id: 4,
          keys: ['叶婉君'],
          constant: false,
          enabled: true,
          insertion_order: 15,
          content: 'AFTER_TRIGGERED_LORE',
          comment: 'after triggered',
          extensions: { position: 1, prevent_recursion: true },
        },
        {
          id: 5,
          keys: [],
          constant: true,
          enabled: true,
          insertion_order: 94,
          content: 'INCHAT_D0_START',
          comment: 'inchat start',
          extensions: { position: 4, depth: 0 },
        },
        {
          id: 6,
          keys: ['叶婉君'],
          constant: false,
          enabled: true,
          insertion_order: 95,
          content: 'INCHAT_D0_TRIGGERED',
          comment: 'inchat triggered',
          extensions: { position: 4, depth: 0, prevent_recursion: true },
        },
        {
          id: 7,
          keys: [],
          constant: true,
          enabled: true,
          insertion_order: 96,
          content: 'INCHAT_D0_END',
          comment: 'inchat end',
          extensions: { position: 4, depth: 0 },
        },
        {
          id: 8,
          keys: [],
          constant: true,
          enabled: true,
          insertion_order: 10,
          content: 'INCHAT_D3_STYLE',
          comment: 'inchat depth 3',
          extensions: { position: 4, depth: 3 },
        },
      ],
    });

    const card: CharacterCard = {
      id: 'card-slot-test',
      name: 'Tester',
      description: 'CHAR_DESC_MARKER',
      personality: '',
      scenario: '',
      firstMessage: 'OPENING_SCENE_MARKER',
      messageExample: '',
      systemPrompt: '',
      postHistoryInstructions: 'POST_HISTORY_MARKER',
      creatorNotes: '',
      tags: [],
      embeddedLorebook: book,
      importedAt: new Date().toISOString(),
    };

    const preset: Preset = {
      id: 'preset-slot-test',
      name: 'Slot Test Preset',
      prompts: [
        { identifier: 'worldInfoBefore', name: 'WI Before', role: 'system', content: '', enabled: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, isSectionHeader: false },
        { identifier: 'charDescription', name: 'Char Desc', role: 'system', content: '', enabled: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, isSectionHeader: false },
        { identifier: 'worldInfoAfter', name: 'WI After', role: 'system', content: '', enabled: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, isSectionHeader: false },
        { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', enabled: true, marker: true, injectionPosition: 0, injectionDepth: 4, injectionOrder: 100, isSectionHeader: false },
        { identifier: 'postRule', name: 'Post Rule', role: 'system', content: 'PRESET_POST_RULE', enabled: true, marker: false, injectionPosition: 0, injectionDepth: 0, injectionOrder: 100, isSectionHeader: false },
      ],
      regexScripts: [],
      samplingMeta: {},
      importedAt: new Date().toISOString(),
    };

    const config: TavernConfig = {
      enabled: true,
      activeCardId: card.id,
      activePresetId: preset.id,
      activeLorebookIds: [],
      userName: 'User',
      userPersona: '',
      cooldownTurns: 0,
      postHistoryRefreshInterval: 0,
      enablePostHistoryInjection: true,
      statelessPerTurn: false,
      directorMode: true,
      authorsNote: '',
      authorsNoteEnabled: false,
    };

    const session: SessionRuntime = {
      conversationId: 'test',
      turnCount: 1,
      injectedLorebookTurns: {},
      lastPostHistoryTurn: 0,
      lastStateInjectedHash: '',
      variables: {},
      recentMessages: [],
      state: {
        location: '',
        timeOfDay: '',
        mood: '',
        outfit: '',
        affection: 0,
        inventory: [],
        activeGoals: [],
        customFields: {},
        summary: '',
        updatedAt: new Date().toISOString(),
      },
    };

    const bundle = assembleSessionStart({
      config,
      card,
      preset,
      lorebooks: [],
      session,
      resumedStoryBlock: 'RESUMED_HISTORY_MARKER',
      recentTurnTexts: ['叶婉君走了进来'],
    });

    const msg = bundle.systemMessage;
    // before_char constant + triggered in exact order, BEFORE charDescription
    expect(msg).toContain('BEFORE_CONST_START\nBEFORE_TRIGGERED_CHAR\nBEFORE_CONST_END');
    expect(msg.indexOf('BEFORE_CONST_END')).toBeLessThan(msg.indexOf('CHAR_DESC_MARKER'));
    // after_char triggered AFTER charDescription and BEFORE opening/history
    expect(msg.indexOf('CHAR_DESC_MARKER')).toBeLessThan(msg.indexOf('AFTER_TRIGGERED_LORE'));
    expect(msg.indexOf('AFTER_TRIGGERED_LORE')).toBeLessThan(msg.indexOf('OPENING_SCENE_MARKER'));
    // in_chat (depth 3 before depth 0, and depth 0 start -> triggered -> end) AFTER resumed history and BEFORE preset postRule
    expect(msg.indexOf('RESUMED_HISTORY_MARKER')).toBeLessThan(msg.indexOf('INCHAT_D3_STYLE'));
    expect(msg.indexOf('INCHAT_D3_STYLE')).toBeLessThan(msg.indexOf('INCHAT_D0_START'));
    expect(msg).toContain('INCHAT_D0_START\nINCHAT_D0_TRIGGERED\nINCHAT_D0_END');
    expect(msg.indexOf('INCHAT_D0_END')).toBeLessThan(msg.indexOf('PRESET_POST_RULE'));
  });
});
