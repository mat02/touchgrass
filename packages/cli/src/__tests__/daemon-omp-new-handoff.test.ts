import { describe, expect, it } from "bun:test";
import { __daemonTestUtils } from "../daemon/index";
import { SessionManager } from "../session/manager";
import { defaultSettings } from "../config/schema";
import type { ChannelChatId, ChannelUserId } from "../channel/types";

const fmt = {
  bold: (value: string) => value,
  italic: (value: string) => value,
  code: (value: string) => value,
  pre: (value: string) => value,
  link: (value: string) => value,
  escape: (value: string) => value,
  fromMarkdown: (value: string) => value,
};

describe("daemon OMP /new handoff", () => {
  it("detaches the current chat and reuses the remote-control picker flow", async () => {
    const sessionManager = new SessionManager({ ...defaultSettings });
    const ownerChat = "telegram:100" as ChannelChatId;
    const ownerUser = "telegram:100" as ChannelUserId;
    const boundChat = "telegram:-200:7" as ChannelChatId;
    const remote = sessionManager.registerRemote("omp", ownerChat, ownerUser, "/tmp/repo", "r-omp-daemon-1");
    sessionManager.attach(boundChat, remote.id);

    const sentMessages: string[] = [];
    const pollCalls: Array<{ title: string; options: string[] }> = [];
    const syncedChats: string[] = [];
    const channel: any = {
      fmt,
      send: async (_chatId: string, content: string) => sentMessages.push(content),
      sendPoll: async (_chatId: string, title: string, options: string[]) => {
        pollCalls.push({ title, options });
        return { pollId: "poll-1", messageId: "msg-1" };
      },
      setTyping: () => {},
    };

    await __daemonTestUtils.handleConfirmedOmpNewHandoff({
      sessionManager,
      getChannelForChat: () => channel,
      getFormatterForChat: () => fmt as any,
      syncCommandMenuForChat: (chatId) => syncedChats.push(chatId),
    }, remote.id);

    expect(sessionManager.getAttachedRemote(boundChat)).toBeUndefined();
    expect(sentMessages[0]).toContain("/new");
    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]?.title).toContain("Select session");
    expect(sessionManager.getRemoteControlPickerByPollId("poll-1")).toBeDefined();
    expect(syncedChats).toEqual([boundChat]);
  });
});
