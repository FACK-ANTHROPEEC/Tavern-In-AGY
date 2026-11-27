import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createDefaultConfig,
  createDefaultState,
  type CharacterCard,
  type Lorebook,
  type PendingForkContext,
  type Preset,
  type SessionRuntime,
  type SessionSnapshot,
  type TavernConfig,
} from './types.js';

export function resolveDataDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.TAVERN_DATA_DIR) return path.resolve(process.env.TAVERN_DATA_DIR);
  if (process.env.PLUGIN_DATA) return path.resolve(process.env.PLUGIN_DATA);
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', 'tavern-in-agy', 'data');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback spin for environments without SharedArrayBuffer
    }
  }
}

/**
 * Windows-safe atomic rename with brief retry backoff on transient EPERM/EACCES/EBUSY
 * caused by concurrent MCP/hook processes or antivirus/indexer locks, plus guaranteed `.tmp` cleanup.
 */
export function renameWithRetry(tmpPath: string, filePath: string, maxAttempts = 6): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        sleepSync(12 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // ignore cleanup failure
  }
  throw lastErr;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  const tmpPath = `${filePath}.${nonce}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameWithRetry(tmpPath, filePath);
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt < 3 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || err instanceof SyntaxError)) {
        sleepSync(10 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
}

export class TavernStorage {
  readonly rootDir: string;

  constructor(dataDir?: string) {
    this.rootDir = resolveDataDir(dataDir);
    ensureDir(this.rootDir);
  }

  private subPath(...parts: string[]): string {
    return path.join(this.rootDir, ...parts);
  }

  // --- Config ---
  getConfig(): TavernConfig {
    const saved = readJsonSafe<Partial<TavernConfig>>(this.subPath('config.json'));
    return { ...createDefaultConfig(), ...(saved ?? {}) };
  }

  saveConfig(patch: Partial<TavernConfig>): TavernConfig {
    const merged = { ...this.getConfig(), ...patch };
    writeJsonAtomic(this.subPath('config.json'), merged);
    return merged;
  }

  // --- Character Cards ---
  listCards(): CharacterCard[] {
    return this.listCollection<CharacterCard>('cards');
  }

  getCard(id: string): CharacterCard | null {
    return readJsonSafe<CharacterCard>(this.subPath('cards', `${safeId(id)}.json`));
  }

  saveCard(card: CharacterCard): CharacterCard {
    writeJsonAtomic(this.subPath('cards', `${safeId(card.id)}.json`), card);
    return card;
  }

  deleteCard(id: string): boolean {
    const p = this.subPath('cards', `${safeId(id)}.json`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    const cfg = this.getConfig();
    if (cfg.activeCardId === id) {
      this.saveConfig({ activeCardId: null });
    }
    return true;
  }

  // --- Presets ---
  listPresets(): Preset[] {
    return this.listCollection<Preset>('presets');
  }

  getPreset(id: string): Preset | null {
    return readJsonSafe<Preset>(this.subPath('presets', `${safeId(id)}.json`));
  }

  savePreset(preset: Preset): Preset {
    writeJsonAtomic(this.subPath('presets', `${safeId(preset.id)}.json`), preset);
    return preset;
  }

  deletePreset(id: string): boolean {
    const p = this.subPath('presets', `${safeId(id)}.json`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    const cfg = this.getConfig();
    if (cfg.activePresetId === id) {
      this.saveConfig({ activePresetId: null });
    }
    return true;
  }

  // --- Lorebooks ---
  listLorebooks(): Lorebook[] {
    return this.listCollection<Lorebook>('lorebooks');
  }

  getLorebook(id: string): Lorebook | null {
    return readJsonSafe<Lorebook>(this.subPath('lorebooks', `${safeId(id)}.json`));
  }

  saveLorebook(book: Lorebook): Lorebook {
    writeJsonAtomic(this.subPath('lorebooks', `${safeId(book.id)}.json`), book);
    return book;
  }

  deleteLorebook(id: string): boolean {
    const p = this.subPath('lorebooks', `${safeId(id)}.json`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    const cfg = this.getConfig();
    if (cfg.activeLorebookIds.includes(id)) {
      this.saveConfig({
        activeLorebookIds: cfg.activeLorebookIds.filter((x) => x !== id),
      });
    }
    return true;
  }

  // --- Session Runtime ---
  getSession(conversationId: string): SessionRuntime {
    const p = this.subPath('sessions', `${safeId(conversationId)}.json`);
    const existing = readJsonSafe<SessionRuntime>(p);
    if (existing) {
      return {
        ...existing,
        statData: existing.statData ?? {},
        state: { ...createDefaultState(), ...(existing.state ?? {}) },
      };
    }
    return {
      conversationId,
      turnCount: 0,
      lastUserInputHash: '',
      injectedLorebookTurns: {},
      lastStateInjectedHash: '',
      lastPostHistoryTurn: 0,
      recentMessages: [],
      variables: {},
      statData: {},
      state: createDefaultState(),
      latestOptions: [],
    };
  }

  saveSession(session: SessionRuntime): SessionRuntime {
    writeJsonAtomic(
      this.subPath('sessions', `${safeId(session.conversationId)}.json`),
      session,
    );
    return session;
  }

  // --- Snapshots ---
  listSnapshots(): SessionSnapshot[] {
    return this.listCollection<SessionSnapshot>('snapshots');
  }

  saveSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
    writeJsonAtomic(this.subPath('snapshots', `${safeId(snapshot.id)}.json`), snapshot);
    return snapshot;
  }

  // --- Pending Branch Fork (consumed once on next SessionStart) ---
  setPendingFork(fork: PendingForkContext): void {
    writeJsonAtomic(this.subPath('pending-fork.json'), fork);
  }

  consumePendingFork(): PendingForkContext | null {
    const p = this.subPath('pending-fork.json');
    const data = readJsonSafe<PendingForkContext>(p);
    if (data && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
    return data;
  }

  private listCollection<T>(folder: string): T[] {
    const dir = this.subPath(folder);
    if (!fs.existsSync(dir)) return [];
    const results: T[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const item = readJsonSafe<T>(path.join(dir, file));
      if (item) results.push(item);
    }
    return results;
  }
}
