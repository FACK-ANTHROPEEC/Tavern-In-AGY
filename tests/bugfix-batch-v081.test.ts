import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMemorySummary } from '../src/core/memory-engine.js';
import { applyMvuUpdates, extractInitVarFromLorebooks } from '../src/core/mvu-engine.js';
import { parsePresetJson } from '../src/core/preset-parser.js';
import { foldUnknownCustomTags, sanitizeStaticHtml } from '../src/core/regex-engine.js';
import { TavernStorage } from '../src/core/storage.js';
import { handleSessionStart } from '../src/agy/hook-session-start.js';
import { handlePreInvocation } from '../src/agy/hook-pre-invocation.js';

describe('v0.8.1 18-bug audit regressions', () => {
  it('#2: bare <summary> compat regex does NOT hijack HTML5 <details><summary>', () => {
    const htmlWithDetails =
      '正文内容。\n<details><summary>角色状态栏</summary><div>status</div></details>';
    const res = extractMemorySummary(htmlWithDetails);
    expect(res.summary).toBe('');
    expect(res.matchedTag).toBeNull();

    const realBareSummary = '正文内容。\n<summary>本轮核心剧情摘要</summary>';
    expect(extractMemorySummary(realBareSummary).summary).toBe('本轮核心剧情摘要');
  });

  it('#3 & #16: applyMvuUpdates runs lodash calls in source order and deepMerge guards prototype pollution', () => {
    const init = { quest: { name: 'Old', stage: 1 } };
    const patch = `<UpdateVariable>
      _.unset('quest');
      _.set('quest.name', 'New');
    </UpdateVariable>`;
    const res = applyMvuUpdates(init, patch);
    expect(res.statData.quest).toEqual({ name: 'New' });

    const polluted = extractInitVarFromLorebooks([
      {
        id: 'lb-1',
        name: 'LB',
        scanDepth: 4,
        tokenBudget: 1000,
        importedAt: new Date().toISOString(),
        entries: [
          {
            uid: '1',
            comment: '[InitVar]',
            keys: [],
            secondaryKeys: [],
            content: '{"__proto__":{"polluted":true},"safe":42}',
            constant: false,
            enabled: false,
            order: 0,
            position: 'before_char',
          },
        ],
      },
    ]);
    expect(polluted?.safe).toBe(42);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('#4: unreferenced preset prompts default to disabled when prompt_order exists', () => {
    const preset = parsePresetJson(
      {
        prompts: [
          { identifier: 'main', name: 'Main', role: 'system', content: 'Keep me' },
          { identifier: 'orphan', name: 'Orphan', role: 'system', content: 'Should stay off' },
        ],
        prompt_order: [
          {
            character_id: 100000,
            order: [{ identifier: 'main', enabled: true }],
          },
        ],
      },
      { name: 'TestPreset' },
    );
    const orphan = preset.prompts.find((p) => p.identifier === 'orphan');
    expect(orphan?.enabled).toBe(false);
  });

  it('#5, #6, #9: non-director isolation, unbound stage never hijacks SessionStart, and OOC dedup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-audit18-'));
    try {
      const storage = new TavernStorage(tmpDir);
      storage.saveCard({
        id: 'c1',
        name: 'Shizi',
        description: 'Maid',
        personality: 'Sharp',
        scenario: 'Study',
        firstMessage: 'Hello.',
        messageExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        importedAt: new Date().toISOString(),
      });

      // #5: Non-director mode must NOT inject into unbound coding window
      storage.saveConfig({ enabled: true, directorMode: false, activeCardId: 'c1' });
      expect(handleSessionStart({ conversationId: 'coding-win' }, storage).injectSteps).toBeUndefined();

      // #6: Director mode: stagedSidePaneInput alone (without PreInvocation promotion) must NOT unlock unrelated SessionStart
      storage.saveConfig({ enabled: true, directorMode: true, activeCardId: 'c1' });
      const shared = storage.getSession('default');
      shared.stagedSidePaneInput = 'Secret RP line';
      shared.stagedSidePaneInputAt = Date.now();
      storage.saveSession(shared);
      expect(handleSessionStart({ conversationId: 'random-subagent' }, storage).injectSteps).toBeUndefined();

      // #9: OOC panel-open persists lastDispatchedUserStep so repeat invocation in same turn returns {}
      const rpSession = storage.getSession('rp-win');
      rpSession.rpModeActive = true;
      storage.saveSession(rpSession);
      const tPath = path.join(tmpDir, 'ooc-transcript.jsonl');
      fs.writeFileSync(
        tPath,
        `${JSON.stringify({ step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-27T09:00:00Z' })}\n`,
        'utf8',
      );
      const ooc1 = handlePreInvocation(
        { conversationId: 'rp-win', lastUserInput: '打开侧边栏面板', transcriptPath: tPath },
        storage,
      );
      expect(ooc1.injectSteps?.length).toBe(1);
      const ooc2 = handlePreInvocation(
        { conversationId: 'rp-win', lastUserInput: '打开侧边栏面板', transcriptPath: tPath },
        storage,
      );
      expect(ooc2.injectSteps).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#10 & #17: sanitizeStaticHtml strips script bodies and foldUnknownCustomTags escapes nested scripts', () => {
    const cleaned = sanitizeStaticHtml('<div>ok</div><script>alert(1)</script><iframe src="x">bad</iframe>');
    expect(cleaned).toBe('<div>ok</div>');
    expect(cleaned).not.toContain('alert');

    const folded = foldUnknownCustomTags('<custom_note>hi <script>alert(2)</script></custom_note>', 'fold');
    expect(folded).not.toContain('<script>');
    expect(folded).toContain('&lt;script&gt;');
  });
});
