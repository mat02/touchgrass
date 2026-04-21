# Telegram Wait-State Board for Spawned Tasks - Technical Design

## Architecture Overview
The feature adds a dedicated wait-state subsystem for explicit spawned-task and subagent waits. It sits alongside, but separate from, the existing transcript delivery and background-job board paths.

The design introduces four cooperating layers:

1. Wait-signal normalization in the CLI session parser
   - converts explicit task/subagent lifecycle tool activity into structured wait-state events
   - keeps ordinary transcript events unchanged so tool-call/result messages can continue flowing normally
2. Daemon-side wait-cycle coordinator
   - owns one logical active wait cycle per session
   - merges overlapping explicit wait signals into the existing active cycle
   - tracks per-task state, cycle heartbeat timing, and finalization
3. Telegram board renderer
   - renders one synchronized per-output board for each active logical cycle
   - pins boards while active, updates them in place, and releases them into history on completion
4. Typing-heartbeat scheduler
   - emits a 5-second Telegram typing pulse every 60 seconds while a cycle remains active
   - respects the existing per-chat `typingIndicator` preference

This subsystem is intentionally not a generic “slow operation detector.” It only activates from explicit spawned-task/subagent lifecycle signals that identify tracked child work.

The design preserves the current transcript pipeline:
- ordinary transcript messages still flow through immediate/throttle/mute delivery rules
- wait boards bypass transcript throttling because they are status surfaces, not transcript messages
- throttled summaries remain enabled while a wait board is active

## Interface Design
### Internal wait-state event interface
The parser-to-daemon contract needs an explicit wait-state interface, separate from transcript `conversation-event` payloads and separate from background-job events.

Preferred shape:
```ts
type WaitItemStatus = "queued" | "running" | "completed" | "failed" | "blocked";

type WaitSignalSource = "omp-task" | "claude-task" | "codex-subagent";

interface WaitItemUpdate {
  itemKey: string;
  title?: string;
  agentId?: string;
  status?: WaitItemStatus;
  detail?: string | null;
}

interface WaitStateEvent {
  cycleSource: WaitSignalSource;
  waitGroupKey: string;
  phase: "startOrUpdate" | "finish";
  items: WaitItemUpdate[];
  summary?: string;
}
```

Transport shape:
```ts
POST /remote/:id/wait-state
{
  cycleSource: "omp-task" | "claude-task" | "codex-subagent",
  waitGroupKey: string,
  phase: "startOrUpdate" | "finish",
  items: [...],
  summary?: string
}
```

Why a dedicated endpoint instead of overloading transcript events:
- wait boards are not transcript content
- wait updates must bypass throttle buffering
- lifecycle handling is closer to existing `/background-job` semantics than to assistant/tool transcript delivery

### Wait-signal normalization rules
The parser layer remains responsible for identifying only explicit child-work waits.

Outcome-level contract:
- lower-case `task` calls/results produce wait-state signals when they represent an explicit spawned-task batch
- upper-case `Task` lifecycle signals produce wait-state signals once the child sub-agent identity is known
- `TaskCreate` / `TaskUpdate` metadata without structured child identity do not produce wait-state signals in this phase
- Codex `wait` is the explicit wait-state signal for subagent tracking; `spawn_agent` may only seed child metadata needed for a later `wait` update
- if a resumed Codex session emits a `wait` result without prior wait-call metadata, the parser falls back to agent-based grouping for that result instead of dropping it; titles may be unavailable in that fallback until fresh child metadata is observed
- generic slow tool calls produce no wait-state signals

Normalization rules:
- the parser emits a stable `waitGroupKey` for each explicit wait batch or gate so overlapping waits can be merged without losing their individual completion boundaries
- the first `startOrUpdate` for a newly discovered child item includes full identity (`itemKey`, `title`, `agentId`) plus an initial `status`
- later `startOrUpdate` events are patch-style updates: omitted fields mean "leave the previously known value unchanged"
- if the source reports additional child items while a cycle is already active, they are emitted as another `startOrUpdate` event and merged into the current cycle
- `finish` is also a patch-carrying event: it may include terminal item updates for the closing wait group, and the daemon applies those patches before any finalization decision
- the parser MUST NOT emit `finish` for a wait group until the cycle state already contains terminal status for every child item attributed to that wait group
- a `finish` event closes only the identified `waitGroupKey`; the logical cycle finishes only when no wait groups remain open
- generic slow tool calls produce no wait-state events even if they take a long time

### Daemon wait-state handler
The daemon needs a shallow internal API that is orthogonal to transcript output:

```ts
handleWaitState(sessionId: string, event: WaitStateEvent): void
```

Responsibilities:
- create a new logical cycle if no active cycle exists for the session
- merge incoming item patches into the active cycle when one already exists
- track which `waitGroupKey` values are still open for the cycle
- finalize the active cycle only when all open wait groups have been closed
- schedule per-output board refreshes
- schedule or suppress heartbeat pulses per target chat

### Board rendering interface
Board rendering is a daemon concern that uses existing Telegram status-board capabilities.

Preferred shape:
```ts
renderWaitBoard(chatId: string, cycle: WaitCycleState): string
renderFinalWaitBoard(chatId: string, cycle: WaitCycleState): string
```

Contract:
- active board rendering and final rendering use the same cycle state
- rendering is deterministic for all active Telegram outputs of the session
- one logical cycle can be rendered to multiple outputs, but all outputs must show synchronized content

### Board release interface
Existing `upsertStatusBoard` and `clearStatusBoard` behavior is sufficient if used in two steps:
1. edit the active board to its final-state content
2. call `clearStatusBoard(..., { unpin: true })` to unpin and forget it while leaving the final message in chat history

No new Telegram API abstraction is required beyond the existing board upsert/clear surface.

## Data Models
### In-memory logical wait cycle
The daemon owns one logical active wait cycle per session.

```ts
interface WaitCycleState {
  cycleId: string;
  sessionId: string;
  sourceFamilies: Set<WaitSignalSource>;
  openWaitGroups: Set<string>;
  status: "active" | "final";
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  items: Map<string, WaitTrackedItem>;
  lastHeartbeatAtByChat: Map<ChannelChatId, number>;
}

interface WaitTrackedItem {
  itemKey: string;
  title: string;
  agentId: string;
  status: WaitItemStatus;
  detail: string | null;
  updatedAt: number;
}
```

Constraints:
- at most one active `WaitCycleState` per `sessionId`
- `cycleId` changes only when a previous cycle has already finalized and a later explicit wait begins
- `openWaitGroups` contains the explicit wait batches that are still keeping the cycle active
- item identity is stable by `itemKey` within a cycle
- omitted fields in a `WaitItemUpdate` never clear previously known values
- per-item status is last-writer-wins for the same `itemKey`
- a cycle is eligible to finalize only when `openWaitGroups.size === 0`

### Per-output board identity
One logical cycle can have multiple rendered Telegram boards, one for each active output currently receiving the session transcript.

Board key shape:
```ts
wait-cycle:${sessionId}:${cycleId}
```

Properties:
- same board key across all Telegram outputs for the same logical cycle
- persisted board registry still stores message identity per `(chatId, boardKey)`
- synchronized content is rendered separately to each output because Telegram message IDs differ per chat

### Persisted active-cycle index
Deterministic restart cleanup needs an explicit persisted record of which wait-cycle board keys are still active.

Preferred shape, stored alongside the existing status-board registry payload:
```ts
interface PersistedActiveWaitCycle {
  sessionId: string;
  cycleId: string;
  boardKey: string;
  activeChatIds: string[];
}
```

Properties:
- updated whenever an active cycle gains or loses Telegram outputs
- removed only after the cycle has been finalized, unpinned, and released across its tracked outputs
- lets daemon startup discover in-flight wait boards without Telegram scanning or parser reconstruction

### Final-state retention
Finalized cycles are not kept as active runtime objects indefinitely.

Retention model:
- while active: cycle exists in the daemon’s `activeWaitCycleBySession`, and its active outputs are mirrored in the persisted active-cycle index
- on finalize: board is edited to final state, unpinned, released from active board tracking, and removed from the active-cycle index
- history retention is provided by the Telegram message itself, not by long-lived active daemon state

Optional short-lived in-memory retention for recently finalized cycles is acceptable only to support immediate cleanup sequencing; it is not required as a user-facing history store.

## Key Components
### 1. CLI session parser (`packages/cli/src/cli/run.ts`)
Responsibilities:
- detect explicit wait lifecycle signals from supported tool families
- emit structured `WaitStateEvent` payloads alongside existing transcript/background-job parsing
- preserve current tool-call/result forwarding for transcript notifications

Public API impact:
- add a new parsed event collection, analogous to `backgroundJobEvents`
- add a new watcher callback, analogous to `onBackgroundJobEvent`
- forward normalized wait-state events to the daemon via `/remote/:id/wait-state`

Dependencies:
- existing tool-call/tool-result parsing logic
- provider-specific tool naming already used for `Task`, `task`, `spawn_agent`, `wait`, and related result paths

### 2. Daemon wait-cycle coordinator (`packages/cli/src/daemon/index.ts`)
Responsibilities:
- maintain `activeWaitCycleBySession`
- merge overlapping explicit wait signals into the existing cycle
- track per-item state transitions
- determine active Telegram targets for the session
- trigger board refresh and finalization
- run heartbeat scheduling per target chat

Public API impact:
- implement `handleWaitState(sessionId, event)`
- expose it through the control server context

Dependencies:
- session attachment/subscription targeting helpers
- existing formatter lookup per chat
- existing status-board persistence helpers already used for background boards

### 3. Telegram status-board integration (`packages/cli/src/channels/telegram/channel.ts`)
Responsibilities:
- no new capability required beyond the current in-place status-board edit, pin, and clear behavior
- preserve current fallback behavior when an old board message becomes non-editable

Public API impact:
- none required if finalization uses `upsertStatusBoard` followed by `clearStatusBoard(unpin: true)`

Dependencies:
- existing `upsertStatusBoard` / `clearStatusBoard` implementation

### 4. Heartbeat scheduler (`packages/cli/src/daemon/index.ts`)
Responsibilities:
- while a wait cycle is active, trigger a 5-second typing pulse every 60 seconds for each target chat that has `typingIndicator` enabled
- stop pulsing when the cycle finalizes or the chat stops receiving the session transcript

Public API impact:
- internal timer/sweep only

Dependencies:
- existing `setTypingForChat(chatId, active)` helper
- per-chat output preference lookup

## User Interaction
### Active wait cycle
When an explicit child-work wait begins:
- Telegram receives a pinned wait board in each active output receiving the session transcript
- the board includes:
  - headline, e.g. “Waiting on 3 tasks”
  - one per-task line with title, agent ID, and current status
  - optional short detail when the source provides a bounded useful reason such as `blocked` detail

The wait board is updated in place as statuses change.

### Heartbeat behavior
While the cycle remains active:
- each eligible chat receives a 5-second typing pulse every 60 seconds
- chats with `typingIndicator = false` receive no pulse
- the board itself remains the primary source of truth; typing is only a liveness hint

### Finalization
When the main agent stops waiting:
- the active board is edited into a final-state message for that cycle
- the final message summarizes overall outcome and final per-task states
- the board is unpinned
- the final message remains in history

### Multiple outputs
If the session transcript is simultaneously delivered to multiple Telegram outputs:
- each active output gets its own rendered message for the same logical cycle
- all rendered messages remain synchronized to the same cycle state
- per-output pin/unpin results can differ, but content and lifecycle remain consistent

### New later wait cycle
If the same session later enters another explicit child-work wait:
- a new logical cycle is created
- a new board key and new Telegram board messages are used
- earlier finalized wait boards remain untouched in history

## External Dependencies
- Telegram status-board editing/pinning semantics from the existing Telegram channel implementation
- existing session-target routing model for bound chats, linked groups, and linked topics
- existing parser knowledge of explicit task/subagent tools in supported providers

No new third-party service dependency is introduced.

## Error Handling
### Missing or partial updates
Expected cases:
- a source emits repeated status updates for the same item
- a source emits additional items after the cycle has already started
- a source emits overlapping explicit wait signals before the existing cycle ends

Recovery strategy:
- merge by `itemKey`
- keep one active logical cycle per session
- treat overlapping explicit wait signals as updates to the existing cycle, not as a second cycle
- require the first event for a newly seen `itemKey` to provide full identity (`title`, `agentId`, initial `status`)
- treat later updates as patches that may omit unchanged fields without clearing prior values

### Pin failures
Expected case:
- Telegram pin permission is unavailable in a group/topic

Recovery strategy:
- keep the board active and editable
- do not surface a user-visible pin failure error
- continue normal lifecycle through finalization

### Board edit failures
Expected case:
- old Telegram message is no longer editable

Recovery strategy:
- rely on existing `upsertStatusBoard` fallback, which sends a fresh board message and optionally unpins the old pinned message
- update persisted board identity to the new message ID

### Daemon restart during active wait
Risk:
- an active pinned wait board could become stale if runtime state disappears mid-cycle

Recovery strategy:
- active wait cycles are not durable product history in v1; only finalized wait boards are historical records
- on daemon startup, the daemon reads the persisted active-cycle index to discover every `wait-cycle:*` board key that was still active before restart
- each indexed active board is immediately edited to a terminal interruption state such as "Wait tracking interrupted after daemon restart", then unpinned and released
- the corresponding active-cycle index entries are removed as part of that release
- if fresh wait-state events later arrive for that session, the daemon creates a new logical cycle and a new active board
- this deterministic release policy avoids leaving stale pinned "active" boards behind after restart

This restart recovery is intentionally explicit rather than best-effort reconstruction. A restart during an active wait ends that tracked cycle and starts a new one if the wait resumes.

## Security
- Wait boards only render data already derived from the local session’s explicit child-work lifecycle.
- No new secrets, credentials, or external authentication paths are introduced.
- Existing chat access boundaries remain authoritative: boards render only to Telegram outputs already eligible to receive that session’s transcript.
- The feature must not broaden cross-chat visibility; synchronized per-output boards apply only to outputs that are already active transcript recipients for that session.

## Configuration
No new user-facing configuration is required for v1.

The feature reuses existing configuration surfaces:
- Telegram transcript routing and chat binding behavior
- per-chat `typingIndicator` preference

Implementation-local constants may define:
- heartbeat cadence: 60 seconds
- heartbeat duration: 5 seconds

These are product constants for this phase, not user-configurable settings.

## Component Interactions
### Active-cycle flow
1. Parser sees an explicit spawned-task/subagent wait signal.
2. Parser emits a `WaitStateEvent` to the daemon.
3. Daemon loads or creates the session’s logical active wait cycle.
4. Daemon merges incoming items/statuses into the cycle.
5. Daemon computes active Telegram outputs for that session.
6. Daemon renders and upserts synchronized boards to each active output.
7. Daemon schedules heartbeat pulses for chats whose `typingIndicator` preference is enabled.
8. Ordinary transcript events continue through the normal delivery pipeline in parallel.

### Finalization flow
1. Parser emits `phase: "finish"` for a specific `waitGroupKey` when the main agent exits that explicit wait batch.
2. Daemon first applies any terminal item patches carried by the `finish` event to the active cycle state.
3. Daemon removes that `waitGroupKey` from the logical cycle's `openWaitGroups`.
4. If other wait groups remain open, the cycle stays active and the existing board is updated in place.
5. When `openWaitGroups` becomes empty, the daemon verifies the cycle already holds terminal status for every tracked item, then marks the logical cycle final.
6. Daemon renders final-state content to each output’s current board message.
7. Daemon unpins and releases each per-output board via `clearStatusBoard(unpin: true)` and removes the persisted active-cycle index entry.
8. Daemon stops heartbeat scheduling for the cycle.
9. Final messages remain in chat history; active runtime tracking is removed.

### Multi-output synchronization
1. Session targeting logic yields all active Telegram outputs currently receiving transcript delivery.
2. Daemon renders one message per output from the same logical cycle state.
3. Per-output message IDs are persisted independently.
4. Content updates remain synchronized because rendering depends only on the shared logical cycle state.

## Platform Considerations
### Telegram DM, group, and topic behavior
- DMs, linked groups, and linked topics all use the same logical cycle semantics.
- Message IDs and pin permissions differ by output, so rendering is synchronized but operationally independent per output.
- Topic-scoped chats must continue using the topic-aware chat identifier model already present in touchgrass.

### Telegram history visibility
- Active boards are pinned when possible to reduce burial in chat history.
- Final boards are unpinned but intentionally left behind as normal Telegram messages so users can find them later.

### Coexistence with existing status boards
The wait-state board is a separate concept from the existing background-job board.

Design stance for this phase:
- do not unify the two systems into a single board
- reuse the same low-level board primitives and persistence patterns
- keep logical board keys distinct so they cannot overwrite one another
