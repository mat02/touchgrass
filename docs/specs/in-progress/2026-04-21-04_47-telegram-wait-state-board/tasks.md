# Telegram Wait-State Board for Spawned Tasks - Implementation Tasks

## Overview
Implement a dedicated Telegram wait-state experience for explicit spawned-task and subagent waits. The implementation adds a parser-to-daemon wait-state contract, daemon-owned wait-cycle coordination, synchronized per-output Telegram boards, restart-safe active-cycle cleanup, and a periodic typing heartbeat that respects existing chat preferences while leaving ordinary transcript delivery unchanged.

## Batch 1 — Wait-state event normalization and control-server plumbing
- Execution profile: slow
- Review profile: slow
- Rationale: introduces a new parser-to-daemon lifecycle contract that must distinguish structured child-work waits from ordinary transcript activity without breaking existing tool notifications.

- [x] **1.** Add a dedicated wait-state event path from the CLI parser to the daemon
  - [x] **1.1** Extend the parsed session event model in `packages/cli/src/cli/run.ts` with a wait-state collection/callback that is separate from transcript events and background-job events.
  - [x] **1.2** Normalize explicit child-work lifecycle signals from lower-case `task`, upper-case `Task` where the sub-agent identity is known, and Codex `wait` flows into one `WaitStateEvent` shape with `waitGroupKey`, `phase`, and patch-style item updates.
  - [x] **1.3** Ensure the first event for a newly discovered child item carries full identity (`itemKey`, `title`, `agentId`, initial `status`) and later updates preserve omitted fields rather than clearing them.
  - [x] **1.4** Keep ordinary tool-call/result transcript notifications intact so the new wait-state path does not suppress or replace existing transcript delivery.

- [x] **2.** Wire the new wait-state endpoint through the daemon control surface
  - [x] **2.1** Add a dedicated `/remote/:id/wait-state` handler and associated request types in `packages/cli/src/daemon/control-server.ts`.
  - [x] **2.2** Forward normalized wait-state events from `packages/cli/src/cli/run.ts` to the new control-server endpoint without routing them through transcript buffering.
  - [x] **2.3** Reject generic slow tool activity that lacks explicit child-work lifecycle signals so wait boards remain scoped to structured waits only.

## Batch 2 — Daemon wait-cycle coordination, board lifecycle, and heartbeat
- Execution profile: slow
- Review profile: slow
- Rationale: this batch owns the one-active-cycle invariant, multi-output synchronization, finalization semantics, and liveness pulses that are easy to get subtly wrong.

- [x] **3.** Implement daemon-owned logical wait cycles per session
  - [x] **3.1** Add in-memory wait-cycle state in `packages/cli/src/daemon/index.ts` with one active logical cycle per session, tracked open wait groups, per-item status, per-chat heartbeat timing, and finalization state.
  - [x] **3.2** Merge overlapping explicit wait signals into the active cycle for the session rather than creating concurrent active cycles.
  - [x] **3.3** Finalize a cycle only after the closing `finish` event has applied terminal item patches, all open wait groups have been closed, and every tracked item is already in a terminal status.
  - [x] **3.4** Preserve transcript delivery behavior while a wait cycle is active so throttle summaries and ordinary transcript messages continue on their existing paths.

- [x] **4.** Render synchronized Telegram wait boards for active outputs
  - [x] **4.1** Determine all active Telegram outputs currently receiving the session transcript and render the same logical cycle state to each output with per-output message IDs.
  - [x] **4.2** Reuse existing status-board primitives to create/update one pinned active board per output, with silent fallback when pinning is unavailable.
  - [x] **4.3** Render active-board content with overall wait count plus per-task lines containing task title, agent ID, status, and bounded detail when provided.
  - [x] **4.4** On cycle completion, render final-state content that summarizes the overall terminal outcome plus the terminal status of every tracked item, then edit each active board into that final-state record, unpin it, release it from active tracking, and leave the final message in history.

- [x] **5.** Add wait heartbeat behavior that respects chat preferences
  - [x] **5.1** Trigger a 5-second typing pulse every 60 seconds for each active wait-board output whose `typingIndicator` preference is enabled.
  - [x] **5.2** Stop heartbeat pulses immediately when the wait cycle finalizes or when an output no longer receives the session transcript.
  - [x] **5.3** Ensure chats with `typingIndicator` disabled never receive wait-heartbeat typing pulses.

## Batch 3 — Restart safety and persisted active-board cleanup
- Execution profile: slow
- Review profile: slow
- Rationale: restart handling touches persisted board identity and must deterministically prevent stale pinned active boards from surviving daemon restarts.

- [x] **6.** Persist enough active wait-cycle identity to recover safely after daemon restart
  - [x] **6.1** Extend the existing status-board persistence path to track the active wait-cycle index needed to discover in-flight wait boards across Telegram outputs.
  - [x] **6.2** Update active-cycle persistence whenever a wait cycle gains or loses Telegram outputs so restart cleanup knows which boards are still active.
  - [x] **6.3** Remove persisted active-cycle entries only after the cycle has been finalized, unpinned, and released across its tracked outputs.

- [x] **7.** Convert interrupted active waits into explicit terminal history on daemon startup
  - [x] **7.1** On daemon startup, load any persisted active wait-cycle entries and edit those boards to an interruption final state such as `Wait tracking interrupted after daemon restart`.
  - [x] **7.2** Unpin and release interrupted active boards during startup cleanup without requiring parser-side reconstruction.
  - [x] **7.3** Ensure any later resumed explicit wait for the same session creates a new logical cycle and a new board instead of reviving the interrupted one.

## Batch 4 — Regression coverage
- Execution profile: default
- Review profile: default
- Rationale: focused tests can validate the new lifecycle boundaries without reopening the core design beyond the implemented contract.

- [x] **8.** Add focused parser and daemon regression coverage for wait-board behavior
  - [x] **8.1** Add parser/control-server tests covering normalization of explicit `task`, identity-qualified `Task`, and Codex `wait` lifecycles into the dedicated wait-state contract, including resumed-output fallback when prior wait-call metadata is unavailable and may omit titles until fresh child metadata is observed.
  - [x] **8.2** Add daemon tests proving a new active wait cycle creates synchronized boards for all active Telegram outputs and updates them in place as per-task status changes arrive.
  - [x] **8.3** Add daemon tests covering pin-allowed and pin-failure paths, proving active boards pin when possible and continue updating without a user-visible error when pinning is unavailable.
  - [x] **8.4** Add daemon tests proving overlapping explicit wait signals merge into one active cycle and do not create concurrent active cycles.
  - [x] **8.5** Add daemon tests proving generic slow tool calls without explicit wait-state signals do not create a wait board.
  - [x] **8.6** Add daemon tests proving chats with `typingIndicator` enabled receive 5-second pulses every 60 seconds during an active cycle, while chats with the preference disabled receive none.
  - [x] **8.7** Add daemon tests proving transcript delivery and throttle summaries continue while the wait board is active.
  - [x] **8.8** Add daemon tests proving a child-task failure keeps the board active when the main agent still waits on other tasks, and that finalization occurs only when the overall wait ends.
  - [x] **8.9** Add daemon tests proving final boards summarize the terminal outcome and terminal per-item statuses, are unpinned and retained in history, later wait cycles create new boards, and daemon restart cleanup converts stale active boards into interruption finals.

## Completion Summary
| Section | Total | Done | Remaining |
| --- | ---: | ---: | ---: |
| Batch 1 — Wait-state event normalization and control-server plumbing | 2 | 2 | 0 |
| Batch 2 — Daemon wait-cycle coordination, board lifecycle, and heartbeat | 3 | 3 | 0 |
| Batch 3 — Restart safety and persisted active-board cleanup | 2 | 2 | 0 |
| Batch 4 — Regression coverage | 1 | 1 | 0 |
| Overall | 8 | 8 | 0 |
