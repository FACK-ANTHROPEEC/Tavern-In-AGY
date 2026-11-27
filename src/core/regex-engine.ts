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
      if (script.substituteRegex === 2) {
        // ESCAPED mode: escape ONLY the macro replacement values, preserving regex metacharacters in findRegex
        patternStr = patternStr.replace(/\{\{[^{}]+\}\}/g, (macroToken) =>
          escapeRegexChars(evaluateMacros(macroToken, opts.macroCtx!)),
        );
      } else {
        patternStr = evaluateMacros(patternStr, opts.macroCtx);
      }
    }

    const regex = parseStRegex(patternStr);
    if (!regex) continue;

    const rawReplace = script.replaceString ?? '';
    const trimStrings = script.trimStrings;

    try {
      text = text.replace(regex, (...args: unknown[]) => {
        const fullMatch = String(args[0] ?? '');
        const lastArg = args[args.length - 1];
        const namedGroups: Record<string, string | undefined> | null =
          lastArg && typeof lastArg === 'object' ? (lastArg as Record<string, string | undefined>) : null;
        const positionalEnd = namedGroups ? args.length - 3 : args.length - 2;

        // Extract positional capture groups (before offset, source string, and optional named groups)
        const groups: string[] = [];
        for (let i = 1; i < positionalEnd; i++) {
          const g = args[i];
          if (typeof g === 'string') {
            groups.push(applyTrimStrings(g, trimStrings));
          } else if (typeof g === 'number') {
            break;
          } else {
            groups.push('');
          }
        }

        const trimmedMatch = applyTrimStrings(fullMatch, trimStrings);

        // Single-pass replacement on rawReplace so `$` sequences inside matched prose are never re-interpreted,
        // `$$` unescapes to literal `$`, `$&` / `{{match}}` resolve safely, and `$<name>` named captures work.
        let replaced = rawReplace.replace(
          /\{\{match\}\}|\$\$|\$&|\$<([^>]+)>|\$(\d{1,2})/gi,
          (tok, namedRef: string | undefined, numRef: string | undefined) => {
            if (tok.toLowerCase() === '{{match}}') return trimmedMatch;
            if (tok === '$$') return '$';
            if (tok === '$&') return trimmedMatch;
            if (namedRef !== undefined) {
              if (namedGroups && Object.prototype.hasOwnProperty.call(namedGroups, namedRef)) {
                return applyTrimStrings(String(namedGroups[namedRef] ?? ''), trimStrings);
              }
              return tok;
            }
            if (numRef !== undefined) {
              const idx = Number(numRef) - 1;
              if (idx >= 0 && idx < groups.length) {
                return groups[idx] ?? '';
              }
              return tok;
            }
            return tok;
          },
        );

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

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STANDARD_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed', 'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p',
  'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script',
  'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'text', 'tspan', 'use', 'symbol',
  'clippath', 'mask', 'filter', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot',
  'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

const PROSE_WRAPPER_TAGS = new Set([
  'content', 'story', 'narrative', 'prose', 'response', 'reply', 'dialogue', 'story_text',
  'scene_text',
]);

function pickTagIcon(tagLower: string): string {
  if (/think|thought|cot|reason|mind/.test(tagLower)) return '💭';
  if (/plan|outline|draft|director|stage|beat/.test(tagLower)) return '📋';
  if (/summary|recap|memory|log|chronicle/.test(tagLower)) return '📝';
  if (/status|stat|panel|hud|sheet|state/.test(tagLower)) return '📊';
  if (/option|choice|action|branch|move/.test(tagLower)) return '🧭';
  if (/review|check|audit|eval|comment|note|disclaimer|report/.test(tagLower)) return '🔍';
  if (/background|lore|world|setting|scene/.test(tagLower)) return '📜';
  return '🏷️';
}

/**
 * Generic post-regex fallback for ANY unknown custom XML tags (from unseen presets or cards).
 * - Protects fenced code blocks and full HTML documents from modification.
 * - Unwraps generic prose container tags (e.g. `<content>`, `<narrative>`, `<story>`).
 * - Strips leftover self-closing custom placeholder tags (e.g. `<StatusPlaceHolderImpl/>`) if no regex consumed them.
 * - Folds all other non-HTML paired custom tags (`<foo_bar>...</foo_bar>`) into native zero-script `<details>` drawers
 *   so unknown preset/card metadata NEVER leaks raw into narrative prose.
 */
export function foldUnknownCustomTags(
  input: string,
  mode: 'fold' | 'keep' | 'hide' = 'fold',
): string {
  if (!input) return input;

  // 1. Protect fenced blocks and full HTML documents so we never mangle card/preset HTML widgets
  const placeholders: string[] = [];
  const stash = (match: string): string => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\u0000TAVERN_PROTECTED_${idx}\u0000`;
  };

  let out = input.replace(
    /```[\s\S]*?```|<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>|<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>/gi,
    stash,
  );

  // 2. Strip leftover self-closing non-HTML placeholder tags (e.g. <StatusPlaceHolderImpl/>)
  out = out.replace(/<([a-zA-Z][\w:-]*)(?:\s[^>]*)?\s*\/>/g, (full, rawTag: string) => {
    const lower = rawTag.toLowerCase();
    return STANDARD_HTML_TAGS.has(lower) ? full : '';
  });

  // 3. Iteratively unwrap prose containers and handle any remaining paired custom XML tags
  const pairedTagRe = /<([a-zA-Z][\w:-]*~?)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    out = out.replace(pairedTagRe, (full, rawTag: string, inner: string) => {
      const normalized = rawTag.replace(/~$/, '').toLowerCase();
      if (STANDARD_HTML_TAGS.has(normalized)) {
        return full;
      }
      const trimmedInner = inner.trim();
      if (!trimmedInner) {
        changed = true;
        return '';
      }
      if (PROSE_WRAPPER_TAGS.has(normalized)) {
        changed = true;
        return `\n${trimmedInner}\n`;
      }
      if (mode === 'keep') {
        return full;
      }
      changed = true;
      if (mode === 'hide') {
        return '';
      }
      const icon = pickTagIcon(normalized);
      const safeBody = escapeHtmlText(trimmedInner).replace(/\n/g, '<br/>');
      return `\n<details><summary>${icon} ${escapeHtmlText(rawTag.replace(/~$/, ''))}</summary><div class="cot-body">${safeBody}</div></details>\n`;
    });
    if (!changed) break;
  }

  // 4. Restore protected blocks
  out = out.replace(/\u0000TAVERN_PROTECTED_(\d+)\u0000/g, (_m, idxStr: string) => {
    return placeholders[Number(idxStr)] ?? '';
  });

  return out;
}

/**
 * Strips potentially executable attributes/tags from static HTML fragments
 * intended for inline native rendering (e.g. `<details><summary>...</summary></details>`).
 * Defends against slash-separated attributes (`<img src=x/onerror=...>`, `<svg/onload=...>`),
 * embedded active containers (`<iframe>`, `<object>`, `<embed>`), and entity-encoded `javascript:` URIs.
 */
export function sanitizeStaticHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?(?:<\/\1>|\/?>)/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/[\s/]+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(?:href|src|xlink:href|formaction|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (full, d?: string, s?: string, u?: string) => {
      const val = d ?? s ?? u ?? '';
      const decoded = val
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/[\u0000-\u0020]+/g, '')
        .toLowerCase();
      if (decoded.startsWith('javascript:') || decoded.startsWith('vbscript:') || decoded.startsWith('data:text/html')) {
        return '';
      }
      return full;
    })
    .replace(/javascript:/gi, '');
}

function needsSandboxWidget(html: string): boolean {
  return (
    /<!doctype\s+html/i.test(html) ||
    /<html\b/i.test(html) ||
    /<script\b/i.test(html) ||
    /<style\b/i.test(html) ||
    /<(?:iframe|object|embed)\b/i.test(html) ||
    /[\s/]+on[a-z]+\s*=/i.test(html)
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

function hasUnclosedContainerTag(fragment: string): boolean {
  const tags = ['div', 'section', 'article', 'aside', 'blockquote'];
  for (const tag of tags) {
    const opens = (fragment.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? []).length;
    const closes = (fragment.match(new RegExp(`<\\/${tag}>`, 'gi')) ?? []).length;
    if (opens > closes) return true;
  }
  return false;
}

/**
 * Deterministic 3-way splitter for post-regex AI floor output:
 * 1. `widget`: Fenced ```html ...``` blocks, full HTML documents, or any HTML containing `<style>`/`<script>`/event handlers -> sandbox iframe host
 * 2. `html`: Static lightweight HTML blocks (e.g., `<details>...</details>`) without styles/scripts -> native inline HTML
 * 3. `text`: Plain narrative / Markdown paragraphs -> Warm Ink Serif reader
 */
export function splitFloorSegments(input: string): FloorSegment[] {
  if (!input || !input.trim()) return [];

  const segments: FloorSegment[] = [];
  // Match in priority order:
  // 1) Fenced ```html ... ``` blocks
  // 2) Full <!DOCTYPE html>...</html> or <html>...</html> documents
  // 3) <details>...</details> blocks (only when NOT nested inside an unclosed outer container like <div>)
  const blockPattern =
    /```html[ \t]*\r?\n([\s\S]*?)```|(<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>)|(<details\b[\s\S]*?<\/details>)/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(input)) !== null) {
    const fencedHtml = match[1];
    const fullDocHtml = match[2];
    const detailsHtml = match[3];

    // If this <details> sits inside an unclosed outer <div>/<section>/etc., skip splitting so the outer wrapper stays intact
    if (detailsHtml !== undefined && hasUnclosedContainerTag(input.slice(lastIndex, match.index))) {
      continue;
    }

    if (match.index > lastIndex) {
      const before = input.slice(lastIndex, match.index).trim();
      if (before) {
        pushTextOrHtml(segments, before);
      }
    }

    if (fencedHtml !== undefined) {
      const trimmed = fencedHtml.trim();
      if (needsSandboxWidget(trimmed)) {
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
      if (needsSandboxWidget(detailsHtml)) {
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
  if (needsSandboxWidget(chunk)) {
    // Preserve leading plain prose before the first styled/interactive HTML block so prose stays Warm Ink Serif
    const firstHtmlTag = chunk.search(/<(?:!doctype|html|style|script|div|section|aside|article|table|nav|header|footer|blockquote)\b/i);
    if (firstHtmlTag > 0) {
      const leading = chunk.slice(0, firstHtmlTag).trim();
      const htmlPart = chunk.slice(firstHtmlTag).trim();
      if (leading) {
        segments.push({ kind: 'text', content: leading });
      }
      if (htmlPart) {
        segments.push({ kind: 'widget', html: htmlPart, title: extractHtmlTitle(htmlPart) });
      }
      return;
    }
    segments.push({ kind: 'widget', html: chunk, title: extractHtmlTitle(chunk) });
    return;
  }
  // If chunk contains inline lightweight HTML wrapper tags like <div style=...> or <table>
  if (/<(div|section|blockquote|table|aside|article|figure|hr)\b/i.test(chunk)) {
    segments.push({ kind: 'html', html: sanitizeStaticHtml(chunk) });
    return;
  }
  segments.push({ kind: 'text', content: chunk });
}
