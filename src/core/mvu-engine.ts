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

export function getByDotPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  const parts = dotPath.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.').filter(Boolean);
  if (parts.length === 0) return obj;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

export const lodashShim = {
  get: (obj: unknown, path: string, defaultValue?: unknown): unknown => {
    const v = getByDotPath(obj, path);
    return v === undefined ? defaultValue : v;
  },
  set: (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> =>
    setByDotPath(obj, path, value),
  assign: (target: Record<string, unknown>, ...sources: Array<Record<string, unknown>>): Record<string, unknown> =>
    Object.assign(target, ...sources),
  cloneDeep,
};

/**
 * Extracts initial MVU `stat_data` JSON from `[initvar]` / `[InitVar]` entries
 * (commonly marked disabled in SillyTavern character_book so they don't bloat raw prompts).
 */
export function extractInitVarFromLorebooks(
  lorebooks: Lorebook[],
  userName = 'User',
): Record<string, unknown> | null {
  for (const book of lorebooks) {
    for (const entry of book.entries) {
      const name = (entry.comment || '').trim().toLowerCase();
      const hasInitKey = entry.keys.some((k) => k.trim().toLowerCase() === '[initvar]');
      if (name === '[initvar]' || name === 'initvar' || hasInitKey) {
        const raw = entry.content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .replace(/<user>/gi, userName)
          .replace(/\{\{user\}\}/gi, userName);
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Try extracting first {...} JSON block defensively
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              const parsed = JSON.parse(match[0]);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
              }
            } catch {
              // Ignore malformed initvar
            }
          }
        }
      }
    }
  }
  return null;
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
 * Parses `<update>...</update>` and `<UpdateVariable>...</UpdateVariable>` blocks
 * containing RFC 6902 JSON Patch arrays or `_.set` / `_.assign` statements,
 * applies them to `stat_data` with `_` readonly protection, and returns cleaned narrative prose.
 */
export function applyMvuUpdates(
  currentStatData: Record<string, unknown>,
  text: string,
): MvuUpdateResult {
  const next = cloneDeep(currentStatData || {});
  let appliedCount = 0;
  const rejectedPaths: string[] = [];

  const blockRegex = /<update(?:variable)?>([\s\S]*?)<\/update(?:variable)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const body = match[1];

    // 1. Try <JSONPatch>...</JSONPatch> or raw JSON array inside block
    const jsonPatchMatch =
      body.match(/<jsonpatch>([\s\S]*?)<\/jsonpatch>/i) ??
      body.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i) ??
      body.match(/(\[\s*\{[\s\S]*?\}\s*\])/);

    if (jsonPatchMatch) {
      try {
        const ops = JSON.parse(jsonPatchMatch[1].trim());
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

    // 2. Also support legacy MVU `_.set('path', value)` statements
    const setRegex = /_\.set\(\s*['"]([^'"]+)['"]\s*,\s*([^;\n)]+)\s*\)/g;
    let setMatch: RegExpExecArray | null;
    while ((setMatch = setRegex.exec(body)) !== null) {
      const dotPath = setMatch[1].trim();
      const segs = dotPath.split('.');
      if (hasReadonlyUnderscoreSegment(segs)) {
        rejectedPaths.push(dotPath);
        continue;
      }
      try {
        const val = JSON.parse(setMatch[2].trim());
        setByDotPath(next, dotPath, val);
        appliedCount += 1;
      } catch {
        // Fallback string literal if single-quoted
        const rawVal = setMatch[2].trim();
        if (rawVal.startsWith("'") && rawVal.endsWith("'")) {
          setByDotPath(next, dotPath, rawVal.slice(1, -1));
          appliedCount += 1;
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
