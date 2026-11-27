/**
 * Browser-side PNG Character Card V2/V3 unpacker & thumbnail generator.
 * Extracts a single `ccv3` or `chara` metadata JSON directly in the browser
 * and compresses the avatar to a lightweight thumbnail so multi-MB PNG cards
 * never blow past MCP App IPC payload limits.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesToLatin1(bytes: Uint8Array, start: number, end: number): string {
  const chunk = 0x8000;
  let out = '';
  for (let i = start; i < end; i += chunk) {
    const slice = bytes.subarray(i, Math.min(end, i + chunk));
    out += String.fromCharCode(...slice);
  }
  return out;
}

function decodeBase64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export function extractCardJsonFromPngBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) {
    throw new Error('无效的 PNG 文件：文件长度不足');
  }
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIG[i]) {
      throw new Error('无效的 PNG 文件：缺少 PNG 文件头签名');
    }
  }

  const view = new DataView(buffer);
  const textChunks = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = bytesToLatin1(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > bytes.length) {
      break;
    }

    if (type === 'tEXt') {
      let nullIdx = -1;
      for (let i = dataStart; i < dataEnd; i += 1) {
        if (bytes[i] === 0) {
          nullIdx = i;
          break;
        }
      }
      if (nullIdx !== -1) {
        const keyword = bytesToLatin1(bytes, dataStart, nullIdx).toLowerCase();
        if (keyword === 'ccv3' || keyword === 'chara') {
          textChunks.set(keyword, bytesToLatin1(bytes, nullIdx + 1, dataEnd));
        }
      }
    } else if (type === 'iTXt') {
      // iTXt: keyword \0 compressionFlag(1) compressionMethod(1) langTag \0 translatedKeyword \0 text
      let nullIdx = -1;
      for (let i = dataStart; i < dataEnd; i += 1) {
        if (bytes[i] === 0) {
          nullIdx = i;
          break;
        }
      }
      if (nullIdx !== -1 && nullIdx + 3 <= dataEnd) {
        const keyword = bytesToLatin1(bytes, dataStart, nullIdx).toLowerCase();
        const compressionFlag = bytes[nullIdx + 1];
        if ((keyword === 'ccv3' || keyword === 'chara') && compressionFlag === 0) {
          let cursor = nullIdx + 3;
          let zeros = 0;
          while (cursor < dataEnd && zeros < 2) {
            if (bytes[cursor] === 0) zeros += 1;
            cursor += 1;
          }
          if (zeros === 2 && cursor < dataEnd) {
            const payload = new TextDecoder('utf-8').decode(bytes.subarray(cursor, dataEnd));
            textChunks.set(keyword, payload);
          }
        }
      }
    }

    if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  const rawPayload = textChunks.get('ccv3') ?? textChunks.get('chara');
  if (!rawPayload) {
    throw new Error('该 PNG 图片中未找到角色卡元数据（缺少 ccv3 或 chara 数据块）');
  }

  const trimmed = rawPayload.trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : decodeBase64ToUtf8(trimmed);
  // Validate JSON upfront so malformed cards fail fast with a clear message
  JSON.parse(jsonText);
  return jsonText;
}

export async function createThumbnailDataUrl(file: Blob, maxSize = 160): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return undefined;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = objectUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return undefined;

    const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, dstW, dstH);

    const webp = canvas.toDataURL('image/webp', 0.82);
    if (webp.startsWith('data:image/webp')) {
      return webp;
    }
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function unpackCharacterCardPng(
  file: File,
): Promise<{ jsonText: string; avatarDataUrl?: string }> {
  const buf = await file.arrayBuffer();
  const jsonText = extractCardJsonFromPngBuffer(buf);
  const avatarDataUrl = await createThumbnailDataUrl(file, 160);
  return { jsonText, avatarDataUrl };
}
