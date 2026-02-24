#!/usr/bin/env bash
# Session Janitor — orchestrator
# Summarizes old sessions, embeds them into SQLite, archives JSONL files.
# Designed to run daily via launchd at 3 AM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="/tmp/session-janitor.lock"
LOG_DIR="$SCRIPT_DIR/logs"
STATE_FILE="$SCRIPT_DIR/state.json"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/janitor-${TODAY}.log"

# Expand ~ in paths
expand_path() { echo "${1/#\~/$HOME}"; }

CONFIG="$SCRIPT_DIR/config.json"
SESSIONS_DIR=$(expand_path "$(python3 -c "import json; print(json.load(open('$CONFIG'))['sessionsDir'])")")
ARCHIVE_DIR=$(expand_path "$(python3 -c "import json; print(json.load(open('$CONFIG'))['archiveDir'])")")
MIN_AGE_HOURS=$(python3 -c "import json; print(json.load(open('$CONFIG'))['minAgeHours'])")
RETENTION_DAYS=$(python3 -c "import json; print(json.load(open('$CONFIG'))['archiveRetentionDays'])")

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

mkdir -p "$LOG_DIR" "$ARCHIVE_DIR"

# ── Lock ─────────────────────────────────────────────────────────────
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Another janitor is running (PID $LOCK_PID). Exiting." | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

log "=== Session Janitor started ==="

# ── Pre-flight checks ────────────────────────────────────────────────
if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  log "ERROR: Ollama is not running. Starting it..."
  brew services start ollama 2>/dev/null || true
  sleep 5
  if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
    log "FATAL: Cannot reach Ollama. Aborting."
    exit 1
  fi
fi
log "Ollama: OK"

MEMORY_DB=$(expand_path "$(python3 -c "import json; print(json.load(open('$CONFIG'))['memoryDb'])")")
if [ ! -f "$MEMORY_DB" ]; then
  log "FATAL: Memory DB not found at $MEMORY_DB"
  exit 1
fi
log "Memory DB: OK ($MEMORY_DB)"

if [ ! -d "$SESSIONS_DIR" ]; then
  log "FATAL: Sessions dir not found at $SESSIONS_DIR"
  exit 1
fi
log "Sessions dir: OK ($SESSIONS_DIR)"

# ── Load state ────────────────────────────────────────────────────────
if [ ! -f "$STATE_FILE" ]; then
  echo '{"processed":{},"lastRun":null}' > "$STATE_FILE"
fi

# ── Process hook queue first (priority lane) ─────────────────────────
QUEUE_FILE="$SCRIPT_DIR/queue.json"
QUEUED=()
if [ -f "$QUEUE_FILE" ]; then
  QUEUED_FILES=$(python3 -c "
import json, os
q = json.load(open('$QUEUE_FILE'))
state = json.load(open('$STATE_FILE'))
for entry in q.get('entries', []):
    f = entry['sessionFile']
    full = os.path.join('$SESSIONS_DIR', f)
    if os.path.exists(full) and f not in state.get('processed', {}):
        print(full)
")
  while IFS= read -r qf; do
    [ -n "$qf" ] && QUEUED+=("$qf")
  done <<< "$QUEUED_FILES"

  if [ ${#QUEUED[@]} -gt 0 ]; then
    log "Hook queue: ${#QUEUED[@]} sessions queued for priority processing"
  fi

  # Clear the queue after reading (janitor owns it now)
  echo '{"entries":[]}' > "$QUEUE_FILE"
fi

# ── Find eligible sessions (age-based scan) ──────────────────────────
# Eligible: .jsonl files, NOT the most-recently-modified, older than MIN_AGE_HOURS,
# not already processed (check state.json), not .deleted/.reset files
MOST_RECENT=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1 || echo "")
CUTOFF_EPOCH=$(date -v-${MIN_AGE_HOURS}H +%s 2>/dev/null || date -d "-${MIN_AGE_HOURS} hours" +%s)

ELIGIBLE=()
for f in "$SESSIONS_DIR"/*.jsonl; do
  [ -f "$f" ] || continue

  # Skip the most recent (active) session
  [ "$f" = "$MOST_RECENT" ] && continue

  # Skip if already in the queued set
  SKIP=false
  for qf in "${QUEUED[@]}"; do
    [ "$f" = "$qf" ] && SKIP=true && break
  done
  [ "$SKIP" = true ] && continue

  # Skip if already processed
  BASENAME=$(basename "$f")
  IS_PROCESSED=$(python3 -c "
import json
state = json.load(open('$STATE_FILE'))
print('yes' if '$BASENAME' in state.get('processed', {}) else 'no')
")
  [ "$IS_PROCESSED" = "yes" ] && continue

  # Skip if too new (age-based entries only — queued entries bypass this)
  FILE_MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
  [ "$FILE_MTIME" -gt "$CUTOFF_EPOCH" ] && continue

  ELIGIBLE+=("$f")
done

# Merge: queued first, then age-based
ALL_SESSIONS=("${QUEUED[@]}" "${ELIGIBLE[@]}")

log "Found ${#ALL_SESSIONS[@]} sessions to process (${#QUEUED[@]} queued + ${#ELIGIBLE[@]} age-based, skipped active: $(basename "${MOST_RECENT:-none}"))"

if [ ${#ALL_SESSIONS[@]} -eq 0 ]; then
  log "Nothing to process. Exiting."
  # Update lastRun
  python3 -c "
import json, datetime
state = json.load(open('$STATE_FILE'))
state['lastRun'] = datetime.datetime.utcnow().isoformat() + 'Z'
json.dump(state, open('$STATE_FILE', 'w'), indent=2)
"
  exit 0
fi

# ── Process each eligible session ────────────────────────────────────
PROCESSED=0
FAILED=0

for SESSION_FILE in "${ALL_SESSIONS[@]}"; do
  BASENAME=$(basename "$SESSION_FILE")
  SESSION_ID="${BASENAME%.jsonl}"
  log "Processing: $BASENAME"

  # Step 1: Summarize
  SUMMARY_FILE="/tmp/janitor-summary-${SESSION_ID}.md"
  if node "$SCRIPT_DIR/summarize-session.mjs" "$SESSION_FILE" "$SUMMARY_FILE" >> "$LOG_FILE" 2>&1; then
    log "  Summarized: OK"
  else
    log "  ERROR: Summarization failed for $BASENAME"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Step 2: Embed and store
  if node "$SCRIPT_DIR/embed-and-store.mjs" "$SUMMARY_FILE" "$SESSION_ID" >> "$LOG_FILE" 2>&1; then
    log "  Embedded: OK"
  else
    log "  ERROR: Embedding failed for $BASENAME"
    FAILED=$((FAILED + 1))
    rm -f "$SUMMARY_FILE"
    continue
  fi

  # Step 3: Archive — gzip and move
  gzip -c "$SESSION_FILE" > "$ARCHIVE_DIR/${BASENAME}.gz"
  rm "$SESSION_FILE"
  log "  Archived: $ARCHIVE_DIR/${BASENAME}.gz"

  # Clean up temp summary
  rm -f "$SUMMARY_FILE"

  # Update state
  python3 -c "
import json, datetime
state = json.load(open('$STATE_FILE'))
state['processed']['$BASENAME'] = {
  'processedAt': datetime.datetime.utcnow().isoformat() + 'Z',
  'archived': True
}
json.dump(state, open('$STATE_FILE', 'w'), indent=2)
"

  PROCESSED=$((PROCESSED + 1))
done

log "Processed: $PROCESSED, Failed: $FAILED"

# ── Purge old archives ───────────────────────────────────────────────
DELETED_ARCHIVES=0
if [ -d "$ARCHIVE_DIR" ]; then
  find "$ARCHIVE_DIR" -name "*.jsonl.gz" -mtime +${RETENTION_DAYS} -type f | while read -r old_file; do
    rm "$old_file"
    DELETED_ARCHIVES=$((DELETED_ARCHIVES + 1))
    log "  Deleted old archive: $(basename "$old_file")"
  done
fi
log "Purged archives older than ${RETENTION_DAYS}d: $DELETED_ARCHIVES"

# ── Rotate logs ──────────────────────────────────────────────────────
# Delete logs older than 14 days
find "$LOG_DIR" -name "janitor-*.log" -mtime +14 -type f -delete 2>/dev/null || true

# Truncate any log over 100 lines (keep tail)
for lf in "$LOG_DIR"/janitor-*.log; do
  [ -f "$lf" ] || continue
  LINES=$(wc -l < "$lf")
  if [ "$LINES" -gt 100 ]; then
    tail -100 "$lf" > "${lf}.tmp" && mv "${lf}.tmp" "$lf"
  fi
done

# ── Update lastRun ───────────────────────────────────────────────────
python3 -c "
import json, datetime
state = json.load(open('$STATE_FILE'))
state['lastRun'] = datetime.datetime.utcnow().isoformat() + 'Z'
json.dump(state, open('$STATE_FILE', 'w'), indent=2)
"

log "=== Session Janitor finished ==="
