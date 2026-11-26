import { describe, it, expect } from 'vitest';
import { parseCharacterCardJson, parseCharacterCardPng } from '../src/core/card-parser.js';

function buildMinimalPngWithTextChunks(chunks: Array<{ keyword: string; text: string }>): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Buffer[] = [sig];

  const makeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); // dummy CRC for parser test
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  for (const c of chunks) {
    const payload = Buffer.concat([
      Buffer.from(c.keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(c.text, 'latin1'),
    ]);
    parts.push(makeChunk('tEXt', payload));
  }

  parts.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe('card-parser', () => {
  it('parses V2 character card PNG with embedded character_book', () => {
    const v2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Aria',
        description: 'A starlight mage.',
        personality: 'Curious and kind',
        scenario: 'Observatory tower',
        first_mes: 'Welcome, {{user}}.',
        tags: ['fantasy', 'mage'],
        character_book: {
          name: 'Aria Lore',
          entries: [
            {
              id: 1,
              keys: ['starlight'],
              content: 'Starlight magic draws from constellations.',
              enabled: true,
              insertion_order: 100,
            },
          ],
        },
      },
    };
    const png = buildMinimalPngWithTextChunks([
      { keyword: 'chara', text: Buffer.from(JSON.stringify(v2), 'utf8').toString('base64') },
    ]);

    const card = parseCharacterCardPng(png);
    expect(card.name).toBe('Aria');
    expect(card.description).toBe('A starlight mage.');
    expect(card.avatarDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(card.embeddedLorebook?.entries).toHaveLength(1);
    expect(card.embeddedLorebook?.entries[0].keys).toEqual(['starlight']);
  });

  it('prefers ccv3 over chara chunk when both exist', () => {
    const v2 = { data: { name: 'OldName', description: 'v2' } };
    const v3 = { spec: 'chara_card_v3', data: { name: 'NewV3Name', description: 'v3' } };
    const png = buildMinimalPngWithTextChunks([
      { keyword: 'chara', text: Buffer.from(JSON.stringify(v2), 'utf8').toString('base64') },
      { keyword: 'ccv3', text: Buffer.from(JSON.stringify(v3), 'utf8').toString('base64') },
    ]);

    const card = parseCharacterCardPng(png);
    expect(card.name).toBe('NewV3Name');
    expect(card.description).toBe('v3');
  });

  it('parses V1 flat JSON card', () => {
    const card = parseCharacterCardJson({
      name: 'Classic',
      description: 'V1 card',
      first_mes: 'Hi',
    });
    expect(card.name).toBe('Classic');
    expect(card.firstMessage).toBe('Hi');
  });
});
