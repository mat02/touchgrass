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
      planOmpSessionWatchDecision(false, [oldSessionFile], existingFiles)
    ).toEqual({
      nextSessionFile: null,
      replaceCurrent: false,
    });

    const newSessionFile = "/tmp/omp/new.jsonl";
    expect(
      planOmpSessionWatchDecision(false, [newSessionFile, oldSessionFile], existingFiles)
    ).toEqual({
      nextSessionFile: newSessionFile,
      replaceCurrent: false,
    });

    const newerSessionFile = "/tmp/omp/newer.jsonl";
    expect(
      planOmpSessionWatchDecision(
        false,
        [newerSessionFile, newSessionFile, oldSessionFile],
        existingFiles
      )
    ).toEqual({
      nextSessionFile: newerSessionFile,
      replaceCurrent: false,
    });
  });

  it("allows exactly one OMP handoff after an explicit /new request", () => {
    const oldSessionFile = "/tmp/omp/old.jsonl";
    const newSessionFile = "/tmp/omp/new.jsonl";
    const existingFiles = new Set([oldSessionFile, newSessionFile]);

    const handoffDecision = planOmpSessionWatchDecision(
      true,
      [newSessionFile, oldSessionFile],
      existingFiles,
      new Set([oldSessionFile])
    );

    expect(handoffDecision).toEqual({
      nextSessionFile: newSessionFile,
      replaceCurrent: true,
    });

    const pinnedDecision = planOmpSessionWatchDecision(
      true,
      [newSessionFile, oldSessionFile],
      existingFiles
    );

    expect(pinnedDecision).toEqual({
      nextSessionFile: null,
      replaceCurrent: false,
    });

    const manager = createManager();
    const ownerChat = "telegram:100" as ChannelChatId;
    const ownerUser = "telegram:100" as ChannelUserId;
    const boundChat = "telegram:-200:7" as ChannelChatId;
    const remote = manager.registerRemote("omp", ownerChat, ownerUser, "/tmp/repo");
    manager.attach(boundChat, remote.id);
    expect(manager.getBoundChat(remote.id)).toBe(boundChat);

    let activeSessionFile = oldSessionFile;
    if (handoffDecision.nextSessionFile) {
      activeSessionFile = handoffDecision.nextSessionFile;
    }

    expect(activeSessionFile).toBe(newSessionFile);
    expect(manager.getBoundChat(remote.id)).toBe(boundChat);
  });
});
