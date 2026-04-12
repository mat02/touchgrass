import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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

describe("session command", () => {
  it("shows a short current-session summary without resume details", async () => {
    const sent: string[] = [];
    const ctx = createCtx(sent);
    const root = mkdtempSync(join(tmpdir(), "tg-session-handler-"));

    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        `<agent-soul>\nName: Builder\nPurpose: Ship changes\n</agent-soul>\n`
      );
      ctx.sessionManager.registerRemote(
        "omp --session /tmp/omp-session.jsonl",
        "telegram:100",
        "telegram:1",
        root,
        "r-session01",
        "Docs sync"
      );

      await routeMessage(
        { userId: "telegram:1", chatId: "telegram:100", text: "/session" },
        ctx
      );

      expect(sent[0]).toContain("Current session");
      expect(sent[0]).toContain("Name:");
      expect(sent[0]).toContain("Docs sync");
      expect(sent[0]).toContain("Agent:");
      expect(sent[0]).toContain("Builder");
      expect(sent[0]).toContain("Tool:");
      expect(sent[0]).toContain("omp");
      expect(sent[0]).toContain("Project:");
      expect(sent[0]).toContain(root.split("/").pop() || "");
      expect(sent[0]).not.toContain("Resume picker");
      expect(sent[0]).not.toContain("Restart wrapper");
      expect(sent[0]).not.toContain("touchgrass session ID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
