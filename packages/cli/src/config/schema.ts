import { parseChannelAddress } from "../channel/id";

export interface ChannelConfig {
  type: string;
  credentials: Record<string, unknown>;
  pairedUsers: PairedUser[];
  linkedGroups: LinkedGroup[];
}

export interface PairedUser {
  userId: string; // e.g. "telegram:123456" or "telegram:bot_a:123456"
  username?: string;
  pairedAt: string;
}

export interface LinkedGroup {
  chatId: string; // e.g. "telegram:-123456" or "telegram:bot_a:-123456:12"
  title?: string;
  linkedAt: string;
}

export interface TgConfig {
  channels: Record<string, ChannelConfig>;
  settings: TgSettings;
  chatPreferences?: Record<string, ChatPreferences>;
}

export type ThinkingMode = "off" | "preview" | "full";
export type ToolCallMode = "off" | "compact" | "detailed";
export type ToolResultMode = "off" | "compact" | "full";
export type TranscriptOutputPreset = "simple" | "thinking" | "verbose";
export type TranscriptOutputPresetLabel = TranscriptOutputPreset | "custom";
export type ThrottleIntervalMinutes = 1 | 5 | 15 | 30;
export type TimedMuteDurationMinutes = 15 | 30 | 60;

export interface ChatOutputPreferences {
  thinkingMode: ThinkingMode;
  toolCallMode: ToolCallMode;
  toolResultMode: ToolResultMode;
  toolErrors: boolean;
  backgroundJobs: boolean;
  typingIndicator: boolean;
  orderingNotices: boolean;
}

export type ImmediateDeliveryPreference = {
  mode: "immediate";
};

export type ThrottleDeliveryPreference = {
  mode: "throttle";
  intervalMinutes: ThrottleIntervalMinutes;
  activatedAt: string;
  lastSummaryAt: string | null;
  pendingUserTurnSince: string | null;
};

export type TimedMuteDeliveryPreference = {
  mode: "mute";
  kind: "timed";
  activatedAt: string;
  mutedUntil: string;
  pendingUserTurnSince: string | null;
};

export type PermanentMuteDeliveryPreference = {
  mode: "mute";
  kind: "permanent";
  activatedAt: string;
  pendingUserTurnSince: string | null;
  lastAwaitingUserNoticeAt: string | null;
};

export type ChatDeliveryPreference =
  | ImmediateDeliveryPreference
  | ThrottleDeliveryPreference
  | TimedMuteDeliveryPreference
  | PermanentMuteDeliveryPreference;

export interface ChatPreferences {
  output?: Partial<ChatOutputPreferences>;
  delivery?: ChatDeliveryPreference;
}

export interface TgSettings {
  outputBatchMinMs: number;
  outputBatchMaxMs: number;
  outputBufferMaxChars: number;
  orderedConversationTimeoutMs: number;
  maxSessions: number;
  defaultShell: string;
}

export const THROTTLE_INTERVAL_MINUTES = [1, 5, 15, 30] as const satisfies readonly ThrottleIntervalMinutes[];
export const TIMED_MUTE_DURATION_MINUTES = [15, 30, 60] as const satisfies readonly TimedMuteDurationMinutes[];

const THROTTLE_INTERVAL_SET = new Set<number>(THROTTLE_INTERVAL_MINUTES);
const TIMED_MUTE_DURATION_SET = new Set<number>(TIMED_MUTE_DURATION_MINUTES);

export const defaultSettings: TgSettings = {
  outputBatchMinMs: 300,
  outputBatchMaxMs: 800,
  outputBufferMaxChars: 4096,
  orderedConversationTimeoutMs: 2000,
  maxSessions: 10,
  defaultShell: process.env.SHELL || "/bin/bash",
};

export const DEFAULT_CHAT_OUTPUT_PREFERENCES: ChatOutputPreferences = {
  thinkingMode: "preview",
  toolCallMode: "compact",
  toolResultMode: "compact",
  toolErrors: true,
  backgroundJobs: true,
  typingIndicator: true,
  orderingNotices: false,
};

const TRANSCRIPT_PRESET_PREFERENCES: Record<TranscriptOutputPreset, Pick<ChatOutputPreferences, "thinkingMode" | "toolCallMode" | "toolResultMode" | "toolErrors">> = {
  simple: {
    thinkingMode: "preview",
    toolCallMode: "compact",
    toolResultMode: "compact",
    toolErrors: true,
  },
  thinking: {
    thinkingMode: "full",
    toolCallMode: "compact",
    toolResultMode: "compact",
    toolErrors: true,
  },
  verbose: {
    thinkingMode: "full",
    toolCallMode: "detailed",
    toolResultMode: "full",
    toolErrors: true,
  },
};

export function createDefaultConfig(): TgConfig {
  return {
    channels: {},
    settings: { ...defaultSettings },
    chatPreferences: {},
  };
}

export function validateConfig(config: unknown): config is TgConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.channels === "object" &&
    c.channels !== null &&
    typeof c.settings === "object" &&
    c.settings !== null &&
    (c.chatPreferences === undefined || (typeof c.chatPreferences === "object" && c.chatPreferences !== null))
  );
}

function isThinkingMode(value: unknown): value is ThinkingMode {
  return value === "off" || value === "preview" || value === "full";
}

function isToolCallMode(value: unknown): value is ToolCallMode {
  return value === "off" || value === "compact" || value === "detailed";
}

function isToolResultMode(value: unknown): value is ToolResultMode {
  return value === "off" || value === "compact" || value === "full";
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeTimestamp(value: unknown): string | null {
  return isIsoTimestamp(value) ? value : null;
}

function transcriptMatchesPreset(
  output: Pick<ChatOutputPreferences, "thinkingMode" | "toolCallMode" | "toolResultMode" | "toolErrors">,
  preset: TranscriptOutputPreset
): boolean {
  const candidate = TRANSCRIPT_PRESET_PREFERENCES[preset];
  return (
    output.thinkingMode === candidate.thinkingMode &&
    output.toolCallMode === candidate.toolCallMode &&
    output.toolResultMode === candidate.toolResultMode &&
    output.toolErrors === candidate.toolErrors
  );
}

function normalizeStoredOutput(output: Partial<ChatOutputPreferences> | undefined): Partial<ChatOutputPreferences> | undefined {
  if (!output) return undefined;
  const normalized: Partial<ChatOutputPreferences> = {};
  if (isThinkingMode(output.thinkingMode)) normalized.thinkingMode = output.thinkingMode;
  if (isToolCallMode(output.toolCallMode)) normalized.toolCallMode = output.toolCallMode;
  if (isToolResultMode(output.toolResultMode)) normalized.toolResultMode = output.toolResultMode;
  if (typeof output.toolErrors === "boolean") normalized.toolErrors = output.toolErrors;
  if (typeof output.backgroundJobs === "boolean") normalized.backgroundJobs = output.backgroundJobs;
  if (typeof output.typingIndicator === "boolean") normalized.typingIndicator = output.typingIndicator;
  if (typeof output.orderingNotices === "boolean") normalized.orderingNotices = output.orderingNotices;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStoredDelivery(delivery: unknown): ChatDeliveryPreference | undefined {
  if (!delivery || typeof delivery !== "object") return undefined;
  const candidate = delivery as Record<string, unknown>;
  if (candidate.mode === "immediate") return { mode: "immediate" };
  if (candidate.mode === "throttle") {
    const intervalMinutes = candidate.intervalMinutes;
    const activatedAt = candidate.activatedAt;
    if (!THROTTLE_INTERVAL_SET.has(intervalMinutes as number) || !isIsoTimestamp(activatedAt)) {
      return undefined;
    }
    return {
      mode: "throttle",
      intervalMinutes: intervalMinutes as ThrottleIntervalMinutes,
      activatedAt,
      lastSummaryAt: normalizeTimestamp(candidate.lastSummaryAt),
      pendingUserTurnSince: normalizeTimestamp(candidate.pendingUserTurnSince),
    };
  }
  if (candidate.mode !== "mute" || candidate.kind === undefined) return undefined;
  if (candidate.kind === "timed") {
    const activatedAt = candidate.activatedAt;
    const mutedUntil = candidate.mutedUntil;
    const durationMinutes = Math.round((Date.parse(mutedUntil as string) - Date.parse(activatedAt as string)) / 60_000);
    if (!isIsoTimestamp(activatedAt) || !isIsoTimestamp(mutedUntil) || !TIMED_MUTE_DURATION_SET.has(durationMinutes)) {
      return undefined;
    }
    return {
      mode: "mute",
      kind: "timed",
      activatedAt,
      mutedUntil,
      pendingUserTurnSince: normalizeTimestamp(candidate.pendingUserTurnSince),
    };
  }
  if (candidate.kind !== "permanent" || !isIsoTimestamp(candidate.activatedAt)) return undefined;
  return {
    mode: "mute",
    kind: "permanent",
    activatedAt: candidate.activatedAt,
    pendingUserTurnSince: normalizeTimestamp(candidate.pendingUserTurnSince),
    lastAwaitingUserNoticeAt: normalizeTimestamp(candidate.lastAwaitingUserNoticeAt),
  };
}

export function createThrottleDeliveryPreference(
  intervalMinutes: ThrottleIntervalMinutes,
  activatedAt = new Date().toISOString()
): ThrottleDeliveryPreference {
  return {
    mode: "throttle",
    intervalMinutes,
    activatedAt,
    lastSummaryAt: null,
    pendingUserTurnSince: null,
  };
}

export function createTimedMuteDeliveryPreference(
  durationMinutes: TimedMuteDurationMinutes,
  activatedAt = new Date().toISOString()
): TimedMuteDeliveryPreference {
  return {
    mode: "mute",
    kind: "timed",
    activatedAt,
    mutedUntil: new Date(Date.parse(activatedAt) + durationMinutes * 60_000).toISOString(),
    pendingUserTurnSince: null,
  };
}

export function createPermanentMuteDeliveryPreference(
  activatedAt = new Date().toISOString()
): PermanentMuteDeliveryPreference {
  return {
    mode: "mute",
    kind: "permanent",
    activatedAt,
    pendingUserTurnSince: null,
    lastAwaitingUserNoticeAt: null,
  };
}

export function normalizeStoredChatPreference(
  preference: unknown,
  legacyMutedActivatedAt = new Date().toISOString()
): ChatPreferences | undefined {
  if (!preference || typeof preference !== "object") return undefined;
  const candidate = preference as {
    output?: Partial<ChatOutputPreferences>;
    delivery?: unknown;
    muted?: unknown;
  };
  const output = normalizeStoredOutput(candidate.output);
  const delivery = normalizeStoredDelivery(candidate.delivery)
    ?? (candidate.muted === true ? createPermanentMuteDeliveryPreference(legacyMutedActivatedAt) : undefined);
  if (!output && (!delivery || delivery.mode === "immediate")) return undefined;
  return {
    ...(output ? { output } : {}),
    ...(delivery && delivery.mode !== "immediate" ? { delivery } : {}),
  };
}

export function getChatOutputPreferences(config: TgConfig, chatId: string): ChatOutputPreferences {
  const output = normalizeStoredOutput(config.chatPreferences?.[chatId]?.output);
  return {
    ...DEFAULT_CHAT_OUTPUT_PREFERENCES,
    ...(output || {}),
  };
}

export function getChatTranscriptPresetLabel(config: TgConfig, chatId: string): TranscriptOutputPresetLabel {
  const current = getChatOutputPreferences(config, chatId);
  const transcript = {
    thinkingMode: current.thinkingMode,
    toolCallMode: current.toolCallMode,
    toolResultMode: current.toolResultMode,
    toolErrors: current.toolErrors,
  };
  if (transcriptMatchesPreset(transcript, "simple")) return "simple";
  if (transcriptMatchesPreset(transcript, "thinking")) return "thinking";
  if (transcriptMatchesPreset(transcript, "verbose")) return "verbose";
  return "custom";
}

export function applyChatTranscriptPreset(config: TgConfig, chatId: string, preset: TranscriptOutputPreset): boolean {
  const current = getChatOutputPreferences(config, chatId);
  return setChatOutputPreferences(config, chatId, {
    ...current,
    ...TRANSCRIPT_PRESET_PREFERENCES[preset],
  });
}

function pruneChatPreference(config: TgConfig, chatId: string): void {
  if (!config.chatPreferences) return;
  const pref = config.chatPreferences[chatId];
  if (!pref) return;
  const normalized = normalizeStoredChatPreference(pref);
  if (!normalized) {
    delete config.chatPreferences[chatId];
    return;
  }
  config.chatPreferences[chatId] = normalized;
}

export function setChatOutputPreferences(
  config: TgConfig,
  chatId: string,
  output: ChatOutputPreferences
): boolean {
  const current = getChatOutputPreferences(config, chatId);
  if (JSON.stringify(current) === JSON.stringify(output)) return false;
  if (!config.chatPreferences) config.chatPreferences = {};
  const nextPref: ChatPreferences = { ...(config.chatPreferences[chatId] || {}) };
  const storedOutput: Partial<ChatOutputPreferences> = {};
  if (output.thinkingMode !== DEFAULT_CHAT_OUTPUT_PREFERENCES.thinkingMode) storedOutput.thinkingMode = output.thinkingMode;
  if (output.toolCallMode !== DEFAULT_CHAT_OUTPUT_PREFERENCES.toolCallMode) storedOutput.toolCallMode = output.toolCallMode;
  if (output.toolResultMode !== DEFAULT_CHAT_OUTPUT_PREFERENCES.toolResultMode) storedOutput.toolResultMode = output.toolResultMode;
  if (output.toolErrors !== DEFAULT_CHAT_OUTPUT_PREFERENCES.toolErrors) storedOutput.toolErrors = output.toolErrors;
  if (output.backgroundJobs !== DEFAULT_CHAT_OUTPUT_PREFERENCES.backgroundJobs) storedOutput.backgroundJobs = output.backgroundJobs;
  if (output.typingIndicator !== DEFAULT_CHAT_OUTPUT_PREFERENCES.typingIndicator) storedOutput.typingIndicator = output.typingIndicator;
  if (output.orderingNotices !== DEFAULT_CHAT_OUTPUT_PREFERENCES.orderingNotices) storedOutput.orderingNotices = output.orderingNotices;
  nextPref.output = Object.keys(storedOutput).length > 0 ? storedOutput : undefined;
  config.chatPreferences[chatId] = nextPref;
  pruneChatPreference(config, chatId);
  return true;
}

export function getChatDeliveryPreference(config: TgConfig, chatId: string): ChatDeliveryPreference {
  return normalizeStoredDelivery(config.chatPreferences?.[chatId]?.delivery) ?? { mode: "immediate" };
}

export function isChatDeliveryMuted(config: TgConfig, chatId: string): boolean {
  return getChatDeliveryPreference(config, chatId).mode === "mute";
}

export function setChatDeliveryPreference(
  config: TgConfig,
  chatId: string,
  delivery: ChatDeliveryPreference
): boolean {
  const current = getChatDeliveryPreference(config, chatId);
  const next = normalizeStoredDelivery(delivery) ?? { mode: "immediate" };
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  if (!config.chatPreferences) config.chatPreferences = {};
  const nextPref: ChatPreferences = { ...(config.chatPreferences[chatId] || {}) };
  if (next.mode === "immediate") delete nextPref.delivery;
  else nextPref.delivery = next;
  config.chatPreferences[chatId] = nextPref;
  pruneChatPreference(config, chatId);
  return true;
}

export function clearChatDeliveryPreference(config: TgConfig, chatId: string): boolean {
  return setChatDeliveryPreference(config, chatId, { mode: "immediate" });
}


export function getTelegramChannelEntries(config: TgConfig): Array<[string, ChannelConfig]> {
  return Object.entries(config.channels).filter(([, ch]) => ch.type === "telegram");
}

export function getSlackChannelEntries(config: TgConfig): Array<[string, ChannelConfig]> {
  return Object.entries(config.channels).filter(([, ch]) => ch.type === "slack");
}

export function getSlackBotToken(config: TgConfig, channelName?: string): string {
  if (channelName) {
    const ch = config.channels[channelName];
    if (!ch || ch.type !== "slack") return "";
    return (ch.credentials.botToken as string) || "";
  }

  const defaultCh = config.channels.slack;
  if (defaultCh?.type === "slack") {
    return (defaultCh.credentials.botToken as string) || "";
  }

  for (const [, ch] of getSlackChannelEntries(config)) {
    const token = (ch.credentials.botToken as string) || "";
    if (token) return token;
  }
  return "";
}

export function getSlackAppToken(config: TgConfig, channelName?: string): string {
  if (channelName) {
    const ch = config.channels[channelName];
    if (!ch || ch.type !== "slack") return "";
    return (ch.credentials.appToken as string) || "";
  }

  const defaultCh = config.channels.slack;
  if (defaultCh?.type === "slack") {
    return (defaultCh.credentials.appToken as string) || "";
  }

  for (const [, ch] of getSlackChannelEntries(config)) {
    const token = (ch.credentials.appToken as string) || "";
    if (token) return token;
  }
  return "";
}

function resolveChannelNameForAddress(
  config: TgConfig,
  address: string,
  preferredChannelName?: string
): string | undefined {
  const parsed = parseChannelAddress(address);
  if (!parsed.type) return undefined;

  if (preferredChannelName) {
    const preferred = config.channels[preferredChannelName];
    if (preferred && preferred.type === parsed.type) return preferredChannelName;
  }

  if (parsed.channelName) {
    const scoped = config.channels[parsed.channelName];
    if (scoped && scoped.type === parsed.type) return parsed.channelName;
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (ch.type === parsed.type) return name;
  }
  return undefined;
}

// Helper to get the bot token from telegram channel config.
// Without channelName, returns the default `telegram` token when present,
// otherwise the first configured telegram token.
export function getTelegramBotToken(config: TgConfig, channelName?: string): string {
  if (channelName) {
    const ch = config.channels[channelName];
    if (!ch || ch.type !== "telegram") return "";
    return (ch.credentials.botToken as string) || "";
  }

  const defaultCh = config.channels.telegram;
  if (defaultCh?.type === "telegram") {
    return (defaultCh.credentials.botToken as string) || "";
  }

  for (const [, ch] of getTelegramChannelEntries(config)) {
    const token = (ch.credentials.botToken as string) || "";
    if (token) return token;
  }
  return "";
}

// Helper to get all paired users across all channels
export function getAllPairedUsers(config: TgConfig): PairedUser[] {
  const users: PairedUser[] = [];
  for (const ch of Object.values(config.channels)) {
    users.push(...ch.pairedUsers);
  }
  return users;
}

// Helper to get all linked groups across all channels
export function getAllLinkedGroups(config: TgConfig): LinkedGroup[] {
  const groups: LinkedGroup[] = [];
  for (const ch of Object.values(config.channels)) {
    groups.push(...(ch.linkedGroups || []));
  }
  return groups;
}

// Update a linked group's title if it changed. Returns true if updated.
export function updateLinkedGroupTitle(
  config: TgConfig,
  chatId: string,
  title: string,
  preferredChannelName?: string
): boolean {
  const channelName = resolveChannelNameForAddress(config, chatId, preferredChannelName);
  if (channelName) {
    const scoped = config.channels[channelName];
    const group = scoped?.linkedGroups?.find((g) => g.chatId === chatId);
    if (group && group.title !== title) {
      group.title = title;
      return true;
    }
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (channelName && name === channelName) continue;
    const group = ch.linkedGroups?.find((g) => g.chatId === chatId);
    if (group && group.title !== title) {
      group.title = title;
      return true;
    }
  }
  return false;
}

// Remove a linked group/topic by chatId. Returns true if removed.
export function removeLinkedGroup(
  config: TgConfig,
  chatId: string,
  preferredChannelName?: string
): boolean {
  const channelName = resolveChannelNameForAddress(config, chatId, preferredChannelName);
  if (channelName) {
    const scoped = config.channels[channelName];
    if (scoped?.linkedGroups) {
      const idx = scoped.linkedGroups.findIndex((g) => g.chatId === chatId);
      if (idx >= 0) {
        scoped.linkedGroups.splice(idx, 1);
        return true;
      }
    }
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (channelName && name === channelName) continue;
    if (!ch.linkedGroups) continue;
    const idx = ch.linkedGroups.findIndex((g) => g.chatId === chatId);
    if (idx >= 0) {
      ch.linkedGroups.splice(idx, 1);
      return true;
    }
  }
  return false;
}

// Add a linked group to the first channel that matches the type
export function addLinkedGroup(
  config: TgConfig,
  chatId: string,
  title?: string,
  preferredChannelName?: string
): boolean {
  const channelName = resolveChannelNameForAddress(config, chatId, preferredChannelName);
  if (!channelName) return false;
  const ch = config.channels[channelName];
  if (!ch) return false;
  if (!ch.linkedGroups) ch.linkedGroups = [];
  if (ch.linkedGroups.some((g) => g.chatId === chatId)) return false;
  ch.linkedGroups.push({ chatId, title, linkedAt: new Date().toISOString() });
  return true;
}

export function isLinkedGroup(config: TgConfig, chatId: string, preferredChannelName?: string): boolean {
  const channelName = resolveChannelNameForAddress(config, chatId, preferredChannelName);
  if (channelName) {
    const scoped = config.channels[channelName];
    if (scoped?.linkedGroups?.some((g) => g.chatId === chatId)) return true;
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (channelName && name === channelName) continue;
    if (ch.linkedGroups?.some((g) => g.chatId === chatId)) return true;
  }
  return false;
}

export function getLinkedGroupTitle(config: TgConfig, chatId: string, preferredChannelName?: string): string | undefined {
  const channelName = resolveChannelNameForAddress(config, chatId, preferredChannelName);
  if (channelName) {
    const scoped = config.channels[channelName];
    const group = scoped?.linkedGroups?.find((g) => g.chatId === chatId);
    if (group) return group.title;
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (channelName && name === channelName) continue;
    const group = ch.linkedGroups?.find((g) => g.chatId === chatId);
    if (group) return group.title;
  }
  return undefined;
}
