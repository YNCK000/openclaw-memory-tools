# CLAUDE.md — Operational Context for OpenClaw Memory Tools

This repo contains two tools that give OpenClaw agents persistent memory across sessions. Read this file to understand how everything connects before making changes.

## OpenClaw Platform Overview

OpenClaw is a self-hosted AI agent framework. Key concepts:

- **Agents** — long-running AI instances (main, cto, research). Config at `~/.openclaw/agents/{id}/`
- **Sessions** — JSONL files storing conversation history. One file per session at `~/.openclaw/agents/{agent}/sessions/{uuid}.jsonl`
- **`sessions.json`** — index mapping session keys (e.g., `agent:main:main`) to active session IDs. Always use this to find the main session, not mtime-based file sorting (cron sessions pollute mtime ordering)
- **Gateway** — the main process. Restart it to reload hooks. Config changes to `openclaw.json` are picked up dynamically, but TypeScript hook code requires a gateway restart
- **Hooks** — TypeScript handlers that fire on lifecycle events. Registered via `HOOK.md` frontmatter + `handler.ts` in directories listed under `hooks.internal.load.extraDirs` in `openclaw.json`
- **Cron jobs** — scheduled agent tasks defined in `~/.openclaw/cron/jobs.json`. Run in isolated sessions (separate from main)
- **Memory search** — built-in `memory_search` tool available to all agents. Hybrid search (70% vector / 30% FTS5) over a SQLite database

## Hook System

Hooks are loaded from directories registered in `openclaw.json`:
```json
"hooks": {
  "internal": {
    "load": {
      "extraDirs": [
        "~/.openclaw/workspace/tools/context-bridge/hooks",
        "~/.openclaw/workspace/tools/session-janitor/hooks"
      ]
    }
  }
}
```

Each hook directory contains:
- `HOOK.md` — frontmatter declares which events to listen on
- `handler.ts` — TypeScript handler implementing `HookHandler`

Available events used by these tools:
- `agent:bootstrap` — fires every turn. `event.context.bootstrapFiles` can be populated to inject content into the session
- `session:end` — session closed
- `command:reset` / `command:new` — user issued `/reset` or `/new`

The handler receives an `event` object with `type`, `action`, `context` (including `workspaceDir`, `bootstrapFiles`), and `sessionKey`.

**Important**: Hook TypeScript is compiled once when the gateway starts. Editing `handler.ts` requires a gateway restart. Config files (JSON) are re-read on each invocation via mtime caching.

## SQLite Memory Database

Location: `~/.openclaw/memory/main.sqlite` (WAL mode)

### Schema

```sql
-- Text chunks with embeddings stored as JSON arrays
chunks(id TEXT PK, path, source, start_line, end_line, hash, model, text, embedding, updated_at)

-- FTS5 full-text search index (weighted at 30% in hybrid search)
chunks_fts(text, id, path, source, model, start_line, end_line)

-- vec0 virtual table for KNN vector search (requires sqlite-vec extension)
chunks_vec(id TEXT PK, embedding FLOAT[768])

-- File metadata for change tracking
files(path, source, hash, mtime, size)

-- Query embedding cache
embedding_cache(...)
```

### Key details
- `source` column: `"memory"` for memory files, `"session-archive"` for janitor-processed sessions
- `model` column: `"nomic-embed-text"` (768 dimensions)
- `chunks_vec` requires the `vec0` SQLite extension. OpenClaw bundles it at `{openclaw-install}/node_modules/sqlite-vec-darwin-arm64/vec0.dylib`
- The session janitor writes to `chunks` and `chunks_fts` only. OpenClaw's memory indexer syncs `chunks_vec` from `chunks.embedding`
- All janitor writes use a single SQLite transaction; idempotent (deletes existing data for a path before inserting)

### Memory search config (`openclaw.json`)
```json
"memorySearch": {
  "provider": "openai",
  "remote": { "baseUrl": "http://localhost:11434/v1/", "apiKey": "ollama-local" },
  "model": "nomic-embed-text",
  "query": {
    "minScore": 0.2,
    "hybrid": { "vectorWeight": 0.7, "textWeight": 0.3 }
  }
}
```
- Uses Ollama's OpenAI-compatible endpoint for embeddings
- `minScore: 0.2` is important — the default 0.35 filters out valid results with nomic-embed-text
- OpenClaw's source code applies `DEFAULT_MIN_SCORE = 0.35` if not overridden

## Context Bridge (Hot Path)

**Purpose**: Inject a compact topic index into fresh sessions so the agent has immediate continuity.

### Flow
1. `agent:bootstrap` fires (every turn)
2. Hook reads `sessions.json` to find main session's JSONL file
3. Checks if session is "fresh": entry count <= 10 OR file age < 2 minutes
4. If fresh: reads `memory/YYYY-MM-DD.md` for today + yesterday
5. Extracts `##` headers + ~150 char snippet per topic (max 10 per day)
6. Writes `CONTEXT_BRIDGE.md` to workspace dir
7. Pushes content to `event.context.bootstrapFiles[]` for immediate injection

### Why session age matters
OpenClaw writes ~100 system entries (model config, tool defs, system prompts) during bootstrap before hooks fire. Entry count alone is unreliable for detecting fresh sessions. The 2-minute age check is the real gate.

### Config (`context-bridge/config.json`)
- `freshSessionThreshold: 10` — entry count threshold (secondary check)
- `maxInjectionChars: 12000` — hard cap (~3000 tokens, rarely hit in topic-index mode)
- Paths use `~` and are expanded via `homedir()` at runtime

### Hourly cron dependency
The context bridge reads daily memory files (`memory/YYYY-MM-DD.md`) written by the `hourly-memory-summary` cron job (ID: `86b5a24d`). This cron runs `scripts/hourly-summary.mjs` which extracts the last hour of main session conversation for a cron agent to summarize and append.

**Critical**: `hourly-summary.mjs` must use `sessions.json` to find the main session, not mtime-based sorting. During cron runs, the cron's own isolated session is the most recently modified file.

## Session Janitor (Cold Path)

**Purpose**: Archive old session transcripts into searchable, embedded summaries in SQLite.

### Pipeline
```
session JSONL → summarize (Ollama qwen3:32b) → chunk by ## headers
  → embed (nomic-embed-text, 768-dim) → SQLite chunks + FTS5
  → gzip → sessions/archive/ → delete original JSONL
```

### Two intake paths
1. **Hook queue** (fast): lifecycle events (`session:end`, `command:reset`, `command:new`) write to `queue.json`. Janitor processes these first, skipping the 24h age check
2. **Age scan** (fallback): daily 3 AM launchd sweep finds JSONL files older than 24h

### Key files
- `session-janitor.sh` — orchestrator (lock, preflight, process, archive, rotate logs)
- `summarize-session.mjs` — imports `session-reader.mjs` from context-bridge, summarizes via Ollama
- `embed-and-store.mjs` — chunks, embeds, writes to SQLite (uses `better-sqlite3` npm package)
- `hooks/session-janitor/handler.ts` — queues sessions on lifecycle events
- `queue.json` — priority queue (janitor clears after reading)
- `state.json` — tracks processed sessions to avoid reprocessing

### Safeguards
- Never touches the most recently modified JSONL (active session)
- Lock file at `/tmp/session-janitor.lock` prevents concurrent runs
- Checks Ollama is running before starting
- All SQLite writes in a single transaction
- Archives gzipped, deleted after 30 days
- Logs rotated (truncated to 100 lines, deleted after 14 days)

### launchd schedule
Plist at `~/Library/LaunchAgents/com.openclaw.session-janitor.plist`. Runs daily at 3 AM, before the 4 AM daily session reset.

## Session-Reader (Shared Library)

`context-bridge/lib/session-reader.mjs` is used by both tools. Exports:
- `parseSessionFile(path)` — parses JSONL into structured entries
- `extractMessages(entries)` — filters to user/assistant text content
- `getSessionMeta(entries)` — extracts session ID, date range, message count
- `getActiveSessionFile(sessionsDir)` — finds active session via sessions.json

## Common Pitfalls

1. **Cron sessions pollute mtime sorting** — always use `sessions.json` index to find the main session, never sort by file mtime
2. **Hook code isn't hot-reloaded** — gateway restart required after editing `.ts` files
3. **nomic-embed-text scores are low** — typical hybrid scores are 0.3-0.5. The default `minScore: 0.35` filters out valid results; we use 0.2
4. **Bootstrap writes ~100 entries** — fresh session detection can't rely on entry count alone; use session file age
5. **`chunks_vec` is FLOAT[768]** — must match the embedding model dimensions. Don't mix with 1536-dim models
6. **SQLite WAL mode** — safe for concurrent reads (agent) and writes (janitor), but only one writer at a time
