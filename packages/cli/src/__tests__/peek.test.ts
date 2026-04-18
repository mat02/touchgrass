import { describe, expect, it } from "bun:test";
import { collectEntriesFromRaw, collectRecentActivityPreviewFromRaw } from "../cli/peek";

describe("peek preview helpers", () => {
  it("finds the last assistant message even when recent mixed entries exclude it", () => {
    const lines: string[] = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "assistant message outside recent slice" }] },
      }),
    ];

    for (let i = 0; i < 12; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: `user ${i}` }] },
        })
      );
    }

    const raw = lines.join("\n");
    const preview = collectRecentActivityPreviewFromRaw(raw, 2);

    expect(preview.recentEntries).toEqual([
      { role: "user", text: "user 10" },
      { role: "user", text: "user 11" },
    ]);
    expect(preview.lastAssistantEntry).toEqual({
      role: "assistant",
      text: "assistant message outside recent slice",
    });
    expect(collectEntriesFromRaw(raw, 2)).toEqual(preview.recentEntries);
  });

  it("supports Gemini full-file JSON messages", () => {
    const raw = JSON.stringify({
      messages: [
        { type: "gemini", content: "older assistant" },
        { type: "user", content: "follow-up question" },
        { type: "gemini", content: "latest assistant" },
      ],
    });

    const preview = collectRecentActivityPreviewFromRaw(raw, 2);

    expect(preview.recentEntries).toEqual([
      { role: "user", text: "follow-up question" },
      { role: "assistant", text: "latest assistant" },
    ]);
    expect(preview.lastAssistantEntry).toEqual({ role: "assistant", text: "latest assistant" });
  });

  it("returns null when there is no assistant message", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "u1" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "u2" }] } }),
    ].join("\n");

    const preview = collectRecentActivityPreviewFromRaw(raw, 10);

    expect(preview.recentEntries).toEqual([
      { role: "user", text: "u1" },
      { role: "user", text: "u2" },
    ]);
    expect(preview.lastAssistantEntry).toBeNull();
  });
});
