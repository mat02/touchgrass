# Telegram bridge conversational ordering - Implementation Tasks

## Overview
Implement an ordered conversational delivery path for Telegram remote-session bridge events so users no longer have to reconstruct interactive turns from scrambled messages. The implementation must preserve source order for conversational events and related file artifacts on a per-target-chat basis, while leaving unrelated background/system output on its existing paths.

The ordered scope includes assistant text, thinking summaries, tool-call notifications, tool-result notifications, approval prompts that belong to the same conversational flow, and related file artifacts. Delivery must be independent per target chat, use a short skip timeout when one event stalls, and support an optional skipped-event notice that is disabled by default and configurable through `/output_mode`.

## Backend
- [x] **1.** Define the ordered conversational bridge event model and source sequencing
  - [x] **1.1** Identify the exact remote-session event types that belong in the ordered conversational stream and document the exclusion of unrelated background/system events.
  - [x] **1.2** Update the JSONL watcher/bridge emission path in `packages/cli/src/cli/run.ts` so conversational events and related file artifacts are emitted through one consistent ordered mechanism.
  - [x] **1.3** Ensure events that originate from the same parsed message preserve their internal source order, including the case where thinking and assistant text coexist in one message.
  - [x] **1.4** Add any sequence metadata or payload reshaping required by the daemon handoff without introducing provider-specific turn heuristics.

- [x] **2.** Add per-chat ordered delivery in the daemon
  - [x] **2.1** Replace fire-and-forget conversational delivery in `packages/cli/src/daemon/index.ts` with a per-target-chat ordered queue for the scoped conversational event set.
  - [x] **2.2** Keep queue behavior independent per target chat for sessions bridged to multiple chats.
  - [x] **2.3** Keep unrelated background/system output on existing delivery paths so plain terminal batching and other non-conversational flows are not serialized behind conversational events.
  - [x] **2.4** Ensure approval prompts and related file artifacts participate in the same ordered conversational flow when they belong to that interactive exchange.

- [x] **3.** Handle blocked deliveries without freezing later conversational events
  - [x] **3.1** Add a configurable ordered-delivery timeout with a default near 2 seconds for the conversational queue.
  - [x] **3.2** When one conversational event exceeds the timeout, mark it skipped for that chat and continue with later ordered events.
  - [x] **3.3** Add optional skipped-event notice emission, disabled by default.
  - [x] **3.4** Make sure timeout/skip handling does not break per-chat independence or leak stalled state between chats.

## Channel and API Wiring
- [x] **4.** Adapt control-server and channel plumbing to support ordered conversational delivery
  - [x] **4.1** Update `packages/cli/src/daemon/control-server.ts` and any related handoff types so ordered conversational events can reach the daemon without splitting across competing paths.
  - [x] **4.2** Update `packages/cli/src/channels/telegram/channel.ts` so message sends and file artifact sends fit the daemon’s ordered conversational queue semantics.
  - [x] **4.3** Preserve existing behavior for non-conversational Telegram output, including output batching and status/background flows.
  - [x] **4.4** Verify that direct assistant sends no longer bypass the ordered conversational path.

## Configuration and Commands
- [x] **5.** Expose skipped-event notice control through existing output settings
  - [x] **5.1** Extend `packages/cli/src/config/schema.ts` with a setting for skipped conversational event notices, default off.
  - [x] **5.2** Persist and load the new setting consistently with existing chat output preferences.
  - [x] **5.3** Update `packages/cli/src/bot/handlers/output-mode.ts` so the setting is configurable through `/output_mode` rather than a new command.
  - [x] **5.4** Update output-mode summaries/prompts so users can discover the new setting without disturbing current presets more than necessary.

## Testing
- [x] **6.** Add focused regression coverage for ordered conversational delivery
  - [x] **6.1** Add tests proving conversational events are delivered in source order for a single chat.
  - [x] **6.2** Add tests covering mixed sequences such as thinking -> tool call -> tool result -> assistant reply -> file artifact.
  - [x] **6.3** Add tests for the same parsed message containing both thinking and assistant text.
  - [x] **6.4** Add tests proving one slow/stuck chat can skip after timeout without blocking another chat for the same session.
  - [x] **6.5** Add tests for skipped-event notices both disabled and enabled.
  - [x] **6.6** Add tests confirming unrelated background/system output still follows its existing non-queued behavior.

## Completion Summary
| Section | Total | Done | Remaining |
| --- | ---: | ---: | ---: |
| Backend | 3 | 3 | 0 |
| Channel and API Wiring | 1 | 1 | 0 |
| Configuration and Commands | 1 | 1 | 0 |
| Testing | 1 | 1 | 0 |
| Overall | 6 | 6 | 0 |
