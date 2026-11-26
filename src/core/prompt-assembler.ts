import crypto from 'node:crypto';
import type {
  CharacterCard,
  LiveCharacterState,
  Lorebook,
  Preset,
  SessionRuntime,
  TavernConfig,
} from './types.js';
import { evaluateMacros, type MacroContext } from './macro-engine.js';
import { compilePreset } from './preset-parser.js';
import { scanLorebooks } from './lorebook-engine.js';

export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function formatCompactState(state: LiveCharacterState, charName: string): string {
  const lines: string[] = [`[Live RP State · ${charName}]`];
  if (state.timeOfDay) lines.push(`- Time: ${state.timeOfDay}`);
  if (state.location) lines.push(`- Location: ${state.location}`);
  if (state.mood) lines.push(`- Mood: ${state.mood}`);
  if (state.outfit) lines.push(`- Outfit: ${state.outfit}`);
  if (state.affection !== 0) lines.push(`- Affection: ${state.affection}`);
  if (state.inventory.length > 0) lines.push(`- Inventory: ${state.inventory.join(', ')}`);
  if (state.activeGoals.length > 0) lines.push(`- Active Goals: ${state.activeGoals.join('; ')}`);
  for (const [k, v] of Object.entries(state.customFields)) {
    if (v) lines.push(`- ${k}: ${v}`);
  }
  if (state.summary) lines.push(`- Recent Summary: ${state.summary}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

export interface SessionStartBundle {
  systemMessage: string;
  variables: Record<string, string>;
  stats: {
    staticChars: number;
    constantLorebookCount: number;
  };
}

export function assembleSessionStart(params: {
  config: TavernConfig;
  card: CharacterCard;
  preset: Preset | null;
  lorebooks: Lorebook[];
  session: SessionRuntime;
  resumedStoryBlock?: string;
}): SessionStartBundle {
  const { config, card, preset, lorebooks, session, resumedStoryBlock } = params;
  const allBooks = card.embeddedLorebook ? [card.embeddedLorebook, ...lorebooks] : lorebooks;

  const ctx: MacroContext = {
    char: card.name,
    user: config.userName || 'User',
    persona: config.userPersona,
    scenario: card.scenario,
    vars: { ...session.variables },
  };

  const scan = scanLorebooks(allBooks, {
    recentMessages: [],
    currentTurn: 0,
    cooldownTurns: config.cooldownTurns,
    injectedLorebookTurns: {},
  });

  const wiBefore = scan.constantBefore.map((x) => x.entry.content).join('\n\n');
  const wiAfter = scan.constantAfter.map((x) => x.entry.content).join('\n\n');

  const slots = {
    worldInfoBefore: wiBefore,
    personaDescription: config.userPersona,
    charDescription: card.description,
    charPersonality: card.personality,
    scenario: card.scenario,
    worldInfoAfter: wiAfter,
    dialogueExamples: card.messageExample,
  };

  const parts: string[] = [];

  if (preset) {
    const compiled = compilePreset(preset, ctx, slots);
    if (compiled.staticText) {
      parts.push(compiled.staticText);
    }
    Object.assign(ctx.vars, compiled.variables);
  } else {
    // Fallback assembly when no preset is selected
    if (wiBefore) parts.push(`[World Info]\n${evaluateMacros(wiBefore, ctx)}`);
    if (card.systemPrompt) parts.push(evaluateMacros(card.systemPrompt, ctx));
    parts.push(`[Character: ${card.name}]\n${evaluateMacros(card.description, ctx)}`);
    if (card.personality) parts.push(`[Personality]\n${evaluateMacros(card.personality, ctx)}`);
    if (card.scenario) parts.push(`[Scenario]\n${evaluateMacros(card.scenario, ctx)}`);
    if (config.userPersona) parts.push(`[User Persona: ${ctx.user}]\n${evaluateMacros(config.userPersona, ctx)}`);
    if (wiAfter) parts.push(`[Additional World Info]\n${evaluateMacros(wiAfter, ctx)}`);
    if (card.messageExample) parts.push(`[Dialogue Examples]\n${evaluateMacros(card.messageExample, ctx)}`);
  }

  if (card.firstMessage) {
    parts.push(`[Opening Scene Reference]\n${evaluateMacros(card.firstMessage, ctx)}`);
  }

  const compactState = formatCompactState(session.state, card.name);
  if (compactState) {
    parts.push(compactState);
  }

  if (resumedStoryBlock && resumedStoryBlock.trim()) {
    parts.push(resumedStoryBlock.trim());
  }

  const systemMessage = parts.filter((p) => p.trim().length > 0).join('\n\n---\n\n');

  return {
    systemMessage,
    variables: { ...ctx.vars },
    stats: {
      staticChars: systemMessage.length,
      constantLorebookCount: scan.constantBefore.length + scan.constantAfter.length,
    },
  };
}

export interface PreInvocationBundle {
  systemMessage: string;
  triggeredLorebookKeys: string[];
  skippedByCooldown: string[];
  injectedPostHistory: boolean;
  injectedState: boolean;
  stateHash: string;
  variables: Record<string, string>;
}

export function assemblePreInvocation(params: {
  config: TavernConfig;
  card: CharacterCard;
  preset: Preset | null;
  lorebooks: Lorebook[];
  session: SessionRuntime;
  recentMessages: string[];
}): PreInvocationBundle {
  const { config, card, preset, lorebooks, session, recentMessages } = params;
  const allBooks = card.embeddedLorebook ? [card.embeddedLorebook, ...lorebooks] : lorebooks;
  const nextTurn = session.turnCount + 1;

  const ctx: MacroContext = {
    char: card.name,
    user: config.userName || 'User',
    persona: config.userPersona,
    scenario: card.scenario,
    vars: { ...session.variables },
  };

  const parts: string[] = [];

  // L2: Dynamic World Info with cooldown deduplication
  const scan = scanLorebooks(allBooks, {
    recentMessages,
    currentTurn: nextTurn,
    cooldownTurns: config.cooldownTurns,
    injectedLorebookTurns: session.injectedLorebookTurns,
  });

  if (scan.triggered.length > 0) {
    const loreText = scan.triggered
      .map((item) => `[Lore: ${item.entry.comment}]\n${evaluateMacros(item.entry.content, ctx)}`)
      .join('\n\n');
    parts.push(`[Triggered World Info]\n${loreText}`);
  }

  // L3a: Post-history preset anchor (refreshed per postHistoryRefreshInterval)
  let injectedPostHistory = false;
  const shouldRefreshPostHistory =
    config.enablePostHistoryInjection &&
    (session.lastPostHistoryTurn === 0 ||
      nextTurn - session.lastPostHistoryTurn >= Math.max(1, config.postHistoryRefreshInterval));

  if (shouldRefreshPostHistory) {
    if (preset) {
      const compiled = compilePreset(preset, ctx, {});
      Object.assign(ctx.vars, compiled.variables);
      if (compiled.postHistoryText.trim()) {
        parts.push(compiled.postHistoryText.trim());
        injectedPostHistory = true;
      }
    } else if (card.postHistoryInstructions.trim()) {
      parts.push(evaluateMacros(card.postHistoryInstructions, ctx).trim());
      injectedPostHistory = true;
    }
  }

  // L3b: Compact live state anchor (only if state changed or refresh interval reached)
  const compactState = formatCompactState(session.state, card.name);
  const stateHash = hashText(compactState);
  let injectedState = false;
  if (compactState && stateHash !== session.lastStateInjectedHash) {
    parts.push(compactState);
    injectedState = true;
  }

  return {
    systemMessage: parts.filter(Boolean).join('\n\n'),
    triggeredLorebookKeys: scan.triggered.map((x) => x.entryKey),
    skippedByCooldown: scan.skippedByCooldown,
    injectedPostHistory,
    injectedState,
    stateHash,
    variables: { ...ctx.vars },
  };
}
