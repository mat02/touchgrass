# Telegram Throttle and Mute Modes - Implementation Tasks

## Overview
Implement distinct Telegram delivery controls for `throttle` and `mute`, replacing the current `/throttle` alias to `/output_mode` with real throttled delivery and extending mute into timed and permanent modes. The work covers command routing, persistent delivery state, daemon-side delivery gating, bounded summary/replay generation, delayed handoff behavior, migration of legacy mute state, and focused regression coverage.

## Backend
- [x] **1.** Introduce canonical per-chat delivery state in config
  - [x] **1.1** Replace legacy boolean-only mute persistence in `packages/cli/src/config/schema.ts` with a canonical `delivery` representation that supports `immediate`, `throttle`, timed `mute`, and permanent `mute`.
  - [x] **1.2** Add normalized getters/setters for delivery state in `packages/cli/src/config/schema.ts` so daemon and command handlers use one representation instead of ad hoc booleans.
  - [x] **1.3** Update `packages/cli/src/config/store.ts` to load, normalize, and persist the new `delivery` structure.
  - [x] **1.4** Migrate legacy `muted?: boolean` state to canonical delivery state during config load without losing existing chat preferences.
  - [x] **1.5** Add or update config-focused tests for delivery-state persistence, normalization, and legacy mute migration.

- [x] **2.** Add Telegram picker state for throttle and mute controls
  - [x] **2.1** Extend `packages/cli/src/session/manager.ts` with dedicated pending picker state for throttle presets.
  - [x] **2.2** Extend `packages/cli/src/session/manager.ts` with dedicated pending picker state for mute presets.
  - [x] **2.3** Add or update session-manager tests covering registration, lookup, and cleanup of the new picker state.

- [x] **3.** Separate command routing for throttle, mute, and output mode
  - [x] **3.1** Update `packages/cli/src/bot/command-router.ts` so `/throttle` no longer routes into `handleOutputModeCommand(...)`.
  - [x] **3.2** Keep `/output_mode` focused on transcript-format controls only.
  - [x] **3.3** Update `/mute` and `/unmute` routing so mute mode is delivery-mode aware rather than a plain boolean toggle.
  - [x] **3.4** Update command help/menu text in `packages/cli/src/bot/handlers/help.ts` and `packages/cli/src/channels/telegram/channel.ts` so `throttle`, `mute`, and `output_mode` have clearly distinct meanings.
  - [x] **3.5** Add or update router/menu/help tests proving the new command semantics.

- [x] **4.** Implement throttle and mute command handlers
  - [x] **4.1** Add a dedicated throttle command handler that presents preset options with Telegram polls and supports direct preset arguments such as `1m`, `5m`, `15m`, `30m`, and `off`.
  - [x] **4.2** Extend or replace the current mute handler so `/mute` presents timed presets plus permanent mute and `/unmute` returns the chat to `immediate` delivery mode.
  - [x] **4.3** Ensure command acknowledgements are always sent immediately, even when the resulting mode suppresses later bridge output.
  - [x] **4.4** Ensure invalid command arguments return mode-specific usage/help text rather than falling back to `/output_mode` behavior.
  - [x] **4.5** Add focused handler tests covering preset selection, direct arguments, disable flows, and no-op confirmations.

- [x] **5.** Add daemon-side delivery gating for immediate, throttle, and mute modes
  - [x] **5.1** Introduce a daemon delivery controller in `packages/cli/src/daemon/index.ts` that decides whether each outbound bridge event is sent immediately, buffered for throttle, or suppressed for mute.
  - [x] **5.2** Ensure command acknowledgements and other explicit control-command responses are not suppressed by throttle or mute delivery gates.
  - [x] **5.3** Keep the delivery decision bounded to Telegram chat delivery without breaking unrelated runtime behavior.
  - [x] **5.4** Ensure delivery decisions are evaluated per target chat so one chat’s mode does not leak into another chat.

- [x] **6.** Build bounded buffered-summary and replay support
  - [x] **6.1** Extend the existing recent-activity extraction/replay path in `packages/cli/src/cli/peek.ts` and `packages/cli/src/daemon/index.ts` so the daemon can build brief summaries plus 3 full recent messages from session history or bounded runtime buffers.
  - [x] **6.2** Define which event types contribute to summaries, which count toward the 3-message replay, and how to guarantee at least one latest assistant/bot message when available.
  - [x] **6.3** Keep summary generation bounded by count and/or age so it does not require unbounded session scans during normal operation.
  - [x] **6.4** Preserve existing formatter escaping and long-message chunking behavior for replayed full messages.

- [x] **7.** Implement throttle interval summaries and immediate user-turn flushes
  - [x] **7.1** Add scheduling in `packages/cli/src/daemon/index.ts` so throttled chats receive brief summaries on the selected preset cadence.
  - [x] **7.2** Add bounded runtime buffering per `(sessionId, chatId)` so throttle has recent context to summarize and replay.
  - [x] **7.3** Add user-turn-triggered flush behavior under throttle that immediately sends:
    - [x] **7.3.1** a notice that the current throttle preset is still active
    - [x] **7.3.2** a brief summary
    - [x] **7.3.3** 3 full recent messages
  - [x] **7.4** Ensure a user-turn-triggered flush does not disable the active throttle mode.
  - [x] **7.5** Ensure subsequent events continue under throttle unless the user explicitly disables it.

- [x] **8.** Implement timed and permanent mute behavior
  - [x] **8.1** Add timed mute expiry handling in `packages/cli/src/daemon/index.ts` so expiry transitions the chat back to `immediate` mode.
  - [x] **8.2** On timed mute expiry, emit a brief summary plus 3 full recent messages.
  - [x] **8.3** While mute is active, continue buffering bounded recent activity so expiry replay remains useful.
  - [x] **8.4** When a user-turn state occurs during mute, record it without sending immediate output.
  - [x] **8.5** For permanent mute, add delayed awaiting-user notice logic that only becomes eligible after at least 1 hour since mute activation.
  - [x] **8.6** Ensure the delayed awaiting-user notice does not break permanent mute; full output remains suppressed until manual disable.

- [x] **9.** Make delivery modes restart-safe
  - [x] **9.1** Reconstruct active delivery state correctly after daemon restart using persisted timestamps and current time.
  - [x] **9.2** Ensure overdue timed throttle/mute transitions still emit the correct post-expiry summary/replay instead of silently dropping obligations.
  - [x] **9.3** Ensure legacy muted chats migrate cleanly without requiring users to reconfigure delivery modes manually.

## Testing
- [x] **10.** Add focused regression coverage for throttle and mute modes
  - [x] **10.1** Add tests proving `/throttle` opens throttle presets instead of output-mode controls.
  - [x] **10.2** Add tests proving `/mute` opens timed/permanent mute presets.
  - [x] **10.3** Add tests for direct throttle preset commands and throttle disable commands.
  - [x] **10.4** Add tests for timed mute enable, permanent mute enable, and `/unmute` transitions.
  - [x] **10.5** Add daemon tests proving throttle suppresses per-message delivery and emits brief summaries at the configured cadence.
  - [x] **10.6** Add daemon tests proving a user-turn event under throttle immediately emits the active-throttle notice, a brief summary, and 3 full recent messages while keeping throttle active.
  - [x] **10.7** Add daemon tests proving timed mute suppresses all output until expiry and then emits a brief summary plus 3 full recent messages.
  - [x] **10.8** Add daemon tests proving user-turn events during mute are remembered but not delivered immediately.
  - [x] **10.9** Add daemon tests proving permanent mute only emits an awaiting-user notice after the 1-hour threshold.
  - [x] **10.10** Add restart-oriented tests proving persisted delivery state survives daemon restarts and still resolves overdue expiry behavior correctly.
  - [x] **10.11** Add tests verifying replay selection includes at least one latest assistant/bot message when one exists.
  - [x] **10.12** Add tests verifying help text and Telegram command menu wording no longer describe `/throttle` as output-mode shorthand.

## Completion Summary
| Section | Total | Done | Remaining |
| --- | ---: | ---: | ---: |
| Backend | 9 | 9 | 0 |
| Testing | 1 | 1 | 0 |
| Overall | 10 | 10 | 0 |