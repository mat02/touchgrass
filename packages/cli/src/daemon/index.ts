import { loadConfig, invalidateCache, saveConfig } from "../config/store";
import {
  addLinkedGroup,
  applyChatTranscriptPreset,
  getAllLinkedGroups,
  getAllPairedUsers,
  getChatDeliveryPreference,
  getChatOutputPreferences,
  getTelegramBotToken,
  isChatDeliveryMuted,
  isLinkedGroup,
  removeLinkedGroup,
  setChatDeliveryPreference,
  setChatOutputPreferences,
  type ChatDeliveryPreference,
  type ChatOutputPreferences,
  type PermanentMuteDeliveryPreference,
  type ThrottleDeliveryPreference,
  type TimedMuteDeliveryPreference,
} from "../config/schema";
import { TelegramApi } from "../channels/telegram/api";
import { debugLogIfEnabled, logger } from "./logger";
import {
  acquireDaemonLock,
  installSignalHandlers,
  onShutdown,
  removeAuthToken,
  removeControlPortFile,
  removeDaemonLock,
  removePidFile,
  removeSocket,
  writePidFile,
} from "./lifecycle";
import { startControlServer, type ChannelInfo, type ConfigChannelSummary, type ConfigChannelDetails, type ConversationEvent, type WaitStateEvent } from "./control-server";
import { routeMessage } from "../bot/command-router";
import {
  advanceOutputWizardSelection,
  buildOutputModeSummaryMessage,
  buildOutputPickerPrompt,
  getNextOutputWizardStep,
} from "../bot/handlers/output-mode";
import {
  buildMutePickerPrompt,
  buildMuteSummaryMessage,
  buildThrottlePickerPrompt,
  buildThrottleSummaryMessage,
} from "../bot/handlers/mute";
import type { BackgroundJobSessionSummary } from "../bot/handlers/background-jobs";
import { SessionManager } from "../session/manager";
import { formatSimpleToolResult, formatToolCall } from "./tool-display";
import { paths } from "../config/paths";
import { generatePairingCode } from "../security/pairing";
import { isUserPaired } from "../security/allowlist";
import { rotateDaemonAuthToken } from "../security/daemon-auth";
import { createChannel } from "../channel/factory";
import { InternalChannel } from "../channels/internal/channel";
import type { Formatter } from "../channel/formatter";
import type { Channel, ChannelChatId, ChannelUserId, StatusBoardFailureCode, StatusBoardResult } from "../channel/types";
import { getChannelName, getChannelType, getRootChatIdNumber, parseChannelAddress } from "../channel/id";
import type { AskQuestion, PendingFilePickerOption, PendingOutputModeOption } from "../session/manager";
import { readManifests } from "../bot/handlers/remote-control";
import { collectRecentActivityPreviewFromRaw, type DisplayEntry } from "../cli/peek";
import { chmod, open, readFile, realpath, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { createHash } from "crypto";

const DAEMON_STARTED_AT = Date.now();

/** Format a session label for messages: "my session" or "claude (myproject)" or just "claude" */
function sessionLabel(command: string, cwd: string, name?: string): string {
  if (name) return name;
  const tool = command.split(" ")[0];
  const folder = cwd.split("/").pop();
  return folder ? `${tool} (${folder})` : tool;
}

function formatThinkingNotification(
  fmt: Formatter,
  thinkingMode: ChatOutputPreferences["thinkingMode"],
  text: string
 ): string | null {
  if (thinkingMode === "off") return null;
  const body = thinkingMode === "preview"
    ? (text.length > 220 ? `${text.slice(0, 220)}...` : text)
    : text;
  return `${fmt.escape("💭")} ${fmt.italic(fmt.fromMarkdown(body))}`;
}

function formatToolResultNotification(
  fmt: Formatter,
  output: Pick<ChatOutputPreferences, "toolResultMode" | "toolErrors">,
  toolName: string,
  content: string,
  isError = false
 ): string | null {
  if (isError) {
    if (!output.toolErrors) return null;
  } else if (output.toolResultMode === "off") {
    return null;
  }

  if (!isError && output.toolResultMode === "full") {
    const maxLen = 1500;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + "\n..." : content;
    const label = (toolName === "Bash" || toolName === "bash" || toolName === "exec_command") ? "Output" : `${toolName} result`;
    return `${fmt.bold(fmt.escape(label))}\n${fmt.pre(fmt.escape(truncated))}`;
  }

  if (isError && output.toolResultMode === "full") {
    const maxLen = 1500;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + "\n..." : content;
    return `${fmt.bold(fmt.escape(`${toolName || "Tool"} error`))}\n${fmt.pre(fmt.escape(truncated))}`;
  }

  return formatSimpleToolResult(fmt, toolName, content, isError);
}

function buildRecentActivityReplayMessages(
  fmt: Formatter,
  raw: string,
  count: number
 ): { summaryMessage: string | null; assistantMessage: string | null } {
  const { recentEntries, lastAssistantEntry } = collectRecentActivityPreviewFromRaw(raw, count);
  if (recentEntries.length === 0) {
    return { summaryMessage: null, assistantMessage: null };
  }

  const recentSummaryEntries = (() => {
    if (!lastAssistantEntry) return recentEntries;
    const lastRecentEntry = recentEntries[recentEntries.length - 1];
    if (lastRecentEntry?.role !== "assistant") return recentEntries;
    if (lastRecentEntry.text !== lastAssistantEntry.text) return recentEntries;
    return recentEntries.slice(0, -1);
  })();

  const summaryMessage = recentSummaryEntries.length > 0
    ? `${fmt.escape("📋")} Recent activity:\n\n${recentSummaryEntries.map((entry: DisplayEntry) => {
      const roleLabel = entry.role === "assistant" ? "Assistant" : entry.role === "user" ? "User" : "Tool";
      const text = entry.text.length > 200 ? `${entry.text.slice(0, 200)}…` : entry.text;
      return `${fmt.bold(`[${roleLabel}]`)} ${fmt.escape(text)}`;
    }).join("\n")}`
    : null;

  if (!lastAssistantEntry) {
    return { summaryMessage, assistantMessage: null };
  }

  const assistantMessage = `${fmt.escape("🤖")} ${fmt.bold("[Assistant]")} ${fmt.escape(lastAssistantEntry.text)}`;
  return { summaryMessage, assistantMessage };

}

const DELIVERY_BUFFER_ENTRY_LIMIT = 24;
const DELIVERY_BUFFER_MAX_AGE_MS = 2 * 60 * 60_000;
const DELIVERY_SUMMARY_LIMIT = 6;
const DELIVERY_REPLAY_COUNT = 3;
const DELIVERY_SWEEP_INTERVAL_MS = 5_000;
const PERMANENT_MUTE_AWAITING_USER_DELAY_MS = 60 * 60_000;

interface BufferedDeliveryEntry {
  at: number;
  role: DisplayEntry["role"];
  summaryText: string | null;
  fullMessage: string | null;
  countsForSummary: boolean;
  countsForReplay: boolean;
}

interface ChatDeliveryRuntimeState {
  entries: BufferedDeliveryEntry[];
  lastBufferedAt: number | null;
  lastFlushAt: number | null;
}

function isThrottleDeliveryPreference(
  delivery: ChatDeliveryPreference
): delivery is ThrottleDeliveryPreference {
  return delivery.mode === "throttle";
}

function isTimedMuteDeliveryPreference(
  delivery: ChatDeliveryPreference
): delivery is TimedMuteDeliveryPreference {
  return delivery.mode === "mute" && delivery.kind === "timed";
}

function isPermanentMuteDeliveryPreference(
  delivery: ChatDeliveryPreference
): delivery is PermanentMuteDeliveryPreference {
  return delivery.mode === "mute" && delivery.kind === "permanent";
}

function truncateDeliverySummary(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDeliveryMinutes(minutes: number): string {
  if (minutes === 60) return "1 hour";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}


function buildBufferedSummaryMessage(fmt: Formatter, entries: BufferedDeliveryEntry[]): string | null {
  const summaryEntries = entries
    .filter((entry) => entry.countsForSummary && entry.summaryText)
    .slice(-DELIVERY_SUMMARY_LIMIT);
  if (summaryEntries.length === 0) return null;
  return `${fmt.escape("📋")} Recent activity:\n\n${summaryEntries.map((entry) => {
    const roleLabel = entry.role === "assistant" ? "Assistant" : entry.role === "user" ? "User" : "Tool";
    return `${fmt.bold(`[${roleLabel}]`)} ${fmt.escape(truncateDeliverySummary(entry.summaryText || ""))}`;
  }).join("\n")}`;
}

function selectBufferedReplayEntries(entries: BufferedDeliveryEntry[], count: number): BufferedDeliveryEntry[] {
  const candidates = entries.filter((entry) => entry.countsForReplay && entry.fullMessage);
  const latestAssistant = [...candidates].reverse().find((entry) => entry.role === "assistant") || null;
  const selected: BufferedDeliveryEntry[] = [];
  if (latestAssistant) selected.push(latestAssistant);
  for (let i = candidates.length - 1; i >= 0 && selected.length < count; i--) {
    const candidate = candidates[i];
    if (!candidate) continue;
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
  }
  return selected.reverse();
}

function buildBufferedDeliveryFlush(fmt: Formatter, entries: BufferedDeliveryEntry[]): {
  summaryMessage: string | null;
  replayMessages: string[];
} {
  return {
    summaryMessage: buildBufferedSummaryMessage(fmt, entries),
    replayMessages: selectBufferedReplayEntries(entries, DELIVERY_REPLAY_COUNT)
      .map((entry) => entry.fullMessage)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  };
}

function selectAutomaticBufferedDeliveryMessages(
  fmt: Formatter,
  entries: BufferedDeliveryEntry[],
  options?: { noticeMessage?: string; includeReplay?: boolean }
): string[] {
  const flush = entries.length > 0
    ? buildBufferedDeliveryFlush(fmt, entries)
    : { summaryMessage: null, replayMessages: [] };
  const replayMessages = options?.includeReplay === false
    ? []
    : flush.replayMessages.slice(0, DELIVERY_REPLAY_COUNT);
  return [
    options?.noticeMessage || null,
    flush.summaryMessage,
    ...replayMessages,
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
}



function createOrderedConversationQueue(deps: {
  getTimeoutMs: () => number;
  logSkip: (chatId: ChannelChatId, error: Error) => Promise<void>;
  onSkip: (chatId: ChannelChatId, timeoutMs: number) => Promise<void>;
}): (chatId: ChannelChatId, deliver: (timeoutMs: number) => Promise<void>) => void {
  const queues = new Map<ChannelChatId, Promise<void>>();
  return (chatId, deliver) => {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const timeoutMs = deps.getTimeoutMs();
        try {
          await deliver(timeoutMs);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await deps.logSkip(chatId, err);
          await deps.onSkip(chatId, timeoutMs);
        }
      })
      .finally(() => {
        if (queues.get(chatId) === current) queues.delete(chatId);
      });
    queues.set(chatId, current);
  };
}

function createQuestionPollScheduler(deps: {
  getPendingQuestions: (sessionId: string) => { chatId: ChannelChatId } | null;
  hasActivePollForSession: (sessionId: string) => boolean;
  isChatMutedForChat: (chatId: ChannelChatId) => boolean;
  enqueueOrderedConversationDelivery: (
    chatId: ChannelChatId,
    deliver: (timeoutMs: number) => Promise<void>
  ) => void;
  sendNextPoll: (sessionId: string, sendOptions?: { timeoutMs?: number }) => Promise<void>;
}): (sessionId: string) => void {
  return (sessionId) => {
    const pending = deps.getPendingQuestions(sessionId);
    if (!pending || deps.hasActivePollForSession(sessionId)) return;
    const chatId = pending.chatId;
    deps.enqueueOrderedConversationDelivery(chatId, async (timeoutMs) => {
      if (deps.hasActivePollForSession(sessionId)) return;
      if (deps.isChatMutedForChat(chatId)) return;
      await deps.sendNextPoll(sessionId, { timeoutMs });
    });
  };
}

function clearInteractiveStateForLocalPromptSubmit(deps: {
  clearPendingQuestions: (sessionId: string) => void;
  clearPendingApproval: (sessionId: string) => void;
  getActivePollForSession: (sessionId: string) => { pollId: string; poll: { chatId: ChannelChatId; messageId: string } } | undefined;
  removePoll: (pollId: string) => void;
  closePollForChat: (chatId: ChannelChatId, messageId: string) => void;
}, sessionId: string): void {
  const active = deps.getActivePollForSession(sessionId);
  deps.clearPendingQuestions(sessionId);
  deps.clearPendingApproval(sessionId);
  if (!active) return;
  deps.removePoll(active.pollId);
  deps.closePollForChat(active.poll.chatId, active.poll.messageId);
}

export const __daemonTestUtils = {
  createOrderedConversationQueue,
  createQuestionPollScheduler,
  clearInteractiveStateForLocalPromptSubmit,
  formatThinkingNotification,
  formatToolResultNotification,
  buildRecentActivityReplayMessages,
  buildBufferedDeliveryFlush,
  selectAutomaticBufferedDeliveryMessages,
  createWaitCycleState,
  applyWaitStateEventToCycleState,
  handleWaitStateForSessionState,
  waitCycleCanFinalizeState,
  renderActiveWaitBoardState,
  renderFinalWaitBoardState,
  renderInterruptedWaitBoardState,
  markWaitCycleStopRequestedState,
  maintainWaitCycleHeartbeatState,
  refreshWaitCycleBoardsState,
  finalizeWaitCycleBoardsState,
  cleanupInterruptedWaitCycleBoardsState,
};


type BackgroundJobStatus = "running" | "completed" | "failed" | "killed";

interface BackgroundJobState {
  taskId: string;
  status: BackgroundJobStatus;
  command?: string;
  outputFile?: string;
  summary?: string;
  urls?: string[];
  updatedAt: number;
}

interface BackgroundJobEvent {
  taskId: string;
  status: string;
  command?: string;
  outputFile?: string;
  summary?: string;
  urls?: string[];
}

type WaitTrackedItemStatus = NonNullable<WaitStateEvent["items"][number]["status"]>;
type WaitCycleCompletionReason = "normal" | "stop_requested";
type WaitBoardRetryFailureCode = Extract<StatusBoardFailureCode, "timeout" | "text_too_long">;

interface WaitTrackedItemState {
  itemKey: string;
  title?: string;
  agentId?: string;
  status: WaitTrackedItemStatus;
  detail?: string;
  updatedAt: number;
}

interface WaitChatHeartbeatState {
  lastPulseAt: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

interface WaitBoardRetryState {
  fingerprint: string;
  failureCode: WaitBoardRetryFailureCode;
  htmlLength: number;
}

interface WaitBoardLogEvent {
  category: "wait_board_active" | "wait_board_final" | "wait_board_interrupted";
  operation: "send" | "edit" | "skip" | "timeout" | "error" | "clear";
  sessionId: string;
  chatId: ChannelChatId;
  boardKey: string;
  waitItemCount: number;
  htmlLength: number;
  fingerprint?: string;
  messageId?: string;
  failureCode?: StatusBoardFailureCode;
  compact?: boolean;
  note?: string;
}

interface WaitCycleState {
  cycleId: number;
  boardKey: string;
  createdAt: number;
  openWaitGroups: Set<string>;
  items: Map<string, WaitTrackedItemState>;
  heartbeatByChat: Map<ChannelChatId, WaitChatHeartbeatState>;
  boardRetryByChat: Map<ChannelChatId, WaitBoardRetryState>;
  completionReason: WaitCycleCompletionReason;
  finalizing: boolean;
  finalSummary?: string;
  lastBoardRefreshAt: number;
}

interface PersistedStatusBoardEntry {
  chatId: string;
  boardKey: string;
  messageId: string;
  pinned: boolean;
  updatedAt: number;
}

interface PersistedActiveWaitCycleEntry {
  sessionId: string;
  cycleId: number;
  boardKey: string;
  activeChatIds: string[];
}

interface SessionManifest {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  jsonlFile: string | null;
  startedAt: string;
}

const WAIT_HEARTBEAT_PULSE_MS = 5_000;
const WAIT_HEARTBEAT_INTERVAL_MS = 60_000;
const WAIT_BOARD_DETAIL_MAX = 280;
const WAIT_BOARD_MAX_CHARS = 3_500;
const WAIT_BOARD_MAX_ITEMS = 18;
const WAIT_TERMINAL_STATUSES = new Set<WaitTrackedItemStatus>(["completed", "failed", "blocked"]);

interface WaitBoardOps {
  getConversationTargets(sessionId: string): Set<ChannelChatId>;
  getOutputPreferencesForChat(chatId: ChannelChatId): Pick<ChatOutputPreferences, "typingIndicator">;
  getChannelForChat(chatId: ChannelChatId): Pick<Channel, "upsertStatusBoard" | "clearStatusBoard" | "setTyping"> | undefined;
  getFormatterForChat(chatId: ChannelChatId): Formatter;
  getPersistedStatusBoard(chatId: ChannelChatId, boardKey: string): PersistedStatusBoardEntry | undefined;
  listPersistedStatusBoardsForBoard(boardKey: string): PersistedStatusBoardEntry[];
  setPersistedStatusBoard(chatId: ChannelChatId, boardKey: string, messageId: string, pinned: boolean): void;
  removePersistedStatusBoard(chatId: ChannelChatId, boardKey: string): void;
  getPersistedActiveWaitCycle(boardKey: string): PersistedActiveWaitCycleEntry | undefined;
  syncPersistedActiveWaitCycle(sessionId: string, cycle: WaitCycleState, activeChatIds: Iterable<ChannelChatId>): void;
  syncPersistedWaitCycleRetryState(entry: PersistedActiveWaitCycleEntry, activeChatIds: Iterable<ChannelChatId>): void;
  removePersistedActiveWaitCycle(boardKey: string): void;
  listPersistedWaitCyclesForCleanup(): PersistedActiveWaitCycleEntry[];
  setTyping(chatId: ChannelChatId, active: boolean): void;
  setStopTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearStopTimer(timer: ReturnType<typeof setTimeout>): void;
  logWaitBoardEvent?(event: WaitBoardLogEvent): Promise<void> | void;
}

function createWaitCycleState(sessionId: string, cycleId: number, now = Date.now()): WaitCycleState {
  return {
    cycleId,
    boardKey: `wait-cycle:${sessionId}:${cycleId}`,
    createdAt: now,
    openWaitGroups: new Set<string>(),
    items: new Map<string, WaitTrackedItemState>(),
    heartbeatByChat: new Map<ChannelChatId, WaitChatHeartbeatState>(),
    boardRetryByChat: new Map<ChannelChatId, WaitBoardRetryState>(),
    completionReason: "normal",
    finalizing: false,
    lastBoardRefreshAt: 0,
  };
}

function normalizeWaitText(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeWaitDetail(value?: string | null): string | undefined {
  const trimmed = normalizeWaitText(value);
  if (!trimmed) return undefined;
  return trimmed.length > WAIT_BOARD_DETAIL_MAX ? `${trimmed.slice(0, WAIT_BOARD_DETAIL_MAX - 3)}...` : trimmed;
}

function waitStatusLabel(status: WaitTrackedItemStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
  }
}

function isTerminalWaitStatus(status: WaitTrackedItemStatus): boolean {
  return WAIT_TERMINAL_STATUSES.has(status);
}

function createDeliveryFingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function getOrderedWaitItems(cycle: WaitCycleState): WaitTrackedItemState[] {
  const statusOrder: Record<WaitTrackedItemStatus, number> = {
    running: 0,
    queued: 1,
    failed: 2,
    blocked: 3,
    completed: 4,
  };
  return Array.from(cycle.items.values()).sort((a, b) => {
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.updatedAt - a.updatedAt;
  });
}

function renderWaitItemLines(chatId: ChannelChatId, item: WaitTrackedItemState, fmt: Formatter): string[] {
  const title = normalizeWaitText(item.title);
  const agentId = normalizeWaitText(item.agentId);
  const identity = title || agentId || item.itemKey;
  const head = title
    ? `${fmt.bold(fmt.escape(title))}${agentId ? ` ${fmt.escape("—")} ${fmt.code(fmt.escape(agentId))}` : ""}`
    : agentId
    ? fmt.code(fmt.escape(agentId))
    : fmt.code(fmt.escape(identity));
  const lines = [`• ${head} ${fmt.escape("—")} ${fmt.escape(waitStatusLabel(item.status))}`];
  const detail = normalizeWaitDetail(item.detail);
  if (detail) lines.push(`  ${fmt.escape(detail)}`);
  return lines;
}

function renderWaitBoardLines(
  chatId: ChannelChatId,
  items: WaitTrackedItemState[],
  fmt: Formatter,
  headerLines: string[],
  emptyLine: string,
  maxItems = WAIT_BOARD_MAX_ITEMS
  ): string {
  if (items.length === 0) return [...headerLines, fmt.escape(emptyLine)].join("\n");

  const blocks: string[][] = [];
  for (const item of items) {
    if (blocks.length >= maxItems) break;
    const candidateBlocks = [...blocks, renderWaitItemLines(chatId, item, fmt)];
    const remaining = items.length - candidateBlocks.length;
    const candidateLines = [...headerLines, ...candidateBlocks.flat()];
    if (remaining > 0) candidateLines.push(fmt.escape(`… +${remaining} more task${remaining === 1 ? "" : "s"}`));
    if (candidateLines.join("\n").length > WAIT_BOARD_MAX_CHARS) break;
    blocks.push(renderWaitItemLines(chatId, item, fmt));
  }

  let hidden = items.length - blocks.length;
  let visibleBlocks = blocks;
  while (hidden > 0) {
    const overflowLine = fmt.escape(`… +${hidden} more task${hidden === 1 ? "" : "s"}`);
    const candidateLines = [...headerLines, ...visibleBlocks.flat(), overflowLine];
    if (candidateLines.join("\n").length <= WAIT_BOARD_MAX_CHARS) {
      return candidateLines.join("\n");
    }
    if (visibleBlocks.length === 0) break;
    visibleBlocks = visibleBlocks.slice(0, -1);
    hidden += 1;
  }

  const visibleLines = [...headerLines, ...visibleBlocks.flat()];
  if (visibleLines.join("\n").length <= WAIT_BOARD_MAX_CHARS && visibleBlocks.length > 0) return visibleLines.join("\n");
  return [...headerLines, fmt.escape(`… +${items.length} tracked task${items.length === 1 ? "" : "s"}`)].join("\n");
}

function renderActiveWaitBoardState(chatId: ChannelChatId, cycle: WaitCycleState, fmt: Formatter): string {
  const items = getOrderedWaitItems(cycle);
  return renderWaitBoardLines(
    chatId,
    items,
    fmt,
    [`${fmt.escape("⏳")} ${fmt.bold(fmt.escape(`Waiting on ${items.length} task${items.length === 1 ? "" : "s"}`))}`],
    "Waiting for task updates..."
  );
}

function getFinalWaitOutcome(cycle: WaitCycleState): { emoji: string; label: string } {
  if (cycle.completionReason === "stop_requested") return { emoji: "🛑", label: "Stop requested" };
  const items = Array.from(cycle.items.values());
  if (items.some((item) => item.status === "failed")) return { emoji: "❌", label: "Wait finished with failures" };
  if (items.some((item) => item.status === "blocked")) return { emoji: "🛑", label: "Wait blocked" };
  return { emoji: "✅", label: "Wait complete" };
}

function renderFinalWaitBoardState(chatId: ChannelChatId, cycle: WaitCycleState, fmt: Formatter): string {
  const items = getOrderedWaitItems(cycle);
  const outcome = getFinalWaitOutcome(cycle);
  const summary = normalizeWaitDetail(cycle.finalSummary);
  const headerLines = [`${fmt.escape(outcome.emoji)} ${fmt.bold(fmt.escape(outcome.label))}`];
  if (summary) headerLines.push(fmt.escape(summary));
  else if (items.length > 0) headerLines.push(fmt.escape(`${items.length} task${items.length === 1 ? "" : "s"} reached terminal status.`));
  return renderWaitBoardLines(chatId, items, fmt, headerLines, "No wait items were reported.");
}

function renderCompactStopRequestedWaitBoardState(chatId: ChannelChatId, cycle: WaitCycleState, fmt: Formatter): string {
  const items = getOrderedWaitItems(cycle);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, blocked: 0 } satisfies Record<WaitTrackedItemStatus, number>;
  for (const item of items) counts[item.status] += 1;
  const parts = ([
    counts.running ? `${counts.running} running` : null,
    counts.queued ? `${counts.queued} queued` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.blocked ? `${counts.blocked} blocked` : null,
    counts.completed ? `${counts.completed} completed` : null,
  ].filter((value): value is string => value !== null));
  const lines = [
    `${fmt.escape("🛑")} ${fmt.bold(fmt.escape("Stop requested"))}`,
    fmt.escape(normalizeWaitDetail(cycle.finalSummary) || "Wait tracking stopped at user request."),
    fmt.escape(
      items.length === 0
        ? "No wait items were reported."
        : `${items.length} tracked task${items.length === 1 ? "" : "s"}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`
    ),
  ];
  return lines.join("\n");
}

function renderInterruptedWaitBoardState(chatId: ChannelChatId, fmt: Formatter): string {
  return [
    `${fmt.escape("⚠️")} ${fmt.bold(fmt.escape("Wait tracking interrupted after daemon restart"))}`,
    fmt.escape("This wait board was closed. A later wait will start a new board."),
  ].join("\n");
}

function applyWaitStateEventToCycleState(cycle: WaitCycleState, event: WaitStateEvent, now = Date.now()): void {
  if (event.phase === "startOrUpdate") cycle.openWaitGroups.add(event.waitGroupKey);
  else cycle.openWaitGroups.delete(event.waitGroupKey);

  for (const patch of event.items) {
    const existing = cycle.items.get(patch.itemKey);
    const nextStatus = patch.status || existing?.status || (event.phase === "finish" ? "completed" : "running");
    cycle.items.set(patch.itemKey, {
      itemKey: patch.itemKey,
      title: patch.title !== undefined ? normalizeWaitText(patch.title) : existing?.title,
      agentId: patch.agentId !== undefined ? normalizeWaitText(patch.agentId) : existing?.agentId,
      status: nextStatus,
      detail: patch.detail !== undefined ? normalizeWaitDetail(patch.detail) : existing?.detail,
      updatedAt: now,
    });
  }

  const summary = normalizeWaitText(event.summary);
  if (summary) cycle.finalSummary = summary;
  else if (event.phase === "startOrUpdate") cycle.finalSummary = undefined;
}

function waitCycleCanFinalizeState(cycle: WaitCycleState): boolean {
  if (cycle.openWaitGroups.size > 0) return false;
  return Array.from(cycle.items.values()).every((item) => isTerminalWaitStatus(item.status));
}

function handleWaitStateForSessionState(
  activeCyclesBySession: Map<string, WaitCycleState>,
  sessionId: string,
  event: WaitStateEvent,
  createCycle: () => WaitCycleState,
  now = Date.now()
  ): { cycle: WaitCycleState; shouldFinalize: boolean } {
  let cycle = activeCyclesBySession.get(sessionId);
  if (!cycle) {
    cycle = createCycle();
    activeCyclesBySession.set(sessionId, cycle);
  }
  applyWaitStateEventToCycleState(cycle, event, now);
  return { cycle, shouldFinalize: waitCycleCanFinalizeState(cycle) };
}

function stopWaitHeartbeatForChatState(cycle: WaitCycleState, chatId: ChannelChatId, ops: WaitBoardOps): void {
  const heartbeat = cycle.heartbeatByChat.get(chatId);
  if (heartbeat?.stopTimer) ops.clearStopTimer(heartbeat.stopTimer);
  cycle.heartbeatByChat.delete(chatId);
  ops.setTyping(chatId, false);
}

function maintainWaitCycleHeartbeatState(sessionId: string, cycle: WaitCycleState, ops: WaitBoardOps, now = Date.now()): void {
  const eligibleChats = new Set<ChannelChatId>();
  for (const chatId of ops.getConversationTargets(sessionId)) {
    if (!ops.getOutputPreferencesForChat(chatId).typingIndicator) continue;
    eligibleChats.add(chatId);
  }

  for (const chatId of Array.from(cycle.heartbeatByChat.keys())) {
    if (!eligibleChats.has(chatId)) stopWaitHeartbeatForChatState(cycle, chatId, ops);
  }

  for (const chatId of eligibleChats) {
    const current = cycle.heartbeatByChat.get(chatId) || { lastPulseAt: 0, stopTimer: null };
    if (current.lastPulseAt !== 0 && now - current.lastPulseAt < WAIT_HEARTBEAT_INTERVAL_MS) {
      cycle.heartbeatByChat.set(chatId, current);
      continue;
    }
    if (current.stopTimer) ops.clearStopTimer(current.stopTimer);
    ops.setTyping(chatId, true);
    current.lastPulseAt = now;
    current.stopTimer = ops.setStopTimer(() => {
      current.stopTimer = null;
      ops.setTyping(chatId, false);
    }, WAIT_HEARTBEAT_PULSE_MS);
    cycle.heartbeatByChat.set(chatId, current);
  }
}

function markWaitCycleStopRequestedState(cycle: WaitCycleState, now = Date.now()): void {
  cycle.completionReason = "stop_requested";
  cycle.openWaitGroups.clear();
  cycle.finalSummary = normalizeWaitDetail(cycle.finalSummary) || "Wait tracking stopped at user request.";
  cycle.boardRetryByChat.clear();
  for (const item of cycle.items.values()) {
    if (isTerminalWaitStatus(item.status)) continue;
    item.status = "blocked";
    item.updatedAt = now;
  }
}

async function logWaitBoardEventState(ops: WaitBoardOps, event: WaitBoardLogEvent): Promise<void> {
  await ops.logWaitBoardEvent?.(event);
}

function getStatusBoardResultState(value: void | StatusBoardResult): StatusBoardResult | undefined {
  return value && typeof value === "object" ? value : undefined;
}

function rememberWaitBoardFailure(
  cycle: WaitCycleState,
  chatId: ChannelChatId,
  fingerprint: string,
  htmlLength: number,
  failureCode: WaitBoardRetryFailureCode
): void {
  cycle.boardRetryByChat.set(chatId, { fingerprint, htmlLength, failureCode });
}

function clearWaitBoardFailure(cycle: WaitCycleState, chatId: ChannelChatId): void {
  cycle.boardRetryByChat.delete(chatId);
}

async function refreshWaitCycleBoardsState(sessionId: string, cycle: WaitCycleState, ops: WaitBoardOps): Promise<void> {
  const key = cycle.boardKey;
  const targets = ops.getConversationTargets(sessionId);
  const entriesForCycle = ops.listPersistedStatusBoardsForBoard(key);
  const boardOwningChats = new Set<ChannelChatId>(
    entriesForCycle.filter((entry) => targets.has(entry.chatId)).map((entry) => entry.chatId as ChannelChatId)
  );

  for (const entry of entriesForCycle) {
    if (targets.has(entry.chatId as ChannelChatId)) continue;
    const chatId = entry.chatId as ChannelChatId;
    const channel = ops.getChannelForChat(chatId);
    let cleared = false;
    try {
      if (channel?.clearStatusBoard) {
        await channel.clearStatusBoard(chatId, key, { unpin: true, messageId: entry.messageId, pinned: entry.pinned });
        cleared = true;
      }
    } catch {}
    if (cleared) {
      ops.removePersistedStatusBoard(chatId, key);
      clearWaitBoardFailure(cycle, chatId);
      await logWaitBoardEventState(ops, {
        category: "wait_board_active",
        operation: "clear",
        sessionId,
        chatId,
        boardKey: key,
        waitItemCount: cycle.items.size,
        htmlLength: 0,
        messageId: entry.messageId,
      });
    } else {
      boardOwningChats.add(chatId);
    }
    stopWaitHeartbeatForChatState(cycle, chatId, ops);
  }

  for (const chatId of targets) {
    const channel = ops.getChannelForChat(chatId);
    const persisted = ops.getPersistedStatusBoard(chatId, key);
    if (!channel?.upsertStatusBoard) {
      try {
        await channel?.clearStatusBoard?.(chatId, key, { unpin: true, messageId: persisted?.messageId, pinned: persisted?.pinned });
      } catch {}
      ops.removePersistedStatusBoard(chatId, key);
      clearWaitBoardFailure(cycle, chatId);
      continue;
    }

    const html = renderActiveWaitBoardState(chatId, cycle, ops.getFormatterForChat(chatId));
    const fingerprint = createDeliveryFingerprint(html);
    const retryState = !persisted?.messageId ? cycle.boardRetryByChat.get(chatId) : undefined;
    if (retryState?.fingerprint === fingerprint) {
      await logWaitBoardEventState(ops, {
        category: "wait_board_active",
        operation: retryState.failureCode === "timeout" ? "timeout" : "skip",
        sessionId,
        chatId,
        boardKey: key,
        waitItemCount: cycle.items.size,
        htmlLength: retryState.htmlLength,
        fingerprint,
        failureCode: retryState.failureCode,
        note: "Skipping repeated board attempt until content changes.",
      });
      continue;
    }

    await logWaitBoardEventState(ops, {
      category: "wait_board_active",
      operation: persisted?.messageId ? "edit" : "send",
      sessionId,
      chatId,
      boardKey: key,
      waitItemCount: cycle.items.size,
      htmlLength: html.length,
      fingerprint,
      messageId: persisted?.messageId,
    });

    const boardResult = getStatusBoardResultState(await channel.upsertStatusBoard(chatId, key, html, {
      pin: true,
      messageId: persisted?.messageId,
      pinned: persisted?.pinned,
    }));
    if (boardResult?.action === "failed") {
      if (persisted?.messageId) boardOwningChats.add(chatId);
      if (boardResult.failureCode === "timeout" || boardResult.failureCode === "text_too_long") {
        if (!persisted?.messageId) {
          rememberWaitBoardFailure(cycle, chatId, fingerprint, html.length, boardResult.failureCode);
        } else {
          clearWaitBoardFailure(cycle, chatId);
        }
        await logWaitBoardEventState(ops, {
          category: "wait_board_active",
          operation: boardResult.failureCode === "timeout" ? "timeout" : "error",
          sessionId,
          chatId,
          boardKey: key,
          waitItemCount: cycle.items.size,
          htmlLength: html.length,
          fingerprint,
          failureCode: boardResult.failureCode,
          note: boardResult.error,
        });
      } else {
        clearWaitBoardFailure(cycle, chatId);
      }
      continue;
    }
    const messageId = boardResult?.messageId || persisted?.messageId;
    const pinned = boardResult?.pinned ?? persisted?.pinned ?? false;
    if (messageId) {
      ops.setPersistedStatusBoard(chatId, key, messageId, pinned);
      boardOwningChats.add(chatId);
      clearWaitBoardFailure(cycle, chatId);
      continue;
    }
    clearWaitBoardFailure(cycle, chatId);
  }

  ops.syncPersistedActiveWaitCycle(sessionId, cycle, boardOwningChats);
}

async function finalizeWaitCycleBoardsState(sessionId: string, cycle: WaitCycleState, ops: WaitBoardOps): Promise<void> {
  cycle.finalizing = true;
  for (const chatId of Array.from(cycle.heartbeatByChat.keys())) stopWaitHeartbeatForChatState(cycle, chatId, ops);
  const key = cycle.boardKey;
  const entriesForCycle = ops.listPersistedStatusBoardsForBoard(key);
  const activeEntry = ops.getPersistedActiveWaitCycle(key);
  const chats = new Set<ChannelChatId>([
    ...entriesForCycle.map((entry) => entry.chatId as ChannelChatId),
    ...((activeEntry?.activeChatIds || []) as ChannelChatId[]),
    ...ops.getConversationTargets(sessionId),
  ]);
  const currentTargets = ops.getConversationTargets(sessionId);
  const unresolvedChats = new Set<ChannelChatId>();

  for (const chatId of chats) {
    const channel = ops.getChannelForChat(chatId);
    const persisted = ops.getPersistedStatusBoard(chatId, key);
    let cleaned = false;

    if (!currentTargets.has(chatId)) {
      try {
        if (channel?.clearStatusBoard) {
          await channel.clearStatusBoard(chatId, key, { unpin: true, messageId: persisted?.messageId, pinned: persisted?.pinned });
          cleaned = true;
        }
      } catch {}
      if (cleaned) {
        ops.removePersistedStatusBoard(chatId, key);
        clearWaitBoardFailure(cycle, chatId);
      } else if (persisted?.messageId) {
        unresolvedChats.add(chatId);
      }
      continue;
    }

    const formatter = ops.getFormatterForChat(chatId);
    let html = renderFinalWaitBoardState(chatId, cycle, formatter);
    let compact = false;
    let boardResult: StatusBoardResult | undefined;
    let messageId = persisted?.messageId;
    let pinned = persisted?.pinned ?? false;
    if (channel?.upsertStatusBoard) {
      await logWaitBoardEventState(ops, {
        category: "wait_board_final",
        operation: messageId ? "edit" : "send",
        sessionId,
        chatId,
        boardKey: key,
        waitItemCount: cycle.items.size,
        htmlLength: html.length,
        fingerprint: createDeliveryFingerprint(html),
        messageId,
      });
      boardResult = getStatusBoardResultState(await channel.upsertStatusBoard(chatId, key, html, {
        pin: false,
        messageId,
        pinned,
      }));
      if (boardResult?.action !== "failed") {
        messageId = boardResult?.messageId || messageId;
        pinned = boardResult?.pinned ?? pinned;
      }

      if (cycle.completionReason === "stop_requested" && boardResult?.failureCode === "text_too_long") {
        html = renderCompactStopRequestedWaitBoardState(chatId, cycle, formatter);
        compact = true;
        await logWaitBoardEventState(ops, {
          category: "wait_board_final",
          operation: "send",
          sessionId,
          chatId,
          boardKey: key,
          waitItemCount: cycle.items.size,
          htmlLength: html.length,
          fingerprint: createDeliveryFingerprint(html),
          compact: true,
          note: "Retrying final stop board with compact summary.",
        });
        boardResult = getStatusBoardResultState(await channel.upsertStatusBoard(chatId, key, html, {
          pin: false,
          messageId,
          pinned,
        }));
        if (boardResult?.action !== "failed") {
          messageId = boardResult?.messageId || messageId;
          pinned = boardResult?.pinned ?? pinned;
        }
      }
    }

    if (boardResult?.action === "failed") {
      await logWaitBoardEventState(ops, {
        category: "wait_board_final",
        operation: boardResult.failureCode === "timeout" ? "timeout" : "error",
        sessionId,
        chatId,
        boardKey: key,
        waitItemCount: cycle.items.size,
        htmlLength: html.length,
        fingerprint: createDeliveryFingerprint(html),
        failureCode: boardResult.failureCode,
        compact,
        note: boardResult.error,
      });
      if (persisted?.messageId) unresolvedChats.add(chatId);
      continue;
    }

    if (messageId) {
      ops.setPersistedStatusBoard(chatId, key, messageId, pinned);
      clearWaitBoardFailure(cycle, chatId);
    }

    if (messageId && channel?.clearStatusBoard) {
      try {
        await channel.clearStatusBoard(chatId, key, { unpin: true, messageId, pinned });
        cleaned = true;
        await logWaitBoardEventState(ops, {
          category: "wait_board_final",
          operation: "clear",
          sessionId,
          chatId,
          boardKey: key,
          waitItemCount: cycle.items.size,
          htmlLength: html.length,
          fingerprint: createDeliveryFingerprint(html),
          messageId,
          compact,
        });
      } catch {}
    }

    if (!cleaned && channel?.clearStatusBoard) {
      try {
        await channel.clearStatusBoard(chatId, key, { unpin: true, messageId: persisted?.messageId, pinned: persisted?.pinned });
        cleaned = true;
      } catch {}
    }

    if (cleaned) ops.removePersistedStatusBoard(chatId, key);
    else if (messageId) unresolvedChats.add(chatId);
  }

  const retryEntry = activeEntry ?? { sessionId, cycleId: cycle.cycleId, boardKey: key, activeChatIds: [] };
  ops.syncPersistedWaitCycleRetryState(retryEntry, unresolvedChats);
  if (unresolvedChats.size === 0) ops.removePersistedActiveWaitCycle(key);
  cycle.finalizing = false;
}

async function cleanupInterruptedWaitCycleBoardsState(ops: WaitBoardOps): Promise<void> {
  for (const entry of ops.listPersistedWaitCyclesForCleanup()) {
    const persistedEntriesForCycle = ops.listPersistedStatusBoardsForBoard(entry.boardKey);
    const chats = new Set<ChannelChatId>([
      ...(entry.activeChatIds as ChannelChatId[]),
      ...persistedEntriesForCycle.map((persistedEntry) => persistedEntry.chatId as ChannelChatId),
    ]);
    const unresolvedChats = new Set<ChannelChatId>();

    for (const chatId of chats) {
      const channel = ops.getChannelForChat(chatId);
      const persisted = ops.getPersistedStatusBoard(chatId, entry.boardKey);
      let cleaned = false;

      if (channel?.upsertStatusBoard && persisted?.messageId) {
        const html = renderInterruptedWaitBoardState(chatId, ops.getFormatterForChat(chatId));
        await logWaitBoardEventState(ops, {
          category: "wait_board_interrupted",
          operation: "edit",
          sessionId: entry.sessionId,
          chatId,
          boardKey: entry.boardKey,
          waitItemCount: 0,
          htmlLength: html.length,
          fingerprint: createDeliveryFingerprint(html),
          messageId: persisted.messageId,
        });
        const boardResult = getStatusBoardResultState(await channel.upsertStatusBoard(
          chatId,
          entry.boardKey,
          html,
          { pin: false, messageId: persisted.messageId, pinned: persisted.pinned }
        ));
        const messageId = boardResult?.messageId || persisted.messageId;
        const pinned = boardResult?.pinned ?? persisted.pinned ?? false;
        if (messageId) ops.setPersistedStatusBoard(chatId, entry.boardKey, messageId, pinned);
        if (messageId && channel.clearStatusBoard) {
          try {
            await channel.clearStatusBoard(chatId, entry.boardKey, { unpin: true, messageId, pinned });
            cleaned = true;
          } catch {}
        }
      }

      if (!cleaned) {
        try {
          if (channel?.clearStatusBoard) {
            await channel.clearStatusBoard(chatId, entry.boardKey, { unpin: true, messageId: persisted?.messageId, pinned: persisted?.pinned });
            cleaned = true;
          }
        } catch {}
      }

      if (cleaned) ops.removePersistedStatusBoard(chatId, entry.boardKey);
      else if (persisted?.messageId) unresolvedChats.add(chatId);
    }

    ops.syncPersistedWaitCycleRetryState(entry, unresolvedChats);
    if (unresolvedChats.size === 0) ops.removePersistedActiveWaitCycle(entry.boardKey);
  }
}

export async function startDaemon(): Promise<void> {
  await logger.info("Daemon starting", { pid: process.pid });

  const lockAcquired = await acquireDaemonLock();
  if (!lockAcquired) {
    await logger.info("Daemon already active; skipping duplicate start", { pid: process.pid });
    process.exit(0);
  }

  let config = await loadConfig();
  async function refreshConfig() {
    invalidateCache();
    config = await loadConfig();
  }

  installSignalHandlers();
  await writePidFile();
  const daemonAuthToken = await rotateDaemonAuthToken();

  const sessionManager = new SessionManager(config.settings);

  // Create channel instances from config
  const configuredChannels = Object.entries(config.channels);
  const channels: Array<{ name: string; type: string; channel: Channel }> = [];
  const channelByName = new Map<string, Channel>();
  const defaultChannelByType = new Map<string, Channel>();
  for (const [name, cfg] of configuredChannels) {
    const channel = createChannel(name, cfg);
    channels.push({ name, type: cfg.type, channel });
    channelByName.set(name, channel);
    if (!defaultChannelByType.has(cfg.type)) {
      defaultChannelByType.set(cfg.type, channel);
    }
  }

  // Always create an internal channel for office/desktop app communication
  const internalChannel = new InternalChannel("internal");
  channels.push({ name: "internal", type: "internal", channel: internalChannel });
  channelByName.set("internal", internalChannel);
  defaultChannelByType.set("internal", internalChannel);

  if (channels.length <= 1) {
    // Only internal channel exists — no external channels configured
    await logger.error("No channels configured. Run `touchgrass setup` first.");
    console.error("No channels configured. Run `touchgrass setup` first.");
    process.exit(1);
  }

  const getChannelForType = (type: string): Channel | null => defaultChannelByType.get(type) || null;
  const getChannelForChat = (chatId: ChannelChatId): Channel | null => {
    const channelName = getChannelName(chatId);
    if (channelName) {
      const scoped = channelByName.get(channelName);
      if (scoped) return scoped;
    }
    return getChannelForType(getChannelType(chatId));
  };
  const getFormatterForChat = (chatId: ChannelChatId): Formatter => {
    return getChannelForChat(chatId)?.fmt || channels[0].channel.fmt;
  };
  const getOutputPreferencesForChat = (chatId: ChannelChatId) => getChatOutputPreferences(config, chatId);
  const getDeliveryPreferenceForChat = (chatId: ChannelChatId) => getChatDeliveryPreference(config, chatId);
  const isChatMutedForChat = (chatId: ChannelChatId): boolean => {
    return isChatDeliveryMuted(config, chatId);
  };

  const deliveryRuntime = new Map<string, ChatDeliveryRuntimeState>();
  const pendingApprovalBySession = new Map<string, { chatId: ChannelChatId; question: string; options: string[] }>();

  const deliveryRuntimeKey = (sessionId: string, chatId: ChannelChatId): string => `${sessionId}|${chatId}`;
  const getDeliveryRuntimeState = (sessionId: string, chatId: ChannelChatId): ChatDeliveryRuntimeState => {
    const key = deliveryRuntimeKey(sessionId, chatId);
    const existing = deliveryRuntime.get(key);
    if (existing) return existing;
    const created: ChatDeliveryRuntimeState = {
      entries: [],
      lastBufferedAt: null,
      lastFlushAt: null,
    };
    deliveryRuntime.set(key, created);
    return created;
  };
  const pruneDeliveryRuntimeState = (state: ChatDeliveryRuntimeState, now = Date.now()): void => {
    state.entries = state.entries.filter((entry) => now - entry.at <= DELIVERY_BUFFER_MAX_AGE_MS).slice(-DELIVERY_BUFFER_ENTRY_LIMIT);
    if (state.entries.length === 0) {
      state.lastBufferedAt = null;
    }
  };
  const clearDeliveryRuntimeState = (sessionId: string, chatId: ChannelChatId): void => {
    deliveryRuntime.delete(deliveryRuntimeKey(sessionId, chatId));
  };
  const clearDeliveryRuntimeForChat = (chatId: ChannelChatId): void => {
    for (const key of deliveryRuntime.keys()) {
      if (key.endsWith(`|${chatId}`)) deliveryRuntime.delete(key);
    }
  };
  const bufferDeliveryEntry = (sessionId: string, chatId: ChannelChatId, entry: BufferedDeliveryEntry | null): void => {
    if (!entry) return;
    const state = getDeliveryRuntimeState(sessionId, chatId);
    state.entries.push(entry);
    state.lastBufferedAt = entry.at;
    pruneDeliveryRuntimeState(state, entry.at);
  };
  const sendToChat = (chatId: ChannelChatId, content: string): void => {
    const channel = getChannelForChat(chatId);
    if (!channel) return;
    channel.send(chatId, content).catch(() => {});
  };
  const syncCommandMenuForChat = (chatId: ChannelChatId, userId: ChannelUserId): void => {
    const channel = getChannelForChat(chatId);
    if (!channel?.syncCommandMenu) return;
    void (async () => {
      // Detect group chats: Telegram uses negative numeric IDs, Slack uses C/G prefixed strings.
      // Fall back to checking linkedGroups if we can't determine from the ID format.
      const channelType = getChannelType(chatId);
      let isGroup: boolean;
      if (channelType === "telegram") {
        const rootChatId = getRootChatIdNumber(chatId);
        isGroup = typeof rootChatId === "number" && Number.isFinite(rootChatId) && rootChatId < 0;
      } else {
        // For Slack and other non-numeric ID channels, check if it's a linked group
        isGroup = isLinkedGroup(config, chatId);
      }
      await channel.syncCommandMenu?.({
        userId,
        chatId,
        isPaired: isUserPaired(config, userId),
        isGroup,
        isLinkedGroup: isGroup ? isLinkedGroup(config, chatId) : false,
        hasActiveSession: !!sessionManager.getAttachedRemote(chatId),
        isMuted: isChatDeliveryMuted(config, chatId),
      });
    })().catch(async (error: unknown) => {
      await logger.debug("Failed to sync command menu from daemon lifecycle", {
        chatId,
        userId,
        error: (error as Error)?.message ?? String(error),
      });
    });
  };
  const setTypingForChat = (chatId: ChannelChatId, active: boolean): void => {
    const channel = getChannelForChat(chatId);
    if (!channel) return;
    if (!active) {
      channel.setTyping(chatId, false);
      return;
    }
    if (!getOutputPreferencesForChat(chatId).typingIndicator) return;
    channel.setTyping(chatId, true);
  };
  const syncKnownCommandMenus = (): void => {
    const pairedUsers = getAllPairedUsers(config);
    const linkedGroups = getAllLinkedGroups(config);
    for (const user of pairedUsers) {
      const parsedUser = parseChannelAddress(user.userId);
      const userType = parsedUser.type;
      const userChannelName = parsedUser.channelName;
      syncCommandMenuForChat(user.userId, user.userId);
      for (const group of linkedGroups) {
        const parsedGroup = parseChannelAddress(group.chatId);
        if (parsedGroup.type !== userType) continue;
        const sameScope = parsedGroup.channelName === userChannelName;
        if ((parsedGroup.channelName || userChannelName) && !sameScope) continue;
        syncCommandMenuForChat(group.chatId, user.userId);
      }
    }
  };
  const sendPollToChat = async (
    chatId: ChannelChatId,
    question: string,
    options: string[],
    multiSelect: boolean,
    sendOptions?: { timeoutMs?: number }
  ): Promise<{ pollId: string; messageId: string } | null> => {
    const channel = getChannelForChat(chatId);
    if (!channel?.sendPoll) return null;
    return channel.sendPoll(chatId, question, options, multiSelect, sendOptions);
  };
  const logTelegramDelivery = async (payload: {
    category: string;
    operation: string;
    chatId?: ChannelChatId;
    sessionId?: string;
    boardKey?: string;
    waitItemCount?: number;
    timeoutMs?: number;
    html?: string;
    htmlLength?: number;
    fingerprint?: string;
    messageId?: string;
    failureCode?: StatusBoardFailureCode;
    note?: string;
    compact?: boolean;
  }): Promise<void> => {
    const { html, ...rest } = payload;
    await debugLogIfEnabled("Telegram delivery", {
      ...rest,
      htmlLength: payload.htmlLength ?? html?.length ?? 0,
      fingerprint: payload.fingerprint ?? (html ? createDeliveryFingerprint(html) : undefined),
    });
  };

  const enqueueOrderedConversationDelivery = createOrderedConversationQueue({
    getTimeoutMs: () => Math.max(250, config.settings.orderedConversationTimeoutMs),
    logSkip: async (chatId, error) => {
      await debugLogIfEnabled("Skipping stalled ordered conversation event", {
        chatId,
        error: error.message,
      });
      await logTelegramDelivery({
        category: "ordered_transcript",
        operation: error.message.toLowerCase().includes("timed out") ? "timeout" : "skip",
        chatId,
        note: error.message,
      });
    },
    onSkip: async (chatId, timeoutMs) => {
      const output = getOutputPreferencesForChat(chatId);
      const channel = getChannelForChat(chatId);
      if (!output.orderingNotices || !channel) return;
      const fmt = getFormatterForChat(chatId);
      const notice = `${fmt.escape("⛳️")} ${fmt.escape("Skipped one bridge event to preserve message order.")}`;
      await logTelegramDelivery({ category: "ordered_transcript", operation: "send", chatId, timeoutMs, html: notice, note: "ordering notice" });
      await channel
        .send(chatId, notice, { timeoutMs })
        .catch(() => {});
    },
  });

  const sendOrderedConversationHtml = async (
    sessionId: string,
    chatId: ChannelChatId,
    channel: Channel,
    html: string,
    timeoutMs: number,
    note?: string
  ): Promise<void> => {
    await logTelegramDelivery({ category: "ordered_transcript", operation: "send", sessionId, chatId, timeoutMs, html, note });
    await channel.send(chatId, html, { timeoutMs });
  };

  const sendOrderedConversationDocument = async (
    sessionId: string,
    chatId: ChannelChatId,
    channel: Channel,
    filePath: string,
    caption: string | undefined,
    timeoutMs: number
  ): Promise<void> => {
    await logTelegramDelivery({
      category: "ordered_transcript",
      operation: "send",
      sessionId,
      chatId,
      timeoutMs,
      htmlLength: caption?.length ?? 0,
      fingerprint: caption ? createDeliveryFingerprint(caption) : undefined,
      note: filePath,
    });
    await channel.sendDocument?.(chatId, filePath, caption, { timeoutMs });
  };
  const getConversationTargets = (sessionId: string, includeGroups = true): Set<ChannelChatId> => {
    const targets = new Set<ChannelChatId>();
    const targetChat = sessionManager.getBoundChat(sessionId);
    if (targetChat) targets.add(targetChat);
    if (includeGroups) {
      for (const groupChatId of sessionManager.getSubscribedGroups(sessionId)) {
        targets.add(groupChatId);
      }
    }
    return targets;
  };

  const updateDeliveryPreferenceForChat = async (
    chatId: ChannelChatId,
    updater: (current: ChatDeliveryPreference) => ChatDeliveryPreference
  ): Promise<ChatDeliveryPreference> => {
    const current = getDeliveryPreferenceForChat(chatId);
    const next = updater(current);
    const changed = setChatDeliveryPreference(config, chatId, next);
    if (changed) await saveConfig(config);
    return getDeliveryPreferenceForChat(chatId);
  };

  const buildApprovalQuestionText = (event: Extract<ConversationEvent, { kind: "approvalNeeded" }>): string => {
    if (event.promptText) {
      return event.promptText.slice(0, 300);
    }
    const detail = (event.input.command as string) || (event.input.file_path as string)
      || (event.input.pattern as string) || (event.input.query as string)
      || (event.input.url as string) || (event.input.description as string) || "";
    const label = detail.length > 200 ? `${detail.slice(0, 200)}...` : detail;
    return (label ? `${event.name}: ${label}` : event.name).slice(0, 300);
  };

  const buildBufferedDeliveryEntry = (
    fmt: Formatter,
    output: ChatOutputPreferences,
    cwd: string,
    event: ConversationEvent
  ): BufferedDeliveryEntry | null => {
    const now = Date.now();
    if (event.kind === "assistant") {
      const text = event.text.trim();
      if (!text) return null;
      return {
        at: now,
        role: "assistant",
        summaryText: text,
        fullMessage: fmt.fromMarkdown(event.text),
        countsForSummary: true,
        countsForReplay: true,
      };
    }

    if (event.kind === "thinking") {
      const message = formatThinkingNotification(fmt, output.thinkingMode, event.text);
      if (!message) return null;
      return {
        at: now,
        role: "assistant",
        summaryText: event.text.trim() || null,
        fullMessage: message,
        countsForSummary: true,
        countsForReplay: false,
      };
    }

    if (event.kind === "toolCall") {
      if (output.toolCallMode === "off") return null;
      const detailMode = output.toolCallMode === "detailed" ? "verbose" : "simple";
      const fullMessage = formatToolCall(fmt, event.name, event.input, detailMode, cwd);
      if (!fullMessage) return null;
      return {
        at: now,
        role: "tool",
        summaryText: event.name,
        fullMessage,
        countsForSummary: true,
        countsForReplay: true,
      };
    }

    if (event.kind === "toolResult") {
      const fullMessage = formatToolResultNotification(fmt, output, event.toolName, event.content, event.isError === true);
      if (!fullMessage) return null;
      return {
        at: now,
        role: "tool",
        summaryText: `${event.toolName}${event.isError ? " error" : " result"}: ${truncateDeliverySummary(event.content, 140)}` ,
        fullMessage,
        countsForSummary: true,
        countsForReplay: true,
      };
    }

    if (event.kind === "question") {
      const first = event.questions[0] as Record<string, unknown> | undefined;
      const questionText = typeof first?.question === "string" ? first.question : "Question";
      return {
        at: now,
        role: "assistant",
        summaryText: questionText,
        fullMessage: `${fmt.escape("❓")} ${fmt.bold("[Question]")} ${fmt.escape(questionText)}` ,
        countsForSummary: true,
        countsForReplay: true,
      };
    }

    if (event.kind === "approvalNeeded") {
      const questionText = buildApprovalQuestionText(event);
      return {
        at: now,
        role: "assistant",
        summaryText: `Approval needed: ${questionText}`,
        fullMessage: `${fmt.escape("⏸")} ${fmt.bold("[Approval]")} ${fmt.escape(questionText)}` ,
        countsForSummary: true,
        countsForReplay: true,
      };
    }

    if (event.kind === "assistantFile") {
      return {
        at: now,
        role: "assistant",
        summaryText: event.caption || `Generated file: ${basename(event.filePath)}` ,
        fullMessage: null,
        countsForSummary: true,
        countsForReplay: false,
      };
    }

    return null;
  };

  const flushBufferedDelivery = async (
    sessionId: string,
    chatId: ChannelChatId,
    options?: { timeoutMs?: number; noticeMessage?: string; includeReplay?: boolean }
  ): Promise<boolean> => {
    const channel = getChannelForChat(chatId);
    if (!channel) return false;
    const fmt = getFormatterForChat(chatId);
    const state = getDeliveryRuntimeState(sessionId, chatId);
    pruneDeliveryRuntimeState(state);
    // Automatic flushes may only send buffered runtime entries. History replay stays
    // behind the explicit "Load recent messages?" user action to avoid duplicates.
    const messages = selectAutomaticBufferedDeliveryMessages(fmt, state.entries, options);
    if (messages.length === 0) return true;
    try {
      for (const message of messages) {
        await channel.send(chatId, message, options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined);
      }
      state.entries = [];
      state.lastBufferedAt = null;
      state.lastFlushAt = Date.now();
      pruneDeliveryRuntimeState(state);
      return true;
    } catch (error) {
      await logger.warn("Buffered delivery flush failed", {
        sessionId,
        chatId,
        error: (error as Error)?.message ?? String(error),
      });
      return false;
    }
  };

  const recordMuteUserTurn = async (chatId: ChannelChatId): Promise<void> => {
    await updateDeliveryPreferenceForChat(chatId, (delivery) => {
      if (delivery.mode !== "mute" || delivery.pendingUserTurnSince) return delivery;
      return { ...delivery, pendingUserTurnSince: new Date().toISOString() };
    });
  };

  const clearMuteUserTurn = async (chatId: ChannelChatId): Promise<void> => {
    await updateDeliveryPreferenceForChat(chatId, (delivery) => {
      if (delivery.mode !== "mute" || delivery.pendingUserTurnSince === null) return delivery;
      return { ...delivery, pendingUserTurnSince: null };
    });
  };

  const resolveSessionArtifactPath = async (sessionId: string, filePath: string): Promise<{ filePath: string; defaultCaption: string }> => {
    const remote = sessionManager.getRemote(sessionId);
    if (!remote) throw new Error("Session not found");

    let resolvedPath = filePath;
    if (remote.cwd && !resolvedPath.startsWith("/")) {
      resolvedPath = resolve(remote.cwd, resolvedPath);
    }

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    if (!fileStats.isFile()) throw new Error(`Not a file: ${resolvedPath}`);
    if (fileStats.size <= 0) throw new Error("File is empty");
    if (fileStats.size > 50 * 1024 * 1024) throw new Error("File exceeds 50MB channel upload limit");

    try {
      const realFile = await realpath(resolvedPath);
      const allowedRoots: string[] = [paths.uploadsDir];
      if (remote.cwd) allowedRoots.push(await realpath(remote.cwd).catch(() => remote.cwd));
      const manifestJsonl = readSessionManifestSync(sessionId)?.jsonlFile;
      if (manifestJsonl) {
        const sessionArtifactRoot = await realpath(resolve(dirname(manifestJsonl), "local")).catch(() => resolve(dirname(manifestJsonl), "local"));
        allowedRoots.push(sessionArtifactRoot);
      }
      const inAllowed = allowedRoots.some((root) => realFile.startsWith(root + "/") || realFile === root);
      if (!inAllowed) {
        throw new Error(`File path outside session working directory: ${resolvedPath}`);
      }
      resolvedPath = realFile;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Cannot resolve file path: ${resolvedPath}`);
    }

    return { filePath: resolvedPath, defaultCaption: basename(resolvedPath) };
  };
  const closePollForChat = (chatId: ChannelChatId, messageId: string, confirmText?: string): void => {
    const channel = getChannelForChat(chatId);
    if (confirmText && channel?.editMessage) {
      channel.editMessage(chatId, messageId, confirmText).catch(() => {});
    } else if (channel?.closePoll) {
      channel.closePoll(chatId, messageId).catch(() => {});
    }
  };
  const reconnectNoticeBySession = new Map<string, number>();
  const RECONNECT_NOTICE_COOLDOWN_MS = 30_000;
  const backgroundJobsBySession = new Map<string, Map<string, BackgroundJobState>>();
  const activeWaitCyclesBySession = new Map<string, WaitCycleState>();
  const waitCycleCounters = new Map<string, number>();
  const waitCycleBoardWorkBySession = new Map<string, Promise<void>>();
  const persistedStatusBoards = new Map<string, PersistedStatusBoardEntry>();
  const persistedActiveWaitCycles = new Map<string, PersistedActiveWaitCycleEntry>();
  const backgroundJobAnnouncements = new Map<string, BackgroundJobStatus>();
  const backgroundBoardKey = (sessionId: string) => `background-jobs:${sessionId}`;
  const waitCycleBoardKey = (sessionId: string, cycleId: number) => `wait-cycle:${sessionId}:${cycleId}`;
  const statusBoardMapKey = (chatId: string, boardKey: string) => `${chatId}::${boardKey}`;
  const backgroundAnnouncementKey = (sessionId: string, taskId: string) => `${sessionId}::${taskId}`;
  const parseWaitCycleBoardKey = (boardKey: string): { sessionId: string; cycleId: number } | null => {
    const waitMatch = boardKey.match(/^wait-cycle:([^:]+):(\d+)$/);
    if (!waitMatch) return null;
    const cycleId = Number.parseInt(waitMatch[2] || "", 10);
    if (!Number.isSafeInteger(cycleId) || cycleId < 1) return null;
    return { sessionId: waitMatch[1] || "", cycleId };
  };
  const rememberWaitCycleId = (sessionId: string, cycleId: number): void => {
    const current = waitCycleCounters.get(sessionId) || 0;
    if (cycleId > current) waitCycleCounters.set(sessionId, cycleId);
  };
  const sessionIdFromBoardKey = (boardKey: string): string | null => {
    if (boardKey.startsWith("background-jobs:")) return boardKey.slice("background-jobs:".length) || null;
    return parseWaitCycleBoardKey(boardKey)?.sessionId || null;
  };
  const BACKGROUND_RECONCILE_INTERVAL_MS = 30_000;
  const BACKGROUND_BOARD_STALE_MS = 5 * 60_000;
  const WAIT_HEARTBEAT_SWEEP_INTERVAL_MS = 5_000;
  const WAIT_HEARTBEAT_PULSE_MS = 5_000;
  const WAIT_HEARTBEAT_INTERVAL_MS = 60_000;
  const WAIT_BOARD_RECONCILE_INTERVAL_MS = 15_000;
  const WAIT_BOARD_DETAIL_MAX = 280;
  const WAIT_TERMINAL_STATUSES = new Set<WaitTrackedItemStatus>(["completed", "failed", "blocked"]);
  const STATUS_BOARD_STORE_PATH = paths.statusBoardsFile;
  let persistStatusBoardsTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcilingBackgroundState = false;

  const normalizeBackgroundStatus = (status: string): BackgroundJobStatus | null => {
    const value = status.toLowerCase();
    if (value === "running" || value === "started" || value === "start") return "running";
    if (value === "completed" || value === "done" || value === "success") return "completed";
    if (value === "failed" || value === "error") return "failed";
    if (
      value === "killed" ||
      value === "stopped" ||
      value === "terminated" ||
      value === "cancelled" ||
      value === "canceled"
    ) {
      return "killed";
    }
    return null;
  };

  const extractTaskNotificationTag = (content: string, tag: string): string | undefined => {
    const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match?.[1]?.trim() || undefined;
  };

  const extractUrls = (text: string): string[] => {
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s<>)\]}]+/gi) || [];
    const deduped = new Set<string>();
    for (const raw of matches) {
      const url = raw.replace(/^[('"`]+|[),.;!?'"`]+$/g, "");
      if (!url) continue;
      deduped.add(url);
      if (deduped.size >= 5) break;
    }
    return Array.from(deduped);
  };

  const inferUrlsFromCommand = (command?: string): string[] => {
    if (!command) return [];
    const urls = new Set<string>();
    const directMatches = extractUrls(command);
    for (const url of directMatches) urls.add(url);

    const portPatterns: RegExp[] = [
      /(?:localhost|127\.0\.0\.1):(\d{2,5})/gi,
      /\.listen\((\d{2,5})\)/gi,
      /--port(?:=|\s+)(\d{2,5})/gi,
      /-p(?:=|\s+)(\d{2,5})/gi,
    ];
    for (const pattern of portPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(command)) !== null) {
        const port = Number(match[1]);
        if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
        urls.add(`http://localhost:${port}`);
      }
    }
    return Array.from(urls).slice(0, 5);
  };

  const extractStoppedTaskFromText = (text: string): { taskId: string; command?: string } | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const taskId = typeof parsed.task_id === "string"
        ? parsed.task_id
        : typeof parsed.taskId === "string"
        ? parsed.taskId
        : "";
      const command = typeof parsed.command === "string" ? parsed.command : undefined;
      const message = typeof parsed.message === "string" ? parsed.message : "";
      const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
      const stoppedByStatus = status === "killed" || status === "stopped" || status === "terminated" || status === "cancelled" || status === "canceled";
      const stoppedByMessage = /stopped task|killed task|terminated task|cancelled task|canceled task/i.test(message);
      if (taskId && (stoppedByStatus || stoppedByMessage)) {
        return { taskId, command };
      }
    } catch {
      // Not JSON payload.
    }

    const stoppedId = trimmed.match(/Successfully stopped task:\s*([A-Za-z0-9_-]+)/i)?.[1];
    if (!stoppedId) return null;
    const command = trimmed.match(/Successfully stopped task:\s*[A-Za-z0-9_-]+\s*\(([\s\S]+)\)/i)?.[1];
    return { taskId: stoppedId, command };
  };

  const mergeUrls = (base?: string[], incoming?: string[]): string[] | undefined => {
    const merged = new Set<string>();
    for (const url of base || []) merged.add(url);
    for (const url of incoming || []) merged.add(url);
    if (merged.size === 0) return undefined;
    return Array.from(merged).slice(0, 5);
  };

  type ResumableTool = "claude" | "codex" | "pi" | "omp" | "kimi" | "gemini";

  const cleanResumeRef = (token: string | undefined): string | null => {
    if (!token) return null;
    const trimmed = token.trim().replace(/^["'`]+|["'`]+$/g, "");
    return trimmed || null;
  };

  const getSessionTool = (command: string): string => {
    return command.trim().split(/\s+/)[0] || "";
  };

  const detectResumableTool = (command: string): ResumableTool | null => {
    const tool = getSessionTool(command).toLowerCase();
    if (tool === "claude" || tool === "codex" || tool === "pi" || tool === "omp" || tool === "kimi" || tool === "gemini") return tool;
    return null;
  };

  const extractResumeRefFromCommand = (tool: ResumableTool, command: string): string | null => {
    if (tool === "pi") {
      return cleanResumeRef(command.match(/(?:^|\s)--session(?:=|\s+)([^\s]+)/i)?.[1]);
    }
    if (tool === "omp") {
      return cleanResumeRef(command.match(/(?:^|\s)(?:--session|--resume|-r)(?:=|\s+)([^\s]+)/i)?.[1]);
    }
    if (tool === "kimi") {
      return cleanResumeRef(command.match(/(?:^|\s)(?:--session|-S)(?:=|\s+)([^\s]+)/i)?.[1]);
    }
    return cleanResumeRef(
      command.match(/\bresume\s+([^\s]+)/i)?.[1] ||
      command.match(/\b--resume(?:=|\s+)([^\s]+)/i)?.[1]
    );
  };

  const supportsBackgroundTracking = (command: string): boolean => {
    const tool = getSessionTool(command);
    return tool === "claude" || tool === "codex";
  };

  const normalizeCodexSessionId = (value: unknown): string | undefined => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return String(Math.trunc(value));
    }
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed;
  };

  const detectCodexExitStatus = (output: string): BackgroundJobStatus | null => {
    const codeMatch = output.match(/Process exited with code\s+(-?\d+)/i);
    if (codeMatch) {
      const code = Number(codeMatch[1]);
      if (Number.isFinite(code) && code === 0) return "completed";
      return "failed";
    }
    if (/(stdin is closed for this session|session not found|no such session)/i.test(output)) {
      return "killed";
    }
    return null;
  };

  const persistStatusBoardsNow = async (): Promise<void> => {
    try {
      const jobs: Record<string, BackgroundJobState[]> = {};
      for (const [sessionId, jobMap] of backgroundJobsBySession) {
        jobs[sessionId] = Array.from(jobMap.values());
      }
      const payload = {
        version: 2,
        boards: Array.from(persistedStatusBoards.values()),
        activeWaitCycles: Array.from(persistedActiveWaitCycles.values()),
        jobs,
      };
      await writeFile(STATUS_BOARD_STORE_PATH, JSON.stringify(payload, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
      });
      await chmod(STATUS_BOARD_STORE_PATH, 0o600).catch(() => {});
    } catch (e) {
      await logger.error("Failed to persist status board registry", { error: (e as Error).message });
    }
  };

  const schedulePersistStatusBoards = (): void => {
    if (persistStatusBoardsTimer) return;
    persistStatusBoardsTimer = setTimeout(async () => {
      persistStatusBoardsTimer = null;
      await persistStatusBoardsNow();
    }, 250);
  };

  const setPersistedStatusBoard = (
    chatId: string,
    boardKey: string,
    messageId: string,
    pinned: boolean
  ): void => {
    persistedStatusBoards.set(statusBoardMapKey(chatId, boardKey), {
      chatId,
      boardKey,
      messageId,
      pinned,
      updatedAt: Date.now(),
    });
    const waitCycle = parseWaitCycleBoardKey(boardKey);
    if (waitCycle) rememberWaitCycleId(waitCycle.sessionId, waitCycle.cycleId);
    schedulePersistStatusBoards();
  };

  const removePersistedStatusBoard = (chatId: string, boardKey: string): void => {
    persistedStatusBoards.delete(statusBoardMapKey(chatId, boardKey));
    schedulePersistStatusBoards();
  };

  const setPersistedActiveWaitCycle = (
    sessionId: string,
    cycleId: number,
    boardKey: string,
    activeChatIds: Iterable<ChannelChatId>
  ): void => {
    const normalizedChatIds = Array.from(new Set(
      Array.from(activeChatIds).filter((chatId): chatId is ChannelChatId => typeof chatId === "string" && chatId.length > 0)
    ));
    if (normalizedChatIds.length === 0) {
      persistedActiveWaitCycles.delete(boardKey);
      schedulePersistStatusBoards();
      return;
    }
    rememberWaitCycleId(sessionId, cycleId);
    persistedActiveWaitCycles.set(boardKey, {
      sessionId,
      cycleId,
      boardKey,
      activeChatIds: normalizedChatIds,
    });
    schedulePersistStatusBoards();
  };

  const syncPersistedActiveWaitCycle = (
    sessionId: string,
    cycle: WaitCycleState,
    activeChatIds: Iterable<ChannelChatId>
  ): void => {
    setPersistedActiveWaitCycle(sessionId, cycle.cycleId, cycle.boardKey, activeChatIds);
  };

  const removePersistedActiveWaitCycle = (boardKey: string): void => {
    persistedActiveWaitCycles.delete(boardKey);
    schedulePersistStatusBoards();
  };

  const syncPersistedWaitCycleRetryState = (entry: PersistedActiveWaitCycleEntry, activeChatIds: Iterable<ChannelChatId>): void => {
    setPersistedActiveWaitCycle(entry.sessionId, entry.cycleId, entry.boardKey, activeChatIds);
  };

  const listPersistedWaitCyclesForCleanup = (): PersistedActiveWaitCycleEntry[] => {
    const combined = new Map<string, { sessionId: string; cycleId: number; activeChatIds: Set<ChannelChatId> }>();

    for (const entry of persistedActiveWaitCycles.values()) {
      combined.set(entry.boardKey, {
        sessionId: entry.sessionId,
        cycleId: entry.cycleId,
        activeChatIds: new Set(entry.activeChatIds),
      });
    }

    for (const entry of persistedStatusBoards.values()) {
      const waitCycle = parseWaitCycleBoardKey(entry.boardKey);
      if (!waitCycle) continue;
      const combinedEntry = combined.get(entry.boardKey);
      if (combinedEntry) {
        combinedEntry.activeChatIds.add(entry.chatId);
        continue;
      }
      combined.set(entry.boardKey, {
        sessionId: waitCycle.sessionId,
        cycleId: waitCycle.cycleId,
        activeChatIds: new Set([entry.chatId]),
      });
    }

    return Array.from(combined.entries(), ([boardKey, entry]) => ({
      sessionId: entry.sessionId,
      cycleId: entry.cycleId,
      boardKey,
      activeChatIds: Array.from(entry.activeChatIds),
    }));
  };


  const getStatusBoardResult = (
    value: void | StatusBoardResult
  ): StatusBoardResult | undefined => {
    return value && typeof value === "object" ? value : undefined;
  };

  const loadPersistedStatusBoards = async (): Promise<void> => {
    try {
      const raw = await readFile(STATUS_BOARD_STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as {
        boards?: PersistedStatusBoardEntry[];
        activeWaitCycles?: PersistedActiveWaitCycleEntry[];
        jobs?: Record<string, BackgroundJobState[]>;
      } | null;
      const boards = Array.isArray(parsed?.boards) ? parsed.boards : [];
      for (const entry of boards) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.chatId !== "string" || !entry.chatId) continue;
        if (typeof entry.boardKey !== "string" || !entry.boardKey) continue;
        if (typeof entry.messageId !== "string" || !entry.messageId) continue;
        const waitCycle = parseWaitCycleBoardKey(entry.boardKey);
        if (waitCycle) rememberWaitCycleId(waitCycle.sessionId, waitCycle.cycleId);
        persistedStatusBoards.set(statusBoardMapKey(entry.chatId, entry.boardKey), {
          chatId: entry.chatId,
          boardKey: entry.boardKey,
          messageId: entry.messageId,
          pinned: entry.pinned === true,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
        });
      }
      const activeWaitCycles = Array.isArray(parsed?.activeWaitCycles) ? parsed.activeWaitCycles : [];
      for (const entry of activeWaitCycles) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.sessionId !== "string" || !entry.sessionId) continue;
        if (typeof entry.cycleId !== "number" || !Number.isSafeInteger(entry.cycleId) || entry.cycleId < 1) continue;
        if (typeof entry.boardKey !== "string" || !entry.boardKey) continue;
        const waitCycle = parseWaitCycleBoardKey(entry.boardKey);
        if (!waitCycle || waitCycle.sessionId !== entry.sessionId || waitCycle.cycleId !== entry.cycleId) continue;
        if (!Array.isArray(entry.activeChatIds)) continue;
        rememberWaitCycleId(entry.sessionId, entry.cycleId);
        persistedActiveWaitCycles.set(entry.boardKey, {
          sessionId: entry.sessionId,
          cycleId: entry.cycleId,
          boardKey: entry.boardKey,
          activeChatIds: entry.activeChatIds.filter(
            (chatId): chatId is ChannelChatId => typeof chatId === "string" && chatId.length > 0
          ),
        });
      }
      const jobs = parsed?.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
      for (const [sessionId, list] of Object.entries(jobs)) {
        if (!sessionId || !Array.isArray(list)) continue;
        const jobMap = new Map<string, BackgroundJobState>();
        for (const rawJob of list) {
          if (!rawJob || typeof rawJob !== "object") continue;
          const taskId = typeof rawJob.taskId === "string" ? rawJob.taskId : "";
          const status = normalizeBackgroundStatus(String(rawJob.status || ""));
          if (!taskId || status !== "running") continue;
          const command = typeof rawJob.command === "string" ? rawJob.command : undefined;
          const urls = Array.isArray(rawJob.urls)
            ? rawJob.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
            : undefined;
          const mergedUrls = mergeUrls(urls && urls.length > 0 ? urls.slice(0, 5) : undefined, inferUrlsFromCommand(command));
          jobMap.set(taskId, {
            taskId,
            status,
            command,
            outputFile: typeof rawJob.outputFile === "string" ? rawJob.outputFile : undefined,
            summary: typeof rawJob.summary === "string" ? rawJob.summary : undefined,
            urls: mergedUrls,
            updatedAt: typeof rawJob.updatedAt === "number" ? rawJob.updatedAt : Date.now(),
          });
        }
        if (jobMap.size > 0) {
          backgroundJobsBySession.set(sessionId, jobMap);
        }
      }
    } catch {
      // No persisted registry yet (or malformed file) — continue with an empty set.
    }
  };

  const readTail = async (filePath: string, maxBytes: number): Promise<string> => {
    const stats = await stat(filePath);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const fd = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buffer, 0, length, start);
      return buffer.toString("utf-8", 0, bytesRead);
    } finally {
      await fd.close();
    }
  };

  const readSessionManifestSync = (sessionId: string): SessionManifest | null => {
    const manifestPath = join(paths.sessionsDir, `${sessionId}.json`);
    try {
      const raw = require("fs").readFileSync(manifestPath, "utf-8") as string;
      const parsed = JSON.parse(raw) as SessionManifest;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  };


  const readSessionManifest = async (sessionId: string): Promise<SessionManifest | null> => {
    const manifestPath = join(paths.sessionsDir, `${sessionId}.json`);
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as SessionManifest;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const readStoppedClaudeTasks = async (
    jsonlFile: string,
    taskIds: Set<string>
  ): Promise<Set<string>> => {
    const stopped = new Set<string>();
    if (!jsonlFile || taskIds.size === 0) return stopped;
    try {
      const tail = await readTail(jsonlFile, 300_000);
      const lines = tail.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "queue-operation" && msg.operation === "enqueue") {
            const content = typeof msg.content === "string" ? msg.content : "";
            if (!content.includes("<task-notification>")) continue;
            const taskId = extractTaskNotificationTag(content, "task-id");
            const status = (extractTaskNotificationTag(content, "status") || "").toLowerCase();
            if (!taskId || !taskIds.has(taskId)) continue;
            if (status === "completed" || status === "failed" || status === "killed" || status === "stopped") {
              stopped.add(taskId);
            }
            continue;
          }

          if (msg.type !== "user") continue;
          const rootToolUseResult = msg.toolUseResult as Record<string, unknown> | undefined;
          const rootStoppedTaskId = typeof rootToolUseResult?.task_id === "string" ? rootToolUseResult.task_id : "";
          const rootStopMessage = typeof rootToolUseResult?.message === "string" ? rootToolUseResult.message : "";
          if (
            rootStoppedTaskId &&
            taskIds.has(rootStoppedTaskId) &&
            /stopped task|killed task|terminated task|cancelled task|canceled task/i.test(rootStopMessage)
          ) {
            stopped.add(rootStoppedTaskId);
            continue;
          }

          const message = msg.message as Record<string, unknown> | undefined;
          if (!message?.content || !Array.isArray(message.content)) continue;
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type !== "tool_result") continue;
            let text = "";
            const content = block.content;
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              text = (content as Array<{ type: string; text?: string }>)
                .filter((segment) => segment.type === "text")
                .map((segment) => segment.text ?? "")
                .join("\n");
            }
            const stoppedTask = extractStoppedTaskFromText(text);
            if (!stoppedTask?.taskId || !taskIds.has(stoppedTask.taskId)) continue;
            stopped.add(stoppedTask.taskId);
          }
        } catch {
          // Skip malformed JSON lines.
        }
      }
    } catch {
      // JSONL may not exist yet.
    }
    return stopped;
  };

  const readRunningClaudeTasks = async (
    jsonlFile: string
  ): Promise<Map<string, BackgroundJobState>> => {
    const running = new Map<string, BackgroundJobState>();
    const toolUseIdToInput = new Map<string, Record<string, unknown>>();
    if (!jsonlFile) return running;
    try {
      const tail = await readTail(jsonlFile, 500_000);
      const lines = tail.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof msg.timestamp === "string"
            ? Date.parse(msg.timestamp)
            : Date.now();
          const updatedAt = Number.isFinite(ts) ? ts : Date.now();

          if (msg.type === "assistant") {
            const m = msg.message as Record<string, unknown> | undefined;
            if (m?.content && Array.isArray(m.content)) {
              for (const block of m.content as Array<Record<string, unknown>>) {
                if (block.type !== "tool_use") continue;
                const toolUseId = typeof block.id === "string" ? block.id : "";
                const input = (block.input as Record<string, unknown> | undefined) || undefined;
                if (!toolUseId || !input) continue;
                toolUseIdToInput.set(toolUseId, input);
                if (toolUseIdToInput.size > 2000) {
                  const firstKey = toolUseIdToInput.keys().next().value as string | undefined;
                  if (firstKey) toolUseIdToInput.delete(firstKey);
                }
              }
            }
            continue;
          }

          if (msg.type === "user") {
            const rootToolUseResult = msg.toolUseResult as Record<string, unknown> | undefined;
            const rootBackgroundTaskId = typeof rootToolUseResult?.backgroundTaskId === "string"
              ? rootToolUseResult.backgroundTaskId
              : undefined;
            const m = msg.message as Record<string, unknown> | undefined;
            if (!m?.content || !Array.isArray(m.content)) continue;
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (block.type !== "tool_result") continue;
              let text = "";
              const c = block.content;
              if (typeof c === "string") text = c;
              else if (Array.isArray(c)) {
                text = (c as Array<{ type: string; text?: string }>)
                  .filter((seg) => seg.type === "text")
                  .map((seg) => seg.text ?? "")
                  .join("\n");
              }
              const trimmedText = text.trim();
              if (!trimmedText) continue;
              const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
              const commandInput = toolUseId ? toolUseIdToInput.get(toolUseId) : undefined;
              const command = typeof commandInput?.command === "string" ? commandInput.command : undefined;
              const stoppedTask = extractStoppedTaskFromText(trimmedText);
              if (stoppedTask?.taskId) {
                running.delete(stoppedTask.taskId);
                continue;
              }
              const startedIdFromText = trimmedText.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)/i)?.[1];
              const taskId = startedIdFromText || rootBackgroundTaskId;
              if (!taskId) continue;
              const outputFile = trimmedText.match(/Output is being written to:\s*([^\s]+)/i)?.[1];
              const urls = mergeUrls(extractUrls(trimmedText), inferUrlsFromCommand(command));
              const existing = running.get(taskId);
              running.set(taskId, {
                taskId,
                status: "running",
                command: command || existing?.command,
                outputFile: outputFile || existing?.outputFile,
                summary: existing?.summary,
                urls: mergeUrls(existing?.urls, urls),
                updatedAt: Math.max(updatedAt, existing?.updatedAt ?? 0),
              });
            }
            continue;
          }

          if (msg.type !== "queue-operation" || msg.operation !== "enqueue") continue;
          const content = typeof msg.content === "string" ? msg.content : "";
          if (!content.includes("<task-notification>")) continue;
          const taskId = extractTaskNotificationTag(content, "task-id");
          const statusRaw = (extractTaskNotificationTag(content, "status") || "").toLowerCase();
          if (!taskId || !statusRaw) continue;
          if (statusRaw === "completed" || statusRaw === "failed" || statusRaw === "killed" || statusRaw === "stopped") {
            running.delete(taskId);
            continue;
          }
          if (statusRaw === "running" || statusRaw === "started" || statusRaw === "start") {
            const summary = extractTaskNotificationTag(content, "summary");
            const outputFile = extractTaskNotificationTag(content, "output-file");
            const commandMatch = summary?.match(/Background command \"([\s\S]+?)\" was/i);
            const command = commandMatch?.[1];
            const urls = mergeUrls(extractUrls(content), inferUrlsFromCommand(command));
            const existing = running.get(taskId);
            running.set(taskId, {
              taskId,
              status: "running",
              command: command || existing?.command,
              outputFile: outputFile || existing?.outputFile,
              summary: summary || existing?.summary,
              urls: mergeUrls(existing?.urls, urls),
              updatedAt: Math.max(updatedAt, existing?.updatedAt ?? 0),
            });
          }
        } catch {
          // Ignore malformed lines in tail snapshots.
        }
      }
    } catch {
      // JSONL may not exist yet.
    }
    return running;
  };

  const readStoppedCodexTasks = async (
    jsonlFile: string,
    taskIds: Set<string>
  ): Promise<Set<string>> => {
    const stopped = new Set<string>();
    if (!jsonlFile || taskIds.size === 0) return stopped;

    const callIdToName = new Map<string, string>();
    const callIdToInput = new Map<string, Record<string, unknown>>();
    const rememberCall = (callId: string, name: string, input: Record<string, unknown>) => {
      callIdToName.set(callId, name);
      callIdToInput.set(callId, input);
      if (callIdToName.size > 2000) {
        const first = callIdToName.keys().next().value as string | undefined;
        if (first) {
          callIdToName.delete(first);
          callIdToInput.delete(first);
        }
      }
    };

    try {
      const tail = await readTail(jsonlFile, 500_000);
      const lines = tail.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type !== "response_item") continue;
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) continue;

          if (payload.type === "function_call" && typeof payload.name === "string") {
            const callId = typeof payload.call_id === "string" ? payload.call_id : "";
            if (!callId) continue;
            let input: Record<string, unknown> = {};
            if (typeof payload.arguments === "string") {
              try {
                input = JSON.parse(payload.arguments) as Record<string, unknown>;
              } catch {
                input = {};
              }
            }
            rememberCall(callId, payload.name, input);
            continue;
          }

          if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") continue;
          const callId = typeof payload.call_id === "string" ? payload.call_id : "";
          if (!callId) continue;
          const input = callIdToInput.get(callId);
          const output = typeof payload.output === "string" ? payload.output : "";
          const trimmedOutput = output.trim();
          if (!trimmedOutput) continue;

          const sessionIdFromOutput = trimmedOutput.match(/Process running with session ID\s*([0-9]+)/i)?.[1];
          const sessionIdFromInput = normalizeCodexSessionId(input?.session_id);
          const sessionId = sessionIdFromOutput || sessionIdFromInput;
          if (!sessionId || !taskIds.has(sessionId)) continue;

          const exitStatus = detectCodexExitStatus(trimmedOutput);
          if (exitStatus) {
            stopped.add(sessionId);
          }
        } catch {
          // Skip malformed JSON lines.
        }
      }
    } catch {
      // JSONL may not exist yet.
    }
    return stopped;
  };

  const readRunningCodexTasks = async (
    jsonlFile: string
  ): Promise<Map<string, BackgroundJobState>> => {
    const running = new Map<string, BackgroundJobState>();
    if (!jsonlFile) return running;

    const callIdToName = new Map<string, string>();
    const callIdToInput = new Map<string, Record<string, unknown>>();
    const sessionIdToCommand = new Map<string, string>();
    const rememberCall = (callId: string, name: string, input: Record<string, unknown>) => {
      callIdToName.set(callId, name);
      callIdToInput.set(callId, input);
      if (callIdToName.size > 2000) {
        const first = callIdToName.keys().next().value as string | undefined;
        if (first) {
          callIdToName.delete(first);
          callIdToInput.delete(first);
        }
      }
    };

    try {
      const tail = await readTail(jsonlFile, 500_000);
      const lines = tail.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof msg.timestamp === "string"
            ? Date.parse(msg.timestamp)
            : Date.now();
          const updatedAt = Number.isFinite(ts) ? ts : Date.now();

          if (msg.type !== "response_item") continue;
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) continue;

          if (payload.type === "function_call" && typeof payload.name === "string") {
            const callId = typeof payload.call_id === "string" ? payload.call_id : "";
            if (!callId) continue;
            let input: Record<string, unknown> = {};
            if (typeof payload.arguments === "string") {
              try {
                input = JSON.parse(payload.arguments) as Record<string, unknown>;
              } catch {
                input = {};
              }
            }
            rememberCall(callId, payload.name, input);
            continue;
          }

          if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") continue;
          const callId = typeof payload.call_id === "string" ? payload.call_id : "";
          if (!callId) continue;
          const toolName = callIdToName.get(callId) ?? "";
          const input = callIdToInput.get(callId);
          const output = typeof payload.output === "string" ? payload.output : "";
          const trimmedOutput = output.trim();
          if (!trimmedOutput) continue;

          const sessionIdFromOutput = trimmedOutput.match(/Process running with session ID\s*([0-9]+)/i)?.[1];
          const sessionIdFromInput = normalizeCodexSessionId(input?.session_id);
          const sessionId = sessionIdFromOutput || sessionIdFromInput;
          const commandFromInput = typeof input?.cmd === "string" ? input.cmd : undefined;
          if (sessionId && commandFromInput && toolName === "exec_command") {
            sessionIdToCommand.set(sessionId, commandFromInput);
          }
          const command = (sessionId && sessionIdToCommand.get(sessionId)) || commandFromInput;

          if (sessionIdFromOutput && sessionId) {
            const existing = running.get(sessionId);
            running.set(sessionId, {
              taskId: sessionId,
              status: "running",
              command: command || existing?.command,
              summary: existing?.summary,
              outputFile: existing?.outputFile,
              urls: mergeUrls(
                existing?.urls,
                mergeUrls(extractUrls(trimmedOutput), inferUrlsFromCommand(command || existing?.command))
              ),
              updatedAt: Math.max(updatedAt, existing?.updatedAt ?? 0),
            });
          }

          if (sessionId) {
            const exitStatus = detectCodexExitStatus(trimmedOutput);
            if (exitStatus) {
              running.delete(sessionId);
              sessionIdToCommand.delete(sessionId);
            }
          }
        } catch {
          // Skip malformed JSON lines.
        }
      }
    } catch {
      // JSONL may not exist yet.
    }

    return running;
  };

  const hydrateBackgroundJobsFromLogs = async (sessionIds: string[]): Promise<void> => {
    for (const sessionId of sessionIds) {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) continue;
      const tool = getSessionTool(remote.command);
      if (tool !== "claude" && tool !== "codex") continue;
      const manifest = await readSessionManifest(sessionId);
      if (!manifest?.jsonlFile) continue;
      const runningFromLog = tool === "claude"
        ? await readRunningClaudeTasks(manifest.jsonlFile)
        : await readRunningCodexTasks(manifest.jsonlFile);
      if (runningFromLog.size === 0) continue;
      const existing = backgroundJobsBySession.get(sessionId) || new Map<string, BackgroundJobState>();
      let changed = false;
      for (const [taskId, snapshot] of runningFromLog) {
        const prior = existing.get(taskId);
        if (prior) continue;
        existing.set(taskId, snapshot);
        changed = true;
      }
      if (changed) {
        backgroundJobsBySession.set(sessionId, existing);
      }
    }
  };

  const getBackgroundTargets = (sessionId: string): Set<ChannelChatId> => {
    const targets = new Set<ChannelChatId>();
    const remote = sessionManager.getRemote(sessionId);
    if (!remote) return targets;
    const targetChat = sessionManager.getBoundChat(sessionId);
    if (targetChat) {
      targets.add(targetChat);
      return targets;
    }
    // Fallback to owner DM only if this session is actually attached there.
    const attachedInOwnerDm = sessionManager.getAttachedRemote(remote.chatId);
    if (attachedInOwnerDm?.id === sessionId) {
      targets.add(remote.chatId);
    }
    return targets;
  };

  const listBackgroundJobsForUserChat = async (
    userId: ChannelUserId,
    chatId: ChannelChatId
  ): Promise<BackgroundJobSessionSummary[]> => {
    const attachedId = sessionManager.getAttachedRemote(chatId)?.id;
    const userRemoteIds = sessionManager.listRemotesForUser(userId).map((remote) => remote.id);
    const candidateIds = attachedId ? [attachedId] : userRemoteIds;
    const candidates = new Set<string>(candidateIds);

    const buildRows = (): BackgroundJobSessionSummary[] => {
      const rows: BackgroundJobSessionSummary[] = [];
      for (const sessionId of candidates) {
        const remote = sessionManager.getRemote(sessionId);
        if (!remote) continue;
        if (!supportsBackgroundTracking(remote.command)) continue;
        const jobs = backgroundJobsBySession.get(sessionId);
        if (!jobs || jobs.size === 0) continue;
        rows.push({
          sessionId,
          command: remote.command,
          cwd: remote.cwd,
          jobs: Array.from(jobs.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((job) => ({
              taskId: job.taskId,
              command: job.command,
              urls: mergeUrls(job.urls, inferUrlsFromCommand(job.command)),
              updatedAt: job.updatedAt,
            })),
        });
      }
      return rows;
    };

    let rows = buildRows();
    if (rows.length > 0) {
      for (const sessionId of candidateIds) {
        const remote = sessionManager.getRemote(sessionId);
        const tool = remote ? getSessionTool(remote.command) : "";
        if (tool !== "claude" && tool !== "codex") continue;
        const jobs = backgroundJobsBySession.get(sessionId);
        if (!jobs || jobs.size === 0) continue;
        const manifest = await readSessionManifest(sessionId);
        if (!manifest?.jsonlFile) continue;
        const stopped = tool === "claude"
          ? await readStoppedClaudeTasks(manifest.jsonlFile, new Set(jobs.keys()))
          : await readStoppedCodexTasks(manifest.jsonlFile, new Set(jobs.keys()));
        if (stopped.size === 0) continue;
        for (const taskId of stopped) jobs.delete(taskId);
        if (jobs.size === 0) {
          backgroundJobsBySession.delete(sessionId);
        }
      }
      rows = buildRows();
    }
    const sessionsNeedingHydration = candidateIds.filter((sessionId) => {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return false;
      if (!supportsBackgroundTracking(remote.command)) return false;
      const jobs = backgroundJobsBySession.get(sessionId);
      return !jobs || jobs.size === 0;
    });

    if (sessionsNeedingHydration.length > 0) {
      await hydrateBackgroundJobsFromLogs(sessionsNeedingHydration);
      rows = buildRows();
    }

    rows.sort((a, b) => {
      // Prefer the currently attached session in this chat if it has jobs.
      if (attachedId && a.sessionId === attachedId && b.sessionId !== attachedId) return -1;
      if (attachedId && b.sessionId === attachedId && a.sessionId !== attachedId) return 1;
      const aLatest = a.jobs[0]?.updatedAt || 0;
      const bLatest = b.jobs[0]?.updatedAt || 0;
      return bLatest - aLatest;
    });

    return rows;
  };

  const announceBackgroundJobEvent = (
    sessionId: string,
    status: BackgroundJobStatus,
    job: {
      taskId: string;
      command?: string;
      summary?: string;
      urls?: string[];
    }
  ): void => {
    const dedupeKey = backgroundAnnouncementKey(sessionId, job.taskId);
    const previousStatus = backgroundJobAnnouncements.get(dedupeKey);
    if (previousStatus === status) return;
    backgroundJobAnnouncements.set(dedupeKey, status);

    const remote = sessionManager.getRemote(sessionId);
    const tool = remote ? getSessionTool(remote.command) : "";
    const noun = tool === "codex" ? "Background terminal" : "Background job";

    const emoji = status === "running"
      ? "🟢"
      : status === "completed"
      ? "✅"
      : status === "failed"
      ? "❌"
      : "🛑";
    const label = status === "running"
      ? `${noun} started`
      : status === "completed"
      ? `${noun} completed`
      : status === "failed"
      ? `${noun} failed`
      : `${noun} stopped`;

    for (const chatId of getBackgroundTargets(sessionId)) {
      if (isChatMutedForChat(chatId)) continue;
      if (!getOutputPreferencesForChat(chatId).backgroundJobs) continue;
      const fmt = getFormatterForChat(chatId);
      const lines: string[] = [
        `${fmt.escape(emoji)} ${fmt.bold(fmt.escape(label))}`,
        `${fmt.code(fmt.escape(job.taskId))} ${fmt.escape("—")} ${fmt.escape((job.command || noun.toLowerCase()).trim())}`,
      ];
      if (job.summary && status !== "running") {
        const trimmed = job.summary.trim();
        if (trimmed) lines.push(fmt.escape(trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed));
      }
      const url = job.urls?.find((candidate) => /^https?:\/\//i.test(candidate));
      if (url) lines.push(`↳ ${fmt.link(fmt.escape(url), url)}`);
      sendToChat(chatId, lines.join("\n"));
    }
  };

  const renderBackgroundBoard = (chatId: ChannelChatId, jobs: BackgroundJobState[]): string => {
    const fmt = getFormatterForChat(chatId);
    const header = `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape(`Background jobs (${jobs.length} running)`))}`;
    const lines: string[] = [];
    for (const job of jobs.slice(0, 8)) {
      const command = (job.command || "running").trim();
      lines.push(`• ${fmt.code(fmt.escape(job.taskId))} ${fmt.escape("—")} ${fmt.escape(command)}`);
      const url = job.urls?.[0];
      if (url && /^https?:\/\//i.test(url)) {
        lines.push(`  ↳ ${fmt.link(fmt.escape(url), url)}`);
      }
    }
    if (jobs.length > 8) {
      lines.push(fmt.escape(`+${jobs.length - 8} more`));
    }
    return [header, ...lines].join("\n");
  };

  const refreshBackgroundBoards = async (sessionId: string): Promise<void> => {
    const board = backgroundJobsBySession.get(sessionId);
    const jobs = board ? Array.from(board.values()) : [];
    const targets = getBackgroundTargets(sessionId);
    const key = backgroundBoardKey(sessionId);
    const entriesForSession = Array.from(persistedStatusBoards.values()).filter((e) => e.boardKey === key);

    // Clear stale boards if the chat is no longer a target for this session.
    for (const entry of entriesForSession) {
      if (targets.has(entry.chatId)) continue;
      const channel = getChannelForChat(entry.chatId);
      try {
        await channel?.clearStatusBoard?.(entry.chatId, key, {
          unpin: true,
          messageId: entry.messageId,
          pinned: entry.pinned,
        });
      } catch {}
      removePersistedStatusBoard(entry.chatId, key);
    }

    for (const chatId of targets) {
      const channel = getChannelForChat(chatId);
      if (!channel) continue;
      const persisted = persistedStatusBoards.get(statusBoardMapKey(chatId, key));
      if (!getOutputPreferencesForChat(chatId).backgroundJobs) {
        try {
          await channel.clearStatusBoard?.(chatId, key, {
            unpin: true,
            messageId: persisted?.messageId,
            pinned: persisted?.pinned,
          });
        } catch {}
        removePersistedStatusBoard(chatId, key);
        continue;
      }
      if (jobs.length === 0) {
        try {
          await channel.clearStatusBoard?.(chatId, key, {
            unpin: true,
            messageId: persisted?.messageId,
            pinned: persisted?.pinned,
          });
        } catch {}
        removePersistedStatusBoard(chatId, key);
        continue;
      }
      if (!channel.upsertStatusBoard) continue;
      const html = renderBackgroundBoard(chatId, jobs);
      try {
        const result = await channel.upsertStatusBoard(chatId, key, html, {
          pin: false,
          messageId: persisted?.messageId,
          pinned: persisted?.pinned,
        });
        const boardResult = getStatusBoardResult(result);
        const messageId = boardResult?.messageId || persisted?.messageId;
        const pinned = boardResult?.pinned ?? persisted?.pinned ?? false;
        if (messageId) {
          setPersistedStatusBoard(chatId, key, messageId, pinned);
        }
      } catch {}
    }
    if (jobs.length === 0) {
      backgroundJobsBySession.delete(sessionId);
    }
  };

  const nextWaitCycleId = (sessionId: string): number => {
    const next = (waitCycleCounters.get(sessionId) || 0) + 1;
    waitCycleCounters.set(sessionId, next);
    return next;
  };

  const createWaitCycle = (sessionId: string): WaitCycleState => {
    const cycleId = nextWaitCycleId(sessionId);
    return createWaitCycleState(sessionId, cycleId, Date.now());
  };

  const normalizeWaitText = (value?: string | null): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  };

  const normalizeWaitDetail = (value?: string | null): string | undefined => {
    const trimmed = normalizeWaitText(value);
    if (!trimmed) return undefined;
    return trimmed.length > WAIT_BOARD_DETAIL_MAX ? `${trimmed.slice(0, WAIT_BOARD_DETAIL_MAX - 3)}...` : trimmed;
  };

  const waitStatusLabel = (status: WaitTrackedItemStatus): string => {
    switch (status) {
      case "queued":
        return "queued";
      case "running":
        return "running";
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "blocked":
        return "blocked";
    }
  };

  const isTerminalWaitStatus = (status: WaitTrackedItemStatus): boolean => WAIT_TERMINAL_STATUSES.has(status);

  const getOrderedWaitItems = (cycle: WaitCycleState): WaitTrackedItemState[] => {
    const statusOrder: Record<WaitTrackedItemStatus, number> = {
      running: 0,
      queued: 1,
      failed: 2,
      blocked: 3,
      completed: 4,
    };
    return Array.from(cycle.items.values()).sort((a, b) => {
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      return b.updatedAt - a.updatedAt;
    });
  };

  const renderWaitItemLines = (chatId: ChannelChatId, item: WaitTrackedItemState): string[] => {
    const fmt = getFormatterForChat(chatId);
    const title = normalizeWaitText(item.title);
    const agentId = normalizeWaitText(item.agentId);
    const identity = title || agentId || item.itemKey;
    const head = title
      ? `${fmt.bold(fmt.escape(title))}${agentId ? ` ${fmt.escape("—")} ${fmt.code(fmt.escape(agentId))}` : ""}`
      : agentId
      ? fmt.code(fmt.escape(agentId))
      : fmt.code(fmt.escape(identity));
    const lines = [`• ${head} ${fmt.escape("—")} ${fmt.escape(waitStatusLabel(item.status))}`];
    const detail = normalizeWaitDetail(item.detail);
    if (detail) lines.push(`  ${fmt.escape(detail)}`);
    return lines;
  };

  const renderActiveWaitBoard = (chatId: ChannelChatId, cycle: WaitCycleState): string => {
    const fmt = getFormatterForChat(chatId);
    const items = getOrderedWaitItems(cycle);
    const waitCount = items.length;
    const lines: string[] = [
      `${fmt.escape("⏳")} ${fmt.bold(fmt.escape(`Waiting on ${waitCount} task${waitCount === 1 ? "" : "s"}`))}`,
    ];
    if (items.length === 0) {
      lines.push(fmt.escape("Waiting for task updates..."));
      return lines.join("\n");
    }
    for (const item of items) {
      lines.push(...renderWaitItemLines(chatId, item));
    }
    return lines.join("\n");
  };

  const getFinalWaitOutcome = (cycle: WaitCycleState): { emoji: string; label: string } => {
    const items = Array.from(cycle.items.values());
    if (items.some((item) => item.status === "failed")) {
      return { emoji: "❌", label: "Wait finished with failures" };
    }
    if (items.some((item) => item.status === "blocked")) {
      return { emoji: "🛑", label: "Wait blocked" };
    }
    return { emoji: "✅", label: "Wait complete" };
  };

  const renderFinalWaitBoard = (chatId: ChannelChatId, cycle: WaitCycleState): string => {
    const fmt = getFormatterForChat(chatId);
    const items = getOrderedWaitItems(cycle);
    const outcome = getFinalWaitOutcome(cycle);
    const lines: string[] = [
      `${fmt.escape(outcome.emoji)} ${fmt.bold(fmt.escape(outcome.label))}`,
    ];
    const summary = normalizeWaitDetail(cycle.finalSummary);
    if (summary) {
      lines.push(fmt.escape(summary));
    } else if (items.length > 0) {
      lines.push(fmt.escape(`${items.length} task${items.length === 1 ? "" : "s"} reached terminal status.`));
    }
    if (items.length === 0) {
      lines.push(fmt.escape("No wait items were reported."));
      return lines.join("\n");
    }
    for (const item of items) {
      lines.push(...renderWaitItemLines(chatId, item));
    }
    return lines.join("\n");
  };

  const renderInterruptedWaitBoard = (chatId: ChannelChatId): string => {
    const fmt = getFormatterForChat(chatId);
    return [
      `${fmt.escape("⚠️")} ${fmt.bold(fmt.escape("Wait tracking interrupted after daemon restart"))}`,
      fmt.escape("This wait board was closed. A later wait will start a new board."),
    ].join("\n");
  };

  const stopWaitHeartbeatForChat = (cycle: WaitCycleState, chatId: ChannelChatId): void => {
    const heartbeat = cycle.heartbeatByChat.get(chatId);
    if (heartbeat?.stopTimer) clearTimeout(heartbeat.stopTimer);
    cycle.heartbeatByChat.delete(chatId);
    setTypingForChat(chatId, false);
  };

  const stopWaitCycleHeartbeats = (cycle: WaitCycleState): void => {
    for (const chatId of Array.from(cycle.heartbeatByChat.keys())) {
      stopWaitHeartbeatForChat(cycle, chatId);
    }
  };

  const logWaitBoardEvent = async (event: WaitBoardLogEvent): Promise<void> => {
    await logTelegramDelivery(event);
  };

  const waitBoardOps: WaitBoardOps = {
    getConversationTargets: (sessionId) => getConversationTargets(sessionId),
    getOutputPreferencesForChat: (chatId) => getOutputPreferencesForChat(chatId),
    getChannelForChat: (chatId) => getChannelForChat(chatId) || undefined,
    getFormatterForChat: (chatId) => getFormatterForChat(chatId),
    getPersistedStatusBoard: (chatId, boardKey) => persistedStatusBoards.get(statusBoardMapKey(chatId, boardKey)),
    listPersistedStatusBoardsForBoard: (boardKey) => Array.from(persistedStatusBoards.values()).filter((entry) => entry.boardKey === boardKey),
    setPersistedStatusBoard: (chatId, boardKey, messageId, pinned) => setPersistedStatusBoard(chatId, boardKey, messageId, pinned),
    removePersistedStatusBoard: (chatId, boardKey) => removePersistedStatusBoard(chatId, boardKey),
    getPersistedActiveWaitCycle: (boardKey) => persistedActiveWaitCycles.get(boardKey),
    syncPersistedActiveWaitCycle: (sessionId, cycle, activeChatIds) => syncPersistedActiveWaitCycle(sessionId, cycle, activeChatIds),
    syncPersistedWaitCycleRetryState: (entry, activeChatIds) => syncPersistedWaitCycleRetryState(entry, activeChatIds),
    removePersistedActiveWaitCycle: (boardKey) => {
      persistedActiveWaitCycles.delete(boardKey);
      schedulePersistStatusBoards();
    },
    listPersistedWaitCyclesForCleanup: () => listPersistedWaitCyclesForCleanup(),
    setTyping: (chatId, active) => setTypingForChat(chatId, active),
    setStopTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearStopTimer: (timer) => clearTimeout(timer),
    logWaitBoardEvent,
  };

  const maintainWaitCycleHeartbeat = (sessionId: string, cycle: WaitCycleState, now = Date.now()): void => {
    maintainWaitCycleHeartbeatState(sessionId, cycle, waitBoardOps, now);
  };

  const refreshWaitCycleBoards = (sessionId: string, cycle: WaitCycleState): Promise<void> => {
    return refreshWaitCycleBoardsState(sessionId, cycle, waitBoardOps);
  };

  const finalizeWaitCycleBoards = (sessionId: string, cycle: WaitCycleState): Promise<void> => {
    return finalizeWaitCycleBoardsState(sessionId, cycle, waitBoardOps);
  };

  const enqueueWaitCycleBoardWork = (sessionId: string, work: () => Promise<void>): void => {
    const prior = waitCycleBoardWorkBySession.get(sessionId) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(work)
      .catch(async (error) => {
        await logger.warn("Wait board update failed", {
          sessionId,
          error: (error as Error)?.message ?? String(error),
        });
      });
    const tracked = next.finally(() => {
      if (waitCycleBoardWorkBySession.get(sessionId) === tracked) {
        waitCycleBoardWorkBySession.delete(sessionId);
      }
    });
    waitCycleBoardWorkBySession.set(sessionId, tracked);
  };


  const ensureActiveWaitCycle = (sessionId: string): WaitCycleState => {
    const existing = activeWaitCyclesBySession.get(sessionId);
    if (existing) return existing;
    const created = createWaitCycle(sessionId);
    activeWaitCyclesBySession.set(sessionId, created);
    return created;
  };

  const stopActiveWaitCycle = (sessionId: string): void => {
    const cycle = activeWaitCyclesBySession.get(sessionId);
    if (!cycle || cycle.finalizing) return;
    activeWaitCyclesBySession.delete(sessionId);
    stopWaitCycleHeartbeats(cycle);
    markWaitCycleStopRequestedState(cycle, Date.now());
    cycle.lastBoardRefreshAt = Date.now();
    enqueueWaitCycleBoardWork(sessionId, async () => {
      await finalizeWaitCycleBoards(sessionId, cycle);
    });
  };


  const clearBackgroundBoards = async (sessionId: string): Promise<void> => {
    const key = backgroundBoardKey(sessionId);
    const entriesForSession = Array.from(persistedStatusBoards.values()).filter((e) => e.boardKey === key);
    for (const entry of entriesForSession) {
      const channel = getChannelForChat(entry.chatId);
      try {
        await channel?.clearStatusBoard?.(entry.chatId, key, {
          unpin: true,
          messageId: entry.messageId,
          pinned: entry.pinned,
        });
      } catch {}
      removePersistedStatusBoard(entry.chatId, key);
    }
    // Also clear from currently bound targets in case a board wasn't persisted yet.
    for (const chatId of getBackgroundTargets(sessionId)) {
      const channel = getChannelForChat(chatId);
      try {
        await channel?.clearStatusBoard?.(chatId, key, { unpin: true });
      } catch {}
      removePersistedStatusBoard(chatId, key);
    }
    backgroundJobsBySession.delete(sessionId);
    for (const entryKey of Array.from(backgroundJobAnnouncements.keys())) {
      if (entryKey.startsWith(`${sessionId}::`)) {
        backgroundJobAnnouncements.delete(entryKey);
      }
    }
  };

  // Auto-stop timer: shut down when all sessions disconnect
  const AUTO_STOP_DELAY = 30_000;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutoStop() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
  }

  function scheduleAutoStop() {
    cancelAutoStop();
    autoStopTimer = setTimeout(async () => {
      if (sessionManager.remoteCount() === 0) {
        await logger.info("No active sessions, auto-stopping daemon");
        for (const { channel } of channels) channel.stopReceiving();
        sessionManager.killAll();
        await removeAuthToken();
        await removePidFile();
        await removeDaemonLock();
        await removeSocket();
        await removeControlPortFile();
        process.exit(0);
      }
    }, AUTO_STOP_DELAY);
  }

  const cleanupStalePersistedBoards = async (): Promise<void> => {
    const now = Date.now();
    const entries = Array.from(persistedStatusBoards.values());
    for (const entry of entries) {
      const sessionId = sessionIdFromBoardKey(entry.boardKey);
      if (sessionId && sessionManager.getRemote(sessionId)) continue;
      if (now - entry.updatedAt < BACKGROUND_BOARD_STALE_MS) continue;
      const channel = getChannelForChat(entry.chatId);
      try {
        await channel?.clearStatusBoard?.(entry.chatId, entry.boardKey, {
          unpin: true,
          messageId: entry.messageId,
          pinned: entry.pinned,
        });
      } catch {}
      removePersistedStatusBoard(entry.chatId, entry.boardKey);
    }
  };

  const reconcileBackgroundState = async (): Promise<void> => {
    if (reconcilingBackgroundState) return;
    reconcilingBackgroundState = true;
    try {
      for (const sessionId of backgroundJobsBySession.keys()) {
        const remote = sessionManager.getRemote(sessionId);
        if (!remote) {
          const hasPersistedBoard = Array.from(persistedStatusBoards.values()).some(
            (entry) => sessionIdFromBoardKey(entry.boardKey) === sessionId
          );
          if (!hasPersistedBoard) {
            backgroundJobsBySession.delete(sessionId);
          }
          continue;
        }

        // Periodically confirm stop events from JSONL in case a watcher event was missed.
        const tool = getSessionTool(remote.command);
        if (tool === "claude" || tool === "codex") {
          const jobs = backgroundJobsBySession.get(sessionId);
          const runningTaskIds = new Set(Array.from(jobs?.keys() || []));
          if (runningTaskIds.size > 0) {
            const manifest = await readSessionManifest(sessionId);
            if (manifest?.jsonlFile) {
              const stopped = tool === "claude"
                ? await readStoppedClaudeTasks(manifest.jsonlFile, runningTaskIds)
                : await readStoppedCodexTasks(manifest.jsonlFile, runningTaskIds);
              if (stopped.size > 0 && jobs) {
                for (const taskId of stopped) jobs.delete(taskId);
              }
            }
          }
        }

        await refreshBackgroundBoards(sessionId);
      }

      await cleanupStalePersistedBoards();
    } finally {
      reconcilingBackgroundState = false;
    }
  };

  const runWaitCycleMaintenance = (now = Date.now()): void => {
    for (const [sessionId, cycle] of Array.from(activeWaitCyclesBySession.entries())) {
      maintainWaitCycleHeartbeat(sessionId, cycle, now);
      if (now - cycle.lastBoardRefreshAt < WAIT_BOARD_RECONCILE_INTERVAL_MS) continue;
      cycle.lastBoardRefreshAt = now;
      enqueueWaitCycleBoardWork(sessionId, async () => {
        if (activeWaitCyclesBySession.get(sessionId) !== cycle || cycle.finalizing) return;
        await refreshWaitCycleBoards(sessionId, cycle);
        const remote = sessionManager.getRemote(sessionId);
        const hasPersistedBoard = Array.from(persistedStatusBoards.values()).some((entry) => entry.boardKey === cycle.boardKey);
        if (!remote && !hasPersistedBoard && activeWaitCyclesBySession.get(sessionId) === cycle) {
          stopWaitCycleHeartbeats(cycle);
          activeWaitCyclesBySession.delete(sessionId);
        }
      });
    }
  };

  const cleanupInterruptedWaitCycleBoards = (): Promise<void> => {
    return cleanupInterruptedWaitCycleBoardsState(waitBoardOps);
  };

  await loadPersistedStatusBoards();
  await cleanupInterruptedWaitCycleBoards();
  void cleanupStalePersistedBoards();
  const backgroundBoardRefreshTimer = setInterval(() => {
    void reconcileBackgroundState();
  }, BACKGROUND_RECONCILE_INTERVAL_MS);
  const waitCycleMaintenanceTimer = setInterval(() => {
    runWaitCycleMaintenance();
  }, WAIT_HEARTBEAT_SWEEP_INTERVAL_MS);
  void reconcileBackgroundState();
  runWaitCycleMaintenance();

  // Wire dead chat detection — clean up subscriptions and linked groups when sends fail permanently
  for (const { channel } of channels) {
    if ("onDeadChat" in channel) {
      channel.onDeadChat = async (deadChatId, error) => {
        await logger.info("Dead chat detected", { chatId: deadChatId, error: error.message });
        // Unsubscribe dead chat from all sessions
        for (const session of sessionManager.list()) {
          sessionManager.unsubscribeGroup(session.id, deadChatId);
        }
        // Detach from any bound session
        sessionManager.detach(deadChatId);
        // Drop persisted status boards for dead chats.
        for (const entry of Array.from(persistedStatusBoards.values())) {
          if (entry.chatId === deadChatId) {
            removePersistedStatusBoard(entry.chatId, entry.boardKey);
          }
        }
        // Remove from linked groups config
        await refreshConfig();
        if (removeLinkedGroup(config, deadChatId, getChannelName(deadChatId))) {
          await saveConfig(config);
        }
      };
    }
  }

  // --- Poll / AskUserQuestion support ---

  async function sendNextPoll(sessionId: string, sendOptions?: { timeoutMs?: number }) {
    if (sessionManager.getActivePollForSession(sessionId)) return;
    const pending = sessionManager.getPendingQuestions(sessionId);
    if (!pending) return;
    const idx = pending.currentIndex;
    if (idx >= pending.questions.length) {
      // All questions answered — press Enter on "Submit answers" screen, then cleanup
      const remote = sessionManager.getRemote(sessionId);
      if (remote) {
        remote.inputQueue.push("\x1b[POLL_SUBMIT]");
      }
      sessionManager.clearPendingQuestions(sessionId);
      return;
    }

    const q = pending.questions[idx];
    // Build options for poll (max 10 real options to keep UI manageable across channels)
    const optionLabels = q.options.slice(0, 9).map((o) => o.label);
    optionLabels.push("Other (type a reply)");

    try {
      const questionText = q.question.length > 300 ? q.question.slice(0, 297) + "..." : q.question;
      const sent = await sendPollToChat(
        pending.chatId,
        questionText,
        optionLabels,
        q.multiSelect,
        sendOptions
      );
      if (!sent) return;
      const { pollId, messageId } = sent;
      sessionManager.registerPoll(pollId, {
        sessionId,
        chatId: pending.chatId,
        messageId,
        questionIndex: idx,
        totalQuestions: pending.questions.length,
        multiSelect: q.multiSelect,
        optionCount: optionLabels.length - 1, // exclude "Other"
        question: questionText,
        optionLabels,
      });
    } catch (e) {
      await logger.error("Failed to send poll", { sessionId, error: (e as Error).message });
      sessionManager.clearPendingQuestions(sessionId);
    }
  }

  async function sendPendingApprovalPoll(sessionId: string, sendOptions?: { timeoutMs?: number }) {
    if (sessionManager.getActivePollForSession(sessionId)) return;
    const pending = pendingApprovalBySession.get(sessionId);
    if (!pending) return;
    try {
      const sent = await sendPollToChat(
        pending.chatId,
        pending.question,
        pending.options,
        false,
        sendOptions
      );
      if (!sent) return;
      const { pollId, messageId } = sent;
      sessionManager.registerPoll(pollId, {
        sessionId,
        chatId: pending.chatId,
        messageId,
        questionIndex: 0,
        totalQuestions: 1,
        multiSelect: false,
        optionCount: pending.options.length,
        question: pending.question,
        optionLabels: pending.options,
      });
      pendingApprovalBySession.delete(sessionId);
    } catch (error) {
      await logger.error("Failed to send approval poll", {
        sessionId,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }


  const scheduleNextQuestionPoll = createQuestionPollScheduler({
    getPendingQuestions: (sessionId) => sessionManager.getPendingQuestions(sessionId) ?? null,
    hasActivePollForSession: (sessionId) => !!sessionManager.getActivePollForSession(sessionId),
    isChatMutedForChat,
    enqueueOrderedConversationDelivery,
    sendNextPoll,
  });

  const schedulePendingInteractiveDelivery = (sessionId: string, chatId: ChannelChatId): void => {
    if (pendingApprovalBySession.get(sessionId)?.chatId === chatId) {
      enqueueOrderedConversationDelivery(chatId, async (timeoutMs) => {
        if (isChatMutedForChat(chatId)) return;
        await sendPendingApprovalPoll(sessionId, { timeoutMs });
      });
    }
    if (sessionManager.getPendingQuestions(sessionId)?.chatId === chatId) {
      scheduleNextQuestionPoll(sessionId);
    }
  };

  const handleLocalPromptSubmit = (sessionId: string): void => {
    clearInteractiveStateForLocalPromptSubmit({
      clearPendingQuestions: (targetSessionId) => sessionManager.clearPendingQuestions(targetSessionId),
      clearPendingApproval: (targetSessionId) => pendingApprovalBySession.delete(targetSessionId),
      getActivePollForSession: (targetSessionId) => sessionManager.getActivePollForSession(targetSessionId),
      removePoll: (pollId) => sessionManager.removePoll(pollId),
      closePollForChat: (chatId, messageId) => closePollForChat(chatId, messageId),
    }, sessionId);
  };

  function buildFilePickerPage(
    files: string[],
    query: string,
    page: number,
    selectedMentions: string[],
    pageSize: number
  ): {
    page: number;
    totalPages: number;
    options: PendingFilePickerOption[];
    optionLabels: string[];
    title: string;
  } {
    const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const start = currentPage * pageSize;
    const visible = files.slice(start, start + pageSize);
    const selected = new Set(selectedMentions);

    const options: PendingFilePickerOption[] = visible.map((path) => ({
      kind: "toggle",
      mention: `@${path}`,
    }));
    const optionLabels: string[] = visible.map((path) => {
      const isDir = path.endsWith("/");
      const mention = `@${path}`;
      return `${selected.has(mention) ? "✅" : "☑️"} ${isDir ? "📁 " : ""}${mention}`;
    });

    if (totalPages > 1 && currentPage > 0) {
      options.push({ kind: "prev" });
      optionLabels.push("⬅️ Prev");
    }
    if (totalPages > 1 && currentPage < totalPages - 1) {
      options.push({ kind: "next" });
      optionLabels.push("➡️ Next");
    }
    if (selected.size > 0) {
      options.push({ kind: "clear" });
      optionLabels.push("🧹 Clear selected");
    }
    options.push({ kind: "cancel" });
    optionLabels.push("❌ Cancel");

    const q = query.trim();
    const title = q
      ? `Pick paths (${q}) ${currentPage + 1}/${totalPages} • selected ${selected.size}`
      : `Pick paths ${currentPage + 1}/${totalPages} • selected ${selected.size}`;

    return { page: currentPage, totalPages, options, optionLabels, title };
  }

  function handlePollAnswer(answer: { pollId: string; userId: ChannelUserId; optionIds: number[] }) {
    const filePicker = sessionManager.getFilePickerByPollId(answer.pollId);
    if (filePicker) {
      if (!isUserPaired(config, answer.userId)) {
        logger.warn("Ignoring file picker answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
        return;
      }
      if (filePicker.ownerUserId !== answer.userId) {
        logger.warn("Ignoring file picker answer from non-owner", {
          userId: answer.userId,
          pollId: answer.pollId,
          ownerUserId: filePicker.ownerUserId,
        });
        return;
      }

      sessionManager.removeFilePicker(answer.pollId);

      const selectedIdx = answer.optionIds[0];
      if (!Number.isFinite(selectedIdx)) return;
      if (selectedIdx < 0 || selectedIdx >= filePicker.options.length) return;
      const selected = filePicker.options[selectedIdx];

      if (selected.kind === "cancel") {
        const pickerFmt = getFormatterForChat(filePicker.chatId);
        closePollForChat(
          filePicker.chatId,
          filePicker.messageId,
          `${pickerFmt.escape("📎")} File picker canceled.`
        );
        return;
      }

      closePollForChat(filePicker.chatId, filePicker.messageId);

      if (selected.kind === "clear") {
        sessionManager.setPendingFileMentions(
          filePicker.sessionId,
          filePicker.chatId,
          filePicker.ownerUserId,
          []
        );
        const nextPage = buildFilePickerPage(
          filePicker.files,
          filePicker.query,
          filePicker.page,
          [],
          filePicker.pageSize
        );
        sendPollToChat(filePicker.chatId, nextPage.title, nextPage.optionLabels, false)
          .then((sent) => {
            if (!sent) return;
            sessionManager.registerFilePicker({
              pollId: sent.pollId,
              messageId: sent.messageId,
              chatId: filePicker.chatId,
              ownerUserId: filePicker.ownerUserId,
              sessionId: filePicker.sessionId,
              files: filePicker.files,
              query: filePicker.query,
              page: nextPage.page,
              pageSize: filePicker.pageSize,
              totalPages: nextPage.totalPages,
              selectedMentions: [],
              options: nextPage.options,
            });
          })
          .catch(() => {});
        return;
      }

      let nextSelected = filePicker.selectedMentions.slice();
      let targetPage = filePicker.page;
      if (selected.kind === "toggle") {
        if (nextSelected.includes(selected.mention)) {
          nextSelected = nextSelected.filter((m) => m !== selected.mention);
        } else {
          nextSelected.push(selected.mention);
        }
      } else if (selected.kind === "next") {
        targetPage = filePicker.page + 1;
      } else if (selected.kind === "prev") {
        targetPage = filePicker.page - 1;
      }

      if (selected.kind === "toggle") {
        sessionManager.setPendingFileMentions(
          filePicker.sessionId,
          filePicker.chatId,
          filePicker.ownerUserId,
          nextSelected
        );
      }

      const nextPage = buildFilePickerPage(
        filePicker.files,
        filePicker.query,
        targetPage,
        nextSelected,
        filePicker.pageSize
      );

      sendPollToChat(filePicker.chatId, nextPage.title, nextPage.optionLabels, false)
        .then((sent) => {
          if (!sent) return;
          sessionManager.registerFilePicker({
            pollId: sent.pollId,
            messageId: sent.messageId,
            chatId: filePicker.chatId,
            ownerUserId: filePicker.ownerUserId,
            sessionId: filePicker.sessionId,
            files: filePicker.files,
            query: filePicker.query,
            page: nextPage.page,
            pageSize: filePicker.pageSize,
            totalPages: nextPage.totalPages,
            selectedMentions: nextSelected,
            options: nextPage.options,
          });
        })
        .catch(() => {});
      return;
    }

    const throttlePicker = sessionManager.getThrottlePickerByPollId(answer.pollId);
    if (throttlePicker) {
      if (!isUserPaired(config, answer.userId)) {
        logger.warn("Ignoring throttle picker answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
        return;
      }
      if (throttlePicker.ownerUserId !== answer.userId) {
        logger.warn("Ignoring throttle picker answer from non-owner", {
          userId: answer.userId,
          pollId: answer.pollId,
          ownerUserId: throttlePicker.ownerUserId,
        });
        return;
      }

      sessionManager.removeThrottlePicker(answer.pollId);
      const selectedIdx = answer.optionIds[0];
      if (!Number.isFinite(selectedIdx)) return;
      if (selectedIdx < 0 || selectedIdx >= throttlePicker.options.length) return;
      const selected = throttlePicker.options[selectedIdx];
      const chatId = throttlePicker.chatId;
      const activatedAt = new Date().toISOString();
      const nextDelivery = selected.kind === "off"
        ? { mode: "immediate" } satisfies ChatDeliveryPreference
        : {
            mode: "throttle",
            intervalMinutes: selected.value,
            activatedAt,
            lastSummaryAt: null,
            pendingUserTurnSince: null,
          } satisfies ChatDeliveryPreference;
      const changed = setChatDeliveryPreference(config, chatId, nextDelivery);
      if (changed) saveConfig(config).catch(() => {});
      if (nextDelivery.mode !== "immediate") setTypingForChat(chatId, false);
      else clearDeliveryRuntimeForChat(chatId);
      closePollForChat(chatId, throttlePicker.messageId, buildThrottleSummaryMessage(chatId, config, getFormatterForChat(chatId)));
      syncCommandMenuForChat(chatId, throttlePicker.ownerUserId);
      return;
    }

    const mutePicker = sessionManager.getMutePickerByPollId(answer.pollId);
    if (mutePicker) {
      if (!isUserPaired(config, answer.userId)) {
        logger.warn("Ignoring mute picker answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
        return;
      }
      if (mutePicker.ownerUserId !== answer.userId) {
        logger.warn("Ignoring mute picker answer from non-owner", {
          userId: answer.userId,
          pollId: answer.pollId,
          ownerUserId: mutePicker.ownerUserId,
        });
        return;
      }

      sessionManager.removeMutePicker(answer.pollId);
      const selectedIdx = answer.optionIds[0];
      if (!Number.isFinite(selectedIdx)) return;
      if (selectedIdx < 0 || selectedIdx >= mutePicker.options.length) return;
      const selected = mutePicker.options[selectedIdx];
      const chatId = mutePicker.chatId;
      const activatedAt = new Date().toISOString();
      const nextDelivery = selected.kind === "permanent"
        ? {
            mode: "mute",
            kind: "permanent",
            activatedAt,
            pendingUserTurnSince: null,
            lastAwaitingUserNoticeAt: null,
          } satisfies ChatDeliveryPreference
        : {
            mode: "mute",
            kind: "timed",
            activatedAt,
            mutedUntil: new Date(Date.now() + selected.value * 60_000).toISOString(),
            pendingUserTurnSince: null,
          } satisfies ChatDeliveryPreference;
      const changed = setChatDeliveryPreference(config, chatId, nextDelivery);
      if (changed) saveConfig(config).catch(() => {});
      setTypingForChat(chatId, false);
      closePollForChat(chatId, mutePicker.messageId, buildMuteSummaryMessage(chatId, config, getFormatterForChat(chatId)));
      syncCommandMenuForChat(chatId, mutePicker.ownerUserId);
      return;
    }


    const outputModePicker = sessionManager.getOutputModePickerByPollId(answer.pollId);
    if (outputModePicker) {
      if (!isUserPaired(config, answer.userId)) {
        logger.warn("Ignoring output-mode picker answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
        return;
      }
      if (outputModePicker.ownerUserId !== answer.userId) {
        logger.warn("Ignoring output-mode picker answer from non-owner", {
          userId: answer.userId,
          pollId: answer.pollId,
          ownerUserId: outputModePicker.ownerUserId,
        });
        return;
      }

      sessionManager.removeOutputModePicker(answer.pollId);
      const selectedIdx = answer.optionIds[0];
      if (!Number.isFinite(selectedIdx)) return;
      if (selectedIdx < 0 || selectedIdx >= outputModePicker.options.length) return;
      const selected = outputModePicker.options[selectedIdx] as PendingOutputModeOption;
      const chatId = outputModePicker.chatId;

      if (selected.kind === "preset") {
        if (selected.value !== "custom") {
          const changed = applyChatTranscriptPreset(config, chatId, selected.value);
          if (changed) saveConfig(config).catch(() => {});
          const pickerFmt = getFormatterForChat(chatId);
          closePollForChat(chatId, outputModePicker.messageId, buildOutputModeSummaryMessage(chatId, config, pickerFmt));
          return;
        }

        const current = getChatOutputPreferences(config, chatId);
        closePollForChat(chatId, outputModePicker.messageId, `${getFormatterForChat(chatId).escape("⛳️")} ${getFormatterForChat(chatId).escape("Custom output setup started.")}`);
        const next = buildOutputPickerPrompt("thinkingMode", current);
        sendPollToChat(chatId, next.title, next.optionLabels, false)
          .then((sent) => {
            if (!sent) return;
            sessionManager.registerOutputModePicker({
              pollId: sent.pollId,
              messageId: sent.messageId,
              chatId,
              ownerUserId: outputModePicker.ownerUserId,
              step: "thinkingMode",
              options: next.options,
              pendingOutput: current,
            });
          })
          .catch(() => {});
        return;
      }

      const current = outputModePicker.pendingOutput || getChatOutputPreferences(config, chatId);
      const { nextOutput, nextStep } = advanceOutputWizardSelection(current, selected);
      if (!nextStep) {
        const changed = setChatOutputPreferences(config, chatId, nextOutput);
        if (changed) saveConfig(config).catch(() => {});
        const pickerFmt = getFormatterForChat(chatId);
        closePollForChat(chatId, outputModePicker.messageId, buildOutputModeSummaryMessage(chatId, config, pickerFmt));
        return;
      }

      closePollForChat(chatId, outputModePicker.messageId);
      const next = buildOutputPickerPrompt(nextStep, nextOutput);
      sendPollToChat(chatId, next.title, next.optionLabels, false)
        .then((sent) => {
          if (!sent) return;
          sessionManager.registerOutputModePicker({
            pollId: sent.pollId,
            messageId: sent.messageId,
            chatId,
            ownerUserId: outputModePicker.ownerUserId,
            step: nextStep,
            options: next.options,
            pendingOutput: nextOutput,
          });
        })
        .catch(() => {});
      return;
    }

    const rcPicker = sessionManager.getRemoteControlPickerByPollId(answer.pollId);
    if (rcPicker) {
      if (!isUserPaired(config, answer.userId)) {
        logger.warn("Ignoring remote-control picker answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
        return;
      }
      if (rcPicker.ownerUserId !== answer.userId) {
        logger.warn("Ignoring remote-control picker answer from non-owner", {
          userId: answer.userId,
          pollId: answer.pollId,
          ownerUserId: rcPicker.ownerUserId,
        });
        return;
      }

      sessionManager.removeRemoteControlPicker(answer.pollId);

      const selectedIdx = answer.optionIds[0];
      if (!Number.isFinite(selectedIdx)) return;
      if (selectedIdx < 0 || selectedIdx >= rcPicker.options.length) return;
      const selected = rcPicker.options[selectedIdx];
      const pickerFmt = getFormatterForChat(rcPicker.chatId);

      if (selected.kind === "exit") {
        closePollForChat(
          rcPicker.chatId,
          rcPicker.messageId,
          `${pickerFmt.escape("⛳️")} Remote control disconnected.`
        );
        sessionManager.detach(rcPicker.chatId);
        syncCommandMenuForChat(rcPicker.chatId, rcPicker.ownerUserId);
        return;
      }

      // Bind session to this chat
      const remote = sessionManager.getRemote(selected.sessionId);
      if (!remote) {
        closePollForChat(
          rcPicker.chatId,
          rcPicker.messageId,
          `${pickerFmt.escape("⛳️")} Session is no longer active.`
        );
        return;
      }

      // Disconnect old session from this chat if taken
      const oldRemote = sessionManager.getAttachedRemote(rcPicker.chatId);
      if (oldRemote && oldRemote.id !== selected.sessionId) {
        sessionManager.detach(rcPicker.chatId);
      }

      sessionManager.attach(rcPicker.chatId, selected.sessionId);
      // Subscribe group for output broadcasting if it's a group chat
      if (rcPicker.chatId !== remote.chatId) {
        sessionManager.subscribeGroup(selected.sessionId, rcPicker.chatId);
      }
      syncCommandMenuForChat(rcPicker.chatId, rcPicker.ownerUserId);
      closePollForChat(
        rcPicker.chatId,
        rcPicker.messageId,
        `${pickerFmt.escape("⛳️")} ${pickerFmt.bold(pickerFmt.escape(sessionLabel(remote.command, remote.cwd, remote.name)))} connected`
      );

      // Offer to load recent messages
      sendPollToChat(rcPicker.chatId, "Load recent messages?", ["Yes", "No"], false).then((sent) => {
        if (!sent) return;
        sessionManager.registerRecentMessagesPoll(sent.pollId, {
          sessionId: selected.sessionId,
          chatId: rcPicker.chatId,
          messageId: sent.messageId,
        });
      }).catch(() => {});

      return;
    }

    // Handle "Load recent messages?" poll answer
    const recentPoll = sessionManager.getRecentMessagesPoll(answer.pollId);
    if (recentPoll) {
      sessionManager.removeRecentMessagesPoll(answer.pollId);

      const selectedIdx = answer.optionIds[0];
      const recentFmt = getFormatterForChat(recentPoll.chatId);
      if (selectedIdx === 0) { // "Yes"
        closePollForChat(
          recentPoll.chatId,
          recentPoll.messageId,
          `${recentFmt.escape("📋")} Loading recent messages…`
        );
        try {
          const manifests = readManifests();
          const manifest = manifests.get(recentPoll.sessionId);
          if (manifest?.jsonlFile) {
            const raw = require("fs").readFileSync(manifest.jsonlFile, "utf-8") as string;
            const fmt = getFormatterForChat(recentPoll.chatId);
            const replay = buildRecentActivityReplayMessages(fmt, raw, 10);
            if (replay.summaryMessage) sendToChat(recentPoll.chatId, replay.summaryMessage);
            if (replay.assistantMessage) sendToChat(recentPoll.chatId, replay.assistantMessage);
            if (!replay.summaryMessage && !replay.assistantMessage) {
              sendToChat(recentPoll.chatId, "No recent messages found.");
            }
          } else {
            sendToChat(recentPoll.chatId, "No session log available.");
          }
        } catch {
          sendToChat(recentPoll.chatId, "Failed to load recent messages.");
        }
      } else {
        // "No" — just dismiss
        closePollForChat(recentPoll.chatId, recentPoll.messageId, `${recentFmt.escape("📋")} Skipped loading recent messages.`);
      }
      return;
    }

    const poll = sessionManager.getPollByPollId(answer.pollId);
    if (!poll) return;
    if (!isUserPaired(config, answer.userId)) {
      logger.warn("Ignoring poll answer from unpaired user", { userId: answer.userId, pollId: answer.pollId });
      return;
    }

    const remote = sessionManager.getRemote(poll.sessionId);
    if (!remote) return;
    if (remote.ownerUserId !== answer.userId) {
      logger.warn("Ignoring poll answer from non-owner", {
        userId: answer.userId,
        sessionId: poll.sessionId,
        ownerUserId: remote.ownerUserId,
      });
      return;
    }

    sessionManager.removePoll(answer.pollId);

    const otherIdx = poll.optionCount; // "Other" is the last option
    const selectedOther = answer.optionIds.includes(otherIdx);

    // Build confirmation text
    const pollFmt = getFormatterForChat(poll.chatId);
    if (selectedOther) {
      closePollForChat(
        poll.chatId,
        poll.messageId,
        poll.question
          ? `${pollFmt.bold(pollFmt.escape(poll.question))}\n${pollFmt.escape("→ Other (type your answer)")}`
          : undefined
      );
      // User chose "Other" — push marker, wait for text message
      remote.inputQueue.push("\x1b[POLL_OTHER]");
      // Don't advance to next question; text handler will do that
      sessionManager.clearPendingQuestions(poll.sessionId);
    } else {
      // Build selected labels for confirmation
      let confirmText: string | undefined;
      if (poll.question && poll.optionLabels) {
        const selectedLabels = answer.optionIds
          .filter((i) => i < poll.optionLabels!.length)
          .map((i) => poll.optionLabels![i]);
        if (selectedLabels.length > 0) {
          confirmText = `${pollFmt.bold(pollFmt.escape(poll.question))}\n${pollFmt.escape("→ " + selectedLabels.join(", "))}`;
        }
      }
      closePollForChat(poll.chatId, poll.messageId, confirmText);

      // Encode selected options
      const encoded = `\x1b[POLL:${answer.optionIds.join(",")}:${poll.multiSelect ? "1" : "0"}]`;
      remote.inputQueue.push(encoded);

      // For multi-select, need to navigate Down to "Next"/"Submit" and press Enter
      // (single-select Enter already advances automatically)
      // Encode last cursor position and option count so CLI can calculate Downs needed
      if (poll.multiSelect) {
        const lastPos = answer.optionIds.length > 0 ? Math.max(...answer.optionIds) : 0;
        remote.inputQueue.push(`\x1b[POLL_NEXT:${lastPos}:${poll.optionCount}]`);
      }

      // Record answer and advance
      const pending = sessionManager.getPendingQuestions(poll.sessionId);
      if (pending) {
        pending.answers.push(answer.optionIds);
        pending.currentIndex++;
        scheduleNextQuestionPoll(poll.sessionId);
      }
    }
  }

  async function sweepDeliveryModes(): Promise<void> {
    const now = Date.now();
    for (const remote of sessionManager.listRemotes()) {
      const targets = getConversationTargets(remote.id);
      for (const chatId of targets) {
        const delivery = getDeliveryPreferenceForChat(chatId);
        if (delivery.mode === "immediate") {
          clearDeliveryRuntimeState(remote.id, chatId);
          if (!sessionManager.getActivePollForSession(remote.id)) {
            schedulePendingInteractiveDelivery(remote.id, chatId);
          }
          continue;
        }

        if (isThrottleDeliveryPreference(delivery)) {
          const lastSummaryAtMs = delivery.lastSummaryAt ? Date.parse(delivery.lastSummaryAt) : Date.parse(delivery.activatedAt);
          const dueAt = lastSummaryAtMs + delivery.intervalMinutes * 60_000;
          if (Number.isFinite(dueAt) && now >= dueAt) {
            enqueueOrderedConversationDelivery(chatId, async (timeoutMs) => {
              const current = getDeliveryPreferenceForChat(chatId);
              if (!isThrottleDeliveryPreference(current)) return;
              const flushed = await flushBufferedDelivery(remote.id, chatId, { timeoutMs, includeReplay: false });
              if (!flushed) return;
              await updateDeliveryPreferenceForChat(chatId, (latest) => (
                isThrottleDeliveryPreference(latest)
                  ? { ...latest, lastSummaryAt: new Date().toISOString(), pendingUserTurnSince: null }
                  : latest
              ));
            });
          }
          continue;
        }

        if (isTimedMuteDeliveryPreference(delivery)) {
          const mutedUntilMs = Date.parse(delivery.mutedUntil);
          if (Number.isFinite(mutedUntilMs) && now >= mutedUntilMs) {
            enqueueOrderedConversationDelivery(chatId, async (timeoutMs) => {
              const current = getDeliveryPreferenceForChat(chatId);
              if (!isTimedMuteDeliveryPreference(current) || Date.parse(current.mutedUntil) > Date.now()) return;
              const flushed = await flushBufferedDelivery(remote.id, chatId, { timeoutMs });
              if (!flushed) return;
              await updateDeliveryPreferenceForChat(chatId, () => ({ mode: "immediate" }));
              syncCommandMenuForChat(chatId, remote.ownerUserId);
              schedulePendingInteractiveDelivery(remote.id, chatId);
              clearDeliveryRuntimeState(remote.id, chatId);
            });
          }
          continue;
        }

        if (
          isPermanentMuteDeliveryPreference(delivery)
          && delivery.pendingUserTurnSince
          && !delivery.lastAwaitingUserNoticeAt
          && now - Date.parse(delivery.activatedAt) >= PERMANENT_MUTE_AWAITING_USER_DELAY_MS
        ) {
          enqueueOrderedConversationDelivery(chatId, async (timeoutMs) => {
            const current = getDeliveryPreferenceForChat(chatId);
            if (
              !isPermanentMuteDeliveryPreference(current)
              || !current.pendingUserTurnSince
              || current.lastAwaitingUserNoticeAt
              || Date.now() - Date.parse(current.activatedAt) < PERMANENT_MUTE_AWAITING_USER_DELAY_MS
            ) return;
            const channel = getChannelForChat(chatId);
            if (!channel) return;
            const fmt = getFormatterForChat(chatId);
            try {
              await channel.send(
                chatId,
                `${fmt.escape("⏸")} ${fmt.escape("This chat is still muted, but the session appears to be waiting for you. Use /unmute to catch up.")}`,
                { timeoutMs }
              );
            } catch {
              return;
            }
            await updateDeliveryPreferenceForChat(chatId, (latest) => (
              isPermanentMuteDeliveryPreference(latest)
                ? { ...latest, lastAwaitingUserNoticeAt: new Date().toISOString() }
                : latest
            ));
          });
        }
      }
    }
  }

  // Wire poll answer handler on all channels that support it
  for (const { channel } of channels) {
    if ("onPollAnswer" in channel) {
      channel.onPollAnswer = handlePollAnswer;
    }
  }

  const deliverySweepTimer = setInterval(() => {
    void sweepDeliveryModes();
  }, DELIVERY_SWEEP_INTERVAL_MS);
  void sweepDeliveryModes();


  // Reap orphaned remote sessions whose CLI crashed without calling /exit
  const REAP_INTERVAL = 60_000;
  const REAP_MAX_AGE = 30_000;
  const reaperTimer = setInterval(async () => {
    const reaped = sessionManager.reapStaleRemotes(REAP_MAX_AGE);
    for (const remote of reaped) {
      reconnectNoticeBySession.delete(remote.id);
      pendingApprovalBySession.delete(remote.id);
      for (const key of deliveryRuntime.keys()) {
        if (key.startsWith(`${remote.id}|`)) deliveryRuntime.delete(key);
      }
      await clearBackgroundBoards(remote.id);
      await logger.info("Reaped stale remote session", { id: remote.id, command: remote.command });
      const fmt = getFormatterForChat(remote.chatId);
      const msg = `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape(sessionLabel(remote.command, remote.cwd, remote.name)))} disconnected (CLI stopped responding)`;
      sendToChat(remote.chatId, msg);
      syncCommandMenuForChat(remote.chatId, remote.ownerUserId);
      if (remote.boundChatId && remote.boundChatId !== remote.chatId) {
        syncCommandMenuForChat(remote.boundChatId, remote.ownerUserId);
      }
    }
    if (reaped.length > 0 && sessionManager.remoteCount() === 0) {
      scheduleAutoStop();
    }
  }, REAP_INTERVAL);

  onShutdown(async () => {
    clearInterval(reaperTimer);
    clearInterval(deliverySweepTimer);
    clearInterval(backgroundBoardRefreshTimer);
    clearInterval(waitCycleMaintenanceTimer);
    for (const cycle of activeWaitCyclesBySession.values()) stopWaitCycleHeartbeats(cycle);
    if (persistStatusBoardsTimer) {
      clearTimeout(persistStatusBoardsTimer);
      persistStatusBoardsTimer = null;
    }
    await persistStatusBoardsNow();
    cancelAutoStop();
    for (const { channel } of channels) channel.stopReceiving();
    sessionManager.killAll();
  });

  await startControlServer({
    authToken: daemonAuthToken,
    startedAt: DAEMON_STARTED_AT,
    getStatus() {
      return {
        pid: process.pid,
        uptime: process.uptime(),
        sessions: sessionManager.list().map((s) => ({
          id: s.id,
          command: s.command,
          name: s.name,
          state: s.state,
          createdAt: s.createdAt,
        })),
      };
    },
    getInputNeeded() {
      return sessionManager.getInputNeeded();
    },
    async shutdown() {
      cancelAutoStop();
      clearInterval(backgroundBoardRefreshTimer);
      clearInterval(waitCycleMaintenanceTimer);
      for (const cycle of activeWaitCyclesBySession.values()) stopWaitCycleHeartbeats(cycle);
      if (persistStatusBoardsTimer) {
        clearTimeout(persistStatusBoardsTimer);
        persistStatusBoardsTimer = null;
      }
      await persistStatusBoardsNow();
      for (const { channel } of channels) channel.stopReceiving();
      sessionManager.killAll();
      await removeAuthToken();
      await removePidFile();
      await removeDaemonLock();
      await removeSocket();
      await removeControlPortFile();
      process.exit(0);
    },
    generatePairingCode() {
      return generatePairingCode();
    },
    async getChannels(): Promise<ChannelInfo[]> {
      await refreshConfig();
      const pairedUsers = getAllPairedUsers(config);
      const results: ChannelInfo[] = [];

      // DM channels: one per paired user per bot
      for (const user of pairedUsers) {
        const dmChatId = user.userId;
        const channel = getChannelForChat(dmChatId);
        let title = "DM";
        if (channel?.getBotName) {
          try { title = await channel.getBotName(); } catch {}
        }
        const bound = sessionManager.getAttachedRemote(dmChatId);
        results.push({
          chatId: dmChatId,
          title,
          type: "dm",
          busy: !!bound,
          busyLabel: bound ? sessionLabel(bound.command, bound.cwd, bound.name) : null,
        });
      }

      // Linked groups and topics
      const rawGroups = getAllLinkedGroups(config);
      for (const g of rawGroups) {
        const isTopic = parseChannelAddress(g.chatId).threadPart !== undefined;
        const bound = sessionManager.getAttachedRemote(g.chatId);
        results.push({
          chatId: g.chatId,
          title: g.title || g.chatId,
          type: isTopic ? "topic" : "group",
          busy: !!bound,
          busyLabel: bound ? sessionLabel(bound.command, bound.cwd, bound.name) : null,
        });
      }

      return results;
    },
    async registerRemote(command: string, chatId: ChannelChatId, ownerUserId: ChannelUserId, cwd: string, existingId?: string, subscribedGroups?: string[], name?: string): Promise<{ sessionId: string; dmBusy: boolean; dmBusyLabel?: string; linkedGroups: Array<{ chatId: string; title?: string }>; allLinkedGroups: Array<{ chatId: string; title?: string; busyLabel?: string }> }> {
      cancelAutoStop();
      const isReconnect = !!existingId && !sessionManager.getRemote(existingId);
      const remote = sessionManager.registerRemote(command, chatId, ownerUserId, cwd, existingId, name);
      const remoteAddress = parseChannelAddress(remote.chatId);
      const remoteType = remoteAddress.type;
      const remoteChannelName = remoteAddress.channelName;

      // Restore group subscriptions (e.g. after daemon restart, CLI re-registers with saved groups)
      if (subscribedGroups) {
        for (const groupId of subscribedGroups) {
          sessionManager.subscribeGroup(remote.id, groupId);
        }
      }

      if (isReconnect) {
        const now = Date.now();
        const lastNoticeAt = reconnectNoticeBySession.get(remote.id) ?? 0;
        if (now - lastNoticeAt >= RECONNECT_NOTICE_COOLDOWN_MS) {
          reconnectNoticeBySession.set(remote.id, now);
          const label = sessionLabel(command, cwd, name);
          const fmt = getFormatterForChat(chatId);
          const notice = `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape(label))} reconnected after daemon restart. Messages sent during restart may have been lost.`;
          void logTelegramDelivery({ category: "reconnect_notice", operation: "send", sessionId: remote.id, chatId, html: notice });
          sendToChat(chatId, notice);
        }
      }

      const existingBound = sessionManager.getAttachedRemote(chatId);
      const dmBusy = !!existingBound && existingBound.id !== remote.id;
      const dmBusyLabel = dmBusy && existingBound ? sessionLabel(existingBound.command, existingBound.cwd, existingBound.name) : undefined;

      await refreshConfig();
      const rawGroups = getAllLinkedGroups(config).filter((g) => {
        const parsedGroup = parseChannelAddress(g.chatId);
        if (parsedGroup.type !== remoteType) return false;
        if (remoteChannelName || parsedGroup.channelName) {
          return parsedGroup.channelName === remoteChannelName;
        }
        return true;
      });

      // Validate groups still exist, remove dead ones
      const validGroups: Array<{ chatId: string; title?: string }> = [];
      for (const g of rawGroups) {
        const groupChannel = getChannelForChat(g.chatId);
        if (groupChannel?.validateChat) {
          const alive = await groupChannel.validateChat(g.chatId);
          if (alive) {
            validGroups.push({ chatId: g.chatId, title: g.title });
          } else {
            await logger.info("Removing inaccessible linked group", { chatId: g.chatId, title: g.title });
            removeLinkedGroup(config, g.chatId, remoteChannelName);
            await saveConfig(config);
          }
        } else {
          validGroups.push({ chatId: g.chatId, title: g.title });
        }
      }

      const allLinkedGroups = validGroups.map((g) => {
        const bound = sessionManager.getAttachedRemote(g.chatId);
        const busyLabel = bound && bound.id !== remote.id ? sessionLabel(bound.command, bound.cwd, bound.name) : undefined;
        return { chatId: g.chatId, title: g.title, busyLabel };
      });
      const linkedGroups = allLinkedGroups.filter((g) => !g.busyLabel);

      syncCommandMenuForChat(chatId, ownerUserId);

      return { sessionId: remote.id, dmBusy, dmBusyLabel, linkedGroups, allLinkedGroups };
    },
    async bindChat(sessionId: string, chatId: ChannelChatId): Promise<{ ok: boolean; error?: string }> {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return { ok: false, error: "Session not found" };
      const isOwnerDm = remote.chatId === chatId;
      await refreshConfig();
      const isLinkedTarget = isLinkedGroup(config, chatId);
      if (!isOwnerDm && !isLinkedTarget) return { ok: false, error: "Group is not linked" };

      // Validate the chat still exists
      const targetChannel = getChannelForChat(chatId);
      if (!isOwnerDm && targetChannel?.validateChat) {
        const alive = await targetChannel.validateChat(chatId);
        if (!alive) {
          removeLinkedGroup(config, chatId, getChannelName(chatId));
          await saveConfig(config);
          return { ok: false, error: "Group no longer exists or bot was removed from it" };
        }
      }

      // Disconnect old session from this channel if taken
      const oldRemote = sessionManager.getAttachedRemote(chatId);
      if (oldRemote && oldRemote.id !== sessionId) {
        sessionManager.detach(chatId);
        syncCommandMenuForChat(chatId, oldRemote.ownerUserId);
        const fmt = getFormatterForChat(chatId);
        sendToChat(chatId, `${fmt.escape("🔄")} ${fmt.bold(fmt.escape(sessionLabel(oldRemote.command, oldRemote.cwd, oldRemote.name)))} disconnected`);
      }

      // Remove auto-attached DM if binding to a different chat
      if (remote.chatId !== chatId) {
        sessionManager.detach(remote.chatId);
        syncCommandMenuForChat(remote.chatId, remote.ownerUserId);
      }
      sessionManager.attach(chatId, sessionId);
      syncCommandMenuForChat(chatId, remote.ownerUserId);
      if (isLinkedTarget) {
        sessionManager.subscribeGroup(sessionId, chatId);
      }
      const fmt = getFormatterForChat(chatId);
      sendToChat(chatId, `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape(sessionLabel(remote.command, remote.cwd, remote.name)))} connected`);
      const activeWaitCycle = activeWaitCyclesBySession.get(sessionId);
      if (activeWaitCycle && !activeWaitCycle.finalizing) {
        const now = Date.now();
        maintainWaitCycleHeartbeat(sessionId, activeWaitCycle, now);
        activeWaitCycle.lastBoardRefreshAt = now;
        enqueueWaitCycleBoardWork(sessionId, async () => {
          if (activeWaitCyclesBySession.get(sessionId) !== activeWaitCycle || activeWaitCycle.finalizing) return;
          await refreshWaitCycleBoards(sessionId, activeWaitCycle);
        });
      }
      return { ok: true };
    },
    canUserAccessSession(userId: ChannelUserId, sessionId: string): boolean {
      return sessionManager.canUserAccessSession(userId, sessionId);
    },
    drainRemoteInput(sessionId: string): string[] {
      return sessionManager.drainRemoteInput(sessionId);
    },
    drainRemoteControl(sessionId: string) {
      return sessionManager.drainRemoteControl(sessionId);
    },
    pushRemoteInput(sessionId: string, text: string): boolean {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return false;
      if (remote.inputQueue.length >= 1000) return false; // prevent memory exhaustion
      if (text.length > 65536) text = text.slice(0, 65536); // cap per-message size at 64KB
      remote.inputQueue.push(text);
      return true;
    },
    hasRemote(sessionId: string): boolean {
      return !!sessionManager.getRemote(sessionId);
    },
    endRemote(sessionId: string, exitCode: number | null): void {
      const remote = sessionManager.getRemote(sessionId);
      if (remote) {
        reconnectNoticeBySession.delete(sessionId);
        const status = exitCode === 0 ? "disconnected" : `disconnected (code ${exitCode ?? "unknown"})`;
        void clearBackgroundBoards(sessionId);
        const activeWaitCycle = activeWaitCyclesBySession.get(sessionId);
        if (activeWaitCycle) stopWaitCycleHeartbeats(activeWaitCycle);
        const boundChat = sessionManager.getBoundChat(sessionId);
        if (boundChat) {
          const fmt = getFormatterForChat(boundChat);
          const msg = `${fmt.escape("⛳️")} ${fmt.bold(fmt.escape(sessionLabel(remote.command, remote.cwd, remote.name)))} ${fmt.escape(status)}`;
          sendToChat(boundChat, msg);
        }
        sessionManager.removeRemote(sessionId);
        syncCommandMenuForChat(remote.chatId, remote.ownerUserId);
        if (boundChat && boundChat !== remote.chatId) {
          syncCommandMenuForChat(boundChat, remote.ownerUserId);
        }
      }

      if (sessionManager.remoteCount() === 0) {
        scheduleAutoStop();
      }
    },
    getSubscribedGroups(sessionId: string): string[] {
      return sessionManager.getSubscribedGroups(sessionId);
    },
    getBoundChat(sessionId: string): string | null {
      return sessionManager.getBoundChat(sessionId);
    },
    getBackgroundJobs(sessionId: string): Array<{ taskId: string; status: string; command?: string; urls?: string[]; updatedAt: number }> {
      const jobs = backgroundJobsBySession.get(sessionId);
      if (!jobs || jobs.size === 0) return [];
      return Array.from(jobs.values()).map((j) => ({
        taskId: j.taskId,
        status: j.status,
        command: j.command,
        urls: j.urls,
        updatedAt: j.updatedAt,
      }));
    },
    getAllBackgroundJobs(cwd?: string): Array<{ sessionId: string; command: string; cwd: string; jobs: Array<{ taskId: string; status: string; command?: string; urls?: string[]; updatedAt: number }> }> {
      const results: Array<{ sessionId: string; command: string; cwd: string; jobs: Array<{ taskId: string; status: string; command?: string; urls?: string[]; updatedAt: number }> }> = [];
      for (const [sid, jobMap] of backgroundJobsBySession) {
        if (jobMap.size === 0) continue;
        const remote = sessionManager.getRemote(sid);
        if (!remote) continue;
        if (cwd && remote.cwd !== cwd) continue;
        results.push({
          sessionId: sid,
          command: remote.command,
          cwd: remote.cwd,
          jobs: Array.from(jobMap.values()).map((j) => ({
            taskId: j.taskId,
            status: j.status,
            command: j.command,
            urls: j.urls,
            updatedAt: j.updatedAt,
          })),
        });
      }
      return results;
    },
    async sendMessageToSession(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return { ok: false, error: "Session not found" };

      const targets = new Set<ChannelChatId>();
      const targetChat = sessionManager.getBoundChat(sessionId);
      if (targetChat) targets.add(targetChat);
      for (const groupChatId of sessionManager.getSubscribedGroups(sessionId)) {
        targets.add(groupChatId);
      }
      if (targets.size === 0) return { ok: false, error: "No bound channel for this session" };

      for (const cid of targets) {
        const channel = getChannelForChat(cid);
        if (!channel) {
          return { ok: false, error: `No channel available for ${cid.split(":")[0]}` };
        }
        await channel.send(cid, text);
      }
      return { ok: true };
    },
    async sendFileToSession(sessionId: string, filePath: string, caption?: string): Promise<{ ok: boolean; error?: string }> {
      try {
        const resolvedArtifact = await resolveSessionArtifactPath(sessionId, filePath);
        const targets = getConversationTargets(sessionId);
        if (targets.size === 0) return { ok: false, error: "No bound channel for this session" };

        const finalCaption = (caption && caption.trim()) || resolvedArtifact.defaultCaption;
        for (const cid of targets) {
          const channel = getChannelForChat(cid);
          if (!channel) {
            return { ok: false, error: `No channel available for ${cid.split(":")[0]}` };
          }
          if (!channel.sendDocument) {
            return { ok: false, error: `Channel ${cid.split(":")[0]} does not support file sending` };
          }
          await channel.sendDocument(cid, resolvedArtifact.filePath, finalCaption);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    stopSessionById(sessionId: string): { ok: boolean; error?: string } {
      if (sessionManager.requestRemoteStop(sessionId)) {
        stopActiveWaitCycle(sessionId);
        return { ok: true };
      }
      return { ok: false, error: "Session not found or already exited" };
    },
    killSessionById(sessionId: string): { ok: boolean; error?: string } {
      if (sessionManager.requestRemoteKill(sessionId)) {
        return { ok: true };
      }
      return { ok: false, error: "Session not found or already exited" };
    },
    restartSessionById(sessionId: string, sessionRef?: string): { ok: boolean; error?: string; sessionRef?: string } {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) {
        return { ok: false, error: "Session not found or already exited" };
      }

      let resolvedSessionRef = cleanResumeRef(sessionRef);
      if (!resolvedSessionRef) {
        const tool = detectResumableTool(remote.command);
        if (!tool) {
          return { ok: false, error: "Current session command does not support resume restart" };
        }
        resolvedSessionRef = extractResumeRefFromCommand(tool, remote.command);
        if (!resolvedSessionRef && tool === "omp") {
          resolvedSessionRef = cleanResumeRef(readSessionManifestSync(sessionId)?.jsonlFile || undefined);
        }
        if (!resolvedSessionRef) {
          return { ok: false, error: "Could not infer resume session ID; pass --session <tool_session_id>" };
        }
      }

      if (!sessionManager.requestRemoteResume(sessionId, resolvedSessionRef)) {
        return { ok: false, error: "Session not found or already exited" };
      }
      return { ok: true, sessionRef: resolvedSessionRef };
    },
    async handleConversationEvent(sessionId: string, event: ConversationEvent): Promise<void> {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return;

      if (event.kind === "question") {
        const targetChat = sessionManager.getBoundChat(sessionId);
        if (!targetChat) return;
        const parsed: AskQuestion[] = event.questions.map((q: unknown) => {
          const raw = q as Record<string, unknown>;
          const options = ((raw.options as Array<Record<string, unknown>>) || []).map((o) => ({
            label: (o.label as string) || "",
            description: o.description as string | undefined,
          }));
          return {
            question: (raw.question as string) || "",
            options,
            multiSelect: (raw.multiSelect as boolean) || false,
          };
        });
        sessionManager.setPendingQuestions(sessionId, parsed, targetChat);
        const delivery = getDeliveryPreferenceForChat(targetChat);
        if (delivery.mode !== "immediate") {
          bufferDeliveryEntry(
            sessionId,
            targetChat,
            buildBufferedDeliveryEntry(getFormatterForChat(targetChat), getOutputPreferencesForChat(targetChat), remote.cwd, event)
          );
        }
        if (delivery.mode === "mute") {
          await recordMuteUserTurn(targetChat);
          setTypingForChat(targetChat, false);
          return;
        }
        if (isThrottleDeliveryPreference(delivery)) {
          const fmt = getFormatterForChat(targetChat);
          const noticeMessage = `${fmt.escape("⏳")} ${fmt.escape(`Throttle is still active every ${formatDeliveryMinutes(delivery.intervalMinutes)}. It looks like it's your turn.`)}`;
          enqueueOrderedConversationDelivery(targetChat, async (timeoutMs) => {
            const flushed = await flushBufferedDelivery(sessionId, targetChat, { timeoutMs, noticeMessage });
            if (flushed) {
              await updateDeliveryPreferenceForChat(targetChat, (current) => (
                isThrottleDeliveryPreference(current)
                  ? { ...current, lastSummaryAt: new Date().toISOString(), pendingUserTurnSince: null }
                  : current
              ));
            }
            scheduleNextQuestionPoll(sessionId);
          });
          return;
        }
        scheduleNextQuestionPoll(sessionId);
        return;
      }

      if (event.kind === "approvalNeeded") {
        const targetChat = sessionManager.getBoundChat(sessionId);
        if (!targetChat) {
          logger.info("handleConversationEvent approvalNeeded: no bound chat", { sessionId, chatId: remote.chatId });
          return;
        }
        const question = buildApprovalQuestionText(event);
        const options = event.pollOptions && event.pollOptions.length >= 2
          ? event.pollOptions
          : ["Yes", "Yes, don't ask again", "No"];
        pendingApprovalBySession.set(sessionId, { chatId: targetChat, question, options });
        const delivery = getDeliveryPreferenceForChat(targetChat);
        if (delivery.mode !== "immediate") {
          bufferDeliveryEntry(
            sessionId,
            targetChat,
            buildBufferedDeliveryEntry(getFormatterForChat(targetChat), getOutputPreferencesForChat(targetChat), remote.cwd, event)
          );
        }
        if (delivery.mode === "mute") {
          await recordMuteUserTurn(targetChat);
          setTypingForChat(targetChat, false);
          return;
        }
        if (isThrottleDeliveryPreference(delivery)) {
          const fmt = getFormatterForChat(targetChat);
          const noticeMessage = `${fmt.escape("⏳")} ${fmt.escape(`Throttle is still active every ${formatDeliveryMinutes(delivery.intervalMinutes)}. It looks like it's your turn.`)}`;
          enqueueOrderedConversationDelivery(targetChat, async (timeoutMs) => {
            const flushed = await flushBufferedDelivery(sessionId, targetChat, { timeoutMs, noticeMessage });
            if (flushed) {
              await updateDeliveryPreferenceForChat(targetChat, (current) => (
                isThrottleDeliveryPreference(current)
                  ? { ...current, lastSummaryAt: new Date().toISOString(), pendingUserTurnSince: null }
                  : current
              ));
            }
            await sendPendingApprovalPoll(sessionId, { timeoutMs });
          });
          return;
        }
        enqueueOrderedConversationDelivery(targetChat, async (timeoutMs) => {
          await sendPendingApprovalPoll(sessionId, { timeoutMs });
        });
        return;
      }

      const targets = getConversationTargets(sessionId);
      if (targets.size === 0) return;

      let resolvedArtifact: { filePath: string; defaultCaption: string } | null = null;
      if (event.kind === "assistantFile") {
        resolvedArtifact = await resolveSessionArtifactPath(sessionId, event.filePath);
      }

      for (const cid of targets) {
        enqueueOrderedConversationDelivery(cid, async (timeoutMs) => {
          const channel = getChannelForChat(cid);
          if (!channel) throw new Error(`No channel available for ${cid.split(":")[0]}`);
          const output = getOutputPreferencesForChat(cid);
          const fmt = getFormatterForChat(cid);
          const delivery = getDeliveryPreferenceForChat(cid);

          if (delivery.mode !== "immediate") {
            bufferDeliveryEntry(sessionId, cid, buildBufferedDeliveryEntry(fmt, output, remote.cwd, event));
            if (event.kind === "assistant" || event.kind === "assistantFile") {
              setTypingForChat(cid, false);
            }
            return;
          }

          if (event.kind === "assistant") {
            setTypingForChat(cid, false);
            await sendOrderedConversationHtml(sessionId, cid, channel, fmt.fromMarkdown(event.text), timeoutMs, "assistant");
            return;
          }

          if (event.kind === "thinking") {
            const message = formatThinkingNotification(fmt, output.thinkingMode, event.text);
            if (!message) return;
            await sendOrderedConversationHtml(sessionId, cid, channel, message, timeoutMs, "thinking");
            return;
          }

          if (event.kind === "toolCall") {
            if (output.toolCallMode === "off") return;
            const detailMode = output.toolCallMode === "detailed" ? "verbose" : "simple";
            const html = formatToolCall(fmt, event.name, event.input, detailMode, remote.cwd);
            if (!html) return;
            await sendOrderedConversationHtml(sessionId, cid, channel, html, timeoutMs, `tool_call:${event.name}`);
            setTypingForChat(cid, true);
            return;
          }

          if (event.kind === "toolResult") {
            const message = formatToolResultNotification(fmt, output, event.toolName, event.content, event.isError === true);
            if (!message) return;
            await sendOrderedConversationHtml(sessionId, cid, channel, message, timeoutMs, `tool_result:${event.toolName}`);
            if (event.isError !== true) setTypingForChat(cid, true);
            return;
          }

          if (event.kind === "assistantFile") {
            if (!resolvedArtifact) throw new Error("Resolved artifact path missing");
            if (!channel.sendDocument) throw new Error(`Channel ${cid.split(":")[0]} does not support file sending`);
            setTypingForChat(cid, false);
            const caption = (event.caption && event.caption.trim()) || resolvedArtifact.defaultCaption;
            await sendOrderedConversationDocument(sessionId, cid, channel, resolvedArtifact.filePath, caption, timeoutMs);
          }
        });
      }
    },
    handleLocalPromptSubmit(sessionId: string): void {
      handleLocalPromptSubmit(sessionId);
    },
    handleTyping(sessionId: string, active: boolean): void {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return;

      const targets = getConversationTargets(sessionId);
      if (targets.size === 0) return;

      for (const cid of targets) {
        if (getDeliveryPreferenceForChat(cid).mode !== "immediate") {
          if (!active) setTypingForChat(cid, false);
          continue;
        }
        setTypingForChat(cid, active);
      }
    },
    handleBackgroundJob(
      sessionId: string,
      event: BackgroundJobEvent
    ): void {
      const remote = sessionManager.getRemote(sessionId);
      if (!remote) return;
      const status = normalizeBackgroundStatus(event.status);
      if (!status) return;
      if (!event.taskId) return;

      if (status === "running") {
        const sessionJobs = backgroundJobsBySession.get(sessionId) || new Map<string, BackgroundJobState>();
        const existing = sessionJobs.get(event.taskId);
        const mergedUrls = mergeUrls(
          existing?.urls,
          mergeUrls(event.urls, inferUrlsFromCommand(event.command || existing?.command))
        );
        sessionJobs.set(event.taskId, {
          taskId: event.taskId,
          status,
          command: event.command || existing?.command,
          outputFile: event.outputFile || existing?.outputFile,
          summary: event.summary || existing?.summary,
          urls: mergedUrls,
          updatedAt: Date.now(),
        });
        backgroundJobsBySession.set(sessionId, sessionJobs);
        if (!existing) {
          announceBackgroundJobEvent(sessionId, status, {
            taskId: event.taskId,
            command: event.command,
            summary: event.summary,
            urls: mergedUrls,
          });
        }
      } else {
        const sessionJobs = backgroundJobsBySession.get(sessionId);
        const existing = sessionJobs?.get(event.taskId);
        sessionJobs?.delete(event.taskId);
        if (sessionJobs && sessionJobs.size === 0) {
          backgroundJobsBySession.delete(sessionId);
        }
        announceBackgroundJobEvent(sessionId, status, {
          taskId: event.taskId,
          command: event.command || existing?.command,
          summary: event.summary || existing?.summary,
          urls: mergeUrls(
            existing?.urls,
            mergeUrls(event.urls, inferUrlsFromCommand(event.command || existing?.command))
          ),
        });
      }

      void refreshBackgroundBoards(sessionId);
    },

    handleWaitState(sessionId: string, event: WaitStateEvent): void {
      if (!sessionManager.getRemote(sessionId)) return;
      const now = Date.now();
      const { cycle, shouldFinalize } = handleWaitStateForSessionState(
        activeWaitCyclesBySession,
        sessionId,
        event,
        () => createWaitCycle(sessionId),
        now
      );
      maintainWaitCycleHeartbeat(sessionId, cycle, now);
      if (shouldFinalize) {
        activeWaitCyclesBySession.delete(sessionId);
        enqueueWaitCycleBoardWork(sessionId, async () => {
          await finalizeWaitCycleBoards(sessionId, cycle);
        });
        return;
      }
      cycle.lastBoardRefreshAt = now;
      enqueueWaitCycleBoardWork(sessionId, async () => {
        if (activeWaitCyclesBySession.get(sessionId) !== cycle || cycle.finalizing) return;
        await refreshWaitCycleBoards(sessionId, cycle);
      });
    },

    // --- Config channel management ---
    async getConfigChannels(): Promise<ConfigChannelSummary[]> {
      await refreshConfig();
      const results: ConfigChannelSummary[] = [];
      for (const [name, ch] of Object.entries(config.channels)) {
        let botUsername: string | undefined;
        let botFirstName: string | undefined;
        if (ch.type === "telegram") {
          const token = getTelegramBotToken(config, name);
          if (token) {
            try {
              const me = await new TelegramApi(token).getMe();
              botUsername = me.username;
              botFirstName = me.first_name;
            } catch {}
          }
        } else if (ch.type === "slack") {
          const creds = ch.credentials as Record<string, unknown>;
          botUsername = (creds.botName as string) || undefined;
          botFirstName = (creds.teamName as string) || undefined;
        }
        results.push({
          name,
          type: ch.type,
          botUsername,
          botFirstName,
          pairedUserCount: ch.pairedUsers.length,
          linkedGroupCount: (ch.linkedGroups || []).length,
        });
      }
      return results;
    },
    async getChannelDetails(name: string): Promise<{ ok: boolean; error?: string; channel?: ConfigChannelDetails }> {
      await refreshConfig();
      const ch = config.channels[name];
      if (!ch) return { ok: false, error: "Channel not found" };
      let botUsername: string | undefined;
      if (ch.type === "telegram") {
        const token = getTelegramBotToken(config, name);
        if (token) {
          try {
            const me = await new TelegramApi(token).getMe();
            botUsername = me.username;
          } catch {}
        }
      } else if (ch.type === "slack") {
        botUsername = (ch.credentials as Record<string, unknown>).botName as string || undefined;
      }
      return {
        ok: true,
        channel: {
          name,
          type: ch.type,
          botUsername,
          pairedUsers: ch.pairedUsers.map((u) => ({ userId: u.userId, username: u.username, pairedAt: u.pairedAt })),
          linkedGroups: (ch.linkedGroups || []).map((g) => ({ chatId: g.chatId, title: g.title, linkedAt: g.linkedAt })),
        },
      };
    },
    async addChannel(name: string, type: string, botToken: string, extraCredentials?: Record<string, string>): Promise<{ ok: boolean; error?: string; botUsername?: string; botFirstName?: string; needsRestart?: boolean }> {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
        return { ok: false, error: "Invalid channel name. Must be lowercase alphanumeric, starting with a letter (max 64 chars)" };
      }
      if (type !== "telegram" && type !== "slack") {
        return { ok: false, error: `Unsupported channel type: ${type}. Use "telegram" or "slack".` };
      }
      await refreshConfig();
      if (config.channels[name]) {
        return { ok: false, error: `Channel "${name}" already exists` };
      }
      // Validate bot token
      let botUsername: string | undefined;
      let botFirstName: string | undefined;
      const credentials: Record<string, unknown> = { botToken };
      if (type === "telegram") {
        try {
          const me = await new TelegramApi(botToken).getMe();
          botUsername = me.username;
          botFirstName = me.first_name;
        } catch (e) {
          return { ok: false, error: `Invalid bot token: ${(e as Error).message}` };
        }
      } else if (type === "slack") {
        const appToken = extraCredentials?.appToken;
        if (!appToken) {
          return { ok: false, error: "Slack channels require an appToken for Socket Mode" };
        }
        credentials.appToken = appToken;
        try {
          const { SlackApi } = await import("../channels/slack/api");
          const api = new SlackApi(botToken);
          const auth = await api.authTest();
          botUsername = auth.user;
          botFirstName = auth.team;
          credentials.botUserId = auth.user_id;
          credentials.botName = auth.user;
          credentials.teamId = auth.team_id;
          credentials.teamName = auth.team;
        } catch (e) {
          return { ok: false, error: `Invalid Slack bot token: ${(e as Error).message}` };
        }
      }
      config.channels[name] = {
        type,
        credentials,
        pairedUsers: [],
        linkedGroups: [],
      };
      await saveConfig(config);
      return { ok: true, botUsername, botFirstName, needsRestart: true };
    },
    async removeChannel(name: string): Promise<{ ok: boolean; error?: string; needsRestart?: boolean }> {
      await refreshConfig();
      const ch = config.channels[name];
      if (!ch) {
        return { ok: false, error: "Channel not found" };
      }
      // Check if any active sessions are using this channel
      const sessions = sessionManager.list();
      for (const s of sessions) {
        const remote = sessionManager.getRemote(s.id);
        if (remote) {
          const parsed = parseChannelAddress(remote.chatId);
          // Match scoped addresses (telegram:botname:123) or unscoped (telegram:123)
          // where the channel is the default for that type
          const usesThisChannel =
            parsed.channelName === name ||
            (!parsed.channelName && parsed.type === ch.type);
          if (usesThisChannel) {
            return { ok: false, error: `Cannot remove channel: active session ${s.id} is using it` };
          }
        }
      }
      delete config.channels[name];
      await saveConfig(config);
      return { ok: true, needsRestart: true };
    },
    async removePairedUser(channelName: string, userId: string): Promise<{ ok: boolean; error?: string }> {
      await refreshConfig();
      const ch = config.channels[channelName];
      if (!ch) return { ok: false, error: "Channel not found" };
      const idx = ch.pairedUsers.findIndex((u) => u.userId === userId);
      if (idx < 0) return { ok: false, error: "Paired user not found" };
      ch.pairedUsers.splice(idx, 1);
      await saveConfig(config);
      return { ok: true };
    },
    async addLinkedGroupApi(channelName: string, chatId: string, title?: string): Promise<{ ok: boolean; error?: string }> {
      await refreshConfig();
      const ch = config.channels[channelName];
      if (!ch) return { ok: false, error: "Channel not found" };
      const added = addLinkedGroup(config, chatId, title, channelName);
      if (!added) return { ok: false, error: "Group already linked or channel type mismatch" };
      await saveConfig(config);
      return { ok: true };
    },
    async removeLinkedGroupApi(channelName: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
      await refreshConfig();
      const ch = config.channels[channelName];
      if (!ch) return { ok: false, error: "Channel not found" };
      const removed = removeLinkedGroup(config, chatId, channelName);
      if (!removed) return { ok: false, error: "Linked group not found" };
      await saveConfig(config);
      return { ok: true };
    },
    getInternalChannel() {
      return internalChannel;
    },
  });

  // Start receiving on all channels
  for (const { name: channelName, channel } of channels) {
    void channel.startReceiving(async (msg) => {
      await refreshConfig();
      await routeMessage(msg, {
        config,
        channelName,
        sessionManager,
        channel,
        listBackgroundJobs: listBackgroundJobsForUserChat,
      });
    }).catch(async (error: unknown) => {
      await logger.error("Channel receiver stopped", {
        channel: channelName,
        type: channel.type,
        error: (error as Error)?.message ?? String(error),
      });
    });
  }

  syncKnownCommandMenus();

  await logger.info("Daemon started successfully");
}
