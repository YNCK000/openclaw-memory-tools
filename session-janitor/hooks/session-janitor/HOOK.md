---
name: session-janitor
description: "Queues ended/reset sessions for summarization and archival by the session janitor"
metadata:
  openclaw:
    emoji: "🧹"
    events:
      - "command:reset"
      - "command:new"
      - "session:end"
    requires:
      config: ["workspace.dir"]
---

# Session Janitor Hook

Bridges OpenClaw's session lifecycle events to the session janitor's processing queue.

## How It Works

1. Fires on `command:reset`, `command:new`, and `session:end`
2. On session end/reset: identifies the previous session JSONL file
3. Writes the session path to a queue file (`queue.json`) for the janitor to pick up
4. The janitor (via launchd at 3 AM or manual run) processes queued sessions immediately,
   bypassing the 24-hour age check for queued items

## Why This Exists

Without this hook, the janitor relies solely on file age (>24h) to find eligible sessions.
This means:
- Sessions that reset mid-day wait until 3 AM + 24h = up to 48h before archival
- The janitor has to scan all files every run to find eligible ones

With this hook:
- Reset/ended sessions are immediately queued
- The janitor processes queued items first (priority lane)
- Reduces scan overhead on large session directories

## Performance

Target: <10ms (just reads dir listing and writes a small JSON file)
