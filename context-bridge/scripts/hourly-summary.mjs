#!/usr/bin/env node
/**
 * Hourly Summary v2
 * 
 * Reads the last hour of conversation from the active session JSONL,
 * outputs a clean markdown summary for the cron agent to write to daily memory.
 * 
 * The cron agent provides the actual summarization — this script just extracts
 * and formats the raw conversation for the agent to work with.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
const SESSIONS_INDEX = join(SESSIONS_DIR, 'sessions.json');
const ONE_HOUR_MS = 60 * 60 * 1000;

function getActiveSession() {
  // Use sessions.json index to find the main session specifically,
  // instead of picking the most-recently-modified file (which during
  // a cron run would be the cron's own isolated session).
  try {
    const index = JSON.parse(readFileSync(SESSIONS_INDEX, 'utf-8'));
    const mainEntry = index['agent:main:main'];
    if (mainEntry?.sessionId) {
      const filePath = join(SESSIONS_DIR, `${mainEntry.sessionId}.jsonl`);
      if (existsSync(filePath)) {
        return { name: `${mainEntry.sessionId}.jsonl`, path: filePath, mtime: statSync(filePath).mtimeMs };
      }
    }
  } catch { /* fall through to mtime-based fallback */ }

  // Fallback: pick most recently modified, but skip small files (<10KB)
  // which are likely cron/sub-agent sessions
  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted') && !f.includes('.reset'))
    .map(f => ({ name: f, path: join(SESSIONS_DIR, f), mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs, size: statSync(join(SESSIONS_DIR, f)).size }))
    .filter(f => f.size > 10000)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
    .trim();
}

function extractThinking(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c.type === 'thinking' && c.thinking)
    .map(c => c.thinking)
    .join('\n---\n')
    .trim();
}

function main() {
  const session = getActiveSession();
  if (!session) {
    console.log('NO_ACTIVITY');
    return;
  }

  const raw = readFileSync(session.path, 'utf-8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const cutoff = Date.now() - ONE_HOUR_MS;

  const recentMessages = [];
  const recentThinking = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message') continue;

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    if (ts < cutoff) continue;

    const role = entry.message?.role;
    const text = extractText(entry.message?.content);
    const thinking = extractThinking(entry.message?.content);

    if (text) {
      recentMessages.push({ role, text: text.slice(0, 1000), time: new Date(ts).toLocaleTimeString() });
    }
    if (thinking) {
      recentThinking.push(thinking.slice(0, 500));
    }
  }

  if (recentMessages.length === 0) {
    console.log('NO_ACTIVITY');
    return;
  }

  // Output structured conversation for the agent to summarize
  console.log(`CONVERSATION_START`);
  console.log(`Messages: ${recentMessages.length} | Thinking blocks: ${recentThinking.length}`);
  console.log('');

  for (const m of recentMessages) {
    console.log(`[${m.time}] ${m.role.toUpperCase()}: ${m.text}`);
    console.log('');
  }

  if (recentThinking.length > 0) {
    console.log('--- KEY REASONING ---');
    for (const t of recentThinking.slice(-3)) {
      console.log(t);
      console.log('---');
    }
  }

  console.log('CONVERSATION_END');
}

main();
