import React, { useEffect, useMemo, useRef } from 'react';
import { buildHelperScriptsStageHtml, buildSandboxedSrcDoc } from './sandbox-shim';
import type { CardFrontendPayload } from './TavernFrontendHost';

interface MvuZodRuntimeHostProps {
  frontend: CardFrontendPayload | null;
  statData: Record<string, unknown>;
  userName: string;
  storyTurns: Array<{ index: number; userMessage?: string; narrative: string }>;
  onUpdateStatData: (nextStatData: Record<string, unknown>) => void;
  onSchemaCountChange?: (count: number) => void;
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
  storyTurns,
  onUpdateStatData,
  onSchemaCountChange,
}: MvuZodRuntimeHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeLoadedRef = useRef<boolean>(false);
  const lastPushedJsonRef = useRef<string>('');
  const latestStatDataRef = useRef<Record<string, unknown>>(statData ?? {});
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
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetId, onUpdateStatData, onSchemaCountChange]);

  useEffect(() => {
    if (!scriptsSignature || !iframeLoadedRef.current) return;
    const curJson = JSON.stringify(statData ?? {});
    if (curJson === lastPushedJsonRef.current) return;
    lastPushedJsonRef.current = curJson;
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'tavern:statSync', statData },
        '*',
      );
    } catch {
      // ignore if iframe not yet ready
    }
  }, [statData, storyTurns.length, scriptsSignature]);

  const srcDoc = useMemo(() => {
    if (!frontend || enabledScripts.length === 0) return '';
    const html = buildHelperScriptsStageHtml(enabledScripts);
    return buildSandboxedSrcDoc(html, {
      widgetId,
      charName: frontend.cardName,
      userName,
      statData,
      storyTurns,
      customExtensions: frontend.customExtensions,
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
        if (curJson !== lastPushedJsonRef.current) {
          lastPushedJsonRef.current = curJson;
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { type: 'tavern:statSync', statData: latest },
              '*',
            );
          } catch {
            // ignore
          }
        }
      }}
      style={{ display: 'none', width: 0, height: 0, border: 0 }}
    />
  );
}
