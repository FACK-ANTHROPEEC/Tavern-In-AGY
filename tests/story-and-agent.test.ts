import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { StoryLogStore } from '../src/core/story-log.js';

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
});

describe('Built-in tavern-rp Custom Agent manifest', () => {
  it('exists with valid frontmatter and tavern_commit_turn guidance', () => {
    const agentPath = path.resolve(process.cwd(), 'plugin', 'agents', 'tavern-rp.md');
    expect(fs.existsSync(agentPath)).toBe(true);
    const md = fs.readFileSync(agentPath, 'utf8');
    expect(md).toContain('name: tavern-rp');
    expect(md).toContain('tavern_commit_turn');
  });
});
