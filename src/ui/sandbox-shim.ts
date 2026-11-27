export interface SandboxShimOptions {
  widgetId: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  /** Current floor message_id (e.g. 0 for opening, 1..N for turns) */
  currentMessageId?: number;
  /** Raw narrative of the current floor so preset widgets reading current message get original tags */
  currentNarrative?: string;
  /** All opening greetings ([firstMessage, ...alternateGreetings]) for message #0 swipes */
  greetings?: string[];
  /** Currently active opening greeting index (0-based) */
  activeGreetingIndex?: number;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  customExtensions?: Record<string, unknown>;
  /** Lightweight mode for per-floor prose beautifiers: omits full storyTurns/greetings serialization */
  liteProseMode?: boolean;
}

export interface ParsedSlashAction {
  action: 'send' | 'setInput' | 'selectGreeting';
  text: string;
  index?: number;
}

/**
 * Parses SillyTavern / JS-Slash-Runner slash commands triggered by preset/card buttons:
 * - `/send ...` or `/sendas ...` -> `{ action: 'send', text }`
 * - `/setinput ...` -> `{ action: 'setInput', text }`
 */
export function parseSlashCommandAction(rawCmd: string): ParsedSlashAction | null {
  const trimmed = String(rawCmd || '').trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\|\|/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^\/trigger\b/i.test(part)) continue;
    const swipesGoMatch = part.match(/^\/swipes-go\s+(\d+)$/i);
    if (swipesGoMatch?.[1]) {
      const idx = Math.max(0, Number(swipesGoMatch[1]) - 1);
      return { action: 'selectGreeting', text: '', index: idx };
    }
    const setInputMatch = part.match(/^\/setinput\s+([\s\S]+)$/i);
    if (setInputMatch?.[1]?.trim()) {
      return { action: 'setInput', text: setInputMatch[1].trim() };
    }
    const sendMatch = part.match(/^\/send\s+([\s\S]+)$/i);
    if (sendMatch?.[1]?.trim()) {
      return { action: 'send', text: sendMatch[1].trim() };
    }
    const sendAsMatch = part.match(/^\/sendas\s+(?:name=(?:"[^"]*"|'[^']*'|\S+)\s+)?([\s\S]+)$/i);
    if (sendAsMatch?.[1]?.trim()) {
      return { action: 'send', text: sendAsMatch[1].trim() };
    }
  }

  if (!trimmed.startsWith('/')) {
    return { action: 'send', text: trimmed };
  }
  return null;
}

/** Back-compat helper returning only send text */
export function parseSlashCommandToMessage(rawCmd: string): string | null {
  const parsed = parseSlashCommandAction(rawCmd);
  return parsed?.text ?? null;
}

/**
 * Safely serializes arbitrary JSON for embedding inside an HTML `<script>` tag.
 * Escapes `<`, `>`, `&`, and JS line separators so embedded `</script>` or `<!--`
 * inside card extensions, greetings, or story turns can never break out of `<script>`.
 */
export function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Detects SillyTavern prose-beautifier helper scripts that style/enhance `#chat .mes .mes_text`
 * (e.g. manuscript typography, bilingual dialogue frames, interactive glossary popups),
 * excluding MVU schema scripts and massive standalone full-screen frontend hosts.
 */
export function isProseBeautifierScript(content: string): boolean {
  if (!content || content.length > 200_000) return false;
  if (/\bregisterMvuSchema\b/.test(content)) return false;
  const stylesMesText =
    /#chat\b[\s\S]{0,80}\.mes_text\b/.test(content) ||
    /\.mes_text(?:\.[a-zA-Z0-9_-]+|\s*\{|\s+[a-zA-Z.#[])/.test(content);
  const touchesDom =
    /\bcreateElement\b|\bMutationObserver\b|\bquerySelector(?:All)?\b|\bgetElementById\b/.test(content);
  return stylesMesText && touchesDom;
}

function escapeHtmlBasic(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function proseTextToStMesHtml(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para
      .map((line) =>
        escapeHtmlBasic(line)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>'),
      )
      .join('<br>');
    blocks.push(`<p>${joined}</p>`);
    para = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushPara();
      blocks.push('<hr>');
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  return blocks.join('\n');
}

/**
 * Builds an isolated SillyTavern-compatible prose stage (`#chat > .mes > .mes_block > .mes_text`)
 * so card prose-beautifier scripts run safely inside `sandbox="allow-scripts"` with full DOM/CSS/event support.
 */
export function buildProseBeautifierSrcDoc(
  proseText: string,
  scripts: Array<{ name: string; content: string }>,
  opts: SandboxShimOptions,
): string {
  const mesId = opts.currentMessageId ?? 0;
  const safeChar = escapeHtmlBasic(opts.charName || 'Character');
  const mesHtml = proseTextToStMesHtml(proseText);
  const scriptTags = scripts
    .map((sc) => {
      const sanitized = sc.content
        .replace(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]https?:\/\/[^'"]+['"]\s*;?\s*$/gm, '// [local Mvu/Zod runtime active]')
        .replace(/<\/script>/gi, '<\\/script>');
      const safeName = sc.name.replace(/-->/g, '').replace(/\r?\n/g, ' ');
      return `<script>\n// ${safeName}\n(function(){\ntry {\n${sanitized}\n} catch (e) { console.error('[ProseBeautifier:' + ${safeJsonForInlineScript(safeName)} + ']', e); }\n})();\n</script>`;
    })
    .join('\n');

  const bodyHtml = `<style>
#chat { width: 100%; }
#chat .mes { width: 100%; }
#chat .mes_text { font-size: 14.5px; line-height: 1.85; color: #e5d9c3; word-break: break-word; }
#chat .mes_text p { margin: 0 0 0.85em 0; }
#chat .mes_text p:last-child { margin-bottom: 0; }
</style>
<div id="chat">
  <div class="mes" mesid="${mesId}" is_user="false" ch_name="${safeChar}">
    <div class="mes_block">
      <div class="mes_text">${mesHtml}</div>
    </div>
  </div>
</div>
${scriptTags}
<script>
window.addEventListener('DOMContentLoaded', function(){
  try {
    if (typeof window.eventEmit === 'function' && window.tavern_events) {
      window.eventEmit(window.tavern_events.CHARACTER_MESSAGE_RENDERED, ${mesId});
    }
  } catch (e) {}
});
</script>`;

  return buildSandboxedSrcDoc(bodyHtml, { ...opts, liteProseMode: true });
}

/**
 * Wraps card/preset helper scripts into safe async IIFEs for an isolated iframe stage,
 * stripping external CDN static `import 'https://...'` lines (since the local sandbox shim
 * already provides `window.z` (Zod v4), `window.Mvu`, `window.registerMvuSchema`, and `window._`).
 */
export function buildHelperScriptsStageHtml(
  scripts: Array<{ name: string; content: string }>,
): string {
  const scriptTags = scripts
    .map((sc) => {
      const sanitized = sc.content
        .replace(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]https?:\/\/[^'"]+['"]\s*;?\s*$/gm, '// [local Mvu/Zod runtime active]')
        .replace(/<\/script>/gi, '<\\/script>');
      const safeName = sc.name.replace(/-->/g, '').replace(/\r?\n/g, ' ');
      return `<script>\n// ${safeName}\n(async function(){\ntry {\n${sanitized}\n} catch (e) { console.error('[HelperScript:' + ${safeJsonForInlineScript(safeName)} + ']', e); }\n})();\n</script>`;
    })
    .join('\n');
  return `<div id="tavern-helper-stage" style="min-height:1px;position:relative;"></div>\n${scriptTags}`;
}

/**
 * Builds a self-contained HTML `srcDoc` with a rich, CSP-safe runtime shim supporting
 * `getCurrentMessageId()`, range-aware `getChatMessages(range)`, `getLastMessageId()`,
 * `triggerSlash('/send ...' | '/setinput ...')`, `replaceVariables`, `_` (lodash), `toastr`,
 * `window.z` (Zod v4), `window.Mvu`, `registerMvuSchema`, and `waitGlobalInitialized`.
 */
export function buildSandboxedSrcDoc(rawHtml: string, opts: SandboxShimOptions): string {
  const chatMessages = opts.liteProseMode
    ? []
    : (opts.storyTurns ?? []).map((t) => ({
        message_id: t.index,
        name: opts.charName,
        role: 'assistant',
        is_user: false,
        is_hidden: false,
        message: t.narrative,
        data: { stat_data: opts.statData },
      }));

  const currentId =
    typeof opts.currentMessageId === 'number'
      ? opts.currentMessageId
      : chatMessages.length > 0
        ? chatMessages[chatMessages.length - 1].message_id
        : 0;

  const allGreetings = opts.liteProseMode
    ? []
    : Array.isArray(opts.greetings) && opts.greetings.length > 0
      ? opts.greetings
      : typeof opts.currentNarrative === 'string' && currentId === 0
        ? [opts.currentNarrative]
        : [];
  const activeGreetingIdx =
    typeof opts.activeGreetingIndex === 'number'
      ? Math.max(0, Math.min(Math.max(0, allGreetings.length - 1), opts.activeGreetingIndex))
      : 0;

  // Ensure message #0 (opening) always exists with swipes[] & swipe_id for multi-greeting cards
  if (allGreetings.length > 0) {
    const existingZero = chatMessages.findIndex((m) => m.message_id === 0);
    const zeroObj = {
      message_id: 0,
      name: opts.charName,
      role: 'assistant',
      is_user: false,
      is_hidden: false,
      message: allGreetings[activeGreetingIdx] ?? allGreetings[0] ?? '',
      swipe_id: activeGreetingIdx,
      swipes: allGreetings,
      data: { stat_data: opts.statData },
    };
    if (existingZero >= 0) {
      chatMessages[existingZero] = zeroObj;
    } else {
      chatMessages.unshift(zeroObj);
    }
  }

  // Ensure the current floor message is always present in CHAT with its raw narrative
  if (typeof opts.currentNarrative === 'string' && currentId !== 0) {
    const existingIdx = chatMessages.findIndex((m) => m.message_id === currentId);
    const currentObj = {
      message_id: currentId,
      name: opts.charName,
      role: 'assistant',
      is_user: false,
      is_hidden: false,
      message: opts.currentNarrative,
      data: { stat_data: opts.statData },
    };
    if (existingIdx >= 0) {
      chatMessages[existingIdx] = currentObj;
    } else {
      chatMessages.push(currentObj);
      chatMessages.sort((a, b) => a.message_id - b.message_id);
    }
  }

  const bridgeScript = `<script>
(function(){
  const WID = ${safeJsonForInlineScript(opts.widgetId)};
  let STAT = ${safeJsonForInlineScript(opts.statData ?? {})};
  const CHAR = ${safeJsonForInlineScript(opts.charName || 'Character')};
  const USER = ${safeJsonForInlineScript(opts.userName || 'User')};
  const CHAT = ${safeJsonForInlineScript(chatMessages)};
  const CURRENT_ID = ${safeJsonForInlineScript(currentId)};
  const EXT = ${safeJsonForInlineScript(opts.customExtensions ?? {})};
  const LISTENERS = new Map();

  function cloneDeep(v){
    try { return JSON.parse(JSON.stringify(v)); } catch(e){ return v; }
  }
  function getByPath(obj, path, def){
    if (obj == null || !path) return obj === undefined ? def : obj;
    const parts = Array.isArray(path) ? path : String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length; i++){
      if (cur == null || typeof cur !== 'object') return def;
      cur = cur[parts[i]];
    }
    return cur === undefined ? def : cur;
  }
  function setByPath(obj, path, val){
    if (obj == null || !path) return obj;
    const parts = Array.isArray(path) ? path : String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++){
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    if (parts.length > 0) cur[parts[parts.length - 1]] = val;
    return obj;
  }
  function mergeDeep(target){
    for (let i = 1; i < arguments.length; i++){
      const src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      Object.keys(src).forEach(function(k){
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
          mergeDeep(target[k], src[k]);
        } else {
          target[k] = cloneDeep(src[k]);
        }
      });
    }
    return target;
  }

  function unsetByPath(obj, path){
    if (obj == null || !path) return false;
    const parts = Array.isArray(path) ? path : String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++){
      if (cur == null || typeof cur !== 'object') return false;
      cur = cur[parts[i]];
    }
    if (cur == null || typeof cur !== 'object' || parts.length === 0) return false;
    const last = parts[parts.length - 1];
    if (Array.isArray(cur)) {
      const idx = Number(last);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return false;
      cur.splice(idx, 1);
      return true;
    }
    if (last in cur) { delete cur[last]; return true; }
    return false;
  }

  // Expose authentic full Lodash & Zod v4 from parent MCP App bundle (zero external CDN dependency)
  try {
    if (!window._ && window.parent && window.parent.__TAVERN_LODASH__) {
      window._ = window.parent.__TAVERN_LODASH__;
    }
    if (!window.z && window.parent && window.parent.__TAVERN_ZOD4__) {
      window.z = window.parent.__TAVERN_ZOD4__;
    }
  } catch(e){}

  if (!window._) {
    window._ = {
      get: getByPath,
      set: setByPath,
      unset: unsetByPath,
      add: function(a, b){ return (Number(a) || 0) + (Number(b) || 0); },
      has: function(o, p){ return getByPath(o, p, Symbol.for('__missing__')) !== Symbol.for('__missing__'); },
      cloneDeep: cloneDeep,
      merge: mergeDeep,
      assign: Object.assign,
      isEmpty: function(v){ return v == null || (Array.isArray(v) || typeof v === 'string' ? v.length === 0 : typeof v === 'object' ? Object.keys(v).length === 0 : false); },
      isObject: function(v){ return v !== null && typeof v === 'object'; },
      isArray: Array.isArray,
      isString: function(v){ return typeof v === 'string'; },
      isNumber: function(v){ return typeof v === 'number' && !Number.isNaN(v); },
      clamp: function(n, min, max){ return Math.min(Math.max(n, min), max); },
      debounce: function(fn, wait){ let t; return function(){ const a = arguments, c = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(c, a); }, wait || 100); }; },
      throttle: function(fn, wait){ let last = 0; return function(){ const now = Date.now(); if (now - last >= (wait || 100)) { last = now; return fn.apply(this, arguments); } }; },
    };
  }

  if (!window.toastr) {
    const showToast = function(msg){
      try { window.parent.postMessage({ widgetId: WID, type: 'tavern:toast', text: String(msg || '') }, '*'); } catch(e){}
    };
    window.toastr = { info: showToast, success: showToast, warning: showToast, error: showToast };
  }

  function eventEmit(evt){
    const args = Array.prototype.slice.call(arguments, 1);
    const list = LISTENERS.get(evt) || [];
    for (let i = 0; i < list.length; i++){
      try { list[i].apply(null, args); } catch(e){}
    }
  }
  function eventOn(evt, fn){
    if (typeof fn !== 'function') return;
    const list = LISTENERS.get(evt) || [];
    list.push(fn);
    LISTENERS.set(evt, list);
  }
  function eventOnce(evt, fn){
    if (typeof fn !== 'function') return;
    const wrapper = function(){
      eventRemoveListener(evt, wrapper);
      return fn.apply(null, arguments);
    };
    eventOn(evt, wrapper);
  }
  function eventRemoveListener(evt, fn){
    const list = LISTENERS.get(evt) || [];
    LISTENERS.set(evt, list.filter(function(x){ return x !== fn; }));
  }

  function getVariables(){
    const snap = cloneDeep(STAT);
    return Object.assign({ stat_data: snap }, snap);
  }
  function getAllVariables(){
    return getVariables();
  }
  function pushStatUpdate(nextStat){
    const cleaned = cloneDeep(nextStat || {});
    if (cleaned && typeof cleaned === 'object' && Object.prototype.hasOwnProperty.call(cleaned, 'stat_data')) {
      delete cleaned.stat_data;
    }
    STAT = cleaned;
    try {
      window.parent.postMessage({ widgetId: WID, type: 'tavern:updateStat', statData: STAT }, '*');
    } catch(e){}
    eventEmit('VARIABLES_UPDATED', STAT);
    eventEmit('mvu_variable_update_ended', STAT);
  }
  function replaceVariables(next){
    const unwrapped = (next && typeof next === 'object' && next.stat_data && typeof next.stat_data === 'object') ? next.stat_data : next;
    pushStatUpdate(unwrapped || {});
    return getVariables();
  }
  function insertOrAssignVariables(patch){
    const raw = (patch && typeof patch === 'object' && patch.stat_data && typeof patch.stat_data === 'object') ? patch.stat_data : (patch || {});
    const merged = mergeDeep(cloneDeep(STAT), raw);
    pushStatUpdate(merged);
    return getVariables();
  }
  function updateVariablesWith(updater){
    const prevSnap = cloneDeep(STAT);
    const prevJson = JSON.stringify(prevSnap);
    const draft = Object.assign({ stat_data: cloneDeep(prevSnap) }, cloneDeep(prevSnap));
    try {
      const res = typeof updater === 'function' ? updater(draft) : draft;
      const target = (res && typeof res === 'object') ? res : draft;
      const topClone = cloneDeep(target);
      const sd = (target.stat_data && typeof target.stat_data === 'object') ? cloneDeep(target.stat_data) : null;
      delete topClone.stat_data;
      // Prefer explicit stat_data edits when stat_data changed; otherwise honor top-level edits on draft
      const sdChanged = sd !== null && JSON.stringify(sd) !== prevJson;
      const nextStat = sdChanged ? sd : topClone;
      pushStatUpdate(nextStat);
      return getVariables();
    } catch(e){
      return getVariables();
    }
  }

  function getCurrentMessageId(){
    return CURRENT_ID;
  }
  function getLastMessageId(){
    return CHAT.length > 0 ? CHAT[CHAT.length - 1].message_id : CURRENT_ID;
  }
  function getChatMessages(range){
    if (range === undefined || range === null || range === '') {
      return CHAT;
    }
    const raw = String(range).trim();
    if (raw === '-1' || raw === '{{lastMessageId}}') {
      return CHAT.length > 0 ? [CHAT[CHAT.length - 1]] : [];
    }
    if (raw === '{{currentMessageId}}') {
      const cur = CHAT.find(function(m){ return m.message_id === CURRENT_ID; });
      return cur ? [cur] : (CHAT.length > 0 ? [CHAT[CHAT.length - 1]] : []);
    }
    const rangeMatch = raw.match(/^(-?\\d+)\\s*-\\s*(-?\\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      return CHAT.filter(function(m){ return m.message_id >= start && m.message_id <= end; });
    }
    const num = Number(raw);
    if (!Number.isNaN(num)) {
      if (num < 0) {
        const idx = CHAT.length + num;
        return idx >= 0 && idx < CHAT.length ? [CHAT[idx]] : [];
      }
      const found = CHAT.find(function(m){ return m.message_id === num; });
      return found ? [found] : [];
    }
    return CHAT;
  }

  function setChatMessages(messages){
    if (Array.isArray(messages)) {
      for (let i = 0; i < messages.length; i++){
        const item = messages[i];
        if (!item || typeof item !== 'object') continue;
        if (item.message_id === 0 && typeof item.swipe_id === 'number') {
          try {
            window.parent.postMessage({ widgetId: WID, type: 'tavern:selectGreeting', index: item.swipe_id }, '*');
          } catch(e){}
        }
        if (item.data && typeof item.data === 'object' && item.data.stat_data && typeof item.data.stat_data === 'object') {
          replaceVariables(item.data.stat_data);
        }
      }
    }
    return Promise.resolve();
  }

  function triggerSlash(cmd){
    try {
      window.parent.postMessage({ widgetId: WID, type: 'tavern:slash', cmd: String(cmd || '') }, '*');
    } catch(e){}
    return Promise.resolve('');
  }
  function formatAsTavernRegexedString(str){
    return String(str || '');
  }

  const TavernHelper = {
    getVariables,
    getAllVariables,
    replaceVariables,
    insertOrAssignVariables,
    updateVariablesWith,
    getChatMessages,
    setChatMessages,
    getCurrentMessageId,
    getLastMessageId,
    triggerSlash,
    eventOn,
    eventOnce,
    eventEmit,
    eventRemoveListener,
    formatAsTavernRegexedString,
  };
  const SillyTavern = {
    getContext: function(){
      return {
        name1: USER,
        name2: CHAR,
        characterId: 0,
        groupId: null,
        chatId: 'default',
        onlineStatus: 'connected',
        getCurrentChatId: function(){ return 'default'; },
        characters: [{ name: CHAR, data: { name: CHAR, extensions: EXT } }],
        chat: CHAT,
        chatMetadata: { variables: getVariables() },
      };
    },
  };

  const REGISTERED_SCHEMAS = [];
  function runRegisteredSchemas(inputStat, emitUpdateIfChanged){
    if (REGISTERED_SCHEMAS.length === 0 || !inputStat || typeof inputStat !== 'object') return inputStat;
    let current = cloneDeep(inputStat);
    const beforeJson = JSON.stringify(current);
    for (let i = 0; i < REGISTERED_SCHEMAS.length; i++){
      const schema = REGISTERED_SCHEMAS[i];
      if (!schema || typeof schema.safeParse !== 'function') continue;
      try {
        const res = schema.safeParse(current);
        if (res && res.success && res.data && typeof res.data === 'object') {
          current = res.data;
        }
      } catch(e){
        console.error('[MVU Zod schema]', e);
      }
    }
    const afterJson = JSON.stringify(current);
    if (afterJson !== beforeJson) {
      STAT = cloneDeep(current);
      if (emitUpdateIfChanged) {
        try {
          window.parent.postMessage({ widgetId: WID, type: 'tavern:updateStat', statData: STAT }, '*');
        } catch(e){}
      }
    }
    return current;
  }

  const MVU_EVENTS = {
    BEFORE_MESSAGE_UPDATE: 'mvu_before_message_update',
    COMMAND_PARSED: 'mvu_command_parsed',
    VARIABLE_INITIALIZED: 'mvu_variable_initialized',
    VARIABLE_UPDATE_STARTED: 'mvu_variable_update_started',
    SINGLE_VARIABLE_UPDATED: 'mvu_single_variable_updated',
    VARIABLE_UPDATE_ENDED: 'mvu_variable_update_ended',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
  };

  function makeMvuSnapshot(statObj){
    const s = cloneDeep(statObj || {});
    return {
      stat_data: s,
      display_data: cloneDeep(s),
      delta_data: {},
      initialized_lorebooks: {},
    };
  }

  function emitMvuEvent(evtName, detailObj){
    const extra = Array.prototype.slice.call(arguments, 1);
    eventEmit.apply(null, [evtName].concat(extra));
    try {
      if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
        document.dispatchEvent(new CustomEvent(evtName, { detail: detailObj }));
      }
    } catch(e){}
  }

  let mvuInitEmitted = false;
  function registerMvuSchema(schemaOrFactory){
    let schema = schemaOrFactory;
    if (typeof schemaOrFactory === 'function') {
      try { schema = schemaOrFactory(); } catch(e){ console.error('[MVU Zod schema factory]', e); return false; }
    }
    if (!schema || typeof schema.safeParse !== 'function') return false;
    REGISTERED_SCHEMAS.push(schema);
    try {
      window.parent.postMessage({ widgetId: WID, type: 'tavern:schemaRegistered', count: REGISTERED_SCHEMAS.length }, '*');
    } catch(e){}
    if (STAT && Object.keys(STAT).length > 0) {
      runRegisteredSchemas(STAT, true);
      if (!mvuInitEmitted) {
        mvuInitEmitted = true;
        emitMvuEvent(MVU_EVENTS.VARIABLE_INITIALIZED, makeMvuSnapshot(STAT), CURRENT_ID);
      }
    }
    return true;
  }

  const Mvu = {
    events: MVU_EVENTS,
    registerMvuSchema: registerMvuSchema,
    getMvuData: function(){
      return makeMvuSnapshot(STAT);
    },
    replaceMvuData: function(next){
      const prevSnap = makeMvuSnapshot(STAT);
      const unwrapped = (next && typeof next === 'object' && next.stat_data && typeof next.stat_data === 'object') ? next.stat_data : next;
      const derived = runRegisteredSchemas(unwrapped || {}, false);
      pushStatUpdate(derived);
      const nextSnap = makeMvuSnapshot(STAT);
      emitMvuEvent(MVU_EVENTS.VARIABLE_UPDATE_ENDED, nextSnap, prevSnap);
      return nextSnap;
    },
    setMvuVariable: function(mvuData, path, value){
      const target = (mvuData && typeof mvuData === 'object' && mvuData.stat_data) ? mvuData.stat_data : mvuData;
      if (target && typeof target === 'object') setByPath(target, path, value);
      return mvuData;
    },
    getRecordFromMvuData: function(mvuData, path){
      const target = (mvuData && typeof mvuData === 'object' && mvuData.stat_data) ? mvuData.stat_data : mvuData;
      return getByPath(target, path);
    },
  };

  function waitGlobalInitialized(name){
    if (name && window[name] !== undefined) return Promise.resolve(window[name]);
    return Promise.resolve(true);
  }

  function errorCatched(fn){
    if (typeof fn !== 'function') return fn;
    return function(){
      try {
        const res = fn.apply(this, arguments);
        if (res && typeof res.catch === 'function') {
          return res.catch(function(err){ console.error('[Sandbox errorCatched]', err); });
        }
        return res;
      } catch (err) {
        console.error('[Sandbox errorCatched]', err);
      }
    };
  }

  // Lightweight jQuery-compatible shim for SillyTavern status bars & cards
  function createJQueryShim(){
    function toEls(sel, root){
      if (!sel) return [];
      if (sel._isJq) return sel._els.slice();
      if (sel instanceof Element || sel === window || sel === document) return [sel];
      if (Array.isArray(sel) || sel instanceof NodeList || sel instanceof HTMLCollection) return Array.from(sel);
      if (typeof sel === 'string') {
        const s = sel.trim();
        if (s.startsWith('<')) {
          const tpl = document.createElement('template');
          tpl.innerHTML = s;
          return Array.from(tpl.content.children);
        }
        try { return Array.from((root || document).querySelectorAll(s)); } catch { return []; }
      }
      return [];
    }
    function camelToKebab(k){ return String(k).replace(/[A-Z]/g, function(m){ return '-' + m.toLowerCase(); }); }
    function wrap(els){
      const arr = Array.isArray(els) ? els.filter(Boolean) : [];
      const obj = {
        _isJq: true,
        _els: arr,
        length: arr.length,
        get: function(i){ return i === undefined ? arr.slice() : arr[i < 0 ? arr.length + i : i]; },
        eq: function(i){ const idx = i < 0 ? arr.length + i : i; return wrap(arr[idx] ? [arr[idx]] : []); },
        first: function(){ return wrap(arr.length ? [arr[0]] : []); },
        last: function(){ return wrap(arr.length ? [arr[arr.length - 1]] : []); },
        each: function(fn){ for (let i = 0; i < arr.length; i++){ if (fn.call(arr[i], i, arr[i]) === false) break; } return obj; },
        map: function(fn){ return wrap(arr.map(function(el, i){ return fn.call(el, i, el); }).filter(function(x){ return x !== null && x !== undefined; })); },
        find: function(sel){
          const out = [];
          for (const el of arr) { if (el && el.querySelectorAll) out.push(...Array.from(el.querySelectorAll(sel))); }
          return wrap(Array.from(new Set(out)));
        },
        children: function(sel){
          const out = [];
          for (const el of arr) {
            for (const c of Array.from((el && el.children) || [])) {
              if (!sel || (c.matches && c.matches(sel))) out.push(c);
            }
          }
          return wrap(out);
        },
        parent: function(sel){
          const out = [];
          for (const el of arr) {
            const p = el && el.parentElement;
            if (p && (!sel || (p.matches && p.matches(sel)))) out.push(p);
          }
          return wrap(Array.from(new Set(out)));
        },
        closest: function(sel){
          const out = [];
          for (const el of arr) {
            const c = el && el.closest ? el.closest(sel) : null;
            if (c) out.push(c);
          }
          return wrap(Array.from(new Set(out)));
        },
        siblings: function(sel){
          const out = [];
          for (const el of arr) {
            const p = el && el.parentElement;
            if (!p) continue;
            for (const c of Array.from(p.children)) {
              if (c !== el && (!sel || (c.matches && c.matches(sel)))) out.push(c);
            }
          }
          return wrap(Array.from(new Set(out)));
        },
        text: function(val){
          if (val === undefined) return arr.map(function(el){ return el.textContent || ''; }).join('');
          for (const el of arr) el.textContent = String(val);
          return obj;
        },
        html: function(val){
          if (val === undefined) return arr[0] ? arr[0].innerHTML : '';
          for (const el of arr) el.innerHTML = String(val);
          return obj;
        },
        val: function(val){
          if (val === undefined) return arr[0] ? arr[0].value : undefined;
          for (const el of arr) el.value = val;
          return obj;
        },
        attr: function(name, val){
          if (typeof name === 'object' && name) {
            for (const [k, v] of Object.entries(name)) obj.attr(k, v);
            return obj;
          }
          if (val === undefined) return arr[0] && arr[0].getAttribute ? arr[0].getAttribute(name) : undefined;
          for (const el of arr) { if (el.setAttribute) el.setAttribute(name, String(val)); }
          return obj;
        },
        removeAttr: function(name){ for (const el of arr){ if (el.removeAttribute) el.removeAttribute(name); } return obj; },
        prop: function(name, val){
          if (val === undefined) return arr[0] ? arr[0][name] : undefined;
          for (const el of arr) el[name] = val;
          return obj;
        },
        data: function(key, val){
          if (key === undefined) return arr[0] && arr[0].dataset ? Object.assign({}, arr[0].dataset) : {};
          const attrName = 'data-' + camelToKebab(key);
          if (val === undefined) {
            const el = arr[0];
            if (!el) return undefined;
            if (el._jqData && key in el._jqData) return el._jqData[key];
            const raw = el.getAttribute ? el.getAttribute(attrName) : null;
            if (raw === null) return undefined;
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
            return raw;
          }
          for (const el of arr) {
            if (!el._jqData) el._jqData = {};
            el._jqData[key] = val;
            if (typeof val !== 'object' && el.setAttribute) el.setAttribute(attrName, String(val));
          }
          return obj;
        },
        css: function(prop, val){
          if (typeof prop === 'object' && prop) {
            for (const [k, v] of Object.entries(prop)) obj.css(k, v);
            return obj;
          }
          if (val === undefined) return arr[0] ? window.getComputedStyle(arr[0]).getPropertyValue(camelToKebab(prop)) : '';
          for (const el of arr) { if (el.style) el.style[prop] = String(val); }
          return obj;
        },
        addClass: function(cls){
          const parts = String(cls || '').trim().split(/\s+/).filter(Boolean);
          for (const el of arr) { if (el.classList) parts.forEach(function(c){ el.classList.add(c); }); }
          return obj;
        },
        removeClass: function(cls){
          const parts = String(cls || '').trim().split(/\s+/).filter(Boolean);
          for (const el of arr) {
            if (!el.classList) continue;
            if (parts.length === 0) el.className = '';
            else parts.forEach(function(c){ el.classList.remove(c); });
          }
          return obj;
        },
        toggleClass: function(cls, force){
          const parts = String(cls || '').trim().split(/\s+/).filter(Boolean);
          for (const el of arr) {
            if (!el.classList) continue;
            parts.forEach(function(c){ force === undefined ? el.classList.toggle(c) : el.classList.toggle(c, Boolean(force)); });
          }
          return obj;
        },
        hasClass: function(cls){ return arr.some(function(el){ return el.classList && el.classList.contains(cls); }); },
        on: function(evts, selOrFn, maybeFn){
          const delegate = typeof selOrFn === 'string' ? selOrFn : null;
          const handler = delegate ? maybeFn : selOrFn;
          if (typeof handler !== 'function') return obj;
          const names = String(evts || '').trim().split(/\s+/).filter(Boolean);
          for (const el of arr) {
            if (!el.addEventListener) continue;
            if (!el._jqListeners) el._jqListeners = [];
            for (const rawName of names) {
              const evtName = rawName.split('.')[0];
              const listener = delegate
                ? function(e){
                    const matched = e.target && e.target.closest ? e.target.closest(delegate) : null;
                    if (matched && el.contains(matched)) handler.call(matched, e);
                  }
                : function(e){ handler.call(el, e); };
              el.addEventListener(evtName, listener);
              el._jqListeners.push({ rawName, evtName, handler, listener });
            }
          }
          return obj;
        },
        off: function(evts, handler){
          const names = evts ? String(evts).trim().split(/\s+/).filter(Boolean) : null;
          for (const el of arr) {
            if (!el._jqListeners) continue;
            el._jqListeners = el._jqListeners.filter(function(item){
              const nameMatch = !names || names.some(function(n){ return n === item.rawName || n === item.evtName; });
              const fnMatch = !handler || item.handler === handler;
              if (nameMatch && fnMatch) {
                el.removeEventListener(item.evtName, item.listener);
                return false;
              }
              return true;
            });
          }
          return obj;
        },
        one: function(evts, fn){
          if (typeof fn !== 'function') return obj;
          const wrapped = function(e){ obj.off(evts, wrapped); return fn.call(this, e); };
          return obj.on(evts, wrapped);
        },
        click: function(fn){ return typeof fn === 'function' ? obj.on('click', fn) : obj.trigger('click'); },
        trigger: function(evtName){
          for (const el of arr) { if (el.dispatchEvent) el.dispatchEvent(new Event(evtName, { bubbles: true })); }
          return obj;
        },
        empty: function(){ for (const el of arr) el.innerHTML = ''; return obj; },
        append: function(content){
          for (const el of arr) {
            if (typeof content === 'string') el.insertAdjacentHTML('beforeend', content);
            else for (const child of toEls(content)) el.appendChild(child);
          }
          return obj;
        },
        prepend: function(content){
          for (const el of arr) {
            if (typeof content === 'string') el.insertAdjacentHTML('afterbegin', content);
            else for (const child of toEls(content).reverse()) el.insertBefore(child, el.firstChild);
          }
          return obj;
        },
        remove: function(){ for (const el of arr){ if (el.parentNode) el.parentNode.removeChild(el); } return obj; },
        show: function(){ for (const el of arr){ if (el.style) el.style.display = ''; } return obj; },
        hide: function(){ for (const el of arr){ if (el.style) el.style.display = 'none'; } return obj; },
        toggle: function(force){
          for (const el of arr) {
            if (!el.style) continue;
            const hidden = force !== undefined ? !force : window.getComputedStyle(el).display === 'none';
            el.style.display = hidden ? '' : 'none';
          }
          return obj;
        },
        is: function(sel){ return arr.some(function(el){ return el.matches && el.matches(sel); }); },
      };
      for (let i = 0; i < arr.length; i++) obj[i] = arr[i];
      return obj;
    }
    function jQ(sel, ctx){
      if (typeof sel === 'function') {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function(){ sel(jQ); }, { once: true });
        } else {
          sel(jQ);
        }
        return wrap([document]);
      }
      return wrap(toEls(sel, ctx));
    }
    jQ.fn = {};
    jQ.extend = Object.assign;
    return jQ;
  }

  const jQueryShim = typeof window.jQuery === 'function' ? window.jQuery : createJQueryShim();

  // Safe in-memory localStorage fallback inside opaque-origin sandbox="allow-scripts" iframes
  try {
    window.localStorage.getItem('__tavern_ls_probe__');
  } catch {
    const memStore = new Map();
    const fakeStorage = {
      getItem: function(k){ return memStore.has(String(k)) ? memStore.get(String(k)) : null; },
      setItem: function(k, v){ memStore.set(String(k), String(v)); },
      removeItem: function(k){ memStore.delete(String(k)); },
      clear: function(){ memStore.clear(); },
      key: function(i){ return Array.from(memStore.keys())[i] ?? null; },
      get length(){ return memStore.size; },
    };
    try { Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true }); } catch {}
  }

  const tavern_events = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED',
    GENERATION_ENDED: 'GENERATION_ENDED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
  };

  window.triggerSlash = triggerSlash;
  window.getVariables = getVariables;
  window.getAllVariables = getAllVariables;
  window.replaceVariables = replaceVariables;
  window.insertOrAssignVariables = insertOrAssignVariables;
  window.updateVariablesWith = updateVariablesWith;
  window.getChatMessages = getChatMessages;
  window.setChatMessages = setChatMessages;
  window.getCurrentMessageId = getCurrentMessageId;
  window.getLastMessageId = getLastMessageId;
  window.eventOn = eventOn;
  window.eventOnce = eventOnce;
  window.eventEmit = eventEmit;
  window.eventRemoveListener = eventRemoveListener;
  window.TavernHelper = TavernHelper;
  window.SillyTavern = SillyTavern;
  window.Mvu = Mvu;
  window.registerMvuSchema = registerMvuSchema;
  window.waitGlobalInitialized = waitGlobalInitialized;
  window.errorCatched = errorCatched;
  window.tavern_events = tavern_events;
  window.jQuery = jQueryShim;
  window.$ = jQueryShim;

  window.addEventListener('message', function(evt){
    const msg = evt && evt.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'tavern:statSync' && msg.statData && typeof msg.statData === 'object') {
      const prevSnap = makeMvuSnapshot(STAT);
      STAT = cloneDeep(msg.statData);
      const incomingSnap = makeMvuSnapshot(STAT);
      if (!mvuInitEmitted && Object.keys(STAT).length > 0) {
        mvuInitEmitted = true;
        runRegisteredSchemas(STAT, true);
        emitMvuEvent(MVU_EVENTS.VARIABLE_INITIALIZED, makeMvuSnapshot(STAT), CURRENT_ID);
      } else {
        emitMvuEvent(MVU_EVENTS.VARIABLE_UPDATE_STARTED, prevSnap, incomingSnap);
        emitMvuEvent(MVU_EVENTS.BEFORE_MESSAGE_UPDATE, { variables: incomingSnap, message_id: CURRENT_ID });
        runRegisteredSchemas(STAT, true);
        const finalSnap = makeMvuSnapshot(STAT);
        emitMvuEvent(MVU_EVENTS.VARIABLE_UPDATE_ENDED, finalSnap, prevSnap);
      }
      eventEmit('VARIABLES_UPDATED', STAT);
      eventEmit('MESSAGE_RECEIVED', STAT);
      postH();
    }
  });

  let lastSentH = -1;
  function measureContentHeight(){
    const body = document.body;
    if (!body) return 0;
    const cs = window.getComputedStyle(body);
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const vh = window.innerHeight || 0;
    let maxBottom = 0;
    for (let i = 0; i < body.children.length; i++){
      const el = body.children[i];
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
      const ecs = window.getComputedStyle(el);
      // Skip fixed overlays so they never cause viewport-height growth feedback loops
      if (ecs.position === 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 || rect.width > 0) {
        // Avoid feedback loop when an element stretches to 100vh of the iframe viewport
        if (vh > 0 && Math.abs(rect.height - vh) <= 2 && /100vh|100dvh/i.test(el.getAttribute('style') || '')) {
          continue;
        }
        const mb = parseFloat(ecs.marginBottom) || 0;
        maxBottom = Math.max(maxBottom, rect.bottom + scrollY + mb);
      }
    }
    if (maxBottom > 0) return Math.ceil(maxBottom + padBottom);
    return Math.ceil(body.offsetHeight || 0);
  }
  function postH(){
    try {
      const h = measureContentHeight();
      if (h > 0 && h !== lastSentH) {
        lastSentH = h;
        window.parent.postMessage({ widgetId: WID, type: 'tavern:resize', height: h }, '*');
      }
    } catch(e){}
  }
  function schedulePostH(){
    postH();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(postH);
    setTimeout(postH, 80);
    setTimeout(postH, 240);
    setTimeout(postH, 450);
  }
  window.addEventListener('load', schedulePostH);
  document.addEventListener('click', schedulePostH, true);
  document.addEventListener('transitionend', postH, true);
  window.addEventListener('DOMContentLoaded', function(){
    if (document.body) {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(postH);
        ro.observe(document.body);
        for (let i = 0; i < document.body.children.length; i++){
          const el = document.body.children[i];
          if (el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') ro.observe(el);
        }
      }
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(schedulePostH).observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-expanded'],
        });
      }
    }
    schedulePostH();
  });
})();
</script>`;

  const baseStyle = `<meta name="referrer" content="no-referrer" /><style>
html,body{margin:0;padding:4px;height:auto!important;min-height:0!important;background:transparent;color:#e5d9c3;font-family:"Noto Serif SC","Source Han Serif SC",system-ui,sans-serif;box-sizing:border-box;}
*,*::before,*::after{box-sizing:inherit;}
</style>`;

  if (/<head\b[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head\b[^>]*>/i, (m) => `${m}${baseStyle}${bridgeScript}`);
  }
  if (/<html\b[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<html\b[^>]*>/i, (m) => `${m}<head><meta charset="utf-8" />${baseStyle}${bridgeScript}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8" />${baseStyle}${bridgeScript}</head><body>${rawHtml}</body></html>`;
}
