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
    type: "telegram",
    fmt,
    send: async (_chatId: string, content: string) => sent.push(content),
  };

  return {
    config,
    sessionManager,
    channel,
  } as any;
}

describe("Telegram /new for OMP", () => {
  it("queues a dedicated OMP new-session control action for the attached session", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const remote = ctx.sessionManager.registerRemote(
      "omp --session /tmp/omp-session.jsonl",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-omp-new-1"
    );
    ctx.sessionManager.attach("telegram:100", remote.id);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/new" },
      ctx
    );

    expect(sent[0]).toContain("Requested /new");
    expect(sent[0]).not.toContain("Chat-side session start/stop was removed");
    expect(ctx.sessionManager.drainRemoteControl(remote.id)).toEqual({ type: "omp-new" });
  });

  it("rejects /new for non-OMP sessions", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const remote = ctx.sessionManager.registerRemote(
      "claude --resume abc",
      "telegram:100",
      "telegram:1",
      "/tmp/project",
      "r-omp-new-2"
    );
    ctx.sessionManager.attach("telegram:100", remote.id);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/new" },
      ctx
    );

    expect(sent[0]).toContain("only supported for attached OMP sessions");
    expect(ctx.sessionManager.drainRemoteControl(remote.id)).toBeNull();
  });

  it("requires an attached session before /new", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);

    await routeMessage(
      { userId: "telegram:1", chatId: "telegram:100", text: "/new" },
      ctx
    );

    expect(sent[0]).toContain("Use /change_session or /session first");
  });
});
