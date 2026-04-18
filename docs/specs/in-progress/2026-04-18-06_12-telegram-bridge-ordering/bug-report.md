# BUG-2026-04-18-01: Telegram bridge scrambles interactive conversational event order

## Summary
When a remote coding session sends interactive conversational events to Telegram with thinking summaries enabled, the bridge can display those events in a scrambled order. Users can receive a final assistant reply before the thinking summary that preceded it, or see tool-call/result notices interleaved after the final reply. This is most disruptive during interactive debugging or investigation turns, where the user has to reconstruct the actual sequence of events from Telegram messages.

The intended fix scope is limited to the conversational bridge stream plus file artifacts that belong to that same conversational flow. Unrelated background/system output may keep its current behavior.

## Severity: High

## Environment
- Repository: `touchgrass`
- Package: `packages/cli`
- Channel: Telegram
- Affected flow: remote session bridge from local JSONL/session events to Telegram chat delivery
- Most visible when `/output_mode thinking` or equivalent thinking summaries are enabled
- Relevant files observed during investigation:
  - `packages/cli/src/cli/run.ts`
  - `packages/cli/src/daemon/index.ts`
  - `packages/cli/src/daemon/control-server.ts`
  - `packages/cli/src/channels/telegram/channel.ts`

## Reproduction Steps
1. Start a remote session bridged to Telegram.
2. Enable a transcript mode that includes thinking summaries.
3. Trigger an interactive turn where the underlying agent emits several chat-visible events in close succession, for example:
   - thinking summary
   - tool call notice
   - tool result summary
   - final assistant reply
4. Observe Telegram delivery during or immediately after that turn.
5. Repeat several times or under slightly variable network timing.

## Expected Behavior
For each target chat, the conversational bridge stream should preserve source order for chat-visible conversational events and related file artifacts. If the underlying agent emits:
1. thinking summary
2. tool call notice
3. tool result summary
4. final assistant reply
5. file artifact

then Telegram should present those items in that same order for that chat.

If one delivery stalls, later conversational events for that chat may proceed only after a short timeout-based skip decision, rather than overtaking the stalled event.

## Actual Behavior
Telegram delivery order is nondeterministic. Users can see sequences such as:
- final assistant reply
- tool call notice
- thinking summary
- another tool call/result notice

This makes interactive turns difficult to follow and forces the user to infer the actual causal order.

## Impact
- Breaks comprehension of interactive remote sessions.
- Makes thinking summaries less trustworthy because they can appear after the reply they were meant to explain.
- Makes tool-call/result notifications noisy instead of informative when they arrive after the assistant has already answered.
- Increases operator error risk during debugging or high-attention workflows because the visible transcript no longer reflects what actually happened.

## Root Cause
The bridge does not have a single ordered delivery pipeline for conversational events.

Observed causes:
- `packages/cli/src/cli/run.ts` parses JSONL messages that can contain both assistant text and thinking, but dispatches assistant text before thinking from the same parsed message.
- In remote mode, assistant text is sent directly from the CLI process to Telegram, while thinking/tool events are forwarded through daemon HTTP endpoints.
- Those sends are fire-and-forget rather than awaited in a shared sequence.
- The daemon-side `sendToChat()` helper also forwards messages without any per-chat ordering queue.
- `TelegramChannel.send()` sends each message independently and does not serialize concurrent conversational sends per chat.

Because conversational events travel over multiple async paths without a shared sequence or queue, normal network and scheduler timing can reorder visible delivery.

## Solution Approach
Introduce a per-session source-ordered conversational bridge event stream and enforce delivery ordering independently per target chat.

Chosen approach:
- Define a bounded conversational event stream for remote sessions that includes:
  - assistant text
  - thinking summaries
  - tool-call notifications
  - tool-result notifications
  - approval prompts if they are part of the same interactive flow
  - file artifacts tied to that conversational flow
- Exclude unrelated background/system output from this queue.
- Assign events source order at the point they are emitted from the watcher/parser path.
- Route those events through one ordered queue per target chat.
- Deliver strictly in order for that chat.
- If one event blocks longer than the configured timeout (target default: about 2 seconds), mark it skipped, optionally emit a skip notice when enabled, and continue with later events.
- Keep skip notices disabled by default and expose the setting through existing `/output_mode` controls.

Rejected alternatives:
- Preserve exact order across every possible chat-visible event in the system. Rejected because it would overreach into unrelated background/system output and enlarge the blast radius.
- Provider-specific turn heuristics. Rejected because they are brittle across Claude/Codex/Kimi and not required to fix the observed bug.
- Silent best-effort retries with no explicit skip path. Rejected because one stuck event could freeze later conversational delivery indefinitely.

## Code Changes
Planned change areas:
- `packages/cli/src/cli/run.ts`
  - Stop emitting conversational events over multiple unordered paths.
  - Ensure source ordering is captured consistently for remote conversational events and file artifacts.
- `packages/cli/src/daemon/control-server.ts`
  - Accept ordered conversational event payloads or equivalent sequence metadata as needed.
- `packages/cli/src/daemon/index.ts`
  - Replace fire-and-forget conversational delivery with a per-chat ordered queue for the scoped event set.
  - Apply timeout/skip behavior and optional skip notices.
  - Keep unrelated background/system messages on their existing delivery path.
- `packages/cli/src/channels/telegram/channel.ts`
  - Support the ordered queue semantics cleanly, including message sends and related file-artifact delivery.
- `packages/cli/src/config/schema.ts`
  - Add output-mode configuration for skipped-event notices, default off.
- `packages/cli/src/bot/handlers/output-mode.ts`
  - Surface the new skipped-event-notice setting via existing output mode controls.
- Tests under `packages/cli/src/__tests__/`
  - Add focused coverage proving ordered conversational delivery, timeout skip behavior, optional notice behavior, and file-artifact ordering.

## Edge Cases
- A single parsed message contains both thinking and final assistant text.
- Multiple tool-call/result events occur between thinking and final text.
- One session is bridged to multiple target chats; each chat must preserve order independently.
- A file artifact is emitted near the end of a conversational turn and must not leap ahead of earlier conversational messages.
- One chat is slow or blocked while another chat for the same session remains healthy.
- Skip notices are disabled; ordering recovery must still continue silently after timeout.
- Plain terminal output batching must remain outside the conversational ordering queue.
- Approval prompts or other interactive notices that belong to the conversational stream must not overtake earlier conversational events.
