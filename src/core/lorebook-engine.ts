import crypto from 'node:crypto';
import type { Lorebook, LorebookEntry } from './types.js';

function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const hash = crypto.createHash('sha1').update(name + Date.now()).digest('hex').slice(0, 6);
  return `${base || 'lorebook'}-${hash}`;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (typeof val === 'string') {
    return val
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function mapPosition(pos: unknown): 'before_char' | 'after_char' | 'in_chat' {
  if (pos === 0 || pos === 'before_char') return 'before_char';
  if (pos === 4 || pos === 'in_chat') return 'in_chat';
  return 'after_char';
}

function pickOptionalBool(...values: unknown[]): boolean | undefined {
  for (const v of values) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

function pickPositiveNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Parses both standalone SillyTavern World Info JSON (`entries` object or array)
 * and Character Card V2/V3 `character_book`.
 */
export function parseLorebookJson(
  raw: unknown,
  fallbackName = 'Imported Lorebook',
  id?: string,
): Lorebook {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Lorebook JSON must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const rawEntries = obj.entries;

  const entryList: Array<Record<string, unknown>> = Array.isArray(rawEntries)
    ? (rawEntries as Array<Record<string, unknown>>)
    : rawEntries && typeof rawEntries === 'object'
      ? Object.values(rawEntries as Record<string, Record<string, unknown>>)
      : [];

  const entries: LorebookEntry[] = entryList.map((e, idx) => {
    const ext = (e.extensions && typeof e.extensions === 'object'
      ? e.extensions
      : {}) as Record<string, unknown>;
    const uid = String(e.uid ?? e.id ?? idx);
    const disabled = 'disable' in e ? Boolean(e.disable) : 'enabled' in e ? !Boolean(e.enabled) : false;
    const logicRaw = Number(
      e.selectiveLogic ?? e.selective_logic ?? ext.selectiveLogic ?? ext.selective_logic ?? 0,
    );
    const selectiveLogic: 0 | 1 | 2 | 3 =
      logicRaw === 1 || logicRaw === 2 || logicRaw === 3 ? logicRaw : 0;

    // ST V2/V3 character_book stores numeric position/depth/recursion flags inside `entry.extensions`
    const rawPos =
      ext.position !== undefined && ext.position !== null ? ext.position : e.position;
    const depth =
      typeof e.depth === 'number'
        ? e.depth
        : typeof ext.depth === 'number'
          ? ext.depth
          : undefined;

    return {
      uid,
      keys: toStringArray(e.key ?? e.keys),
      secondaryKeys: toStringArray(e.keysecondary ?? e.secondary_keys),
      selective: Boolean(e.selective),
      selectiveLogic,
      constant: Boolean(e.constant),
      content: String(e.content ?? ''),
      comment: String(e.comment ?? e.name ?? `Entry ${uid}`),
      enabled: !disabled,
      order: Number(e.order ?? e.insertion_order ?? 100),
      position: mapPosition(rawPos),
      depth,
      caseSensitive: pickOptionalBool(
        e.caseSensitive,
        e.case_sensitive,
        ext.case_sensitive,
        ext.caseSensitive,
      ),
      matchWholeWords: pickOptionalBool(
        e.matchWholeWords,
        e.match_whole_words,
        ext.match_whole_words,
        ext.matchWholeWords,
      ),
      excludeRecursion: Boolean(
        e.excludeRecursion ?? e.exclude_recursion ?? ext.exclude_recursion ?? ext.excludeRecursion,
      ),
      preventRecursion: Boolean(
        e.preventRecursion ?? e.prevent_recursion ?? ext.prevent_recursion ?? ext.preventRecursion,
      ),
      delayUntilRecursion: Boolean(
        e.delayUntilRecursion ??
          e.delay_until_recursion ??
          ext.delay_until_recursion ??
          ext.delayUntilRecursion,
      ),
      scanDepth: pickPositiveNumber(e.scanDepth, e.scan_depth, ext.scan_depth, ext.scanDepth),
    };
  });

  const name = String(obj.name ?? fallbackName).trim() || fallbackName;

  return {
    id: id ?? slugifyId(name),
    name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    scanDepth: Number(obj.scan_depth ?? obj.scanDepth ?? 4),
    tokenBudget: Number(obj.token_budget ?? obj.tokenBudget ?? 2048),
    recursiveScanning: Boolean(obj.recursive_scanning ?? obj.recursiveScanning ?? true),
    maxRecursionSteps: Number(obj.max_recursion_steps ?? 3),
    entries,
    importedAt: new Date().toISOString(),
  };
}

function matchesKeyword(haystack: string, keyword: string, caseSensitive: boolean): boolean {
  if (!keyword) return false;
  // Regex syntax: /pattern/flags
  if (keyword.startsWith('/') && keyword.lastIndexOf('/') > 0) {
    const lastSlash = keyword.lastIndexOf('/');
    const pattern = keyword.slice(1, lastSlash);
    const flags = keyword.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
    try {
      const re = new RegExp(pattern, flags);
      return re.test(haystack);
    } catch {
      return false;
    }
  }
  if (caseSensitive) {
    return haystack.includes(keyword);
  }
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}

function matchesEntry(haystack: string, entry: LorebookEntry): boolean {
  if (!entry.enabled || !entry.content.trim() || entry.keys.length === 0) return false;
  const cs = Boolean(entry.caseSensitive);
  const primaryHit = entry.keys.some((k) => matchesKeyword(haystack, k, cs));
  if (!primaryHit) return false;

  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return true;
  }

  const hits = entry.secondaryKeys.map((k) => matchesKeyword(haystack, k, cs));
  switch (entry.selectiveLogic) {
    case 0: // AND_ANY
      return hits.some(Boolean);
    case 1: // NOT_ALL
      return !hits.every(Boolean);
    case 2: // NOT_ANY
      return !hits.some(Boolean);
    case 3: // AND_ALL
      return hits.every(Boolean);
    default:
      return true;
  }
}

export interface LorebookScanOptions {
  recentMessages: string[];
  currentTurn: number;
  cooldownTurns: number;
  injectedLorebookTurns: Record<string, number>;
  tokenBudgetOverride?: number;
}

export interface TriggeredLorebookEntry {
  bookId: string;
  entryKey: string;
  entry: LorebookEntry;
}

export interface LorebookScanResult {
  constantBefore: TriggeredLorebookEntry[];
  constantAfter: TriggeredLorebookEntry[];
  triggered: TriggeredLorebookEntry[];
  skippedByCooldown: string[];
  estimatedTokens: number;
}

function estimateTokens(text: string): number {
  // Blended heuristic for CJK + English (~2.5 chars/token conservative)
  return Math.ceil(text.length / 2.5);
}

/**
 * SillyTavern-compatible World Info scanner with Antigravity cooldown deduplication.
 */
export function scanLorebooks(
  lorebooks: Lorebook[],
  options: LorebookScanOptions,
): LorebookScanResult {
  const constantBefore: TriggeredLorebookEntry[] = [];
  const constantAfter: TriggeredLorebookEntry[] = [];
  const candidates: TriggeredLorebookEntry[] = [];
  const candidateKeys = new Set<string>();
  const skippedByCooldown: string[] = [];

  const maxScanDepth = Math.max(1, ...lorebooks.map((b) => b.scanDepth || 4));
  const baseScanBuffer = options.recentMessages.slice(-maxScanDepth).join('\n');
  let recursionBuffer = '';

  // Collect constants first
  for (const book of lorebooks) {
    for (const entry of book.entries) {
      if (!entry.enabled || !entry.content.trim()) continue;
      if (entry.constant) {
        const item: TriggeredLorebookEntry = {
          bookId: book.id,
          entryKey: `${book.id}:${entry.uid}`,
          entry,
        };
        if (entry.position === 'before_char') {
          constantBefore.push(item);
        } else {
          constantAfter.push(item);
        }
      }
    }
  }

  // Iterative scan + recursive expansion
  const maxSteps = Math.max(1, ...lorebooks.map((b) => (b.recursiveScanning ? b.maxRecursionSteps || 3 : 1)));

  for (let step = 0; step < maxSteps; step++) {
    let addedInStep = false;
    let recursionAdditions = '';

    for (const book of lorebooks) {
      if (step > 0 && !book.recursiveScanning) continue;

      for (const entry of book.entries) {
        if (!entry.enabled || entry.constant || !entry.content.trim()) continue;
        if (step === 0 && entry.delayUntilRecursion) continue;
        if (step > 0 && entry.excludeRecursion) continue;

        const entryKey = `${book.id}:${entry.uid}`;
        if (candidateKeys.has(entryKey)) continue;

        const entryBaseBuffer =
          entry.scanDepth && entry.scanDepth > 0
            ? options.recentMessages.slice(-entry.scanDepth).join('\n')
            : baseScanBuffer;
        const haystack = step === 0 ? entryBaseBuffer : entryBaseBuffer + recursionBuffer;

        if (matchesEntry(haystack, entry)) {
          candidateKeys.add(entryKey);
          candidates.push({ bookId: book.id, entryKey, entry });
          addedInStep = true;
          if (!entry.preventRecursion) {
            recursionAdditions += '\n' + entry.content;
          }
        }
      }
    }

    if (!addedInStep || !recursionAdditions) break;
    recursionBuffer += recursionAdditions;
  }

  // Sort by ST order descending (higher order = higher priority)
  candidates.sort((a, b) => b.entry.order - a.entry.order);

  const budget =
    options.tokenBudgetOverride ??
    Math.max(512, ...lorebooks.map((b) => b.tokenBudget || 2048));

  const triggered: TriggeredLorebookEntry[] = [];
  let usedTokens = 0;

  for (const item of candidates) {
    const lastTurn = options.injectedLorebookTurns[item.entryKey];
    if (
      lastTurn !== undefined &&
      options.cooldownTurns > 0 &&
      options.currentTurn - lastTurn < options.cooldownTurns
    ) {
      skippedByCooldown.push(item.entryKey);
      continue;
    }

    const cost = estimateTokens(item.entry.content);
    if (triggered.length > 0 && usedTokens + cost > budget) {
      continue;
    }

    triggered.push(item);
    usedTokens += cost;
  }

  return {
    constantBefore,
    constantAfter,
    triggered,
    skippedByCooldown,
    estimatedTokens: usedTokens,
  };
}
