import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RegexScript } from '../core/types';
import { applyRegexScripts, foldUnknownCustomTags, splitFloorSegments } from '../core/regex-engine';
import { extractMemorySummary, stripMemorySummaryTags } from '../core/memory-engine';
import {
  buildProseBeautifierSrcDoc,
  buildSandboxedSrcDoc,
  parseSlashCommandAction,
  type SandboxWorldbookEntry,
  type SandboxWorldbookSnapshot,
} from './sandbox-shim';

interface FloorRendererProps {
  narrative: string;
  messageId: number;
  depth: number;
  regexScripts: RegexScript[];
  enableRegex: boolean;
  proseBeautifierScripts?: Array<{ name: string; content: string }>;
  /** Limits active sandbox iframes to recent floors (default true) so expanding 50+ floors stays lightweight */
  allowSandboxIframe?: boolean;
  unknownTagMode?: 'fold' | 'keep' | 'hide';
  memorySummary?: string;
  memorySummaryDisplayMode?: 'fold' | 'hide';
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  greetings?: string[];
  activeGreetingIndex?: number;
  worldbooks?: SandboxWorldbookSnapshot[];
  worldbookNames?: string[];
  charWorldbookName?: string | null;
  onSendMessage: (text: string) => void;
  onSetInput?: (text: string) => void;
  onUpdateStatData?: (nextStatData: Record<string, unknown>) => void;
  onGetWorldbook?: (bookName: string) => Promise<{ found: boolean; entries: SandboxWorldbookEntry[] }>;
  onReplaceWorldbook?: (bookName: string, entries: SandboxWorldbookEntry[], allowEmpty?: boolean) => void;
  onSelectGreeting?: (index: number) => void;
}

function renderProseText(text: string, keyPrefix: string) {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div key={keyPrefix} className="story-prose">
      {paragraphs.map((p, i) => {
        const isDialogue =
          (p.startsWith('「') && p.endsWith('」')) ||
          (p.startsWith('『') && p.endsWith('』')) ||
          (p.startsWith('“') && p.endsWith('”')) ||
          p.startsWith('>');
        if (isDialogue) {
          return (
            <blockquote key={i} className="story-quote">
              {p.replace(/^>\s*/, '')}
            </blockquote>
          );
        }
        return <p key={i}>{p}</p>;
      })}
    </div>
  );
}

/**
 * Sandboxed inline iframe for preset/card HTML+CSS+JS regex widgets
 * (e.g. preset option cards, styled CoT panels, MVU status bars).
 * Strictly isolates CSS & JS per floor, auto-resizes height, bridges `triggerSlash` to side-pane direct chat,
 * and syncs `replaceVariables` / `insertOrAssignVariables` back to MVU state.
 */
function InlineRegexWidget({
  html,
  title,
  messageId,
  rawNarrative,
  charName,
  userName,
  statData,
  storyTurns,
  greetings,
  activeGreetingIndex,
  worldbooks,
  worldbookNames,
  charWorldbookName,
  onSendMessage,
  onSetInput,
  onUpdateStatData,
  onGetWorldbook,
  onReplaceWorldbook,
  onSelectGreeting,
}: {
  html: string;
  title?: string;
  messageId: number;
  rawNarrative: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  greetings?: string[];
  activeGreetingIndex?: number;
  worldbooks?: SandboxWorldbookSnapshot[];
  worldbookNames?: string[];
  charWorldbookName?: string | null;
  onSendMessage: (text: string) => void;
  onSetInput?: (text: string) => void;
  onUpdateStatData?: (nextStatData: Record<string, unknown>) => void;
  onGetWorldbook?: (bookName: string) => Promise<{ found: boolean; entries: SandboxWorldbookEntry[] }>;
  onReplaceWorldbook?: (bookName: string, entries: SandboxWorldbookEntry[], allowEmpty?: boolean) => void;
  onSelectGreeting?: (index: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(120);
  const widgetId = useMemo(() => `w-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      if (evt.source !== iframeRef.current?.contentWindow) return;
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:resize' && typeof msg.height === 'number') {
        setHeight(Math.max(40, Math.min(1600, Math.ceil(msg.height) + 8)));
      } else if (msg.type === 'tavern:selectGreeting' && typeof msg.index === 'number') {
        onSelectGreeting?.(msg.index);
      } else if (msg.type === 'tavern:slash' && typeof msg.cmd === 'string') {
        const parsed = parseSlashCommandAction(msg.cmd);
        if (parsed?.action === 'selectGreeting' && typeof parsed.index === 'number') {
          onSelectGreeting?.(parsed.index);
        } else if (parsed?.action === 'setInput') {
          onSetInput?.(parsed.text);
        } else if (parsed?.action === 'send') {
          onSendMessage(parsed.text);
        }
      } else if (msg.type === 'tavern:updateStat' && msg.statData && typeof msg.statData === 'object') {
        onUpdateStatData?.(msg.statData as Record<string, unknown>);
      } else if (msg.type === 'tavern:worldbookGet' && typeof msg.requestId === 'string' && typeof msg.bookName === 'string') {
        const reqId = msg.requestId;
        const bName = msg.bookName;
        if (onGetWorldbook) {
          onGetWorldbook(bName).then((res) => {
            try {
              iframeRef.current?.contentWindow?.postMessage(
                { type: 'tavern:worldbookResponse', requestId: reqId, bookName: bName, found: res.found, entries: res.entries },
                '*',
              );
            } catch {
              // ignore
            }
          });
        } else {
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'tavern:worldbookResponse', requestId: reqId, bookName: bName, found: false, entries: [] },
              '*',
            );
          } catch {
            // ignore
          }
        }
      } else if (msg.type === 'tavern:worldbookReplace' && typeof msg.bookName === 'string' && Array.isArray(msg.entries)) {
        onReplaceWorldbook?.(msg.bookName, msg.entries as SandboxWorldbookEntry[], Boolean(msg.allowEmpty));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onSendMessage, onSetInput, onUpdateStatData, onGetWorldbook, onReplaceWorldbook, onSelectGreeting]);

  // Push live stat updates into the mounted iframe without rebuilding srcDoc
  useEffect(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:statSync', statData },
        '*',
      );
    } catch {
      // ignore if iframe not yet ready
    }
  }, [statData]);

  useEffect(() => {
    if (!worldbooks) return;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:worldbookSync', worldbooks },
        '*',
      );
    } catch {
      // ignore
    }
  }, [worldbooks]);

  const srcDoc = useMemo(
    () =>
      buildSandboxedSrcDoc(html, {
        widgetId,
        charName,
        userName,
        statData,
        currentMessageId: messageId,
        currentNarrative: rawNarrative,
        greetings,
        activeGreetingIndex,
        storyTurns,
        worldbooks,
        worldbookNames,
        charWorldbookName,
      }),
    // Intentionally keep statData out of srcDoc deps so live updates flow via postMessage without flickering
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, widgetId, charName, userName, messageId, rawNarrative, greetings?.length, activeGreetingIndex],
  );

  return (
    <div className="inline-widget-wrap">
      {title && <div className="inline-widget-label">{title}</div>}
      <iframe
        ref={iframeRef}
        title={title || 'Preset / Card Widget'}
        className="inline-widget-frame"
        sandbox="allow-scripts allow-same-origin"
        srcDoc={srcDoc}
        style={{ height }}
      />
    </div>
  );
}

/**
 * Isolated `sandbox="allow-scripts"` iframe for SillyTavern `#chat .mes .mes_text` prose beautifier scripts.
 * Omitting `allow-same-origin` ensures scripts cannot access outer React `window.parent.document`
 * and cleanly fall back to the local `#chat > .mes > .mes_block > .mes_text` stage.
 */
function SandboxedProseBlock({
  proseText,
  scripts,
  messageId,
  rawNarrative,
  charName,
  userName,
  statData,
  storyTurns,
  greetings,
  activeGreetingIndex,
  onSendMessage,
  onSetInput,
  onUpdateStatData,
  onSelectGreeting,
}: {
  proseText: string;
  scripts: Array<{ name: string; content: string }>;
  messageId: number;
  rawNarrative: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  greetings?: string[];
  activeGreetingIndex?: number;
  onSendMessage: (text: string) => void;
  onSetInput?: (text: string) => void;
  onUpdateStatData?: (nextStatData: Record<string, unknown>) => void;
  onSelectGreeting?: (index: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(180);
  const widgetId = useMemo(() => `p-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      if (evt.source !== iframeRef.current?.contentWindow) return;
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:resize' && typeof msg.height === 'number') {
        setHeight(Math.max(60, Math.min(12000, Math.ceil(msg.height) + 12)));
      } else if (msg.type === 'tavern:selectGreeting' && typeof msg.index === 'number') {
        onSelectGreeting?.(msg.index);
      } else if (msg.type === 'tavern:slash' && typeof msg.cmd === 'string') {
        const parsed = parseSlashCommandAction(msg.cmd);
        if (parsed?.action === 'selectGreeting' && typeof parsed.index === 'number') {
          onSelectGreeting?.(parsed.index);
        } else if (parsed?.action === 'setInput') {
          onSetInput?.(parsed.text);
        } else if (parsed?.action === 'send') {
          onSendMessage(parsed.text);
        }
      } else if (msg.type === 'tavern:updateStat' && msg.statData && typeof msg.statData === 'object') {
        onUpdateStatData?.(msg.statData as Record<string, unknown>);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onSendMessage, onSetInput, onUpdateStatData, onSelectGreeting]);

  useEffect(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:statSync', statData },
        '*',
      );
    } catch {
      // ignore if iframe not yet ready
    }
  }, [statData]);

  const scriptsKey = useMemo(() => scripts.map((s) => `${s.name}:${s.content.length}`).join('|'), [scripts]);

  const srcDoc = useMemo(
    () =>
      buildProseBeautifierSrcDoc(proseText, scripts, {
        widgetId,
        charName,
        userName,
        statData,
        currentMessageId: messageId,
        currentNarrative: rawNarrative,
        greetings,
        activeGreetingIndex,
        storyTurns,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proseText, scriptsKey, widgetId, charName, userName, messageId, rawNarrative, greetings?.length, activeGreetingIndex],
  );

  return (
    <div className="inline-widget-wrap">
      <iframe
        ref={iframeRef}
        title="Prose Beautifier"
        className="inline-widget-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height }}
      />
    </div>
  );
}

export function FloorRenderer({
  narrative,
  messageId,
  depth,
  regexScripts,
  enableRegex,
  proseBeautifierScripts,
  allowSandboxIframe = true,
  unknownTagMode = 'fold',
  memorySummary,
  memorySummaryDisplayMode = 'fold',
  charName,
  userName,
  statData,
  storyTurns,
  greetings,
  activeGreetingIndex,
  worldbooks,
  worldbookNames,
  charWorldbookName,
  onSendMessage,
  onSetInput,
  onUpdateStatData,
  onGetWorldbook,
  onReplaceWorldbook,
  onSelectGreeting,
}: FloorRendererProps) {
  const { cleanNarrative, resolvedSummary } = useMemo(() => {
    const extracted = extractMemorySummary(narrative);
    const cleaned = stripMemorySummaryTags(narrative);
    return {
      cleanNarrative: cleaned,
      resolvedSummary: (memorySummary && memorySummary.trim()) || extracted.summary || '',
    };
  }, [narrative, memorySummary]);

  const segments = useMemo(() => {
    if (!enableRegex) {
      return [{ kind: 'text' as const, content: cleanNarrative }];
    }

    // 1. Run preset & card display regex scripts FIRST (strict SillyTavern order)
    //    so every preset's own option cards, CoT panels, and card status bars render faithfully.
    const afterRegex =
      regexScripts.length > 0
        ? applyRegexScripts(cleanNarrative, regexScripts, {
            placement: 2,
            target: 'display',
            depth,
            macroCtx: {
              char: charName,
              user: userName,
              vars: {},
              statData,
            },
          })
        : cleanNarrative;

    // 2. Generic post-regex fallback: unwrap prose containers (<content>/<narrative>),
    //    clean unconsumed empty placeholders (<StatusPlaceHolderImpl/>), and handle ANY
    //    unseen custom XML tag not matched by preset/card regexes according to unknownTagMode.
    const afterGenericFallback = foldUnknownCustomTags(afterRegex, unknownTagMode);

    // 3. Deterministic 3-way split (text / static html / CSS+JS sandboxed widget)
    return splitFloorSegments(afterGenericFallback);
  }, [cleanNarrative, depth, regexScripts, enableRegex, unknownTagMode, charName, userName, statData]);

  return (
    <div className="floor-segments">
      {segments.map((seg, idx) => {
        if (seg.kind === 'text') {
          if (allowSandboxIframe && enableRegex && proseBeautifierScripts && proseBeautifierScripts.length > 0) {
            return (
              <SandboxedProseBlock
                key={`prose-${idx}`}
                proseText={seg.content}
                scripts={proseBeautifierScripts}
                messageId={messageId}
                rawNarrative={cleanNarrative}
                charName={charName}
                userName={userName}
                statData={statData}
                storyTurns={storyTurns}
                greetings={greetings}
                activeGreetingIndex={activeGreetingIndex}
                onSendMessage={onSendMessage}
                onSetInput={onSetInput}
                onUpdateStatData={onUpdateStatData}
                onSelectGreeting={onSelectGreeting}
              />
            );
          }
          return renderProseText(seg.content, `txt-${idx}`);
        }
        if (seg.kind === 'html') {
          return (
            <div
              key={`html-${idx}`}
              className="story-html-block"
              dangerouslySetInnerHTML={{ __html: seg.html }}
            />
          );
        }
        if (!allowSandboxIframe) {
          return (
            <div key={`wid-skip-${idx}`} className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
              [{seg.title || '历史楼层交互组件'} · 仅最新 10 楼挂载沙箱以节省内存]
            </div>
          );
        }
        return (
          <InlineRegexWidget
            key={`wid-${idx}`}
            html={seg.html}
            title={seg.title}
            messageId={messageId}
            rawNarrative={cleanNarrative}
            charName={charName}
            userName={userName}
            statData={statData}
            storyTurns={storyTurns}
            greetings={greetings}
            activeGreetingIndex={activeGreetingIndex}
            worldbooks={worldbooks}
            worldbookNames={worldbookNames}
            charWorldbookName={charWorldbookName}
            onSendMessage={onSendMessage}
            onSetInput={onSetInput}
            onUpdateStatData={onUpdateStatData}
            onGetWorldbook={onGetWorldbook}
            onReplaceWorldbook={onReplaceWorldbook}
            onSelectGreeting={onSelectGreeting}
          />
        );
      })}
      {resolvedSummary && memorySummaryDisplayMode !== 'hide' && (
        <details className="memory-summary-fold">
          <summary>记忆摘要 · {resolvedSummary.length} 字</summary>
          <div className="memory-summary-body">{resolvedSummary}</div>
        </details>
      )}
    </div>
  );
}
