/**
 * Session Janitor Hook
 *
 * Listens for session lifecycle events and queues ended/reset sessions
 * for the janitor to process. This provides a fast-path: instead of
 * waiting for the 3 AM launchd run + 24h age check, sessions are
 * queued immediately when they end.
 *
 * The janitor reads queue.json first and processes those entries
 * with priority (skipping the age check for queued items).
 */

import type { HookHandler } from "../../../../src/hooks/hooks.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
const JANITOR_DIR = join(homedir(), '.openclaw', 'workspace', 'tools', 'session-janitor');
const QUEUE_FILE = join(JANITOR_DIR, 'queue.json');

interface QueueEntry {
  sessionFile: string;
  queuedAt: string;
  reason: string;
  sessionKey?: string;
}

interface Queue {
  entries: QueueEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadQueue(): Queue {
  try {
    if (existsSync(QUEUE_FILE)) {
      return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
    }
  } catch { /* corrupt file, start fresh */ }
  return { entries: [] };
}

function saveQueue(queue: Queue): void {
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * Find session JSONL files sorted by mtime descending.
 * Returns the second-most-recent file (the one that just ended),
 * since the most recent is the new active session.
 */
function findPreviousSession(): string | null {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted') && !f.includes('.reset'))
    .map(f => ({
      name: f,
      path: join(SESSIONS_DIR, f),
      mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  // On command:new or command:reset, the new session is being created.
  // The previous session is the second-most-recent, or the most recent
  // if only one exists (edge case: first session after reset).
  if (files.length >= 2) {
    return files[1].name;
  }

  return null;
}

/**
 * Find the most recently modified session — this is the one that just ended
 * when we get a session:end event (no new session has been created yet).
 */
function findCurrentSession(): string | null {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted') && !f.includes('.reset'))
    .map(f => ({
      name: f,
      path: join(SESSIONS_DIR, f),
      mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.name || null;
}

// ── Hook Handler ─────────────────────────────────────────────────────

const handler: HookHandler = async (event) => {
  const start = performance.now();

  let sessionFile: string | null = null;
  let reason = '';

  switch (event.type) {
    case 'command':
      if (event.action === 'reset' || event.action === 'new') {
        // A new session is being created — queue the previous one
        sessionFile = findPreviousSession();
        reason = `command:${event.action}`;
      }
      break;

    case 'session':
      if (event.action === 'end') {
        // Session just ended — the most recent file is the one that ended
        sessionFile = findCurrentSession();
        reason = 'session:end';
      }
      break;

    default:
      return;
  }

  if (!sessionFile) {
    console.log(`[session-janitor] No previous session to queue (${reason})`);
    return;
  }

  // Check if already queued or already processed
  const queue = loadQueue();
  const alreadyQueued = queue.entries.some(e => e.sessionFile === sessionFile);

  if (alreadyQueued) {
    console.log(`[session-janitor] Already queued: ${sessionFile}`);
    return;
  }

  // Add to queue
  queue.entries.push({
    sessionFile,
    queuedAt: new Date().toISOString(),
    reason,
    sessionKey: event.sessionKey
  });

  // Cap queue at 100 entries (prevent unbounded growth)
  if (queue.entries.length > 100) {
    queue.entries = queue.entries.slice(-100);
  }

  saveQueue(queue);

  const elapsed = (performance.now() - start).toFixed(1);
  console.log(`[session-janitor] Queued ${sessionFile} (${reason}) in ${elapsed}ms`);
};

export default handler;
