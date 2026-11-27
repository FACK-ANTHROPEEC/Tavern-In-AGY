import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMemoryPromptInstruction,
  extractMemorySummary,
  splitTurnsByRecentFloors,
  stripMemorySummaryTags,
} from '../src/core/memory-engine.js';
import { StoryLogStore, resolveStoryKey } from '../src/core/story-log.js';
import { assemblePreInvocation, assembleSessionStart } from '../src/core/prompt-assembler.js';
import {
  createDefaultConfig,
  createDefaultState,
  type CharacterCard,
  type SessionRuntime,
  type StoryTurn,
} from '../src/core/types.js';

function makeTurn(index: number, opts?: { summary?: string; noUser?: boolean }): StoryTurn {
  return {
    turnId: `turn-${index}`,
    index,
    userMessage: opts?.noUser ? undefined : `玩家第${index}轮行动指令`,
    narrative: `这是第${index}轮的长篇正文内容，包含大量细节描写与对话。${
      opts?.summary ? `\n<memory_summary>${opts.summary}</memory_summary>` : ''
    }`,
    memorySummary: opts?.summary,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(),
  };
}

describe('memory-engine & sliding-window history', () => {
  it('generates memory prompt contract only when enabled and supports {{length}}', () => {
    expect(buildMemoryPromptInstruction({ enabled: false })).toBe('');

    const defaultPrompt = buildMemoryPromptInstruction({
      enabled: true,
      summaryLengthHint: 200,
    });
    expect(defaultPrompt).toContain('[Memory Summary Contract]');
    expect(defaultPrompt).toContain('200');
    expect(defaultPrompt).toContain('<memory_summary>');

    const custom = buildMemoryPromptInstruction({
      enabled: true,
      summaryLengthHint: 150,
      customPrompt: '请输出 {{length}} 字摘要。',
    });
    expect(custom).toContain('请输出 150 字摘要。');
  });

  it('extracts <memory_summary> and preserves compat tags without stripping them', () => {
    const own = extractMemorySummary('正文第一段。\n<memory_summary>主角抵达港口并拿到钥匙。</memory_summary>');
    expect(own.matchedTag).toBe('memory_summary');
    expect(own.summary).toBe('主角抵达港口并拿到钥匙。');
    expect(own.strippedText).toBe('正文第一段。');

    const compat = extractMemorySummary('正文。<wave_summary>兼容预设摘要</wave_summary>');
    expect(compat.matchedTag).toBe('wave_summary');
    expect(compat.summary).toBe('兼容预设摘要');
    expect(compat.strippedText).toContain('<wave_summary>');

    expect(stripMemorySummaryTags('A\n<memory_summary>S</memory_summary>\nB')).toBe('A\n\nB');
  });

  it('splits turns by exact floor count for both even and odd recentFullFloors', () => {
    // 8 turns * 2 floors/turn = 16 floors
    const turns = Array.from({ length: 8 }, (_, i) =>
      makeTurn(i + 1, { summary: `第${i + 1}轮小总结` }),
    );

    // 10 floors = latest 5 complete turns (turns #4..#8 full, #1..#3 summarized)
    const evenSplit = splitTurnsByRecentFloors(turns, 10);
    expect(evenSplit.totalFloors).toBe(16);
    expect(evenSplit.fullFloorCount).toBe(10);
    expect(evenSplit.summarizedFloorCount).toBe(6);
    expect(evenSplit.summarizedTurns.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(evenSplit.fullEntries.map((e) => e.turn.index)).toEqual([4, 5, 6, 7, 8]);
    expect(evenSplit.fullEntries.every((e) => e.includeUserFull)).toBe(true);

    // 7 floors = latest 3 complete turns (6 floors: #6..#8) + assistant floor of #5 (1 floor)
    const oddSplit = splitTurnsByRecentFloors(turns, 7);
    expect(oddSplit.fullFloorCount).toBe(7);
    expect(oddSplit.summarizedFloorCount).toBe(9);
    expect(oddSplit.summarizedTurns.map((t) => t.index)).toEqual([1, 2, 3, 4]);
    expect(oddSplit.fullEntries.map((e) => [e.turn.index, e.includeUserFull])).toEqual([
      [5, false],
      [6, true],
      [7, true],
      [8, true],
    ]);
  });

  it('formats earlier turns as summaries and latest N floors as full prose when enabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mem-'));
    try {
      const store = new StoryLogStore(tmpDir);
      const turns = [
        makeTurn(1, { summary: '第1轮摘要：相遇于雨夜车站。' }),
        makeTurn(2), // legacy turn without summary -> graceful fallback
        makeTurn(3, { summary: '第3轮摘要：约定次日出发。' }),
        makeTurn(4, { summary: '第4轮摘要：登上列车。' }),
        makeTurn(5, { summary: '第5轮摘要：遭遇神秘检票员。' }),
      ];

      // Keep latest 4 floors (= turns #4 and #5 full); turns #1..#3 condensed
      const output = store.formatForForkResume(turns, '诗子', '主人', {
        memoryPlugin: { enabled: true, recentFullFloors: 4, summaryLengthHint: 200 },
      });

      expect(output).toContain('[Earlier Story Memory · Turns #1–#3 (3 Turns Condensed)]');
      expect(output).toContain('- [Turn #1] 第1轮摘要：相遇于雨夜车站。');
      expect(output).toContain('- [Turn #2] 行动：玩家第2轮行动指令');
      expect(output).toContain('- [Turn #3] 第3轮摘要：约定次日出发。');
      // Earlier turns must NOT emit their full prose
      expect(output).not.toContain('这是第1轮的长篇正文内容');
      expect(output).not.toContain('这是第3轮的长篇正文内容');
      // Recent window emits full prose, with <memory_summary> stripped
      expect(output).toContain('### Turn 4 (主人)');
      expect(output).toContain('这是第4轮的长篇正文内容');
      expect(output).toContain('这是第5轮的长篇正文内容');
      expect(output).not.toContain('<memory_summary>');

      // Test editTurnSummary persistence
      const saved = store.appendTurn('card-a', {
        userMessage: 'hi',
        narrative: 'hello',
      });
      const updated = store.editTurnSummary('card-a', saved.turnId, '手动补写摘要');
      expect(updated[0].memorySummary).toBe('手动补写摘要');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('injects memory summary contract into SessionStart only when memoryPlugin.enabled is true', () => {
    const card: CharacterCard = {
      id: 'c1',
      name: 'Aria',
      description: 'desc',
      personality: 'calm',
      scenario: 'station',
      firstMessage: 'hello',
      messageExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      tags: [],
      importedAt: new Date().toISOString(),
    };
    const session: SessionRuntime = {
      conversationId: 'default',
      turnCount: 0,
      lastUserInputHash: '',
      injectedLorebookTurns: {},
      lastStateInjectedHash: '',
      lastPostHistoryTurn: 0,
      recentMessages: [],
      variables: {},
      statData: {},
      state: createDefaultState(),
      latestOptions: [],
    };

    const offCfg = createDefaultConfig();
    const offBundle = assembleSessionStart({
      config: offCfg,
      card,
      preset: null,
      lorebooks: [],
      session,
    });
    expect(offBundle.systemMessage).not.toContain('[Memory Summary Contract]');

    const onCfg = {
      ...offCfg,
      memoryPlugin: { enabled: true, recentFullFloors: 8, summaryLengthHint: 180 },
    };
    const onBundle = assembleSessionStart({
      config: onCfg,
      card,
      preset: null,
      lorebooks: [],
      session,
    });
    expect(onBundle.systemMessage).toContain('[Memory Summary Contract]');
    expect(onBundle.systemMessage).toContain('180');
  });

  it('preserves boundary userMessage on odd recentFullFloors and never overwrites edited summary on prose edit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-mem-reg-'));
    try {
      const store = new StoryLogStore(tmpDir);
      const turns = Array.from({ length: 4 }, (_, i) =>
        makeTurn(i + 1, { summary: `第${i + 1}轮摘要` }),
      );
      // 3 floors = turn #4 full (2 floors) + turn #3 assistant full (1 floor); turn #3 userMessage must be preserved
      const out = store.formatForForkResume(turns, '诗子', '主人', {
        memoryPlugin: { enabled: true, recentFullFloors: 3, summaryLengthHint: 200 },
      });
      expect(out).toContain('- [Turn #3 · 主人] 玩家第3轮行动指令');
      expect(out).toContain('### Turn 3 (诗子)');
      expect(out).not.toContain('### Turn 3 (主人)');

      // Editing prose after editing summary must NOT overwrite the edited summary
      const saved = store.appendTurn('card-reg', {
        userMessage: '行动',
        narrative: '初版正文。',
        memorySummary: '初版摘要',
      });
      store.editTurnSummary('card-reg', saved.turnId, '手动精修后的新摘要');
      const afterProseEdit = store.editTurn('card-reg', saved.turnId, '修改了错别字的正文。');
      expect(afterProseEdit[0].memorySummary).toBe('手动精修后的新摘要');
      expect(afterProseEdit[0].narrative).toBe('修改了错别字的正文。');

      // If narrative contains <memory_summary>, editTurn strips it from narrative and updates memorySummary
      const afterTagEdit = store.editTurn(
        'card-reg',
        saved.turnId,
        '再次修改正文。\n<memory_summary>标签内新摘要</memory_summary>',
      );
      expect(afterTagEdit[0].narrative).toBe('再次修改正文。');
      expect(afterTagEdit[0].memorySummary).toBe('标签内新摘要');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves alternate greeting on multi-slot playthroughs and injects memory contract mid-session', () => {
    const card: CharacterCard = {
      id: 'card-slot',
      name: 'Aria',
      description: 'desc',
      personality: 'calm',
      scenario: 'station',
      firstMessage: 'OPENING_ZERO',
      alternateGreetings: ['OPENING_ONE', 'OPENING_TWO'],
      messageExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      tags: [],
      importedAt: new Date().toISOString(),
    };
    const slotId = '1700001234';
    const storyKey = resolveStoryKey(card.id, slotId);
    const cfg = {
      ...createDefaultConfig(),
      activeCardId: card.id,
      activeChatSlots: { [card.id]: slotId },
      activeGreetingIndices: { [storyKey]: 2 },
    };
    const session: SessionRuntime = {
      conversationId: 'default',
      turnCount: 0,
      lastUserInputHash: '',
      injectedLorebookTurns: {},
      lastStateInjectedHash: '',
      lastPostHistoryTurn: 0,
      recentMessages: [],
      variables: {},
      statData: {},
      state: createDefaultState(),
      latestOptions: [],
    };

    const startBundle = assembleSessionStart({
      config: cfg,
      card,
      preset: null,
      lorebooks: [],
      session,
    });
    expect(startBundle.systemMessage).toContain('OPENING_TWO');
    expect(startBundle.systemMessage).not.toContain('OPENING_ZERO');

    // Mid-session toggle on injects memory contract once in PreInvocation
    const cfgMemOn = {
      ...cfg,
      memoryPlugin: { enabled: true, recentFullFloors: 8, summaryLengthHint: 200 },
    };
    const pre1 = assemblePreInvocation({
      config: cfgMemOn,
      card,
      preset: null,
      lorebooks: [],
      session,
      recentMessages: ['继续'],
    });
    expect(pre1.systemMessage).toContain('[Memory Summary Contract]');

    const pre2 = assemblePreInvocation({
      config: cfgMemOn,
      card,
      preset: null,
      lorebooks: [],
      session,
      recentMessages: ['再继续'],
    });
    expect(pre2.systemMessage).not.toContain('[Memory Summary Contract]');
  });

  it('uses SillyTavern message-level depth (0,2,4... for AI) for promptOnly regex scripts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-depth-'));
    try {
      const store = new StoryLogStore(tmpDir);
      const turns: StoryTurn[] = [
        { turnId: 't1', index: 1, userMessage: 'u1', narrative: 'BODY1<ws>SUM1</ws>', createdAt: '' },
        { turnId: 't2', index: 2, userMessage: 'u2', narrative: 'BODY2<ws>SUM2</ws>', createdAt: '' },
        { turnId: 't3', index: 3, userMessage: 'u3', narrative: 'BODY3<ws>SUM3</ws>', createdAt: '' },
      ];
      // Message depths from latest: t3 AI=0, t3 User=1, t2 AI=2, t2 User=3, t1 AI=4, t1 User=5
      // A promptOnly regex with minDepth: 4 must strip BODY1 on t1 AI (depth=4), while keeping BODY2 (depth=2) & BODY3 (depth=0)
      const out = store.formatForForkResume(turns, '诗子', '主人', {}, [
        {
          scriptName: 'trim-old-body',
          findRegex: '/BODY\\d+(?=<ws>)/g',
          replaceString: '',
          disabled: false,
          placement: [2],
          promptOnly: true,
          markdownOnly: false,
          minDepth: 4,
          maxDepth: null,
        },
      ]);
      expect(out).not.toContain('BODY1');
      expect(out).toContain('<ws>SUM1</ws>');
      expect(out).toContain('BODY2');
      expect(out).toContain('BODY3');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
