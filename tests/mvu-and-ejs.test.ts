import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z as zod4 } from 'zod4';
import { applyMvuUpdates, extractInitVarFromLorebooks, getByDotPath, setByDotPath, unsetByDotPath } from '../src/core/mvu-engine.js';
import { buildProseBeautifierSrcDoc, isProseBeautifierScript } from '../src/ui/sandbox-shim.js';
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

  it('supports <json_patch> underscore tag and _.add / _.unset / _.assign with readonly `_` protection', () => {
    const init = {
      stats: { hp: 50, mp: 20, _locked: 1, tempBuff: 'haste' },
      bag: { potion: 1 },
    };
    const reply = `战斗结束。\n<update>\n<json_patch>\n[{"op":"replace","path":"/stats/mp","value":35}]\n</json_patch>\n_.add('stats.hp', 15);\n_.unset('stats.tempBuff');\n_.unset('stats._locked');\n_.assign('bag', {"elixir": 2, "_secret": 9});\n</update>`;

    const res = applyMvuUpdates(init, reply);
    expect(res.appliedCount).toBe(4);
    expect(res.rejectedPaths).toEqual(['stats._locked', 'bag._secret']);
    const stats = res.statData.stats as Record<string, unknown>;
    const bag = res.statData.bag as Record<string, unknown>;
    expect(stats.hp).toBe(65);
    expect(stats.mp).toBe(35);
    expect(stats.tempBuff).toBeUndefined();
    expect(stats._locked).toBe(1);
    expect(bag.elixir).toBe(2);
    expect(bag._secret).toBeUndefined();
  });

  it('provides authentic Zod v4 APIs (looseObject, strictObject, prettifyError) for MVU Zod schemas', () => {
    const schema = zod4
      .looseObject({
        base: zod4.coerce.number().default(10),
        bonus: zod4.coerce.number().default(5),
      })
      .transform((val) => ({ ...val, total: val.base + val.bonus }));
    const parsed = schema.safeParse({ base: '20', extra: 'kept' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total).toBe(25);
      expect(parsed.data.extra).toBe('kept');
    }
    expect(typeof zod4.prettifyError).toBe('function');
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

  it('extracts and deep-merges multi-part [InitVar]* entries with JSONC comments, and handles bracket paths, <user> macros, tuples, _.insert, and _.remove', () => {
    const merged = extractInitVarFromLorebooks(
      [
        {
          id: 'lb-1',
          name: 'Multi InitVar Book',
          scanDepth: 4,
          tokenBudget: 2048,
          recursiveScanning: false,
          maxRecursionSteps: 2,
          importedAt: '',
          entries: [
            {
              uid: '1',
              comment: '[InitVar]1st',
              keys: [],
              secondaryKeys: [],
              selective: false,
              selectiveLogic: 0,
              constant: false,
              enabled: false,
              order: 10,
              position: 'before_char',
              content: `{
                // single-line comment
                "时间": ["05:00", "黎明"],
                "<user>": { "修为": { "进度": 10 }, "经历": ["入门", "旧事"], },
              }`,
            },
            {
              uid: '2',
              comment: '[InitVar]2nd',
              keys: [],
              secondaryKeys: [],
              selective: false,
              selectiveLogic: 0,
              constant: false,
              enabled: false,
              order: 20,
              position: 'before_char',
              content: `/* block comment */ { "<user>": { "好感": [5, "初始"] }, "角色A": { "状态": "正常" } }`,
            },
          ],
        },
      ],
      'Master',
    );
    expect(merged).not.toBeNull();
    expect((merged!.Master as Record<string, unknown>).修为).toEqual({ 进度: 10 });
    expect((merged!.Master as Record<string, unknown>).好感).toEqual([5, '初始']);
    expect((merged!.角色A as Record<string, unknown>).状态).toBe('正常');

    const updated = applyMvuUpdates(
      merged!,
      `<UpdateVariable>
        _.set('时间[0]', '09:00');
        _.add('<user>.修为.进度', 6);
        _.add('<user>.好感', 3);
        _.insert('<user>.经历', '突破');
        _.remove('<user>.经历', '旧事');
      </UpdateVariable>`,
      { userName: 'Master' },
    );
    expect(updated.statData.时间).toEqual(['09:00', '黎明']);
    expect(((updated.statData.Master as Record<string, unknown>).修为 as Record<string, unknown>).进度).toBe(16);
    expect((updated.statData.Master as Record<string, unknown>).好感).toEqual([8, '初始']);
    expect((updated.statData.Master as Record<string, unknown>).经历).toEqual(['入门', '突破']);
    expect(updated.statData['<user>']).toBeUndefined();
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

  it('syncs setvar() updates to variables immediately within the same render pass', () => {
    const vars: Record<string, string> = {};
    const out = renderEjsTemplate(
      `<% setvar('mood', 'calm'); %><%= variables.mood %>|<%= getvar('mood') %>`,
      {
        statData: {},
        vars,
      },
    );
    expect(out).toBe('calm|calm');
    expect(vars.mood).toBe('calm');
  });

  it('prevents inherited prototype lookups and prototype pollution in getvar/setvar and dot-path helpers', () => {
    const vars: Record<string, string> = {};
    const statData: Record<string, unknown> = { a: 1 };

    const out = renderEjsTemplate(
      `<% setvar('__proto__', 'bad'); setvar('stat_data.__proto__.polluted', 'yes'); %><%= getvar('toString', { defaults: 'SAFE' }) %>|<%= getvar('constructor', { defaults: 'SAFE2' }) %>`,
      {
        statData,
        vars,
      },
    );

    expect(out).toBe('SAFE|SAFE2');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(vars, '__proto__')).toBe(false);

    expect(getByDotPath({ a: 1 }, 'toString')).toBeUndefined();
    expect(getByDotPath({ a: 1 }, 'constructor')).toBeUndefined();
    expect(unsetByDotPath({}, 'toString')).toBe(false);

    const target: Record<string, unknown> = {};
    setByDotPath(target, '__proto__.polluted', 'yes');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

  it('extracts YAML-formatted [initvar] lorebook entries with {{user}} substitution', () => {
    const initVar = extractInitVarFromLorebooks(
      [
        {
          id: 'lb-yaml',
          name: 'YAML InitVar Book',
          scanDepth: 4,
          tokenBudget: 2048,
          recursiveScanning: false,
          maxRecursionSteps: 2,
          importedAt: '',
          entries: [
            {
              uid: '1',
              comment: '[initvar]变量初始化勿开',
              keys: [],
              secondaryKeys: [],
              selective: false,
              selectiveLogic: 0,
              constant: true,
              enabled: false,
              order: 10,
              position: 'before_char',
              content: `系统变量:
  日期:
    年: 2025
    月: 8
    日: 20
    星期: 周日
    时间类型: 休息日
角色档案:
  基础信息:
    姓名: {{user}}
    年龄: 24`,
            },
          ],
        },
      ],
      '辰欢',
    );

    expect(initVar).not.toBeNull();
    const sys = initVar!.系统变量 as Record<string, Record<string, unknown>>;
    const profile = initVar!.角色档案 as Record<string, Record<string, unknown>>;
    expect(sys.日期.年).toBe(2025);
    expect(sys.日期.星期).toBe('周日');
    expect(profile.基础信息.姓名).toBe('辰欢');
    expect(profile.基础信息.年龄).toBe(24);
  });

  it('detects ST #chat .mes .mes_text prose-beautifier scripts and builds isolated prose srcDoc with tavern_events', () => {
    const validProseScript = `
      const st = document.createElement('style');
      st.textContent = '#chat .mes .mes_text.custom-theme { color: gold; }';
      document.head.appendChild(st);
      const chat = document.getElementById('chat');
      if (chat) new MutationObserver(() => {}).observe(chat, { childList: true, subtree: true });
    `;
    const mvuSchemaScript = `registerMvuSchema(z.object({ a: z.number() }));`;

    expect(isProseBeautifierScript(validProseScript)).toBe(true);
    expect(isProseBeautifierScript(mvuSchemaScript)).toBe(false);

    const html = buildProseBeautifierSrcDoc(
      '第一段**加粗**文本\n\n---\n\n第二段*斜体*文本',
      [{ name: 'Custom Theme', content: validProseScript }],
      {
        widgetId: 'p-test',
        charName: 'Tester',
        userName: 'User',
        statData: { hp: 100 },
        currentMessageId: 2,
      },
    );

    expect(html).toContain('<div id="chat">');
    expect(html).toContain('class="mes" mesid="2"');
    expect(html).toContain('<div class="mes_text"><p>第一段<strong>加粗</strong>文本</p>');
    expect(html).toContain('<hr>');
    expect(html).toContain('window.tavern_events = tavern_events;');
    expect(html).toContain('window.jQuery = jQueryShim;');
    expect(html).toContain('window.errorCatched = errorCatched;');
  });

  it('provides `variables` global and authentic lodash-es array paths in EJS templates', () => {
    const out = renderEjsTemplate(
      `<% const h = _.get(variables, ['stat_data', '角色', '苏莱娅'], {}); %>姓名:<%= h.姓名 %>|好感:<%= h.好感 %>`,
      {
        statData: { 角色: { 苏莱娅: { 姓名: '苏莱娅', 好感: 88 } } },
        vars: {},
        userName: 'User',
      },
    );
    expect(out).toBe('姓名:苏莱娅|好感:88');
  });
});
