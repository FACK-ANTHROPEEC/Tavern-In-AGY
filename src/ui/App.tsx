import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from '@modelcontextprotocol/ext-apps';
import { z as zod4 } from 'zod4';
import * as lodash from 'lodash-es';
import type { MemoryPluginConfig, RegexScript } from '../core/types';
import { resolveMemoryPluginConfig, splitTurnsByRecentFloors } from '../core/memory-engine';
import { MvuTreeView } from './MvuTreeView';
import { TavernFrontendHost, type CardFrontendPayload } from './TavernFrontendHost';
import { MvuZodRuntimeHost } from './MvuZodRuntimeHost';
import { FloorRenderer } from './FloorRenderer';
import { unpackCharacterCardPng } from './png-unpack';

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w.__TAVERN_ZOD4__ = zod4;
  w.__TAVERN_LODASH__ = lodash;
}

interface EmbeddedLoreEntrySummary {
  uid: string;
  comment: string;
  keys: string[];
  constant: boolean;
  enabled: boolean;
  order: number;
}

interface HelperScriptSummary {
  index: number;
  name: string;
  enabled: boolean;
  charLength: number;
}

interface CardSummary {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  allGreetings?: string[];
  activeGreetingIndex?: number;
  tags: string[];
  avatarDataUrl?: string;
  hasEmbeddedLorebook: boolean;
  embeddedLorebookName?: string;
  embeddedLorebookCount: number;
  embeddedLorebookEntries?: EmbeddedLoreEntrySummary[];
  hasFrontendHtml?: boolean;
  hasHelperScripts?: boolean;
  regexScripts?: PresetRegexSummary[];
  helperScripts?: HelperScriptSummary[];
}

interface PresetPromptSummary {
  identifier: string;
  name: string;
  role: string;
  enabled: boolean;
  marker: boolean;
  isSectionHeader: boolean;
  charLength: number;
}

interface PresetRegexSummary {
  index: number;
  scriptName: string;
  disabled: boolean;
  placement: number[];
  markdownOnly: boolean;
  promptOnly: boolean;
  minDepth: number | null;
  maxDepth: number | null;
}

interface PresetSummary {
  id: string;
  name: string;
  regexCount: number;
  samplingMeta: Record<string, unknown>;
  prompts: PresetPromptSummary[];
  regexScripts?: PresetRegexSummary[];
  helperScripts?: HelperScriptSummary[];
}

interface LorebookSummary {
  id: string;
  name: string;
  entryCount: number;
  constantCount: number;
  scanDepth: number;
  tokenBudget: number;
}

interface LiveState {
  location: string;
  timeOfDay: string;
  mood: string;
  outfit: string;
  affection: number;
  inventory: string[];
  activeGoals: string[];
  summary: string;
}

interface WaveOption {
  label: string;
  category: string;
  text: string;
}

interface StoryTurnItem {
  turnId: string;
  index: number;
  userMessage?: string;
  narrative: string;
  memorySummary?: string;
  statsSnapshot?: {
    location?: string;
    mood?: string;
    outfit?: string;
    affection?: number;
  };
  createdAt: string;
}

interface ChatSlotSummary {
  slotId: string;
  storyKey: string;
  label: string;
  turnCount: number;
  updatedAt: string;
}

interface TavernConfig {
  enabled: boolean;
  userName: string;
  userPersona: string;
  activeCardId: string | null;
  activePresetId: string | null;
  activeLorebookIds: string[];
  cooldownTurns: number;
  postHistoryRefreshInterval: number;
  enablePostHistoryInjection: boolean;
  statelessPerTurn?: boolean;
  directorMode?: boolean;
  uiScale?: number;
  proseFontSize?: number;
  proseLineHeight?: number;
  maxReadingWidth?: number;
  enableRegexBeautify?: boolean;
  unknownTagMode?: 'fold' | 'keep' | 'hide';
  authorsNote?: string;
  authorsNoteEnabled?: boolean;
  visibleFloorLimit?: number;
  memoryPlugin?: MemoryPluginConfig;
}

interface BootstrapData {
  config: TavernConfig;
  cards: CardSummary[];
  presets: PresetSummary[];
  lorebooks: LorebookSummary[];
  sessionState: LiveState;
  statData?: Record<string, unknown>;
  latestOptions: WaveOption[];
  storyTurns: StoryTurnItem[];
  chatSlots?: ChatSlotSummary[];
  activeChatSlot?: string;
  activeDisplayRegexScripts?: RegexScript[];
  dataDir: string;
}

type TabKey = 'chat' | 'cards' | 'presets' | 'lorebooks' | 'memory' | 'state';

export function AppView() {
  const appRef = useRef<App | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerTextRef = useRef<string>('');
  const [data, setData] = useState<BootstrapData | null>(null);
  const [tab, setTab] = useState<TabKey>('chat');
  const [statusMsg, setStatusMsg] = useState<string>('正在连接 TavernInAGY 本地引擎...');
  const [presetSearch, setPresetSearch] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [canMessage, setCanMessage] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>('');
  const [editingOpening, setEditingOpening] = useState<boolean>(false);
  const [editingOpeningDraft, setEditingOpeningDraft] = useState<string>('');
  const [extraLoadedTurns, setExtraLoadedTurns] = useState<number>(0);
  const [composerText, setComposerText] = useState<string>('');
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const sendingRef = useRef<boolean>(false);
  const pendingBaseLastTurnIdRef = useRef<string | null>(null);
  const [cardFrontend, setCardFrontend] = useState<CardFrontendPayload | null>(null);
  const [mvuSchemaCount, setMvuSchemaCount] = useState<number>(0);
  const [jumpingGreeting, setJumpingGreeting] = useState<boolean>(false);
  const [jumpGreetingInput, setJumpGreetingInput] = useState<string>('');
  const [showPresetRegexList, setShowPresetRegexList] = useState<boolean>(false);
  const [showPresetHelperList, setShowPresetHelperList] = useState<boolean>(false);
  const [showCardRegexList, setShowCardRegexList] = useState<boolean>(false);
  const [showCardHelperList, setShowCardHelperList] = useState<boolean>(false);
  const [showEmbeddedLore, setShowEmbeddedLore] = useState<boolean>(true);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingPromptContent, setEditingPromptContent] = useState<string>('');
  const [editingPromptRole, setEditingPromptRole] = useState<'system' | 'user' | 'assistant'>('system');
  const [draftUiScale, setDraftUiScale] = useState<number | null>(null);
  const [draftFontSize, setDraftFontSize] = useState<number | null>(null);
  const [draftLineHeight, setDraftLineHeight] = useState<number | null>(null);
  const [authorsNoteDraft, setAuthorsNoteDraft] = useState<string>('');
  const [userNameDraft, setUserNameDraft] = useState<string>('');
  const [userPersonaDraft, setUserPersonaDraft] = useState<string>('');
  const [memoryPromptDraft, setMemoryPromptDraft] = useState<string>('');
  const [recentFloorsDraft, setRecentFloorsDraft] = useState<string>('10');
  const [summaryLengthDraft, setSummaryLengthDraft] = useState<string>('200');
  const [visibleFloorLimitDraft, setVisibleFloorLimitDraft] = useState<string>('10');
  const [editingSummaryTurnId, setEditingSummaryTurnId] = useState<string | null>(null);
  const [editingSummaryDraft, setEditingSummaryDraft] = useState<string>('');

  useEffect(() => {
    const app = new App({ name: 'TavernInAGY', version: '0.7.0' }, {});
    appRef.current = app;

    app.ontoolresult = (result) => {
      const sc = result?.structuredContent as
        | (BootstrapData & { delta?: false })
        | {
            delta: true;
            committedTurn?: StoryTurnItem;
            sessionState?: LiveState;
            statData?: Record<string, unknown>;
            latestOptions?: WaveOption[];
          }
        | undefined;
      if (!sc) return;

      if ('delta' in sc && sc.delta) {
        setData((prev) => {
          if (!prev) return prev;
          const nextTurns = sc.committedTurn
            ? [
                ...prev.storyTurns.filter((t) => t.turnId !== sc.committedTurn!.turnId),
                sc.committedTurn,
              ].slice(-200)
            : prev.storyTurns;
          return {
            ...prev,
            storyTurns: nextTurns,
            sessionState: sc.sessionState ?? prev.sessionState,
            statData: sc.statData ?? prev.statData,
            latestOptions: sc.latestOptions ?? prev.latestOptions,
          };
        });
        setPendingSend(null);
        setStatusMsg(
          sc.committedTurn
            ? `已同步第 #${sc.committedTurn.index} 楼与最新状态`
            : '正文与 MVU 状态已同步',
        );
        return;
      }

      if ('config' in sc && sc.config) {
        setData((prev) => ({
          ...sc,
          activeDisplayRegexScripts: sc.activeDisplayRegexScripts ?? prev?.activeDisplayRegexScripts,
          cards: sc.cards.map((c) => {
            const old = prev?.cards.find((x) => x.id === c.id);
            return {
              ...c,
              avatarDataUrl: c.avatarDataUrl ?? old?.avatarDataUrl,
              embeddedLorebookEntries: c.embeddedLorebookEntries ?? old?.embeddedLorebookEntries,
            };
          }),
        }));
        setPendingSend(null);
        setStatusMsg('正文与 MVU 状态已同步');
      }
    };

    app.onhostcontextchanged = () => {
      const caps = app.getHostCapabilities();
      if (caps) {
        setCanMessage('message' in caps);
      }
    };

    app
      .connect()
      .then(async () => {
        const caps = app.getHostCapabilities();
        setCanMessage(Boolean(caps && 'message' in caps));
        await callTool('story_app_bootstrap', {});
      })
      .catch((err) => {
        setStatusMsg(`连接失败: ${String(err)}`);
      });
  }, []);

  // Sync controlled text & numeric drafts whenever persisted config updates
  useEffect(() => {
    if (!data?.config) return;
    setAuthorsNoteDraft(data.config.authorsNote ?? '');
    setUserNameDraft(data.config.userName ?? '');
    setUserPersonaDraft(data.config.userPersona ?? '');
    setMemoryPromptDraft(data.config.memoryPlugin?.customPrompt ?? '');
    setRecentFloorsDraft(String(data.config.memoryPlugin?.recentFullFloors ?? 10));
    setSummaryLengthDraft(String(data.config.memoryPlugin?.summaryLengthHint ?? 200));
    setVisibleFloorLimitDraft(String(data.config.visibleFloorLimit ?? 10));
  }, [
    data?.config.authorsNote,
    data?.config.userName,
    data?.config.userPersona,
    data?.config.memoryPlugin?.customPrompt,
    data?.config.memoryPlugin?.recentFullFloors,
    data?.config.memoryPlugin?.summaryLengthHint,
    data?.config.visibleFloorLimit,
  ]);

  // Reset transient editing & pagination state whenever active card or playthrough slot switches
  useEffect(() => {
    setEditingTurnId(null);
    setEditingOpening(false);
    setEditingSummaryTurnId(null);
    setJumpingGreeting(false);
    setExtraLoadedTurns(0);
  }, [data?.config.activeCardId, data?.activeChatSlot]);

  // Keep composerTextRef synced and bridge native `input` events dispatched by preset option widgets
  useEffect(() => {
    composerTextRef.current = composerText;
  }, [composerText]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const onNativeInput = () => {
      composerTextRef.current = el.value;
      setComposerText(el.value);
    };
    el.addEventListener('input', onNativeInput);
    return () => el.removeEventListener('input', onNativeInput);
  }, [tab, Boolean(data)]);

  // Reset pagination when switching active card or chat slot
  useEffect(() => {
    setExtraLoadedTurns(0);
    setEditingOpening(false);
    setEditingTurnId(null);
  }, [data?.config.activeCardId, data?.activeChatSlot]);

  // Auto-scroll to bottom when new turns arrive or user sends a message
  useEffect(() => {
    if (tab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [data?.storyTurns?.[data.storyTurns.length - 1]?.turnId, pendingSend, tab]);

  // Lightweight auto-poll ONLY while waiting for a reply (tracks latest turnId so >50 turns never stalls)
  useEffect(() => {
    if (!pendingSend) return;
    let cancelled = false;
    let ticks = 0;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      ticks += 1;
      if (ticks > 90) {
        // Stop polling after ~3.75 minutes
        window.clearInterval(timer);
        return;
      }
      const app = appRef.current;
      if (!app) return;
      try {
        const res = await app.callServerTool({ name: 'story_app_bootstrap', arguments: {} });
        const sc = res?.structuredContent as BootstrapData | undefined;
        if (!cancelled && sc && sc.config) {
          const turns = sc.storyTurns ?? [];
          const latestTurn = turns[turns.length - 1];
          const latestId = latestTurn?.turnId ?? null;
          if (latestId && latestId !== pendingBaseLastTurnIdRef.current) {
            setData(sc);
            setPendingSend(null);
            setStatusMsg(`已自动同步第 #${latestTurn.index} 楼正文`);
            window.clearInterval(timer);
          }
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingSend]);

  async function callTool(name: string, args: Record<string, unknown>): Promise<BootstrapData | undefined> {
    const app = appRef.current;
    if (!app) return undefined;
    const caps = app.getHostCapabilities();
    if (caps) {
      setCanMessage('message' in caps);
    }
    try {
      const res = await app.callServerTool({ name, arguments: args });
      if (res?.isError) {
        const errText =
          (res.content ?? [])
            .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean)
            .join(' ') || '未知工具错误';
        setStatusMsg(`操作失败: ${errText}`);
        return undefined;
      }
      const sc = res?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData(sc);
        if (name === 'story_app_bootstrap') {
          setPendingSend(null);
        }
      }
      return sc;
    } catch (err) {
      setStatusMsg(`操作失败: ${String(err)}`);
      return undefined;
    }
  }

  async function stageUploadText(
    text: string,
    label: string,
  ): Promise<{ jsonText?: string; uploadId?: string } | null> {
    const CHUNK_SIZE = 384 * 1024;
    if (text.length <= CHUNK_SIZE) {
      return { jsonText: text };
    }
    const app = appRef.current;
    if (!app) return null;
    const uploadId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const totalChunks = Math.ceil(text.length / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i += 1) {
      setStatusMsg(`正在分片上传${label} (${i + 1}/${totalChunks})...`);
      const slice = text.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      try {
        const res = await app.callServerTool({
          name: 'story_app_upload_chunk',
          arguments: { uploadId, chunkIndex: i, totalChunks, data: slice },
        });
        if (res?.isError) {
          const errText =
            (res.content ?? [])
              .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join(' ') || '分片上传失败';
          setStatusMsg(`上传失败: ${errText}`);
          return null;
        }
      } catch (err) {
        setStatusMsg(`分片上传失败 (${i + 1}/${totalChunks}): ${String(err)}`);
        return null;
      }
    }
    return { uploadId };
  }

  async function sendTextToChat(rawText: string) {
    const text = rawText.trim();
    if (!text || sendingRef.current) return;
    const app = appRef.current;
    if (!app || !canMessage) {
      setStatusMsg('左侧尚未建立对话：请先在左侧发送第一句，再重开或刷新此面板以启用直聊。');
      return;
    }
    sendingRef.current = true;
    const useDirector = Boolean(data?.config.directorMode);
    const useStateless = !useDirector && Boolean(data?.config.statelessPerTurn);
    composerTextRef.current = '';
    setComposerText('');
    const currentTurns = data?.storyTurns ?? [];
    pendingBaseLastTurnIdRef.current = currentTurns[currentTurns.length - 1]?.turnId ?? null;
    setPendingSend(text);
    setStatusMsg(
      useDirector
        ? '已交由导演派发全新 story-writer 子智能体落笔（写完自动销毁并同步）...'
        : useStateless
          ? '已按无状态单轮模式拉起全新上下文，等待角色落笔（完成后自动同步）...'
          : '已发送，等待角色落笔回应（完成后将自动同步）...',
    );
    try {
      let outboundText = text;
      if (useDirector) {
        try {
          const stageRes = await app.callServerTool({
            name: 'story_app_stage_director_input',
            arguments: { text },
          });
          if (!stageRes?.isError) {
            const nextFloor = currentTurns.length + 1;
            outboundText = `第 #${nextFloor} 楼 · 开始演绎`;
          }
        } catch {
          // Fallback to sending raw text if staging fails
        }
      }
      const payload = useStateless
        ? ({
            role: 'user',
            content: [{ type: 'text', text: outboundText }],
            _meta: { 'com.google.antigravity/message': { target: 'new' } },
          } as Parameters<App['sendMessage']>[0])
        : {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: outboundText }],
          };
      await app.sendMessage(payload);
    } catch (err) {
      setPendingSend(null);
      composerTextRef.current = text;
      setComposerText(text);
      setStatusMsg(`发送失败: ${String(err)}`);
    } finally {
      sendingRef.current = false;
    }
  }

  async function handleCardUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在解析角色卡 ${file.name}...`);
    try {
      const isPng = file.name.toLowerCase().endsWith('.png');
      let jsonText: string;
      let avatarDataUrl: string | undefined;
      if (isPng) {
        const unpacked = await unpackCharacterCardPng(file);
        jsonText = unpacked.jsonText;
        avatarDataUrl = unpacked.avatarDataUrl;
      } else {
        jsonText = await file.text();
        JSON.parse(jsonText);
      }
      const staged = await stageUploadText(jsonText, `角色卡 ${file.name}`);
      if (!staged) return;
      setStatusMsg(`正在保存角色卡 ${file.name}...`);
      const ok = await callTool('story_app_import_card', {
        filename: file.name,
        ...staged,
        avatarDataUrl,
        isPng: false,
        setActive: true,
      });
      if (ok) {
        setStatusMsg(`已导入并启用角色卡: ${file.name}`);
      }
    } catch (err) {
      setStatusMsg(`导入角色卡失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  }

  async function handlePresetUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在解析社区预设 ${file.name}...`);
    try {
      const jsonText = await file.text();
      JSON.parse(jsonText);
      const staged = await stageUploadText(jsonText, `预设 ${file.name}`);
      if (!staged) return;
      const ok = await callTool('story_app_import_preset', {
        filename: file.name,
        ...staged,
        setActive: true,
      });
      if (ok) {
        setStatusMsg(`已导入并启用预设: ${file.name}`);
      }
    } catch (err) {
      setStatusMsg(`导入预设失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  }

  async function handleLorebookUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在导入世界书 ${file.name}...`);
    try {
      const jsonText = await file.text();
      JSON.parse(jsonText);
      const staged = await stageUploadText(jsonText, `世界书 ${file.name}`);
      if (!staged) return;
      const ok = await callTool('story_app_import_lorebook', {
        filename: file.name,
        ...staged,
        activate: true,
      });
      if (ok) {
        setStatusMsg(`已导入世界书: ${file.name}`);
      }
    } catch (err) {
      setStatusMsg(`导入世界书失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  }

  async function handleForkBranch() {
    await callTool('story_app_prepare_fork', {});
    const app = appRef.current;
    if (app && canMessage) {
      try {
        await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: '请从当前分支点无缝续写下一轮剧情。' }],
          _meta: { 'com.google.antigravity/message': { target: 'new' } },
        } as Parameters<App['sendMessage']>[0]);
        setStatusMsg('已拉起全新分支会话，SessionStart 将自动接力修剪后的楼层！');
        return;
      } catch {
        // Fallback to manual new chat
      }
    }
    setStatusMsg('分支状态已就绪！请新建对话，SessionStart 将自动接力修剪后的楼层。');
  }

  const activeCard = useMemo(() => {
    if (!data?.config.activeCardId) return null;
    return data.cards.find((c) => c.id === data.config.activeCardId) ?? null;
  }, [data]);

  const activePreset = useMemo(() => {
    if (!data?.config.activePresetId) return null;
    return data.presets.find((p) => p.id === data.config.activePresetId) ?? null;
  }, [data]);

  const enabledHelperSig = useMemo(() => {
    const cardPart = (activeCard?.helperScripts ?? [])
      .filter((s) => s.enabled)
      .map((s) => `${s.index}:${s.name}`)
      .join(',');
    const presetPart = (activePreset?.helperScripts ?? [])
      .filter((s) => s.enabled)
      .map((s) => `${s.index}:${s.name}`)
      .join(',');
    return `${activeCard?.id ?? ''}|${activePreset?.id ?? ''}|${cardPart}|${presetPart}`;
  }, [activeCard, activePreset]);

  // Clear manually loaded cardFrontend only when switching active card
  useEffect(() => {
    setCardFrontend(null);
    setMvuSchemaCount(0);
  }, [activeCard?.id]);

  // Auto-load card/preset helper scripts in the background so MVU Zod schemas register automatically
  useEffect(() => {
    const hasAnyHelper =
      Boolean(activeCard?.hasHelperScripts) ||
      Boolean(activePreset?.helperScripts?.some((s) => s.enabled));
    if (!activeCard || !hasAnyHelper) {
      setMvuSchemaCount(0);
      return;
    }
    let cancelled = false;
    const app = appRef.current;
    if (!app) return;
    app
      .callServerTool({
        name: 'story_app_get_card_frontend',
        arguments: { cardId: activeCard.id },
      })
      .then((res) => {
        if (cancelled || res?.isError) return;
        const sc = res?.structuredContent as CardFrontendPayload | undefined;
        if (sc) setCardFrontend(sc);
      })
      .catch(() => {
        // ignore transient errors
      });
    return () => {
      cancelled = true;
    };
    // Depend ONLY on primitive enabledHelperSig (includes cardId, presetId, and enabled script lists)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledHelperSig]);

  const handleSilentStatUpdate = useCallback((nextStat: Record<string, unknown>) => {
    callTool('story_app_set_stat_data', { statData: nextStat });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupedPresetSections = useMemo(() => {
    if (!activePreset) return [];
    const query = presetSearch.trim().toLowerCase();
    const groups: Array<{ title: string; id: string; items: PresetPromptSummary[] }> = [];
    let current = { title: '通用模块', id: '__default__', items: [] as PresetPromptSummary[] };

    for (const item of activePreset.prompts) {
      if (item.isSectionHeader) {
        if (current.items.length > 0) groups.push(current);
        current = { title: item.name, id: item.identifier, items: [] };
        continue;
      }
      if (
        query &&
        !item.name.toLowerCase().includes(query) &&
        !item.identifier.toLowerCase().includes(query)
      ) {
        continue;
      }
      current.items.push(item);
    }
    if (current.items.length > 0) groups.push(current);
    return groups;
  }, [activePreset, presetSearch]);

  if (!data) {
    return (
      <div className="app-shell">
        <div className="card-box">
          <strong>TavernInAGY</strong>
          <div className="muted">{statusMsg}</div>
        </div>
      </div>
    );
  }

  const hasMvuInfo = Boolean(
    data.sessionState.timeOfDay ||
      data.sessionState.location ||
      data.sessionState.mood ||
      data.sessionState.outfit ||
      data.sessionState.affection !== 0,
  );

  const enableRegexBeautify = data.config.enableRegexBeautify !== false;
  const unknownTagMode = data.config.unknownTagMode ?? 'fold';
  const visibleFloorLimit = Math.max(2, Math.min(200, data.config.visibleFloorLimit ?? 10));
  const turnsPerPage = Math.max(1, Math.ceil(visibleFloorLimit / 2));
  const allStoryTurns = data.storyTurns ?? [];
  const shownTurnsCount = turnsPerPage + extraLoadedTurns;
  const hiddenTurnsCount = Math.max(0, allStoryTurns.length - shownTurnsCount);
  const visibleStoryTurns = hiddenTurnsCount > 0 ? allStoryTurns.slice(-shownTurnsCount) : allStoryTurns;
  const uiScale = Math.max(80, Math.min(130, draftUiScale ?? data.config.uiScale ?? 100));
  const proseFontSize = Math.max(12, Math.min(22, draftFontSize ?? data.config.proseFontSize ?? 14));
  const proseLineHeight = Math.max(1.4, Math.min(2.2, draftLineHeight ?? data.config.proseLineHeight ?? 1.7));
  const maxReadingWidth = data.config.maxReadingWidth ?? 0;

  const shellStyle = {
    zoom: uiScale / 100,
    height: `${(10000 / uiScale).toFixed(2)}vh`,
    '--prose-font-size': `${proseFontSize}px`,
    '--prose-line-height': String(proseLineHeight),
    '--reading-max-width': maxReadingWidth > 0 ? `${maxReadingWidth}px` : '100%',
  } as React.CSSProperties;

  return (
    <div className="app-shell" style={shellStyle}>
      <MvuZodRuntimeHost
        frontend={cardFrontend && activeCard && cardFrontend.cardId === activeCard.id ? cardFrontend : null}
        statData={data.statData ?? {}}
        userName={data.config.userName || 'User'}
        storyTurns={data.storyTurns ?? []}
        onUpdateStatData={handleSilentStatUpdate}
        onSchemaCountChange={setMvuSchemaCount}
      />
      <div className="header">
        <div className="header-title">
          {activeCard?.avatarDataUrl ? (
            <img
              src={activeCard.avatarDataUrl}
              alt={activeCard.name}
              style={{ width: 22, height: 22, borderRadius: 2, objectFit: 'cover' }}
            />
          ) : (
            <span>🕯️</span>
          )}
          <span>{activeCard ? activeCard.name : 'TavernInAGY'}</span>
          <span className="badge">{data.config.enabled ? 'RP 运行中' : '已暂停'}</span>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button
            className="btn btn-xs"
            onClick={() => callTool('story_app_bootstrap', {})}
            title="手动同步最新楼层与状态"
          >
            刷新
          </button>
          <button
            className={`btn btn-xs ${data.config.enabled ? '' : 'btn-primary'}`}
            onClick={() =>
              callTool('story_app_update_config', { enabled: !data.config.enabled })
            }
          >
            {data.config.enabled ? '暂停' : '启用'}
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab-btn ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          正文 ({data.storyTurns?.length ?? 0})
        </button>
        <button className={`tab-btn ${tab === 'cards' ? 'active' : ''}`} onClick={() => setTab('cards')}>
          角色 ({data.cards.length})
        </button>
        <button className={`tab-btn ${tab === 'presets' ? 'active' : ''}`} onClick={() => setTab('presets')}>
          预设 ({data.presets.length})
        </button>
        <button className={`tab-btn ${tab === 'lorebooks' ? 'active' : ''}`} onClick={() => setTab('lorebooks')}>
          世界书 ({data.lorebooks.length + (activeCard?.hasEmbeddedLorebook ? 1 : 0)})
        </button>
        <button className={`tab-btn ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>
          记忆{data.config.memoryPlugin?.enabled ? ' ●' : ''}
        </button>
        <button className={`tab-btn ${tab === 'state' ? 'active' : ''}`} onClick={() => setTab('state')}>
          状态与设置
        </button>
      </div>

      {tab === 'chat' && (
        <>
          {hasMvuInfo && (
            <div className="mvu-strip">
              {data.sessionState.timeOfDay && (
                <span>时辰：<strong>{data.sessionState.timeOfDay}</strong></span>
              )}
              {data.sessionState.location && (
                <span>地点：<strong>{data.sessionState.location}</strong></span>
              )}
              {data.sessionState.mood && (
                <span>情绪：<strong>{data.sessionState.mood}</strong></span>
              )}
              {data.sessionState.outfit && (
                <span>衣着：<strong>{data.sessionState.outfit}</strong></span>
              )}
              {data.sessionState.affection !== 0 && (
                <span>好感：<strong>{data.sessionState.affection}</strong></span>
              )}
            </div>
          )}

          <div className="chat-stream">
            {!activeCard && (
              <div className="story-paper">
                <div className="story-prose">
                  <p>欢迎来到暖墨书房。请先前往顶部「角色」与「预设」页导入角色卡与社区预设，即可在此直接落笔开演。</p>
                </div>
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  <button className="btn btn-primary" onClick={() => setTab('cards')}>
                    去导入角色卡
                  </button>
                  <button className="btn" onClick={() => setTab('presets')}>
                    去导入社区预设
                  </button>
                </div>
              </div>
            )}

            {hiddenTurnsCount > 0 && (
              <button
                className="load-more-floors-btn"
                onClick={() => setExtraLoadedTurns((prev) => prev + turnsPerPage)}
              >
                ↑ 点击加载更早的 {Math.min(visibleFloorLimit, hiddenTurnsCount * 2)} 楼（还有 {hiddenTurnsCount * 2} 楼未显示）
              </button>
            )}

            {hiddenTurnsCount === 0 && activeCard && (activeCard.allGreetings?.[activeCard.activeGreetingIndex ?? 0] || activeCard.firstMessage) && (() => {
              const allGreetings = activeCard.allGreetings && activeCard.allGreetings.length > 0
                ? activeCard.allGreetings
                : [activeCard.firstMessage];
              const gIdx = Math.max(0, Math.min(allGreetings.length - 1, activeCard.activeGreetingIndex ?? 0));
              const currentOpening = allGreetings[gIdx] || activeCard.firstMessage;
              const selectGreeting = async (targetIdx: number) => {
                const wrapped = ((targetIdx % allGreetings.length) + allGreetings.length) % allGreetings.length;
                setJumpingGreeting(false);
                setEditingOpening(false);
                await callTool('story_app_select_greeting', { index: wrapped });
                setStatusMsg(`已切换至第 ${wrapped + 1}/${allGreetings.length} 个开场白`);
              };
              return (
                <div className="story-paper">
                  <div className="row">
                    <span className="muted">#0 · 开场白 · {activeCard.name}</span>
                    <div className="floor-actions floor-actions-visible">
                      <span className="badge">
                        {allGreetings.length > 1 ? `Opening ${gIdx + 1}/${allGreetings.length}` : 'Opening'}
                      </span>
                      {!editingOpening ? (
                        <button
                          className="pencil-btn"
                          title="编辑本层开场白正文"
                          onClick={() => {
                            setEditingOpening(true);
                            setEditingOpeningDraft(currentOpening);
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            <path d="m15 5 4 4" />
                          </svg>
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn btn-xs btn-primary"
                            onClick={async () => {
                              const ok = await callTool('story_app_edit_greeting', {
                                index: gIdx,
                                content: editingOpeningDraft,
                              });
                              if (ok) {
                                setEditingOpening(false);
                                setStatusMsg('已保存开场白修改');
                              }
                            }}
                          >
                            保存
                          </button>
                          <button
                            className="btn btn-xs"
                            onClick={() => setEditingOpening(false)}
                          >
                            取消
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {editingOpening ? (
                    <textarea
                      className="textarea"
                      style={{ minHeight: 140 }}
                      value={editingOpeningDraft}
                      onChange={(e) => setEditingOpeningDraft(e.target.value)}
                    />
                  ) : (
                    <FloorRenderer
                      key={`opening-${activeCard.id}-${gIdx}`}
                      narrative={currentOpening
                        .replace(/\{\{char\}\}|<char>/gi, activeCard.name)
                        .replace(/\{\{user\}\}|<user>/gi, data.config.userName || 'User')}
                      messageId={0}
                      depth={allStoryTurns.length}
                      regexScripts={data.activeDisplayRegexScripts ?? []}
                      enableRegex={enableRegexBeautify}
                      unknownTagMode={unknownTagMode}
                      charName={activeCard.name}
                      userName={data.config.userName || 'User'}
                      statData={data.statData ?? {}}
                      storyTurns={allStoryTurns}
                      greetings={allGreetings}
                      activeGreetingIndex={gIdx}
                      onSendMessage={sendTextToChat}
                      onSetInput={(txt) => {
                        setComposerText(txt);
                        setStatusMsg('已将选项填入下方输入框');
                      }}
                      onUpdateStatData={(nextStat) =>
                        callTool('story_app_set_stat_data', { statData: nextStat })
                      }
                      onSelectGreeting={selectGreeting}
                    />
                  )}
                  {allGreetings.length > 1 && (
                    <div className="greeting-swipe-bar">
                      <button
                        className="btn btn-xs"
                        title="上一个开场白"
                        onClick={() => selectGreeting(gIdx - 1)}
                      >
                        ‹
                      </button>
                      {jumpingGreeting ? (
                        <form
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            const n = parseInt(jumpGreetingInput, 10);
                            if (Number.isFinite(n) && n >= 1 && n <= allGreetings.length) {
                              selectGreeting(n - 1);
                            } else {
                              setJumpingGreeting(false);
                            }
                          }}
                        >
                          <input
                            type="number"
                            className="input"
                            style={{ width: 54, height: 22, padding: '1px 5px', fontSize: 11, textAlign: 'center' }}
                            min={1}
                            max={allGreetings.length}
                            autoFocus
                            value={jumpGreetingInput}
                            onChange={(e) => setJumpGreetingInput(e.target.value)}
                            onBlur={() => setJumpingGreeting(false)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setJumpingGreeting(false);
                            }}
                          />
                          <span className="muted">/ {allGreetings.length}</span>
                        </form>
                      ) : (
                        <button
                          className="greeting-counter-btn"
                          title="点击输入序号直接跳转到指定开场白"
                          onClick={() => {
                            setJumpGreetingInput(String(gIdx + 1));
                            setJumpingGreeting(true);
                          }}
                        >
                          {gIdx + 1}/{allGreetings.length}
                        </button>
                      )}
                      <button
                        className="btn btn-xs"
                        title="下一个开场白"
                        onClick={() => selectGreeting(gIdx + 1)}
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {visibleStoryTurns.map((t, idx, arr) => {
              const isEditing = editingTurnId === t.turnId;
              const depth = arr.length - 1 - idx;
              return (
                <React.Fragment key={t.turnId}>
                  {t.userMessage && (
                    <div className="user-bubble">
                      <span className="muted">{data.config.userName || 'User'}：</span>
                      {t.userMessage}
                    </div>
                  )}
                  <div className="story-paper">
                    <div className="row">
                      <span className="muted">
                        #{t.index} · {activeCard?.name ?? '角色'}
                        {t.statsSnapshot?.location ? ` · ${t.statsSnapshot.location}` : ''}
                      </span>
                      <div className="floor-actions floor-actions-visible">
                        {!isEditing ? (
                          <button
                            className="pencil-btn"
                            title="编辑本层正文"
                            onClick={() => {
                              setEditingTurnId(t.turnId);
                              setEditingDraft(t.narrative);
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                        ) : (
                          <>
                            <button
                              className="btn btn-xs btn-primary"
                              onClick={async () => {
                                const ok = await callTool('story_app_edit_turn', {
                                  turnId: t.turnId,
                                  narrative: editingDraft,
                                });
                                if (ok) {
                                  setEditingTurnId(null);
                                  setStatusMsg(`已保存第 #${t.index} 楼修改`);
                                }
                              }}
                            >
                              保存
                            </button>
                            <button
                              className="btn btn-xs"
                              onClick={() => setEditingTurnId(null)}
                            >
                              取消
                            </button>
                          </>
                        )}
                        <button
                          className="btn btn-xs"
                          onClick={async () => {
                            await callTool('story_app_rollback_turn', {
                              turnId: t.turnId,
                              inclusive: true,
                            });
                            setStatusMsg(`已保留至第 #${t.index} 楼（可点分支续写）`);
                          }}
                        >
                          保留至此
                        </button>
                        <button
                          className="btn btn-xs btn-danger"
                          onClick={async () => {
                            await callTool('story_app_rollback_turn', {
                              turnId: t.turnId,
                              inclusive: false,
                            });
                            setStatusMsg(`已删掉第 #${t.index} 楼（可点分支续写重 Roll）`);
                          }}
                        >
                          重Roll
                        </button>
                      </div>
                    </div>
                    {isEditing ? (
                      <textarea
                        className="textarea"
                        style={{ minHeight: 110 }}
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                      />
                    ) : (
                      <FloorRenderer
                        narrative={t.narrative}
                        messageId={t.index}
                        depth={depth}
                        regexScripts={data.activeDisplayRegexScripts ?? []}
                        enableRegex={enableRegexBeautify}
                        unknownTagMode={unknownTagMode}
                        memorySummary={t.memorySummary}
                        memorySummaryDisplayMode={data.config.memoryPlugin?.summaryDisplayMode ?? 'fold'}
                        charName={activeCard?.name ?? '角色'}
                        userName={data.config.userName || 'User'}
                        statData={data.statData ?? {}}
                        storyTurns={data.storyTurns ?? []}
                        onSendMessage={sendTextToChat}
                        onSetInput={(txt) => {
                          setComposerText(txt);
                          setStatusMsg('已将选项填入下方输入框');
                        }}
                        onUpdateStatData={(nextStat) =>
                          callTool('story_app_set_stat_data', { statData: nextStat })
                        }
                      />
                    )}
                  </div>
                </React.Fragment>
              );
            })}

            {pendingSend && (
              <>
                <div className="user-bubble">
                  <span className="muted">{data.config.userName || 'User'}：</span>
                  {pendingSend}
                </div>
                <div className="story-paper">
                  <div className="muted">🕯️ {activeCard?.name ?? '角色'} 正在落笔构思中……（若主界面已回复完，可点右上角「刷新」）</div>
                </div>
              </>
            )}

            <div ref={chatEndRef} />
          </div>

          <div className="composer-dock">
            <div className="composer-row">
              <textarea
                id="send_textarea"
                ref={composerRef}
                className="composer-input"
                placeholder={
                  canMessage
                    ? data.config.directorMode
                      ? '导演模式（左侧请选 story-director）：每轮自动派发干净子体落笔…（Enter 发送）'
                      : data.config.statelessPerTurn
                        ? '无状态单轮模式：每句自动新开干净上下文全量重拼…（Enter 发送）'
                        : '在此直接输入你的行动或对话…（Enter 发送，Shift+Enter 换行）'
                    : '左侧尚未建立对话：请先在左侧发送第一句，再重开本面板即可启用直聊'
                }
                value={composerText}
                disabled={!canMessage}
                onChange={(e) => {
                  composerTextRef.current = e.target.value;
                  setComposerText(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendTextToChat(composerTextRef.current);
                  }
                }}
              />
              <button
                id="send_but"
                className="btn btn-primary composer-send"
                disabled={!canMessage}
                style={{ opacity: composerText.trim() ? 1 : 0.65 }}
                onClick={() => sendTextToChat(composerRef.current?.value ?? composerTextRef.current)}
              >
                发送
              </button>
            </div>

            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                {activeCard && (data.chatSlots?.length ?? 0) > 0 && (
                  <select
                    className="input"
                    style={{ padding: '2px 6px', fontSize: 11, height: 24, width: 'auto', minWidth: 96 }}
                    value={data.activeChatSlot || 'default'}
                    onChange={(e) =>
                      callTool('story_app_switch_chat_slot', { slotId: e.target.value }).then(() =>
                        setStatusMsg('已切换至选定存档'),
                      )
                    }
                    title="切换该角色卡的历史聊天存档（旧记录全部保留）"
                  >
                    {(data.chatSlots ?? []).map((slot) => (
                      <option key={slot.slotId} value={slot.slotId}>
                        {slot.label}
                      </option>
                    ))}
                  </select>
                )}
                {activeCard && (
                  <button
                    className="btn btn-xs"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={async () => {
                      await callTool('story_app_new_chat_slot', {});
                      setStatusMsg('已开启新存档（旧记录完好保留，随时可在下拉栏切回）');
                    }}
                    title="保留旧聊天记录，新建一个干净存档并重置初始状态"
                  >
                    + 新存档
                  </button>
                )}
                <button
                  className="btn btn-xs"
                  style={{ whiteSpace: 'nowrap' }}
                  disabled={Boolean(pendingSend) || (data.storyTurns?.length ?? 0) === 0}
                  onClick={async () => {
                    const turns = data.storyTurns ?? [];
                    const last = turns[turns.length - 1];
                    if (!last) return;
                    const promptToReplay = last.userMessage?.trim();
                    await callTool('story_app_rollback_turn', {
                      turnId: last.turnId,
                      inclusive: false,
                    });
                    if (promptToReplay) {
                      setComposerText(promptToReplay);
                      setStatusMsg(`已撤回第 #${last.index} 楼并将原指令填回输入框，按 Enter 即可重发`);
                    } else {
                      setStatusMsg(`已撤回第 #${last.index} 楼，请在下方输入新指令`);
                    }
                  }}
                  title="撤回最新一楼并将原指令填回输入框，方便微调后按 Enter 手动重发"
                >
                  ↻ 重Roll本楼
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                <button
                  className="btn btn-xs"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() =>
                    callTool('story_app_update_config', {
                      enableRegexBeautify: !enableRegexBeautify,
                    })
                  }
                  title="切换预设/角色卡正则美化与原始正文（已持久化）"
                >
                  {enableRegexBeautify ? '正则：开' : '正则：关'}
                </button>
              </div>
            </div>

            <div className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusMsg}
            </div>
          </div>
        </>
      )}

      {tab !== 'chat' && (
        <div className="main-scroll">
          {tab === 'cards' && (
            <div className="card-box">
              <div className="row">
                <strong>角色卡库（PNG V2/V3 & JSON）</strong>
                <label className="btn btn-primary">
                  + 导入
                  <input type="file" accept=".png,.json" hidden onChange={handleCardUpload} />
                </label>
              </div>
              <div className="muted">
                💡 新建对话时在输入框下方的 Agent 选择器中切换至{' '}
                <strong>story-director</strong>
                ，在此一键切卡即刻生效。
              </div>
              {data.cards.length === 0 && (
                <div className="muted">暂未导入角色卡，点击右上角导入标准 PNG/JSON 角色卡。</div>
              )}
              {data.cards.map((card) => {
                const isActive = data.config.activeCardId === card.id;
                return (
                  <div key={card.id} className="card-box" style={{ background: 'var(--ink-header)' }}>
                    <div className="row">
                      <div className="row" style={{ justifyContent: 'flex-start' }}>
                        {card.avatarDataUrl && <img className="avatar" src={card.avatarDataUrl} alt={card.name} />}
                        <div>
                          <strong>{card.name}</strong>
                          <div className="muted">
                            {card.hasEmbeddedLorebook ? `内嵌世界书 ${card.embeddedLorebookCount} 条` : '无内嵌世界书'}
                          </div>
                        </div>
                      </div>
                      <div className="row">
                        <button
                          className={`btn ${isActive ? 'btn-primary' : ''}`}
                          onClick={() =>
                            callTool('story_app_update_config', {
                              activeCardId: isActive ? null : card.id,
                            })
                          }
                        >
                          {isActive ? '已激活' : '启用'}
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => callTool('story_app_delete_asset', { kind: 'card', id: card.id })}
                        >
                          删
                        </button>
                      </div>
                    </div>
                    {card.scenario && <div className="muted">场景：{card.scenario.slice(0, 100)}</div>}
                  </div>
                );
              })}

              {activeCard && activeCard.regexScripts && activeCard.regexScripts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    className="section-header"
                    onClick={() => setShowCardRegexList((v) => !v)}
                  >
                    <span>
                      {showCardRegexList ? '▾' : '▸'} 角色卡正则脚本（{activeCard.name}）
                    </span>
                    <span className="muted">
                      {activeCard.regexScripts.filter((r) => !r.disabled).length}/{activeCard.regexScripts.length}
                    </span>
                  </div>
                  {showCardRegexList && (
                    <div className="st-prompt-list">
                      {activeCard.regexScripts.map((r) => {
                        const modeTag =
                          r.markdownOnly && !r.promptOnly
                            ? '仅显示'
                            : r.promptOnly && !r.markdownOnly
                              ? '仅注入'
                              : '双向';
                        const depthTag =
                          r.minDepth !== null || r.maxDepth !== null
                            ? `深度 ${r.minDepth ?? 0}~${r.maxDepth ?? '∞'}`
                            : '';
                        return (
                          <div
                            key={r.index}
                            className={`st-prompt-row ${r.disabled ? 'disabled' : ''}`}
                          >
                            <div className="st-prompt-left">
                              <span className="st-star">⌘</span>
                              <span className="st-prompt-name" title={r.scriptName}>
                                {r.scriptName}
                              </span>
                              <span className="badge">{modeTag}</span>
                              {depthTag && <span className="badge">{depthTag}</span>}
                            </div>
                            <div className="st-prompt-right">
                              <label className="st-switch">
                                <input
                                  type="checkbox"
                                  checked={!r.disabled}
                                  onChange={(e) =>
                                    callTool('story_app_toggle_card_regex', {
                                      cardId: activeCard.id,
                                      index: r.index,
                                      disabled: !e.target.checked,
                                    })
                                  }
                                />
                                <span className="st-slider" />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeCard && activeCard.helperScripts && activeCard.helperScripts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    className="section-header"
                    onClick={() => setShowCardHelperList((v) => !v)}
                  >
                    <span>
                      {showCardHelperList ? '▾' : '▸'} 角色卡助手脚本（{activeCard.name}）
                    </span>
                    <span className="muted">
                      {activeCard.helperScripts.filter((s) => s.enabled).length}/{activeCard.helperScripts.length}
                    </span>
                  </div>
                  {showCardHelperList && (
                    <div className="st-prompt-list">
                      {activeCard.helperScripts.map((s) => (
                        <div
                          key={s.index}
                          className={`st-prompt-row ${s.enabled ? '' : 'disabled'}`}
                        >
                          <div className="st-prompt-left">
                            <span className="st-star">⚙</span>
                            <span className="st-prompt-name" title={s.name}>
                              {s.name}
                            </span>
                            <span className="badge">{Math.max(1, Math.round(s.charLength / 1024))} KB</span>
                          </div>
                          <div className="st-prompt-right">
                            <label className="st-switch">
                              <input
                                type="checkbox"
                                checked={s.enabled}
                                onChange={(e) =>
                                  callTool('story_app_toggle_card_helper_script', {
                                    cardId: activeCard.id,
                                    index: s.index,
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              <span className="st-slider" />
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'presets' && (
            <div className="card-box">
              <div className="row">
                <strong>社区预设（Prompt Manager）</strong>
                <label className="btn btn-primary">
                  + 导入 JSON
                  <input type="file" accept=".json" hidden onChange={handlePresetUpload} />
                </label>
              </div>
              {data.presets.length > 0 && (
                <div className="row">
                  <select
                    className="input"
                    value={data.config.activePresetId ?? ''}
                    onChange={(e) =>
                      callTool('story_app_update_config', {
                        activePresetId: e.target.value || null,
                      })
                    }
                  >
                    <option value="">（不使用预设，仅角色卡默认拼装）</option>
                    {data.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}（{p.prompts.length} 条 / 正则 {p.regexCount}）
                      </option>
                    ))}
                  </select>
                  {activePreset && (
                    <button
                      className="btn btn-danger"
                      onClick={() => callTool('story_app_delete_asset', { kind: 'preset', id: activePreset.id })}
                    >
                      删
                    </button>
                  )}
                </div>
              )}

              {activePreset && (
                <>
                  <div className="muted">采样参数由 AGY 宿主托管；点击任意条目名称可展开在线编辑正文，下方亦可独立开关正则。</div>

                  {activePreset.regexScripts && activePreset.regexScripts.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div
                        className="section-header"
                        onClick={() => setShowPresetRegexList((v) => !v)}
                      >
                        <span>
                          {showPresetRegexList ? '▾' : '▸'} 预设正则脚本（Regex）
                        </span>
                        <span className="muted">
                          {activePreset.regexScripts.filter((r) => !r.disabled).length}/{activePreset.regexScripts.length}
                        </span>
                      </div>
                      {showPresetRegexList && (
                        <div className="st-prompt-list">
                          {activePreset.regexScripts.map((r) => {
                            const modeTag =
                              r.markdownOnly && !r.promptOnly
                                ? '仅显示'
                                : r.promptOnly && !r.markdownOnly
                                  ? '仅注入'
                                  : '双向';
                            const depthTag =
                              r.minDepth !== null || r.maxDepth !== null
                                ? `深度 ${r.minDepth ?? 0}~${r.maxDepth ?? '∞'}`
                                : '';
                            return (
                              <div
                                key={r.index}
                                className={`st-prompt-row ${r.disabled ? 'disabled' : ''}`}
                              >
                                <div className="st-prompt-left">
                                  <span className="st-star">⌘</span>
                                  <span className="st-prompt-name" title={r.scriptName}>
                                    {r.scriptName}
                                  </span>
                                  <span className="badge">{modeTag}</span>
                                  {depthTag && <span className="badge">{depthTag}</span>}
                                </div>
                                <div className="st-prompt-right">
                                  <label className="st-switch">
                                    <input
                                      type="checkbox"
                                      checked={!r.disabled}
                                      onChange={(e) =>
                                        callTool('story_app_toggle_preset_regex', {
                                          presetId: activePreset.id,
                                          index: r.index,
                                          disabled: !e.target.checked,
                                        })
                                      }
                                    />
                                    <span className="st-slider" />
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {activePreset.helperScripts && activePreset.helperScripts.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div
                        className="section-header"
                        onClick={() => setShowPresetHelperList((v) => !v)}
                      >
                        <span>
                          {showPresetHelperList ? '▾' : '▸'} 预设助手脚本（Helper Scripts）
                        </span>
                        <span className="muted">
                          {activePreset.helperScripts.filter((s) => s.enabled).length}/{activePreset.helperScripts.length}
                        </span>
                      </div>
                      {showPresetHelperList && (
                        <div className="st-prompt-list">
                          {activePreset.helperScripts.map((s) => (
                            <div
                              key={s.index}
                              className={`st-prompt-row ${s.enabled ? '' : 'disabled'}`}
                            >
                              <div className="st-prompt-left">
                                <span className="st-star">⚙</span>
                                <span className="st-prompt-name" title={s.name}>
                                  {s.name}
                                </span>
                                <span className="badge">{Math.max(1, Math.round(s.charLength / 1024))} KB</span>
                              </div>
                              <div className="st-prompt-right">
                                <label className="st-switch">
                                  <input
                                    type="checkbox"
                                    checked={s.enabled}
                                    onChange={(e) =>
                                      callTool('story_app_toggle_preset_helper_script', {
                                        presetId: activePreset.id,
                                        index: s.index,
                                        enabled: e.target.checked,
                                      })
                                    }
                                  />
                                  <span className="st-slider" />
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <input
                    className="input"
                    placeholder="搜索预设条目名称或 ID..."
                    value={presetSearch}
                    onChange={(e) => setPresetSearch(e.target.value)}
                  />
                  {groupedPresetSections.map((sec) => {
                    const collapsed = Boolean(collapsedSections[sec.id]);
                    const enabledInSec = sec.items.filter((i) => i.enabled).length;
                    return (
                      <div key={sec.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div
                          className="section-header"
                          onClick={() =>
                            setCollapsedSections((prev) => ({ ...prev, [sec.id]: !prev[sec.id] }))
                          }
                        >
                          <span>
                            {collapsed ? '▸' : '▾'} {sec.title}
                          </span>
                          <span className="muted">
                            {enabledInSec}/{sec.items.length}
                          </span>
                        </div>
                        {!collapsed && (
                          <div className="st-prompt-list">
                            {sec.items.map((item) => {
                              const estTokens =
                                item.charLength > 0 ? Math.max(1, Math.round(item.charLength / 2.5)) : 0;
                              const isEditingPrompt = editingPromptId === item.identifier;
                              return (
                                <div key={item.identifier}>
                                  <div className={`st-prompt-row ${item.enabled ? '' : 'disabled'}`}>
                                    <div
                                      className="st-prompt-left"
                                      style={{ cursor: item.marker ? 'default' : 'pointer' }}
                                      onClick={async () => {
                                        if (item.marker) return;
                                        if (isEditingPrompt) {
                                          setEditingPromptId(null);
                                          return;
                                        }
                                        const app = appRef.current;
                                        if (!app) return;
                                        const res = await app.callServerTool({
                                          name: 'story_app_get_preset_prompt',
                                          arguments: {
                                            presetId: activePreset.id,
                                            identifier: item.identifier,
                                          },
                                        });
                                        const sc = res?.structuredContent as
                                          | { item?: { content: string; role: 'system' | 'user' | 'assistant' } }
                                          | undefined;
                                        if (sc?.item) {
                                          setEditingPromptId(item.identifier);
                                          setEditingPromptContent(sc.item.content);
                                          setEditingPromptRole(sc.item.role);
                                        }
                                      }}
                                    >
                                      <span className="st-star">{item.marker ? '▤' : '✳'}</span>
                                      <span className="st-prompt-name" title={item.identifier}>
                                        {item.name}
                                      </span>
                                      {item.marker ? <span className="badge">插槽</span> : null}
                                      {item.role !== 'system' ? <span className="badge">{item.role}</span> : null}
                                    </div>
                                    <div className="st-prompt-right">
                                      <label className="st-switch">
                                        <input
                                          type="checkbox"
                                          checked={item.enabled}
                                          onChange={(e) =>
                                            callTool('story_app_toggle_preset_prompt', {
                                              presetId: activePreset.id,
                                              identifier: item.identifier,
                                              enabled: e.target.checked,
                                            })
                                          }
                                        />
                                        <span className="st-slider" />
                                      </label>
                                      <span className="st-token-num">{estTokens > 0 ? estTokens : '-'}</span>
                                    </div>
                                  </div>
                                  {isEditingPrompt && (
                                    <div className="prompt-inline-editor">
                                      <div className="row">
                                        <span className="muted">角色（Role）</span>
                                        <select
                                          className="input"
                                          style={{ width: 120 }}
                                          value={editingPromptRole}
                                          onChange={(e) =>
                                            setEditingPromptRole(
                                              e.target.value as 'system' | 'user' | 'assistant',
                                            )
                                          }
                                        >
                                          <option value="system">system</option>
                                          <option value="user">user</option>
                                          <option value="assistant">assistant</option>
                                        </select>
                                      </div>
                                      <textarea
                                        className="textarea"
                                        style={{ minHeight: 120 }}
                                        value={editingPromptContent}
                                        onChange={(e) => setEditingPromptContent(e.target.value)}
                                      />
                                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                                        <button
                                          className="btn btn-xs"
                                          onClick={() => setEditingPromptId(null)}
                                        >
                                          取消
                                        </button>
                                        <button
                                          className="btn btn-xs btn-primary"
                                          onClick={async () => {
                                            const ok = await callTool('story_app_edit_preset_prompt', {
                                              presetId: activePreset.id,
                                              identifier: item.identifier,
                                              content: editingPromptContent,
                                              role: editingPromptRole,
                                            });
                                            if (ok) {
                                              setEditingPromptId(null);
                                              setStatusMsg(`已保存预设条目「${item.name}」`);
                                            }
                                          }}
                                        >
                                          保存条目
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {tab === 'lorebooks' && (
            <div className="card-box">
              <div className="row">
                <strong>世界书（World Info）</strong>
                <label className="btn btn-primary">
                  + 导入 JSON
                  <input type="file" accept=".json" hidden onChange={handleLorebookUpload} />
                </label>
              </div>
              <div className="row">
                <span className="muted">AGY 冷却去重窗口（轮）</span>
                <input
                  type="number"
                  className="input"
                  style={{ width: 80 }}
                  min={0}
                  max={100}
                  value={data.config.cooldownTurns}
                  onChange={(e) =>
                    callTool('story_app_update_config', {
                      cooldownTurns: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                />
              </div>
              {activeCard && activeCard.hasEmbeddedLorebook && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    className="section-header"
                    onClick={() => setShowEmbeddedLore((v) => !v)}
                  >
                    <span>
                      {showEmbeddedLore ? '▾' : '▸'} 角色卡自带世界书：{activeCard.embeddedLorebookName || activeCard.name}
                    </span>
                    <span className="muted">
                      {(activeCard.embeddedLorebookEntries ?? []).filter((e) => e.enabled).length}/{activeCard.embeddedLorebookCount}
                    </span>
                  </div>
                  {showEmbeddedLore && (
                    <div className="st-prompt-list">
                      {(activeCard.embeddedLorebookEntries ?? []).map((entry) => (
                        <div
                          key={entry.uid}
                          className={`st-prompt-row ${entry.enabled ? '' : 'disabled'}`}
                        >
                          <div className="st-prompt-left">
                            <span className="st-star">{entry.constant ? '📌' : '🔑'}</span>
                            <div style={{ minWidth: 0 }}>
                              <div className="st-prompt-name" title={entry.comment}>
                                {entry.comment || `词条 #${entry.uid}`}
                              </div>
                              <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {entry.constant
                                  ? '常驻词条（开局自动注入）'
                                  : `关键词：${entry.keys.slice(0, 4).join('、') || '无'}`}
                              </div>
                            </div>
                          </div>
                          <div className="st-prompt-right">
                            <label className="st-switch">
                              <input
                                type="checkbox"
                                checked={entry.enabled}
                                onChange={(e) =>
                                  callTool('story_app_toggle_card_lore_entry', {
                                    cardId: activeCard.id,
                                    uid: entry.uid,
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              <span className="st-slider" />
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {data.lorebooks.length === 0 && !activeCard?.hasEmbeddedLorebook && (
                <div className="muted">暂未导入外部世界书（角色卡内嵌的 character_book 会自动生效）。</div>
              )}
              {data.lorebooks.map((book) => {
                const active = data.config.activeLorebookIds.includes(book.id);
                return (
                  <div key={book.id} className={`st-prompt-row ${active ? '' : 'disabled'}`}>
                    <div className="st-prompt-left">
                      <span className="st-star">📖</span>
                      <div>
                        <div className="st-prompt-name">{book.name}</div>
                        <div className="muted">
                          共 {book.entryCount} 条 · 常驻 {book.constantCount} 条 · 深度 {book.scanDepth}
                        </div>
                      </div>
                    </div>
                    <div className="st-prompt-right">
                      <label className="st-switch">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...data.config.activeLorebookIds, book.id]
                              : data.config.activeLorebookIds.filter((x) => x !== book.id);
                            callTool('story_app_update_config', { activeLorebookIds: next });
                          }}
                        />
                        <span className="st-slider" />
                      </label>
                      <button
                        className="btn btn-danger"
                        onClick={() => callTool('story_app_delete_asset', { kind: 'lorebook', id: book.id })}
                      >
                        删
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'memory' && (() => {
            const memCfg = resolveMemoryPluginConfig(data.config.memoryPlugin);
            const turns = data.storyTurns ?? [];
            const split = splitTurnsByRecentFloors(turns, memCfg.recentFullFloors);
            const summarizedIds = new Set(split.summarizedTurns.map((t) => t.turnId));
            const summarizedWithText = turns.filter((t) => Boolean(t.memorySummary?.trim())).length;

            const patchMemory = (patch: Partial<MemoryPluginConfig>, msg?: string) =>
              callTool('story_app_update_config', { memoryPlugin: patch }).then(() => {
                if (msg) setStatusMsg(msg);
              });

            return (
              <>
                <div className="card-box">
                  <div className="row" style={{ alignItems: 'center' }}>
                    <div>
                      <strong>🧠 记忆插件（滑动窗口 + 逐楼小总结）</strong>
                      <div className="muted" style={{ marginTop: 2 }}>
                        开启后，每轮正文末尾要求模型附带约 {memCfg.summaryLengthHint} 字 <code>&lt;memory_summary&gt;</code>；发送上下文时仅最新 {memCfg.recentFullFloors} 楼喂完整正文，更早楼层全部只喂小总结。
                      </div>
                    </div>
                    <button
                      className={`btn ${memCfg.enabled ? 'btn-primary' : ''}`}
                      onClick={() =>
                        patchMemory(
                          { enabled: !memCfg.enabled },
                          !memCfg.enabled ? '记忆插件已开启' : '记忆插件已关闭（恢复全量历史）',
                        )
                      }
                    >
                      {memCfg.enabled ? '● 总开关：已开启' : '○ 总开关：已关闭'}
                    </button>
                  </div>

                  <div className="mem-stats-bar">
                    <span>
                      当前存档：<strong>{split.totalFloors}</strong> 楼（{turns.length} 轮）
                    </span>
                    <span>
                      全量正文窗口：<strong>{memCfg.enabled ? split.fullFloorCount : split.totalFloors}</strong> 楼
                    </span>
                    <span>
                      摘要压缩：<strong>{memCfg.enabled ? split.summarizedFloorCount : 0}</strong> 楼
                    </span>
                    <span>
                      已有小总结：<strong>{summarizedWithText}/{turns.length}</strong> 轮
                    </span>
                  </div>
                </div>

                <div className="card-box">
                  <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <strong>完整正文保留楼层数</strong>
                      <div className="muted">
                        玩家输入与 AI 正文各算 1 楼（例如 10 楼 = 最近 5 轮完整对话）
                      </div>
                    </div>
                    <div className="row-actions" style={{ alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        className="input"
                        style={{ width: 72, textAlign: 'center', padding: '4px 6px' }}
                        value={recentFloorsDraft}
                        onChange={(e) => setRecentFloorsDraft(e.target.value)}
                        onBlur={() => {
                          const v = parseInt(recentFloorsDraft, 10);
                          if (Number.isFinite(v)) {
                            const clamped = Math.max(1, Math.min(200, v));
                            setRecentFloorsDraft(String(clamped));
                            if (clamped !== memCfg.recentFullFloors) {
                              patchMemory({ recentFullFloors: clamped }, `完整正文窗口已设为最新 ${clamped} 楼`);
                            }
                          } else {
                            setRecentFloorsDraft(String(memCfg.recentFullFloors));
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                      <span className="muted">楼</span>
                    </div>
                  </div>
                  <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {[6, 7, 8, 10, 12, 16, 20].map((n) => (
                      <button
                        key={n}
                        className={`btn btn-xs ${memCfg.recentFullFloors === n ? 'btn-primary' : ''}`}
                        onClick={() => patchMemory({ recentFullFloors: n }, `完整正文窗口已设为最新 ${n} 楼`)}
                      >
                        {n} 楼
                      </button>
                    ))}
                  </div>

                  <div className="row" style={{ alignItems: 'center', marginBottom: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                    <div>
                      <strong>小总结目标字数</strong>
                      <div className="muted">提示词中建议模型每轮总结的字数（默认 200 字）</div>
                    </div>
                    <div className="row-actions" style={{ alignItems: 'center', gap: 6 }}>
                      {[120, 200, 300].map((len) => (
                        <button
                          key={len}
                          className={`btn btn-xs ${memCfg.summaryLengthHint === len ? 'btn-primary' : ''}`}
                          onClick={() => patchMemory({ summaryLengthHint: len })}
                        >
                          {len}字
                        </button>
                      ))}
                      <input
                        type="number"
                        min={50}
                        max={800}
                        step={20}
                        className="input"
                        style={{ width: 68, textAlign: 'center', padding: '4px 6px' }}
                        value={summaryLengthDraft}
                        onChange={(e) => setSummaryLengthDraft(e.target.value)}
                        onBlur={() => {
                          const v = parseInt(summaryLengthDraft, 10);
                          if (Number.isFinite(v)) {
                            const clamped = Math.max(50, Math.min(800, v));
                            setSummaryLengthDraft(String(clamped));
                            if (clamped !== memCfg.summaryLengthHint) {
                              patchMemory({ summaryLengthHint: clamped });
                            }
                          } else {
                            setSummaryLengthDraft(String(memCfg.summaryLengthHint));
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </div>
                  </div>

                  <div className="row" style={{ alignItems: 'center', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                    <div>
                      <strong>正文阅读器内显示方式</strong>
                      <div className="muted">控制每楼末尾 <code>&lt;memory_summary&gt;</code> 在正文区的展示</div>
                    </div>
                    <div className="row-actions" style={{ gap: 6 }}>
                      <button
                        className={`btn btn-xs ${memCfg.summaryDisplayMode !== 'hide' ? 'btn-primary' : ''}`}
                        onClick={() => patchMemory({ summaryDisplayMode: 'fold' })}
                      >
                        折叠小条
                      </button>
                      <button
                        className={`btn btn-xs ${memCfg.summaryDisplayMode === 'hide' ? 'btn-primary' : ''}`}
                        onClick={() => patchMemory({ summaryDisplayMode: 'hide' })}
                      >
                        正文内隐藏
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
                      <strong>自定义摘要提示词（可选）</strong>
                      <button
                        className="btn btn-xs btn-primary"
                        onClick={() =>
                          patchMemory({ customPrompt: memoryPromptDraft }, '记忆摘要提示词已保存')
                        }
                      >
                        保存提示词
                      </button>
                    </div>
                    <div className="muted" style={{ marginBottom: 6 }}>
                      留空将使用内置标准中文约束（支持 <code>{'{{length}}'}</code> 占位符引用目标字数）。
                    </div>
                    <textarea
                      className="textarea"
                      style={{ minHeight: 68 }}
                      placeholder="留空则使用内置标准约束：要求模型在每轮末尾输出约 {{length}} 字的 <memory_summary>...</memory_summary> 客观剧情小总结。"
                      value={memoryPromptDraft}
                      onChange={(e) => setMemoryPromptDraft(e.target.value)}
                    />
                  </div>
                </div>

                <div className="card-box">
                  <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                    <strong>📜 逐楼记忆时间线（{turns.length} 轮）</strong>
                    <span className="muted">可手动修改或为历史旧楼补写小总结</span>
                  </div>
                  {turns.length === 0 ? (
                    <div className="muted">当前存档还没有楼层记录，开始演绎后每轮摘要会自动汇总在这里。</div>
                  ) : (
                    <div className="mem-timeline">
                      {turns.map((t) => {
                        const isCompressed = memCfg.enabled && summarizedIds.has(t.turnId);
                        const isEditingMem = editingSummaryTurnId === t.turnId;
                        return (
                          <div key={t.turnId} className="mem-turn-item">
                            <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <strong>#{t.index}</strong>
                                <span className={`mem-badge ${isCompressed ? 'compressed' : 'full'}`}>
                                  {isCompressed ? '已摘要压缩' : '全量正文窗口'}
                                </span>
                                {!t.memorySummary?.trim() && (
                                  <span className="mem-badge missing">待补写（自动摘录降级）</span>
                                )}
                              </div>
                              <div className="row-actions" style={{ gap: 4 }}>
                                {isEditingMem ? (
                                  <>
                                    <button
                                      className="btn btn-xs btn-primary"
                                      onClick={async () => {
                                        const ok = await callTool('story_app_edit_turn_summary', {
                                          turnId: t.turnId,
                                          memorySummary: editingSummaryDraft,
                                        });
                                        if (ok) {
                                          setEditingSummaryTurnId(null);
                                          setStatusMsg(`已保存第 #${t.index} 楼记忆摘要`);
                                        }
                                      }}
                                    >
                                      保存
                                    </button>
                                    <button
                                      className="btn btn-xs"
                                      onClick={() => setEditingSummaryTurnId(null)}
                                    >
                                      取消
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="btn btn-xs"
                                    onClick={() => {
                                      setEditingSummaryTurnId(t.turnId);
                                      setEditingSummaryDraft(t.memorySummary ?? '');
                                    }}
                                  >
                                    {t.memorySummary?.trim() ? '编辑' : '补写'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {isEditingMem ? (
                              <textarea
                                className="textarea"
                                style={{ minHeight: 72 }}
                                placeholder="输入本楼约 200 字客观剧情小总结..."
                                value={editingSummaryDraft}
                                onChange={(e) => setEditingSummaryDraft(e.target.value)}
                              />
                            ) : (
                              <div className="mem-turn-text">
                                {t.memorySummary?.trim() || (
                                  <span className="muted">
                                    暂无独立摘要；超出全量窗口时将自动截取本楼精简要点喂给模型。
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            );
          })()}

          {tab === 'state' && (
            <>
              {activeCard &&
                (activeCard.hasFrontendHtml ||
                  activeCard.hasHelperScripts ||
                  Boolean(activePreset?.helperScripts?.some((s) => s.enabled))) && (
                cardFrontend && cardFrontend.cardId === activeCard.id ? (
                  <TavernFrontendHost
                    frontend={cardFrontend}
                    statData={data.statData ?? {}}
                    userName={data.config.userName || 'User'}
                    storyTurns={data.storyTurns ?? []}
                    onSendSlashOrMessage={(txt) => sendTextToChat(txt)}
                    onUpdateStatData={(nextStat) =>
                      callTool('story_app_set_stat_data', { statData: nextStat })
                    }
                  />
                ) : (
                  <div className="card-box">
                    <div className="row">
                      <div>
                        <strong>✨ 检测到角色卡自带前端美化 / 助手脚本</strong>
                        <div className="muted">
                          可在侧边栏通过 卡片脚本垫片加载，完全不碰 AGY 主窗口。
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        onClick={async () => {
                          const app = appRef.current;
                          if (!app) return;
                          const requestedCardId = activeCard.id;
                          setStatusMsg('正在加载角色卡前端资源...');
                          try {
                            const res = await app.callServerTool({
                              name: 'story_app_get_card_frontend',
                              arguments: { cardId: requestedCardId },
                            });
                            if (res?.isError) {
                              setStatusMsg('加载角色卡前端资源失败');
                              return;
                            }
                            const sc = res?.structuredContent as CardFrontendPayload | undefined;
                            if (sc && sc.cardId === requestedCardId) {
                              setCardFrontend(sc);
                              setStatusMsg('角色卡前端资源已就绪');
                            }
                          } catch (err) {
                            setStatusMsg(`加载前端资源失败: ${String(err)}`);
                          }
                        }}
                      >
                        加载美化舞台
                      </button>
                    </div>
                  </div>
                )
              )}

              <div className="card-box">
                <div className="row">
                  <strong>MVU 变量树（stat_data）</strong>
                  {mvuSchemaCount > 0 && (
                    <span className="badge">MVU Zod Schema 已就绪 ({mvuSchemaCount})</span>
                  )}
                </div>
                <MvuTreeView data={data.statData ?? {}} />
              </div>

              <div className="card-box">
                <strong>基础状态栏</strong>
                <div className="muted">时辰：{data.sessionState.timeOfDay || '未记录'} · 地点：{data.sessionState.location || '未记录'}</div>
                <div className="muted">情绪：{data.sessionState.mood || '未记录'} · 好感：{data.sessionState.affection}</div>
                <div className="muted">衣着：{data.sessionState.outfit || '未记录'}</div>
                {data.sessionState.inventory.length > 0 && (
                  <div className="muted">背包：{data.sessionState.inventory.join('、')}</div>
                )}
                {data.sessionState.summary && (
                  <div className="muted">摘要：{data.sessionState.summary}</div>
                )}
              </div>

              <div className="card-box">
                <strong>玩家设定（User Persona）</strong>
                <input
                  className="input"
                  placeholder="玩家称呼 ({{user}})"
                  value={userNameDraft}
                  onChange={(e) => setUserNameDraft(e.target.value)}
                  onBlur={() => callTool('story_app_update_config', { userName: userNameDraft })}
                />
                <textarea
                  className="textarea"
                  placeholder="玩家人设描述 ({{persona}})"
                  value={userPersonaDraft}
                  onChange={(e) => setUserPersonaDraft(e.target.value)}
                  onBlur={() =>
                    callTool('story_app_update_config', { userPersona: userPersonaDraft })
                  }
                />
              </div>

              <div className="card-box">
                <div className="row">
                  <strong>外观与页面尺寸</strong>
                  <button
                    className="btn btn-xs"
                    onClick={() => {
                      setDraftUiScale(null);
                      setDraftFontSize(null);
                      setDraftLineHeight(null);
                      callTool('story_app_update_config', {
                        uiScale: 100,
                        proseFontSize: 14,
                        proseLineHeight: 1.7,
                        maxReadingWidth: 0,
                      });
                    }}
                  >
                    恢复默认
                  </button>
                </div>
                <div className="row">
                  <span className="muted">页面整体缩放：{uiScale}%</span>
                  <input
                    type="range"
                    min={80}
                    max={130}
                    step={5}
                    value={uiScale}
                    onChange={(e) => setDraftUiScale(Number(e.target.value))}
                    onPointerUp={() => {
                      if (draftUiScale !== null) {
                        const val = draftUiScale;
                        setDraftUiScale(null);
                        callTool('story_app_update_config', { uiScale: val });
                      }
                    }}
                    onKeyUp={() => {
                      if (draftUiScale !== null) {
                        const val = draftUiScale;
                        setDraftUiScale(null);
                        callTool('story_app_update_config', { uiScale: val });
                      }
                    }}
                  />
                </div>
                <div className="row">
                  <span className="muted">正文字号：{proseFontSize}px</span>
                  <input
                    type="range"
                    min={12}
                    max={22}
                    step={1}
                    value={proseFontSize}
                    onChange={(e) => setDraftFontSize(Number(e.target.value))}
                    onPointerUp={() => {
                      if (draftFontSize !== null) {
                        const val = draftFontSize;
                        setDraftFontSize(null);
                        callTool('story_app_update_config', { proseFontSize: val });
                      }
                    }}
                    onKeyUp={() => {
                      if (draftFontSize !== null) {
                        const val = draftFontSize;
                        setDraftFontSize(null);
                        callTool('story_app_update_config', { proseFontSize: val });
                      }
                    }}
                  />
                </div>
                <div className="row">
                  <span className="muted">正文行距：{proseLineHeight.toFixed(1)}</span>
                  <input
                    type="range"
                    min={1.4}
                    max={2.2}
                    step={0.1}
                    value={proseLineHeight}
                    onChange={(e) => setDraftLineHeight(Number(Number(e.target.value).toFixed(1)))}
                    onPointerUp={() => {
                      if (draftLineHeight !== null) {
                        const val = draftLineHeight;
                        setDraftLineHeight(null);
                        callTool('story_app_update_config', { proseLineHeight: val });
                      }
                    }}
                    onKeyUp={() => {
                      if (draftLineHeight !== null) {
                        const val = draftLineHeight;
                        setDraftLineHeight(null);
                        callTool('story_app_update_config', { proseLineHeight: val });
                      }
                    }}
                  />
                </div>
                <div className="row">
                  <span className="muted">阅读版心宽度</span>
                  <select
                    className="input"
                    style={{ width: 150 }}
                    value={maxReadingWidth}
                    onChange={(e) =>
                      callTool('story_app_update_config', {
                        maxReadingWidth: Number(e.target.value),
                      })
                    }
                  >
                    <option value={0}>自适应全宽</option>
                    <option value={720}>书卷窄版 (720px)</option>
                    <option value={860}>书卷标准 (860px)</option>
                    <option value={1000}>书卷宽版 (1000px)</option>
                  </select>
                </div>
              </div>

              <div className="card-box">
                <div className="row">
                  <strong>作者注释（Author&apos;s Note）</strong>
                  <label className="st-switch">
                    <input
                      type="checkbox"
                      checked={Boolean(data.config.authorsNoteEnabled)}
                      onChange={(e) =>
                        callTool('story_app_update_config', {
                          authorsNoteEnabled: e.target.checked,
                        })
                      }
                    />
                    <span className="st-slider" />
                  </label>
                </div>
                <div className="muted">
                  不改角色卡或预设原文，随时注入短期导演提醒/文风微调（自动置于历史楼层末尾，支持宏与 EJS）。
                </div>
                <textarea
                  className="textarea"
                  placeholder="例如：接下来几轮保持舒缓温馨的日常互动节奏，重点刻画细节与眼神交流..."
                  value={authorsNoteDraft}
                  onChange={(e) => setAuthorsNoteDraft(e.target.value)}
                  onBlur={() =>
                    callTool('story_app_update_config', { authorsNote: authorsNoteDraft })
                  }
                />
              </div>

              <div className="card-box">
                <strong>剧情渲染与世界书设置</strong>
                <div className="row">
                  <span className="muted">启用预设/角色卡正则美化（持久化）</span>
                  <label className="st-switch">
                    <input
                      type="checkbox"
                      checked={enableRegexBeautify}
                      onChange={(e) =>
                        callTool('story_app_update_config', {
                          enableRegexBeautify: e.target.checked,
                        })
                      }
                    />
                    <span className="st-slider" />
                  </label>
                </div>
                <div className="row">
                  <div>
                    <div>漏网未知标签兜底</div>
                    <div className="muted">
                      作者正则始终最先执行；仅当某自定义标签未被任何正则匹配时，按此策略兜底。
                    </div>
                  </div>
                  <select
                    className="input"
                    style={{ width: 130, flexShrink: 0 }}
                    value={unknownTagMode}
                    onChange={(e) =>
                      callTool('story_app_update_config', {
                        unknownTagMode: e.target.value as 'fold' | 'keep' | 'hide',
                      })
                    }
                  >
                    <option value="fold">自动折叠（推荐）</option>
                    <option value="keep">原样保留</option>
                    <option value="hide">静默隐藏</option>
                  </select>
                </div>
                <div className="row">
                  <span className="muted">默认渲染最近楼层数（点击顶部按此步长加载更早楼层）</span>
                  <input
                    type="number"
                    className="input"
                    style={{ width: 72 }}
                    min={2}
                    max={200}
                    step={2}
                    value={visibleFloorLimitDraft}
                    onChange={(e) => setVisibleFloorLimitDraft(e.target.value)}
                    onBlur={() => {
                      const v = parseInt(visibleFloorLimitDraft, 10);
                      if (Number.isFinite(v)) {
                        const clamped = Math.max(2, Math.min(200, v));
                        setVisibleFloorLimitDraft(String(clamped));
                        if (clamped !== visibleFloorLimit) {
                          callTool('story_app_update_config', { visibleFloorLimit: clamped });
                        }
                      } else {
                        setVisibleFloorLimitDraft(String(visibleFloorLimit));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
                <div className="row">
                  <span className="muted">世界书触发冷却回合（0 = 每次命中均触发）</span>
                  <input
                    type="number"
                    className="input"
                    style={{ width: 72 }}
                    min={0}
                    max={50}
                    value={data.config.cooldownTurns}
                    onChange={(e) =>
                      callTool('story_app_update_config', {
                        cooldownTurns: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </div>
              </div>

              {activeCard && (data.chatSlots?.length ?? 0) > 0 && (
                <div className="card-box">
                  <div className="row">
                    <strong>多周目存档管理（{activeCard.name}）</strong>
                    <button
                      className="btn btn-xs btn-primary"
                      onClick={async () => {
                        await callTool('story_app_new_chat_slot', {});
                        setStatusMsg('已开启新周目（旧周目记录完好保留）');
                      }}
                    >
                      + 开启新周目
                    </button>
                  </div>
                  {(data.chatSlots ?? []).map((slot) => {
                    const isCurrent = (data.activeChatSlot || 'default') === slot.slotId;
                    return (
                      <div key={slot.slotId} className="row">
                        <span className={isCurrent ? '' : 'muted'}>
                          {isCurrent ? '● ' : ''}
                          {slot.label}
                        </span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {!isCurrent && (
                            <button
                              className="btn btn-xs"
                              onClick={() =>
                                callTool('story_app_switch_chat_slot', { slotId: slot.slotId })
                              }
                            >
                              切换
                            </button>
                          )}
                          {slot.slotId !== 'default' && (
                            <button
                              className="btn btn-xs btn-danger"
                              onClick={() =>
                                callTool('story_app_delete_chat_slot', { slotId: slot.slotId })
                              }
                            >
                              删档
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="card-box">
                <strong>运行架构（单窗口导演模式）</strong>
                <div className="row">
                  <div>
                    <div>单窗口导演模式（已启用 · 配合左侧 <code>story-director</code>）</div>
                    <div className="muted">
                      主窗口零注入、不刷屏左侧列表；每轮自动派发全新 <code>story-writer</code> 子智能体全量重拼上下文落笔，写完立即销毁。
                    </div>
                  </div>
                  <span className="mem-badge full" style={{ flexShrink: 0 }}>默认启用</span>
                </div>
              </div>
            </>
          )}

          <div className="status-banner">{statusMsg}</div>
        </div>
      )}
    </div>
  );
}
