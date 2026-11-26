import fs from 'node:fs';
import path from 'node:path';
import type { CharacterCard, Preset, TavernConfig } from './types.js';
import { evaluateMacros, type MacroContext } from './macro-engine.js';
import { compilePreset } from './preset-parser.js';

function toAgentSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return ascii ? `rp-${ascii}` : `rp-card-${Date.now().toString(36)}`;
}

export interface ExportedAgentResult {
  agentName: string;
  filePath: string;
  slashHint: string;
}

/**
 * Exports a SillyTavern CharacterCard (and optional active Preset static rules)
 * into an Antigravity Custom Agent Markdown file (`agents/<slug>.md`).
 * This lets users switch characters cleanly with `/agents` without coding-tool clutter.
 */
export function exportCardToCustomAgent(params: {
  card: CharacterCard;
  preset: Preset | null;
  config: TavernConfig;
  agentsDir: string;
}): ExportedAgentResult {
  const { card, preset, config, agentsDir } = params;
  fs.mkdirSync(agentsDir, { recursive: true });

  const agentName = toAgentSlug(card.name);
  const filePath = path.join(agentsDir, `${agentName}.md`);

  const ctx: MacroContext = {
    char: card.name,
    user: config.userName || 'User',
    persona: config.userPersona,
    scenario: card.scenario,
    vars: {},
  };

  let body = '';
  if (preset) {
    const compiled = compilePreset(preset, ctx, {
      personaDescription: config.userPersona,
      charDescription: card.description,
      charPersonality: card.personality,
      scenario: card.scenario,
      dialogueExamples: card.messageExample,
    });
    body = compiled.staticText;
  } else {
    const sections = [
      `# Roleplay Character: ${card.name}`,
      card.systemPrompt ? evaluateMacros(card.systemPrompt, ctx) : '',
      card.description ? `## Description\n${evaluateMacros(card.description, ctx)}` : '',
      card.personality ? `## Personality\n${evaluateMacros(card.personality, ctx)}` : '',
      card.scenario ? `## Scenario\n${evaluateMacros(card.scenario, ctx)}` : '',
      config.userPersona ? `## User Persona (${ctx.user})\n${evaluateMacros(config.userPersona, ctx)}` : '',
      card.messageExample ? `## Dialogue Examples\n${evaluateMacros(card.messageExample, ctx)}` : '',
    ].filter(Boolean);
    body = sections.join('\n\n');
  }

  const opening = card.firstMessage
    ? `\n\n## Opening Scene\n${evaluateMacros(card.firstMessage, ctx)}`
    : '';

  const toolGuidance = [
    '',
    '## Roleplay Tool Discipline',
    '- Focus exclusively on immersive Roleplay storytelling. Ignore software engineering or filesystem tools unless explicitly asked out-of-character.',
    '- After writing each narrative turn, call `tavern_commit_turn` with your narrative, updated character stats (location, timeOfDay, mood, outfit, affection, summary), and optional action choices so the TavernInAGY side-pane MVU panel and JSONL story log stay synchronized.',
    '- Use `tavern_search_lorebook` if you need extra world-building details on demand.',
  ].join('\n');

  const safeDesc = `TavernInAGY Roleplay persona for ${card.name}.`.replace(/"/g, "'");
  const markdown = [
    '---',
    `name: ${agentName}`,
    `description: "${safeDesc}"`,
    '---',
    '',
    body,
    opening,
    toolGuidance,
    '',
  ].join('\n');

  fs.writeFileSync(filePath, markdown, 'utf8');

  return {
    agentName,
    filePath,
    slashHint: `/agents (${agentName})`,
  };
}
