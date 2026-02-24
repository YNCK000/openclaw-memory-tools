# OpenClaw Memory Tools

Two complementary systems that give OpenClaw agents persistent memory across sessions: a **hot path** for immediate context on session start, and a **cold path** for long-term searchable archives.

## Architecture

```
                         OpenClaw Agent Session
                        ┌──────────────────────┐
                        │                      │
                        │   agent:bootstrap    │
                        │        │             │
                        │        ▼             │
                        │  ┌───────────┐       │
                        │  │ context-  │       │       ┌─────────────────┐
                        │  │ inject    │───────┼──────▶│ CONTEXT_BRIDGE  │
                        │  │ hook      │       │ write │ .md             │
                        │  └───────────┘       │       └─────────────────┘
           HOT PATH     │        │             │
         (immediate)    │        ▼             │
                        │  bootstrapFiles[]    │
                        │  (~249 tokens)       │
                        │                      │
                        │        ...           │
                        │                      │
                        │  ┌───────────┐       │       ┌─────────────────┐
                        │  │ memory_   │◀──────┼───────│ SQLite FTS5 +   │
                        │  │ search    │       │ query │ vec0 (768-dim)  │
                        │  │ tool      │       │       └────────▲────────┘
                        │  └───────────┘       │                │
                        │                      │                │
                        └──────────┬───────────┘                │
                                   │                            │
             session:end           │                            │
             command:reset         │                            │
             command:new           │                            │
                                   ▼                            │
                        ┌──────────────────────┐                │
           COLD PATH    │  session-janitor     │                │
         (archival)     │  hook                │                │
                        │  ─────────────       │                │
                        │  Queues ended        │                │
                        │  sessions to         │                │
                        │  queue.json          │                │
                        └──────────┬───────────┘                │
                                   │                            │
                                   ▼                            │
                        ┌──────────────────────┐                │
                        │  session-janitor.sh  │                │
                        │  (launchd, daily 3AM)│                │
                        │  ─────────────────── │                │
                        │                      │                │
                        │  1. Read queue.json  │                │
                        │     (priority lane)  │                │
                        │  2. Scan for old     │                │
                        │     sessions (>24h)  │                │
                        │          │           │                │
                        │          ▼           │                │
                        │  ┌──────────────┐    │                │
                        │  │ summarize    │    │                │
                        │  │ (Ollama      │    │                │
                        │  │  qwen3:32b)  │    │                │
                        │  └──────┬───────┘    │                │
                        │         │            │                │
                        │         ▼            │                │
                        │  ┌──────────────┐    │                │
                        │  │ embed +      │────┼────────────────┘
                        │  │ store        │    │  write chunks +
                        │  │ (nomic-      │    │  embeddings
                        │  │  embed-text) │    │
                        │  └──────┬───────┘    │
                        │         │            │
                        │         ▼            │
                        │  gzip + archive      │
                        │  JSONL → .gz         │
                        └──────────────────────┘


  ┌─────────────────────────────────────────────────────────┐
  │                    Data Flow Summary                     │
  ├──────────┬──────────────────────────────────────────────┤
  │ HOT PATH │ Recent daily memory files → topic index      │
  │          │ → injected on fresh session (~249 tokens)    │
  │          │ → model reads full files on demand            │
  ├──────────┼──────────────────────────────────────────────┤
  │ COLD PATH│ Old session JSONL → Ollama summary           │
  │          │ → nomic-embed-text embeddings → SQLite       │
  │          │ → searchable via memory_search tool          │
  ├──────────┼──────────────────────────────────────────────┤
  │ CRON     │ Hourly: summarize main session activity      │
  │          │ → write to memory/YYYY-MM-DD.md              │
  │          │ Daily 3AM: janitor archives old sessions     │
  └──────────┴──────────────────────────────────────────────┘
```

## Components

### Context Bridge (Hot Path)

Provides immediate continuity when a new session starts. Instead of inlining full daily logs, it injects a compact **topic index** (~150-300 tokens) with pointers to full files for on-demand retrieval.

| File | Purpose |
|------|---------|
| `context-bridge/hooks/context-inject/handler.ts` | Bootstrap hook — detects fresh sessions, builds topic index, injects via `bootstrapFiles[]` |
| `context-bridge/scripts/hourly-summary.mjs` | Cron script — extracts last hour of main session conversation for the cron agent to summarize |
| `context-bridge/lib/session-reader.mjs` | Shared JSONL parser (also used by session-janitor) |
| `context-bridge/config.json` | Injection settings: thresholds, paths, char budgets |

**How injection works:**

1. Hook fires on every `agent:bootstrap` event
2. Checks if session is fresh: entry count <= 10 **OR** session file < 2 minutes old
3. Reads today's + yesterday's `memory/YYYY-MM-DD.md` files
4. Extracts `##` headers + ~150 char snippet per topic (max 10 per day)
5. Appends file paths + `memory_search` reminder for deeper retrieval
6. Pushes to `bootstrapFiles[]` for immediate availability

**Fresh session detection:**
- OpenClaw writes ~100 system entries during bootstrap before the hook fires
- Entry count alone is unreliable, so the hook also checks session file age
- Sessions younger than 2 minutes are always treated as fresh

### Session Janitor (Cold Path)

Archives old session transcripts into searchable, embedded summaries in SQLite. Runs daily via launchd with a hook-based priority queue for immediate processing of ended sessions.

| File | Purpose |
|------|---------|
| `session-janitor/session-janitor.sh` | Orchestrator — lock, preflight, process queue + age-based scan, archive, rotate logs |
| `session-janitor/summarize-session.mjs` | Summarizes session JSONL via Ollama `qwen3:32b` |
| `session-janitor/embed-and-store.mjs` | Chunks summaries, embeds via `nomic-embed-text`, writes to SQLite `chunks` + `chunks_fts` tables |
| `session-janitor/hooks/session-janitor/handler.ts` | Lifecycle hook — queues ended sessions to `queue.json` for priority processing |
| `session-janitor/config.json` | Paths, model configs, retention policies |
| `launchd/com.openclaw.session-janitor.plist` | macOS launchd job (daily at 3 AM) |

**Processing pipeline:**

```
session JSONL → summarize (qwen3:32b) → chunk by ## headers
  → embed (nomic-embed-text, 768-dim) → SQLite chunks + FTS5
  → gzip archive → delete original JSONL
```

**Two intake paths:**
- **Hook queue** (fast): `session:end`, `command:reset`, `command:new` events write to `queue.json` — janitor processes these first, skipping the 24h age check
- **Age scan** (fallback): finds JSONL files older than 24h that haven't been processed

## Configuration

### OpenClaw (`openclaw.json`)

The following settings in `agents.defaults` are relevant:

```jsonc
{
  "memorySearch": {
    "query": {
      "minScore": 0.2,  // Default 0.35 is too aggressive for nomic-embed-text
      "hybrid": {
        "vectorWeight": 0.7,
        "textWeight": 0.3
      }
    }
  },
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
}
```

### Context Bridge (`context-bridge/config.json`)

```jsonc
{
  "injection": {
    "maxInjectionChars": 12000,    // Hard cap (~3000 tokens)
    "freshSessionThreshold": 10    // Entry count threshold (age check is the real gate)
  }
}
```

### Session Janitor (`session-janitor/config.json`)

```jsonc
{
  "sessionsDir": "~/.openclaw/agents/main/sessions",
  "archiveDir": "~/.openclaw/agents/main/sessions/archive",
  "memoryDb": "~/.openclaw/memory/main.sqlite",
  "minAgeHours": 24,
  "archiveRetentionDays": 30,
  "summarization": {
    "model": "qwen3:32b",
    "fallbackModel": "llama3.2:3b"
  },
  "embedding": {
    "model": "nomic-embed-text",
    "dimensions": 768
  }
}
```

## Prerequisites

- [OpenClaw](https://openclaw.dev) agent framework
- [Ollama](https://ollama.ai) running locally with `qwen3:32b` and `nomic-embed-text` models
- Node.js 20+
- `better-sqlite3` npm package (install in `session-janitor/`)

## Installation

```bash
# 1. Copy tools to your OpenClaw workspace
cp -r context-bridge/ ~/.openclaw/workspace/tools/context-bridge/
cp -r session-janitor/ ~/.openclaw/workspace/tools/session-janitor/

# 2. Install session-janitor dependencies
cd ~/.openclaw/workspace/tools/session-janitor && npm install

# 3. Register hooks in openclaw.json (under agents.defaults.hooks.internal.load.extraDirs)
# Add both hook directories as shown in Configuration above

# 4. Set memory search minScore to 0.2 in openclaw.json

# 5. Install launchd job for daily janitor runs
cp launchd/com.openclaw.session-janitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.session-janitor.plist

# 6. Restart OpenClaw gateway to load hooks
```

## SQLite Schema

The janitor writes to the existing OpenClaw memory database (`~/.openclaw/memory/main.sqlite`):

- **`chunks`** — text + embedding JSON, with `source: "session-archive"`
- **`chunks_fts`** — FTS5 full-text search index (weighted at 30% in hybrid search)
- **`chunks_vec`** — vec0 virtual table for KNN vector search (768-dim, `nomic-embed-text`)
- **`files`** — file metadata for change tracking

The janitor does NOT write to `chunks_vec` directly — OpenClaw's memory indexer handles the vector table synchronization.

## License

MIT
