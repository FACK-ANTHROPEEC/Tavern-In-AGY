import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { evaluateMacros } from '../src/core/macro-engine.js';
import { compilePreset, parsePresetJson } from '../src/core/preset-parser.js';
import { applyRegexScripts, splitFloorSegments } from '../src/core/regex-engine.js';
import { renderEjsTemplate } from '../src/core/ejs-engine.js';

describe('extended ST macros & depth/prefill preset compilation', () => {
  it('evaluates space/colon roll, pick, global/inc/dec vars, and context macros', () => {
    const ctx = {
      char: '诗子',
      user: '主人',
      vars: {},
      lastUserMessage: '今晚喝什么茶？',
      lastCharMessage: '红茶已经温好了。',
      lastMessageId: 7,
      rng: () => 0.5,
    };
    const out = evaluateMacros(
      '{{setglobalvar::turn::1}}{{incglobalvar::turn}}|{{roll 1d100}}|{{roll:2d6+1}}|{{pick::甲::乙::丙}}|{{lastUserMessage}}|{{lastCharMessage}}|{{lastMessageId}}',
      ctx,
    );
    expect(out).toContain('2|51|9|');
    expect(out).toContain('今晚喝什么茶？|红茶已经温好了。|7');
  });

  it('orders injection_position=1 by depth desc + order asc and bridges assistant prefill', () => {
    const raw = {
      prompts: [
        { identifier: 'chatHistory', name: 'History', role: 'system', content: '', marker: true },
        {
          identifier: 'd0',
          name: 'Depth0',
          role: 'system',
          content: 'DEPTH_ZERO',
          injection_position: 1,
          injection_depth: 0,
          injection_order: 100,
        },
        {
          identifier: 'd4',
          name: 'Depth4',
          role: 'system',
          content: 'DEPTH_FOUR',
          injection_position: 1,
          injection_depth: 4,
          injection_order: 100,
        },
        {
          identifier: 'prefill',
          name: 'Prefill',
          role: 'assistant',
          content: '明白了，我现在开始。',
          injection_position: 0,
        },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'd0', enabled: true },
            { identifier: 'd4', enabled: true },
            { identifier: 'prefill', enabled: true },
          ],
        },
      ],
    };
    const preset = parsePresetJson(raw, { name: 'DepthAndPrefill' });
    const compiled = compilePreset(preset, { char: 'A', user: 'B', vars: {} }, {});
    expect(compiled.stats.prefillCount).toBe(1);
    const idx4 = compiled.postHistoryText.indexOf('DEPTH_FOUR');
    const idx0 = compiled.postHistoryText.indexOf('DEPTH_ZERO');
    const idxPrefill = compiled.postHistoryText.indexOf('[Assistant Continuation Anchor]');
    expect(idx4).toBeGreaterThanOrEqual(0);
    expect(idx0).toBeGreaterThan(idx4);
    expect(idxPrefill).toBeGreaterThan(idx0);
  });

  it('supports EJS rendering inside postHistoryText as well as staticText', () => {
    const raw = {
      prompts: [
        { identifier: 'chatHistory', name: 'History', role: 'system', content: '', marker: true },
        {
          identifier: 'ejsPost',
          name: 'EJS Post',
          role: 'system',
          content: '<% if (stat_data.mood === "happy") { %>KEEP_SMILING<% } %>',
        },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'ejsPost', enabled: true },
          ],
        },
      ],
    };
    const preset = parsePresetJson(raw, { name: 'EjsPost' });
    const compiled = compilePreset(
      preset,
      { char: 'A', user: 'B', vars: {} },
      {},
      {
        ejsRender: (s) =>
          renderEjsTemplate(s, {
            statData: { mood: 'happy' },
            vars: {},
            userName: 'B',
          }),
      },
    );
    expect(compiled.postHistoryText).toBe('KEEP_SMILING');
  });
});

describe('ST regex engine & 3-way floor splitter', () => {
  it('respects minDepth, maxDepth, placement, target, and trimStrings', () => {
    const scripts = [
      {
        scriptName: 'Hide old options',
        findRegex: '/<options>[\\s\\S]*?<\\/options>/g',
        replaceString: '',
        disabled: false,
        placement: [2],
        markdownOnly: true,
        promptOnly: true,
        minDepth: 1,
        maxDepth: null,
      },
      {
        scriptName: 'Compress ancient floor to summary',
        findRegex: '/[\\s\\S]*?<summary>([\\s\\S]*?)<\\/summary>[\\s\\S]*/g',
        replaceString: '摘要：$1',
        disabled: false,
        placement: [2],
        markdownOnly: false,
        promptOnly: true,
        minDepth: 4,
        maxDepth: null,
        trimStrings: ['```'],
      },
    ];

    const sample = '正文内容。<summary>```本楼发生大事```</summary><options>A/B</options>';
    // depth=0 display keeps options
    const d0 = applyRegexScripts(sample, scripts, { placement: 2, target: 'display', depth: 0 });
    expect(d0).toContain('<options>A/B</options>');
    // depth=1 display hides options
    const d1 = applyRegexScripts(sample, scripts, { placement: 2, target: 'display', depth: 1 });
    expect(d1).not.toContain('<options>');
    // depth=5 prompt compresses to trimmed summary
    const d5Prompt = applyRegexScripts(sample, scripts, { placement: 2, target: 'prompt', depth: 5 });
    expect(d5Prompt).toBe('摘要：本楼发生大事');
  });

  it('splits mixed post-regex floor output into text, static html, and interactive widget', () => {
    const mixed = [
      '「今晚月色真好。」',
      '<details><summary>本楼背景</summary>书房内灯火微暗。</details>',
      '```html\n<!DOCTYPE html><html><body><button onclick="triggerSlash(\'/send 喝茶\')">喝茶</button><script>console.log(1)</script></body></html>\n```',
    ].join('\n\n');

    const segs = splitFloorSegments(mixed);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'html', 'widget']);
  });
});

describe('real-world 4 community presets regression (local 预设参考/)', () => {
  const presetsDir = path.resolve(process.cwd(), '预设参考');
  const files = [
    {
      name: 'Kemini_Dramatron_v3.1改.json',
      expectPrefill: true,
      sampleAi: '「你好。」<disclaimer>免责</disclaimer><summary>一段摘要</summary>',
    },
    {
      name: 'Meowssiah_1.9.12.json',
      expectPrefill: false,
      sampleAi: '<think_nya>思考中...</think_nya>\n正文第一段。\n<background>背景设定</background>',
    },
    {
      name: '夏瑾 天琴座 Beta 3.8.json',
      expectPrefill: false,
      sampleAi: '她忽然露出一丝不容置疑的笑容，语气冷得如同寒冰。',
    },
    {
      name: '我即浪潮-1110自改-Éclat·Turing.json',
      expectPrefill: false,
      sampleAi: '<wave_plan>构思提要</wave_plan>\n<content>夜风拂过长廊。</content>\n<wave_summary>两人相遇</wave_summary>',
    },
  ];

  for (const item of files) {
    const fullPath = path.join(presetsDir, item.name);
    it.skipIf(!fs.existsSync(fullPath))(`compiles and executes regexes cleanly for ${item.name}`, () => {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const preset = parsePresetJson(raw, { name: item.name });
      expect(preset.prompts.length).toBeGreaterThan(20);
      expect(preset.regexScripts.length).toBeGreaterThan(0);

      const compiled = compilePreset(
        preset,
        {
          char: '诗子',
          user: '主人',
          persona: '温柔体贴的主人',
          scenario: '静谧书房',
          vars: {},
          lastUserMessage: '继续吧',
          lastCharMessage: '好的，主人。',
          lastMessageId: 3,
        },
        {
          charDescription: '专属执事女仆。',
          scenario: '静谧书房',
        },
      );

      expect(compiled.staticText.length).toBeGreaterThan(200);
      expect(compiled.staticText).not.toContain('{{random::');
      expect(compiled.staticText).not.toContain('{{roll ');
      expect(compiled.staticText).not.toContain('{{lastUserMessage}}');
      expect(compiled.staticText).not.toContain('{{lastCharMessage}}');
      if (item.expectPrefill) {
        expect(compiled.stats.prefillCount).toBeGreaterThan(0);
        expect(compiled.postHistoryText).toContain('[Assistant Continuation Anchor]');
      }

      // Verify display regex pipeline executes cleanly without throwing and produces valid segments
      const displayRendered = applyRegexScripts(item.sampleAi, preset.regexScripts, {
        placement: 2,
        target: 'display',
        depth: 0,
      });
      const segments = splitFloorSegments(displayRendered);
      expect(segments.length).toBeGreaterThan(0);
    });
  }
});
