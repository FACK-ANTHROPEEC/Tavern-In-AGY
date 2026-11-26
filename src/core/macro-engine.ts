import { getByDotPath, stripHiddenDollarKeys } from './mvu-engine.js';

export interface MacroContext {
  char: string;
  user: string;
  persona?: string;
  scenario?: string;
  vars: Record<string, string>;
  statData?: Record<string, unknown>;
  now?: Date;
  rng?: () => number;
}

const TRIM_SENTINEL = '\u0000__TAVERN_TRIM__\u0000';

/**
 * O(N) stack-based innermost-first SillyTavern macro evaluator.
 * Supports multi-line values, nested macros, setvar/getvar/addvar, random, comments, and standard slots.
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

function evaluateMacroExpression(expr: string, ctx: MacroContext): string {
  const trimmed = expr.trim();

  // Comments: {{// ...}}
  if (trimmed.startsWith('//')) {
    return '';
  }

  // Trim directive
  if (trimmed.toLowerCase() === 'trim') {
    return TRIM_SENTINEL;
  }

  // Standard single-token macros (case-insensitive for char/user/etc.)
  const lower = trimmed.toLowerCase();
  if (lower === 'char') return ctx.char;
  if (lower === 'user') return ctx.user;
  if (lower === 'persona') return ctx.persona ?? '';
  if (lower === 'scenario') return ctx.scenario ?? '';
  if (lower === 'time') {
    const d = ctx.now ?? new Date();
    return d.toTimeString().slice(0, 5);
  }
  if (lower === 'date') {
    const d = ctx.now ?? new Date();
    return d.toISOString().slice(0, 10);
  }

  // Colon-delimited macros: {{op::arg1::arg2...}}
  const sepIdx = expr.indexOf('::');
  if (sepIdx !== -1) {
    const op = expr.slice(0, sepIdx).trim().toLowerCase();
    const rest = expr.slice(sepIdx + 2);

    if (op === 'setvar') {
      const valSep = rest.indexOf('::');
      if (valSep === -1) {
        ctx.vars[rest.trim()] = '';
      } else {
        const key = rest.slice(0, valSep).trim();
        const value = rest.slice(valSep + 2);
        ctx.vars[key] = value;
      }
      return '';
    }

    if (op === 'getvar') {
      const key = rest.trim();
      return ctx.vars[key] ?? '';
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

    if (op === 'addvar') {
      const valSep = rest.indexOf('::');
      if (valSep !== -1) {
        const key = rest.slice(0, valSep).trim();
        const deltaRaw = rest.slice(valSep + 2);
        const curRaw = ctx.vars[key] ?? '';
        const curNum = Number(curRaw);
        const deltaNum = Number(deltaRaw);
        if (curRaw !== '' && !Number.isNaN(curNum) && !Number.isNaN(deltaNum)) {
          ctx.vars[key] = String(curNum + deltaNum);
        } else {
          ctx.vars[key] = curRaw + deltaRaw;
        }
      }
      return '';
    }

    if (op === 'random') {
      const choices = rest.split('::');
      if (choices.length === 0) return '';
      const rng = ctx.rng ?? Math.random;
      const idx = Math.min(choices.length - 1, Math.floor(rng() * choices.length));
      return choices[idx] ?? '';
    }
  }

  // Unknown macro: preserve verbatim so we never silently corrupt user text
  return `{{${expr}}}`;
}
