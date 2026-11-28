import React, { useEffect, useMemo, useRef } from 'react';
import {
  buildHelperScriptsStageHtml,
  buildSandboxedSrcDoc,
  type SandboxWorldbookEntry,
} from './sandbox-shim';
import type { CardFrontendPayload } from './TavernFrontendHost';

interface MvuZodRuntimeHostProps {
  frontend: CardFrontendPayload | null;
  statData: Record<string, unknown>;
  userName: string;
  chatSlot?: string;
  storyTurns: Array<{ index: number; userMessage?: string; narrative: string }>;
  onUpdateStatData: (nextStatData: Record<string, unknown>) => void;
  onReplaceWorldbook?: (bookName: string, entries: SandboxWorldbookEntry[]) => void;
  onSchemaCountChange?: (count: number) => void;
  onScriptError?: (scriptName: string, message: string) => void;
}

/**
 * Silent background sandbox iframe that auto-runs enabled card/preset helper scripts
 * (such as MVU Zod `registerMvuSchema` scripts) so Zod validation and derived fields
 * stay active automatically across turns without requiring manual stage mounting.
 */
export function MvuZodRuntimeHost({
  frontend,
  statData,
  userName,
  chatSlot,
  storyTurns,
  onUpdateStatData,
  onReplaceWorldbook,
  onSchemaCountChange,
  onScriptError,
}: MvuZodRuntimeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeLoadedRef = useRef<boolean>(false);
  const lastPushedJsonRef = useRef<string>('');
  const bakedStatJsonRef = useRef<string>('');
  const latestStatDataRef = useRef<Record<string, unknown>>(statData ?? {});
  const prevTurnCountRef = useRef<number>(storyTurns.length);
  const prevChatSlotRef = useRef<string | undefined>(chatSlot);
  const widgetId = useMemo(() => `mvuzod-${Math.random().toString(36).slice(2, 9)}`, []);

  latestStatDataRef.current = statData ?? {};

  const enabledScripts = frontend?.helperScripts ?? [];
  const scriptsSignature = useMemo(
    () =>
      frontend
        ? `${frontend.cardId}:${enabledScripts.map((s) => `${s.name}:${s.content.length}`).join('|')}`
        : '',
    [frontend, enabledScripts],
  );

  useEffect(() => {
    onSchemaCountChange?.(0);
    iframeLoadedRef.current = false;
    lastPushedJsonRef.current = '';
  }, [scriptsSignature, onSchemaCountChange]);

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      if (evt.source !== iframeRef.current?.contentWindow) return;
      const msg = evt.data;
      if (!msg || typeof msg !== 'object' || msg.widgetId !== widgetId) return;
      if (msg.type === 'tavern:schemaRegistered' && typeof msg.count === 'number') {
        onSchemaCountChange?.(msg.count);
      } else if (msg.type === 'tavern:updateStat' && msg.statData && typeof msg.statData === 'object') {
        const nextJson = JSON.stringify(msg.statData);
        if (nextJson !== lastPushedJsonRef.current) {
          lastPushedJsonRef.current = nextJson;
          onUpdateStatData(msg.statData as Record<string, unknown>);
        }
      } else if (msg.type === 'tavern:worldbookReplace' && typeof msg.bookName === 'string' && Array.isArray(msg.entries)) {
        onReplaceWorldbook?.(msg.bookName, msg.entries as SandboxWorldbookEntry[]);
      } else if (msg.type === 'tavern:scriptError' && typeof msg.message === 'string') {
        onScriptError?.(typeof msg.scriptName === 'string' ? msg.scriptName : 'script', msg.message);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onUpdateStatData, onReplaceWorldbook, onSchemaCountChange, onScriptError]);

  useEffect(() => {
    if (!scriptsSignature || !iframeLoadedRef.current) return;
    const curJson = JSON.stringify(statData ?? {});
    const turnCountChanged = storyTurns.length !== prevTurnCountRef.current;
    prevTurnCountRef.current = storyTurns.length;
    if (curJson === lastPushedJsonRef.current && !turnCountChanged) return;
    lastPushedJsonRef.current = curJson;
    const lastMessageId = storyTurns.length > 0 ? storyTurns[storyTurns.length - 1].index : 0;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:statSync', statData, turnCountChanged, lastMessageId },
        '*',
      );
    } catch {
      // ignore if iframe not yet ready
    }
  }, [statData, storyTurns, scriptsSignature]);

  useEffect(() => {
    if (!scriptsSignature || !iframeLoadedRef.current || !frontend?.worldbooks) return;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:worldbookSync', worldbooks: frontend.worldbooks },
        '*',
      );
    } catch {
      // ignore
    }
  }, [frontend?.worldbooks, scriptsSignature]);

  useEffect(() => {
    if (chatSlot === prevChatSlotRef.current) return;
    prevChatSlotRef.current = chatSlot;
    if (!scriptsSignature || !iframeLoadedRef.current) return;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:chatChanged', chatId: chatSlot || 'default' },
        '*',
      );
    } catch {
      // ignore
    }
  }, [chatSlot, scriptsSignature]);

  const srcDoc = useMemo(() => {
    if (!frontend || enabledScripts.length === 0) return '';
    bakedStatJsonRef.current = JSON.stringify(statData ?? {});
    const html = buildHelperScriptsStageHtml(enabledScripts);
    return buildSandboxedSrcDoc(html, {
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
  }, [scriptsSignature, widgetId, userName]);

  if (!srcDoc) return null;

  return (
    <iframe
      key={scriptsSignature}
      ref={iframeRef}
      title="MVU Zod Background Sandbox"
      sandbox="allow-scripts allow-same-origin"
      srcDoc={srcDoc}
      onLoad={() => {
        iframeLoadedRef.current = true;
        const latest = latestStatDataRef.current;
        const curJson = JSON.stringify(latest ?? {});
        // Only push statSync if state changed since srcDoc was baked; otherwise record baked baseline
        // so stale onLoad snapshots never rebound over newer state.
        if (curJson !== bakedStatJsonRef.current && curJson !== lastPushedJsonRef.current) {
          lastPushedJsonRef.current = curJson;
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'tavern:statSync', statData: latest },
              '*',
            );
          } catch {
            // ignore
          }
        } else if (!lastPushedJsonRef.current) {
          lastPushedJsonRef.current = curJson;
        }
      }}
      style={{ display: 'none', width: 0, height: 0, border: 0 }}
    />
  );
}
