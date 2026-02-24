/**
 * Session Reader
 * Parses OpenClaw session JSONL files
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

// Resolve ~ in paths
function expandPath(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// Parse a single JSONL file
export function parseSessionFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // Skip malformed lines
      console.error(`Skipping malformed line in ${filePath}`);
    }
  }
  
  return entries;
}

// Get the active (current) session file
export function getActiveSessionFile(sessionsDir) {
  const dir = expandPath(sessionsDir);
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted'))
    .map(f => ({
      name: f,
      path: join(dir, f),
      mtime: statSync(join(dir, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);
  
  return files[0] || null;
}

// Get all session files modified within a time window
export function getSessionsInWindow(sessionsDir, windowMs) {
  const dir = expandPath(sessionsDir);
  const cutoff = Date.now() - windowMs;
  
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted'))
    .map(f => ({
      name: f,
      path: join(dir, f),
      mtime: statSync(join(dir, f)).mtime
    }))
    .filter(f => f.mtime.getTime() > cutoff)
    .sort((a, b) => b.mtime - a.mtime);
}

// Extract messages from parsed session
export function extractMessages(entries, options = {}) {
  const {
    roles = ['user', 'assistant'],
    limit = null,
    sinceTimestamp = null
  } = options;
  
  const messages = entries
    .filter(e => e.type === 'message')
    .filter(e => roles.includes(e.message?.role))
    .filter(e => !sinceTimestamp || new Date(e.timestamp) > new Date(sinceTimestamp))
    .map(e => ({
      id: e.id,
      role: e.message.role,
      timestamp: e.timestamp,
      content: extractTextContent(e.message.content)
    }));
  
  if (limit) {
    return messages.slice(-limit);
  }
  return messages;
}

// Extract thinking blocks from parsed session
export function extractThinking(entries, options = {}) {
  const { limit = null, sinceTimestamp = null } = options;
  
  const thinking = [];
  
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    
    if (sinceTimestamp && new Date(entry.timestamp) <= new Date(sinceTimestamp)) continue;
    
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    
    for (const block of content) {
      if (block.type === 'thinking' && block.thinking) {
        thinking.push({
          id: entry.id,
          timestamp: entry.timestamp,
          thinking: block.thinking
        });
      }
    }
  }
  
  if (limit) {
    return thinking.slice(-limit);
  }
  return thinking;
}

// Extract text content from message content array
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

// Get session metadata
export function getSessionMeta(entries) {
  const sessionEntry = entries.find(e => e.type === 'session');
  const modelChanges = entries.filter(e => e.type === 'model_change');
  const lastModel = modelChanges[modelChanges.length - 1];
  
  return {
    id: sessionEntry?.id,
    version: sessionEntry?.version,
    timestamp: sessionEntry?.timestamp,
    cwd: sessionEntry?.cwd,
    currentModel: lastModel?.modelId,
    currentProvider: lastModel?.provider
  };
}

// Get compaction events
export function getCompactions(entries) {
  return entries
    .filter(e => e.type === 'compaction' || e.customType?.includes('compaction'))
    .map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      data: e.data || e
    }));
}

// CLI
if (process.argv[2] === 'test') {
  const sessionsDir = '~/.openclaw/agents/main/sessions';
  const active = getActiveSessionFile(sessionsDir);
  
  if (active) {
    console.log('Active session:', active.name);
    const entries = parseSessionFile(active.path);
    console.log('Total entries:', entries.length);
    
    const meta = getSessionMeta(entries);
    console.log('Session meta:', meta);
    
    const messages = extractMessages(entries, { limit: 5 });
    console.log('\nLast 5 messages:');
    for (const m of messages) {
      console.log(`  [${m.role}] ${m.content.slice(0, 80)}...`);
    }
    
    const thinking = extractThinking(entries, { limit: 3 });
    console.log('\nLast 3 thinking blocks:');
    for (const t of thinking) {
      console.log(`  ${t.thinking.slice(0, 80)}...`);
    }
  } else {
    console.log('No active session found');
  }
}
