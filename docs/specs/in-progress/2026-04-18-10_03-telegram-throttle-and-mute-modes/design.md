# Telegram Throttle and Mute Modes - Technical Design

## Architecture Overview
The design introduces a new Telegram chat-side delivery-control layer that sits alongside existing output-format controls.

Current behavior conflates three concerns:
- transcript formatting (`/output_mode`)
- output suppression (`/mute`)
- delivery cadence (`/throttle`, currently miswired as `/output_mode`)

This design separates them into two distinct domains:
- `output` preferences continue to control how messages are formatted
- `delivery` preferences control when bridge output is delivered to a chat

The system will use one canonical per-chat delivery representation with three modes:
- `immediate` — current default behavior
- `throttle` — suppress per-message delivery and emit brief summaries on a preset cadence, with immediate flushes when it becomes the user's turn
- `mute` — suppress bridge output entirely until timed expiry or manual disable; permanent mute may emit a delayed awaiting-user notice

The implementation is split across four layers:
1. Telegram command layer for `/throttle`, `/mute`, `/unmute`, help text, and command menus
2. Persistent config schema for per-chat delivery state
3. Daemon-side delivery gate that decides whether an outbound bridge event is delivered immediately, buffered, summarized, or suppressed
4. Replay/summary builder that can emit brief summaries plus 3 full recent messages on flush, expiry, or delayed handoff

Command acknowledgements remain immediate. Delivery controls apply to bridge output from live sessions, not to the user’s own control commands.

## Interface Design
### Telegram commands
#### `/throttle`
Purpose:
- Configure throttled delivery for the current Telegram chat

Behavior:
- With no arguments, opens a preset picker for throttle intervals
- With a supported preset token, applies the throttle preset directly
- With an off/disable token, returns the chat to `immediate` mode
- Returns a confirmation message describing the active delivery mode

Supported outcome-level command forms:
- `/throttle`
- `/throttle 1m`
- `/throttle 5m`
- `/throttle 15m`
- `/throttle 30m`
- `/throttle off`

Exact accepted aliases are finalized in tasks, but the interface must remain small and discoverable.

#### `/mute`
Purpose:
- Configure timed or permanent mute for the current Telegram chat

Behavior:
- With no arguments, opens a picker with timed presets plus permanent mute
- With a supported preset token, applies the mute mode directly
- Sends an immediate acknowledgement even though subsequent bridge output is suppressed

Supported outcome-level command forms:
- `/mute`
- `/mute 15m`
- `/mute 30m`
- `/mute 1h`
- `/mute forever`

Exact preset set is finalized in tasks/design follow-through, but the design requires timed presets and permanent mute.

#### `/unmute`
Purpose:
- Return the current chat to `immediate` delivery mode

Behavior:
- Clears active mute state
- If the chat was not muted, reports the existing state
- Does not silently preserve a throttle mode underneath mute; mode transitions remain explicit

### Daemon delivery interfaces
#### Delivery mode lookup
The daemon needs a shallow interface that answers:
- what delivery mode is active for a chat now
- whether a timed mode has expired
- whether a flush/summary emission is due

Proposed shape:
```ts
function getChatDeliveryMode(config: TgConfig, chatId: string): ChatDeliveryPreference
```

#### Bridge-output gating
All bridge output paths that are intended for Telegram chat delivery will pass through a single decision layer.

Proposed shape:
```ts
type DeliveryDecision =
  | { kind: "sendNow" }
  | { kind: "bufferForThrottle" }
  | { kind: "suppressForMute" }
  | { kind: "flushThrottleNow"; reason: "interval" | "userTurn" }
  | { kind: "flushMuteNow"; reason: "expiry" | "manualDisable" | "awaitingUserNotice" }
```

The decision layer remains internal to the daemon; callers only need to hand off outbound bridge events plus chat/session identifiers.

#### User-turn classifier
The design needs a bounded interface for "it is the user's turn now" without locking in over-complex heuristics at this stage.

Proposed shape:
```ts
function classifyUserTurn(event: ConversationEvent, recent: DisplayEntry[]): UserTurnState
```

Contract:
- returns whether the current event should trigger immediate flush behavior under throttle
- returns whether the event should be remembered as pending user-turn state under mute
- implementation stays augmentable and conservative

### Summary/replay builder
The daemon already has recent-activity replay helpers. The design extends this into a delivery-mode-specific builder.

Proposed shape:
```ts
function buildBufferedDeliveryFlush(
  fmt: Formatter,
  source: SessionHistorySource,
  options: {
    summaryLimit: number;
    replayCount: 3;
    includeThrottleStillActiveNotice?: boolean;
  }
): {
  noticeMessage: string | null;
  summaryMessage: string | null;
  replayMessages: string[];
}
```

Contract:
- summary is brief and bounded
- replay messages are full recent messages, not summary lines
- replay result must include at least one latest assistant/bot message when available

## Data Models
### Canonical persisted delivery preference
The current `ChatPreferences.muted?: boolean` is too weak for timed mute, throttle cadence, expiry bookkeeping, and delayed awaiting-user notices.

The design replaces that with a single canonical `delivery` object under `ChatPreferences`.

Proposed schema:
```ts
type ChatDeliveryPreference =
  | {
      mode: "immediate";
    }
  | {
      mode: "throttle";
      intervalMinutes: 1 | 5 | 15 | 30;
      activatedAt: string;          // ISO timestamp
      lastSummaryAt: string | null; // ISO timestamp of most recent emitted summary
      pendingUserTurnSince: string | null;
    }
  | {
      mode: "mute";
      kind: "timed";
      activatedAt: string;
      mutedUntil: string;           // ISO timestamp
      pendingUserTurnSince: string | null;
    }
  | {
      mode: "mute";
      kind: "permanent";
      activatedAt: string;
      pendingUserTurnSince: string | null;
      lastAwaitingUserNoticeAt: string | null;
    };
```

Changes to `ChatPreferences`:
```ts
interface ChatPreferences {
  output?: Partial<ChatOutputPreferences>;
  delivery?: ChatDeliveryPreference;
}
```

Migration rule:
- legacy `muted: true` migrates to `{ mode: "mute", kind: "permanent", activatedAt: <migration-time-or-best-effort>, pendingUserTurnSince: null, lastAwaitingUserNoticeAt: null }`
- legacy `muted: false` or absent mute state migrates to no `delivery` override, which resolves to `immediate`
- the legacy `muted` field is removed from the canonical representation after migration

### In-memory daemon runtime state
Persisted state answers mode and expiry timestamps, but the daemon also needs bounded in-memory buffers per `(sessionId, chatId)` to build summaries and replay without scanning arbitrary history on every event.

Proposed runtime shape:
```ts
interface BufferedDeliveryEntry {
  at: number;
  role: "assistant" | "user" | "tool";
  fullText: string;
  summaryText: string;
  sourceKind: "assistant" | "toolCall" | "toolResult" | "thinking" | "approvalNeeded" | "question";
  countsForReplay: boolean;
  countsForSummary: boolean;
  countsAsUserTurnCandidate: boolean;
}

interface ChatDeliveryRuntimeState {
  entries: BufferedDeliveryEntry[];
  lastBufferedAt: number | null;
  lastFlushAt: number | null;
}
```

Constraints:
- buffer is bounded by count and age
- runtime state is reconstructible after daemon restart from persisted delivery state plus recent session history

### Pending picker state
The current session manager already stores Telegram poll-backed picker state. The design adds dedicated picker state for delivery controls rather than overloading output-mode pickers.

Preferred model:
```ts
interface PendingThrottlePicker { ... }
interface PendingMutePicker { ... }
```

This keeps delivery controls separate from transcript-format controls.

## Key Components
### 1. Command router
Files:
- `packages/cli/src/bot/command-router.ts`
- `packages/cli/src/bot/handlers/help.ts`
- `packages/cli/src/channels/telegram/channel.ts`

Responsibilities:
- stop routing `/throttle` into `/output_mode`
- dispatch `/throttle`, `/mute`, and `/unmute` to dedicated delivery-control handlers
- update help text and command menu text to reflect separate meanings

Public API:
- route Telegram messages to the correct handler based on command text

Dependencies:
- delivery handlers
- config access helpers
- command menu sync helpers

### 2. Delivery command handlers
Files:
- existing `packages/cli/src/bot/handlers/mute.ts`
- new dedicated throttle handler or unified delivery handler module

Responsibilities:
- show preset pickers
- parse direct preset arguments
- persist delivery preferences
- acknowledge mode changes immediately
- clear typing indicators on mute activation when appropriate

Public API:
- `handleThrottleCommand(...)`
- `handleMuteCommand(...)`
- `handleUnmuteCommand(...)`

Dependencies:
- config schema/store
- session manager picker state
- channel poll/message sending

### 3. Config schema and store
Files:
- `packages/cli/src/config/schema.ts`
- `packages/cli/src/config/store.ts`

Responsibilities:
- define the canonical per-chat `delivery` representation
- load/store/migrate legacy `muted` state
- expose getters/setters that keep delivery mode normalized

Public API:
- `getChatDeliveryMode(...)`
- `setChatDeliveryMode(...)`
- `clearChatDeliveryMode(...)`

Dependencies:
- config file persistence only

### 4. Session manager picker state
File:
- `packages/cli/src/session/manager.ts`

Responsibilities:
- store pending throttle and mute picker metadata
- resolve poll answers back into delivery mode changes

Public API:
- register/get/remove pending throttle picker
- register/get/remove pending mute picker

Dependencies:
- command handlers and poll-answer routing in daemon/router

### 5. Daemon delivery controller
Files:
- `packages/cli/src/daemon/index.ts`
- existing conversation event handlers and helper functions

Responsibilities:
- decide whether each bridge output event is sent immediately, buffered for throttle, or suppressed for mute
- emit scheduled throttle summaries
- emit timed mute expiry summaries/replays
- remember pending user-turn state while muted
- keep command acknowledgements out of suppression logic

Public API:
- internal daemon helper invoked by bridge output paths

Dependencies:
- config delivery preference getters
- session history/replay builder
- channel send APIs
- timer/sweep loop

### 6. Summary and replay builder
Files:
- `packages/cli/src/cli/peek.ts`
- `packages/cli/src/daemon/index.ts`

Responsibilities:
- build short activity summaries for throttle and mute expiry
- extract 3 recent full messages with at least one latest assistant message when available
- reuse existing display-entry parsing and replay logic rather than duplicating message parsing conventions

Public API:
- daemon-local helper(s) that accept chat formatter, session history, and flush reason

Dependencies:
- session JSONL or other recorded session history
- formatter helpers

## User Interaction
### `/throttle` flow
1. User sends `/throttle`
2. Bot responds with a preset picker
3. User selects 1m/5m/15m/30m/off
4. Bot confirms the selected delivery mode
5. While active:
   - periodic brief summaries are emitted on cadence
   - if it becomes the user's turn, bot immediately sends:
     - throttle-still-active notice
     - brief summary
     - 3 full recent messages
6. Throttle remains active until the user disables it

### `/mute` flow
1. User sends `/mute`
2. Bot responds with timed presets plus permanent mute
3. User selects a mode
4. Bot confirms mute activation immediately
5. While active:
   - bridge output is suppressed
   - pending user-turn state is remembered but not delivered
6. If timed mute expires:
   - bot sends brief summary
   - bot sends 3 full recent messages
7. If permanent mute is active and a pending user-turn state persists for at least 1 hour since activation:
   - bot may send one awaiting-user notification
8. `/unmute` returns the chat to immediate delivery mode

### Interaction with existing output controls
- `/output_mode` continues to control formatting only
- `/throttle` and `/mute` control delivery cadence/suppression only
- the confirmation text for each command must make that separation obvious

## External Dependencies
- Telegram Bot API message sending and poll sending already used by the project
- Existing Telegram `sendChatAction("typing")` support remains optional and does not become a requirement for throttle correctness
- No new third-party libraries are required by the design

## Error Handling
- If a delivery-mode configuration cannot be parsed from persisted config, the chat falls back to `immediate` and the invalid state is normalized away on next save.
- If a timed throttle or mute period expires and session history cannot be reconstructed, the daemon sends the best available summary/replay instead of failing silently.
- If summary delivery fails due to Telegram send errors, the mode state must remain intact; the next scheduled opportunity may retry rather than clearing the mode incorrectly.
- If the daemon restarts while timed mute or throttle is active, it recomputes overdue flushes based on persisted timestamps and current time.
- If the user issues `/unmute` while no mute is active, the system returns a clear no-op confirmation.
- If the user issues `/throttle off` while throttle is not active, the system returns a clear no-op confirmation.

## Security
- Delivery-mode changes remain restricted to already-authorized Telegram users/chats under existing pairing/linking rules.
- Per-chat delivery state must not leak across unrelated chats or sessions.
- Replay messages continue to use the existing formatter/escaping path so buffered summaries and replays do not bypass HTML escaping rules.
- No secrets or external credentials are introduced by this feature.

## Configuration
### Persisted config changes
`ChatPreferences` gains canonical delivery state:
- `delivery.mode`
- throttle interval metadata
- mute expiry/permanent metadata
- delayed awaiting-user notification metadata where needed

`ChatOutputPreferences` remains unchanged for transcript formatting.

### Migration
On config load:
- convert legacy `muted?: boolean` into canonical `delivery` state
- preserve existing output formatting preferences unchanged
- remove the need for parallel mute representations

### Defaults
Chats without explicit delivery preferences resolve to:
```ts
{ mode: "immediate" }
```

## Component Interactions
### Throttle interval path
1. Session emits bridge output event
2. Daemon delivery controller checks current chat delivery mode
3. If mode is `throttle`, event is buffered instead of sent immediately
4. Daemon sweep loop sees throttle interval due
5. Summary/replay builder creates brief summary from buffered period
6. Daemon sends summary to chat
7. Daemon updates `lastSummaryAt` and trims runtime buffer

### Throttle user-turn path
1. Session emits bridge output event
2. User-turn classifier marks event as requiring user attention
3. Daemon delivery controller immediately flushes:
   - throttle-still-active notice
   - brief summary
   - 3 full recent messages
4. Throttle mode remains persisted as active
5. Future events continue under throttle unless the user disables it

### Timed mute expiry path
1. Session emits bridge output events while mute is active
2. Daemon suppresses delivery but buffers bounded recent entries
3. Sweep loop sees `mutedUntil <= now`
4. Daemon transitions the chat from timed mute to immediate mode
5. Summary/replay builder creates expiry output
6. Daemon sends brief summary plus 3 full recent messages

### Permanent mute delayed awaiting-user path
1. Session emits event that classifier marks as user-turn state
2. Daemon records pending user-turn timestamp under permanent mute
3. Sweep loop checks whether at least 1 hour has elapsed since mute activation
4. If eligible and not previously notified, daemon sends awaiting-user notice
5. Permanent mute remains active; full output stays suppressed until manual disable

## Platform Considerations
- Telegram bots can reliably send typing indicators for the bot, but user-typing detection is not assumed to be reliable or even available for this design. The feature must work correctly without it.
- Telegram message length limits still apply to summary and replay delivery; replay messages must continue to use the existing send/chunk behavior.
- Telegram poll UX is already used elsewhere in the product and should be reused for preset selection to stay consistent with current command interaction patterns.
- Because daemon restarts are part of normal local-dev behavior, timed delivery modes must be timestamp-based rather than process-lifetime-based.
