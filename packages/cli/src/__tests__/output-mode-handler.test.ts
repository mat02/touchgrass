import { describe, expect, it } from "bun:test";
import { routeMessage } from "../bot/command-router";
import { advanceOutputWizardSelection, buildOutputPickerPrompt, getNextOutputWizardStep } from "../bot/handlers/output-mode";
import { getChatDeliveryPreference, getChatOutputPreferences, isChatDeliveryMuted, setChatOutputPreferences, defaultSettings } from "../config/schema";
import { SessionManager } from "../session/manager";

const fmt = {
  bold: (value: string) => value,
  italic: (value: string) => value,
  code: (value: string) => value,
  pre: (value: string) => value,
  link: (value: string) => value,
  escape: (value: string) => value,
  fromMarkdown: (value: string) => value,
};

function createCtx(sent: string[], withPoll = false) {
  const config = {
    channels: {
      telegram: {
        type: "telegram",
        credentials: {},
        pairedUsers: [{ userId: "telegram:1", pairedAt: new Date().toISOString() }],
        linkedGroups: [],
      },
    },
    settings: { ...defaultSettings },
    chatPreferences: {},
  };

  const sessionManager = new SessionManager(defaultSettings);
  const channel: any = {
    fmt,
    send: async (_chatId: string, content: string) => sent.push(content),
    setTyping: () => {},
  };
  if (withPoll) {
    let pollSeq = 0;
    channel.sendPoll = async () => ({ pollId: `poll-${++pollSeq}`, messageId: String(98 + pollSeq) });
  }

  return {
    config,
    sessionManager,
    channel,
  } as any;
}

describe("output mode command", () => {
  it("shows current output settings when called without args (text fallback)", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode" },
      ctx
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Transcript preset: simple");
    expect(sent[0]).toContain("Thinking: preview");
    expect(sent[0]).toContain("Ordering notices: off");
    expect(sent[1]).toContain("/output_mode tool_calls off|compact|detailed");
  });

  it("opens preset picker when /output_mode has no args and polling is supported", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent, true);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Transcript preset: simple");
    const picker = ctx.sessionManager.getOutputModePickerByPollId("poll-1");
    expect(picker).toBeDefined();
    expect(picker.step).toBe("preset");
    expect(picker.options).toEqual([
      { kind: "preset", value: "simple" },
      { kind: "preset", value: "thinking" },
      { kind: "preset", value: "verbose" },
      { kind: "preset", value: "custom" },
    ]);
  });


  it("exposes custom wizard progression through ordering notices and persists the final choice", () => {
    const sequence: string[] = [];
    const selections = {
      thinkingMode: "full",
      toolCallMode: "detailed",
      toolResultMode: "full",
      toolErrors: true,
      backgroundJobs: true,
      typingIndicator: true,
      orderingNotices: true,
    } as const;
    const ctx = createCtx([]);
    const chatId = "telegram:100";
    let step: ReturnType<typeof getNextOutputWizardStep> | "thinkingMode" = "thinkingMode";
    let pendingOutput = getChatOutputPreferences(ctx.config, chatId);

    while (step) {
      sequence.push(step);
      const prompt = buildOutputPickerPrompt(step, pendingOutput);
      expect(prompt.options.length).toBeGreaterThan(0);
      expect(prompt.options.every((option) => option.kind === step)).toBe(true);
      const selected = prompt.options.find(
        (option) => option.kind === step && option.value === selections[step]
      ) as Exclude<(typeof prompt.options)[number], { kind: "preset" }> | undefined;
      expect(selected).toBeDefined();
      const advanced = advanceOutputWizardSelection(pendingOutput, selected!);
      pendingOutput = advanced.nextOutput;
      step = advanced.nextStep;
    }

    expect(sequence).toEqual([
      "thinkingMode",
      "toolCallMode",
      "toolResultMode",
      "toolErrors",
      "backgroundJobs",
      "typingIndicator",
      "orderingNotices",
    ]);
    const changed = setChatOutputPreferences(ctx.config, chatId, pendingOutput);
    expect(changed).toBe(true);
    expect(getChatOutputPreferences(ctx.config, chatId).orderingNotices).toBe(true);
    expect(getChatOutputPreferences(ctx.config, chatId).toolCallMode).toBe("detailed");
    expect(getChatOutputPreferences(ctx.config, chatId).toolResultMode).toBe("full");
  });
  it("accepts tg output-mode alias", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "tg output-mode" },
      ctx
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Output settings");
  });

  it("opens throttle presets instead of output mode controls", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent, true);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/throttle" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Throttle");
    const picker = ctx.sessionManager.getThrottlePickerByPollId("poll-1");
    expect(picker?.options).toEqual([
      { kind: "preset", value: 1 },
      { kind: "preset", value: 5 },
      { kind: "preset", value: 15 },
      { kind: "preset", value: 30 },
      { kind: "off" },
    ]);
  });

  it("rejects invalid output mode values", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode loud" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/output_mode simple|thinking|verbose");
    expect(sent[0]).toContain("Transcript preset: simple");
  });

  it("accepts simple as explicit preset alias", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode simple" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Transcript preset: simple");
  });

  it("accepts thinking as an explicit preset", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode thinking" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Transcript preset: thinking");
    expect(sent[0]).toContain("Thinking: full");
  });

  it("accepts granular tool call settings", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode tool_calls off" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Tool calls: off");
    expect(sent[0]).toContain("Transcript preset: custom");
  });

  it("accepts ordering notice settings", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode ordering_notices on" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Ordering notices: on");
    expect(sent[0]).toContain("Transcript preset: simple");
  });

  it("rejects removed messages_only mode", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/output_mode messages_only" },
      ctx
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/output_mode simple|thinking|verbose");
    expect(sent[0]).toContain("Transcript preset: simple");
  });

  it("accepts direct throttle presets and throttle off", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/throttle 15m" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({
      mode: "throttle",
      intervalMinutes: 15,
      activatedAt: expect.any(String),
      lastSummaryAt: null,
      pendingUserTurnSince: null,
    });
    expect(sent[0]).toContain("Throttle is active every 15 minutes");

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/throttle off" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({ mode: "immediate" });
    expect(sent[1]).toContain("Bridge output is now immediate");
  });

  it("accepts timed mute, permanent mute, and /unmute", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/mute 30m" },
      ctx
    );

    expect(isChatDeliveryMuted(ctx.config, "telegram:100")).toBe(true);
    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({
      mode: "mute",
      kind: "timed",
      activatedAt: expect.any(String),
      mutedUntil: expect.any(String),
      pendingUserTurnSince: null,
    });
    expect(sent[0]).toContain("muted for 30 minutes");

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/mute forever" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({
      mode: "mute",
      kind: "permanent",
      activatedAt: expect.any(String),
      pendingUserTurnSince: null,
      lastAwaitingUserNoticeAt: null,
    });
    expect(sent[1]).toContain("muted until you use /unmute");

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/unmute" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({ mode: "immediate" });
    expect(sent[2]).toContain("Bridge output is now immediate");
  });

  it("rejects invalid throttle arguments with throttle usage", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/throttle verbose" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({ mode: "immediate" });
    expect(sent[0]).toContain("/throttle 1m");
    expect(sent[0]).toContain("Throttle");
  });

  it("opens mute presets and rejects invalid mute arguments with mute usage", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent, true);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/mute" },
      ctx
    );

    expect(sent[0]).toContain("Mute");
    expect(ctx.sessionManager.getMutePickerByPollId("poll-1")?.options).toEqual([
      { kind: "timed", value: 15 },
      { kind: "timed", value: 30 },
      { kind: "timed", value: 60 },
      { kind: "permanent" },
    ]);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/mute now" },
      ctx
    );

    expect(getChatDeliveryPreference(ctx.config, "telegram:100")).toEqual({ mode: "immediate" });
    expect(sent[1]).toContain("/mute 15m");
    expect(sent[1]).toContain("Mute");
  });

  it("updates help text for throttle, mute, and output_mode", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/help" },
      ctx
    );

    expect(sent[0]).toContain("/throttle — Reduce bridge delivery to timed summaries");
    expect(sent[0]).toContain("/mute — Silence bridge output with timed or permanent mute");
    expect(sent[0]).toContain("/output_mode — Configure transcript formatting");
  });
});
