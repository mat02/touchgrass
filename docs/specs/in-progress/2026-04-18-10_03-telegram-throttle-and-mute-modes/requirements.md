# Telegram Throttle and Mute Modes

## Summary
Define distinct Telegram chat-side delivery modes for `throttle` and `mute` so users can reduce bridge noise without losing important session context. `throttle` should send periodic brief summaries while keeping full output suppressed between intervals, and `mute` should suppress all bridge output for either a timed preset or a permanent state. Both modes must preserve enough recent context to let the user recover quickly when a timed period ends or when the system determines it is the user's turn.

## Problem Statement
The current Telegram command behavior conflates `/throttle` with `/output_mode`, which is not the intended product behavior. Users need two separate controls:

- a throttled mode that reduces message frequency while still surfacing meaningful progress on a preset cadence
- a mute mode that fully suppresses bridge output temporarily or permanently

The current implementation only provides a permanent per-chat mute boolean and output-format controls. It does not provide preset-based throttling, timed mute, periodic summaries, delayed replay, or a coherent policy for what to do when the session reaches a point where user attention is needed.

## User Stories
- As a Telegram user following an active remote session, I want to enable throttling with preset intervals so that I get fewer messages without losing track of progress.
- As a Telegram user who wants full silence for a while, I want to mute a chat for a preset duration or permanently so that the bridge does not interrupt me.
- As a Telegram user returning after a muted or throttled period, I want a concise summary plus recent full messages so that I can quickly recover context.
- As a Telegram user, I want the bridge to surface when it is my turn, so that important handoff moments are not silently buried forever.
- As a maintainer, I want `throttle` and `mute` to be separate product concepts with clear persistence and expiration behavior, so that commands, UI text, and runtime behavior stay coherent.

## Functional Requirements
- [ ] **REQ-001**: The Telegram `/throttle` command SHALL no longer behave as an alias for `/output_mode`.
- [ ] **REQ-002**: The Telegram `/throttle` command SHALL present preset duration options for throttled delivery, including at least 1 minute, 5 minutes, 15 minutes, and 30 minutes.
- [ ] **REQ-003**: When throttling is enabled for a chat, normal bridge output SHALL NOT be forwarded message-by-message during the active throttle interval.
- [ ] **REQ-004**: While throttling is enabled, the bridge SHALL send a brief activity summary to the chat at the selected preset cadence until throttling is disabled.
- [ ] **REQ-005**: The brief throttle summary SHALL describe recent activity without replaying the full raw message stream.
- [ ] **REQ-006**: If the session reaches a state that counts as "it is the user's turn now" while throttling is active, the bridge SHALL immediately send a notification rather than waiting for the next throttle interval.
- [ ] **REQ-007**: The immediate throttled notification SHALL state that the current throttle preset remains active.
- [ ] **REQ-008**: The immediate throttled notification flow SHALL include a brief activity summary and 3 full recent messages.
- [ ] **REQ-009**: The 3 full recent messages replayed by throttle SHALL include at least one most-recent bot/assistant message and MAY include tool-call or other recent conversation messages for the remaining slots.
- [ ] **REQ-010**: Triggering an immediate throttled notification because it is the user's turn SHALL NOT disable throttling automatically.
- [ ] **REQ-011**: The Telegram `/mute` command SHALL present mute options that include timed presets and a permanent mute option.
- [ ] **REQ-012**: The timed mute options SHALL include preset durations, with exact preset values to be defined in design.
- [ ] **REQ-013**: When timed mute is enabled for a chat, the bridge SHALL suppress all bridge output for the selected duration.
- [ ] **REQ-014**: When permanent mute is enabled for a chat, the bridge SHALL suppress all bridge output until the user explicitly disables mute.
- [ ] **REQ-015**: If the session reaches a state that counts as "it is the user's turn now" while mute is active, the bridge SHALL continue suppressing normal output until mute is disabled or, for timed mute, until the mute period expires.
- [ ] **REQ-016**: When a timed mute period expires, the bridge SHALL send a brief activity summary and 3 full recent messages.
- [ ] **REQ-017**: The 3 full recent messages replayed after mute expiry SHALL include at least one most-recent bot/assistant message and MAY include tool-call or other recent conversation messages for the remaining slots.
- [ ] **REQ-018**: Permanent mute MAY emit an "awaiting user" notification, but only if at least 1 hour has passed since permanent mute was enabled.
- [ ] **REQ-019**: The system SHALL persist enough per-chat state to preserve active throttle mode, active mute mode, and any timed expiration information across daemon restarts.
- [ ] **REQ-020**: If a timed throttle or timed mute period expires while the daemon is unavailable and later restarts, the restored state SHALL still resolve to the correct post-expiry behavior rather than silently forgetting the pending summary/replay obligation.
- [ ] **REQ-021**: The command help text, Telegram command menu descriptions, and any in-chat summaries related to `throttle` and `mute` SHALL reflect their new distinct meanings.
- [ ] **REQ-022**: Existing `/mute` and `/unmute` flows SHALL be updated so users can discover and control the new mute modes without conflicting command semantics.
- [ ] **REQ-023**: The requirements for detecting "it is the user's turn now" SHALL remain outcome-focused at this stage and SHALL NOT require provider-specific or overly complex heuristics in the requirements document.
- [ ] **REQ-024**: A Telegram user-typing-based temporary switch to immediate delivery MAY be added only if it is straightforward and reliable on the bot platform; if it is not, the system SHALL function correctly without it.

## Non-Functional Requirements
- Reliability
  - The selected throttle or mute mode must behave predictably across daemon restarts and reconnects.
  - Expiry handling must not silently drop the summary/replay that the user depends on to recover context.
- Compatibility
  - Existing chats without throttle or timed mute state must continue to behave as they do today.
  - New mode state must not break unrelated output controls such as `/output_mode`.
- Usability
  - Preset choices must be easy to understand from Telegram command flows without requiring users to memorize raw configuration syntax.
  - Notifications emitted while throttle or mute is active must explain the current mode clearly enough that users understand why output delivery changed.
- Performance
  - Summary generation and recent-message replay must remain bounded and should rely on recent session history rather than unbounded scans whenever possible.

## Acceptance Criteria
- [ ] **AC-001**: A user invoking `/throttle` is offered throttle presets rather than output-mode presets or output-mode usage text.
- [ ] **AC-002**: A user invoking `/mute` is offered mute options that include timed presets and permanent mute.
- [ ] **AC-003**: While a throttle preset is active, a busy session does not stream normal bridge output message-by-message and instead produces brief summaries at the selected cadence.
- [ ] **AC-004**: If the session reaches a user-turn state during throttling, the chat immediately receives a notice that throttle is still active, a brief summary, and 3 full recent messages.
- [ ] **AC-005**: After the immediate user-turn notification under throttling, the throttle mode remains active until the user disables it.
- [ ] **AC-006**: While a timed mute is active, no bridge output is sent before expiry, even if the session reaches a user-turn state.
- [ ] **AC-007**: When a timed mute expires, the chat receives a brief summary and 3 full recent messages.
- [ ] **AC-008**: While permanent mute is active, normal bridge output remains suppressed indefinitely.
- [ ] **AC-009**: A permanent mute does not emit an "awaiting user" notification until at least 1 hour has elapsed since mute was enabled.
- [ ] **AC-010**: After a daemon restart, active throttle and mute state still behave correctly, including any pending timed-expiry behavior.
- [ ] **AC-011**: Telegram help text and command menu descriptions describe `throttle` and `mute` as separate features rather than aliases of `/output_mode`.

## Out of Scope
- Defining the exact implementation heuristic for detecting every possible "user's turn" state.
- Provider-specific semantic parsing beyond what is necessary to support the required user-facing outcomes.
- Reworking `/output_mode` beyond changes needed to remove `/throttle` from that flow.
- Requiring a Telegram user-typing optimization if it proves unreliable or unavailable to bots.

## Assumptions
- Recent session history is available in a form that can support both brief summaries and replay of 3 full recent messages.
- The project can persist additional per-chat delivery-mode state alongside existing chat preferences.
- The exact timed mute preset list may differ from the throttle preset list if design finds a better product fit.
- "3 full recent messages" refers to conversation/history items suitable for chat replay, not arbitrary raw terminal chunks.

## Dependencies
- Telegram command routing and menu wiring in `packages/cli/src/bot/command-router.ts`, `packages/cli/src/bot/handlers/help.ts`, and `packages/cli/src/channels/telegram/channel.ts`
- Chat preference and settings persistence in `packages/cli/src/config/schema.ts` and `packages/cli/src/config/store.ts`
- Existing recent-activity extraction and replay helpers in `packages/cli/src/cli/peek.ts` and `packages/cli/src/daemon/index.ts`
- Existing mute behavior in `packages/cli/src/bot/handlers/mute.ts`
