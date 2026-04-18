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
});
