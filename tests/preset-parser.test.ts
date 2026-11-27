import { describe, it, expect } from 'vitest';
import { compilePreset, parsePresetJson } from '../src/core/preset-parser.js';
import { parseLorebookJson } from '../src/core/lorebook-engine.js';
import { assembleSessionStart } from '../src/core/prompt-assembler.js';
import { createDefaultConfig, createDefaultState, type CharacterCard, type SessionRuntime } from '../src/core/types.js';

describe('preset-parser', () => {
  it('splits static vs postHistory around chatHistory and flows setvar/getvar across', () => {
    const raw = {
      temperature: 1,
      prompts: [
        { identifier: 'sec1', name: '=== Core ===', role: 'system', content: '', marker: false },
        {
          identifier: 'init',
          name: 'Init',
          role: 'system',
          content: '{{setvar::tone::poetic}}Main instruction for {{char}}.',
          marker: false,
        },
        { identifier: 'charDescription', name: 'Char', role: 'system', content: '', marker: true },
        { identifier: 'chatHistory', name: 'History', role: 'system', content: '', marker: true },
        {
          identifier: 'post',
          name: 'Post',
          role: 'system',
          content: 'Write in {{getvar::tone}} tone for {{user}}.',
          marker: false,
        },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'sec1', enabled: true },
            { identifier: 'init', enabled: true },
            { identifier: 'charDescription', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'post', enabled: true },
          ],
        },
      ],
    };

    const preset = parsePresetJson(raw, { name: 'MiniPreset' });
    expect(preset.prompts[0].isSectionHeader).toBe(true);

    const compiled = compilePreset(
      preset,
      { char: 'Shizi', user: 'Master', vars: {} },
      { charDescription: 'A devoted butler maid.' },
    );

    expect(compiled.staticText).toContain('Main instruction for Shizi.');
    expect(compiled.staticText).toContain('A devoted butler maid.');
    expect(compiled.postHistoryText).toBe('Write in poetic tone for Master.');
    expect(compiled.trailingPostBlocks).toEqual(['Write in poetic tone for Master.']);
  });

  it('enforces official SillyTavern tail order: Depth>=1 -> User Input -> Depth=0 (User->Assistant->System, order asc) -> Post-History Relative/Prefill', () => {
    const preset = parsePresetJson(
      {
        prompts: [
          { identifier: 'main', name: 'Main', role: 'system', content: 'STATIC_MAIN', marker: false },
          { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', marker: true },
          // Depth=1 preset block
          {
            identifier: 'd1_sys',
            name: 'D1 System',
            role: 'system',
            content: 'PRESET_D1_SYS',
            marker: false,
            injection_position: 1,
            injection_depth: 1,
            injection_order: 10,
          },
          // Depth=0 preset blocks in intentionally scrambled role/order sequence
          {
            identifier: 'd0_sys_late',
            name: 'D0 Sys 50',
            role: 'system',
            content: 'PRESET_D0_SYS_50',
            marker: false,
            injection_position: 1,
            injection_depth: 0,
            injection_order: 50,
          },
          {
            identifier: 'd0_asst',
            name: 'D0 Asst 20',
            role: 'assistant',
            content: 'PRESET_D0_ASST_20',
            marker: false,
            injection_position: 1,
            injection_depth: 0,
            injection_order: 20,
          },
          {
            identifier: 'd0_user_high',
            name: 'D0 User 30',
            role: 'user',
            content: 'PRESET_D0_USER_30',
            marker: false,
            injection_position: 1,
            injection_depth: 0,
            injection_order: 30,
          },
          // Relative blocks below chatHistory (PHI + Assistant Prefill)
          {
            identifier: 'phi',
            name: 'Post-History Instructions',
            role: 'system',
            content: 'RELATIVE_PHI_TAIL',
            marker: false,
            injection_position: 0,
          },
          {
            identifier: 'prefill',
            name: 'Assistant Prefill',
            role: 'assistant',
            content: 'RELATIVE_PREFILL_TAIL',
            marker: false,
            injection_position: 0,
          },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'chatHistory', enabled: true },
              { identifier: 'd1_sys', enabled: true },
              { identifier: 'd0_sys_late', enabled: true },
              { identifier: 'd0_asst', enabled: true },
              { identifier: 'd0_user_high', enabled: true },
              { identifier: 'phi', enabled: true },
              { identifier: 'prefill', enabled: true },
            ],
          },
        ],
      },
      { name: 'STTailOrderPreset' },
    );

    const lorebook = parseLorebookJson(
      {
        name: 'InChatRoleBook',
        entries: [
          {
            uid: 1,
            constant: true,
            enabled: true,
            content: 'WI_D1_USER',
            insertion_order: 5,
            extensions: { position: 4, depth: 1, role: 1 }, // user @D1
          },
          {
            uid: 2,
            constant: true,
            enabled: true,
            content: 'WI_D0_USER_10',
            insertion_order: 10,
            extensions: { position: 4, depth: 0, role: 1 }, // user @D0 order 10
          },
          {
            uid: 3,
            constant: true,
            enabled: true,
            content: 'WI_D0_SYS_5',
            insertion_order: 5,
            extensions: { position: 4, depth: 0, role: 0 }, // system @D0 order 5
          },
          {
            uid: 4,
            constant: true,
            enabled: true,
            content: 'WI_D0_ASST_5',
            insertion_order: 5,
            extensions: { position: 4, depth: 0, role: 2 }, // assistant @D0 order 5
          },
        ],
      },
      'InChatRoleBook',
    );

    expect(lorebook.entries.map((e) => e.role)).toEqual(['user', 'user', 'system', 'assistant']);

    const card: CharacterCard = {
      id: 'card-st-order',
      name: 'Shizi',
      description: 'Maid',
      personality: '',
      scenario: '',
      firstMessage: 'OPENING_GREETING',
      messageExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      tags: [],
      embeddedLorebook: lorebook,
      importedAt: new Date().toISOString(),
    };

    const session: SessionRuntime = {
      conversationId: 'writer-order-test',
      turnCount: 1,
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

    const bundle = assembleSessionStart({
      config: createDefaultConfig(),
      card,
      preset,
      lorebooks: [],
      session,
      resumedStoryBlock: 'PRIOR_STORY_HISTORY',
      currentUserInput: 'USER_TURN_INPUT_HERE',
    });

    const msg = bundle.systemMessage;
    const expectedSequence = [
      'STATIC_MAIN',
      'OPENING_GREETING',
      'PRIOR_STORY_HISTORY',
      'WI_D1_USER',
      'PRESET_D1_SYS',
      '[Current Turn User Input]',
      'USER_TURN_INPUT_HERE',
      'WI_D0_USER_10',
      'PRESET_D0_USER_30',
      'WI_D0_ASST_5',
      'PRESET_D0_ASST_20',
      'WI_D0_SYS_5',
      'PRESET_D0_SYS_50',
      'RELATIVE_PHI_TAIL',
      'RELATIVE_PREFILL_TAIL',
      '[Story Panel Delivery]',
    ];

    let prevIdx = -1;
    for (const marker of expectedSequence) {
      const idx = msg.indexOf(marker);
      expect(idx, `Expected marker "${marker}" to exist in assembled prompt`).toBeGreaterThan(-1);
      expect(idx, `Expected "${marker}" to appear after previous marker`).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
  });
});
