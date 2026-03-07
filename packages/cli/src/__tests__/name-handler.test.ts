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

describe("name command", () => {
  it("sets a name for the current session", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const remote = ctx.sessionManager.registerRemote(
      "claude",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-name001"
    );

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/name Auth work" },
      ctx
    );

    expect(ctx.sessionManager.getRemote(remote.id)?.name).toBe("Auth work");
    expect(sent[0]).toContain("is now named");
    expect(sent[0]).toContain("Auth work");
  });

  it("shows the current name and usage when no argument is provided", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    ctx.sessionManager.registerRemote(
      "claude",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-name002",
      "Inbox zero"
    );

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/name" },
      ctx
    );

    expect(sent[0]).toContain("Current name:");
    expect(sent[0]).toContain("Inbox zero");
    expect(sent[0]).toContain("/name <new name>");
  });

  it("clears an existing name", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const remote = ctx.sessionManager.registerRemote(
      "claude",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-name003",
      "Inbox zero"
    );

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/name clear" },
      ctx
    );

    expect(ctx.sessionManager.getRemote(remote.id)?.name).toBeUndefined();
    expect(sent[0]).toContain("Cleared custom name");
  });

  it("supports tg name aliases", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const remote = ctx.sessionManager.registerRemote(
      "claude",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-name004"
    );

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "tg name Build bot" },
      ctx
    );

    expect(ctx.sessionManager.getRemote(remote.id)?.name).toBe("Build bot");
    expect(sent[0]).toContain("Build bot");
  });
});
