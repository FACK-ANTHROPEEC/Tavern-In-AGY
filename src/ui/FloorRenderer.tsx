import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RegexScript } from '../core/types';
import { applyRegexScripts, splitFloorSegments } from '../core/regex-engine';

interface FloorRendererProps {
  narrative: string;
  depth: number;
  regexScripts: RegexScript[];
  enableRegex: boolean;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  onSendMessage: (text: string) => void;
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
 * Sandboxed inline iframe for preset/card HTML+JS regex widgets
 * (e.g. Wave options/plan cards, Meowssiah collapsible thinking, Xiajin action options).
 * Isolates CSS cleanly, auto-resizes height, and bridges `triggerSlash` to side-pane direct chat.
 */
function InlineRegexWidget({
  html,
  title,
  charName,
  userName,
  statData,
  onSendMessage,
}: {
  html: string;
  title?: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  onSendMessage: (text: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(120);
  const widgetId = useMemo(() => `w-${Math.random().toString(36).slice(2, 9)}`, []);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:resize' && typeof msg.height === 'number') {
        setHeight(Math.max(48, Math.min(720, Math.ceil(msg.height) + 8)));
      } else if (msg.type === 'tavern:slash' && typeof msg.cmd === 'string') {
        const cleaned = msg.cmd.replace(/^\/send\s+/i, '').trim();
        if (cleaned) onSendMessage(cleaned);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onSendMessage]);

  const srcDoc = useMemo(() => {
    const bridgeScript = `<script>
(function(){
  const WID = ${JSON.stringify(widgetId)};
  const STAT = ${JSON.stringify(statData)};
  const CHAR = ${JSON.stringify(charName)};
  const USER = ${JSON.stringify(userName)};
  const triggerSlash = function(cmd){
    try { window.parent.postMessage({ widgetId: WID, type: 'tavern:slash', cmd: String(cmd || '') }, '*'); } catch(e){}
  };
  const getVariables = function(){ return Object.assign({ stat_data: STAT }, STAT); };
  const eventOn = function(){};
  const getChatMessages = function(){ return []; };
  window.triggerSlash = triggerSlash;
  window.getVariables = getVariables;
  window.eventOn = eventOn;
  window.getChatMessages = getChatMessages;
  window.TavernHelper = { triggerSlash, getVariables, eventOn, getChatMessages };
  window.SillyTavern = { getContext: function(){ return { name1: USER, name2: CHAR, chatMetadata: { variables: getVariables() } }; } };
  function postH(){
    try {
      const h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0);
      window.parent.postMessage({ widgetId: WID, type: 'tavern:resize', height: h }, '*');
    } catch(e){}
  }
  window.addEventListener('load', function(){ postH(); setTimeout(postH, 150); setTimeout(postH, 500); });
  if (typeof ResizeObserver !== 'undefined') {
    window.addEventListener('DOMContentLoaded', function(){
      if (document.body) new ResizeObserver(postH).observe(document.body);
      postH();
    });
  }
})();
</script>`;

    const baseStyle = `<style>html,body{margin:0;padding:4px;background:transparent;color:#e5d9c3;font-family:"Noto Serif SC","Source Han Serif SC",serif;}</style>`;
    if (/<head\b[^>]*>/i.test(html)) {
      return html.replace(/<head\b[^>]*>/i, (m) => `${m}${baseStyle}${bridgeScript}`);
    }
    if (/<html\b[^>]*>/i.test(html)) {
      return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${baseStyle}${bridgeScript}</head>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8" />${baseStyle}${bridgeScript}</head><body>${html}</body></html>`;
  }, [html, widgetId, statData, charName, userName]);

  return (
    <div className="inline-widget-wrap">
      {title && <div className="inline-widget-label">{title}</div>}
      <iframe
        ref={iframeRef}
        title={title || 'Preset Widget'}
        className="inline-widget-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height }}
      />
    </div>
  );
}

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const NATIVE_COT_TAGS: Array<{ tag: string; label: string }> = [
  { tag: 'wave_plan', label: '📋 创作规划（Wave Plan）' },
  { tag: 'think_nya', label: '💭 思维链（Think）' },
  { tag: 'report_nya', label: '📋 思考报告' },
  { tag: 'thinking', label: '💭 思维链（Thinking）' },
  { tag: 'think', label: '💭 思维链（Think）' },
  { tag: 'thought', label: '💭 思考' },
  { tag: 'wave_summary', label: '📝 本楼记事' },
  { tag: 'wave_review', label: '🔍 成稿回看' },
  { tag: 'wave_comment', label: '💬 浪潮插话' },
  { tag: 'background', label: '📜 背景剧情' },
];

/**
 * Converts standard preset CoT / plan / summary tags directly into zero-script native
 * `<details>` accordions so they never fail inside nested MCP App CSP sandboxes.
 */
function preprocessNativeTags(raw: string): string {
  let out = raw;
  // Unwrap <content>...</content> cleanly
  out = out.replace(/<content>\s*([\s\S]*?)\s*<\/content>/gi, '$1');
  // Beautify <wave_mind>...</wave_mind> as italic inner thought
  out = out.replace(/<wave_mind>\s*([\s\S]*?)\s*<\/wave_mind>/gi, (_m, inner: string) => {
    return `\n> *${inner.trim()}*\n`;
  });
  // Remove <wave_options> / <options> raw block if clickable options strip already handles it,
  // or fold it cleanly into a native details card
  out = out.replace(/<(?:wave_options|options)>\s*([\s\S]*?)\s*<\/(?:wave_options|options)>/gi, (_m, inner: string) => {
    const safe = escapeHtmlText(inner.trim()).replace(/\n/g, '<br/>');
    return `\n<details><summary>🧭 备选走法</summary><div class="cot-body">${safe}</div></details>\n`;
  });
  for (const { tag, label } of NATIVE_COT_TAGS) {
    const re = new RegExp(`<${tag}~?>\\s*([\\s\\S]*?)\\s*<\\/${tag}~?>`, 'gi');
    out = out.replace(re, (_m, inner: string) => {
      const safe = escapeHtmlText(inner.trim()).replace(/\n/g, '<br/>');
      return `\n<details><summary>${label}</summary><div class="cot-body">${safe}</div></details>\n`;
    });
  }
  return out;
}

export function FloorRenderer({
  narrative,
  depth,
  regexScripts,
  enableRegex,
  charName,
  userName,
  statData,
  onSendMessage,
}: FloorRendererProps) {
  const segments = useMemo(() => {
    if (!enableRegex) {
      return [{ kind: 'text' as const, content: narrative }];
    }

    // 1. Convert standard CoT / plan / summary tags to zero-script native Warm Ink accordions first
    const withNativeFolds = preprocessNativeTags(narrative);

    // 2. Run preset & card display regex scripts (e.g. prose cleanup, punctuation, custom HTML blocks)
    const processed =
      regexScripts.length > 0
        ? applyRegexScripts(withNativeFolds, regexScripts, {
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
        : withNativeFolds;

    return splitFloorSegments(processed);
  }, [narrative, depth, regexScripts, enableRegex, charName, userName, statData]);

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
            charName={charName}
            userName={userName}
            statData={statData}
            onSendMessage={onSendMessage}
          />
        );
      })}
    </div>
  );
}
