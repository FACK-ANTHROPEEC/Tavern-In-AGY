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

  const realPresetPath = path.resolve(
    process.cwd(),
    '我即浪潮-1110自改-Éclat·Turing.json',
  );

  it.skipIf(!fs.existsSync(realPresetPath))(
    'parses and compiles real community preset (我即浪潮) accurately',
    () => {
      const raw = JSON.parse(fs.readFileSync(realPresetPath, 'utf8'));
      const preset = parsePresetJson(raw, { name: '我即浪潮' });

      expect(preset.prompts.length).toBe(148);
      expect(preset.regexScripts.length).toBe(11);

      const compiled = compilePreset(
        preset,
        { char: '诗子', user: '主人', persona: '一位从容的架构师', scenario: '静谧的书房', vars: {} },
        {
          charDescription: '温柔优雅的专属执事女仆。',
          charPersonality: '沉稳、体贴、专业。',
          scenario: '静谧的书房',
        },
      );

      expect(compiled.stats.staticBlockCount).toBeGreaterThan(5);
      expect(compiled.stats.postHistoryBlockCount).toBeGreaterThanOrEqual(2);
      // 143KB wave-noise-anchor must be evaluated down to ~1.3KB, never left raw
      expect(compiled.staticText).not.toContain('{{random::');
      expect(compiled.staticText).not.toContain('{{setvar::');
      expect(compiled.postHistoryText).not.toContain('{{getvar::');
      expect(compiled.postHistoryText).toContain('wave_options');
    },
  );
});
