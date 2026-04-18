import { describe, it, expect } from "bun:test";
import {
  getAllLinkedGroups,
  addLinkedGroup,
  removeLinkedGroup,
  isLinkedGroup,
  updateLinkedGroupTitle,
  getChatOutputPreferences,
  getChatTranscriptPresetLabel,
  getChatMuted,
  setChatOutputPreferences,
  applyChatTranscriptPreset,
  setChatMuted,
  type TgConfig,
  type ChannelConfig,
  type ChatOutputPreferences,
  defaultSettings,
  DEFAULT_CHAT_OUTPUT_PREFERENCES,
} from "../config/schema";

function makeChannel(type: string, groups: ChannelConfig["linkedGroups"] = []): ChannelConfig {
  return {
    type,
    credentials: { botToken: "test-token" },
    pairedUsers: [],
    linkedGroups: groups,
  };
}

function makeConfig(channels: Record<string, ChannelConfig> = {}): TgConfig {
  return { channels, settings: { ...defaultSettings } };
}

describe("getAllLinkedGroups", () => {
  it("returns empty array when no channels", () => {
    const config = makeConfig();
    expect(getAllLinkedGroups(config)).toEqual([]);
  });

  it("returns empty array when channels have no groups", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    expect(getAllLinkedGroups(config)).toEqual([]);
  });

  it("flattens groups across multiple channels", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Group A", linkedAt: "2024-01-01" },
      ]),
      discord: makeChannel("discord", [
        { chatId: "discord:200", title: "Server B", linkedAt: "2024-01-02" },
      ]),
    });
    const groups = getAllLinkedGroups(config);
    expect(groups).toHaveLength(2);
    expect(groups[0].chatId).toBe("telegram:-100");
    expect(groups[1].chatId).toBe("discord:200");
  });

  it("handles channels with undefined linkedGroups", () => {
    const config = makeConfig({
      telegram: { type: "telegram", credentials: {}, pairedUsers: [] } as unknown as ChannelConfig,
    });
    // linkedGroups is undefined — should not throw
    expect(getAllLinkedGroups(config)).toEqual([]);
  });
});

describe("addLinkedGroup", () => {
  it("adds a group to the matching channel", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const result = addLinkedGroup(config, "telegram:-100", "My Group");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups).toHaveLength(1);
    expect(config.channels.telegram.linkedGroups[0].chatId).toBe("telegram:-100");
    expect(config.channels.telegram.linkedGroups[0].title).toBe("My Group");
  });

  it("rejects duplicate chatId", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Existing", linkedAt: "2024-01-01" },
      ]),
    });
    const result = addLinkedGroup(config, "telegram:-100", "Duplicate");
    expect(result).toBe(false);
    expect(config.channels.telegram.linkedGroups).toHaveLength(1);
  });

  it("returns false when no matching channel exists", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const result = addLinkedGroup(config, "discord:200", "Discord Group");
    expect(result).toBe(false);
  });

  it("handles topics (chatIds with thread suffix)", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const result = addLinkedGroup(config, "telegram:-100:42", "Topic Thread");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups[0].chatId).toBe("telegram:-100:42");
  });

  it("initializes linkedGroups array if missing", () => {
    const config = makeConfig({
      telegram: { type: "telegram", credentials: {}, pairedUsers: [] } as unknown as ChannelConfig,
    });
    const result = addLinkedGroup(config, "telegram:-100", "New Group");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups).toHaveLength(1);
  });

  it("adds scoped telegram groups to the matching named channel", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram"),
      ops_bot: makeChannel("telegram"),
    });
    const result = addLinkedGroup(config, "telegram:ops_bot:-100", "Ops Group");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups).toHaveLength(0);
    expect(config.channels.ops_bot.linkedGroups).toHaveLength(1);
    expect(config.channels.ops_bot.linkedGroups[0].chatId).toBe("telegram:ops_bot:-100");
  });
});

describe("removeLinkedGroup", () => {
  it("removes an existing group", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Group A", linkedAt: "2024-01-01" },
        { chatId: "telegram:-200", title: "Group B", linkedAt: "2024-01-02" },
      ]),
    });
    const result = removeLinkedGroup(config, "telegram:-100");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups).toHaveLength(1);
    expect(config.channels.telegram.linkedGroups[0].chatId).toBe("telegram:-200");
  });

  it("returns false when group not found", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const result = removeLinkedGroup(config, "telegram:-999");
    expect(result).toBe(false);
  });

  it("returns false when channel has no linkedGroups", () => {
    const config = makeConfig({
      telegram: { type: "telegram", credentials: {}, pairedUsers: [] } as unknown as ChannelConfig,
    });
    const result = removeLinkedGroup(config, "telegram:-100");
    expect(result).toBe(false);
  });
});

describe("isLinkedGroup", () => {
  it("returns true for a linked group", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Group A", linkedAt: "2024-01-01" },
      ]),
    });
    expect(isLinkedGroup(config, "telegram:-100")).toBe(true);
  });

  it("returns false for an unlinked chatId", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    expect(isLinkedGroup(config, "telegram:-100")).toBe(false);
  });

  it("returns false when no channels exist", () => {
    const config = makeConfig();
    expect(isLinkedGroup(config, "telegram:-100")).toBe(false);
  });

  it("resolves scoped chat IDs against the matching channel", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Default", linkedAt: "2024-01-01" },
      ]),
      ops_bot: makeChannel("telegram", [
        { chatId: "telegram:ops_bot:-100", title: "Ops", linkedAt: "2024-01-01" },
      ]),
    });
    expect(isLinkedGroup(config, "telegram:ops_bot:-100")).toBe(true);
    expect(isLinkedGroup(config, "telegram:other_bot:-100")).toBe(false);
  });
});

describe("updateLinkedGroupTitle", () => {
  it("updates title when it changed", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Old Title", linkedAt: "2024-01-01" },
      ]),
    });
    const result = updateLinkedGroupTitle(config, "telegram:-100", "New Title");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups[0].title).toBe("New Title");
  });

  it("returns false when title is the same", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", title: "Same Title", linkedAt: "2024-01-01" },
      ]),
    });
    const result = updateLinkedGroupTitle(config, "telegram:-100", "Same Title");
    expect(result).toBe(false);
  });

  it("returns false when group not found", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const result = updateLinkedGroupTitle(config, "telegram:-999", "New Title");
    expect(result).toBe(false);
  });

  it("sets title when previously undefined", () => {
    const config = makeConfig({
      telegram: makeChannel("telegram", [
        { chatId: "telegram:-100", linkedAt: "2024-01-01" },
      ]),
    });
    const result = updateLinkedGroupTitle(config, "telegram:-100", "First Title");
    expect(result).toBe(true);
    expect(config.channels.telegram.linkedGroups[0].title).toBe("First Title");
  });
});

describe("chat output preferences", () => {
  it("defaults to the simple transcript preset with extras on", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual(DEFAULT_CHAT_OUTPUT_PREFERENCES);
    expect(getChatTranscriptPresetLabel(config, "telegram:100")).toBe("simple");
  });

  it("applies the thinking transcript preset without changing extras", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    setChatOutputPreferences(config, "telegram:100", {
      ...DEFAULT_CHAT_OUTPUT_PREFERENCES,
      backgroundJobs: false,
      typingIndicator: false,
      orderingNotices: true,
    });

    const changed = applyChatTranscriptPreset(config, "telegram:100", "thinking");
    expect(changed).toBe(true);
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual({
      thinkingMode: "full",
      toolCallMode: "compact",
      toolResultMode: "compact",
      toolErrors: true,
      backgroundJobs: false,
      typingIndicator: false,
      orderingNotices: true,
    });
    expect(getChatTranscriptPresetLabel(config, "telegram:100")).toBe("thinking");
  });

  it("applies the verbose transcript preset", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const changed = applyChatTranscriptPreset(config, "telegram:100", "verbose");
    expect(changed).toBe(true);
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual({
      thinkingMode: "full",
      toolCallMode: "detailed",
      toolResultMode: "full",
      toolErrors: true,
      backgroundJobs: true,
      typingIndicator: true,
      orderingNotices: false,
    });
    expect(getChatTranscriptPresetLabel(config, "telegram:100")).toBe("verbose");
  });

  it("reports custom transcript settings when they do not match a preset", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    setChatOutputPreferences(config, "telegram:100", {
      ...DEFAULT_CHAT_OUTPUT_PREFERENCES,
      toolCallMode: "off",
    });
    expect(getChatTranscriptPresetLabel(config, "telegram:100")).toBe("custom");
  });

  it("reads valid stored partial output preferences", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    config.chatPreferences = {
      "telegram:100": {
        output: {
          thinkingMode: "full",
          backgroundJobs: false,
        },
      },
    };
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual({
      thinkingMode: "full",
      toolCallMode: "compact",
      toolResultMode: "compact",
      toolErrors: true,
      backgroundJobs: false,
      typingIndicator: true,
      orderingNotices: false,
    });
    expect(getChatTranscriptPresetLabel(config, "telegram:100")).toBe("thinking");
  });

  it("falls back to defaults for invalid stored values", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    config.chatPreferences = {
      "telegram:100": {
        output: {
          thinkingMode: "loud",
          toolCallMode: "maybe",
          toolErrors: "yes",
        } as unknown as Partial<ChatOutputPreferences>,
      },
    };
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual(DEFAULT_CHAT_OUTPUT_PREFERENCES);
  });

  it("removes explicit chat preference when resetting to defaults", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    setChatOutputPreferences(config, "telegram:100", {
      ...DEFAULT_CHAT_OUTPUT_PREFERENCES,
      toolResultMode: "full",
    });
    const changed = setChatOutputPreferences(config, "telegram:100", DEFAULT_CHAT_OUTPUT_PREFERENCES);
    expect(changed).toBe(true);
    expect(getChatOutputPreferences(config, "telegram:100")).toEqual(DEFAULT_CHAT_OUTPUT_PREFERENCES);
    expect(config.chatPreferences?.["telegram:100"]).toBeUndefined();
  });
});

describe("chat mute preference", () => {
  it("defaults to unmuted", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    expect(getChatMuted(config, "telegram:100")).toBe(false);
  });

  it("enables and disables mute per chat", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    const enabled = setChatMuted(config, "telegram:100", true);
    expect(enabled).toBe(true);
    expect(getChatMuted(config, "telegram:100")).toBe(true);

    const disabled = setChatMuted(config, "telegram:100", false);
    expect(disabled).toBe(true);
    expect(getChatMuted(config, "telegram:100")).toBe(false);
  });

  it("keeps chat preference when unmuting if output settings are customized", () => {
    const config = makeConfig({ telegram: makeChannel("telegram") });
    setChatMuted(config, "telegram:100", true);
    setChatOutputPreferences(config, "telegram:100", {
      ...DEFAULT_CHAT_OUTPUT_PREFERENCES,
      typingIndicator: false,
    });
    const changed = setChatMuted(config, "telegram:100", false);
    expect(changed).toBe(true);
    expect(getChatMuted(config, "telegram:100")).toBe(false);
    expect(getChatOutputPreferences(config, "telegram:100").typingIndicator).toBe(false);
    expect(config.chatPreferences?.["telegram:100"]).toBeDefined();
  });
});
