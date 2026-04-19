import { describe, expect, it, mock } from "bun:test";
import { TelegramChannel, __telegramChannelTestUtils } from "../channels/telegram/channel";
import { stat, unlink } from "fs/promises";

describe("TelegramChannel actions", () => {
  it("uses inline keyboard for single-select actions and clears keyboard on close", async () => {
    const calls: string[] = [];
    const channel = new TelegramChannel("bot-token");
    const anyChannel = channel as unknown as {
      api: {
        sendInlineKeyboard: (
          chatId: number,
          text: string,
          buttons: Array<Array<{ text: string; callback_data: string }>>,
          threadId?: number
        ) => Promise<{ message_id: number }>;
        sendPoll: (...args: unknown[]) => Promise<unknown>;
        editMessageReplyMarkup: (chatId: number, messageId: number, markup: Record<string, unknown>) => Promise<void>;
        stopPoll: (chatId: number, messageId: number) => Promise<void>;
      };
    };

    anyChannel.api = {
      sendInlineKeyboard: async (_chatId, _text, buttons) => {
        calls.push("sendInlineKeyboard");
        expect(buttons).toHaveLength(2);
        expect(buttons[0]?.[0]?.callback_data).toMatch(/^tgp:/);
        return { message_id: 123 };
      },
      sendPoll: async () => {
        calls.push("sendPoll");
        return { message_id: 999, poll: { id: "tg-real-poll" } };
      },
      editMessageReplyMarkup: async () => {
        calls.push("editMessageReplyMarkup");
      },
      stopPoll: async () => {
        calls.push("stopPoll");
      },
    };

    const sent = await channel.sendPoll("telegram:100", "Proceed?", ["Yes", "No"], false);
    expect(sent.messageId).toBe("123");
    expect(sent.pollId).toMatch(/^tgp-/);
    expect(calls).toEqual(["sendInlineKeyboard"]);

    await channel.closePoll("telegram:100", "123");
    expect(calls).toEqual(["sendInlineKeyboard", "editMessageReplyMarkup"]);
  });

  it("uses native Telegram polls for multi-select actions", async () => {
    const calls: string[] = [];
    const channel = new TelegramChannel("bot-token");
    const anyChannel = channel as unknown as {
      api: {
        sendInlineKeyboard: (...args: unknown[]) => Promise<unknown>;
        sendPoll: (chatId: number, question: string, options: string[], multiSelect: boolean) => Promise<{
          message_id: number;
          poll: { id: string };
        }>;
      };
    };

    anyChannel.api = {
      sendInlineKeyboard: async () => {
        calls.push("sendInlineKeyboard");
        return { message_id: 1 };
      },
      sendPoll: async () => {
        calls.push("sendPoll");
        return { message_id: 456, poll: { id: "tg-native-poll" } };
      },
    };

    const sent = await channel.sendPoll("telegram:100", "Pick many", ["A", "B"], true);
    expect(sent).toEqual({ pollId: "tg-native-poll", messageId: "456" });
    expect(calls).toEqual(["sendPoll"]);
  });

  it("detects polling conflict errors from Telegram 409 responses", () => {
    const channel = new TelegramChannel("bot-token");
    const anyChannel = channel as unknown as { isPollingConflictError: (error: unknown) => boolean };

    expect(
      anyChannel.isPollingConflictError(
        new Error(
          "Telegram API getUpdates failed (409): {\"ok\":false,\"error_code\":409,\"description\":\"Conflict: terminated by other getUpdates request\"}"
        )
      )
    ).toBe(true);

    expect(anyChannel.isPollingConflictError(new Error("Telegram API getUpdates timed out after 40000ms"))).toBe(false);
    expect(anyChannel.isPollingConflictError(new Error("Something else failed"))).toBe(false);
  });
});

describe("Telegram command menus", () => {
  it("builds context-aware command lists", () => {
    const names = (cmds: Array<{ command: string }>) => cmds.map((c) => c.command);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: false,
      isGroup: false,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    }))).toEqual(["pair"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: false,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    }))).toEqual(["start_remote_control"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: false,
      isLinkedGroup: false,
      hasActiveSession: true,
      isMuted: false,
    }))).toEqual(["stop_remote_control", "change_session", "session", "name", "throttle", "output_mode", "mute", "skills"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: true,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    }))).toEqual(["start_remote_control", "link"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: true,
      isLinkedGroup: false,
      hasActiveSession: true,
      isMuted: false,
    }))).toEqual(["start_remote_control", "link"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: true,
      isLinkedGroup: true,
      hasActiveSession: false,
      isMuted: false,
    }))).toEqual(["start_remote_control"]);

    expect(names(__telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: true,
      isLinkedGroup: true,
      hasActiveSession: true,
      isMuted: true,
    }))).toEqual(["stop_remote_control", "change_session", "session", "name", "throttle", "output_mode", "unmute", "skills"]);
  });


  it("uses distinct delivery and formatting descriptions", () => {
    const commands = __telegramChannelTestUtils.buildCommandMenu({
      isPaired: true,
      isGroup: false,
      isLinkedGroup: false,
      hasActiveSession: true,
      isMuted: false,
    });

    expect(commands.find((command) => command.command === "throttle")?.description).toBe("Timed summary delivery");
    expect(commands.find((command) => command.command === "mute")?.description).toBe("Timed or permanent silence");
    expect(commands.find((command) => command.command === "output_mode")?.description).toBe("Transcript formatting");
  });

  it("syncs chat-member command menu and skips duplicate updates", async () => {
    const channel = new TelegramChannel("bot-token");
    const calls: Array<{ commands: string[]; scope: { type: string; chat_id: number; user_id: number } }> = [];
    const anyChannel = channel as unknown as {
      api: {
        setMyCommands: (
          commands: Array<{ command: string; description: string }>,
          scope?: { type: string; chat_id: number; user_id: number }
        ) => Promise<true>;
      };
    };

    anyChannel.api = {
      setMyCommands: async (commands, scope) => {
        calls.push({
          commands: commands.map((c) => c.command),
          scope: scope as { type: string; chat_id: number; user_id: number },
        });
        return true;
      },
    };

    await channel.syncCommandMenu?.({
      userId: "telegram:7",
      chatId: "telegram:-100:4",
      isPaired: true,
      isGroup: true,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    });
    await channel.syncCommandMenu?.({
      userId: "telegram:7",
      chatId: "telegram:-100:4",
      isPaired: true,
      isGroup: true,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.commands).toEqual(["start_remote_control", "link"]);
    expect(calls[0]?.scope).toEqual({
      type: "chat_member",
      chat_id: -100,
      user_id: 7,
    });

    await channel.syncCommandMenu?.({
      userId: "telegram:7",
      chatId: "telegram:-100:4",
      isPaired: true,
      isGroup: true,
      isLinkedGroup: true,
      hasActiveSession: true,
      isMuted: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.commands).toEqual(["stop_remote_control", "change_session", "session", "name", "throttle", "output_mode", "mute", "skills"]);
  });

  it("uses chat scope for DM command menu sync", async () => {
    const channel = new TelegramChannel("bot-token");
    const calls: Array<{ commands: string[]; scope: { type: string; chat_id: number; user_id?: number } }> = [];
    const anyChannel = channel as unknown as {
      api: {
        setMyCommands: (
          commands: Array<{ command: string; description: string }>,
          scope?: { type: string; chat_id: number; user_id?: number }
        ) => Promise<true>;
      };
    };

    anyChannel.api = {
      setMyCommands: async (commands, scope) => {
        calls.push({
          commands: commands.map((c) => c.command),
          scope: scope as { type: string; chat_id: number; user_id?: number },
        });
        return true;
      },
    };

    await channel.syncCommandMenu?.({
      userId: "telegram:7",
      chatId: "telegram:7",
      isPaired: true,
      isGroup: false,
      isLinkedGroup: false,
      hasActiveSession: false,
      isMuted: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.commands).toEqual(["start_remote_control"]);
    expect(calls[0]?.scope).toEqual({
      type: "chat",
      chat_id: 7,
    });
  });
});

describe("TelegramChannel media groups", () => {
  it("coalesces album items into one inbound message with both file paths", async () => {
    const channel = new TelegramChannel("bot-token");
    const anyChannel = channel as unknown as {
      api: {
        getMe: () => Promise<{ id: number; username: string }>;
        setMyCommands: () => Promise<true>;
        getUpdates: () => Promise<Array<{ update_id: number; message?: any }>>;
        getFile: (fileId: string) => Promise<{ file_id: string; file_unique_id: string; file_path: string }>;
        getFileUrl: (filePath: string) => string;
      };
      acquirePollerLock: () => Promise<void>;
      releasePollerLock: () => Promise<void>;
      cleanupOldUploads: () => Promise<void>;
    };

    anyChannel.acquirePollerLock = async () => {};
    anyChannel.releasePollerLock = async () => {};
    anyChannel.cleanupOldUploads = async () => {};

    let pollCount = 0;
    anyChannel.api = {
      getMe: async () => ({ id: 99, username: "bot" }),
      setMyCommands: async () => true,
      getUpdates: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return [
            {
              update_id: 1,
              message: {
                message_id: 101,
                media_group_id: "album-1",
                chat: { id: -100, type: "group", title: "Ops" },
                from: { id: 7, is_bot: false, first_name: "Dev", username: "dev" },
                date: 1,
                caption: "release notes",
                photo: [
                  { file_id: "img-1", file_unique_id: "img-1", width: 10, height: 10 },
                ],
              },
            },
            {
              update_id: 2,
              message: {
                message_id: 102,
                media_group_id: "album-1",
                chat: { id: -100, type: "group", title: "Ops" },
                from: { id: 7, is_bot: false, first_name: "Dev", username: "dev" },
                date: 1,
                photo: [
                  { file_id: "img-2", file_unique_id: "img-2", width: 10, height: 10 },
                ],
              },
            },
          ];
        }

        if (pollCount === 2) {
          await Bun.sleep(1250);
          channel.stopReceiving();
        }
        return [];
      },
      getFile: async (fileId: string) => ({
        file_id: fileId,
        file_unique_id: fileId,
        file_path: `photos/${fileId}.jpg`,
      }),
      getFileUrl: (filePath: string) => `https://files.example/${filePath}`,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;

    const received: Array<{ text: string; fileUrls?: string[] }> = [];
    try {
      await channel.startReceiving(async (msg) => {
        received.push({ text: msg.text, fileUrls: msg.fileUrls });
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(received).toHaveLength(1);
    const inbound = received[0];
    expect(inbound.fileUrls).toHaveLength(2);
    expect(inbound.text).toContain("release notes");
    expect(inbound.text).toContain(inbound.fileUrls![0]);
    expect(inbound.text).toContain(inbound.fileUrls![1]);

    await stat(inbound.fileUrls![0]);
    await stat(inbound.fileUrls![1]);
    await unlink(inbound.fileUrls![0]);
    await unlink(inbound.fileUrls![1]);
  });
});
