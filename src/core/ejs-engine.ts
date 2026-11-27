import ejs from 'ejs';
import * as lodashEs from 'lodash-es';
import type { CharacterCard, Lorebook } from './types.js';
import { getByDotPath, setByDotPath } from './mvu-engine.js';

export interface EjsTemplateContext {
  statData: Record<string, unknown>;
  vars: Record<string, string>;
  card?: CharacterCard | null;
  lorebooks?: Lorebook[];
  userName?: string;
}

/**
 * Generic ST-Prompt-Template (EJS) renderer.
 * Supports `<% ... %>`, `<%- ... %>`, `<%_ ... _%>`, `print(...)`, `@@preprocessing`,
 * `getvar(key, { defaults })`, `setvar(key, val)`, `getwi(title)`, `getchar()`, and `_` (lodash).
 */
export function renderEjsTemplate(template: string, ctx: EjsTemplateContext): string {
  if (!template || !template.includes('<%')) {
    return template;
  }

  // Strip ST-Prompt-Template `@@preprocessing` marker line if present
  const cleaned = template.replace(/^\s*@@preprocessing\s*\r?\n?/i, '');

  const getvar = (key: string, opts?: { defaults?: unknown; scope?: string }): unknown => {
    const trimmed = String(key || '').trim();
    if (!trimmed) return opts?.defaults;

    // 1. Direct `stat_data` / `display_data` / `delta_data`
    if (trimmed === 'stat_data' || trimmed === 'display_data') {
      return ctx.statData;
    }
    if (trimmed === 'delta_data') {
      return {};
    }
    if (trimmed.startsWith('stat_data.')) {
      const subPath = trimmed.slice('stat_data.'.length);
      const val = getByDotPath(ctx.statData, subPath);
      return val !== undefined ? val : opts?.defaults;
    }
    if (trimmed.startsWith('display_data.')) {
      const subPath = trimmed.slice('display_data.'.length);
      const val = getByDotPath(ctx.statData, subPath);
      return val !== undefined ? val : opts?.defaults;
    }

    // 2. Flat string vars
    if (trimmed in ctx.vars) {
      return ctx.vars[trimmed];
    }

    // 3. Fallback: try dot-path inside statData directly
    const direct = getByDotPath(ctx.statData, trimmed);
    if (direct !== undefined) return direct;

    return opts?.defaults;
  };

  const setvar = (key: string, value: unknown): void => {
    const trimmed = String(key || '').trim();
    if (!trimmed) return;
    if (trimmed === 'stat_data' && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(ctx.statData, value);
      return;
    }
    if (trimmed.startsWith('stat_data.')) {
      setByDotPath(ctx.statData, trimmed.slice('stat_data.'.length), value);
      return;
    }
    ctx.vars[trimmed] = String(value ?? '');
  };

  const getwi = (title: string): string => {
    const needle = String(title || '').trim().toLowerCase();
    for (const book of ctx.lorebooks ?? []) {
      for (const entry of book.entries) {
        if ((entry.comment || '').trim().toLowerCase() === needle) {
          return entry.content;
        }
      }
    }
    return '';
  };

  const getchar = () => ({
    name: ctx.card?.name ?? '',
    description: ctx.card?.description ?? '',
    personality: ctx.card?.personality ?? '',
    scenario: ctx.card?.scenario ?? '',
  });

  const variables = {
    ...ctx.vars,
    stat_data: ctx.statData,
    display_data: ctx.statData,
    delta_data: {},
  };

  try {
    return ejs.render(
      cleaned,
      {
        getvar,
        setvar,
        getwi,
        getchar,
        variables,
        stat_data: ctx.statData,
        display_data: ctx.statData,
        delta_data: {},
        user: ctx.userName ?? 'User',
        char: ctx.card?.name ?? '',
        _: lodashEs,
      },
      {
        outputFunctionName: 'print',
      },
    );
  } catch {
    // Graceful fallback: never crash prompt assembly on card-specific global refs
    return cleaned;
  }
}
