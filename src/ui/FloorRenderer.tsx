import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RegexScript } from '../core/types';
import { applyRegexScripts, foldUnknownCustomTags, splitFloorSegments } from '../core/regex-engine';
import { buildSandboxedSrcDoc, parseSlashCommandAction } from './sandbox-shim';

interface FloorRendererProps {
  narrative: string;
  messageId: number;
  depth: number;
  regexScripts: RegexScript[];
  enableRegex: boolean;
  unknownTagMode?: 'fold' | 'keep' | 'hide';
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  onSendMessage: (text: string) => void;
  onSetInput?: (text: string) => void;
  onUpdateStatData?: (nextStatData: Record<string, unknown>) => void;
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
  onSendMessage,
  onSetInput,
  onUpdateStatData,
}: {
  html: string;
  title?: string;
  messageId: number;
  rawNarrative: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  onSendMessage: (text: string) => void;
  onSetInput?: (text: string) => void;
  onUpdateStatData?: (nextStatData: Record<string, unknown>) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(120);
  const widgetId = useMemo(() => `w-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:resize' && typeof msg.height === 'number') {
        setHeight(Math.max(40, Math.min(1600, Math.ceil(msg.height) + 8)));
      } else if (msg.type === 'tavern:slash' && typeof msg.cmd === 'string') {
        const parsed = parseSlashCommandAction(msg.cmd);
        if (parsed?.action === 'setInput') {
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
  }, [widgetId, onSendMessage, onSetInput, onUpdateStatData]);

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

  const srcDoc = useMemo(
    () =>
      buildSandboxedSrcDoc(html, {
        widgetId,
        charName,
        userName,
        statData,
        currentMessageId: messageId,
        currentNarrative: rawNarrative,
        storyTurns,
      }),
    // Intentionally keep statData out of srcDoc deps so live updates flow via postMessage without flickering
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, widgetId, charName, userName, messageId, rawNarrative],
  );

  return (
    <div className="inline-widget-wrap">
      {title && <div className="inline-widget-label">{title}</div>}
      <iframe
        ref={iframeRef}
        title={title || 'Preset / Card Widget'}
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
  unknownTagMode = 'fold',
  charName,
  userName,
  statData,
  storyTurns,
  onSendMessage,
  onSetInput,
  onUpdateStatData,
}: FloorRendererProps) {
  const segments = useMemo(() => {
    if (!enableRegex) {
      return [{ kind: 'text' as const, content: narrative }];
    }

    // 1. Run preset & card display regex scripts FIRST (strict SillyTavern order)
    //    so every preset's own option cards, CoT panels, and card status bars render faithfully.
    const afterRegex =
      regexScripts.length > 0
        ? applyRegexScripts(narrative, regexScripts, {
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
        : narrative;

    // 2. Generic post-regex fallback: unwrap prose containers (<content>/<narrative>),
    //    clean unconsumed empty placeholders (<StatusPlaceHolderImpl/>), and handle ANY
    //    unseen custom XML tag not matched by preset/card regexes according to unknownTagMode.
    const afterGenericFallback = foldUnknownCustomTags(afterRegex, unknownTagMode);

    // 3. Deterministic 3-way split (text / static html / CSS+JS sandboxed widget)
    return splitFloorSegments(afterGenericFallback);
  }, [narrative, depth, regexScripts, enableRegex, unknownTagMode, charName, userName, statData]);

  return (
    <div className="floor-segments">
      {segments.map((seg, idx) => {
        if (seg.kind === 'text') {
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
        return (
          <InlineRegexWidget
            key={`wid-${idx}`}
            html={seg.html}
            title={seg.title}
            messageId={messageId}
            rawNarrative={narrative}
            charName={charName}
            userName={userName}
            statData={statData}
            storyTurns={storyTurns}
            onSendMessage={onSendMessage}
            onSetInput={onSetInput}
            onUpdateStatData={onUpdateStatData}
          />
        );
      })}
    </div>
  );
}
