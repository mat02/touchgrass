import { describe, expect, it } from "bun:test";
import { routeMessage } from "../bot/command-router";
import { SessionManager } from "../session/manager";
import { defaultSettings, getChatOutputMode } from "../config/schema";

const fmt = {
  bold: (value: string) => value,
  italic: (value: string) => value,
  code: (value: string) => value,
  pre: (value: string) => value,
  link: (value: string) => value,
  escape: (value: string) => value,
  fromMarkdown: (value: string) => value,
};

function createCtx(sent: string[]) {
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

  return {
    config,
    sessionManager,
    channel,
  } as any;
}

describe("removed thinking command", () => {
  it("reports that /thinking was removed", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/thinking" },
      ctx
    );

    expect(getChatOutputMode(ctx.config, "telegram:100")).toBe("compact");
    expect(sent[0]).toContain("command was removed");
    expect(sent[0]).toContain("/output_mode thinking");
  });

  it("reports that tg thinking alias was removed", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "tg thinking on" },
      ctx
    );

    expect(getChatOutputMode(ctx.config, "telegram:100")).toBe("compact");
    expect(sent[0]).toContain("command was removed");
    expect(sent[0]).toContain("output_mode thinking");
  });
});
