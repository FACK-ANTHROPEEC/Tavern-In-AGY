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
      expect(dirPre1.injectSteps?.[0].systemMessage.systemMessage).toContain('[Story Director · Turn Router]');
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

      // 4. [BUG 1] story-writer triggers PreInvocation -> MUST return {} and NOT inject [Story Director · Turn Router] or overwrite shared state
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

      // 7. Next turn: side-pane stages real user text locally and sends only a minimal floor trigger to main chat
      const stagedNow = Date.now();
      const stagedSession = storage.getSession('default');
      stagedSession.stagedSidePaneInput = '她推开殿门，轻声唤道：“主人，该起榻了。”';
      stagedSession.stagedSidePaneInputAt = stagedNow;
      stagedSession.pendingDirectorInput = stagedSession.stagedSidePaneInput;
      stagedSession.pendingDirectorInputAt = stagedNow;
      stagedSession.lastUserInputForCommit = stagedSession.stagedSidePaneInput;
      storage.saveSession(stagedSession);

      const dirNextTurn = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '第 #2 楼 · 开始演绎', invocationNum: 1 },
        storage,
      );
      expect(dirNextTurn.injectSteps?.length).toBe(1);
      expect(dirNextTurn.injectSteps?.[0].systemMessage.systemMessage).toContain('[Story Director · Turn Router]');
      expect(storage.getSession('default').pendingDirectorInput).toBe('她推开殿门，轻声唤道：“主人，该起榻了。”');
      expect(storage.getSession('default').lastUserInputForCommit).toBe('她推开殿门，轻声唤道：“主人，该起榻了。”');
      // Direct channel: PreInvocation must NOT delete stagedSidePaneInput; SessionStart is the sole consumer
      expect(storage.getSession('default').stagedSidePaneInput).toBe('她推开殿门，轻声唤道：“主人，该起榻了。”');

      // 7b. [REGRESSION] AGY fires a 2nd PreInvocation right after invoke_subagent returns (BEFORE writer SessionStart runs!)
      // without invocationNum > 1 -> MUST return {} (no duplicate router prompt) AND MUST NOT overwrite real staged input!
      const dirMidTurnEcho = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '第 #2 楼 · 开始演绎' },
        storage,
      );
      expect(dirMidTurnEcho.injectSteps).toBeUndefined();
      expect(storage.getSession('default').pendingDirectorInput).toBe('她推开殿门，轻声唤道：“主人，该起榻了。”');
      expect(storage.getSession('default').lastUserInputForCommit).toBe('她推开殿门，轻声唤道：“主人，该起榻了。”');

      // 8. Writer SessionStart consumes stagedSidePaneInput/pendingDirectorInput and receives the REAL user input
      const writerStart2 = handleSessionStart({ conversationId: 'writer-conv-2' }, storage);
      const writer2Text = (writerStart2.injectSteps ?? []).map((s) => s.systemMessage.systemMessage).join('\n');
      expect(writer2Text).toContain('她推开殿门，轻声唤道：“主人，该起榻了。”');
      expect(writer2Text).not.toContain('第 #2 楼 · 开始演绎');
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();
      expect(storage.getSession('default').stagedSidePaneInput).toBeUndefined();
      const dirWakeupAfterFailure = handlePreInvocation(
        { conversationId: 'director-conv', lastUserInput: '第 #2 楼 · 开始演绎', invocationNum: 1 },
        storage,
      );
      expect(dirWakeupAfterFailure.injectSteps).toBeUndefined();
      expect(storage.getSession('default').directorTurnState).toBe('idle');

      // 8b. [REGRESSION] Full transcript-backed 4-call director turn (Call 1 dispatch, Call 2 post-invoke, Call 3 wakeup, Call 4 post-kill)
      const transcriptPath = path.join(tmpDir, 'director-transcript.jsonl');
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({ step_index: 7, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-27T08:30:57Z' })}\n`,
        'utf8',
      );
      const stagedNow3 = Date.now() + 5;
      const s3 = storage.getSession('default');
      s3.stagedSidePaneInput = '转身按住她的手腕，低声问她为何深夜来访。';
      s3.stagedSidePaneInputAt = stagedNow3;
      s3.pendingDirectorInput = s3.stagedSidePaneInput;
      s3.pendingDirectorInputAt = stagedNow3;
      s3.lastUserInputForCommit = s3.stagedSidePaneInput;
      storage.saveSession(s3);

      const call1 = handlePreInvocation({ conversationId: 'director-conv', lastUserInput: '第 #3 楼 · 开始演绎', transcriptPath }, storage);
      expect(call1.injectSteps?.length).toBe(1);
      // Call 2: right after invoke_subagent returns (before SessionStart)
      const call2 = handlePreInvocation({ conversationId: 'director-conv', lastUserInput: '第 #3 楼 · 开始演绎', transcriptPath }, storage);
      expect(call2.injectSteps).toBeUndefined();
      // Writer SessionStart + commit
      const writerStart3 = handleSessionStart({ conversationId: 'writer-conv-3' }, storage);
      expect((writerStart3.injectSteps ?? []).map((x) => x.systemMessage.systemMessage).join('\n')).toContain('转身按住她的手腕');
      const s3Committed = storage.getSession('default');
      s3Committed.directorTurnState = 'committed';
      s3Committed.directorCommittedAt = Date.now();
      s3Committed.lastUserInputForCommit = undefined;
      storage.saveSession(s3Committed);
      // Call 3: reactive wakeup after writer sends message
      const call3 = handlePreInvocation({ conversationId: 'director-conv', lastUserInput: '第 #3 楼 · 开始演绎', transcriptPath }, storage);
      expect(call3.injectSteps).toBeUndefined();
      // Call 4: right after manage_subagents(kill) returns -> MUST still return {} (zero duplicate prompt injection!)
      const call4 = handlePreInvocation({ conversationId: 'director-conv', lastUserInput: '第 #3 楼 · 开始演绎', transcriptPath }, storage);
      expect(call4.injectSteps).toBeUndefined();
      expect(storage.getSession('default').pendingDirectorInput).toBeUndefined();

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
