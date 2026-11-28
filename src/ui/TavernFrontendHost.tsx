import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildHelperScriptsStageHtml,
  buildSandboxedSrcDoc,
  parseSlashCommandToMessage,
  type SandboxCharData,
  type SandboxWorldbookEntry,
  type SandboxWorldbookSnapshot,
} from './sandbox-shim';

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
  worldbooks?: SandboxWorldbookSnapshot[];
  charWorldbookName?: string | null;
  charData?: SandboxCharData;
}

interface TavernFrontendHostProps {
  frontend: CardFrontendPayload;
  statData: Record<string, unknown>;
  userName: string;
  storyTurns: Array<{ index: number; userMessage?: string; narrative: string }>;
  onSendSlashOrMessage: (text: string) => void;
  onUpdateStatData: (nextStatData: Record<string, unknown>) => void;
  onReplaceWorldbook?: (bookName: string, entries: SandboxWorldbookEntry[]) => void;
  onScriptError?: (scriptName: string, message: string) => void;
}

/**
 * Generic CSP-safe side-pane stage for Character Card card frontend beautification HTML
 * and JS-Slash-Runner (`tavern_helper`) scripts.
 * Renders inside an isolated `<iframe sandbox="allow-scripts" srcDoc>` (avoiding `unsafe-eval` / `new Function`
 * and preventing any card CSS from polluting the side-pane UI).
 */
export function TavernFrontendHost({
  frontend,
  statData,
  userName,
  storyTurns,
  onSendSlashOrMessage,
  onUpdateStatData,
  onReplaceWorldbook,
  onScriptError,
}: TavernFrontendHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const prevTurnCountRef = useRef<number>(storyTurns.length);
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState(0);
  const [mountMode, setMountMode] = useState<'none' | 'html' | 'helper'>('none');
  const [mountRevision, setMountRevision] = useState(0);
  const [frameHeight, setFrameHeight] = useState<number>(320);
  const [hostLog, setHostLog] = useState<string>('');
  const widgetId = useMemo(() => `stage-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      if (evt.source !== iframeRef.current?.contentWindow) return;
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:resize' && typeof msg.height === 'number') {
        setFrameHeight(Math.max(220, Math.min(900, Math.ceil(msg.height) + 16)));
      } else if (msg.type === 'tavern:slash' && typeof msg.cmd === 'string') {
        const parsed = parseSlashCommandToMessage(msg.cmd);
        if (parsed) onSendSlashOrMessage(parsed);
      } else if (msg.type === 'tavern:updateStat' && msg.statData && typeof msg.statData === 'object') {
        onUpdateStatData(msg.statData as Record<string, unknown>);
      } else if (msg.type === 'tavern:worldbookReplace' && typeof msg.bookName === 'string' && Array.isArray(msg.entries)) {
        onReplaceWorldbook?.(msg.bookName, msg.entries as SandboxWorldbookEntry[]);
      } else if (msg.type === 'tavern:scriptError' && typeof msg.message === 'string') {
        const name = typeof msg.scriptName === 'string' ? msg.scriptName : 'script';
        setHostLog(`脚本异常 [${name}]：${msg.message}`);
        onScriptError?.(name, msg.message);
      } else if (msg.type === 'tavern:toast' && typeof msg.text === 'string' && msg.text.trim()) {
        setHostLog(`卡片提示：${msg.text.trim()}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onSendSlashOrMessage, onUpdateStatData, onReplaceWorldbook, onScriptError]);

  // Push live stat updates to mounted iframe without remounting
  useEffect(() => {
    if (mountMode === 'none') return;
    const turnCountChanged = storyTurns.length !== prevTurnCountRef.current;
    prevTurnCountRef.current = storyTurns.length;
    const lastMessageId = storyTurns.length > 0 ? storyTurns[storyTurns.length - 1].index : 0;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:statSync', statData, turnCountChanged, lastMessageId },
        '*',
      );
    } catch {
      // ignore
    }
  }, [statData, storyTurns, mountMode]);

  useEffect(() => {
    if (mountMode === 'none' || !frontend.worldbooks) return;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:worldbookSync', worldbooks: frontend.worldbooks },
        '*',
      );
    } catch {
      // ignore
    }
  }, [frontend.worldbooks, mountMode]);

  const srcDoc = useMemo(() => {
    if (mountMode === 'none') return '';
    if (mountMode === 'html') {
      const tpl = frontend.htmlTemplates[selectedTemplateIdx];
      if (!tpl) return '';
      return buildSandboxedSrcDoc(tpl.html, {
        widgetId,
        charName: frontend.cardName,
        userName,
        statData,
        storyTurns,
        customExtensions: frontend.customExtensions,
        worldbooks: frontend.worldbooks,
        charWorldbookName: frontend.charWorldbookName,
        charData: frontend.charData,
      });
    }
    // Helper scripts mode: wrap all enabled helper scripts inside an isolated stage document
    const helperHtml = buildHelperScriptsStageHtml(frontend.helperScripts);
    return buildSandboxedSrcDoc(helperHtml, {
      widgetId,
      charName: frontend.cardName,
      userName,
      statData,
      storyTurns,
      customExtensions: frontend.customExtensions,
      worldbooks: frontend.worldbooks,
      charWorldbookName: frontend.charWorldbookName,
      charData: frontend.charData,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountMode, mountRevision, selectedTemplateIdx, frontend, widgetId, userName]);

  return (
    <div className="card-box">
      <div className="row">
        <strong>角色卡前端美化 / 悬浮球舞台（隔离 iframe 沙箱）</strong>
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
          <button
            className="btn btn-primary"
            onClick={() => {
              const tpl = frontend.htmlTemplates[selectedTemplateIdx];
              setMountMode('html');
              setMountRevision((r) => r + 1);
              setHostLog(`已在独立沙箱 iframe 中渲染「${tpl?.name ?? '状态栏'}」`);
            }}
          >
            {mountMode === 'html' ? '重新渲染' : '渲染状态栏'}
          </button>
        </div>
      )}

      {frontend.helperScripts.length > 0 && (
        <div className="row">
          <span className="muted">
            检测到 {frontend.helperScripts.length} 个卡片扩展脚本（{frontend.helperScripts.map((s) => s.name).join('、')}）
          </span>
          <button
            className="btn"
            onClick={() => {
              setMountMode('helper');
              setMountRevision((r) => r + 1);
              setHostLog(`已将 ${frontend.helperScripts.length} 个卡片扩展脚本挂载至独立沙箱舞台`);
            }}
          >
            {mountMode === 'helper' ? '重新挂载' : '挂载到侧边栏'}
          </button>
        </div>
      )}

      {hostLog && <div className="muted">{hostLog}</div>}

      {mountMode !== 'none' && srcDoc && (
        <iframe
          key={`${mountMode}-${mountRevision}-${selectedTemplateIdx}`}
          ref={iframeRef}
          title="Tavern Card Frontend Sandbox"
          className="inline-widget-frame"
          sandbox="allow-scripts allow-same-origin"
          srcDoc={srcDoc}
          style={{
            width: '100%',
            height: frameHeight,
            border: '1px solid var(--ink-border)',
            borderRadius: 2,
            background: 'transparent',
          }}
        />
      )}
    </div>
  );
}
