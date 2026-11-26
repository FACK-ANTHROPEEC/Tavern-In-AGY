import React, { useEffect, useRef, useState } from 'react';

export interface FrontendHtmlTemplate {
  name: string;
  findRegex: string;
  html: string;
}

export interface HelperScriptItem {
  name: string;
  content: string;
  enabled: boolean;
}

export interface CardFrontendPayload {
  cardId: string;
  cardName: string;
  htmlTemplates: FrontendHtmlTemplate[];
  helperScripts: HelperScriptItem[];
  customExtensions: Record<string, unknown>;
}

interface TavernFrontendHostProps {
  frontend: CardFrontendPayload;
  statData: Record<string, unknown>;
  userName: string;
  storyTurns: Array<{ index: number; userMessage?: string; narrative: string }>;
  onSendSlashOrMessage: (text: string) => void;
  onUpdateStatData: (nextStatData: Record<string, unknown>) => void;
}

/**
 * Generic side-pane host for SillyTavern card frontend beautification HTML
 * and JS-Slash-Runner (`tavern_helper`) floating-ball scripts.
 * Redirects `window.parent` / `document.body` into a scoped side-pane stage
 * so nothing ever touches AGY's main window DOM.
 */
export function TavernFrontendHost({
  frontend,
  statData,
  userName,
  storyTurns,
  onSendSlashOrMessage,
  onUpdateStatData,
}: TavernFrontendHostProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const listenersRef = useRef<Map<string, Array<(...args: unknown[]) => void>>>(new Map());
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState(0);
  const [mountedHtml, setMountedHtml] = useState(false);
  const [mountedHelper, setMountedHelper] = useState(false);
  const [hostLog, setHostLog] = useState<string>('');

  const statRef = useRef(statData);
  statRef.current = statData;

  // Notify registered TavernHelper listeners whenever statData updates
  useEffect(() => {
    const map = listenersRef.current;
    for (const evt of ['MESSAGE_RECEIVED', 'GENERATION_ENDED', 'VARIABLES_UPDATED', 'mvu_variable_update_ended']) {
      for (const fn of map.get(evt) ?? []) {
        try {
          fn(statData);
        } catch {
          // ignore card script listener errors
        }
      }
    }
  }, [statData, storyTurns.length]);

  function buildRuntimeShim(mountRoot: HTMLElement) {
    const emit = (evt: string, ...args: unknown[]) => {
      for (const fn of listenersRef.current.get(evt) ?? []) {
        try {
          fn(...args);
        } catch {
          // ignore
        }
      }
    };

    const eventOn = (evt: string, fn: (...args: unknown[]) => void) => {
      const list = listenersRef.current.get(evt) ?? [];
      list.push(fn);
      listenersRef.current.set(evt, list);
    };

    const getVariables = () => ({ stat_data: statRef.current, ...statRef.current });

    const replaceVariables = (next: Record<string, unknown>) => {
      const nextStat =
        next && typeof next.stat_data === 'object' && next.stat_data
          ? (next.stat_data as Record<string, unknown>)
          : next;
      statRef.current = nextStat;
      onUpdateStatData(nextStat);
      emit('VARIABLES_UPDATED', nextStat);
    };

    const insertOrAssignVariables = (patch: Record<string, unknown>) => {
      const merged = { ...statRef.current, ...patch };
      replaceVariables(merged);
    };

    const getChatMessages = () =>
      storyTurns.map((t) => ({
        message_id: t.index,
        name: frontend.cardName,
        role: 'assistant',
        is_user: false,
        message: t.narrative,
        data: { stat_data: statRef.current },
      }));

    const triggerSlash = (cmd: string) => {
      const cleaned = String(cmd || '').replace(/^\/send\s+/i, '').trim();
      if (cleaned) onSendSlashOrMessage(cleaned);
    };

    const SillyTavern = {
      getContext: () => ({
        name1: userName,
        name2: frontend.cardName,
        characterId: 0,
        characters: [
          {
            name: frontend.cardName,
            data: {
              name: frontend.cardName,
              extensions: frontend.customExtensions,
            },
          },
        ],
        chat: getChatMessages(),
        chatMetadata: { variables: getVariables() },
      }),
    };

    const TavernHelper = {
      getVariables,
      replaceVariables,
      insertOrAssignVariables,
      getChatMessages,
      triggerSlash,
      eventOn,
      eventEmit: emit,
    };

    // Redirect `document.body` to our scoped side-pane stage so floating balls stay inside the side pane!
    const scopedDocument = new Proxy(document, {
      get(target, prop) {
        if (prop === 'body') return mountRoot;
        const val = Reflect.get(target, prop);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    const scopedWindow = new Proxy(window, {
      get(target, prop) {
        if (prop === 'parent' || prop === 'top' || prop === 'self' || prop === 'window') {
          return scopedWindow;
        }
        if (prop === 'document') return scopedDocument;
        if (prop === 'TavernHelper') return TavernHelper;
        if (prop === 'SillyTavern') return SillyTavern;
        if (prop === 'getVariables') return getVariables;
        if (prop === 'replaceVariables') return replaceVariables;
        if (prop === 'insertOrAssignVariables') return insertOrAssignVariables;
        if (prop === 'getChatMessages') return getChatMessages;
        if (prop === 'triggerSlash') return triggerSlash;
        if (prop === 'eventOn') return eventOn;
        const val = Reflect.get(target, prop);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    return {
      TavernHelper,
      SillyTavern,
      scopedDocument,
      scopedWindow,
      getVariables,
      replaceVariables,
      insertOrAssignVariables,
      getChatMessages,
      triggerSlash,
      eventOn,
    };
  }

  function mountHtmlTemplate() {
    const stage = stageRef.current;
    const tpl = frontend.htmlTemplates[selectedTemplateIdx];
    if (!stage || !tpl) return;

    stage.innerHTML = '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(tpl.html, 'text/html');

    // Inject scoped styles + body markup
    const wrapper = document.createElement('div');
    wrapper.className = 'card-frontend-stage-inner';
    doc.querySelectorAll('style').forEach((styleEl) => {
      wrapper.appendChild(styleEl.cloneNode(true));
    });

    const bodyClone = document.createElement('div');
    bodyClone.innerHTML = doc.body.innerHTML;
    const scripts = Array.from(bodyClone.querySelectorAll('script'));
    scripts.forEach((s) => s.remove());
    wrapper.appendChild(bodyClone);
    stage.appendChild(wrapper);

    // Execute inline scripts against our generic TavernHelper shim
    const shim = buildRuntimeShim(wrapper);
    let okCount = 0;
    let errMsg = '';
    for (const sc of scripts) {
      const code = sc.textContent || '';
      if (!code.trim()) continue;
      try {
        const fn = new Function(
          'window',
          'parent',
          'document',
          'TavernHelper',
          'SillyTavern',
          'getVariables',
          'replaceVariables',
          'insertOrAssignVariables',
          'getChatMessages',
          'triggerSlash',
          'eventOn',
          code,
        );
        fn(
          shim.scopedWindow,
          shim.scopedWindow,
          shim.scopedDocument,
          shim.TavernHelper,
          shim.SillyTavern,
          shim.getVariables,
          shim.replaceVariables,
          shim.insertOrAssignVariables,
          shim.getChatMessages,
          shim.triggerSlash,
          shim.eventOn,
        );
        okCount += 1;
      } catch (err) {
        errMsg = String(err);
      }
    }

    setMountedHtml(true);
    setHostLog(
      errMsg
        ? `已挂载「${tpl.name}」（执行 ${okCount} 段脚本，部分兼容性提示：${errMsg.slice(0, 80)}）`
        : `已成功在侧边栏挂载「${tpl.name}」（运行 ${okCount} 段脚本）`,
    );
  }

  function mountHelperScripts() {
    const stage = stageRef.current;
    if (!stage || frontend.helperScripts.length === 0) return;

    const shim = buildRuntimeShim(stage);
    let okCount = 0;
    let errMsg = '';
    for (const sc of frontend.helperScripts) {
      try {
        const fn = new Function(
          'window',
          'parent',
          'document',
          'TavernHelper',
          'SillyTavern',
          'getVariables',
          'replaceVariables',
          'insertOrAssignVariables',
          'getChatMessages',
          'triggerSlash',
          'eventOn',
          sc.content,
        );
        fn(
          shim.scopedWindow,
          shim.scopedWindow,
          shim.scopedDocument,
          shim.TavernHelper,
          shim.SillyTavern,
          shim.getVariables,
          shim.replaceVariables,
          shim.insertOrAssignVariables,
          shim.getChatMessages,
          shim.triggerSlash,
          shim.eventOn,
        );
        okCount += 1;
      } catch (err) {
        errMsg = String(err);
      }
    }
    setMountedHelper(true);
    setHostLog(
      errMsg
        ? `已加载 ${okCount}/${frontend.helperScripts.length} 个助手脚本（兼容提示：${errMsg.slice(0, 80)}）`
        : `已将 ${okCount} 个酒馆助手脚本挂载到侧边栏舞台！`,
    );
  }

  return (
    <div className="card-box">
      <div className="row">
        <strong>角色卡前端美化 / 悬浮球舞台（TavernHelper 垫片）</strong>
      </div>

      {frontend.htmlTemplates.length > 0 && (
        <div className="row">
          <select
            className="input"
            value={selectedTemplateIdx}
            onChange={(e) => setSelectedTemplateIdx(Number(e.target.value))}
          >
            {frontend.htmlTemplates.map((t, i) => (
              <option key={i} value={i}>
                状态栏 HTML：{t.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={mountHtmlTemplate}>
            {mountedHtml ? '重新渲染' : '渲染状态栏'}
          </button>
        </div>
      )}

      {frontend.helperScripts.length > 0 && (
        <div className="row">
          <span className="muted">
            检测到 {frontend.helperScripts.length} 个酒馆助手脚本（{frontend.helperScripts.map((s) => s.name).join('、')}）
          </span>
          <button className="btn" onClick={mountHelperScripts}>
            {mountedHelper ? '已挂载' : '挂载到侧边栏'}
          </button>
        </div>
      )}

      {hostLog && <div className="muted">{hostLog}</div>}

      <div
        ref={stageRef}
        className="frontend-stage"
        style={{
          position: 'relative',
          minHeight: mountedHtml || mountedHelper ? 260 : 0,
          overflow: 'auto',
          border: mountedHtml || mountedHelper ? '1px solid var(--ink-border)' : 'none',
          borderRadius: 2,
        }}
      />
    </div>
  );
}
