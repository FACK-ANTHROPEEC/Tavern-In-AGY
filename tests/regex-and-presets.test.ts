import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { evaluateMacros } from '../src/core/macro-engine.js';
import { compilePreset, parsePresetJson } from '../src/core/preset-parser.js';
import { applyRegexScripts, foldUnknownCustomTags, splitFloorSegments } from '../src/core/regex-engine.js';
import { applyMvuUpdates } from '../src/core/mvu-engine.js';
import { buildSandboxedSrcDoc, parseSlashCommandAction, parseSlashCommandToMessage } from '../src/ui/sandbox-shim.js';
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
    const idxPrefill = compiled.postHistoryText.indexOf('明白了，我现在开始。');
    expect(compiled.postHistoryText).not.toContain('[Assistant Continuation Anchor]');
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

  it('folds ANY unseen custom XML tags generically while unwrapping prose containers and keeping HTML intact', () => {
    const raw = [
      '<brand_new_cot>未见过的新预设思维链</brand_new_cot>',
      '<narrative>这是真正的暖纸正文。</narrative>',
      '<custom_xyz_meta>某些元数据</custom_xyz_meta>',
      '<div class="keep">标准HTML保留</div>',
      '<StatusPlaceHolderImpl/>',
    ].join('\n');

    const folded = foldUnknownCustomTags(raw);
    expect(folded).toContain('<details><summary>💭 brand_new_cot</summary>');
    expect(folded).toContain('<details><summary>🏷️ custom_xyz_meta</summary>');
    expect(folded).toContain('这是真正的暖纸正文。');
    expect(folded).not.toContain('<narrative>');
    expect(folded).not.toContain('<StatusPlaceHolderImpl/>');
    expect(folded).toContain('<div class="keep">标准HTML保留</div>');
  });

  it('preserves <StatusPlaceHolderImpl/> for card regexes and isolates styled HTML widgets from leading prose', () => {
    const mvuOut = applyMvuUpdates(
      { hp: 100 },
      '夜色深沉。\n<update><JSONPatch>[{"op":"replace","path":"/hp","value":90}]</JSONPatch></update>\n<StatusPlaceHolderImpl/>',
    );
    expect(mvuOut.statData.hp).toBe(90);
    expect(mvuOut.cleanedText).toContain('<StatusPlaceHolderImpl/>');

    const cardStatusRegex = [
      {
        scriptName: 'Render MVU Status Card',
        findRegex: '/<StatusPlaceHolderImpl\\s*\\/?>/gi',
        replaceString: '<style>.hud{color:gold}</style><div class="hud">HP: 90</div>',
        disabled: false,
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
      },
    ];

    const afterRegex = applyRegexScripts(mvuOut.cleanedText, cardStatusRegex, {
      placement: 2,
      target: 'display',
      depth: 0,
    });
    const afterFallback = foldUnknownCustomTags(afterRegex);
    const segs = splitFloorSegments(afterFallback);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'widget']);
    if (segs[0].kind === 'text') expect(segs[0].content).toBe('夜色深沉。');
    if (segs[1].kind === 'widget') expect(segs[1].html).toContain('class="hud"');
  });

  it('parses ST slash commands cleanly for preset option buttons (send & setInput) and exposes getCurrentMessageId', () => {
    expect(parseSlashCommandToMessage('/send 继续探索主殿 || /trigger')).toBe('继续探索主殿');
    expect(parseSlashCommandToMessage('/sendas name="主人" 倒杯红茶')).toBe('倒杯红茶');
    expect(parseSlashCommandAction('/setinput 先观察四周动静')).toEqual({
      action: 'setInput',
      text: '先观察四周动静',
    });
    expect(parseSlashCommandToMessage('直接行动文本')).toBe('直接行动文本');
    expect(parseSlashCommandToMessage('/trigger')).toBeNull();

    const doc = buildSandboxedSrcDoc('<div>widget</div>', {
      widgetId: 'w1',
      charName: 'Lyra',
      userName: 'Reader',
      statData: {},
      currentMessageId: 10,
      currentNarrative: '正文<wave_options>选项A</wave_options>',
      storyTurns: [{ index: 10, narrative: '正文<wave_options>选项A</wave_options>' }],
    });
    expect(doc).toContain('getCurrentMessageId');
    expect(doc).toContain('CURRENT_ID = 10');
  });
});

describe('synthetic multi-preset compilation & regex pipeline regression', () => {
  it('compiles a full multi-section preset with random macros, prefill, and display regexes cleanly', () => {
    const raw = {
      prompts: [
        { identifier: 'main', name: 'Main Style', role: 'system', content: 'Style seed: {{random::ink::vellum::lantern}} for {{char}}.' },
        { identifier: 'charDescription', name: 'Char', role: 'system', content: '', marker: true },
        { identifier: 'chatHistory', name: 'History', role: 'system', content: '', marker: true },
        { identifier: 'out', name: 'Output Rules', role: 'system', content: 'Reply cleanly to {{user}}.' },
        { identifier: 'prefill', name: 'Prefill', role: 'assistant', content: 'Understood, continuing the scene.' },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'charDescription', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'out', enabled: true },
            { identifier: 'prefill', enabled: true },
          ],
        },
      ],
      extensions: {
        regex_scripts: [
          {
            scriptName: 'Beautify Options',
            findRegex: '/<custom_options>([\\s\\S]*?)<\\/custom_options>/g',
            replaceString: '<style>.opt{color:#d8c3a5}</style><div class="opt">$1</div>',
            disabled: false,
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
          },
        ],
      },
    };

    const preset = parsePresetJson(raw, { name: 'SyntheticPreset' });
    const compiled = compilePreset(
      preset,
      { char: 'Lyra', user: 'Reader', vars: {} },
      { charDescription: 'A calm archivist.' },
    );

    expect(compiled.staticText).not.toContain('{{random::');
    expect(compiled.postHistoryText).toContain('Understood, continuing the scene.');
    expect(compiled.postHistoryText).not.toContain('[Assistant Continuation Anchor]');

    const sampleAi = '<custom_think>Drafting beat</custom_think>\n「晚风微凉。」\n<custom_options>选项一</custom_options>';
    const afterRegex = applyRegexScripts(sampleAi, preset.regexScripts, {
      placement: 2,
      target: 'display',
      depth: 0,
    });
    const afterFallback = foldUnknownCustomTags(afterRegex);
    const segments = splitFloorSegments(afterFallback);
    expect(segments.map((s) => s.kind)).toEqual(['html', 'text', 'widget']);
  });
});
