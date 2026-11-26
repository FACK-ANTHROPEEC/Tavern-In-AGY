import type { RegexScript } from './types.js';
import { evaluateMacros, type MacroContext } from './macro-engine.js';

export interface RegexRunOptions {
  /** 1 = User Input, 2 = AI Output */
  placement: 1 | 2;
  /** 'display' = side-pane reader; 'prompt' = model context / fork resume compression */
  target: 'display' | 'prompt';
  /** 0 = latest message, 1 = previous message, etc. */
  depth: number;
  macroCtx?: MacroContext;
}

export type FloorSegment =
  | { kind: 'text'; content: string }
  | { kind: 'html'; html: string }
  | { kind: 'widget'; html: string; title?: string };

function escapeRegexChars(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a SillyTavern regex string (either `/pattern/flags` or bare `pattern`).
 */
export function parseStRegex(rawPattern: string): RegExp | null {
  if (!rawPattern) return null;
  const trimmed = rawPattern.trim();
  if (!trimmed) return null;

  const slashMatch = trimmed.match(/^\/([\s\S]+)\/([gimsuyd]*)$/);
  try {
    if (slashMatch) {
      return new RegExp(slashMatch[1], slashMatch[2]);
    }
    return new RegExp(trimmed, 'g');
  } catch {
    return null;
  }
}

function applyTrimStrings(value: string, trimStrings?: string[]): string {
  if (!trimStrings || trimStrings.length === 0 || !value) return value;
  let out = value;
  for (const t of trimStrings) {
    if (!t) continue;
    out = out.split(t).join('');
  }
  return out;
}

function shouldRunScript(script: RegexScript, opts: RegexRunOptions): boolean {
  if (script.disabled) return false;
  if (!script.findRegex || !script.findRegex.trim()) return false;

  // Placement check (if placement is non-empty, must include opts.placement)
  if (Array.isArray(script.placement) && script.placement.length > 0) {
    if (!script.placement.includes(opts.placement)) return false;
  }

  // Target check: ST semantics
  // - markdownOnly=true, promptOnly=false -> display only
  // - markdownOnly=false, promptOnly=true -> prompt only
  // - both true or both false -> runs on both
  const md = Boolean(script.markdownOnly);
  const pr = Boolean(script.promptOnly);
  if (opts.target === 'display' && pr && !md) return false;
  if (opts.target === 'prompt' && md && !pr) return false;

  // Depth check (inclusive bounds, matching ST regex engine)
  if (typeof script.minDepth === 'number' && !Number.isNaN(script.minDepth)) {
    if (opts.depth < script.minDepth) return false;
  }
  if (typeof script.maxDepth === 'number' && !Number.isNaN(script.maxDepth)) {
    if (opts.depth > script.maxDepth) return false;
  }

  return true;
}

/**
 * Executes a list of SillyTavern regex scripts in order, honoring placement,
 * markdownOnly/promptOnly, minDepth/maxDepth, trimStrings, {{match}}, and substituteRegex.
 */
export function applyRegexScripts(
  input: string,
  scripts: RegexScript[],
  opts: RegexRunOptions,
): string {
  if (!input || !scripts || scripts.length === 0) return input;

  let text = input;

  for (const script of scripts) {
    if (!shouldRunScript(script, opts)) continue;

    let patternStr = script.findRegex;
    if (opts.macroCtx && (script.substituteRegex === 1 || script.substituteRegex === 2)) {
      const evaluated = evaluateMacros(patternStr, opts.macroCtx);
      patternStr = script.substituteRegex === 2 ? escapeRegexChars(evaluated) : evaluated;
    }

    const regex = parseStRegex(patternStr);
    if (!regex) continue;

    const rawReplace = script.replaceString ?? '';
    const trimStrings = script.trimStrings;

    try {
      text = text.replace(regex, (...args: unknown[]) => {
        const fullMatch = String(args[0] ?? '');
        // Extract positional capture groups (before offset & source string)
        const groups: string[] = [];
        for (let i = 1; i < args.length - 2; i++) {
          const g = args[i];
          if (typeof g === 'string') {
            groups.push(applyTrimStrings(g, trimStrings));
          } else if (typeof g === 'number') {
            // Reached offset argument
            break;
          } else {
            groups.push('');
          }
        }

        const trimmedMatch = applyTrimStrings(fullMatch, trimStrings);
        let replaced = rawReplace.replace(/\{\{match\}\}/gi, trimmedMatch);

        // Replace $1..$99 and $<name> capture references
        replaced = replaced.replace(/\$(\d{1,2}|\&)/g, (tok, ref: string) => {
          if (ref === '&') return trimmedMatch;
          const idx = Number(ref) - 1;
          if (idx >= 0 && idx < groups.length) {
            return groups[idx] ?? '';
          }
          return tok;
        });

        if (opts.macroCtx && replaced.includes('{{')) {
          replaced = evaluateMacros(replaced, opts.macroCtx);
        }

        return replaced;
      });
    } catch {
      // Defensive: never crash on a pathological user regex
    }
  }

  return text;
}

/**
 * Strips potentially executable attributes/tags from static HTML fragments
 * intended for inline native rendering (e.g. `<details><summary>...</summary></details>`).
 */
export function sanitizeStaticHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function isInteractiveHtml(html: string): boolean {
  return (
    /<!doctype\s+html/i.test(html) ||
    /<html\b/i.test(html) ||
    /<script\b/i.test(html) ||
    /\son(?:click|change|input|submit|load)\s*=/i.test(html)
  );
}

function extractHtmlTitle(html: string): string | undefined {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim();
  const sumMatch = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  if (sumMatch?.[1]?.trim()) {
    return sumMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 40);
  }
  return undefined;
}

/**
 * Deterministic 3-way splitter for post-regex AI floor output:
 * 1. `widget`: Fenced ```html ...``` blocks or standalone HTML+JS documents/fragments -> sandbox iframe host
 * 2. `html`: Static lightweight HTML blocks (e.g., `<details>...</details>`) without scripts -> native inline HTML
 * 3. `text`: Plain narrative / Markdown paragraphs -> Warm Ink Serif reader
 */
export function splitFloorSegments(input: string): FloorSegment[] {
  if (!input || !input.trim()) return [];

  const segments: FloorSegment[] = [];
  // Match in priority order:
  // 1) Fenced ```html ... ``` blocks
  // 2) Full <!DOCTYPE html>...</html> or <html>...</html> documents
  // 3) <details>...</details> blocks (which may be static or interactive)
  const blockPattern =
    /```html[ \t]*\r?\n([\s\S]*?)```|(<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>)|(<details\b[\s\S]*?<\/details>)/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      const before = input.slice(lastIndex, match.index).trim();
      if (before) {
        pushTextOrHtml(segments, before);
      }
    }

    const fencedHtml = match[1];
    const fullDocHtml = match[2];
    const detailsHtml = match[3];

    if (fencedHtml !== undefined) {
      const trimmed = fencedHtml.trim();
      if (isInteractiveHtml(trimmed) || /<style\b/i.test(trimmed)) {
        segments.push({ kind: 'widget', html: trimmed, title: extractHtmlTitle(trimmed) });
      } else {
        segments.push({ kind: 'html', html: sanitizeStaticHtml(trimmed) });
      }
    } else if (fullDocHtml !== undefined) {
      segments.push({
        kind: 'widget',
        html: fullDocHtml.trim(),
        title: extractHtmlTitle(fullDocHtml),
      });
    } else if (detailsHtml !== undefined) {
      if (isInteractiveHtml(detailsHtml)) {
        segments.push({
          kind: 'widget',
          html: detailsHtml.trim(),
          title: extractHtmlTitle(detailsHtml),
        });
      } else {
        segments.push({ kind: 'html', html: sanitizeStaticHtml(detailsHtml.trim()) });
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) {
    const tail = input.slice(lastIndex).trim();
    if (tail) {
      pushTextOrHtml(segments, tail);
    }
  }

  return segments;
}

function pushTextOrHtml(segments: FloorSegment[], chunk: string): void {
  if (isInteractiveHtml(chunk)) {
    segments.push({ kind: 'widget', html: chunk, title: extractHtmlTitle(chunk) });
    return;
  }
  // If chunk contains inline lightweight HTML wrapper tags like <div style=...> or <span class=...>
  if (/<(div|section|blockquote|table|style)\b/i.test(chunk)) {
    segments.push({ kind: 'html', html: sanitizeStaticHtml(chunk) });
    return;
  }
  segments.push({ kind: 'text', content: chunk });
}
