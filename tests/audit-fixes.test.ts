import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRegexScripts, sanitizeStaticHtml, splitFloorSegments } from '../src/core/regex-engine.js';
import { applyMvuUpdates } from '../src/core/mvu-engine.js';
import { assembleSessionStart } from '../src/core/prompt-assembler.js';
import { StoryLogStore } from '../src/core/story-log.js';
import {
  createDefaultConfig,
  createDefaultState,
  type CharacterCard,
  type Preset,
  type SessionRuntime,
} from '../src/core/types.js';

describe('Security & engine audit regression tests', () => {
  it('#4 blocks slash-delimited event handlers, active embed tags, and entity-encoded javascript: URIs', () => {
    const clean = sanitizeStaticHtml(
      '<img src=x/onerror=alert(1)><svg/onload=alert(2)><iframe srcdoc="<script>x</script>"></iframe><object data="x"></object><embed src="x"><a href="java&#x09;script:alert(3)">click</a>',
    );
    expect(clean.toLowerCase()).not.toContain('onerror');
    expect(clean.toLowerCase()).not.toContain('onload');
    expect(clean.toLowerCase()).not.toContain('<iframe');
    expect(clean.toLowerCase()).not.toContain('<object');
    expect(clean.toLowerCase()).not.toContain('<embed');
    expect(clean.toLowerCase()).not.toContain('javascript:');

    const segs = splitFloorSegments('<div><svg/onload=alert(1)></div>');
    expect(segs[0]?.kind).toBe('widget');
  });

  it('#10 story-director.md includes call_mcp_tool in frontmatter tools', () => {
    const md = fs.readFileSync(path.resolve('plugin/agents/story-director.md'), 'utf8');
    expect(md).toMatch(/tools:\s*[\s\S]*-\s*call_mcp_tool/);
  });

  it('#13 evaluates preset slots exactly once in prompt_order so setvar flows into charDescription', () => {
    const card: CharacterCard = {
      id: 'c-once',
      name: 'Aria',
      description: 'Rank={{getvar::rank}}',
      personality: '',
      scenario: '',
      firstMessage: '',
      messageExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      tags: [],
      importedAt: '',
    };
    const preset: Preset = {
      id: 'p-once',
      name: 'TestPreset',
      prompts: [
        {
          identifier: 'set-rank',
          name: 'SetRank',
          role: 'system',
          content: '{{setvar::rank::S+}}Init',
          enabled: true,
          marker: false,
          injectionPosition: 0,
          injectionDepth: 0,
          injectionOrder: 0,
          isSectionHeader: false,
        },
        {
          identifier: 'charDescription',
          name: 'CharDesc',
          role: 'system',
          content: '',
          enabled: true,
          marker: true,
          injectionPosition: 0,
          injectionDepth: 0,
          injectionOrder: 1,
          isSectionHeader: false,
        },
      ],
      regexScripts: [],
      samplingMeta: {},
      importedAt: '',
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
    const bundle = assembleSessionStart({
      config: createDefaultConfig(),
      card,
      preset,
      lorebooks: [],
      session,
    });
    expect(bundle.systemMessage).toContain('Rank=S+');
  });

  it('#14 & #15 substituteRegex=2 escapes only macro values; {{match}} preserves $10/$$ and supports $<name>', () => {
    const res1 = applyRegexScripts(
      'A.B: hello world',
      [
        {
          scriptName: 'escaped-macro',
          findRegex: '/^{{char}}:\\s*(?<msg>.*)$/gm',
          replaceString: '[$<msg>]',
          disabled: false,
          placement: [2],
          substituteRegex: 2,
        },
      ],
      {
        placement: 2,
        target: 'display',
        depth: 0,
        macroCtx: { char: 'A.B', user: 'U', vars: {} },
      },
    );
    expect(res1).toBe('[hello world]');

    const res2 = applyRegexScripts(
      'Price is $10 and $& and $$5',
      [
        {
          scriptName: 'dollar-safe',
          findRegex: '/Price is .*/g',
          replaceString: 'Cost($$): {{match}}',
          disabled: false,
          placement: [2],
        },
      ],
      { placement: 2, target: 'display', depth: 0 },
    );
    expect(res2).toBe('Cost($): Price is $10 and $& and $$5');
  });

  it('#16 applyMvuUpdates handles nested JSONPatch arrays and _.set/_.assign strings containing ) and ;', () => {
    const input = `<update>
[{"op":"replace","path":"/bag","value":[{"name":"sword"},{"name":"shield"}]}]
_.set('status', 'HP 80 (受伤); 正常');
_.assign('meta', 'note', 'foo (bar); baz');
</update>`;
    const res = applyMvuUpdates({ bag: [], status: '', meta: {} }, input);
    expect(res.appliedCount).toBe(3);
    expect(res.statData.bag).toEqual([{ name: 'sword' }, { name: 'shield' }]);
    expect(res.statData.status).toBe('HP 80 (受伤); 正常');
    expect((res.statData.meta as Record<string, unknown>).note).toBe('foo (bar); baz');
  });

  it('#17 StoryLogStore.appendTurn inserts missing newline before appending to avoid corrupting JSONL', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-jsonl-nl-'));
    try {
      const store = new StoryLogStore(tmpDir);
      const storiesDir = path.join(tmpDir, 'stories');
      // Write a first line WITHOUT trailing newline
      fs.writeFileSync(
        path.join(storiesDir, 'card1.jsonl'),
        JSON.stringify({ turnId: 't1', index: 1, narrative: 'first', createdAt: '' }),
        'utf8',
      );
      store.appendTurn('card1', { narrative: 'second' });
      const turns = store.readTurns('card1');
      expect(turns.length).toBe(2);
      expect(turns[0].narrative).toBe('first');
      expect(turns[1].narrative).toBe('second');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
