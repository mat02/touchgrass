import { describe, expect, it } from "bun:test";
import { __daemonTestUtils } from "../daemon/index";
import { DEFAULT_CHAT_OUTPUT_PREFERENCES } from "../config/schema";

const fmt = {
  bold: (value: string) => `<b>${value}</b>`,
  italic: (value: string) => `<i>${value}</i>`,
  code: (value: string) => `<code>${value}</code>`,
  pre: (value: string) => `<pre>${value}</pre>`,
  link: (value: string) => value,
  escape: (value: string) => value,
  fromMarkdown: (value: string) => value,
};

describe("daemon output controls", () => {
  it("truncates thinking in preview mode and preserves full mode", () => {
    const preview = __daemonTestUtils.formatThinkingNotification(fmt, "preview", "x".repeat(260));
    const full = __daemonTestUtils.formatThinkingNotification(fmt, "full", "full thinking");

    expect(preview).toContain("💭");
    expect(preview).toContain("<i>");
    expect(preview).toContain("...");
    expect(full).toContain("full thinking");
    expect(__daemonTestUtils.formatThinkingNotification(fmt, "off", "hidden")).toBeNull();
  });

  it("suppresses normal tool results when tool result mode is off", () => {
    const rendered = __daemonTestUtils.formatToolResultNotification(
      fmt,
      { toolResultMode: "off", toolErrors: true },
      "WebFetch",
      "https://touchgrass.sh",
      false
    );

    expect(rendered).toBeNull();
  });

  it("shows compact success summaries when enabled", () => {
    const rendered = __daemonTestUtils.formatToolResultNotification(
      fmt,
      { toolResultMode: "compact", toolErrors: true },
      "WebFetch",
      "https://touchgrass.sh/docs\nFetched successfully",
      false
    );

    expect(rendered).toContain("WebFetch result");
    expect(rendered).toContain("touchgrass.sh/docs Fetched successfully");
    expect(rendered).not.toContain("<pre>");
  });

  it("shows full successful results in preformatted blocks", () => {
    const rendered = __daemonTestUtils.formatToolResultNotification(
      fmt,
      { ...DEFAULT_CHAT_OUTPUT_PREFERENCES, toolResultMode: "full" },
      "bash",
      "echo hi\nhi",
      false
    );

    expect(rendered).toContain("<b>Output</b>");
    expect(rendered).toContain("<pre>echo hi\nhi</pre>");
  });

  it("keeps tool errors independent from normal tool result mode", () => {
    const hidden = __daemonTestUtils.formatToolResultNotification(
      fmt,
      { toolResultMode: "off", toolErrors: false },
      "Read",
      "permission denied",
      true
    );
    const shown = __daemonTestUtils.formatToolResultNotification(
      fmt,
      { toolResultMode: "off", toolErrors: true },
      "Read",
      "permission denied",
      true
    );

    expect(hidden).toBeNull();
    expect(shown).toContain("Read error");
    expect(shown).toContain("permission denied");
  });

  it("builds replay output with separate last assistant message when assistant is outside recent slice", () => {
    const rawLines: string[] = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "assistant message outside recent slice" }] },
      }),
    ];
    for (let i = 0; i < 12; i++) {
      rawLines.push(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: `user ${i}` }] },
        })
      );
    }

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, rawLines.join("\n"), 2);

    expect(replay.summaryMessage).toContain("📋 Recent activity:");
    expect(replay.summaryMessage).toContain("<b>[User]</b> user 10");
    expect(replay.summaryMessage).toContain("<b>[User]</b> user 11");
    expect(replay.summaryMessage).not.toContain("assistant message outside recent slice");
    expect(replay.assistantMessage).toBe("🤖 <b>[Assistant]</b> assistant message outside recent slice");
  });

  it("omits the last assistant entry from summary when it is inside the recent slice", () => {
    const raw = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "older assistant" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "latest user" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "latest assistant" }] } }),
    ].join("\n");

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, raw, 3);

    expect(replay.summaryMessage).toContain("📋 Recent activity:");
    expect(replay.summaryMessage).toContain("<b>[Assistant]</b> older assistant");
    expect(replay.summaryMessage).toContain("<b>[User]</b> latest user");
    expect(replay.summaryMessage).not.toContain("latest assistant");
    expect(replay.assistantMessage).toBe("🤖 <b>[Assistant]</b> latest assistant");
  });

  it("returns full last assistant text without helper truncation", () => {
    const longAssistantText = "A".repeat(1600);
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "u1" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: longAssistantText }] } }),
    ].join("\n");

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, raw, 2);

    expect(replay.summaryMessage).not.toContain(longAssistantText);
    expect(replay.assistantMessage).toBe(`🤖 <b>[Assistant]</b> ${longAssistantText}`);
    expect(replay.assistantMessage).not.toContain("…");
  });

  it("skips the brief summary when only the last assistant entry is recent", () => {
    const raw = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "only assistant" }] },
    });

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, raw, 10);

    expect(replay.summaryMessage).toBeNull();
    expect(replay.assistantMessage).toBe("🤖 <b>[Assistant]</b> only assistant");
  });


  it("does not fabricate assistant replay when none exists", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "u1" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "u2" }] } }),
    ].join("\n");

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, raw, 10);

    expect(replay.summaryMessage).toContain("📋 Recent activity:");
    expect(replay.assistantMessage).toBeNull();
  });


  it("serializes ordered deliveries within a chat", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseSecond!: () => void;
    const secondDone = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const enqueue = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 2000,
      logSkip: async () => {},
      onSkip: async () => {},
    });

    enqueue("telegram:1", async (timeoutMs) => {
      calls.push(`first:${timeoutMs}`);
      firstStarted();
      await firstDone;
      calls.push("first:done");
    });
    enqueue("telegram:1", async () => {
      calls.push("second");
      releaseSecond();
    });

    await firstStartedGate;
    expect(calls).toEqual(["first:2000"]);
    releaseFirst();
    await secondDone;
    expect(calls).toEqual(["first:2000", "first:done", "second"]);
  });

  it("keeps ordered delivery independent per chat", async () => {
    const calls: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastDone!: () => void;
    const fastGate = new Promise<void>((resolve) => {
      fastDone = resolve;
    });
    const enqueue = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 2000,
      logSkip: async () => {},
      onSkip: async () => {},
    });

    enqueue("telegram:slow", async () => {
      calls.push("slow:start");
      await slowGate;
      calls.push("slow:end");
    });
    enqueue("telegram:fast", async () => {
      calls.push("fast");
      fastDone();
    });

    await fastGate;
    expect(calls).toEqual(["slow:start", "fast"]);
    releaseSlow();
    await Promise.resolve();
    expect(calls).toEqual(["slow:start", "fast", "slow:end"]);
  });


  it("routes follow-up question polls through the ordered chat queue", async () => {
    const pendingBySession = new Map<string, { chatId: string }>();
    pendingBySession.set("session-1", { chatId: "telegram:1" });

    const calls: string[] = [];
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let followupDone!: () => void;
    const followupGate = new Promise<void>((resolve) => {
      followupDone = resolve;
    });
    let sendCount = 0;

    const enqueueOrderedConversationDelivery = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 1200,
      logSkip: async () => {},
      onSkip: async () => {},
    });
    const scheduleNextQuestionPoll = __daemonTestUtils.createQuestionPollScheduler({
      getPendingQuestions: (sessionId) => pendingBySession.get(sessionId) ?? null,
      hasActivePollForSession: () => false,
      isChatMutedForChat: () => false,
      enqueueOrderedConversationDelivery,
      sendNextPoll: async (_sessionId, sendOptions) => {
        calls.push(`poll:${sendOptions?.timeoutMs ?? "missing"}`);
        sendCount += 1;
        if (sendCount === 1) {
          firstStarted();
          await firstGate;
          calls.push("first:done");
          return;
        }
        followupDone();
      },
    });

    scheduleNextQuestionPoll("session-1");
    await firstStartedGate;
    scheduleNextQuestionPoll("session-1");

    expect(calls).toEqual(["poll:1200"]);
    resolveFirst();
    await followupGate;
    expect(calls).toEqual(["poll:1200", "first:done", "poll:1200"]);
  });

  it("keeps follow-up poll ordering independent per chat", async () => {
    const pendingBySession = new Map<string, { chatId: string }>([
      ["slow-session", { chatId: "telegram:slow" }],
      ["fast-session", { chatId: "telegram:fast" }],
    ]);

    const calls: string[] = [];
    let releaseSlowFirst!: () => void;
    const slowFirstGate = new Promise<void>((resolve) => {
      releaseSlowFirst = resolve;
    });
    let fastDone!: () => void;
    const fastGate = new Promise<void>((resolve) => {
      fastDone = resolve;
    });
    let slowFollowupDone!: () => void;
    const slowFollowupGate = new Promise<void>((resolve) => {
      slowFollowupDone = resolve;
    });
    let slowSendCount = 0;

    const enqueueOrderedConversationDelivery = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 900,
      logSkip: async () => {},
      onSkip: async () => {},
    });
    const scheduleNextQuestionPoll = __daemonTestUtils.createQuestionPollScheduler({
      getPendingQuestions: (sessionId) => pendingBySession.get(sessionId) ?? null,
      hasActivePollForSession: () => false,
      isChatMutedForChat: () => false,
      enqueueOrderedConversationDelivery,
      sendNextPoll: async (sessionId) => {
        if (sessionId === "slow-session") {
          slowSendCount += 1;
          if (slowSendCount === 1) {
            calls.push("slow:first:start");
            await slowFirstGate;
            calls.push("slow:first:end");
            return;
          }
          calls.push("slow:followup");
          slowFollowupDone();
          return;
        }

        calls.push("fast:first");
        fastDone();
      },
    });

    scheduleNextQuestionPoll("slow-session");
    scheduleNextQuestionPoll("slow-session");
    scheduleNextQuestionPoll("fast-session");

    await fastGate;
    expect(calls).toEqual(["slow:first:start", "fast:first"]);
    releaseSlowFirst();
    await slowFollowupGate;
    expect(calls).toEqual(["slow:first:start", "fast:first", "slow:first:end", "slow:followup"]);
  });
  it("clears pending interactive state on local prompt submit and suppresses follow-up poll sends", async () => {
    const pendingQuestionsBySession = new Map<string, { chatId: string }>([["session-1", { chatId: "telegram:1" }]]);
    const pendingApprovalBySession = new Map<string, { chatId: string }>([["session-1", { chatId: "telegram:1" }]]);
    const activePollBySession = new Map<string, { pollId: string; poll: { chatId: string; messageId: string } }>([
      ["session-1", { pollId: "poll-1", poll: { chatId: "telegram:1", messageId: "msg-1" } }],
    ]);
    const removedPollIds: string[] = [];
    const closedPolls: Array<{ chatId: string; messageId: string }> = [];
    let sendCount = 0;

    const enqueueOrderedConversationDelivery = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 1000,
      logSkip: async () => {},
      onSkip: async () => {},
    });
    const scheduleNextQuestionPoll = __daemonTestUtils.createQuestionPollScheduler({
      getPendingQuestions: (sessionId) => pendingQuestionsBySession.get(sessionId) ?? null,
      hasActivePollForSession: (sessionId) => activePollBySession.has(sessionId),
      isChatMutedForChat: () => false,
      enqueueOrderedConversationDelivery,
      sendNextPoll: async () => {
        sendCount += 1;
      },
    });

    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    expect(sendCount).toBe(0);

    __daemonTestUtils.clearInteractiveStateForLocalPromptSubmit({
      clearPendingQuestions: (sessionId) => {
        pendingQuestionsBySession.delete(sessionId);
      },
      clearPendingApproval: (sessionId) => {
        pendingApprovalBySession.delete(sessionId);
      },
      getActivePollForSession: (sessionId) => activePollBySession.get(sessionId),
      removePoll: (pollId) => {
        removedPollIds.push(pollId);
        activePollBySession.delete("session-1");
      },
      closePollForChat: (chatId, messageId) => {
        closedPolls.push({ chatId, messageId });
      },
    }, "session-1");

    expect(pendingQuestionsBySession.has("session-1")).toBe(false);
    expect(pendingApprovalBySession.has("session-1")).toBe(false);
    expect(removedPollIds).toEqual(["poll-1"]);
    expect(closedPolls).toEqual([{ chatId: "telegram:1", messageId: "msg-1" }]);

    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    expect(sendCount).toBe(0);
  });

  it("does not send duplicate question polls while one is active and resumes after answer", async () => {
    const pendingBySession = new Map<string, { chatId: string }>([["session-1", { chatId: "telegram:1" }]]);
    let hasActivePoll = true;
    let sendCount = 0;

    const enqueueOrderedConversationDelivery = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 800,
      logSkip: async () => {},
      onSkip: async () => {},
    });
    const scheduleNextQuestionPoll = __daemonTestUtils.createQuestionPollScheduler({
      getPendingQuestions: (sessionId) => pendingBySession.get(sessionId) ?? null,
      hasActivePollForSession: () => hasActivePoll,
      isChatMutedForChat: () => false,
      enqueueOrderedConversationDelivery,
      sendNextPoll: async () => {
        sendCount += 1;
      },
    });

    scheduleNextQuestionPoll("session-1");
    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCount).toBe(0);

    hasActivePoll = false;
    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCount).toBe(1);

    hasActivePoll = true;
    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCount).toBe(1);

    hasActivePoll = false;
    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCount).toBe(2);
  });

  it("emits skip notices and continues after a failed ordered delivery", async () => {
    const notices: Array<{ chatId: string; timeoutMs: number }> = [];
    const calls: string[] = [];
    let afterSkipDone!: () => void;
    const afterSkipGate = new Promise<void>((resolve) => {
      afterSkipDone = resolve;
    });
    const enqueue = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 1500,
      logSkip: async () => {},
      onSkip: async (chatId, timeoutMs) => {
        notices.push({ chatId, timeoutMs });
      },
    });

    enqueue("telegram:1", async () => {
      throw new Error("timed out");
    });
    enqueue("telegram:1", async () => {
      calls.push("after-skip");
      afterSkipDone();
    });

    await afterSkipGate;
    expect(notices).toEqual([{ chatId: "telegram:1", timeoutMs: 1500 }]);
    expect(calls).toEqual(["after-skip"]);
  });
  const bufferedEntriesForAutomaticFlush = [
    {
      at: 1,
      role: "tool" as const,
      summaryText: "Read README.md",
      fullMessage: "🛠️ <b>[Tool]</b> Read README.md",
      countsForSummary: true,
      countsForReplay: true,
    },
    {
      at: 2,
      role: "user" as const,
      summaryText: "Please update the docs",
      fullMessage: "🙋 <b>[User]</b> Please update the docs",
      countsForSummary: true,
      countsForReplay: true,
    },
    {
      at: 3,
      role: "tool" as const,
      summaryText: "Search results ready",
      fullMessage: "🛠️ <b>[Tool]</b> Search results ready",
      countsForSummary: true,
      countsForReplay: true,
    },
    {
      at: 4,
      role: "assistant" as const,
      summaryText: "I need your approval before editing production config",
      fullMessage: "🤖 <b>[Assistant]</b> I need your approval before editing production config",
      countsForSummary: true,
      countsForReplay: true,
    },
  ];

  it("selects summary and replay messages for non-empty automatic flush", () => {
    const messages = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(fmt, bufferedEntriesForAutomaticFlush);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("Recent activity");
    expect(messages.slice(1)).toEqual([
      "🙋 <b>[User]</b> Please update the docs",
      "🛠️ <b>[Tool]</b> Search results ready",
      "🤖 <b>[Assistant]</b> I need your approval before editing production config",
    ]);
  });

  it("returns no messages for empty automatic flush without notice", () => {
    const messages = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(fmt, []);

    expect(messages).toEqual([]);
  });

  it("keeps explicit notice distinct from replay when automatic buffer is empty", () => {
    const noticeMessage = "⏳ Throttle is still active.";
    const messages = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(
      fmt,
      [],
      { noticeMessage }
    );

    expect(messages).toEqual([noticeMessage]);
  });

  it("suppresses replay when includeReplay is false while keeping notice and summary", () => {
    const noticeMessage = "⏳ Throttle is still active.";
    const messages = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(
      fmt,
      bufferedEntriesForAutomaticFlush,
      { noticeMessage, includeReplay: false }
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(noticeMessage);
    expect(messages[1]).toContain("Recent activity");
  });

  it("keeps manual recent-history replay helper behavior for explicit replay", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "first user" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "latest assistant" }] } }),
    ].join("\n");

    const replay = __daemonTestUtils.buildRecentActivityReplayMessages(fmt, raw, 10);

    expect(replay.summaryMessage).toContain("📋 Recent activity:");
    expect(replay.summaryMessage).toContain("<b>[User]</b> first user");
    expect(replay.assistantMessage).toBe("🤖 <b>[Assistant]</b> latest assistant");
  });

  it("suppresses question polls while mute is active", async () => {
    const pendingBySession = new Map<string, { chatId: string }>([["session-1", { chatId: "telegram:1" }]]);
    let sendCount = 0;
    const enqueueOrderedConversationDelivery = __daemonTestUtils.createOrderedConversationQueue({
      getTimeoutMs: () => 1000,
      logSkip: async () => {},
      onSkip: async () => {},
    });
    const scheduleNextQuestionPoll = __daemonTestUtils.createQuestionPollScheduler({
      getPendingQuestions: (sessionId) => pendingBySession.get(sessionId) ?? null,
      hasActivePollForSession: () => false,
      isChatMutedForChat: () => true,
      enqueueOrderedConversationDelivery,
      sendNextPoll: async () => {
        sendCount += 1;
      },
    });

    scheduleNextQuestionPoll("session-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCount).toBe(0);
  });

  function createWaitBoardHarness(options?: {
    chats?: string[];
    typingIndicatorByChat?: Record<string, boolean>;
    upsertBehaviorByChat?: Record<string, (input: {
      html: string;
      options: { pin?: boolean; messageId?: string; pinned?: boolean };
      count: number;
    }) => { messageId?: string; pinned?: boolean } | void>;
    clearThrowsByChat?: Set<string>;
  }) {
    const chats = options?.chats ?? ["telegram:1"];
    const typingIndicatorByChat = options?.typingIndicatorByChat ?? {};
    const upsertBehaviorByChat = options?.upsertBehaviorByChat ?? {};
    const clearThrowsByChat = options?.clearThrowsByChat ?? new Set<string>();
    const persistedBoards = new Map<string, { chatId: string; boardKey: string; messageId: string; pinned: boolean; updatedAt: number }>();
    const activeWaitCycles = new Map<string, { sessionId: string; cycleId: number; boardKey: string; activeChatIds: string[] }>();
    const upserts: Array<{ chatId: string; boardKey: string; html: string; options: { pin?: boolean; messageId?: string; pinned?: boolean } }> = [];
    const clears: Array<{ chatId: string; boardKey: string; options: { unpin?: boolean; messageId?: string; pinned?: boolean } }> = [];
    const typing: Array<{ chatId: string; active: boolean }> = [];
    const timers: Array<{ delayMs: number; callback: () => void }> = [];
    const upsertCounts = new Map<string, number>();
    const statusKey = (chatId: string, boardKey: string) => `${chatId}::${boardKey}`;

    const channels = new Map(
      chats.map((chatId) => {
        const channel = {
          upsertStatusBoard: async (
            nextChatId: string,
            boardKey: string,
            html: string,
            boardOptions: { pin?: boolean; messageId?: string; pinned?: boolean }
          ) => {
            upserts.push({ chatId: nextChatId, boardKey, html, options: boardOptions });
            const count = (upsertCounts.get(nextChatId) ?? 0) + 1;
            upsertCounts.set(nextChatId, count);
            const custom = upsertBehaviorByChat[nextChatId]?.({ html, options: boardOptions, count });
            return custom ?? { messageId: boardOptions.messageId ?? `${nextChatId}-msg-${count}`, pinned: boardOptions.pin === true };
          },
          clearStatusBoard: async (
            nextChatId: string,
            boardKey: string,
            boardOptions: { unpin?: boolean; messageId?: string; pinned?: boolean }
          ) => {
            clears.push({ chatId: nextChatId, boardKey, options: boardOptions });
            if (clearThrowsByChat.has(nextChatId)) throw new Error(`clear failed for ${nextChatId}`);
          },
          setTyping: (nextChatId: string, active: boolean) => {
            typing.push({ chatId: nextChatId, active });
          },
        };
        return [chatId, channel];
      })
    );

    const ops = {
      getConversationTargets: () => new Set(chats),
      getOutputPreferencesForChat: (chatId: string) => ({ typingIndicator: typingIndicatorByChat[chatId] ?? false }),
      getChannelForChat: (chatId: string) => channels.get(chatId),
      getFormatterForChat: () => fmt,
      getPersistedStatusBoard: (chatId: string, boardKey: string) => persistedBoards.get(statusKey(chatId, boardKey)),
      listPersistedStatusBoardsForBoard: (boardKey: string) => Array.from(persistedBoards.values()).filter((entry) => entry.boardKey === boardKey),
      setPersistedStatusBoard: (chatId: string, boardKey: string, messageId: string, pinned: boolean) => {
        persistedBoards.set(statusKey(chatId, boardKey), {
          chatId,
          boardKey,
          messageId,
          pinned,
          updatedAt: persistedBoards.get(statusKey(chatId, boardKey))?.updatedAt ?? 0,
        });
      },
      removePersistedStatusBoard: (chatId: string, boardKey: string) => {
        persistedBoards.delete(statusKey(chatId, boardKey));
      },
      getPersistedActiveWaitCycle: (boardKey: string) => activeWaitCycles.get(boardKey),
      syncPersistedActiveWaitCycle: (sessionId: string, cycle: { cycleId: number; boardKey: string }, activeChatIds: Iterable<string>) => {
        const normalized = Array.from(new Set(activeChatIds));
        if (normalized.length === 0) {
          activeWaitCycles.delete(cycle.boardKey);
          return;
        }
        activeWaitCycles.set(cycle.boardKey, {
          sessionId,
          cycleId: cycle.cycleId,
          boardKey: cycle.boardKey,
          activeChatIds: normalized,
        });
      },
      syncPersistedWaitCycleRetryState: (entry: { sessionId: string; cycleId: number; boardKey: string }, activeChatIds: Iterable<string>) => {
        const normalized = Array.from(new Set(activeChatIds));
        if (normalized.length === 0) {
          activeWaitCycles.delete(entry.boardKey);
          return;
        }
        activeWaitCycles.set(entry.boardKey, {
          sessionId: entry.sessionId,
          cycleId: entry.cycleId,
          boardKey: entry.boardKey,
          activeChatIds: normalized,
        });
      },
      removePersistedActiveWaitCycle: (boardKey: string) => {
        activeWaitCycles.delete(boardKey);
      },
      listPersistedWaitCyclesForCleanup: () => Array.from(activeWaitCycles.values()),
      setTyping: (chatId: string, active: boolean) => {
        typing.push({ chatId, active });
      },
      setStopTimer: (callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs });
        return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
      },
      clearStopTimer: () => {},
    };

    return { ops, persistedBoards, activeWaitCycles, upserts, clears, typing, timers };
  }

  it("creates synchronized wait boards for all active chats and updates them in place", async () => {
    const harness = createWaitBoardHarness({
      chats: ["telegram:1", "telegram:2"],
      upsertBehaviorByChat: {
        "telegram:2": ({ options, count }) => ({
          messageId: options.messageId ?? `telegram:2-msg-${count}`,
          pinned: false,
        }),
      },
    });
    const cycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:batch-1",
      phase: "startOrUpdate",
      items: [
        { itemKey: "task-1", title: "Draft reply", status: "queued" },
        { itemKey: "task-2", title: "Check policy", status: "running" },
      ],
    }, 100);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", cycle, harness.ops);

    expect(harness.upserts).toHaveLength(2);
    expect(harness.upserts[0]?.options.pin).toBe(true);
    expect(harness.upserts[1]?.options.pin).toBe(true);
    expect(Array.from(harness.persistedBoards.values()).map((entry) => entry.messageId)).toEqual([
      "telegram:1-msg-1",
      "telegram:2-msg-1",
    ]);
    expect(Array.from(harness.persistedBoards.values()).map((entry) => entry.pinned)).toEqual([true, false]);

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:batch-1",
      phase: "startOrUpdate",
      items: [
        { itemKey: "task-1", status: "completed" },
        { itemKey: "task-2", status: "running", detail: "Waiting on final review" },
      ],
    }, 200);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", cycle, harness.ops);

    expect(harness.upserts).toHaveLength(4);
    expect(harness.upserts[2]?.options.messageId).toBe("telegram:1-msg-1");
    expect(harness.upserts[3]?.options.messageId).toBe("telegram:2-msg-1");
    expect(harness.upserts[2]?.html).toContain("Draft reply");
    expect(harness.upserts[2]?.html).toContain("completed");
    expect(harness.upserts[2]?.html).toContain("Waiting on final review");
  });

  it("keeps the board active across overlapping wait groups until all tracked work finishes", async () => {
    const harness = createWaitBoardHarness();
    const cycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "claude-task",
      waitGroupKey: "claude-task:tool-1",
      phase: "startOrUpdate",
      items: [{ itemKey: "agent-a", title: "Subagent A", status: "running" }],
    }, 100);
    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "codex-subagent",
      waitGroupKey: "codex-subagent:wait-1",
      phase: "startOrUpdate",
      items: [{ itemKey: "agent-b", title: "Subagent B", status: "running" }],
    }, 101);
    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "claude-task",
      waitGroupKey: "claude-task:tool-1",
      phase: "finish",
      items: [{ itemKey: "agent-a", status: "failed", detail: "tool crashed" }],
    }, 200);

    expect(__daemonTestUtils.waitCycleCanFinalizeState(cycle)).toBe(false);
    expect(__daemonTestUtils.renderActiveWaitBoardState("telegram:1", cycle, fmt)).toContain("Waiting on 2 tasks");
    expect(__daemonTestUtils.renderActiveWaitBoardState("telegram:1", cycle, fmt)).toContain("tool crashed");

    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", cycle, harness.ops);
    expect(harness.upserts[0]?.html).toContain("Waiting on 2 tasks");

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "codex-subagent",
      waitGroupKey: "codex-subagent:wait-1",
      phase: "finish",
      items: [{ itemKey: "agent-b", status: "completed" }],
      summary: "Main agent finished waiting.",
    }, 300);

    expect(__daemonTestUtils.waitCycleCanFinalizeState(cycle)).toBe(true);
    await __daemonTestUtils.finalizeWaitCycleBoardsState("session-1", cycle, harness.ops);

    expect(harness.upserts).toHaveLength(2);
    expect(harness.upserts[1]?.html).toContain("Wait finished with failures");
    expect(harness.upserts[1]?.html).toContain("Main agent finished waiting.");
    expect(harness.clears).toEqual([
      {
        chatId: "telegram:1",
        boardKey: cycle.boardKey,
        options: { unpin: true, messageId: "telegram:1-msg-1", pinned: false },
      },
    ]);
  });

  it("reuses one active cycle across overlapping wait events until all groups finish", () => {
    const activeCycles = new Map<string, ReturnType<typeof __daemonTestUtils.createWaitCycleState>>();

    const first = __daemonTestUtils.handleWaitStateForSessionState(
      activeCycles,
      "session-1",
      {
        cycleSource: "claude-task",
        waitGroupKey: "claude-task:tool-1",
        phase: "startOrUpdate",
        items: [{ itemKey: "agent-a", title: "Subagent A", status: "running" }],
      },
      () => __daemonTestUtils.createWaitCycleState("session-1", 1, 100),
      100
    );
    const second = __daemonTestUtils.handleWaitStateForSessionState(
      activeCycles,
      "session-1",
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:wait-1",
        phase: "startOrUpdate",
        items: [{ itemKey: "agent-b", title: "Subagent B", status: "running" }],
      },
      () => __daemonTestUtils.createWaitCycleState("session-1", 99, 200),
      200
    );

    expect(activeCycles.size).toBe(1);
    expect(second.cycle.boardKey).toBe(first.cycle.boardKey);
    expect(second.shouldFinalize).toBe(false);

    const finished = __daemonTestUtils.handleWaitStateForSessionState(
      activeCycles,
      "session-1",
      {
        cycleSource: "claude-task",
        waitGroupKey: "claude-task:tool-1",
        phase: "finish",
        items: [{ itemKey: "agent-a", status: "completed" }],
      },
      () => __daemonTestUtils.createWaitCycleState("session-1", 100, 300),
      300
    );
    expect(finished.shouldFinalize).toBe(false);

    const finalized = __daemonTestUtils.handleWaitStateForSessionState(
      activeCycles,
      "session-1",
      {
        cycleSource: "codex-subagent",
        waitGroupKey: "codex-subagent:wait-1",
        phase: "finish",
        items: [{ itemKey: "agent-b", status: "completed" }],
      },
      () => __daemonTestUtils.createWaitCycleState("session-1", 101, 400),
      400
    );
    expect(finalized.cycle.boardKey).toBe(first.cycle.boardKey);
    expect(finalized.shouldFinalize).toBe(true);
  });

  it("keeps transcript delivery available while a wait board is active", async () => {
    const harness = createWaitBoardHarness({ chats: ["telegram:1"] });
    const cycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:batch-1",
      phase: "startOrUpdate",
      items: [{ itemKey: "task-1", title: "Draft reply", status: "running" }],
    }, 100);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", cycle, harness.ops);

    const automaticFlush = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(fmt, bufferedEntriesForAutomaticFlush, {
      noticeMessage: "⏳ Throttle is still active.",
    });

    __daemonTestUtils.applyWaitStateEventToCycleState(cycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:batch-1",
      phase: "startOrUpdate",
      items: [{ itemKey: "task-1", status: "running", detail: "Still waiting on final review" }],
    }, 200);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", cycle, harness.ops);

    expect(harness.upserts).toHaveLength(2);
    expect(harness.upserts[0]?.html).toContain("Waiting on 1 task");
    expect(harness.upserts[1]?.html).toContain("Still waiting on final review");
    expect(automaticFlush[0]).toBe("⏳ Throttle is still active.");
    expect(automaticFlush[1]).toContain("Recent activity");
    expect(automaticFlush.slice(2)).toEqual([
      "🙋 <b>[User]</b> Please update the docs",
      "🛠️ <b>[Tool]</b> Search results ready",
      "🤖 <b>[Assistant]</b> I need your approval before editing production config",
    ]);
  });

  it("stops wait heartbeat when a target disappears or the cycle finalizes", async () => {
    const targetChats = ["telegram:1"];
    const harness = createWaitBoardHarness({
      chats: targetChats,
      typingIndicatorByChat: { "telegram:1": true },
    });
    const cycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-1", cycle, harness.ops, 1_000);
    expect(harness.typing).toEqual([{ chatId: "telegram:1", active: true }]);

    targetChats.splice(0, 1);
    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-1", cycle, harness.ops, 2_000);
    expect(harness.typing).toEqual([
      { chatId: "telegram:1", active: true },
      { chatId: "telegram:1", active: false },
    ]);

    const finalizeHarness = createWaitBoardHarness({
      chats: ["telegram:1"],
      typingIndicatorByChat: { "telegram:1": true },
    });
    const finalizeCycle = __daemonTestUtils.createWaitCycleState("session-2", 1, 100);
    __daemonTestUtils.applyWaitStateEventToCycleState(finalizeCycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:1",
      phase: "finish",
      items: [{ itemKey: "task-1", title: "Initial task", status: "completed" }],
    }, 100);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-2", finalizeCycle, finalizeHarness.ops);
    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-2", finalizeCycle, finalizeHarness.ops, 5_000);
    await __daemonTestUtils.finalizeWaitCycleBoardsState("session-2", finalizeCycle, finalizeHarness.ops);

    expect(finalizeHarness.typing).toEqual([
      { chatId: "telegram:1", active: true },
      { chatId: "telegram:1", active: false },
    ]);
  });

  it("does not create a wait board unless explicit wait-state signals are applied", () => {
    const harness = createWaitBoardHarness({ chats: ["telegram:1", "telegram:2"] });

    const automaticFlush = __daemonTestUtils.selectAutomaticBufferedDeliveryMessages(fmt, bufferedEntriesForAutomaticFlush, {
      noticeMessage: "⏳ Throttle is still active.",
    });

    expect(automaticFlush[0]).toBe("⏳ Throttle is still active.");
    expect(harness.upserts).toEqual([]);
    expect(harness.persistedBoards.size).toBe(0);
  });

  it("sends 5-second typing pulses only to chats with typing indicators enabled", () => {
    const harness = createWaitBoardHarness({
      chats: ["telegram:1", "telegram:2"],
      typingIndicatorByChat: { "telegram:1": true, "telegram:2": false },
    });
    const cycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-1", cycle, harness.ops, 1_000);
    expect(harness.typing).toEqual([{ chatId: "telegram:1", active: true }]);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(5_000);

    harness.timers[0]?.callback();
    expect(harness.typing).toEqual([
      { chatId: "telegram:1", active: true },
      { chatId: "telegram:1", active: false },
    ]);

    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-1", cycle, harness.ops, 30_000);
    expect(harness.typing).toHaveLength(2);

    __daemonTestUtils.maintainWaitCycleHeartbeatState("session-1", cycle, harness.ops, 61_000);
    expect(harness.typing).toEqual([
      { chatId: "telegram:1", active: true },
      { chatId: "telegram:1", active: false },
      { chatId: "telegram:1", active: true },
    ]);
  });

  it("finalizes boards into retained history, starts later cycles on new boards, and cleans up restart leftovers deterministically", async () => {
    const harness = createWaitBoardHarness({ chats: ["telegram:1", "telegram:2"], clearThrowsByChat: new Set(["telegram:2"]) });
    const firstCycle = __daemonTestUtils.createWaitCycleState("session-1", 1, 100);

    __daemonTestUtils.applyWaitStateEventToCycleState(firstCycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:1",
      phase: "finish",
      items: [{ itemKey: "task-1", title: "Initial task", status: "completed" }],
      summary: "All tasks completed.",
    }, 100);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", firstCycle, harness.ops);
    await __daemonTestUtils.finalizeWaitCycleBoardsState("session-1", firstCycle, harness.ops);

    const firstCycleFinalUpserts = harness.upserts.filter((entry) => entry.boardKey === firstCycle.boardKey && entry.options.pin === false);
    expect(firstCycleFinalUpserts).toHaveLength(2);
    expect(firstCycleFinalUpserts[0]?.html).toContain("Wait complete");
    expect(firstCycleFinalUpserts[0]?.html).toContain("All tasks completed.");
    expect(harness.persistedBoards.get(`telegram:2::${firstCycle.boardKey}`)?.messageId).toBe("telegram:2-msg-1");
    expect(harness.activeWaitCycles.get(firstCycle.boardKey)?.activeChatIds).toEqual(["telegram:2"]);

    const secondCycle = __daemonTestUtils.createWaitCycleState("session-1", 2, 200);
    __daemonTestUtils.applyWaitStateEventToCycleState(secondCycle, {
      cycleSource: "omp-task",
      waitGroupKey: "omp-task:2",
      phase: "startOrUpdate",
      items: [{ itemKey: "task-2", title: "Follow-up task", status: "running" }],
    }, 200);
    await __daemonTestUtils.refreshWaitCycleBoardsState("session-1", secondCycle, harness.ops);

    expect(secondCycle.boardKey).not.toBe(firstCycle.boardKey);
    expect(harness.upserts.filter((entry) => entry.boardKey === secondCycle.boardKey)).toHaveLength(2);

    harness.persistedBoards.set(`telegram:2::wait-cycle:session-2:9`, {
      chatId: "telegram:2",
      boardKey: "wait-cycle:session-2:9",
      messageId: "stale-msg",
      pinned: true,
      updatedAt: 0,
    });
    harness.activeWaitCycles.set("wait-cycle:session-2:9", {
      sessionId: "session-2",
      cycleId: 9,
      boardKey: "wait-cycle:session-2:9",
      activeChatIds: ["telegram:2"],
    });

    await __daemonTestUtils.cleanupInterruptedWaitCycleBoardsState(harness.ops);

    const staleBoardUpsert = harness.upserts.find((entry) => entry.boardKey === "wait-cycle:session-2:9" && entry.html.includes("Wait tracking interrupted after daemon restart"));
    expect(staleBoardUpsert?.chatId).toBe("telegram:2");
    expect(harness.clears).toContainEqual({
      chatId: "telegram:2",
      boardKey: "wait-cycle:session-2:9",
      options: { unpin: true, messageId: "stale-msg", pinned: true },
    });
    expect(harness.activeWaitCycles.get("wait-cycle:session-2:9")?.activeChatIds).toEqual(["telegram:2"]);
  });

});
