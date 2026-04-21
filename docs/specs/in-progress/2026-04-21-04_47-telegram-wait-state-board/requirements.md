# Telegram Wait-State Board for Spawned Tasks

## Summary
Add a Telegram wait-state experience for explicit spawned-task and subagent wait cycles so users can tell when the main agent is intentionally waiting on child work rather than silently stalled. The feature should present a persistent, in-place status board with per-task progress, keep normal transcript delivery behavior intact, and leave behind a final historical record when the wait cycle ends.

## Problem Statement
Today, spawned-task and subagent waits are only visible through ordinary tool-call and tool-result notifications in the chat transcript. That leaves a product gap:

- users cannot easily distinguish “the main agent is waiting on child work” from “the bridge or agent may be hung”
- wait progress is fragmented across normal transcript messages instead of having one stable surface
- active waits can become hard to follow in Telegram, especially when other transcript messages continue to arrive
- completed waits do not leave one clear summary record in history

Users need a dedicated Telegram-side waiting surface for structured child-task waits without suppressing the existing transcript stream.

## User Stories
- As a Telegram user following a remote session, I want a clear waiting board when the main agent is blocked on child tasks, so that I can distinguish intentional waiting from an apparent hang.
- As a Telegram user, I want to see per-task status, titles, and agent IDs in one place, so that I can understand what the agent is waiting on.
- As a Telegram user, I want the waiting board to stay visible while active and remain in history afterward, so that I can both monitor the current state and later review what happened.
- As a Telegram user who keeps throttle enabled, I want the wait board to coexist with ordinary summaries, so that I do not lose either progress context or transcript flow.
- As a maintainer, I want wait-state notifications to be limited to explicit spawned-task/subagent waits, so that the system does not mislabel arbitrary slow tool calls as structured waits.

## Functional Requirements
- [ ] **REQ-001**: The system SHALL create a Telegram wait-state board only for explicit spawned-task or subagent wait cycles, and SHALL NOT treat arbitrary long-running tool calls as wait-board candidates in this phase.
- [ ] **REQ-002**: When the main agent enters an eligible wait cycle, the system SHALL create a new persistent Telegram status board for that specific wait cycle.
- [ ] **REQ-003**: Each distinct wait cycle within the same session SHALL create its own board rather than reusing a previous completed wait board.
- [ ] **REQ-004**: While a wait cycle is active, the board SHALL show an overall waiting summary that includes the number of child tasks or subagents currently being tracked.
- [ ] **REQ-005**: While a wait cycle is active, the board SHALL show one line or row per tracked child item with its task title, agent ID, and current per-task status.
- [ ] **REQ-006**: The active wait board SHALL be pinned by default when the Telegram chat permits pinning.
- [ ] **REQ-007**: If Telegram pinning is unavailable or fails, the wait board SHALL continue working without surfacing a user-visible pin failure error.
- [ ] **REQ-008**: While a wait cycle remains active, the system SHALL update the same board in place as per-task status changes arrive.
- [ ] **REQ-009**: If one tracked child task fails while the main agent is still waiting on other child tasks, the board SHALL remain active and continue tracking the remaining child tasks.
- [ ] **REQ-010**: The system SHALL keep ordinary transcript delivery behavior active while the wait board is present, including existing throttle summaries.
- [ ] **REQ-011**: The presence of an active wait board SHALL NOT suppress normal throttled summaries or other ordinary transcript notifications in this phase.
- [ ] **REQ-012**: While a wait cycle is active, the system SHALL emit a Telegram typing heartbeat pulse lasting 5 seconds every 60 seconds as a liveness hint.
- [ ] **REQ-013**: The typing heartbeat pulse SHALL only run for chats whose existing `typingIndicator` preference is enabled.
- [ ] **REQ-014**: When the main agent stops waiting on the tracked child tasks, the system SHALL update the active board into a final-state record for that wait cycle.
- [ ] **REQ-015**: The final-state record SHALL summarize the terminal outcome of the wait cycle and the terminal status of the tracked child tasks.
- [ ] **REQ-016**: After switching to the final-state record, the system SHALL unpin the board if it had been pinned.
- [ ] **REQ-017**: After a wait board reaches its final state, the system SHALL leave that message in Telegram history and SHALL NOT delete it automatically.
- [ ] **REQ-018**: If the session later enters another eligible wait cycle, the system SHALL create a new active board while leaving prior final-state wait boards intact in history.
- [ ] **REQ-019**: If a session is simultaneously routed to multiple Telegram outputs that are currently receiving its transcript, the system SHALL maintain one logical active wait cycle for that session while rendering synchronized wait-board state to each such output, regardless of whether the output is a DM, linked group, or linked topic.
- [ ] **REQ-020**: The requirements for entering and exiting wait-board state SHALL stay tied to explicit spawned-task/subagent lifecycle signals and SHALL NOT require generic duration-based heuristics in this phase.
- [ ] **REQ-021**: The system SHALL allow at most one logical active wait cycle per session at a time.
- [ ] **REQ-022**: If additional eligible child tasks or overlapping explicit wait signals appear while a session already has an active wait cycle, the system SHALL merge them into that existing active cycle and continue updating the existing wait boards for that cycle rather than creating a second concurrent active cycle.

## Non-Functional Requirements
- Reliability
  - Wait boards must track one coherent wait cycle at a time and must not accidentally merge separate cycles into the same historical record.
  - The system must not create overlapping concurrent active wait cycles for the same session or divergent board state across Telegram outputs for that cycle.
  - Loss of pin permission must degrade gracefully without losing the underlying board updates.
  - A wait board must not become the only source of truth for session progress; ordinary transcript delivery must continue to behave correctly alongside it.
- Usability
  - The active board must be easier to scan than raw transcript messages for understanding what the main agent is waiting on.
  - The final board must remain understandable when read later in chat history without requiring surrounding transcript context.
- Compatibility
  - Chats that have `typingIndicator` disabled must not start showing wait-heartbeat typing pulses.
  - Existing Telegram throttle behavior, background-job boards, and transcript output controls must continue to function unless explicitly changed by design.
- Performance
  - Board updates and heartbeat behavior must remain bounded per active wait cycle and must not require unbounded transcript rescans.

## Acceptance Criteria
- [ ] **AC-001**: When the main agent enters an explicit spawned-task/subagent wait, Telegram receives a new persistent wait board for that cycle.
- [ ] **AC-002**: The active wait board shows the current wait count plus per-task status lines containing task titles and agent IDs.
- [ ] **AC-003**: If pinning is allowed, the active wait board is pinned; if pinning fails, the board still appears and updates without a user-visible error.
- [ ] **AC-004**: While the wait remains active, per-task progress updates are reflected by editing the same board rather than posting a new board each time.
- [ ] **AC-005**: While the wait board is active, ordinary transcript delivery still continues, including existing throttle summaries.
- [ ] **AC-006**: A chat with `typingIndicator` enabled receives a 5-second typing pulse every 60 seconds while the wait board remains active.
- [ ] **AC-007**: A chat with `typingIndicator` disabled does not receive wait-heartbeat typing pulses.
- [ ] **AC-008**: If one child task fails but the main agent keeps waiting on others, the board remains active and continues updating until the overall wait ends.
- [ ] **AC-009**: When the main agent stops waiting, the board is edited into a final-state record, unpinned, and left in history.
- [ ] **AC-010**: If the same session later enters a new wait cycle, Telegram gets a new board for that cycle while the earlier final-state board remains in history.
- [ ] **AC-011**: If a session transcript is being delivered to multiple Telegram outputs at the same time, each active output receives synchronized wait-board state for the same logical wait cycle.
- [ ] **AC-012**: A generic slow or blocking tool call that does not emit an explicit spawned-task/subagent wait lifecycle signal does not create a wait board.
- [ ] **AC-013**: If additional eligible child tasks or overlapping explicit wait signals appear while a wait board is already active for a session, the existing active cycle absorbs them and continues updating the same cycle's boards rather than creating a second concurrent active cycle.

## Out of Scope
- Treating arbitrary slow or blocking tool calls as wait-board candidates in this phase.
- Redesigning ordinary transcript throttling, mute behavior, or tool-call formatting beyond changes needed to coexist with the wait board.
- Defining a generic hang detector or guaranteeing that the heartbeat can distinguish every daemon hang from every model-side stall.
- Replacing existing background-job boards or merging this feature into background-job status as a single unified concept in this phase.

## Assumptions
- Explicit spawned-task/subagent wait lifecycles are observable with enough structure to identify child items, task titles, agent IDs, and terminal outcomes.
- Telegram status boards can be updated in place and unpinned later without needing to repost them as ordinary messages.
- Keeping throttle summaries active alongside the wait board is desirable even when that creates parallel surfaces for progress information.
- The existing `typingIndicator` preference is the correct governing switch for any wait-heartbeat typing behavior.

## Dependencies
- Telegram status-board capabilities in `packages/cli/src/channel/types.ts` and `packages/cli/src/channels/telegram/channel.ts`
- Session delivery and Telegram notification orchestration in `packages/cli/src/daemon/index.ts`
- Existing typing-indicator preference handling in `packages/cli/src/config/schema.ts`, `packages/cli/src/config/store.ts`, and `packages/cli/src/bot/handlers/output-mode.ts`
- Existing task/subagent tool-call and tool-result parsing in `packages/cli/src/cli/run.ts` and `packages/cli/src/daemon/tool-display.ts`
- Existing pinned/unpinned board lifecycle patterns used for background status boards in `packages/cli/src/daemon/index.ts`
