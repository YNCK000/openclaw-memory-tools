#!/usr/bin/env node
/**
 * summarize-session.mjs
 * Summarizes an OpenClaw session JSONL file using Ollama.
 *
 * Usage: node summarize-session.mjs <session.jsonl> <output.md>
 *
 * Reuses session-reader.mjs from context-bridge for parsing.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Import session reader from context-bridge
const __dirname = dirname(fileURLToPath(import.meta.url));
const contextBridgeLib = join(__dirname, '..', 'context-bridge', 'lib', 'session-reader.mjs');

let parseSessionFile, extractMessages, getSessionMeta;
try {
  const mod = await import(contextBridgeLib);
  parseSessionFile = mod.parseSessionFile;
  extractMessages = mod.extractMessages;
  getSessionMeta = mod.getSessionMeta;
} catch (e) {
  console.error(`Failed to import session-reader from ${contextBridgeLib}: ${e.message}`);
  process.exit(1);
}

// Load config
const configPath = join(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const OLLAMA_URL = config.summarization.ollamaUrl;
const MODEL = config.summarization.model;
const FALLBACK_MODEL = config.summarization.fallbackModel;
const TEMPERATURE = config.summarization.temperature;
const MAX_MSG_CHARS = config.summarization.maxMessageChars;
const CHUNK_SIZE = config.summarization.chunkSize;

// ── Helpers ──────────────────────────────────────────────────────────

async function ollamaGenerate(prompt, model) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: TEMPERATURE }
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.response;
}

async function summarizeWithFallback(prompt) {
  try {
    return await ollamaGenerate(prompt, MODEL);
  } catch (e) {
    console.warn(`Primary model (${MODEL}) failed: ${e.message}. Trying fallback...`);
    return await ollamaGenerate(prompt, FALLBACK_MODEL);
  }
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '... [truncated]';
}

// ── Main ─────────────────────────────────────────────────────────────

const [sessionPath, outputPath] = process.argv.slice(2);
if (!sessionPath || !outputPath) {
  console.error('Usage: node summarize-session.mjs <session.jsonl> <output.md>');
  process.exit(1);
}

console.log(`Summarizing: ${sessionPath}`);

// Parse the session
const entries = parseSessionFile(sessionPath);
const meta = getSessionMeta(entries);

// Extract user/assistant text messages only
const messages = extractMessages(entries, { roles: ['user', 'assistant'] });

if (messages.length === 0) {
  console.log('No messages found in session. Writing empty summary.');
  writeFileSync(outputPath, `# Session Summary\n\n*No messages found.*\n`);
  process.exit(0);
}

// Prepare messages: truncate each, format as role: content
const prepared = messages.map(m => {
  const content = truncate(m.content, MAX_MSG_CHARS);
  return `[${m.role}] ${content}`;
});

// Chunk into groups of CHUNK_SIZE
const chunks = [];
for (let i = 0; i < prepared.length; i += CHUNK_SIZE) {
  chunks.push(prepared.slice(i, i + CHUNK_SIZE));
}

console.log(`Messages: ${messages.length}, Chunks: ${chunks.length}`);

// Summarize each chunk
const chunkSummaries = [];
for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const chunkText = chunk.join('\n\n');

  const prompt = `You are a session summarizer. Below is a chunk of conversation (${i + 1}/${chunks.length}) from an AI assistant session.

Produce a concise, structured summary covering:
- Key topics discussed
- Decisions made
- Code/files changed or created
- Open questions or action items
- Important technical details

Be specific — include file paths, function names, and exact decisions. Do NOT use vague language.

---
${chunkText}
---

Summary:`;

  console.log(`  Summarizing chunk ${i + 1}/${chunks.length} (${chunk.length} messages)...`);
  const summary = await summarizeWithFallback(prompt);
  chunkSummaries.push(summary);
}

// If multiple chunks, merge summaries
let finalSummary;
if (chunkSummaries.length === 1) {
  finalSummary = chunkSummaries[0];
} else {
  console.log('Merging chunk summaries...');
  const mergePrompt = `You are a session summarizer. Below are summaries of ${chunkSummaries.length} chunks from the same conversation session. Merge them into a single coherent summary.

Structure the output as:
## Key Topics
## Decisions Made
## Files Changed
## Open Items

Be specific and concise. Remove redundancy between chunks.

---
${chunkSummaries.map((s, i) => `### Chunk ${i + 1}\n${s}`).join('\n\n')}
---

Merged Summary:`;

  finalSummary = await summarizeWithFallback(mergePrompt);
}

// Determine date range from messages
const firstTs = messages[0]?.timestamp;
const lastTs = messages[messages.length - 1]?.timestamp;
const dateRange = firstTs && lastTs
  ? `${new Date(firstTs).toISOString().slice(0, 10)} to ${new Date(lastTs).toISOString().slice(0, 10)}`
  : 'unknown';

// Write output
const output = `# Session Summary

**Session ID:** ${meta.id || 'unknown'}
**Date Range:** ${dateRange}
**Messages:** ${messages.length}
**Model:** ${meta.currentModel || 'unknown'}

## Summary

${finalSummary}
`;

writeFileSync(outputPath, output);
console.log(`Summary written to: ${outputPath}`);
