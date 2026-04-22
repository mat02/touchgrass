export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string; icon_color: number; icon_custom_emoji_id?: string };
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string };
}

export interface TelegramPoll {
  id: string;
  question: string;
  options: Array<{ text: string; voter_count: number }>;
  is_closed: boolean;
}

export interface TelegramPollAnswer {
  poll_id: string;
  user: TelegramUser;
  option_ids: number[];
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export type TelegramBotCommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "all_group_chats" }
  | { type: "all_chat_administrators" }
  | { type: "chat"; chat_id: number }
  | { type: "chat_administrators"; chat_id: number }
  | { type: "chat_member"; chat_id: number; user_id: number };

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  poll_answer?: TelegramPollAnswer;
  callback_query?: TelegramCallbackQuery;
}

interface ApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export type TelegramApiErrorKind = "timeout" | "http" | "api";

export class TelegramApiError extends Error {
  readonly kind: TelegramApiErrorKind;
  readonly method: string;
  readonly status?: number;
  readonly description?: string;
  readonly timeoutMs?: number;

  constructor(
    kind: TelegramApiErrorKind,
    method: string,
    message: string,
    options?: { status?: number; description?: string; timeoutMs?: number }
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.kind = kind;
    this.method = method;
    this.status = options?.status;
    this.description = options?.description;
    this.timeoutMs = options?.timeoutMs;
  }
}

export function isTelegramApiError(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError;
}

export function isTelegramTextTooLongError(error: unknown): boolean {
  if (error instanceof TelegramApiError) {
    const description = `${error.description || ""} ${error.message}`.toLowerCase();
    return description.includes("message is too long") || description.includes("text is too long");
  }
  const text = (error as Error | undefined)?.message?.toLowerCase?.() || "";
  return text.includes("message is too long") || text.includes("text is too long");
}

export class TelegramApi {
  private baseUrl: string;
  private static readonly DEFAULT_TIMEOUT_MS = 15000;

  constructor(private token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: params ? JSON.stringify(params) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TelegramApiError("timeout", method, `Telegram API ${method} timed out after ${timeoutMs}ms`, { timeoutMs });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const body = (await res.json()) as ApiResponse<T>;
      const retryAfter = body.parameters?.retry_after ?? 5;
      await Bun.sleep(retryAfter * 1000);
      return this.call(method, params, timeoutMs);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new TelegramApiError("http", method, `Telegram API ${method} failed (${res.status}): ${body}`, { status: res.status, description: body });
    }

    const body = (await res.json()) as ApiResponse<T>;
    if (!body.ok) {
      throw new TelegramApiError("api", method, `Telegram API ${method}: ${body.description}`, { description: body.description });
    }
    return body.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "poll_answer", "callback_query"],
    }, Math.max((timeout + 10) * 1000, TelegramApi.DEFAULT_TIMEOUT_MS));
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode: "HTML" | "MarkdownV2" | "" = "HTML",
    messageThreadId?: number,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, timeoutMs);
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    scope?: TelegramBotCommandScope,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<true> {
    return this.call<true>("setMyCommands", { commands, ...(scope ? { scope } : {}) }, timeoutMs);
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId });
  }

  getFileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
  }

  async getChat(chatId: number): Promise<TelegramChat> {
    return this.call<TelegramChat>("getChat", { chat_id: chatId });
  }

  async sendChatAction(chatId: number, action: string, messageThreadId?: number): Promise<boolean> {
    return this.call<boolean>("sendChatAction", {
      chat_id: chatId,
      action,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    parseMode: "HTML" | "MarkdownV2" | "" = "HTML",
    messageThreadId?: number
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
  }

  async sendPoll(
    chatId: number,
    question: string,
    options: string[],
    allowsMultipleAnswers = false,
    isAnonymous = false,
    messageThreadId?: number,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendPoll", {
      chat_id: chatId,
      question,
      options: options.map((text) => ({ text })),
      allows_multiple_answers: allowsMultipleAnswers,
      is_anonymous: isAnonymous,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, timeoutMs);
  }

  async sendDocument(
    chatId: number,
    filePath: string,
    caption?: string,
    messageThreadId?: number,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<TelegramMessage> {
    const file = Bun.file(filePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("document", file, filePath.split("/").pop() || "file");
    if (caption) formData.append("caption", caption);
    if (messageThreadId) formData.append("message_thread_id", String(messageThreadId));

    const url = `${this.baseUrl}/sendDocument`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body: formData, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TelegramApiError("timeout", "sendDocument", `Telegram API sendDocument timed out after ${timeoutMs}ms`, { timeoutMs });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const body = (await res.json()) as ApiResponse<TelegramMessage>;
      const retryAfter = body.parameters?.retry_after ?? 5;
      await Bun.sleep(retryAfter * 1000);
      return this.sendDocument(chatId, filePath, caption, messageThreadId, timeoutMs);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new TelegramApiError("http", "sendDocument", `Telegram API sendDocument failed (${res.status}): ${body}`, { status: res.status, description: body });
    }

    const body = (await res.json()) as ApiResponse<TelegramMessage>;
    if (!body.ok) {
      throw new TelegramApiError("api", "sendDocument", `Telegram API sendDocument: ${body.description}`, { description: body.description });
    }
    return body.result;
  }

  async stopPoll(chatId: number, messageId: number): Promise<TelegramPoll> {
    return this.call<TelegramPoll>("stopPoll", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async sendInlineKeyboard(
    chatId: number,
    text: string,
    buttons: TelegramInlineKeyboardButton[][],
    messageThreadId?: number,
    timeoutMs: number = TelegramApi.DEFAULT_TIMEOUT_MS
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, timeoutMs);
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: Record<string, unknown> | null
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  async pinChatMessage(chatId: number, messageId: number, disableNotification = true): Promise<boolean> {
    return this.call<boolean>("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: disableNotification,
    });
  }

  async unpinChatMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("unpinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }
}
