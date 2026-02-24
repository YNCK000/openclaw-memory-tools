#!/usr/bin/env node
/**
 * embed-and-store.mjs
 * Takes a summary markdown file and a session ID, chunks it,
 * embeds via Ollama nomic-embed-text, and writes to the OpenClaw
 * memory SQLite database (chunks + chunks_fts + files tables).
 *
 * DOES NOT write to chunks_vec (FLOAT[1536], incompatible with 768-dim nomic).
 *
 * Usage: node embed-and-store.mjs <summary.md> <sessionId>
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load config
const configPath = join(__dirname, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const OLLAMA_URL = config.embedding.ollamaUrl;
const EMBED_MODEL = config.embedding.model;
const EMBED_DIMS = config.embedding.dimensions;
const CHUNK_MAX_TOKENS = config.embedding.chunkMaxTokens;
const CHUNK_OVERLAP = config.embedding.chunkOverlap;

// Resolve ~ in paths
function expandPath(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const DB_PATH = expandPath(config.memoryDb);

// ── Chunking ─────────────────────────────────────────────────────────

/**
 * Split text into chunks:
 * 1. Split on ## headers first
 * 2. For long sections, apply sliding window (approx token count = chars/4)
 */
function chunkText(text) {
  const sections = text.split(/(?=^## )/m).filter(s => s.trim());
  const chunks = [];

  for (const section of sections) {
    const approxTokens = section.length / 4;

    if (approxTokens <= CHUNK_MAX_TOKENS) {
      chunks.push(section.trim());
    } else {
      // Sliding window by words
      const words = section.split(/\s+/);
      const windowWords = CHUNK_MAX_TOKENS * 3; // ~3 chars per word avg after splitting
      const overlapWords = CHUNK_OVERLAP * 3;
      let start = 0;

      while (start < words.length) {
        const end = Math.min(start + windowWords, words.length);
        const chunk = words.slice(start, end).join(' ');
        if (chunk.trim()) chunks.push(chunk.trim());
        if (end >= words.length) break;
        start += windowWords - overlapWords;
      }
    }
  }

  return chunks;
}

// ── Embedding ────────────────────────────────────────────────────────

async function embedText(text) {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama embed error (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return data.embedding;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function generateId() {
  return crypto.randomUUID();
}

// ── Main ─────────────────────────────────────────────────────────────

const [summaryPath, sessionId] = process.argv.slice(2);
if (!summaryPath || !sessionId) {
  console.error('Usage: node embed-and-store.mjs <summary.md> <sessionId>');
  process.exit(1);
}

console.log(`Embedding summary for session: ${sessionId}`);
console.log(`DB: ${DB_PATH}`);

const summaryText = readFileSync(summaryPath, 'utf-8');
const chunks = chunkText(summaryText);

console.log(`Chunks: ${chunks.length}`);

if (chunks.length === 0) {
  console.log('No chunks to embed. Exiting.');
  process.exit(0);
}

// Embed all chunks
const embeddings = [];
for (let i = 0; i < chunks.length; i++) {
  console.log(`  Embedding chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
  const embedding = await embedText(chunks[i]);

  if (embedding.length !== EMBED_DIMS) {
    console.warn(`  Warning: expected ${EMBED_DIMS} dims, got ${embedding.length}`);
  }

  embeddings.push(embedding);
}

// Open SQLite — use better-sqlite3 for synchronous transactions
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 not installed. Run: npm install');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const virtualPath = `session-archive/${sessionId}`;
const now = Date.now();
const fileHash = sha256(summaryText);

// All writes in a single transaction
const insertChunk = db.prepare(`
  INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
  VALUES (?, ?, 'session-archive', ?, ?, ?, ?, ?, ?, ?)
`);

const insertFts = db.prepare(`
  INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
  VALUES (?, ?, ?, 'session-archive', ?, ?, ?)
`);

const deleteFtsForPath = db.prepare(`
  DELETE FROM chunks_fts WHERE path = ?
`);

const deleteChunksForPath = db.prepare(`
  DELETE FROM chunks WHERE path = ?
`);

const upsertFile = db.prepare(`
  INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
  VALUES (?, 'session-archive', ?, ?, ?)
`);

const transaction = db.transaction(() => {
  // Clear any existing data for this session (idempotent re-runs)
  deleteFtsForPath.run(virtualPath);
  deleteChunksForPath.run(virtualPath);

  for (let i = 0; i < chunks.length; i++) {
    const id = generateId();
    const chunkHash = sha256(chunks[i]);
    const embeddingJson = JSON.stringify(embeddings[i]);

    insertChunk.run(
      id, virtualPath, i, i,
      chunkHash, EMBED_MODEL,
      chunks[i], embeddingJson, now
    );

    insertFts.run(
      chunks[i], id, virtualPath,
      EMBED_MODEL, i, i
    );
  }

  // Update files table
  upsertFile.run(virtualPath, fileHash, now, summaryText.length);
});

try {
  transaction();
  console.log(`Stored ${chunks.length} chunks for session ${sessionId}`);
  console.log(`Path: ${virtualPath}`);
} catch (e) {
  console.error(`Transaction failed: ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}
