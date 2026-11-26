import { describe, it, expect } from 'vitest';
import { parseLorebookJson, scanLorebooks } from '../src/core/lorebook-engine.js';

describe('lorebook-engine', () => {
  const rawBook = {
    name: 'Test World',
    scan_depth: 3,
    token_budget: 2048,
    recursive_scanning: true,
    entries: {
      '0': {
        uid: 0,
        key: ['ignored'],
        constant: true,
        position: 0,
        content: 'The world has two moons.',
        comment: 'Two Moons',
        order: 50,
        disable: false,
      },
      '1': {
        uid: 1,
        key: ['银月城', '/silver\\s+city/i'],
        constant: false,
        content: '银月城由秘银议会统治。',
        comment: 'Silver City',
        order: 100,
        disable: false,
      },
      '2': {
        uid: 2,
        key: ['秘银议会'],
        constant: false,
        content: '秘银议会共有七位大法师。',
        comment: 'Mithril Council',
        order: 90,
        disable: false,
      },
      '3': {
        uid: 3,
        key: ['酒馆'],
        keysecondary: ['暗号'],
        selective: true,
        selectiveLogic: 0, // AND_ANY
        constant: false,
        content: '酒馆地下室有密道。',
        comment: 'Tavern Basement',
        order: 80,
        disable: false,
      },
    },
  };

  it('separates constant entries, matches regex/recursive entries, and applies cooldown', () => {
    const book = parseLorebookJson(rawBook);
    expect(book.entries).toHaveLength(4);

    // Turn 1: mention "Silver City" -> triggers entry 1, recursively triggers entry 2
    const res1 = scanLorebooks([book], {
      recentMessages: ['We just arrived at the Silver City gates.'],
      currentTurn: 1,
      cooldownTurns: 10,
      injectedLorebookTurns: {},
    });

    expect(res1.constantBefore).toHaveLength(1);
    expect(res1.triggered.map((x) => x.entry.comment)).toEqual(['Silver City', 'Mithril Council']);

    // Turn 5: mention again within cooldown -> both skipped!
    const injectedTurns: Record<string, number> = {};
    for (const item of res1.triggered) injectedTurns[item.entryKey] = 1;

    const res2 = scanLorebooks([book], {
      recentMessages: ['Tell me more about 银月城'],
      currentTurn: 5,
      cooldownTurns: 10,
      injectedLorebookTurns: injectedTurns,
    });
    expect(res2.triggered).toHaveLength(0);
    expect(res2.skippedByCooldown).toHaveLength(2);

    // Turn 12: past cooldown -> triggers again!
    const res3 = scanLorebooks([book], {
      recentMessages: ['Back to 银月城'],
      currentTurn: 12,
      cooldownTurns: 10,
      injectedLorebookTurns: injectedTurns,
    });
    expect(res3.triggered).toHaveLength(2);
  });

  it('enforces selective secondary keys', () => {
    const book = parseLorebookJson(rawBook);
    const miss = scanLorebooks([book], {
      recentMessages: ['我去酒馆喝一杯'],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(miss.triggered).toHaveLength(0);

    const hit = scanLorebooks([book], {
      recentMessages: ['我去酒馆对暗号'],
      currentTurn: 1,
      cooldownTurns: 0,
      injectedLorebookTurns: {},
    });
    expect(hit.triggered.map((x) => x.entry.comment)).toEqual(['Tavern Basement']);
  });
});
