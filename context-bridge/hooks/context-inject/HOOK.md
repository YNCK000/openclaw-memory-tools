---
name: context-inject
description: "Injects daily memory files into CONTEXT_BRIDGE.md on fresh/compacted sessions"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
      },
  }
---

# Context Inject Hook v3

Injects recent context on new/compacted sessions for seamless continuity.

## How It Works

1. Fires on `agent:bootstrap` (every turn)
2. Counts session JSONL entries — if ≤4, it's a fresh or compacted session
3. Reads `memory/today.md` + `memory/yesterday.md` (the real summaries)
4. Writes `CONTEXT_BRIDGE.md` to workspace

No JSONL parsing for content. No keyword extraction. Just reads the memory files
that the hourly cron agent already wrote with proper LLM summaries.

## Token Budget

- Max 12,000 chars (~3,000 tokens)
- Today gets priority, yesterday gets remainder
- Trims at paragraph boundaries (no mid-word cuts)

## Config

`~/.openclaw/workspace/tools/context-bridge/config.json`
