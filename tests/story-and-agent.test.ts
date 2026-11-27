import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { StoryLogStore } from '../src/core/story-log.js';
import { splitIntoInjectChunks } from '../src/core/prompt-assembler.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-v04-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StoryLogStore (JSONL story log & rollback)', () => {
  it('appends, edits, rolls back turns, and formats fork resume block', () => {
    const dir = makeTmpDir();
    const store = new StoryLogStore(dir);

    const t1 = store.appendTurn('card-1', {
      userMessage: 'Knock on the study door.',
      narrative: 'Shizi opens the door with a warm smile.',
      statsSnapshot: { location: 'Study', mood: 'Warm', affection: 10 },
    });
    const t2 = store.appendTurn('card-1', {
      userMessage: 'Ask for tea.',
      narrative: 'She pours black tea.',
    });
    store.appendTurn('card-1', {
      userMessage: 'Spill the cup.',
      narrative: 'Tea splashes everywhere.',
    });

    expect(store.readTurns('card-1')).toHaveLength(3);

    // Edit turn 2
    store.editTurn('card-1', t2.turnId, 'She pours fragrant Darjeeling tea.');
    expect(store.readTurns('card-1')[1].narrative).toBe('She pours fragrant Darjeeling tea.');

    // Roll back inclusively to turn 2 (drop turn 3)
    const afterRollback = store.rollbackToTurn('card-1', t2.turnId, true);
    expect(afterRollback).toHaveLength(2);

    const resume = store.formatForForkResume(afterRollback, 'Shizi', 'Master');
    expect(resume).toContain('Turn 1');
    expect(resume).toContain('Darjeeling tea');
    expect(resume).not.toContain('splashes');

    // Roll back exclusively on turn 1 (delete everything from turn 1 onward)
    expect(store.rollbackToTurn('card-1', t1.turnId, false)).toHaveLength(0);
  });

  it('supports non-destructive multi-playthrough chat slots per card', () => {
    const dir = makeTmpDir();
    const store = new StoryLogStore(dir);

    store.appendTurn('card-x', { narrative: '第一周目第一楼' });
    const slot2 = store.createSlot('card-x');
    store.appendTurn(slot2.storyKey, { narrative: '第二周目全新开局' });

    const slots = store.listSlots('card-x', slot2.slotId);
    expect(slots).toHaveLength(2);
    expect(slots[0].slotId).toBe('default');
    expect(slots[0].turnCount).toBe(1);
    expect(slots[1].slotId).toBe(slot2.slotId);
    expect(slots[1].turnCount).toBe(1);

    // Original playthrough remains completely intact
    expect(store.readTurns('card-x')[0].narrative).toBe('第一周目第一楼');
    expect(store.readTurns(slot2.storyKey)[0].narrative).toBe('第二周目全新开局');

    store.deleteSlot(slot2.storyKey);
    expect(store.listSlots('card-x', 'default')).toHaveLength(1);
  });
});

describe('Built-in story-writer & story-director Custom Agent manifests', () => {
  it('exists with valid frontmatter and story_commit_turn guidance', () => {
    const agentPath = path.resolve(process.cwd(), 'plugin', 'agents', 'story-writer.md');
    expect(fs.existsSync(agentPath)).toBe(true);
    const md = fs.readFileSync(agentPath, 'utf8');
    expect(md).toContain('name: story-writer');
    expect(md).toContain('story_commit_turn');

    const directorPath = path.resolve(process.cwd(), 'plugin', 'agents', 'story-director.md');
    expect(fs.existsSync(directorPath)).toBe(true);
    const directorMd = fs.readFileSync(directorPath, 'utf8');
    expect(directorMd).toContain('name: story-director');
    expect(directorMd).toContain('invoke_subagent');
    expect(directorMd).toContain('manage_subagents');
  });

  it('splits oversized system messages into UTF-8 byte-bounded injectSteps chunks without data loss', () => {
    const sectionA = '这是一段中文测试设定。\n'.repeat(400); // ~13.2 KB
    const sectionB = '这是第二段开场白与历史正文。\n'.repeat(400); // ~16.8 KB
    const sectionC = '[TavernInAGY Delivery] End marker preserved.';
    const combined = `${sectionA}\n\n---\n\n${sectionB}\n\n---\n\n${sectionC}`;

    const chunks = splitIntoInjectChunks(combined, 12000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(12000);
    }
    expect(chunks[chunks.length - 1]).toContain('[TavernInAGY Delivery] End marker preserved.');
  });
});
