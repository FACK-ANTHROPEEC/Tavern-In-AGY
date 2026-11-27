import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TavernStorage } from '../src/core/storage.js';
import { handleSessionStart } from '../src/agy/hook-session-start.js';
import { handlePreInvocation } from '../src/agy/hook-pre-invocation.js';
import { buildSandboxedSrcDoc, safeJsonForInlineScript } from '../src/ui/sandbox-shim.js';

describe('Director Mode multi-agent hook lifecycle', () => {
  it('isolates story-writer from director prompts and prevents duplicate dispatch on reactive wakeup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-director-hooks-'));
    try {
      const storage = new TavernStorage(tmpDir);
      storage.saveCard({
        id: 'card-1',
        name: 'Shizi',
        description: 'A devoted butler maid.',
        personality: 'Warm and sharp.',
        scenario: 'Study room',
        firstMessage: 'Welcome back.',
        messageExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        importedAt: new Date().toISOString(),
      });
      storage.saveConfig({
        enabled: true,
        directorMode: true,
        activeCardId: 'card-1',
      });

      // 0. Normal AGY coding window (never ran `/rp`) MUST stay 100% untouched even when config.enabled=true
      const normalPre = handlePreInvocation(
        { conversationId: 'coding-conv', lastUserInput: '帮我修一下这个 TypeScript 类型报错', invocationNum: 1 },
        storage,
      );
      expect(normalPre.injectSteps).toBeUndefined();
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();

      // 1. Director main window opens -> SessionStart must stay 100% clean ({})
      const dirStart = handleSessionStart({ conversationId: 'director-conv' }, storage);
      expect(dirStart.injectSteps).toBeUndefined();

      // 1b. User invokes `/rp` in director-conv -> binds THIS window only, does NOT dispatch writer
      const rpActivate = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '/rp', invocationNum: 1 },
        storage,
      );
      expect(rpActivate.injectSteps).toBeUndefined();
      expect(storage.getSession('director-conv').rpModeActive).toBe(true);
      expect(storage.getSession('coding-conv').rpModeActive).toBeUndefined();

      // 1c. OOC panel-open request inside bound RP window -> instructs opening panel directly, no writer dispatch
      const oocOpen = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '打开侧边栏面板', invocationNum: 1 },
        storage,
      );
      expect(oocOpen.injectSteps?.length).toBe(1);
      expect(oocOpen.injectSteps?.[0].systemMessage.systemMessage).toContain('story_open_panel');
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();

      // 2. User sends "继续" -> Director PreInvocation dispatches story-writer
      const dirPre1 = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '继续', invocationNum: 1 },
        storage,
      );
      expect(dirPre1.injectSteps?.length).toBe(1);
      expect(dirPre1.injectSteps?.[0].systemMessage.systemMessage).toContain('[Story Director · Pure Router]');
      expect(storage.getSession('default').directorTurnState).toBe('dispatched');
      expect(storage.getSession('default').pendingDirectorInput).toBe('继续');

      // 3. story-writer subagent spawns -> SessionStart consumes pendingDirectorInput, injects [Current Turn User Input], and marks isWriterSubagent
      const writerStart = handleSessionStart({ conversationId: 'writer-conv-1' }, storage);
      expect((writerStart.injectSteps?.length ?? 0)).toBeGreaterThan(0);
      const writerInjectedText = (writerStart.injectSteps ?? [])
        .map((s) => s.systemMessage.systemMessage)
        .join('\n');
      expect(writerInjectedText).toContain('[Current Turn User Input]');
      expect(writerInjectedText).toContain('继续');
      expect(storage.getSession('writer-conv-1').isWriterSubagent).toBe(true);
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();

      // 4. [BUG 1] story-writer triggers PreInvocation -> MUST return {} and NOT inject [Story Director · Pure Router] or overwrite shared state
      const writerPre = handlePreInvocation(
        { conversationId: 'writer-conv-1', lastUserInput: 'Write turn #1 for 继续', invocationNum: 1 },
        storage,
      );
      expect(writerPre.injectSteps).toBeUndefined();
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();
      expect(storage.getSession('default').lastUserInputForCommit).toBe('继续');

      // 5. story-writer commits turn via story_commit_turn -> sets directorTurnState = 'committed'
      const sharedAfterCommit = storage.getSession('default');
      sharedAfterCommit.directorTurnState = 'committed';
      sharedAfterCommit.lastUserInputForCommit = undefined;
      storage.saveSession(sharedAfterCommit);

      // 6. [BUG 2] AGY reactively wakes up director with invocationNum: 1 and same lastUserInput -> MUST return {} (no duplicate dispatch)
      const dirWakeup = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '继续', invocationNum: 1 },
        storage,
      );
      expect(dirWakeup.injectSteps).toBeUndefined();
      expect(storage.getSession('default').directorTurnState).toBe('idle');

      // 7. Next turn: user sends the exact same short message "继续" again -> MUST dispatch normally
      const dirNextTurn = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '继续', invocationNum: 1 },
        storage,
      );
      expect(dirNextTurn.injectSteps?.length).toBe(1);
      expect(dirNextTurn.injectSteps?.[0].systemMessage.systemMessage).toContain('[Story Director · Pure Router]');

      // 8. Abnormal writer exit (claimed pendingDirectorInput in SessionStart, failed before story_commit_turn) -> wakeup still resets & stops loop
      handleSessionStart({ conversationId: 'writer-conv-2' }, storage);
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();
      const dirWakeupAfterFailure = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '继续', invocationNum: 1 },
        storage,
      );
      expect(dirWakeupAfterFailure.injectSteps).toBeUndefined();
      expect(storage.getSession('default').directorTurnState).toBe('idle');

      // 9. `/rp off` unbinds this window -> subsequent messages return {} with zero RP injection
      const rpOff = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '/rp off', invocationNum: 1 },
        storage,
      );
      expect(rpOff.injectSteps).toBeUndefined();
      expect(storage.getSession('director-conv').rpModeActive).toBe(false);
      const afterOff = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '继续', invocationNum: 1 },
        storage,
      );
      expect(afterOff.injectSteps).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sandbox-shim inline script escape safety', () => {
  it('escapes </script>, </SCRIPT>, and <!-- in all serialized payloads so HTML5 never truncates the shim', () => {
    const evil = '</script><script>window.__ESCAPED__=1;</script></SCRIPT><!-- comment -->';
    expect(safeJsonForInlineScript(evil)).not.toContain('</script>');
    expect(safeJsonForInlineScript(evil)).not.toContain('<');

    const doc = buildSandboxedSrcDoc('<div id="ok">widget</div>', {
      widgetId: `w-${evil}`,
      charName: `Char ${evil}`,
      userName: `User ${evil}`,
      statData: { note: evil, nested: { html: '<script>x</script>' } },
      currentMessageId: 0,
      currentNarrative: `Opening ${evil}`,
      greetings: [`Opening 0 ${evil}`, `Opening 1 ${evil}`],
      activeGreetingIndex: 0,
      storyTurns: [{ index: 1, userMessage: evil, narrative: `Turn 1 ${evil}` }],
      customExtensions: {
        regex_scripts: [{ replaceString: `<style>body{}</style><script>alert(1)</script>` }],
        tavern_helper: { scripts: [{ name: 'zod', content: `const s = "${evil}";` }] },
      },
    });

    // Extract the very first <script>...</script> block (the entire shim runtime)
    const firstOpen = doc.indexOf('<script>');
    const firstClose = doc.indexOf('</script>');
    expect(firstOpen).toBeGreaterThan(-1);
    expect(firstClose).toBeGreaterThan(firstOpen);

    const shimJs = doc.slice(firstOpen + '<script>'.length, firstClose);
    // The shim must contain the entire runtime all the way to its closing IIFE, never truncated early
    expect(shimJs).toContain('window.TavernHelper');
    expect(shimJs).toContain('window.Mvu');
    expect(shimJs).toContain('schedulePostH');
    // Must parse as 100% valid JavaScript with zero SyntaxError
    expect(() => new Function(shimJs)).not.toThrow();
  });
});
