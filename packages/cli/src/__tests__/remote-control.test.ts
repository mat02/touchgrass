import { describe, expect, it } from "bun:test";
import { mergeRemoteControlAction, parseRemoteControlAction } from "../session/remote-control";

describe("parseRemoteControlAction", () => {
  it("accepts stop and kill", () => {
    expect(parseRemoteControlAction("stop")).toBe("stop");
    expect(parseRemoteControlAction("kill")).toBe("kill");
  });

  it("accepts resume and OMP new action objects", () => {
    expect(
      parseRemoteControlAction({ type: "resume", sessionRef: "abc-123" })
    ).toEqual({ type: "resume", sessionRef: "abc-123" });
    expect(parseRemoteControlAction({ type: "omp-new" })).toEqual({ type: "omp-new" });
  });

  it("rejects invalid values", () => {
    expect(parseRemoteControlAction("STOP")).toBeNull();
    expect(parseRemoteControlAction("")).toBeNull();
    expect(parseRemoteControlAction({ type: "resume" })).toBeNull();
    expect(parseRemoteControlAction({ type: "start", tool: "codex" })).toBeNull();
    expect(parseRemoteControlAction(undefined)).toBeNull();
  });
});

describe("mergeRemoteControlAction", () => {
  it("prefers kill over stop", () => {
    expect(mergeRemoteControlAction(null, "stop")).toBe("stop");
    expect(mergeRemoteControlAction("stop", "kill")).toBe("kill");
    expect(mergeRemoteControlAction("kill", "stop")).toBe("kill");
  });

  it("keeps resume and OMP new requests over stop", () => {
    const resume = { type: "resume", sessionRef: "id-1" } as const;
    const ompNew = { type: "omp-new" } as const;
    expect(mergeRemoteControlAction(null, resume)).toEqual(resume);
    expect(mergeRemoteControlAction(resume, "stop")).toEqual(resume);
    expect(mergeRemoteControlAction(null, ompNew)).toEqual(ompNew);
    expect(mergeRemoteControlAction(ompNew, "stop")).toEqual(ompNew);
  });

  it("keeps kill as the highest priority action", () => {
    const resume = { type: "resume", sessionRef: "id-2" } as const;
    const ompNew = { type: "omp-new" } as const;
    expect(mergeRemoteControlAction("kill", resume)).toBe("kill");
    expect(mergeRemoteControlAction(resume, "kill")).toBe("kill");
    expect(mergeRemoteControlAction("kill", ompNew)).toBe("kill");
  });
});
