import { load as parseYaml } from 'js-yaml';
import type { Lorebook } from './types.js';

export function cloneDeep<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Strips any keys starting with `$` (JS-Slash-Runner / MVU metadata convention).
 */
export function stripHiddenDollarKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripHiddenDollarKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$')) continue;
      out[k] = stripHiddenDollarKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Parses lodash-style property paths supporting dot notation, numeric indices,
 * and quoted bracket keys: `a.b[0].c`, `时间[0]`, `角色['a.b'].属性`.
 */
export function parseLodashPath(path: string): string[] {
  if (!path) return [];
  const parts: string[] = [];
  let i = 0;
  let buf = '';

  const flush = () => {
    if (buf.length > 0) {
      parts.push(buf);
      buf = '';
    }
  };

  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flush();
      const close = path.indexOf(']', i + 1);
      if (close === -1) {
        buf += path.slice(i);
        break;
      }
      let inner = path.slice(i + 1, close).trim();
      if (
        inner.length >= 2 &&
        ((inner.startsWith("'") && inner.endsWith("'")) ||
          (inner.startsWith('"') && inner.endsWith('"')))
      ) {
        inner = inner.slice(1, -1).replace(/\\(['"\\])/g, '$1');
      }
      if (inner.length > 0) parts.push(inner);
      i = close + 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return parts;
}

function isArrayIndexSegment(seg: string): boolean {
  return /^\d+$/.test(seg);
}

export function getByDotPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  const parts = parseLodashPath(dotPath);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    if (Array.isArray(cur) && isArrayIndexSegment(part)) {
      cur = cur[Number(part)];
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

export function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): Record<string, unknown> {
  const parts = parseLodashPath(dotPath);
  if (parts.length === 0) return obj;
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const nextSeg = parts[i + 1];
    if (Array.isArray(cur) && isArrayIndexSegment(seg)) {
      const idx = Number(seg);
      if (!cur[idx] || typeof cur[idx] !== 'object') {
        cur[idx] = isArrayIndexSegment(nextSeg) ? [] : {};
      }
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      const rec = cur as Record<string, unknown>;
      if (rec[seg] === null || rec[seg] === undefined || typeof rec[seg] !== 'object') {
        rec[seg] = isArrayIndexSegment(nextSeg) ? [] : {};
      }
      cur = rec[seg];
    } else {
      return obj;
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur) && isArrayIndexSegment(last)) {
    cur[Number(last)] = value;
  } else if (cur && typeof cur === 'object') {
    (cur as Record<string, unknown>)[last] = value;
  }
  return obj;
}

export function unsetByDotPath(obj: Record<string, unknown>, dotPath: string): boolean {
  const parts = parseLodashPath(dotPath);
  if (parts.length === 0) return false;
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return false;
    const seg = parts[i];
    cur = Array.isArray(cur) && isArrayIndexSegment(seg)
      ? cur[Number(seg)]
      : (cur as Record<string, unknown>)[seg];
  }
  if (!cur || typeof cur !== 'object') return false;
  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return false;
    cur.splice(idx, 1);
    return true;
  }
  if (last in (cur as Record<string, unknown>)) {
    delete (cur as Record<string, unknown>)[last];
    return true;
  }
  return false;
}

function parseLiteralValue(raw: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return { ok: true, value: trimmed.slice(1, -1) };
    }
    return { ok: false };
  }
}

export const lodashShim = {
  get: (obj: unknown, path: string, defaultValue?: unknown): unknown => {
    const v = getByDotPath(obj, path);
    return v === undefined ? defaultValue : v;
  },
  set: (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> =>
    setByDotPath(obj, path, value),
  unset: (obj: Record<string, unknown>, path: string): boolean => unsetByDotPath(obj, path),
  assign: (target: Record<string, unknown>, ...sources: Array<Record<string, unknown>>): Record<string, unknown> =>
    Object.assign(target, ...sources),
  cloneDeep,
};

/**
 * Strips single-line `//` and block `/* ... *\/` comments plus trailing commas outside string literals,
 * so hand-authored JSONC `[InitVar]` blocks parse reliably.
 */
function sanitizeJsonc(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const attempts = [raw, sanitizeJsonc(raw)];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Only extract `{...}` substring when the document itself starts with `{` (JSON/JSONC);
      // never match an inline `{}` inside a YAML document (e.g. `jobs: {}`).
      if (candidate.trimStart().startsWith('{')) {
        const match = candidate.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // continue next attempt
          }
        }
      }
    }
  }
  return null;
}

const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(source)) {
    if (UNSAFE_MERGE_KEYS.has(k)) continue;
    const existing = target[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      deepMergeObjects(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function tryParseYamlObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isInitVarEntry(comment: string, keys: string[]): boolean {
  const c = (comment || '').trim().toLowerCase();
  if (c === 'initvar' || c.includes('[initvar]')) return true;
  return keys.some((k) => {
    const lk = k.trim().toLowerCase();
    return lk === 'initvar' || lk.includes('[initvar]');
  });
}

/**
 * Extracts and deep-merges initial MVU `stat_data` JSON from all `[initvar]` / `[InitVar]*`
 * entries (e.g. `[InitVar]`, `[InitVar]1st`, `[InitVar]2nd`, commonly marked disabled in ST).
 */
export function extractInitVarFromLorebooks(
  lorebooks: Lorebook[],
  userName = 'User',
  charName?: string,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  let foundAny = false;

  for (const book of lorebooks) {
    const matched = book.entries
      .filter((entry) => isInitVarEntry(entry.comment, entry.keys))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const entry of matched) {
      let raw = entry.content
        .trim()
        .replace(/^```(?:jsonc?|yaml)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/<user>/gi, userName)
        .replace(/\{\{user\}\}/gi, userName);
      if (charName) {
        raw = raw.replace(/<char>/gi, charName).replace(/\{\{char\}\}/gi, charName);
      }
      const parsed = tryParseJsonObject(raw) ?? tryParseYamlObject(raw);
      if (parsed) {
        deepMergeObjects(merged, parsed);
        foundAny = true;
      }
    }
  }
  return foundAny ? merged : null;
}

interface JsonPatchOp {
  op: 'replace' | 'add' | 'remove';
  path: string;
  value?: unknown;
}

function decodePointerSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parseJsonPointer(pointer: string): string[] {
  if (!pointer || pointer === '/') return [];
  const cleaned = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  return cleaned.split('/').map(decodePointerSegment);
}

function hasReadonlyUnderscoreSegment(segments: string[]): boolean {
  return segments.some((s) => s.startsWith('_'));
}

function applyJsonPatchOp(
  root: Record<string, unknown>,
  op: JsonPatchOp,
): { applied: boolean; rejectedPath?: string } {
  const segments = parseJsonPointer(op.path);
  if (segments.length === 0) {
    // Prevent replacing entire root object (MVU safety invariant)
    return { applied: false, rejectedPath: op.path };
  }
  if (hasReadonlyUnderscoreSegment(segments)) {
    return { applied: false, rejectedPath: op.path };
  }

  let cur: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) {
        return { applied: false, rejectedPath: op.path };
      }
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      const rec = cur as Record<string, unknown>;
      if (!(seg in rec) || rec[seg] === null || typeof rec[seg] !== 'object') {
        if (op.op === 'add' || op.op === 'replace') {
          rec[seg] = {};
        } else {
          return { applied: false, rejectedPath: op.path };
        }
      }
      cur = rec[seg];
    } else {
      return { applied: false, rejectedPath: op.path };
    }
  }

  const last = segments[segments.length - 1];
  if (Array.isArray(cur)) {
    if (op.op === 'add' && last === '-') {
      cur.push(op.value);
      return { applied: true };
    }
    const idx = Number(last);
    if (Number.isNaN(idx)) return { applied: false, rejectedPath: op.path };
    if (op.op === 'add') {
      cur.splice(idx, 0, op.value);
      return { applied: true };
    }
    if (op.op === 'replace' && idx >= 0 && idx < cur.length) {
      cur[idx] = op.value;
      return { applied: true };
    }
    if (op.op === 'remove' && idx >= 0 && idx < cur.length) {
      cur.splice(idx, 1);
      return { applied: true };
    }
    return { applied: false, rejectedPath: op.path };
  }

  if (cur && typeof cur === 'object') {
    const rec = cur as Record<string, unknown>;
    if (op.op === 'remove') {
      delete rec[last];
      return { applied: true };
    }
    rec[last] = op.value;
    return { applied: true };
  }

  return { applied: false, rejectedPath: op.path };
}

export interface MvuUpdateResult {
  statData: Record<string, unknown>;
  appliedCount: number;
  rejectedPaths: string[];
  cleanedText: string;
}

/**
 * Quote-aware balanced `[...]` extractor so nested JSONPatch values like
 * `[{"op":"replace","path":"/bag","value":[{"name":"sword"}]}]` are never truncated at inner `}]`.
 */
function extractBalancedJsonArray(body: string): string | null {
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const start = body.indexOf('[', searchFrom);
    if (start === -1) return null;
    const afterStart = body.slice(start + 1).trimStart();
    if (!afterStart.startsWith('{')) {
      searchFrom = start + 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          return body.slice(start, i + 1);
        }
      }
    }
    return null;
  }
  return null;
}

/**
 * Quote- and bracket-aware extractor for `_.set(...)`, `_.add(...)`, `_.unset(...)`, `_.assign(...)`.
 * Correctly handles string arguments containing `)`, `;`, `,`, or nested objects/arrays.
 */
type LodashMethodName = 'set' | 'add' | 'unset' | 'assign' | 'insert' | 'remove';

function extractOrderedLodashCalls(
  body: string,
): Array<{ fn: LodashMethodName; args: string[] }> {
  const results: Array<{ fn: LodashMethodName; args: string[] }> = [];
  const prefixRe = /_\.(set|add|unset|assign|insert|remove)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = prefixRe.exec(body)) !== null) {
    const fn = m[1] as LodashMethodName;
    const argStart = m.index + m[0].length;
    let depthParen = 1;
    let depthBrace = 0;
    let depthBracket = 0;
    let quote: string | null = null;
    let escaped = false;
    const args: string[] = [];
    let cur = '';
    let closed = false;

    for (let i = argStart; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        cur += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === '(') {
        depthParen += 1;
        cur += ch;
      } else if (ch === ')') {
        depthParen -= 1;
        if (depthParen === 0) {
          if (cur.trim()) args.push(cur.trim());
          closed = true;
          prefixRe.lastIndex = i + 1;
          break;
        }
        cur += ch;
      } else if (ch === '{') {
        depthBrace += 1;
        cur += ch;
      } else if (ch === '}') {
        depthBrace = Math.max(0, depthBrace - 1);
        cur += ch;
      } else if (ch === '[') {
        depthBracket += 1;
        cur += ch;
      } else if (ch === ']') {
        depthBracket = Math.max(0, depthBracket - 1);
        cur += ch;
      } else if (ch === ',' && depthParen === 1 && depthBrace === 0 && depthBracket === 0) {
        args.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }

    if (closed && args.length > 0) {
      results.push({ fn, args });
    }
  }

  return results;
}

function unquoteStringArg(raw: string): string | null {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1).replace(/\\(['"\\])/g, '$1');
  }
  return null;
}

export interface MvuUpdateOptions {
  userName?: string;
  charName?: string;
}

/**
 * Parses `<update>...</update>` and `<UpdateVariable>...</UpdateVariable>` blocks
 * containing RFC 6902 JSON Patch arrays or `_.set` / `_.add` / `_.unset` / `_.assign` / `_.insert` / `_.remove` statements,
 * applies them to `stat_data` with `_` readonly protection, and returns cleaned narrative prose.
 */
export function applyMvuUpdates(
  currentStatData: Record<string, unknown>,
  text: string,
  options?: MvuUpdateOptions,
): MvuUpdateResult {
  const next = cloneDeep(currentStatData || {});
  let appliedCount = 0;
  const rejectedPaths: string[] = [];

  const blockRegex = /<update(?:variable)?>([\s\S]*?)<\/update(?:variable)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    let body = match[1];
    if (options?.userName) {
      body = body.replace(/<user>|\{\{user\}\}/gi, options.userName);
    }
    if (options?.charName) {
      body = body.replace(/<char>|\{\{char\}\}/gi, options.charName);
    }

    // 1. Try <JSONPatch> / <json_patch>, fenced json array, or balanced raw JSON array inside block
    const jsonPatchRaw =
      body.match(/<json_?patch>([\s\S]*?)<\/json_?patch>/i)?.[1] ??
      body.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i)?.[1] ??
      extractBalancedJsonArray(body);

    if (jsonPatchRaw) {
      try {
        const ops = JSON.parse(jsonPatchRaw.trim());
        if (Array.isArray(ops)) {
          for (const rawOp of ops) {
            if (
              rawOp &&
              typeof rawOp === 'object' &&
              (rawOp.op === 'replace' || rawOp.op === 'add' || rawOp.op === 'remove') &&
              typeof rawOp.path === 'string'
            ) {
              const res = applyJsonPatchOp(next, rawOp as JsonPatchOp);
              if (res.applied) appliedCount += 1;
              else if (res.rejectedPath) rejectedPaths.push(res.rejectedPath);
            }
          }
        }
      } catch {
        // Ignore malformed JSON patch array
      }
    }

    // 2. Execute MVU lodash calls (`_.set`/`_.add`/`_.unset`/`_.assign`/`_.insert`/`_.remove`) in exact source order
    for (const { fn, args } of extractOrderedLodashCalls(body)) {
      if (fn === 'set') {
        if (args.length < 2) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        if (!dotPath) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        const parsed = parseLiteralValue(args[1]);
        if (parsed.ok) {
          setByDotPath(next, dotPath, parsed.value);
          appliedCount += 1;
        }
      } else if (fn === 'add') {
        if (args.length < 2) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        const delta = Number(args[1]);
        if (!dotPath || !Number.isFinite(delta)) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        const curVal = getByDotPath(next, dotPath);
        if (Array.isArray(curVal) && curVal.length > 0 && typeof curVal[0] === 'number' && Number.isFinite(curVal[0])) {
          curVal[0] = curVal[0] + delta;
          appliedCount += 1;
        } else {
          const baseNum = typeof curVal === 'number' && Number.isFinite(curVal) ? curVal : Number(curVal) || 0;
          setByDotPath(next, dotPath, baseNum + delta);
          appliedCount += 1;
        }
      } else if (fn === 'unset') {
        if (args.length < 1) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        if (!dotPath) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        if (unsetByDotPath(next, dotPath)) {
          appliedCount += 1;
        }
      } else if (fn === 'assign') {
        if (args.length < 2) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        if (!dotPath) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        if (args.length === 2) {
          const parsedObj = parseLiteralValue(args[1]);
          if (parsedObj.ok) {
            const existing = getByDotPath(next, dotPath);
            if (Array.isArray(existing)) {
              existing.push(parsedObj.value);
              appliedCount += 1;
            } else if (parsedObj.value && typeof parsedObj.value === 'object' && !Array.isArray(parsedObj.value)) {
              const targetObj =
                existing && typeof existing === 'object' && !Array.isArray(existing)
                  ? (existing as Record<string, unknown>)
                  : {};
              for (const [k, v] of Object.entries(parsedObj.value as Record<string, unknown>)) {
                if (k.startsWith('_')) {
                  rejectedPaths.push(`${dotPath}.${k}`);
                  continue;
                }
                targetObj[k] = v;
              }
              setByDotPath(next, dotPath, targetObj);
              appliedCount += 1;
            }
          }
        } else if (args.length >= 3) {
          const key = unquoteStringArg(args[1])?.trim();
          if (!key) continue;
          if (key.startsWith('_')) {
            rejectedPaths.push(`${dotPath}.${key}`);
            continue;
          }
          const parsedVal = parseLiteralValue(args[2]);
          if (parsedVal.ok) {
            setByDotPath(next, `${dotPath}.${key}`, parsedVal.value);
            appliedCount += 1;
          }
        }
      } else if (fn === 'insert') {
        if (args.length < 2) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        if (!dotPath) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        if (args.length === 2) {
          const parsedVal = parseLiteralValue(args[1]);
          if (parsedVal.ok) {
            const existing = getByDotPath(next, dotPath);
            if (Array.isArray(existing)) {
              existing.push(parsedVal.value);
            } else {
              setByDotPath(next, dotPath, [parsedVal.value]);
            }
            appliedCount += 1;
          }
        } else if (args.length >= 3) {
          const key = unquoteStringArg(args[1])?.trim();
          if (!key || key.startsWith('_')) {
            if (key?.startsWith('_')) rejectedPaths.push(`${dotPath}.${key}`);
            continue;
          }
          const parsedVal = parseLiteralValue(args[2]);
          if (parsedVal.ok) {
            setByDotPath(next, `${dotPath}.${key}`, parsedVal.value);
            appliedCount += 1;
          }
        }
      } else if (fn === 'remove') {
        if (args.length < 2) continue;
        const dotPath = unquoteStringArg(args[0])?.trim();
        if (!dotPath) continue;
        const segs = parseLodashPath(dotPath);
        if (hasReadonlyUnderscoreSegment(segs)) {
          rejectedPaths.push(dotPath);
          continue;
        }
        const parsedTarget = parseLiteralValue(args[1]);
        if (!parsedTarget.ok) continue;
        const container = getByDotPath(next, dotPath);
        if (Array.isArray(container)) {
          const targetVal = parsedTarget.value;
          const idx =
            typeof targetVal === 'number' && Number.isInteger(targetVal) && targetVal >= 0 && targetVal < container.length
              ? targetVal
              : container.findIndex((item) => item === targetVal || JSON.stringify(item) === JSON.stringify(targetVal));
          if (idx !== -1) {
            container.splice(idx, 1);
            appliedCount += 1;
          }
        } else if (container && typeof container === 'object') {
          const key = String(parsedTarget.value);
          if (key.startsWith('_')) {
            rejectedPaths.push(`${dotPath}.${key}`);
          } else if (key in (container as Record<string, unknown>)) {
            delete (container as Record<string, unknown>)[key];
            appliedCount += 1;
          }
        }
      }
    }
  }

  // Strip MVU patch blocks from narrative; keep <StatusPlaceHolderImpl/> so card display regexes can render status bars
  // (if no card regex consumes it, FloorRenderer's generic fallback cleanly strips leftover empty placeholders).
  const cleanedText = text
    .replace(/<update(?:variable)?>[\s\S]*?<\/update(?:variable)?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    statData: next,
    appliedCount,
    rejectedPaths,
    cleanedText,
  };
}
