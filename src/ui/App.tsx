import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

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
  dataDir: string;
}

type TabKey = 'cards' | 'presets' | 'lorebooks' | 'state';

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
  const [data, setData] = useState<BootstrapData | null>(null);
  const [tab, setTab] = useState<TabKey>('cards');
  const [statusMsg, setStatusMsg] = useState<string>('正在连接 TavernInAGY 本地引擎...');
  const [presetSearch, setPresetSearch] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [canMessage, setCanMessage] = useState(false);

  useEffect(() => {
    const app = new App({ name: 'TavernInAGY', version: '0.1.0' }, {});
    appRef.current = app;

    app.ontoolresult = (result) => {
      const sc = result?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData(sc);
        setStatusMsg('已同步最新酒馆数据');
      }
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };

    app
      .connect()
      .then(async () => {
        const ctx = app.getHostContext();
        if (ctx?.theme) applyDocumentTheme(ctx.theme);
        if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
        const caps = app.getHostCapabilities();
        setCanMessage(Boolean(caps && 'message' in caps));
        await callTool('tavern_app_bootstrap', {});
      })
      .catch((err) => {
        setStatusMsg(`连接失败: ${String(err)}`);
      });
  }, []);

  async function callTool(name: string, args: Record<string, unknown>) {
    const app = appRef.current;
    if (!app) return;
    try {
      const res = await app.callServerTool({ name, arguments: args });
      const sc = res?.structuredContent as BootstrapData | undefined;
      if (sc && sc.config) {
        setData(sc);
      }
    } catch (err) {
      setStatusMsg(`操作失败: ${String(err)}`);
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
    setStatusMsg(`已导入角色卡: ${file.name}`);
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
    setStatusMsg(`已导入预设: ${file.name}`);
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

  async function sendOptionToChat(opt: WaveOption) {
    const app = appRef.current;
    if (!app || !canMessage) return;
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `${opt.label}：${opt.text}` }],
    });
    setStatusMsg(`已发送行动: ${opt.label}`);
  }

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

  return (
    <div className="app-shell">
      <div className="header">
        <div className="header-title">
          <span>🍺 TavernInAGY</span>
          <span className="badge">{data.config.enabled ? 'RP 运行中' : '已暂停'}</span>
        </div>
        <button
          className={`btn ${data.config.enabled ? '' : 'btn-primary'}`}
          onClick={() =>
            callTool('tavern_app_update_config', { enabled: !data.config.enabled })
          }
        >
          {data.config.enabled ? '暂停注入' : '启用注入'}
        </button>
      </div>

      <div className="tabs">
        <button className={`tab-btn ${tab === 'cards' ? 'active' : ''}`} onClick={() => setTab('cards')}>
          角色卡 ({data.cards.length})
        </button>
        <button className={`tab-btn ${tab === 'presets' ? 'active' : ''}`} onClick={() => setTab('presets')}>
          预设 ({data.presets.length})
        </button>
        <button className={`tab-btn ${tab === 'lorebooks' ? 'active' : ''}`} onClick={() => setTab('lorebooks')}>
          世界书 ({data.lorebooks.length})
        </button>
        <button className={`tab-btn ${tab === 'state' ? 'active' : ''}`} onClick={() => setTab('state')}>
          状态与选项
        </button>
      </div>

      {tab === 'cards' && (
        <div className="card-box">
          <div className="row">
            <strong>角色卡库（ST PNG V2/V3 & JSON）</strong>
            <label className="btn btn-primary">
              + 导入角色卡
              <input type="file" accept=".png,.json" hidden onChange={handleCardUpload} />
            </label>
          </div>
          {data.cards.length === 0 && (
            <div className="muted">暂未导入角色卡，点击右上角即可导入原版 SillyTavern PNG/JSON 角色卡。</div>
          )}
          {data.cards.map((card) => {
            const isActive = data.config.activeCardId === card.id;
            return (
              <div key={card.id} className="card-box" style={{ background: 'var(--bg-1)' }}>
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
                      {isActive ? '当前激活' : '启用'}
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
              + 导入预设 JSON
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
              <div className="muted">
                采样参数（Temp/Top-P）由 AGY 宿主托管；下方可按分组一键开关任意社区模块。
              </div>
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
                      <div className="card-box" style={{ padding: '4px 8px', background: 'var(--bg-1)' }}>
                        {sec.items.map((item) => (
                          <label key={item.identifier} className="prompt-item">
                            <div>
                              <div>
                                {item.name} {item.marker ? <span className="badge">插槽</span> : null}
                              </div>
                              <div className="muted">
                                {item.identifier} · {item.charLength} 字
                              </div>
                            </div>
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
                          </label>
                        ))}
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
              + 导入世界书 JSON
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
              <div key={book.id} className="prompt-item">
                <div>
                  <strong>{book.name}</strong>
                  <div className="muted">
                    共 {book.entryCount} 条 · 常驻 {book.constantCount} 条 · 扫描深度 {book.scanDepth}
                  </div>
                </div>
                <div className="row">
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
            <strong>我的设定（User Persona）</strong>
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

          <div className="card-box">
            <strong>当前实时状态</strong>
            <div className="muted">时间：{data.sessionState.timeOfDay || '未记录'}</div>
            <div className="muted">地点：{data.sessionState.location || '未记录'}</div>
            <div className="muted">情绪：{data.sessionState.mood || '未记录'} · 好感：{data.sessionState.affection}</div>
            {data.sessionState.inventory.length > 0 && (
              <div className="muted">背包：{data.sessionState.inventory.join('、')}</div>
            )}
            {data.sessionState.summary && (
              <div className="muted">摘要：{data.sessionState.summary}</div>
            )}
          </div>

          {data.latestOptions.length > 0 && (
            <div className="card-box">
              <strong>快捷行动选项（点击直接推进剧情）</strong>
              {data.latestOptions.map((opt, idx) => (
                <button
                  key={idx}
                  className="option-btn"
                  disabled={!canMessage}
                  onClick={() => sendOptionToChat(opt)}
                >
                  <div><strong>{opt.label}</strong></div>
                  <div className="muted">{opt.text}</div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="status-banner">{statusMsg}</div>
    </div>
  );
}
