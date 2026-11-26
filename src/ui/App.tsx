import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App } from '@modelcontextprotocol/ext-apps';

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
  embeddedLorebookCount: number;
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

interface PresetSummary {
  id: string;
  name: string;
  regexCount: number;
  samplingMeta: Record<string, unknown>;
  prompts: PresetPromptSummary[];
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
}

interface BootstrapData {
  config: TavernConfig;
  cards: CardSummary[];
  presets: PresetSummary[];
  lorebooks: LorebookSummary[];
  sessionState: LiveState;
  latestOptions: WaveOption[];
  storyTurns: StoryTurnItem[];
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

function renderStoryNarrative(narrative: string) {
  const paragraphs = narrative
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="story-prose">
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
  const [showOptions, setShowOptions] = useState<boolean>(true);

  useEffect(() => {
    const app = new App({ name: 'TavernInAGY', version: '0.5.0' }, {});
    appRef.current = app;

    app.ontoolresult = (result) => {
      const sc = result?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData((prev) => ({
          ...sc,
          cards: sc.cards.map((c) => {
            const old = prev?.cards.find((x) => x.id === c.id);
            return { ...c, avatarDataUrl: c.avatarDataUrl ?? old?.avatarDataUrl };
          }),
        }));
        setPendingSend(null);
        setStatusMsg('正文与 MVU 状态已同步');
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

  async function callTool(name: string, args: Record<string, unknown>): Promise<BootstrapData | undefined> {
    const app = appRef.current;
    if (!app) return undefined;
    try {
      const res = await app.callServerTool({ name, arguments: args });
      const sc = res?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData(sc);
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
      setStatusMsg('当前视图不支持直发消息，请在右侧边栏模式打开 TavernInAGY。');
      return;
    }
    setComposerText('');
    setPendingSend(text);
    setStatusMsg('已发送，等待角色落笔回应...');
    try {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text }],
      });
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
          世界书 ({data.lorebooks.length})
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

            {activeCard && (!data.storyTurns || data.storyTurns.length === 0) && activeCard.firstMessage && (
              <div className="story-paper">
                <div className="row">
                  <span className="muted">开场白 · {activeCard.name}</span>
                  <span className="badge">Opening</span>
                </div>
                {renderStoryNarrative(
                  activeCard.firstMessage
                    .replace(/\{\{char\}\}/gi, activeCard.name)
                    .replace(/\{\{user\}\}/gi, data.config.userName || 'User'),
                )}
              </div>
            )}

            {(data.storyTurns ?? []).map((t) => {
              const isEditing = editingTurnId === t.turnId;
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
                      renderStoryNarrative(t.narrative)
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
                    ? '在此直接输入你的行动或对话…（Enter 发送，Shift+Enter 换行）'
                    : '请在右侧边栏模式打开以启用直聊发送'
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
              <button
                className="btn btn-xs"
                onClick={handleForkBranch}
                title="编辑或删楼后，拉起新分支无缝续写"
              >
                ✨ 分支续写
              </button>
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
                  <div className="muted">采样参数由 AGY 宿主托管；下方可按分组一键开关任意社区模块。</div>
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
                              return (
                                <div
                                  key={item.identifier}
                                  className={`st-prompt-row ${item.enabled ? '' : 'disabled'}`}
                                >
                                  <div className="st-prompt-left">
                                    <span className="st-star">{item.marker ? '▤' : '✳'}</span>
                                    <span className="st-prompt-name" title={item.identifier}>
                                      {item.name}
                                    </span>
                                    {item.marker ? <span className="badge">插槽</span> : null}
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
              {data.lorebooks.length === 0 && (
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
              <div className="card-box">
                <strong>MVU 实时状态栏</strong>
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
