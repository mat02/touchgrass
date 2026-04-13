import { describe, expect, it } from "bun:test";
import { defaultSettings } from "../config/schema";
import { __cliRunTestUtils } from "../cli/run";
import { SessionManager } from "../session/manager";
import type { ChannelChatId, ChannelUserId } from "../channel/types";

const { planOmpSessionWatchDecision } = __cliRunTestUtils;

function createManager(): SessionManager {
  return new SessionManager({ ...defaultSettings });
}

describe("OMP session cutover watch planning", () => {
  it("ignores pre-existing OMP logs until a new session file appears", () => {
    const oldSessionFile = "/tmp/omp/old.jsonl";
    const existingFiles = new Set([oldSessionFile]);

    expect(
      planOmpSessionWatchDecision(null, false, [oldSessionFile], existingFiles)
    ).toEqual({
      nextSessionFile: null,
      replaceCurrent: false,
    });

    const newSessionFile = "/tmp/omp/new.jsonl";
    expect(
      planOmpSessionWatchDecision(
        null,
        false,
        [newSessionFile, oldSessionFile],
        existingFiles
      )
    ).toEqual({
      nextSessionFile: newSessionFile,
      replaceCurrent: false,
    });
  });

  it("switches to the newest OMP log while leaving chat binding intact", () => {
    const oldSessionFile = "/tmp/omp/old.jsonl";
    const newSessionFile = "/tmp/omp/new.jsonl";
    const decision = planOmpSessionWatchDecision(
      oldSessionFile,
      true,
      [newSessionFile, oldSessionFile],
      new Set([oldSessionFile, newSessionFile])
    );

    expect(decision).toEqual({
      nextSessionFile: newSessionFile,
      replaceCurrent: true,
    });

    const manager = createManager();
    const ownerChat = "telegram:100" as ChannelChatId;
    const ownerUser = "telegram:100" as ChannelUserId;
    const boundChat = "telegram:-200:7" as ChannelChatId;
    const remote = manager.registerRemote("omp", ownerChat, ownerUser, "/tmp/repo");
    manager.attach(boundChat, remote.id);
    expect(manager.getBoundChat(remote.id)).toBe(boundChat);

    let activeSessionFile = oldSessionFile;
    if (decision.nextSessionFile) {
      activeSessionFile = decision.nextSessionFile;
    }

    expect(activeSessionFile).toBe(newSessionFile);
    expect(manager.getBoundChat(remote.id)).toBe(boundChat);
  });
});
