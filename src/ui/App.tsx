import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App } from '@modelcontextprotocol/ext-apps';
import type { RegexScript } from '../core/types';
import { MvuTreeView } from './MvuTreeView';
import { TavernFrontendHost, type CardFrontendPayload } from './TavernFrontendHost';
import { FloorRenderer } from './FloorRenderer';

interface EmbeddedLoreEntrySummary {
  uid: string;
  comment: string;
  keys: string[];
  constant: boolean;
  enabled: boolean;
  order: number;
}

interface CardSummary {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  tags: string[];
  avatarDataUrl?: string;
  hasEmbeddedLorebook: boolean;
  embeddedLorebookName?: string;
  embeddedLorebookCount: number;
  embeddedLorebookEntries?: EmbeddedLoreEntrySummary[];
  hasFrontendHtml?: boolean;
  hasHelperScripts?: boolean;
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
  statsSnapshot?: {
    location?: string;
    mood?: string;
    outfit?: string;
    affection?: number;
  };
  createdAt: string;
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
  activeDisplayRegexScripts?: RegexScript[];
  dataDir: string;
}

type TabKey = 'chat' | 'cards' | 'presets' | 'lorebooks' | 'state';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function AppView() {
  const appRef = useRef<App | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [tab, setTab] = useState<TabKey>('chat');
  const [statusMsg, setStatusMsg] = useState<string>('正在连接 TavernInAGY 本地引擎...');
  const [presetSearch, setPresetSearch] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [canMessage, setCanMessage] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>('');
  const [composerText, setComposerText] = useState<string>('');
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const pendingBaseTurnCountRef = useRef<number>(0);
  const [showOptions, setShowOptions] = useState<boolean>(true);
  const [cardFrontend, setCardFrontend] = useState<CardFrontendPayload | null>(null);
  const [enableRegexBeautify, setEnableRegexBeautify] = useState<boolean>(true);
  const [showPresetRegexList, setShowPresetRegexList] = useState<boolean>(false);
  const [showEmbeddedLore, setShowEmbeddedLore] = useState<boolean>(true);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [editingPromptContent, setEditingPromptContent] = useState<string>('');
  const [editingPromptRole, setEditingPromptRole] = useState<'system' | 'user' | 'assistant'>('system');

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
              ].slice(-50)
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
        await callTool('tavern_app_bootstrap', {});
      })
      .catch((err) => {
        setStatusMsg(`连接失败: ${String(err)}`);
      });
  }, []);

  // Auto-scroll to bottom when new turns arrive or user sends a message
  useEffect(() => {
    if (tab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [data?.storyTurns?.length, pendingSend, tab]);

  // Lightweight auto-poll ONLY while waiting for a reply so the user never has to click Refresh manually
  useEffect(() => {
    if (!pendingSend) return;
    let cancelled = false;
    let ticks = 0;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      ticks += 1;
      if (ticks > 60) {
        // Stop polling after ~2.5 minutes
        window.clearInterval(timer);
        return;
      }
      const app = appRef.current;
      if (!app) return;
      try {
        const res = await app.callServerTool({ name: 'tavern_app_bootstrap', arguments: {} });
        const sc = res?.structuredContent as BootstrapData | undefined;
        if (!cancelled && sc && sc.config) {
          const newCount = sc.storyTurns?.length ?? 0;
          if (newCount > pendingBaseTurnCountRef.current) {
            setData(sc);
            setPendingSend(null);
            setStatusMsg(`已自动同步第 #${newCount} 楼正文`);
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
      const sc = res?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData(sc);
        if (name === 'tavern_app_bootstrap') {
          setPendingSend(null);
        }
      }
      return sc;
    } catch (err) {
      setStatusMsg(`操作失败: ${String(err)}`);
      return undefined;
    }
  }

  async function sendTextToChat(rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    const app = appRef.current;
    if (!app || !canMessage) {
      setStatusMsg('左侧尚未建立对话：请先在左侧发送第一句，再重开或刷新此面板以启用直聊。');
      return;
    }
    const useDirector = Boolean(data?.config.directorMode);
    const useStateless = !useDirector && Boolean(data?.config.statelessPerTurn);
    setComposerText('');
    pendingBaseTurnCountRef.current = data?.storyTurns?.length ?? 0;
    setPendingSend(text);
    setStatusMsg(
      useDirector
        ? '已交由导演派发全新 tavern-rp 子智能体落笔（写完自动销毁并同步）...'
        : useStateless
          ? '已按无状态单轮模式拉起全新上下文，等待角色落笔（完成后自动同步）...'
          : '已发送，等待角色落笔回应（完成后将自动同步）...',
    );
    try {
      const payload = useStateless
        ? ({
            role: 'user',
            content: [{ type: 'text', text }],
            _meta: { 'com.google.antigravity/message': { target: 'new' } },
          } as Parameters<App['sendMessage']>[0])
        : {
            role: 'user' as const,
            content: [{ type: 'text' as const, text }],
          };
      await app.sendMessage(payload);
    } catch (err) {
      setPendingSend(null);
      setStatusMsg(`发送失败: ${String(err)}`);
    }
  }

  async function handleCardUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在导入角色卡 ${file.name}...`);
    const buf = await file.arrayBuffer();
    const isPng = file.name.toLowerCase().endsWith('.png');
    await callTool('tavern_app_import_card', {
      filename: file.name,
      contentBase64: arrayBufferToBase64(buf),
      isPng,
      setActive: true,
    });
    setStatusMsg(`已导入并启用角色卡: ${file.name}`);
    e.target.value = '';
  }

  async function handlePresetUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在解析社区预设 ${file.name}...`);
    const jsonText = await file.text();
    await callTool('tavern_app_import_preset', {
      filename: file.name,
      jsonText,
      setActive: true,
    });
    setStatusMsg(`已导入并启用预设: ${file.name}`);
    e.target.value = '';
  }

  async function handleLorebookUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatusMsg(`正在导入世界书 ${file.name}...`);
    const jsonText = await file.text();
    await callTool('tavern_app_import_lorebook', {
      filename: file.name,
      jsonText,
      activate: true,
    });
    setStatusMsg(`已导入世界书: ${file.name}`);
    e.target.value = '';
  }

  async function handleForkBranch() {
    await callTool('tavern_app_prepare_fork', {});
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

  return (
    <div className="app-shell">
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
            onClick={() => callTool('tavern_app_bootstrap', {})}
            title="手动同步最新楼层与状态"
          >
            刷新
          </button>
          <button
            className={`btn btn-xs ${data.config.enabled ? '' : 'btn-primary'}`}
            onClick={() =>
              callTool('tavern_app_update_config', { enabled: !data.config.enabled })
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
        <button className={`tab-btn ${tab === 'state' ? 'active' : ''}`} onClick={() => setTab('state')}>
          状态
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

            {activeCard && activeCard.firstMessage && (
              <div className="story-paper">
                <div className="row">
                  <span className="muted">#0 · 开场白 · {activeCard.name}</span>
                  <span className="badge">Opening</span>
                </div>
                <FloorRenderer
                  narrative={activeCard.firstMessage
                    .replace(/\{\{char\}\}/gi, activeCard.name)
                    .replace(/\{\{user\}\}/gi, data.config.userName || 'User')}
                  depth={data.storyTurns?.length ?? 0}
                  regexScripts={data.activeDisplayRegexScripts ?? []}
                  enableRegex={enableRegexBeautify}
                  charName={activeCard.name}
                  userName={data.config.userName || 'User'}
                  statData={data.statData ?? {}}
                  onSendMessage={sendTextToChat}
                />
              </div>
            )}

            {(data.storyTurns ?? []).map((t, idx, arr) => {
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
                      <div className="floor-actions">
                        {!isEditing ? (
                          <button
                            className="btn btn-xs"
                            onClick={() => {
                              setEditingTurnId(t.turnId);
                              setEditingDraft(t.narrative);
                            }}
                          >
                            编辑
                          </button>
                        ) : (
                          <button
                            className="btn btn-xs btn-primary"
                            onClick={async () => {
                              await callTool('tavern_app_edit_turn', {
                                turnId: t.turnId,
                                narrative: editingDraft,
                              });
                              setEditingTurnId(null);
                              setStatusMsg(`已保存第 #${t.index} 楼修改`);
                            }}
                          >
                            保存
                          </button>
                        )}
                        <button
                          className="btn btn-xs"
                          onClick={async () => {
                            await callTool('tavern_app_rollback_turn', {
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
                            await callTool('tavern_app_rollback_turn', {
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
                        depth={depth}
                        regexScripts={data.activeDisplayRegexScripts ?? []}
                        enableRegex={enableRegexBeautify}
                        charName={activeCard?.name ?? '角色'}
                        userName={data.config.userName || 'User'}
                        statData={data.statData ?? {}}
                        onSendMessage={sendTextToChat}
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
            {data.latestOptions.length > 0 && (
              <div>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="muted">快捷走法选项（点击即发）</span>
                  <button
                    className="btn btn-xs"
                    onClick={() => setShowOptions((v) => !v)}
                  >
                    {showOptions ? '收起' : `展开 (${data.latestOptions.length})`}
                  </button>
                </div>
                {showOptions && (
                  <div className="options-strip">
                    {data.latestOptions.map((opt, idx) => (
                      <button
                        key={idx}
                        className="option-btn"
                        disabled={!canMessage}
                        onClick={() => sendTextToChat(`${opt.label}：${opt.text}`)}
                      >
                        <div><strong>{opt.label}</strong></div>
                        <div className="muted">{opt.text}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="composer-row">
              <textarea
                className="composer-input"
                placeholder={
                  canMessage
                    ? data.config.directorMode
                      ? '导演模式（请确保左侧已选 tavern-director）：每轮自动派发干净子智能体落笔…'
                      : data.config.statelessPerTurn
                        ? '无状态单轮模式：每句自动新开干净上下文全量重拼…（Enter 发送）'
                        : '在此直接输入你的行动或对话…（Enter 发送，Shift+Enter 换行）'
                    : '左侧尚未建立对话：请先在左侧发送第一句，再重开本面板即可启用直聊'
                }
                value={composerText}
                disabled={!canMessage}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendTextToChat(composerText);
                  }
                }}
              />
              <button
                className="btn btn-primary composer-send"
                disabled={!canMessage || !composerText.trim()}
                onClick={() => sendTextToChat(composerText)}
              >
                发送
              </button>
            </div>

            <div className="row">
              <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {statusMsg}
              </span>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  className={`btn btn-xs ${data.config.directorMode ? 'btn-primary' : ''}`}
                  onClick={() =>
                    callTool('tavern_app_update_config', {
                      directorMode: !data.config.directorMode,
                      ...(!data.config.directorMode ? { statelessPerTurn: false } : {}),
                    })
                  }
                  title="单窗口导演模式（需在左侧选择 tavern-director）：每轮派发全新 tavern-rp 子智能体落笔后立即销毁，零多会话刷屏"
                >
                  {data.config.directorMode ? '导演子体：开' : '导演子体：关'}
                </button>
                <button
                  className="btn btn-xs"
                  onClick={() => setEnableRegexBeautify((v) => !v)}
                  title="切换预设/角色卡正则美化与原始正文"
                >
                  {enableRegexBeautify ? '正则美化：开' : '正则美化：关'}
                </button>
                <button
                  className="btn btn-xs"
                  onClick={handleForkBranch}
                  title="编辑或删楼后，拉起新分支无缝续写"
                >
                  ✨ 分支续写
                </button>
              </div>
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
                💡 在主聊天框输入 <code>/agents</code> 切换 <strong>tavern-rp</strong> 进入纯净 RP 模式，在此一键切卡即刻生效。
              </div>
              {data.cards.length === 0 && (
                <div className="muted">暂未导入角色卡，点击右上角导入原版 ST PNG/JSON 角色卡。</div>
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
                            callTool('tavern_app_update_config', {
                              activeCardId: isActive ? null : card.id,
                            })
                          }
                        >
                          {isActive ? '已激活' : '启用'}
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => callTool('tavern_app_delete_asset', { kind: 'card', id: card.id })}
                        >
                          删
                        </button>
                      </div>
                    </div>
                    {card.scenario && <div className="muted">场景：{card.scenario.slice(0, 100)}</div>}
                  </div>
                );
              })}
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
                      callTool('tavern_app_update_config', {
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
                      onClick={() => callTool('tavern_app_delete_asset', { kind: 'preset', id: activePreset.id })}
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
                                        callTool('tavern_app_toggle_preset_regex', {
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
                                          name: 'tavern_app_get_preset_prompt',
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
                                            callTool('tavern_app_toggle_preset_prompt', {
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
                                            await callTool('tavern_app_edit_preset_prompt', {
                                              presetId: activePreset.id,
                                              identifier: item.identifier,
                                              content: editingPromptContent,
                                              role: editingPromptRole,
                                            });
                                            setEditingPromptId(null);
                                            setStatusMsg(`已保存预设条目「${item.name}」`);
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
                    callTool('tavern_app_update_config', {
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
                                  callTool('tavern_app_toggle_card_lore_entry', {
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
                            callTool('tavern_app_update_config', { activeLorebookIds: next });
                          }}
                        />
                        <span className="st-slider" />
                      </label>
                      <button
                        className="btn btn-danger"
                        onClick={() => callTool('tavern_app_delete_asset', { kind: 'lorebook', id: book.id })}
                      >
                        删
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'state' && (
            <>
              {activeCard && (activeCard.hasFrontendHtml || activeCard.hasHelperScripts) && (
                cardFrontend && cardFrontend.cardId === activeCard.id ? (
                  <TavernFrontendHost
                    frontend={cardFrontend}
                    statData={data.statData ?? {}}
                    userName={data.config.userName || 'User'}
                    storyTurns={data.storyTurns ?? []}
                    onSendSlashOrMessage={(txt) => sendTextToChat(txt)}
                    onUpdateStatData={(nextStat) =>
                      callTool('tavern_app_set_stat_data', { statData: nextStat })
                    }
                  />
                ) : (
                  <div className="card-box">
                    <div className="row">
                      <div>
                        <strong>✨ 检测到角色卡自带前端美化 / 助手脚本</strong>
                        <div className="muted">
                          可在侧边栏通过 TavernHelper 垫片加载，完全不碰 AGY 主窗口。
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        onClick={async () => {
                          const app = appRef.current;
                          if (!app) return;
                          setStatusMsg('正在加载角色卡前端资源...');
                          const res = await app.callServerTool({
                            name: 'tavern_app_get_card_frontend',
                            arguments: { cardId: activeCard.id },
                          });
                          const sc = res?.structuredContent as CardFrontendPayload | undefined;
                          if (sc) {
                            setCardFrontend(sc);
                            setStatusMsg('角色卡前端资源已就绪');
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
                <strong>MVU 变量树（stat_data）</strong>
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
                <strong>上下文与省额度策略（AGY 缓存优化）</strong>
                <div className="row">
                  <div>
                    <div>单窗口导演模式（推荐 · 配合左侧 <code>tavern-director</code>）</div>
                    <div className="muted">
                      主窗口零注入、不刷屏左侧列表；每轮自动派发全新 <code>tavern-rp</code> 子智能体全量重拼上下文落笔，写完立即销毁。
                    </div>
                  </div>
                  <label className="st-switch" style={{ flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(data.config.directorMode)}
                      onChange={(e) =>
                        callTool('tavern_app_update_config', {
                          directorMode: e.target.checked,
                          ...(e.target.checked ? { statelessPerTurn: false } : {}),
                        })
                      }
                    />
                    <span className="st-slider" />
                  </label>
                </div>
                <div className="row">
                  <div>
                    <div>无状态单轮模式（每轮新开后台会话）</div>
                    <div className="muted">
                      备选方案：每次发送拉起新后台对话（会新增左侧历史会话记录）。
                    </div>
                  </div>
                  <label className="st-switch" style={{ flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(data.config.statelessPerTurn)}
                      onChange={(e) =>
                        callTool('tavern_app_update_config', {
                          statelessPerTurn: e.target.checked,
                          ...(e.target.checked ? { directorMode: false } : {}),
                        })
                      }
                    />
                    <span className="st-slider" />
                  </label>
                </div>
                <div className="row">
                  <span className="muted">预设后半段周期提醒（0 = 仅首轮钉死，最省额度）</span>
                  <input
                    type="number"
                    className="input"
                    style={{ width: 72 }}
                    min={0}
                    max={50}
                    value={data.config.postHistoryRefreshInterval}
                    onChange={(e) =>
                      callTool('tavern_app_update_config', {
                        postHistoryRefreshInterval: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </div>
              </div>

              <div className="card-box">
                <strong>玩家设定（User Persona）</strong>
                <input
                  className="input"
                  placeholder="玩家称呼 ({{user}})"
                  defaultValue={data.config.userName}
                  onBlur={(e) => callTool('tavern_app_update_config', { userName: e.target.value })}
                />
                <textarea
                  className="textarea"
                  placeholder="玩家人设描述 ({{persona}})"
                  defaultValue={data.config.userPersona}
                  onBlur={(e) => callTool('tavern_app_update_config', { userPersona: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="status-banner">{statusMsg}</div>
        </div>
      )}
    </div>
  );
}
