import fs from 'node:fs';
import path from 'node:path';
import type { ChatSlotSummary, MemoryPluginConfig, RegexScript, StoryTurn } from './types.js';
import { applyRegexScripts } from './regex-engine.js';
import {
  buildFallbackSummary,
  extractMemorySummary,
  resolveMemoryPluginConfig,
  splitTurnsByRecentFloors,
  stripMemorySummaryTags,
} from './memory-engine.js';

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
}

export function resolveStoryKey(cardId: string, slotId?: string): string {
  const base = cardId || 'default';
  if (!slotId || slotId === 'default') return base;
  return `${base}__slot_${slotId}`;
}

export function estimateContextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * 1.1 + other / 3.8);
}

export interface ResumeBudgetOptions {
  /** Max estimated context tokens for resumed history (default: 150_000). */
  maxContextTokens?: number;
  /** Hard UTF-8 byte safety ceiling for resumed history (default: 480_000). */
  maxContextBytes?: number;
  /** Optional explicit turn cap; 0 or omitted means unlimited (bounded only by context budget). */
  maxTurns?: number;
  /** Optional memory plugin config; when enabled, only recentFullFloors are sent in full prose and earlier turns are condensed to memorySummary. */
  memoryPlugin?: Partial<MemoryPluginConfig>;
}

export class StoryLogStore {
  private readonly storiesDir: string;

  constructor(dataDir: string) {
    this.storiesDir = path.join(dataDir, 'stories');
    if (!fs.existsSync(this.storiesDir)) {
      fs.mkdirSync(this.storiesDir, { recursive: true });
    }
  }

  private filePath(storyKey: string): string {
    return path.join(this.storiesDir, `${safeKey(storyKey)}.jsonl`);
  }

  /**
   * Lists all playthrough chat slots for a given card (backward-compatible with legacy `<cardId>.jsonl` as `'default'`).
   */
  listSlots(cardId: string, activeSlotId = 'default'): ChatSlotSummary[] {
    const safeCard = safeKey(cardId || 'default');
    const prefix = `${safeCard}__slot_`;
    const files = fs.existsSync(this.storiesDir) ? fs.readdirSync(this.storiesDir) : [];

    const slotIds = new Set<string>(['default']);
    if (activeSlotId) slotIds.add(activeSlotId);

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const stem = f.slice(0, -6);
      if (stem === safeCard) {
        slotIds.add('default');
      } else if (stem.startsWith(prefix)) {
        slotIds.add(stem.slice(prefix.length));
      }
    }

    const items: ChatSlotSummary[] = [];
    let extraIndex = 2;
    const orderedIds = Array.from(slotIds).sort((a, b) => {
      if (a === 'default') return -1;
      if (b === 'default') return 1;
      return a.localeCompare(b);
    });

    for (const slotId of orderedIds) {
      const storyKey = resolveStoryKey(cardId, slotId);
      const p = this.filePath(storyKey);
      const turns = this.readTurns(storyKey);
      const stat = fs.existsSync(p) ? fs.statSync(p) : null;
      const updatedAt = turns[turns.length - 1]?.createdAt ?? stat?.mtime.toISOString() ?? '';
      const label =
        slotId === 'default'
          ? `存档 1 · ${turns.length}轮`
          : `存档 ${extraIndex++} · ${turns.length}轮`;
      items.push({
        slotId,
        storyKey,
        label,
        turnCount: turns.length,
        updatedAt,
      });
    }

    return items;
  }

  createSlot(cardId: string): { slotId: string; storyKey: string } {
    const slotId = `${Date.now()}`;
    const storyKey = resolveStoryKey(cardId, slotId);
    const p = this.filePath(storyKey);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, '', 'utf8');
    }
    return { slotId, storyKey };
  }

  deleteSlot(storyKey: string): void {
    const p = this.filePath(storyKey);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  }

  readTurns(storyKey: string): StoryTurn[] {
    const p = this.filePath(storyKey);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    const turns: StoryTurn[] = [];
    for (const line of lines) {
      try {
        turns.push(JSON.parse(line) as StoryTurn);
      } catch {
        // Skip corrupted line defensively
      }
    }
    return turns;
  }

  appendTurn(
    storyKey: string,
    input: Omit<StoryTurn, 'turnId' | 'index' | 'createdAt'>,
  ): StoryTurn {
    const existing = this.readTurns(storyKey);
    const turn: StoryTurn = {
      ...input,
      turnId: `turn-${Date.now()}-${existing.length + 1}`,
      index: existing.length + 1,
      createdAt: new Date().toISOString(),
    };
    const p = this.filePath(storyKey);
    fs.appendFileSync(p, JSON.stringify(turn) + '\n', 'utf8');
    return turn;
  }

  editTurn(storyKey: string, turnId: string, narrative: string): StoryTurn[] {
    const turns = this.readTurns(storyKey);
    const target = turns.find((t) => t.turnId === turnId);
    if (target) {
      const extracted = extractMemorySummary(narrative);
      // Only strip our own <memory_summary> tag so editing prose never overwrites a manually edited summary later
      target.narrative = extracted.matchedTag === 'memory_summary' ? extracted.strippedText : narrative;
      if (extracted.summary) {
        target.memorySummary = extracted.summary;
      }
      this.rewrite(storyKey, turns);
    }
    return turns;
  }

  editTurnSummary(storyKey: string, turnId: string, memorySummary: string): StoryTurn[] {
    const turns = this.readTurns(storyKey);
    const target = turns.find((t) => t.turnId === turnId);
    if (target) {
      const cleaned = memorySummary.trim();
      if (cleaned) {
        target.memorySummary = cleaned;
      } else {
        delete target.memorySummary;
      }
      this.rewrite(storyKey, turns);
    }
    return turns;
  }

  /**
   * Rolls back the JSONL story log:
   * - inclusive=true: keeps turns up to and including `turnId` (drops everything after)
   * - inclusive=false: deletes `turnId` and everything after (for re-rolling that turn)
   */
  rollbackToTurn(storyKey: string, turnId: string, inclusive: boolean): StoryTurn[] {
    const turns = this.readTurns(storyKey);
    const idx = turns.findIndex((t) => t.turnId === turnId);
    if (idx === -1) return turns;
    const kept = inclusive ? turns.slice(0, idx + 1) : turns.slice(0, idx);
    const reindexed = kept.map((t, i) => ({ ...t, index: i + 1 }));
    this.rewrite(storyKey, reindexed);
    return reindexed;
  }

  formatForForkResume(
    turns: StoryTurn[],
    charName: string,
    userName: string,
    budgetOrMaxTurns: number | ResumeBudgetOptions = {},
    regexScripts: RegexScript[] = [],
  ): string {
    if (turns.length === 0) return '';
    const opts: ResumeBudgetOptions =
      typeof budgetOrMaxTurns === 'number'
        ? { maxTurns: budgetOrMaxTurns }
        : budgetOrMaxTurns;
    const maxContextTokens = opts.maxContextTokens ?? 150_000;
    const maxContextBytes = opts.maxContextBytes ?? 480_000;
    const candidateTurns =
      opts.maxTurns && opts.maxTurns > 0 ? turns.slice(-opts.maxTurns) : turns;

    const memCfg = resolveMemoryPluginConfig(opts.memoryPlugin);

    // Memory plugin mode: older floors are compressed to per-turn summaries, latest N floors stay in full prose.
    if (memCfg.enabled) {
      const split = splitTurnsByRecentFloors(candidateTurns, memCfg.recentFullFloors);

      // 1. Build full-prose blocks for the latest N floors first (highest priority in token budget)
      const fullBlocks: string[] = [];
      let usedTokens = 0;
      let usedBytes = 0;
      let msgDepth = 0;

      for (let i = split.fullEntries.length - 1; i >= 0; i--) {
        const { turn: t, includeUserFull } = split.fullEntries[i];
        const aiDepth = msgDepth++;
        const userDepth = t.userMessage && includeUserFull ? msgDepth++ : aiDepth + 1;
        const parts: string[] = [];
        if (t.userMessage && includeUserFull) {
          const userText =
            regexScripts.length > 0
              ? applyRegexScripts(t.userMessage, regexScripts, {
                  placement: 1,
                  target: 'prompt',
                  depth: userDepth,
                })
              : t.userMessage;
          parts.push(`\n### Turn ${t.index} (${userName})\n${userText}`);
        }
        const strippedNarrative = stripMemorySummaryTags(t.narrative);
        const aiText =
          regexScripts.length > 0
            ? applyRegexScripts(strippedNarrative, regexScripts, {
                placement: 2,
                target: 'prompt',
                depth: aiDepth,
              })
            : strippedNarrative;
        parts.push(`\n### Turn ${t.index} (${charName})\n${aiText}`);

        const block = parts.join('\n');
        const blockTokens = estimateContextTokens(block);
        const blockBytes = Buffer.byteLength(block, 'utf8');

        if (
          fullBlocks.length > 0 &&
          (usedTokens + blockTokens > maxContextTokens || usedBytes + blockBytes > maxContextBytes)
        ) {
          break;
        }
        fullBlocks.push(block);
        usedTokens += blockTokens;
        usedBytes += blockBytes;
      }
      fullBlocks.reverse();

      // 2. Build compact summary lines for all earlier turns (newest-first budget check, emitted chronologically)
      // Also preserve boundary turn's userMessage when recentFullFloors is odd (includeUserFull === false)
      const boundaryEntry = split.fullEntries[0];
      const boundaryUserLine =
        boundaryEntry && !boundaryEntry.includeUserFull && boundaryEntry.turn.userMessage?.trim()
          ? `- [Turn #${boundaryEntry.turn.index} · ${userName}] ${boundaryEntry.turn.userMessage.trim()}`
          : '';

      const summaryLines: string[] = [];
      if (boundaryUserLine) {
        const bTokens = estimateContextTokens(boundaryUserLine);
        const bBytes = Buffer.byteLength(boundaryUserLine, 'utf8');
        if (usedTokens + bTokens <= maxContextTokens && usedBytes + bBytes <= maxContextBytes) {
          summaryLines.push(boundaryUserLine);
          usedTokens += bTokens;
          usedBytes += bBytes;
        }
      }
      for (let i = split.summarizedTurns.length - 1; i >= 0; i--) {
        const t = split.summarizedTurns[i];
        const text =
          (t.memorySummary && t.memorySummary.trim()) ||
          extractMemorySummary(t.narrative).summary ||
          buildFallbackSummary(t, Math.max(160, memCfg.summaryLengthHint));
        const line = `- [Turn #${t.index}] ${text}`;
        const lineTokens = estimateContextTokens(line);
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (usedTokens + lineTokens > maxContextTokens || usedBytes + lineBytes > maxContextBytes) {
          break;
        }
        summaryLines.push(line);
        usedTokens += lineTokens;
        usedBytes += lineBytes;
      }
      summaryLines.reverse();

      const sections: string[] = [];
      if (summaryLines.length > 0) {
        const condensedCount = split.summarizedTurns.length;
        const header =
          condensedCount > 0
            ? `[Earlier Story Memory · Turns #${split.summarizedTurns[0]?.index ?? 1}–#${split.summarizedTurns[condensedCount - 1]?.index ?? condensedCount} (${condensedCount} Turns Condensed)]`
            : '[Earlier Story Memory · Boundary User Input]';
        sections.push([header, ...summaryLines].join('\n'));
      }
      if (fullBlocks.length > 0) {
        sections.push(
          [
            `[Recent Story History · Latest ${split.fullFloorCount} Floors in Full Prose]`,
            'Continue seamlessly from the exact story state below:',
            ...fullBlocks,
          ].join('\n'),
        );
      }
      return sections.join('\n\n');
    }

    // Standard full-history mode (memory plugin disabled): walk backward from the latest turn within 150k budget.
    const selectedBlocks: string[] = [];
    let usedTokens = 0;
    let usedBytes = 0;
    let msgDepth = 0;

    for (let i = candidateTurns.length - 1; i >= 0; i--) {
      const t = candidateTurns[i];
      const aiDepth = msgDepth++;
      const userDepth = t.userMessage ? msgDepth++ : aiDepth + 1;
      const parts: string[] = [];
      if (t.userMessage) {
        const userText =
          regexScripts.length > 0
            ? applyRegexScripts(t.userMessage, regexScripts, {
                placement: 1,
                target: 'prompt',
                depth: userDepth,
              })
            : t.userMessage;
        parts.push(`\n### Turn ${t.index} (${userName})\n${userText}`);
      }
      const aiText =
        regexScripts.length > 0
          ? applyRegexScripts(t.narrative, regexScripts, {
              placement: 2,
              target: 'prompt',
              depth: aiDepth,
            })
          : t.narrative;
      parts.push(`\n### Turn ${t.index} (${charName})\n${aiText}`);

      const block = parts.join('\n');
      const blockTokens = estimateContextTokens(block);
      const blockBytes = Buffer.byteLength(block, 'utf8');

      if (
        selectedBlocks.length > 0 &&
        (usedTokens + blockTokens > maxContextTokens || usedBytes + blockBytes > maxContextBytes)
      ) {
        break;
      }
      selectedBlocks.push(block);
      usedTokens += blockTokens;
      usedBytes += blockBytes;
    }

    if (selectedBlocks.length === 0) return '';
    selectedBlocks.reverse();
    const header = [
      `[Resumed Story Branch · Last ${selectedBlocks.length} Turns]`,
      'Continue seamlessly from the exact edited/rolled-back story state below:',
    ];
    return [...header, ...selectedBlocks].join('\n');
  }

  private rewrite(storyKey: string, turns: StoryTurn[]): void {
    const p = this.filePath(storyKey);
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
    const tmp = `${p}.${nonce}.tmp`;
    const body = turns.map((t) => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : '');
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);
  }
}
