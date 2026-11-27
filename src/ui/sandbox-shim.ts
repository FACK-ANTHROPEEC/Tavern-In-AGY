export interface SandboxShimOptions {
  widgetId: string;
  charName: string;
  userName: string;
  statData: Record<string, unknown>;
  /** Current floor message_id (e.g. 0 for opening, 1..N for turns) */
  currentMessageId?: number;
  /** Raw narrative of the current floor so preset widgets reading current message get original tags */
  currentNarrative?: string;
  storyTurns?: Array<{ index: number; userMessage?: string; narrative: string }>;
  customExtensions?: Record<string, unknown>;
}

export interface ParsedSlashAction {
  action: 'send' | 'setInput';
  text: string;
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
 * Builds a self-contained HTML `srcDoc` with a rich, CSP-safe runtime shim supporting
 * `getCurrentMessageId()`, range-aware `getChatMessages(range)`, `getLastMessageId()`,
 * `triggerSlash('/send ...' | '/setinput ...')`, `replaceVariables`, `_` (lodash), and `toastr`.
 */
export function buildSandboxedSrcDoc(rawHtml: string, opts: SandboxShimOptions): string {
  const chatMessages = (opts.storyTurns ?? []).map((t) => ({
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

  // Ensure the current floor message is always present in CHAT with its raw narrative
  if (typeof opts.currentNarrative === 'string') {
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
  const WID = ${JSON.stringify(opts.widgetId)};
  let STAT = ${JSON.stringify(opts.statData ?? {})};
  const CHAR = ${JSON.stringify(opts.charName || 'Character')};
  const USER = ${JSON.stringify(opts.userName || 'User')};
  const CHAT = ${JSON.stringify(chatMessages)};
  const CURRENT_ID = ${JSON.stringify(currentId)};
  const EXT = ${JSON.stringify(opts.customExtensions ?? {})};
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

  if (!window._) {
    window._ = {
      get: getByPath,
      set: setByPath,
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
    return Object.assign({ stat_data: STAT }, STAT);
  }
  function pushStatUpdate(nextStat){
    STAT = cloneDeep(nextStat || {});
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
    const merged = mergeDeep(cloneDeep(STAT), patch || {});
    pushStatUpdate(merged);
    return getVariables();
  }
  function updateVariablesWith(updater){
    const draft = getVariables();
    try {
      const res = typeof updater === 'function' ? updater(draft) : draft;
      return replaceVariables(res || draft);
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
    replaceVariables,
    insertOrAssignVariables,
    updateVariablesWith,
    getChatMessages,
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

  window.triggerSlash = triggerSlash;
  window.getVariables = getVariables;
  window.replaceVariables = replaceVariables;
  window.insertOrAssignVariables = insertOrAssignVariables;
  window.updateVariablesWith = updateVariablesWith;
  window.getChatMessages = getChatMessages;
  window.getCurrentMessageId = getCurrentMessageId;
  window.getLastMessageId = getLastMessageId;
  window.eventOn = eventOn;
  window.eventOnce = eventOnce;
  window.eventEmit = eventEmit;
  window.eventRemoveListener = eventRemoveListener;
  window.TavernHelper = TavernHelper;
  window.SillyTavern = SillyTavern;

  window.addEventListener('message', function(evt){
    const msg = evt && evt.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'tavern:statSync' && msg.statData && typeof msg.statData === 'object') {
      STAT = cloneDeep(msg.statData);
      eventEmit('VARIABLES_UPDATED', STAT);
      eventEmit('mvu_variable_update_ended', STAT);
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
    let maxBottom = 0;
    for (let i = 0; i < body.children.length; i++){
      const el = body.children[i];
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 || rect.width > 0) {
        const ecs = window.getComputedStyle(el);
        const mb = parseFloat(ecs.marginBottom) || 0;
        maxBottom = Math.max(maxBottom, rect.bottom + mb);
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

  const baseStyle = `<style>
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
