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
});
