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
    expect(res.cleanedText).toBe('她轻轻一笑。');
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

describe('Real Reference Cards Integration Tests (卡片参考/)', () => {
  const card2Path = path.resolve(process.cwd(), '卡片参考', '恶女婊子 高质量的MVU与前端角色卡.png');
  const card1Path = path.resolve(
    process.cwd(),
    '卡片参考',
    '大辰辰皇 V6 轻量版 我的自制角色卡，没有MVU变量，有自定义变量和酒馆助手脚本.json',
  );

  it.skipIf(!fs.existsSync(card2Path))(
    'parses real MVU card (恶女婊子), extracts [initvar], renders EJS, and collects dynamic CSP origins',
    () => {
      const card = parseCharacterCardPng(fs.readFileSync(card2Path));
      expect(card.embeddedLorebook?.entries.length).toBeGreaterThan(20);
      expect(card.regexScripts?.length).toBeGreaterThan(0);
      expect(card.resourceOrigins).toContain('https://files.catbox.moe');

      const initVar = extractInitVarFromLorebooks([card.embeddedLorebook!], '测试主角');
      expect(initVar).not.toBeNull();
      expect((initVar!.主面 as Record<string, unknown>)._本源熔炉开关).toBe('OPEN');

      const bundle = assembleSessionStart({
        config: { ...createDefaultConfig(), userName: '测试主角' },
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
      expect(bundle.systemMessage).toContain('<status_current_variables>');
      expect(bundle.systemMessage).toContain('本源熔炉为 OPEN');
      expect(bundle.systemMessage).not.toContain('<%_');
    },
  );

  it.skipIf(!fs.existsSync(card1Path))(
    'parses real custom-script card (大辰辰皇 V6), preserving 100 lorebook entries, tavern_helper scripts, and portraits',
    () => {
      const raw = JSON.parse(fs.readFileSync(card1Path, 'utf8'));
      const card = parseCharacterCardJson(raw);
      expect(card.embeddedLorebook?.entries.length).toBe(100);
      expect(card.tavernHelperScripts?.length).toBe(2);
      expect(card.customExtensions?.dch_portraits).toBeDefined();
      expect(card.customExtensions?.dch_maps).toBeDefined();
    },
  );
});
