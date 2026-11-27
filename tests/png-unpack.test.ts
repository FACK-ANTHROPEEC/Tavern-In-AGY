import { describe, expect, it } from 'vitest';
import { extractCardJsonFromPngBuffer } from '../src/ui/png-unpack.js';

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); // parser skips CRC verification
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeFakePng(chunks: Buffer[]): ArrayBuffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  const full = Buffer.concat([sig, ...chunks, iend]);
  return full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength);
}

describe('browser PNG character card unpacker', () => {
  it('prefers ccv3 over chara in tEXt chunks and decodes UTF-8 Chinese cleanly', () => {
    const v2 = Buffer.from(JSON.stringify({ name: '旧版角色' }), 'utf8').toString('base64');
    const v3 = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: '新版测试角色' } }), 'utf8').toString('base64');

    const png = makeFakePng([
      makeChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(v2, 'latin1')])),
      makeChunk('tEXt', Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(v3, 'latin1')])),
    ]);

    const jsonText = extractCardJsonFromPngBuffer(png);
    const parsed = JSON.parse(jsonText);
    expect(parsed.data.name).toBe('新版测试角色');
  });

  it('supports uncompressed iTXt chunks with raw JSON or base64 payload', () => {
    const rawJson = JSON.stringify({ data: { name: '国际块角色' } });
    // keyword \0 compressionFlag(0) compressionMethod(0) lang \0 translated \0 text
    const itxtData = Buffer.concat([
      Buffer.from('ccv3', 'latin1'),
      Buffer.from([0, 0, 0, 0, 0]),
      Buffer.from(rawJson, 'utf8'),
    ]);
    const png = makeFakePng([makeChunk('iTXt', itxtData)]);
    const parsed = JSON.parse(extractCardJsonFromPngBuffer(png));
    expect(parsed.data.name).toBe('国际块角色');
  });

  it('throws a clear error when PNG lacks character metadata', () => {
    const png = makeFakePng([]);
    expect(() => extractCardJsonFromPngBuffer(png)).toThrow(/ccv3|chara/);
  });
});
