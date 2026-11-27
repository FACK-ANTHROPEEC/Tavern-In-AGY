import fs from 'node:fs';

export interface ParsedWaveOption {
  label: string;
  category: string;
  text: string;
}

/**
 * Defensively reads recent text snippets from an Antigravity transcript.jsonl file.
 * Never throws if the file is missing or its internal schema changes in future AGY versions.
 */
export function readRecentTranscriptTexts(
  transcriptPath: string | undefined,
  maxLines = 40,
): string[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    const texts: string[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const extracted = extractTextFromRecord(obj);
        if (extracted) texts.push(extracted);
      } catch {
        // Ignore malformed lines
      }
    }
    return texts;
  } catch {
    return [];
  }
}

function extractTextFromRecord(obj: Record<string, unknown>, depth = 0): string {
  if (depth > 4) return '';
  const candidates = ['text', 'content', 'userMessage', 'assistantMessage', 'response', 'message'];
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = extractTextFromRecord(val as Record<string, unknown>, depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

/**
 * Reads a stable stamp (`step_index|created_at`) for the most recent USER_INPUT record
 * in an Antigravity transcript.jsonl file so PreInvocation can deduplicate all follow-up
 * LLM calls within the same user turn (e.g. after invoke_subagent or manage_subagents).
 */
export function readLastUserInputStamp(transcriptPath: string | undefined): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        if (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT') {
          const step = obj.step_index !== undefined ? String(obj.step_index) : '';
          const ts = typeof obj.created_at === 'string' ? obj.created_at : '';
          if (step || ts) {
            return `${step}|${ts}`;
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts `<wave_options>...</wave_options>` style numbered action choices
 * from the most recent assistant message for clickable side-pane buttons.
 */
export function extractWaveOptions(texts: string[]): ParsedWaveOption[] {
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    const match = t.match(/<wave_options>([\s\S]*?)<\/wave_options>/i);
    if (!match) continue;

    const body = match[1].trim();
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const options: ParsedWaveOption[] = [];
    for (const line of lines) {
      // Matches patterns like: "1. **稳步推进**：行动文本" or "1. 稳步推进: 行动文本"
      const m = line.match(/^(\d+)[\.、]\s*\*?\*?([^：:*]+)\*?\*?[：:]\s*(.+)$/);
      if (m) {
        options.push({
          label: `${m[1]}. ${m[2].trim()}`,
          category: m[2].trim(),
          text: m[3].trim(),
        });
      }
    }
    if (options.length > 0) return options;
  }
  return [];
}
