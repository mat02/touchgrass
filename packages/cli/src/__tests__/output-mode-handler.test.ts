import { describe, expect, it } from "bun:test";
import { routeMessage } from "../bot/command-router";
import { SessionManager } from "../session/manager";
import { defaultSettings } from "../config/schema";

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
  };
  if (withPoll) {
    channel.sendPoll = async () => ({ pollId: "poll-output-mode", messageId: "99" });
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
    const picker = ctx.sessionManager.getOutputModePickerByPollId("poll-output-mode");
    expect(picker).toBeDefined();
    expect(picker.step).toBe("preset");
    expect(picker.options).toEqual([
      { kind: "preset", value: "simple" },
      { kind: "preset", value: "thinking" },
      { kind: "preset", value: "verbose" },
      { kind: "preset", value: "custom" },
    ]);
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
});
