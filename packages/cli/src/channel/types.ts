import type { Formatter } from "./formatter";
import { getParentChannelChatId, isTopicChatId } from "./id";

// Tagged string IDs:
// Legacy: "telegram:123456"
// Scoped: "telegram:bot_a:123456"
export type ChannelUserId = string;
export type ChannelChatId = string;

export interface InboundMessage {
  userId: ChannelUserId;
  chatId: ChannelChatId;
  username?: string;
  text: string;
  fileUrls?: string[]; // resolved attachment URLs
  isGroup?: boolean; // true if message came from a group/channel
  chatTitle?: string; // group/channel title
  topicTitle?: string; // forum topic title (if detectable)
}

export interface PollResult {
  pollId: string;
  messageId: string;
}

export interface StatusBoardOptions {
  pin?: boolean;
  messageId?: string;
  pinned?: boolean;
}

export interface ClearStatusBoardOptions {
  unpin?: boolean;
  messageId?: string;
  pinned?: boolean;
}

export type StatusBoardFailureCode = "timeout" | "text_too_long" | "telegram_error";

export interface StatusBoardResult {
  messageId?: string;
  pinned?: boolean;
  pinError?: string;
  action?: "sent" | "edited" | "unchanged" | "cleared" | "failed";
  failureCode?: StatusBoardFailureCode;
  error?: string;
}


export interface CommandMenuContext {
  userId: ChannelUserId;
  chatId: ChannelChatId;
  isPaired: boolean;
  isGroup: boolean;
  isLinkedGroup: boolean;
  hasActiveSession: boolean;
  isMuted: boolean;
}

export type PollAnswerHandler = (answer: {
  pollId: string;
  userId: ChannelUserId;
  optionIds: number[];
}) => void;

export interface ChannelSendOptions {
  timeoutMs?: number;
}

export interface Channel {
  readonly type: string;
  readonly fmt: Formatter;
  send(chatId: ChannelChatId, html: string, options?: ChannelSendOptions): Promise<void>;
  sendOutput(chatId: ChannelChatId, rawOutput: string): Promise<void>;
  sendDocument?(chatId: ChannelChatId, filePath: string, caption?: string, options?: ChannelSendOptions): Promise<void>;
  clearLastMessage(chatId: ChannelChatId): void;
  startReceiving(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  stopReceiving(): void;
  setTyping(chatId: ChannelChatId, active: boolean): void;
  // Callback for permanent send failures (chat deleted, bot removed, etc.)
  onDeadChat?: ((chatId: ChannelChatId, error: Error) => void) | null;
  // Optional capabilities — not all channels support these
  sendPoll?(chatId: ChannelChatId, question: string, options: string[], multiSelect: boolean, sendOptions?: ChannelSendOptions): Promise<PollResult>;
  closePoll?(chatId: ChannelChatId, messageId: string): Promise<void>;
  editMessage?(chatId: ChannelChatId, messageId: string, html: string): Promise<void>;
  upsertStatusBoard?(
    chatId: ChannelChatId,
    boardKey: string,
    html: string,
    options?: StatusBoardOptions
  ): Promise<StatusBoardResult | void>;
  clearStatusBoard?(
    chatId: ChannelChatId,
    boardKey: string,
    options?: ClearStatusBoardOptions
  ): Promise<StatusBoardResult | void>;
  syncCommandMenu?(ctx: CommandMenuContext): Promise<void>;
  onPollAnswer?: PollAnswerHandler | null;
  validateChat?(chatId: ChannelChatId): Promise<boolean>;
  getBotName?(): Promise<string>;
}

export function isTopic(chatId: ChannelChatId): boolean {
  return isTopicChatId(chatId);
}

export function getParentChatId(chatId: ChannelChatId): ChannelChatId {
  return getParentChannelChatId(chatId);
}
