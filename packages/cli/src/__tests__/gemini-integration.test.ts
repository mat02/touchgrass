import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __cliRunTestUtils } from "../cli/run";

const { extractApprovalPrompt, watchGeminiSessionFile } = __cliRunTestUtils;

function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for Gemini watcher update"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("gemini prompt extraction", () => {
  it("extracts 'Allow execution' prompt and options with command context", () => {
    const ptyOutput = `
╭─── Action Required ──╮
│ ? Shell git diff     │
│                      │
│ git diff             │
│ Allow execution?     │
╰──────────────────────╯
● 1. Allow once
  2. No
`;
    const result = extractApprovalPrompt("gemini", ptyOutput);
    expect(result).not.toBeNull();
    // Should skip UI lines and extract just the command
    expect(result?.promptText).toBe("git diff\n\nAllow execution?");
    expect(result?.pollOptions).toEqual([
      "Allow once",
      "No"
    ]);
  });

  it("extracts 'Approve plan' prompt", () => {
    const ptyOutput = `
Approve plan?
1. Yes
2. No
3. Edit
`;
    const result = extractApprovalPrompt("gemini", ptyOutput);
    expect(result).not.toBeNull();
    expect(result?.promptText).toBe("Approve plan?");
    expect(result?.pollOptions).toEqual(["Yes", "No", "Edit"]);
  });

  it("ignores partial 'Allow' prompts without a question mark", () => {
    const ptyOutput = "Allow exec";
    const result = extractApprovalPrompt("gemini", ptyOutput);
    expect(result).toBeNull();
  });

  it("ignores prompts where options appear before the keyword", () => {
    // This simulates old menu items lingering in the PTY buffer
    const ptyOutput = `
1. Old Option
Allow execution of: 'ls'?
`;
    const result = extractApprovalPrompt("gemini", ptyOutput);
    expect(result).toBeNull();
  });

  it("cleans up TUI artifacts from options", () => {
    const ptyOutput = `
Allow file write?
│ 1. Yes (y)
─ 2. No (n)
`;
    const result = extractApprovalPrompt("gemini", ptyOutput);
    expect(result?.pollOptions).toEqual(["Yes", "No"]);
  });
});

describe("gemini session watcher", () => {
  it("routes new remote Gemini assistant output through conversation events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-gemini-watch-"));
    const sessionFile = join(root, "chat.json");
    try {
      writeFileSync(sessionFile, JSON.stringify({
        messages: [{ type: "gemini", content: "Old assistant text" }],
      }));

      const assistantTexts: string[] = [];
      const events: Array<{ kind: string; text?: string }> = [];
      const watcher = watchGeminiSessionFile(
        sessionFile,
        (text) => assistantTexts.push(text),
        true,
        (event) => events.push(event as { kind: string; text?: string })
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        writeFileSync(sessionFile, JSON.stringify({
          messages: [
            { type: "gemini", content: "Old assistant text" },
            { type: "gemini", content: "New remote reply" },
          ],
        }));
        await waitFor(() => events.length === 1);
      } finally {
        watcher.close();
      }

      expect(events).toEqual([{ kind: "assistant", text: "New remote reply" }]);
      expect(assistantTexts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local Gemini watcher output callback behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-gemini-local-watch-"));
    const sessionFile = join(root, "chat.json");
    try {
      writeFileSync(sessionFile, JSON.stringify({
        messages: [{ type: "gemini", content: "Local reply" }],
      }));

      const assistantTexts: string[] = [];
      const watcher = watchGeminiSessionFile(sessionFile, (text) => assistantTexts.push(text));
      try {
        await waitFor(() => assistantTexts.length === 1);
      } finally {
        watcher.close();
      }

      expect(assistantTexts).toEqual(["Local reply"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});