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

export interface TavernHelperScript {
  name: string;
  content: string;
  enabled: boolean;
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
  regexScripts?: RegexScript[];
  tavernHelperScripts?: TavernHelperScript[];
  customExtensions?: Record<string, unknown>;
  resourceOrigins?: string[];
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
  minDepth?: number | null;
  maxDepth?: number | null;
  /** 0 = NONE, 1 = RAW, 2 = ESCAPED */
  substituteRegex?: number;
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
  outfit: string;
  affection: number;
  inventory: string[];
  activeGoals: string[];
  customFields: Record<string, string>;
  summary: string;
  updatedAt: string;
}

export interface StoryTurn {
  turnId: string;
  index: number;
  userMessage?: string;
  narrative: string;
  thought?: string;
  statsSnapshot?: {
    location?: string;
    timeOfDay?: string;
    mood?: string;
    outfit?: string;
    affection?: number;
  };
  /** Per-floor MVU stat_data snapshot for exact rollback on Swipe/Re-roll */
  statData?: Record<string, unknown>;
  options?: Array<{ label: string; category: string; text: string }>;
  createdAt: string;
}

export interface PendingForkContext {
  cardId: string;
  turns: StoryTurn[];
  state: LiveCharacterState;
  statData?: Record<string, unknown>;
  createdAt: string;
}

export interface SessionRuntime {
  conversationId: string;
  turnCount: number;
  lastUserInputHash: string;
  /** Tracks which card & preset had SessionStart injected into this conversation */
  sessionStartCardId?: string;
  sessionStartPresetId?: string;
  /** Lorebook entry key (`${bookId}:${uid}`) -> last turn injected */
  injectedLorebookTurns: Record<string, number>;
  lastStateInjectedHash: string;
  lastPostHistoryTurn: number;
  recentMessages: string[];
  variables: Record<string, string>;
  /** True MVU stat_data tree (initialized from [initvar] & updated via RFC 6902 JSON Patch) */
  statData: Record<string, unknown>;
  state: LiveCharacterState;
  latestOptions: Array<{ label: string; category: string; text: string }>;
  /** Latest user input cached by PreInvocation in directorMode for the spawned subagent's SessionStart lorebook scan */
  pendingDirectorInput?: string;
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
  /** When true, every side-pane send spawns a fresh background conversation with full re-assembled context */
  statelessPerTurn?: boolean;
  /** When true (used with tavern-director agent), main window PreInvocation skips heavy injection and relays user input to spawned tavern-rp subagents */
  directorMode?: boolean;
}

export function createDefaultState(): LiveCharacterState {
  return {
    location: '',
    timeOfDay: '',
    mood: '',
    outfit: '',
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
    postHistoryRefreshInterval: 0,
    enablePostHistoryInjection: true,
    statelessPerTurn: false,
    directorMode: false,
  };
}
