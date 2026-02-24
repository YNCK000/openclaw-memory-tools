/**
 * Context Inject Hook v4 — Topic Index Mode
 *
 * Fires on agent:bootstrap (every turn). Only injects on fresh/compacted sessions.
 * Instead of inlining full daily memory files, extracts ## topic headers with a
 * short context snippet (~150 chars) each, plus file paths for on-demand retrieval.
 * The model uses memory_search or reads files directly when it needs full detail.
 *
 * Target: <50ms, ~150-300 tokens injected (down from ~800+).
 */

import type { HookHandler } from "../../../../src/hooks/hooks.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.openclaw', 'workspace', 'tools', 'context-bridge', 'config.json');

interface Config {
  injection: {
    hourlyWindowHours: number;
    maxInjectionChars: number;
    freshSessionThreshold: number;
  };
  paths: {
    sessions: string;
    memory: string;
    workspace: string;
    state: string;
  };
}

// ── Caching ──
let cachedConfig: Config | null = null;
let configMtime = 0;

function loadConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const mt = statSync(CONFIG_PATH).mtimeMs;
    if (cachedConfig && mt === configMtime) return cachedConfig;
    cachedConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    configMtime = mt;
    return cachedConfig;
  } catch { return null; }
}

function expandPath(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// ── Session entry counting (lightweight — just counts lines, no full parse) ──

function countSessionEntries(sessionsDir: string): { count: number; sessionId: string | null } {
  const dir = expandPath(sessionsDir);
  if (!existsSync(dir)) return { count: 0, sessionId: null };

  // Use sessions.json index to find the main session, avoiding
  // cron/sub-agent sessions that would always appear "fresh" (≤4 entries)
  let targetFile: string | null = null;
  let targetId: string | null = null;
  try {
    const indexPath = join(dir, 'sessions.json');
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      const mainEntry = index['agent:main:main'];
      if (mainEntry?.sessionId) {
        const filePath = join(dir, `${mainEntry.sessionId}.jsonl`);
        if (existsSync(filePath)) {
          targetFile = filePath;
          targetId = mainEntry.sessionId;
        }
      }
    }
  } catch { /* fall through */ }

  // Fallback to mtime-based
  if (!targetFile) {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted') && !f.includes('.reset'))
      .map(f => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return { count: 0, sessionId: null };
    targetFile = files[0].path;
    targetId = files[0].name.replace('.jsonl', '');
  }

  const content = readFileSync(targetFile, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  return { count: lines.length, sessionId: targetId };
}

// ── Read memory files ──

function readMemoryFile(dir: string, date: string): string {
  const filePath = join(expandPath(dir), `${date}.md`);
  if (!existsSync(filePath)) return '';
  try {
    return readFileSync(filePath, 'utf-8');
  } catch { return ''; }
}

function getDateStrings(): { today: string; yesterday: string } {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);
  const yesterday = yd.toISOString().split('T')[0];
  return { today, yesterday };
}

// ── Extract topic digests from a daily memory file ──
// Pulls ## headers + first ~120 chars of meaningful content after each header.

const MAX_TOPICS_PER_DAY = 10;

function extractTopics(markdown: string): string[] {
  const stripped = markdown.replace(/^# .*\n\n?/, ''); // Remove H1
  const sections = stripped.split(/^(?=## )/m).filter(Boolean);
  const topics: string[] = [];

  for (const section of sections) {
    const lines = section.split('\n');
    const header = (lines[0] || '').replace(/^##\s*/, '').trim();
    if (!header) continue;

    // Grab first few meaningful lines after the header as context snippet
    const bodyLines = lines.slice(1)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('---'));
    let snippet = bodyLines.slice(0, 3).join(' ').replace(/\s+/g, ' ');
    if (snippet.length > 150) snippet = snippet.slice(0, 147) + '...';

    topics.push(snippet ? `- **${header}**: ${snippet}` : `- **${header}**`);
  }

  // No ## headers found — fall back to a raw snippet of the file
  if (topics.length === 0 && stripped.trim()) {
    let raw = stripped.trim().split('\n').slice(0, 4).join(' ').replace(/\s+/g, ' ');
    if (raw.length > 200) raw = raw.slice(0, 197) + '...';
    topics.push(`- ${raw}`);
  }

  // Keep only the most recent topics (last N) to avoid noisy active days
  return topics.slice(-MAX_TOPICS_PER_DAY);
}

// ── Build injection content (topic-index mode) ──

function buildContext(config: Config): string {
  const { today, yesterday } = getDateStrings();
  const memoryDir = expandPath(config.paths.memory);
  const maxChars = config.injection.maxInjectionChars;

  // Read daily memory files
  const todayContent = readMemoryFile(config.paths.memory, today);
  const yesterdayContent = readMemoryFile(config.paths.memory, yesterday);

  if (!todayContent && !yesterdayContent) return '';

  const todayTopics = todayContent ? extractTopics(todayContent) : [];
  const yesterdayTopics = yesterdayContent ? extractTopics(yesterdayContent) : [];

  if (todayTopics.length === 0 && yesterdayTopics.length === 0) return '';

  let content = `# Context Bridge — Session Continuity\n`;
  content += `*Fresh session. Today: ${today}*\n\n`;

  if (todayTopics.length > 0) {
    content += `## Today (${today})\n`;
    content += todayTopics.join('\n') + '\n\n';
  }

  // Only include yesterday if we have room
  if (yesterdayTopics.length > 0 && content.length < maxChars * 0.7) {
    content += `## Yesterday (${yesterday})\n`;
    content += yesterdayTopics.join('\n') + '\n\n';
  }

  content += `## Retrieval\n`;
  if (todayContent) content += `- Today's full log: \`${memoryDir}/${today}.md\`\n`;
  if (yesterdayContent) content += `- Yesterday's full log: \`${memoryDir}/${yesterday}.md\`\n`;
  content += `- Deeper history: use \`memory_search\`\n`;

  // Hard cap — shouldn't hit with topic-index mode, but safety net
  if (content.length > maxChars) {
    const trimPoint = content.lastIndexOf('\n', maxChars - 50);
    content = content.slice(0, trimPoint > 0 ? trimPoint : maxChars);
    content += '\n\n*[Trimmed — use retrieval for full context]*\n';
  }

  return content;
}

// ── Injection decision ──

let lastSessionId = '';
let lastEntryCount = 0;

// Fresh session: bootstrap writes ~4 system entries before the hook even fires,
// so threshold must account for those + a few user/assistant turns.
// Also check session file age — a session <2 minutes old is always fresh.
const FRESH_SESSION_AGE_MS = 2 * 60 * 1000;

function getSessionFileMtime(sessionsDir: string, sessionId: string): number {
  try {
    const filePath = join(expandPath(sessionsDir), `${sessionId}.jsonl`);
    return statSync(filePath).mtimeMs;
  } catch { return 0; }
}

function shouldInject(
  count: number,
  sessionId: string | null,
  threshold: number,
  sessionsDir: string
): { inject: boolean; reason: string } {
  const sid = sessionId ?? '';

  // New session file (first time we see this session ID)
  if (sid !== lastSessionId) {
    lastSessionId = sid;
    lastEntryCount = count;

    if (count <= threshold) {
      return { inject: true, reason: 'new-session' };
    }

    // Entry count is above threshold, but check if the session file is very young —
    // bootstrap system entries can push count past threshold before our first check
    if (sid) {
      const age = Date.now() - getSessionFileMtime(sessionsDir, sid);
      if (age < FRESH_SESSION_AGE_MS) {
        return { inject: true, reason: `new-session (${count} entries, age ${Math.round(age / 1000)}s)` };
      }
    }

    return { inject: false, reason: `existing-session (${count} entries)` };
  }

  // Entry count dropped = compaction
  if (count < lastEntryCount && count <= threshold) {
    lastEntryCount = count;
    return { inject: true, reason: `post-compaction (was ${lastEntryCount} → ${count})` };
  }

  lastEntryCount = count;
  return { inject: false, reason: `mid-session (${count} entries)` };
}

// ── Hook ──

const handler: HookHandler = async (event) => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') return;

  const start = performance.now();
  const config = loadConfig();
  if (!config) return;
  if (!event.context?.workspaceDir) return;

  const { count, sessionId } = countSessionEntries(config.paths.sessions);
  const { inject, reason } = shouldInject(count, sessionId, config.injection.freshSessionThreshold, config.paths.sessions);

  if (!inject) {
    console.log(`[context-inject] Skip (${(performance.now() - start).toFixed(1)}ms): ${reason}`);
    return;
  }

  const contextContent = buildContext(config);
  if (!contextContent) {
    console.log('[context-inject] No context available to inject');
    return;
  }

  // Write to disk for workspace scanner
  const contextFilePath = join(event.context.workspaceDir, 'CONTEXT_BRIDGE.md');
  try {
    writeFileSync(contextFilePath, contextContent, 'utf-8');
  } catch (e) {
    console.error('[context-inject] Write failed:', e);
    return;
  }

  // Push to bootstrapFiles for immediate availability
  if (!event.context.bootstrapFiles) event.context.bootstrapFiles = [];
  event.context.bootstrapFiles.push({
    name: 'CONTEXT_BRIDGE.md',
    content: contextContent,
    path: contextFilePath,
    type: 'inject'
  });

  const elapsed = (performance.now() - start).toFixed(1);
  const tokens = Math.ceil(contextContent.length / 4);
  console.log(`[context-inject] ✅ Injected (${elapsed}ms, ~${tokens} tokens): ${reason}`);
};

export default handler;
