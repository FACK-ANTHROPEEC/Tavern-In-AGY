export interface LorebookEntry {
  uid: string;
  keys: string[];
  secondaryKeys: string[];
  selective: boolean;
  /** 0 = AND_ANY, 1 = NOT_ALL, 2 = NOT_ANY, 3 = AND_ALL */
  selectiveLogic: 0 | 1 | 2 | 3;
  constant: boolean;
  content: string;
  comment: string;
  enabled: boolean;
  order: number;
  position: 'before_char' | 'after_char' | 'in_chat';
  depth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
}

export interface Lorebook {
  id: string;
  name: string;
  description?: string;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  maxRecursionSteps: number;
  entries: LorebookEntry[];
  importedAt: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  messageExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  tags: string[];
  avatarDataUrl?: string;
  embeddedLorebook?: Lorebook;
  importedAt: string;
}

export interface PresetPromptItem {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  enabled: boolean;
  marker: boolean;
  injectionPosition: number;
  injectionDepth: number;
  injectionOrder: number;
  isSectionHeader: boolean;
  forbidOverrides?: boolean;
}

export interface RegexScript {
  id?: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  disabled: boolean;
  placement: number[];
  trimStrings?: string[];
  markdownOnly?: boolean;
  promptOnly?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  prompts: PresetPromptItem[];
  regexScripts: RegexScript[];
  samplingMeta: Record<string, unknown>;
  importedAt: string;
}

export interface LiveCharacterState {
  location: string;
  timeOfDay: string;
  mood: string;
  affection: number;
  inventory: string[];
  activeGoals: string[];
  customFields: Record<string, string>;
  summary: string;
  updatedAt: string;
}

export interface SessionRuntime {
  conversationId: string;
  turnCount: number;
  lastUserInputHash: string;
  /** Lorebook entry key (`${bookId}:${uid}`) -> last turn injected */
  injectedLorebookTurns: Record<string, number>;
  lastStateInjectedHash: string;
  lastPostHistoryTurn: number;
  recentMessages: string[];
  variables: Record<string, string>;
  state: LiveCharacterState;
  latestOptions: Array<{ label: string; category: string; text: string }>;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  cardId: string | null;
  presetId: string | null;
  state: LiveCharacterState;
  variables: Record<string, string>;
  recentMessages: string[];
  createdAt: string;
}

export interface TavernConfig {
  enabled: boolean;
  userName: string;
  userPersona: string;
  activeCardId: string | null;
  activePresetId: string | null;
  activeLorebookIds: string[];
  cooldownTurns: number;
  stateRefreshInterval: number;
  postHistoryRefreshInterval: number;
  enablePostHistoryInjection: boolean;
}

export function createDefaultState(): LiveCharacterState {
  return {
    location: '',
    timeOfDay: '',
    mood: '',
    affection: 0,
    inventory: [],
    activeGoals: [],
    customFields: {},
    summary: '',
    updatedAt: new Date().toISOString(),
  };
}

export function createDefaultConfig(): TavernConfig {
  return {
    enabled: true,
    userName: 'User',
    userPersona: '',
    activeCardId: null,
    activePresetId: null,
    activeLorebookIds: [],
    cooldownTurns: 12,
    stateRefreshInterval: 3,
    postHistoryRefreshInterval: 1,
    enablePostHistoryInjection: true,
  };
}
