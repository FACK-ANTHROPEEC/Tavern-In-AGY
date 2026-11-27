import type { MemoryPluginConfig, StoryTurn } from './types.js';

export const DEFAULT_MEMORY_PLUGIN_CONFIG: MemoryPluginConfig = {
  enabled: false,
  recentFullFloors: 10,
  summaryLengthHint: 200,
  customPrompt: '',
  summaryDisplayMode: 'fold',
};

export function resolveMemoryPluginConfig(
  raw?: Partial<MemoryPluginConfig> | null,
): MemoryPluginConfig {
  const recentRaw = Number(raw?.recentFullFloors);
  const recentFullFloors = Number.isFinite(recentRaw)
    ? Math.max(1, Math.min(200, Math.floor(recentRaw)))
    : DEFAULT_MEMORY_PLUGIN_CONFIG.recentFullFloors;

  const lengthRaw = Number(raw?.summaryLengthHint);
  const summaryLengthHint = Number.isFinite(lengthRaw)
    ? Math.max(50, Math.min(800, Math.floor(lengthRaw)))
    : DEFAULT_MEMORY_PLUGIN_CONFIG.summaryLengthHint;

  return {
    enabled: Boolean(raw?.enabled),
    recentFullFloors,
    summaryLengthHint,
    customPrompt: typeof raw?.customPrompt === 'string' ? raw.customPrompt : '',
    summaryDisplayMode: raw?.summaryDisplayMode === 'hide' ? 'hide' : 'fold',
  };
}

/**
 * Builds the concise prompt contract instructing the model to append a ~200-char
 * per-turn summary inside `<memory_summary>...</memory_summary>`.
 */
export function buildMemoryPromptInstruction(raw?: Partial<MemoryPluginConfig> | null): string {
  const cfg = resolveMemoryPluginConfig(raw);
  if (!cfg.enabled) return '';

  const custom = (cfg.customPrompt ?? '').trim();
  if (custom) {
    return `[Memory Summary Contract]\n${custom.replace(/\{\{length\}\}/gi, String(cfg.summaryLengthHint))}`;
  }

  return [
    '[Memory Summary Contract]',
    `在 story_commit_turn 的 narrative 参数正文末尾，附带一段约 ${cfg.summaryLengthHint} 字的客观剧情小总结，放在 <memory_summary>...</memory_summary> 标签内即可，方便侧边栏自动收纳。`,
    '说明：记录本轮已发生的客观事实（时间/地点变化、出场人物、核心行动与对话结论、重要伏笔或关系变动），保持简洁。',
  ].join('\n');
}

const MEMORY_SUMMARY_RE = /<memory_summary\b[^>]*>([\s\S]*?)<\/memory_summary>/gi;
const COMPAT_SUMMARY_RES: Array<{ tag: string; re: RegExp }> = [
  { tag: 'wave_summary', re: /<wave_summary\b[^>]*>([\s\S]*?)<\/wave_summary>/gi },
  { tag: 'summary', re: /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi },
];

export interface ExtractedMemorySummary {
  summary: string;
  /** Narrative with `<memory_summary>` removed only when `stripOwnTag` is true; compat tags are never stripped */
  strippedText: string;
  matchedTag: string | null;
}

/**
 * Extracts a turn's concise summary from `<memory_summary>` (preferred) or compatible
 * preset tags (`<wave_summary>`, `<summary>`).
 */
export function extractMemorySummary(text: string): ExtractedMemorySummary {
  if (!text) return { summary: '', strippedText: '', matchedTag: null };

  let lastOwnMatch = '';
  for (const m of text.matchAll(MEMORY_SUMMARY_RE)) {
    const inner = (m[1] ?? '').trim();
    if (inner) lastOwnMatch = inner;
  }
  if (lastOwnMatch) {
    const strippedText = text.replace(MEMORY_SUMMARY_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    return { summary: lastOwnMatch, strippedText, matchedTag: 'memory_summary' };
  }

  const withoutDetails = text.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '');
  for (const { tag, re } of COMPAT_SUMMARY_RES) {
    const scanTarget = tag === 'summary' ? withoutDetails : text;
    let lastCompat = '';
    for (const m of scanTarget.matchAll(re)) {
      const inner = (m[1] ?? '').trim();
      if (inner) lastCompat = inner;
    }
    if (lastCompat) {
      return { summary: lastCompat, strippedText: text, matchedTag: tag };
    }
  }

  return { summary: '', strippedText: text, matchedTag: null };
}

/**
 * Removes `<memory_summary>...</memory_summary>` from a narrative before feeding it
 * as full prose in the recent window so the model does not read duplicated summaries.
 */
export function stripMemorySummaryTags(text: string): string {
  if (!text) return '';
  return text.replace(MEMORY_SUMMARY_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Generates a lightweight fallback excerpt for legacy turns created before the
 * memory plugin was enabled (when `turn.memorySummary` is absent).
 */
export function buildFallbackSummary(turn: StoryTurn, maxChars = 220): string {
  const clean = (s: string) =>
    s
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<(?:thinking|thought|cot|update|updatevariable|memory_summary)[^>]*>[\s\S]*?<\/(?:thinking|thought|cot|update|updatevariable|memory_summary)>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const userPart = turn.userMessage ? clean(turn.userMessage) : '';
  const aiPart = clean(turn.narrative || '');

  const userSnippet = userPart ? `行动：${userPart.slice(0, 60)}${userPart.length > 60 ? '…' : ''}；` : '';
  const remain = Math.max(40, maxChars - userSnippet.length);
  const aiSnippet = aiPart.length > remain ? `${aiPart.slice(0, remain)}…` : aiPart;
  return `${userSnippet}${aiSnippet}`.trim() || '(本楼暂无摘要)';
}

export interface FloorWindowSplit {
  /** Older turns whose full prose is replaced by concise summaries */
  summarizedTurns: StoryTurn[];
  /** Recent turns kept in full prose (boundary turn may keep AI prose only when recentFullFloors is odd) */
  fullEntries: Array<{ turn: StoryTurn; includeUserFull: boolean }>;
  totalFloors: number;
  fullFloorCount: number;
  summarizedFloorCount: number;
}

/**
 * Splits story turns by exact floor count (each userMessage = 1 floor, each narrative = 1 floor).
 * For example, `recentFullFloors = 10` keeps the latest 5 complete turns (5 user + 5 assistant floors);
 * `recentFullFloors = 7` keeps the latest 3 complete turns (6 floors) + the 4th-from-last assistant floor (1 floor).
 */
export function splitTurnsByRecentFloors(
  turns: StoryTurn[],
  recentFullFloors: number,
): FloorWindowSplit {
  const limit = Math.max(1, Math.floor(recentFullFloors));
  const totalFloors = turns.reduce((acc, t) => acc + (t.userMessage ? 2 : 1), 0);

  let remaining = limit;
  const fullEntriesRev: Array<{ turn: StoryTurn; includeUserFull: boolean }> = [];
  const summarizedRev: StoryTurn[] = [];
  let fullFloorCount = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (remaining <= 0) {
      summarizedRev.push(turn);
      continue;
    }

    // Assistant narrative occupies the latest floor of this turn
    remaining -= 1;
    fullFloorCount += 1;

    let includeUserFull = false;
    if (turn.userMessage) {
      if (remaining > 0) {
        includeUserFull = true;
        remaining -= 1;
        fullFloorCount += 1;
      }
    }
    fullEntriesRev.push({ turn, includeUserFull });
  }

  return {
    summarizedTurns: summarizedRev.reverse(),
    fullEntries: fullEntriesRev.reverse(),
    totalFloors,
    fullFloorCount,
    summarizedFloorCount: Math.max(0, totalFloors - fullFloorCount),
  };
}
