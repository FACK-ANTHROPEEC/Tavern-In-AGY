import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { compilePreset, parsePresetJson } from '../src/core/preset-parser.js';

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
  });
});
