import { describe, it, expect } from 'vitest';
import { evaluateMacros, type MacroContext } from '../src/core/macro-engine.js';

function makeCtx(overrides?: Partial<MacroContext>): MacroContext {
  return {
    char: 'Shizi',
    user: 'Master',
    persona: 'A calm architect',
    scenario: 'A quiet study room',
    vars: {},
    rng: () => 0,
    ...overrides,
  };
}

describe('macro-engine', () => {
  it('replaces standard macros and strips comments', () => {
    const ctx = makeCtx();
    const out = evaluateMacros(
      'Hello {{user}}, I am {{char}}.{{// hidden note}} Scene: {{scenario}}',
      ctx,
    );
    expect(out).toBe('Hello Master, I am Shizi. Scene: A quiet study room');
  });

  it('supports multi-line setvar, getvar, and addvar', () => {
    const ctx = makeCtx();
    const tpl = [
      '{{setvar::style::line 1\nline 2\nline 3}}',
      '{{setvar::score::10}}',
      '{{addvar::score::5}}',
      'STYLE={{getvar::style}}|SCORE={{getvar::score}}',
    ].join('');
    const out = evaluateMacros(tpl, ctx);
    expect(out).toBe('STYLE=line 1\nline 2\nline 3|SCORE=15');
  });

  it('supports nested macros (innermost-first)', () => {
    const ctx = makeCtx({ rng: () => 0.6 });
    const tpl =
      '{{setvar::mood::{{random::calm::playful}}}}{{setvar::line::{{char}} feels {{getvar::mood}}}}{{getvar::line}}';
    expect(evaluateMacros(tpl, ctx)).toBe('Shizi feels playful');
  });

  it('evaluates 2000 random macros fast in O(N)', () => {
    const ctx = makeCtx({ rng: () => 0.5 });
    const big = '{{random::a::b::c::d}}'.repeat(2000);
    const t0 = Date.now();
    const out = evaluateMacros(big, ctx);
    const elapsed = Date.now() - t0;
    expect(out.length).toBe(2000);
    expect(out).toBe('c'.repeat(2000));
    expect(elapsed).toBeLessThan(200);
  });

  it('handles trim directive cleanly', () => {
    const ctx = makeCtx();
    expect(evaluateMacros('A\n  {{trim}}  \nB', ctx)).toBe('AB');
  });
});
