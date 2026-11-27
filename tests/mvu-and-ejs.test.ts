import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { applyMvuUpdates, extractInitVarFromLorebooks } from '../src/core/mvu-engine.js';
import { renderEjsTemplate } from '../src/core/ejs-engine.js';
import { evaluateMacros } from '../src/core/macro-engine.js';
import { parseCharacterCardJson, parseCharacterCardPng } from '../src/core/card-parser.js';
import { assembleSessionStart } from '../src/core/prompt-assembler.js';
import { createDefaultConfig, createDefaultState } from '../src/core/types.js';

describe('MVU engine (generic stat_data + RFC 6902 JSON Patch)', () => {
  it('applies replace/add/remove JSON Patch, protects readonly `_` keys, and strips <update> blocks', () => {
    const init = {
      主面: {
        _本源熔炉开关: 'OPEN',
        本源熔炉: 0,
        物品栏: { 手机: { 数量: 1 } },
      },
    };
    const reply = `她轻轻一笑。\n<update>\n<JSONPatch>\n[\n  {"op": "replace", "path": "/主面/本源熔炉", "value": 500},\n  {"op": "replace", "path": "/主面/_本源熔炉开关", "value": "CLOSE"},\n  {"op": "add", "path": "/主面/物品栏/星银钥匙", "value": {"数量": 1}}\n]\n</JSONPatch>\n</update>\n<StatusPlaceHolderImpl/>`;

    const res = applyMvuUpdates(init, reply);
    expect(res.appliedCount).toBe(2);
    expect(res.rejectedPaths).toEqual(['/主面/_本源熔炉开关']);
    expect((res.statData.主面 as Record<string, unknown>).本源熔炉).toBe(500);
    expect((res.statData.主面 as Record<string, unknown>)._本源熔炉开关).toBe('OPEN');
    expect(res.cleanedText).toBe('她轻轻一笑。\n\n<StatusPlaceHolderImpl/>');
  });

  it('supports JS-Slash-Runner scoped variable macros and strips $ hidden keys', () => {
    const out = evaluateMacros('HP={{get_message_variable::stat_data.hp}} DATA={{get_chat_variable::stat_data}}', {
      char: 'A',
      user: 'U',
      vars: {},
      statData: { hp: 99, $meta: { hidden: true } },
    });
    expect(out).toBe('HP=99 DATA={"hp":99}');
  });
});

describe('EJS ST-Prompt-Template engine', () => {
  it('renders @@preprocessing, print(), and getvar(dotPath, { defaults })', () => {
    const tpl = `@@preprocessing\n<%_ if (getvar('stat_data.主面._本源熔炉开关', { defaults: 'CLOSE' }) === 'OPEN') { print('熔炉已开启'); } else { print('凡人模式'); } _%>`;
    const out = renderEjsTemplate(tpl, {
      statData: { 主面: { _本源熔炉开关: 'OPEN' } },
      vars: {},
    });
    expect(out.trim()).toBe('熔炉已开启');
  });
});

describe('Synthetic MVU + EJS + Extension Card Integration', () => {
  it('extracts [initvar], renders EJS templates, and preserves card scripts & custom extensions', () => {
    const rawCard = {
      spec: 'chara_card_v3',
      data: {
        name: 'Lyra',
        description: 'An archivist in a warm candlelit study.',
        personality: 'Calm and observant.',
        scenario: 'Late evening in the observatory.',
        first_mes: 'The lantern flickers softly. <img src="https://files.catbox.moe/sample.png" />',
        character_book: {
          name: 'Lyra Book',
          entries: [
            {
              uid: 1,
              comment: '[initvar]',
              key: ['[initvar]'],
              content: '{"status":{"_locked":"OPEN","energy":80}}',
              enabled: false,
              constant: false,
            },
            {
              uid: 2,
              comment: 'Dynamic Status Block',
              key: [],
              content: '<% if (stat_data.status && stat_data.status._locked === "OPEN") { %>ENERGY:<%= stat_data.status.energy %><% } %>',
              enabled: true,
              constant: true,
              position: 'before_char',
            },
          ],
        },
        extensions: {
          regex_scripts: [
            {
              scriptName: 'Portrait',
              findRegex: '/<portrait>/g',
              replaceString: '<img src="https://files.catbox.moe/sample.png" />',
              disabled: false,
              placement: [2],
            },
          ],
          custom_portraits: { default: 'https://files.catbox.moe/sample.png' },
        },
      },
    };

    const card = parseCharacterCardJson(rawCard);
    expect(card.embeddedLorebook?.entries.length).toBe(2);
    expect(card.resourceOrigins).toContain('https://files.catbox.moe');
    expect(card.customExtensions?.custom_portraits).toBeDefined();

    const initVar = extractInitVarFromLorebooks([card.embeddedLorebook!], 'Reader');
    expect(initVar).not.toBeNull();
    expect((initVar!.status as Record<string, unknown>)._locked).toBe('OPEN');

    const bundle = assembleSessionStart({
      config: { ...createDefaultConfig(), userName: 'Reader' },
      card,
      preset: null,
      lorebooks: [],
      session: {
        conversationId: 'test-mvu',
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
      },
    });

    expect(bundle.stats.initializedMvu).toBe(true);
    expect(bundle.systemMessage).toContain('ENERGY:80');
    expect(bundle.systemMessage).not.toContain('<%');
  });
});
