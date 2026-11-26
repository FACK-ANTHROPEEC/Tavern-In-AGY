import fs from 'node:fs';
import path from 'node:path';
import type { RegexScript, StoryTurn } from './types.js';
import { applyRegexScripts } from './regex-engine.js';

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
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
      target.narrative = narrative;
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
    maxTurns = 15,
    regexScripts: RegexScript[] = [],
  ): string {
    const recent = turns.slice(-maxTurns);
    if (recent.length === 0) return '';
    const lines: string[] = [
      `[Resumed Story Branch · Last ${recent.length} Turns]`,
      'Continue seamlessly from the exact edited/rolled-back story state below:',
    ];
    for (let i = 0; i < recent.length; i++) {
      const t = recent[i];
      const depth = recent.length - 1 - i;
      if (t.userMessage) {
        const userText =
          regexScripts.length > 0
            ? applyRegexScripts(t.userMessage, regexScripts, {
                placement: 1,
                target: 'prompt',
                depth,
              })
            : t.userMessage;
        lines.push(`\n### Turn ${t.index} (${userName})\n${userText}`);
      }
      const aiText =
        regexScripts.length > 0
          ? applyRegexScripts(t.narrative, regexScripts, {
              placement: 2,
              target: 'prompt',
              depth,
            })
          : t.narrative;
      lines.push(`\n### Turn ${t.index} (${charName})\n${aiText}`);
    }
    return lines.join('\n');
  }

  private rewrite(storyKey: string, turns: StoryTurn[]): void {
    const p = this.filePath(storyKey);
    const tmp = `${p}.${process.pid}.tmp`;
    const body = turns.map((t) => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : '');
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);
  }
}
