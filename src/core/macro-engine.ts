import { getByDotPath, stripHiddenDollarKeys } from './mvu-engine.js';

export interface MacroContext {
  char: string;
  user: string;
  persona?: string;
  scenario?: string;
  vars: Record<string, string>;
  globalVars?: Record<string, string>;
  statData?: Record<string, unknown>;
  lastUserMessage?: string;
  lastCharMessage?: string;
  lastMessage?: string;
  lastMessageId?: number;
  original?: string;
  now?: Date;
  rng?: () => number;
}

const TRIM_SENTINEL = '\u0000__TAVERN_TRIM__\u0000';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function evalDiceExpression(rawExpr: string, rng: () => number): string {
  // Supports `1d999999`, `d20`, `2d6+3`, `1d100-5`
  const cleaned = rawExpr.replace(/\s+/g, '').toLowerCase();
  const m = cleaned.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) return rawExpr;
  const count = Math.min(100, Math.max(1, m[1] ? Number(m[1]) : 1));
  const sides = Math.max(1, Number(m[2]));
  const modifier = m[3] ? Number(m[3]) : 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += Math.floor(rng() * sides) + 1;
  }
  return String(total + modifier);
}

/**
 * O(N) stack-based innermost-first SillyTavern macro evaluator.
 * Supports multi-line values, nested macros, local/global vars, inc/dec/add,
 * random/pick/roll, scoped MVU variables, context macros, comments, and standard slots.
 */
export function evaluateMacros(input: string, ctx: MacroContext): string {
  if (!input || !input.includes('{{')) {
    return input;
  }

  const frames: string[] = [''];
  let i = 0;
  const len = input.length;

  while (i < len) {
    if (input.charCodeAt(i) === 123 && i + 1 < len && input.charCodeAt(i + 1) === 123) {
      // "{{"
      frames.push('');
      i += 2;
      continue;
    }

    if (
      input.charCodeAt(i) === 125 &&
      i + 1 < len &&
      input.charCodeAt(i + 1) === 125 &&
      frames.length > 1
    ) {
      // "}}"
      const rawExpr = frames.pop()!;
      const evaluated = evaluateMacroExpression(rawExpr, ctx);
      frames[frames.length - 1] += evaluated;
      i += 2;
      continue;
    }

    frames[frames.length - 1] += input[i];
    i += 1;
  }

  // Rejoin any unclosed "{{" literally
  let result = frames[0];
  for (let f = 1; f < frames.length; f++) {
    result += '{{' + frames[f];
  }

  if (result.includes(TRIM_SENTINEL)) {
    result = result.replace(new RegExp(`[ \\t\\r\\n]*${TRIM_SENTINEL}[ \\t\\r\\n]*`, 'g'), '');
  }

  return result;
}

function getVarStore(ctx: MacroContext, isGlobal: boolean): Record<string, string> {
  if (!isGlobal) return ctx.vars;
  if (!ctx.globalVars) ctx.globalVars = ctx.vars;
  return ctx.globalVars;
}

function evaluateMacroExpression(expr: string, ctx: MacroContext): string {
  const trimmed = expr.trim();

  // Comments: {{// ...}}
  if (trimmed.startsWith('//')) {
    return '';
  }

  // Trim directive
  const lower = trimmed.toLowerCase();
  if (lower === 'trim') {
    return TRIM_SENTINEL;
  }

  // Standard single-token macros (case-insensitive)
  if (lower === 'char' || lower === 'charifnotgroup') return ctx.char;
  if (lower === 'user') return ctx.user;
  if (lower === 'persona') return ctx.persona ?? '';
  if (lower === 'scenario') return ctx.scenario ?? '';
  if (lower === 'original') return ctx.original ?? '';
  if (lower === 'newline') return '\n';
  if (lower === 'lastusermessage') return ctx.lastUserMessage ?? '';
  if (lower === 'lastcharmessage') return ctx.lastCharMessage ?? '';
  if (lower === 'lastmessage') return ctx.lastMessage ?? ctx.lastCharMessage ?? ctx.lastUserMessage ?? '';
  if (lower === 'lastmessageid') return String(ctx.lastMessageId ?? 0);

  if (lower === 'time' || lower === 'isotime') {
    const d = ctx.now ?? new Date();
    return d.toTimeString().slice(0, 5);
  }
  if (lower === 'date' || lower === 'isodate') {
    const d = ctx.now ?? new Date();
    return d.toISOString().slice(0, 10);
  }
  if (lower === 'weekday') {
    const d = ctx.now ?? new Date();
    return WEEKDAYS[d.getDay()] ?? '';
  }

  // Space- or single-colon-delimited roll macro: {{roll 1d999999}} or {{roll:1d20}}
  const rollSpaceMatch = trimmed.match(/^roll(?:\s+|:(?!:))(.+)$/i);
  if (rollSpaceMatch) {
    return evalDiceExpression(rollSpaceMatch[1], ctx.rng ?? Math.random);
  }

  // Colon-delimited macros: {{op::arg1::arg2...}}
  const sepIdx = expr.indexOf('::');
  if (sepIdx !== -1) {
    const op = expr.slice(0, sepIdx).trim().toLowerCase();
    const rest = expr.slice(sepIdx + 2);

    if (op === 'roll') {
      return evalDiceExpression(rest, ctx.rng ?? Math.random);
    }

    if (op === 'setvar' || op === 'setglobalvar') {
      const store = getVarStore(ctx, op === 'setglobalvar');
      const valSep = rest.indexOf('::');
      if (valSep === -1) {
        store[rest.trim()] = '';
      } else {
        const key = rest.slice(0, valSep).trim();
        const value = rest.slice(valSep + 2);
        store[key] = value;
      }
      return '';
    }

    if (op === 'getvar' || op === 'getglobalvar') {
      const store = getVarStore(ctx, op === 'getglobalvar');
      const key = rest.trim();
      return store[key] ?? ctx.vars[key] ?? '';
    }

    if (op === 'incvar' || op === 'decvar' || op === 'incglobalvar' || op === 'decglobalvar') {
      const store = getVarStore(ctx, op.includes('global'));
      const key = rest.trim();
      const cur = Number(store[key] ?? 0);
      const delta = op.startsWith('inc') ? 1 : -1;
      const next = (Number.isNaN(cur) ? 0 : cur) + delta;
      store[key] = String(next);
      return String(next);
    }

    if (op === 'addvar' || op === 'addglobalvar') {
      const store = getVarStore(ctx, op === 'addglobalvar');
      const valSep = rest.indexOf('::');
      if (valSep !== -1) {
        const key = rest.slice(0, valSep).trim();
        const deltaRaw = rest.slice(valSep + 2);
        const curRaw = store[key] ?? '';
        const curNum = Number(curRaw);
        const deltaNum = Number(deltaRaw);
        if (curRaw !== '' && !Number.isNaN(curNum) && !Number.isNaN(deltaNum)) {
          store[key] = String(curNum + deltaNum);
        } else {
          store[key] = curRaw + deltaRaw;
        }
      }
      return '';
    }

    // JS-Slash-Runner scoped variable macros (strip `$` hidden keys automatically)
    if (
      op === 'get_message_variable' ||
      op === 'get_chat_variable' ||
      op === 'get_global_variable' ||
      op === 'get_character_variable' ||
      op === 'format_message_variable' ||
      op === 'format_chat_variable'
    ) {
      const key = rest.trim();
      let val: unknown;
      if (key === 'stat_data') {
        val = ctx.statData ?? {};
      } else if (key.startsWith('stat_data.')) {
        val = getByDotPath(ctx.statData ?? {}, key.slice('stat_data.'.length));
      } else if (key in ctx.vars) {
        val = ctx.vars[key];
      } else {
        val = getByDotPath(ctx.statData ?? {}, key);
      }
      if (val === undefined) return '';
      const cleaned = stripHiddenDollarKeys(val);
      if (typeof cleaned === 'object' && cleaned !== null) {
        return JSON.stringify(cleaned, null, op.startsWith('format_') ? 2 : 0);
      }
      return String(cleaned);
    }

    if (op === 'random') {
      const choices = rest.split('::');
      if (choices.length === 0) return '';
      const rng = ctx.rng ?? Math.random;
      const idx = Math.min(choices.length - 1, Math.floor(rng() * choices.length));
      return choices[idx] ?? '';
    }

    if (op === 'pick') {
      const choices = rest.split('::');
      if (choices.length === 0) return '';
      // Deterministic hash pick based on choice text + lastMessageId
      const seedStr = `${ctx.lastMessageId ?? 0}:${rest}`;
      let hash = 2166136261;
      for (let k = 0; k < seedStr.length; k++) {
        hash ^= seedStr.charCodeAt(k);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % choices.length;
      return choices[idx] ?? '';
    }
  }

  // Unknown macro: preserve verbatim so we never silently corrupt user text
  return `{{${expr}}}`;
}
