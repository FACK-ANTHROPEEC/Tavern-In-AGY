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
  delayUntilRecursion?: boolean;
  scanDepth?: number;
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
  alternateGreetings?: string[];
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
  tavernHelperScripts?: TavernHelperScript[];
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
  /** Per-turn concise plot summary (~200 chars) used when this floor falls outside the full-prose window */
  memorySummary?: string;
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

export interface MemoryPluginConfig {
  /** Master toggle for per-turn summary prompt injection & sliding-window history compression */
  enabled: boolean;
  /** Number of latest floors (each user input = 1 floor, each assistant narrative = 1 floor) sent in full prose */
  recentFullFloors: number;
  /** Target character length hint for the per-turn summary (default 200) */
  summaryLengthHint: number;
  /** Optional custom instruction prompt overriding the built-in summary contract */
  customPrompt?: string;
  /** How <memory_summary> is displayed in the side-pane reader: 'fold' (collapsible chip) or 'hide' */
  summaryDisplayMode?: 'fold' | 'hide';
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
  pendingDirectorInputAt?: number;
  /** Real user input staged by the side-pane reader so the main chat only receives a minimal floor-trigger signal */
  stagedSidePaneInput?: string;
  stagedSidePaneInputAt?: number;
  /** Fallback user message captured by PreInvocation in case story_commit_turn omits userMessage */
  lastUserInputForCommit?: string;
  /** Tracks whether [Memory Summary Contract] has already been injected in this session */
  memoryContractInjected?: boolean;
  /** Marks a subagent session unlocked by SessionStart as story-writer so PreInvocation never injects director prompts into it */
  isWriterSubagent?: boolean;
  /** Director Mode per-turn handshake state stored on the shared 'default' session to prevent duplicate dispatch on subagent wakeup */
  directorTurnState?: 'idle' | 'dispatched' | 'committed';
  /** Timestamp when story_commit_turn finished the latest director turn (used to suppress post-commit kill-tool PreInvocation echoes) */
  directorCommittedAt?: number;
  /** Unique USER_INPUT step stamp from transcript.jsonl (`step_index|created_at`) for exact per-turn PreInvocation deduplication */
  lastDispatchedUserStep?: string;
  /** Timestamp (`stagedSidePaneInputAt`) of the side-pane staged input already dispatched by PreInvocation */
  lastDispatchedStagedAt?: number;
  /** Per-conversation RP activation flag set by `/rp` and cleared by `/rp off`, keeping normal AGY chats 100% isolated */
  rpModeActive?: boolean;
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

export interface ChatSlotSummary {
  slotId: string;
  storyKey: string;
  label: string;
  turnCount: number;
  updatedAt: string;
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
  /** UI visual scale percentage (80 - 130, default 100) */
  uiScale?: number;
  /** Narrative prose font size in px (12 - 22, default 14) */
  proseFontSize?: number;
  /** Narrative prose line height (1.4 - 2.2, default 1.7) */
  proseLineHeight?: number;
  /** Max reading width in px (0 = full width, e.g. 720 / 860 / 1000) */
  maxReadingWidth?: number;
  /** Persistent toggle for ST display regex beautification */
  enableRegexBeautify?: boolean;
  /** Fallback handling ONLY for leftover custom XML tags not consumed by any preset/card regex */
  unknownTagMode?: 'fold' | 'keep' | 'hide';
  /** SillyTavern-style Author's Note injected near the end of story history */
  authorsNote?: string;
  authorsNoteEnabled?: boolean;
  /** Per-card active multi-playthrough chat slot id (`cardId -> slotId`, default `'default'`) */
  activeChatSlots?: Record<string, string>;
  /** Selected opening greeting index per storyKey (0 = firstMessage, 1..N = alternateGreetings) */
  activeGreetingIndices?: Record<string, number>;
  /** Number of recent floors (user + assistant messages) shown by default before clicking "load earlier" (default 10 = 5 turns) */
  visibleFloorLimit?: number;
  /** Memory & sliding-window summary plugin configuration */
  memoryPlugin?: MemoryPluginConfig;
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
    cooldownTurns: 3,
    stateRefreshInterval: 3,
    postHistoryRefreshInterval: 0,
    enablePostHistoryInjection: true,
    statelessPerTurn: false,
    directorMode: true,
    uiScale: 100,
    proseFontSize: 14,
    proseLineHeight: 1.7,
    maxReadingWidth: 0,
    enableRegexBeautify: true,
    unknownTagMode: 'fold',
    authorsNote: '',
    authorsNoteEnabled: false,
    activeChatSlots: {},
  };
}
