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
import { applyMvuUpdates, extractInitVarFromLorebooks } from './mvu-engine.js';
import { renderEjsTemplate } from './ejs-engine.js';
import { buildMemoryPromptInstruction } from './memory-engine.js';
import { resolveStoryKey } from './story-log.js';

export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * Splits a large systemMessage into multiple UTF-8 byte-bounded chunks so that
 * Antigravity's per-step hook message cap (~24 KB) never truncates trailing
 * history turns, postHistoryText, or delivery instructions.
 * Benchmarked up to 25 x 20 KB (~500 KB / ~187k tokens) in a single hook stdout with 0 truncation.
 */
export function splitIntoInjectChunks(text: string, maxBytes = 20480): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
    return [trimmed];
  }

  const chunks: string[] = [];
  // First split by major section separators or paragraphs
  const paragraphs = trimmed.split(/(\n\n---\n\n|\n\n)/);
  let current = '';

  const pushCurrent = () => {
    const clean = current.trim();
    if (clean) chunks.push(clean);
    current = '';
  };

  const appendOversizedPiece = (piece: string) => {
    const lines = piece.split('\n');
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
        current = candidate;
        continue;
      }
      if (current) pushCurrent();
      if (Buffer.byteLength(line, 'utf8') <= maxBytes) {
        current = line;
        continue;
      }
      // Hard fallback: split very long single line safely along UTF-16 code points
      let buf = '';
      for (const ch of line) {
        if (Buffer.byteLength(buf + ch, 'utf8') > maxBytes) {
          if (buf.trim()) chunks.push(buf.trim());
          buf = ch;
        } else {
          buf += ch;
        }
      }
      current = buf;
    }
  };

  for (const part of paragraphs) {
    if (!part) continue;
    const candidate = current + part;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      current = candidate;
    } else {
      if (current.trim()) pushCurrent();
      if (Buffer.byteLength(part, 'utf8') <= maxBytes) {
        current = part.trimStart();
      } else {
        appendOversizedPiece(part.trim());
      }
    }
  }
  pushCurrent();
  return chunks;
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
  statData: Record<string, unknown>;
  stats: {
    staticChars: number;
    constantLorebookCount: number;
    initializedMvu: boolean;
  };
}

export function assembleSessionStart(params: {
  config: TavernConfig;
  card: CharacterCard;
  preset: Preset | null;
  lorebooks: Lorebook[];
  session: SessionRuntime;
  resumedStoryBlock?: string;
  recentTurnTexts?: string[];
}): SessionStartBundle {
  const { config, card, preset, lorebooks, session, resumedStoryBlock, recentTurnTexts } = params;
  const allBooks = card.embeddedLorebook ? [card.embeddedLorebook, ...lorebooks] : lorebooks;
  const userName = config.userName || 'User';

  // Resolve active opening greeting (0 = firstMessage, 1..N = alternateGreetings)
  const activeSlot = config.activeChatSlots?.[card.id] || 'default';
  const storyKey = resolveStoryKey(card.id, activeSlot);
  const allGreetings = [card.firstMessage, ...(card.alternateGreetings ?? [])];
  const rawGreetingIdx = config.activeGreetingIndices?.[storyKey] ?? 0;
  const greetingIdx = Math.max(0, Math.min(Math.max(0, allGreetings.length - 1), rawGreetingIdx));
  const selectedGreeting = allGreetings[greetingIdx] || card.firstMessage;

  // Initialize MVU stat_data from [initvar] + selected opening's <update> patch if session.statData is empty
  let statData: Record<string, unknown> = { ...(session.statData ?? {}) };
  let initializedMvu = false;
  if (Object.keys(statData).length === 0) {
    const initVar = extractInitVarFromLorebooks(allBooks, userName);
    if (initVar) {
      statData =
        selectedGreeting && /<update(?:variable)?>/i.test(selectedGreeting)
          ? applyMvuUpdates(initVar, selectedGreeting).statData
          : initVar;
      initializedMvu = true;
    }
  }

  const ctx: MacroContext = {
    char: card.name,
    user: userName,
    persona: config.userPersona,
    scenario: card.scenario,
    vars: { ...session.variables },
    statData,
  };

  const ejsRender = (raw: string): string =>
    renderEjsTemplate(raw, {
      statData,
      vars: ctx.vars,
      card,
      lorebooks: allBooks,
      userName,
    });

  const renderText = (raw: string): string => evaluateMacros(ejsRender(raw), ctx);

  const scan = scanLorebooks(allBooks, {
    recentMessages: recentTurnTexts ?? [],
    currentTurn: Math.max(1, session.turnCount + 1),
    cooldownTurns: config.cooldownTurns,
    injectedLorebookTurns: {},
  });

  const wiBefore = scan.constantBefore.map((x) => renderText(x.entry.content)).filter((s) => s.trim()).join('\n\n');
  const wiAfter = scan.constantAfter.map((x) => renderText(x.entry.content)).filter((s) => s.trim()).join('\n\n');

  const slots = {
    worldInfoBefore: wiBefore,
    personaDescription: config.userPersona,
    charDescription: renderText(card.description),
    charPersonality: renderText(card.personality),
    scenario: renderText(card.scenario),
    worldInfoAfter: wiAfter,
    dialogueExamples: renderText(card.messageExample),
  };

  const parts: string[] = [];
  let deferredPostHistory = '';

  if (preset) {
    const compiled = compilePreset(preset, ctx, slots, { ejsRender });
    if (compiled.staticText) {
      parts.push(compiled.staticText);
    }
    if (config.enablePostHistoryInjection && compiled.postHistoryText) {
      deferredPostHistory = compiled.postHistoryText;
    }
    Object.assign(ctx.vars, compiled.variables);
  } else {
    if (wiBefore) parts.push(`[World Info]\n${wiBefore}`);
    if (card.systemPrompt) parts.push(renderText(card.systemPrompt));
    if (slots.charDescription) parts.push(`[Character: ${card.name}]\n${slots.charDescription}`);
    if (slots.charPersonality) parts.push(`[Personality]\n${slots.charPersonality}`);
    if (slots.scenario) parts.push(`[Scenario]\n${slots.scenario}`);
    if (config.userPersona) parts.push(`[User Persona: ${ctx.user}]\n${renderText(config.userPersona)}`);
    if (wiAfter) parts.push(`[Additional World Info]\n${wiAfter}`);
    if (slots.dialogueExamples) parts.push(`[Dialogue Examples]\n${slots.dialogueExamples}`);
    if (config.enablePostHistoryInjection && card.postHistoryInstructions.trim()) {
      deferredPostHistory = renderText(card.postHistoryInstructions).trim();
    }
  }

  // Strictly place Opening Scene (#0, respecting selected alternate greeting) and existing Story History BEFORE postHistoryText
  if (selectedGreeting) {
    parts.push(
      `[Turn #0 · Opening Scene (${card.name}) — Already Shown to ${ctx.user}; Continue Directly From Here]\n${renderText(selectedGreeting)}`,
    );
  }

  if (resumedStoryBlock && resumedStoryBlock.trim()) {
    parts.push(resumedStoryBlock.trim());
  }

  if (scan.triggered.length > 0) {
    const triggeredLoreText = scan.triggered
      .map((item) => `[Lore: ${item.entry.comment}]\n${renderText(item.entry.content)}`)
      .join('\n\n');
    parts.push(`[Triggered World Info]\n${triggeredLoreText}`);
  }

  const compactState = formatCompactState(session.state, card.name);
  if (compactState) {
    parts.push(compactState);
  }

  // SillyTavern-style Author's Note (short-term steering without editing card/preset)
  if (config.authorsNoteEnabled && config.authorsNote?.trim()) {
    parts.push(`[Author's Note]\n${renderText(config.authorsNote.trim())}`);
  }

  // Pin post-history rules AFTER opening scene & prior story turns so WAVE_CONTEXT_END / output_contract sit at the true end
  if (deferredPostHistory) {
    parts.push(deferredPostHistory);
  }

  // Optional Memory Plugin contract: instruct the model to append a concise ~200-char <memory_summary>
  const memoryContract = buildMemoryPromptInstruction(config.memoryPlugin);
  session.memoryContractInjected = Boolean(memoryContract);
  if (memoryContract) {
    parts.push(memoryContract);
  }

  parts.push(
    '[Story Panel Delivery] Stay 100% in Roleplay mode and do NOT invoke coding, file, shell, or browser tools. Put your full turn output (including any preset CoT/formatting tags and story prose) inside `story_commit_turn(narrative)`. Do not repeat story prose in main chat; end main chat with only a 1-line floor index (e.g., `✦ 第 #N 楼已落笔至侧边栏`).',
  );

  const systemMessage = parts.filter((p) => p.trim().length > 0).join('\n\n---\n\n');

  return {
    systemMessage,
    variables: { ...ctx.vars },
    statData,
    stats: {
      staticChars: systemMessage.length,
      constantLorebookCount: scan.constantBefore.length + scan.constantAfter.length,
      initializedMvu,
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

  const statData = { ...(session.statData ?? {}) };
  const userName = config.userName || 'User';

  const lastUserMessage = recentMessages[recentMessages.length - 1] ?? '';
  const lastCharMessage = recentMessages.length >= 2 ? recentMessages[recentMessages.length - 2] ?? '' : '';

  const ctx: MacroContext = {
    char: card.name,
    user: userName,
    persona: config.userPersona,
    scenario: card.scenario,
    vars: { ...session.variables },
    statData,
    lastUserMessage,
    lastCharMessage,
    lastMessage: lastUserMessage || lastCharMessage,
    lastMessageId: nextTurn,
    original: card.postHistoryInstructions,
  };

  const ejsRender = (raw: string): string =>
    renderEjsTemplate(raw, {
      statData,
      vars: ctx.vars,
      card,
      lorebooks: allBooks,
      userName,
    });

  const renderText = (raw: string): string => evaluateMacros(ejsRender(raw), ctx);

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
      .map((item) => `[Lore: ${item.entry.comment}]\n${renderText(item.entry.content)}`)
      .join('\n\n');
    parts.push(`[Triggered World Info]\n${loreText}`);
  }

  // L3a: Optional periodic post-history refresh (0 = pinned once in SessionStart for max KV cache & zero redundancy)
  let injectedPostHistory = false;
  const shouldRefreshPostHistory =
    config.enablePostHistoryInjection &&
    config.postHistoryRefreshInterval > 0 &&
    nextTurn - session.lastPostHistoryTurn >= config.postHistoryRefreshInterval;

  if (shouldRefreshPostHistory) {
    if (preset) {
      const compiled = compilePreset(preset, ctx, {}, { ejsRender });
      Object.assign(ctx.vars, compiled.variables);
      if (compiled.postHistoryText.trim()) {
        parts.push(compiled.postHistoryText.trim());
        injectedPostHistory = true;
      }
    } else if (card.postHistoryInstructions.trim()) {
      parts.push(renderText(card.postHistoryInstructions).trim());
      injectedPostHistory = true;
    }
  }

  // L3b: Compact live state anchor (only if state changed)
  const compactState = formatCompactState(session.state, card.name);
  const stateHash = hashText(compactState);
  let injectedState = false;
  if (compactState && stateHash !== session.lastStateInjectedHash) {
    parts.push(compactState);
    injectedState = true;
  }

  // L3c: If memory plugin was toggled on mid-session (non-director mode), inject contract once
  const memContract = buildMemoryPromptInstruction(config.memoryPlugin);
  if (memContract && !session.memoryContractInjected) {
    parts.push(memContract);
    session.memoryContractInjected = true;
  } else if (!memContract && session.memoryContractInjected) {
    session.memoryContractInjected = false;
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
