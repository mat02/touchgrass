# ⛳ touchgrass.sh

Use Telegram as a remote controller for Claude Code, Codex, Kimi, Pi, OMP, and more.

- **Zero config** — wraps your existing CLI tools, no new runtime to learn
- **Works from your phone** — send prompts, approve tools, attach files from Telegram
- **Multi-tool** — supports Claude Code, Codex, Pi, OMP, and Kimi out of the box
- **Lightweight** — just a PTY bridge + daemon, auto-starts and auto-stops
- **Fork additions** — improved Telegram output controls, better OMP tool formatting, and safer plan review delivery

## Table of Contents

- [Install](#install)
- [Setup](#setup)
- [How it works](#how-it-works)
- [CLI reference](#touchgrass-cli-reference)
- [FAQ](#faq)
- [Requirements](#requirements)

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/mat02/touchgrass/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/mat02/touchgrass/main/install.ps1 | iex
```

These installers are fetched from this repository and download GitHub release assets from `mat02/touchgrass`.
They do not install upstream `touchgrass.sh` releases.

## Fork-specific changes

- Added OMP session support (`touchgrass omp`) and improved compact Telegram rendering for OMP tool calls
- Reworked Telegram output controls around `/output_mode` presets (`simple`, `thinking`, `verbose`) plus a guided custom wizard and granular setters
- Kept assistant/control-plane updates always visible and improved long OMP plan reviews by sending an attachment when inline delivery would be too large

## Setup

### 1. Setup channel

Create a Telegram bot via [@BotFather](https://t.me/BotFather) (`/newbot`), then:

```bash
touchgrass setup --telegram <bot-token>
```

Pair from Telegram by DMing your bot: `/pair <code>` (the code is printed by `touchgrass setup`).

> **Note:** `tg` works as a shorthand alias for `touchgrass` everywhere.

### 2. Start a CLI session

```bash
touchgrass claude
touchgrass codex
touchgrass pi
touchgrass omp
touchgrass kimi
```

You'll see a banner confirming the session is touchgrass-wrapped:

```
⛳ touchgrass · /start_remote_control to connect from Telegram
```

### 3. Remote control

From any Telegram chat where your bot is present (DM or group), run `/start_remote_control` to pick a session and connect.

For groups: add your bot and disable BotFather group privacy (`/setprivacy` -> Disable) so it can see messages.

### CLI flags

Claude (permission modes + tool/path controls):

```bash
touchgrass claude --dangerously-skip-permissions
touchgrass claude --permission-mode default
touchgrass claude --permission-mode acceptEdits
touchgrass claude --add-dir ../shared-lib
touchgrass claude --allowed-tools "Read,Edit,Bash(git:*)"
touchgrass claude --disallowed-tools "Bash(rm:*)"
```

Codex (sandbox + approval policy):

```bash
touchgrass codex --dangerously-bypass-approvals-and-sandbox
touchgrass codex --sandbox workspace-write --ask-for-approval on-request
touchgrass codex --sandbox workspace-write --ask-for-approval untrusted
```

## How it works

Two processes cooperate:

1. CLI process (`touchgrass claude` / `touchgrass codex` / `touchgrass pi` / `touchgrass omp` / `touchgrass kimi`):
- starts PTY
- watches tool JSONL output (the session files for the CLIs)
- sends output to selected chat destination

2. Daemon:
- auto-starts on demand
- receives channel messages
- routes input into the right session
- auto-stops after 30s idle

### Channels vs sessions

- **Configured channel entry (bot config)**: a Telegram bot definition in `config.json` (token, paired users, linked chats).
  Use: `touchgrass setup --list-channels`, `touchgrass setup --channel <name> --show`, `touchgrass setup --channel <name>`.
- **Runtime chat channel**: a concrete DM/group/topic the daemon can route to right now.
  Use: `touchgrass channels`.
- **Session**: a running bridged CLI process (`touchgrass claude`, `touchgrass codex`, `touchgrass pi`, `touchgrass omp`, `touchgrass kimi`) with an `r-...` id.
  Use: `touchgrass ls`, `touchgrass stop <id>`, `touchgrass kill <id>`, `touchgrass send <id> ...`.

### Telegram commands

- `/start_remote_control` — pick a running session to connect to this chat.
- `/stop_remote_control` — disconnect the current session from this chat.
- `/files` (or `@?<query>`) — inline file picker; select `@path` entries for your next message.
- `@?<query> - <prompt>` — resolve top fuzzy match and send `@path - prompt` directly.
- `/change_session` — switch to a different running session.
- `/output_mode` — show current transcript/extras summary and open the preset picker (`Simple`, `Thinking`, `Verbose`, `Custom`).
- `/output_mode simple|thinking|verbose` — apply transcript presets without resetting background-job or typing-indicator extras.
- `/output_mode thinking off|preview|full` — control thinking visibility.
- `/output_mode tool_calls off|compact|detailed` — control tool-call notifications.
- `/output_mode tool_results off|compact|full` — control tool-result notifications.
- `/output_mode tool_errors on|off`, `/output_mode background_jobs on|off`, `/output_mode typing on|off` — adjust the remaining Telegram delivery controls.
## Touchgrass CLI reference

### Bridge sessions

```bash
touchgrass claude [args]
touchgrass codex [args]
touchgrass pi [args]
touchgrass omp [args]
touchgrass kimi [args]
```

- `touchgrass claude [args]`: run Claude Code with touchgrass bridge.
- `touchgrass codex [args]`: run Codex with touchgrass bridge.
- `touchgrass pi [args]`: run PI with touchgrass bridge.
- `touchgrass omp [args]`: run Oh My Pi with touchgrass bridge.
- `touchgrass kimi [args]`: run Kimi with touchgrass bridge.

### Setup and health

```bash
touchgrass setup
touchgrass init
touchgrass pair
touchgrass doctor
touchgrass config
touchgrass logs
```

- `touchgrass setup`: interactive setup for channel credentials (Telegram token, etc.).
- `touchgrass setup --telegram <token>`: non-interactive setup; validates token, saves config, and prints a pairing code.
- `touchgrass setup --telegram <token> --channel <name>`: add/update a named Telegram bot config entry.
- `touchgrass setup --list-channels`: show configured Telegram channel entries.
- `touchgrass setup --channel <name> --show`: show details for one Telegram channel entry.
- `touchgrass init`: alias for `touchgrass setup`.
- `touchgrass pair`: generate a one-time code to pair your Telegram account in bot DM.
- `touchgrass doctor`: diagnostics for CLI/channel/daemon state.
- `touchgrass config`: print current config paths and resolved settings.
- `touchgrass logs`: show daemon logs.

### Session operations

```bash
touchgrass ls
touchgrass channels
touchgrass links
touchgrass peek <id> [count]
touchgrass stop <id>
touchgrass kill <id>
```

- `touchgrass ls`: list active bridge sessions.
- `touchgrass channels`: list runtime chat channels (DM/groups/topics) available via the daemon.
- `touchgrass links`: list chat link mappings.
- `touchgrass peek <id> [count]`: show latest output chunks for a session.
- `touchgrass stop <id>`: request graceful stop for a session.
- `touchgrass kill <id>`: force-kill a stuck session.

### Sending input and files

```bash
touchgrass send <id> "continue"
touchgrass send --file <id> ./notes.md
```

- `touchgrass send <id> "text"`: inject text input into a running session.
- `touchgrass send --file <id> <path>`: send a local file to the linked channel for that session.

## FAQ

**Does touchgrass change how Claude/Codex/PI/Kimi/OMP run?**
No. You still run the normal local terminal CLI; touchgrass only bridges the session to Telegram.

**Can I type locally and from chat at the same time?**
Yes, but avoid simultaneous input bursts to prevent interleaving.

**Do the install scripts fetch from upstream touchgrass.sh?**
No. The install commands in this README fetch the installer scripts from `mat02/touchgrass`, and those scripts download release binaries from this same repository’s GitHub releases.

**Does touchgrass include a non-interactive autonomous runtime?**
No. This project is focused on remote terminal control only.

## Requirements

- Bun runtime
- Telegram account
- Local Claude/Codex/PI/Kimi/OMP CLI installed

## License

MIT
