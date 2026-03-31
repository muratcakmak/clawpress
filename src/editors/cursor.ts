import path from 'path';
import fs from 'fs';
import os from 'os';
import type BetterSqlite3 from 'better-sqlite3';
let Database: typeof BetterSqlite3 | undefined;
try { Database = (await import('better-sqlite3')).default; } catch {}
import type { Chat, Message, ToolCall } from '../types.js';

const HOME: string = os.homedir();
const CURSOR_CHATS_DIR: string = path.join(HOME, '.cursor', 'chats');

function getAppDataPath(appName: string): string {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', appName);
  if (process.platform === 'win32') return path.join(HOME, 'AppData', 'Roaming', appName);
  return path.join(HOME, '.config', appName);
}

const CURSOR_USER_DIR: string = path.join(getAppDataPath('Cursor'), 'User');
const WORKSPACE_STORAGE_DIR: string = path.join(CURSOR_USER_DIR, 'workspaceStorage');
const GLOBAL_STORAGE_DB: string = path.join(CURSOR_USER_DIR, 'globalStorage', 'state.vscdb');

export const name: string = 'cursor';
export const label: string = 'Cursor';
export const color: string = '#f59e0b';

// ── Source 1: ~/.cursor/chats store.db (agent KV) ──

interface AgentStoreEntry {
  workspace: string;
  chatId: string;
  dbPath: string;
}

interface StoreMeta {
  name?: string;
  createdAt?: number;
  mode?: string;
  latestRootBlobId?: string;
  lastUsedModel?: string;
}

interface TreeParseResult {
  messageRefs: string[];
  childRefs: string[];
}

interface WorkspaceEntry {
  hash: string;
  folder: string;
  stateDb: string;
}

interface ComposerHeader {
  composerId: string;
  name: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  mode: string;
}

interface Bubble {
  type?: number;
  text?: string;
  modelId?: string;
  model?: string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  toolFormerData?: { name?: string; rawArgs?: string | Record<string, unknown> };
}

function getAgentStoreChats(): AgentStoreEntry[] {
  const results: AgentStoreEntry[] = [];
  if (!fs.existsSync(CURSOR_CHATS_DIR)) return results;
  for (const workspace of fs.readdirSync(CURSOR_CHATS_DIR)) {
    const wsDir = path.join(CURSOR_CHATS_DIR, workspace);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const chat of fs.readdirSync(wsDir)) {
      const dbPath = path.join(wsDir, chat, 'store.db');
      if (fs.existsSync(dbPath)) results.push({ workspace, chatId: chat, dbPath });
    }
  }
  return results;
}

function hexToString(hex: string): string {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  return str;
}

function readStoreMeta(db: BetterSqlite3.Database): StoreMeta | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string | Buffer } | undefined;
  if (!row) return null;
  const hex = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('hex');
  try { return JSON.parse(hexToString(hex)) as StoreMeta; } catch {
    try { return JSON.parse(row.value as string) as StoreMeta; } catch { return null; }
  }
}

function parseTreeBlob(data: Buffer | string): TreeParseResult {
  const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const messageRefs: string[] = [];
  const childRefs: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 34 > buf.length) break;
    const tag: number = buf[offset];
    const len: number = buf[offset + 1];
    if (len !== 0x20) break;
    const hash: string = buf.slice(offset + 2, offset + 2 + 32).toString('hex');
    if (tag === 0x0a) messageRefs.push(hash);
    else if (tag === 0x12) childRefs.push(hash);
    else break;
    offset += 2 + 32;
  }
  return { messageRefs, childRefs };
}

interface RawStoreMessage {
  role: 'user' | 'assistant';
  content: string | Array<string | { text?: string }>;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string | Record<string, unknown> };
    name?: string;
  }>;
  model?: string;
}

function normalizeStoreMessage(json: RawStoreMessage): Message {
  const msg: Message = { role: json.role, content: '', _toolCalls: [] };
  if (typeof json.content === 'string') msg.content = json.content;
  else if (Array.isArray(json.content)) msg.content = json.content.map((p) => typeof p === 'string' ? p : (p.text || '')).join('\n');
  if (json.tool_calls && Array.isArray(json.tool_calls)) {
    for (const tc of json.tool_calls) {
      const tcName: string = tc.function?.name || tc.name || 'unknown';
      let args: Record<string, unknown> = {};
      try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) as Record<string, unknown> : (tc.function?.arguments || {}) as Record<string, unknown>; } catch {}
      msg.content += `\n[tool-call: ${tcName}(${Object.keys(args).join(', ')})]`;
      msg._toolCalls!.push({ name: tcName, args });
    }
  }
  if (json.model) msg._model = json.model;
  return msg;
}

function collectStoreMessages(db: BetterSqlite3.Database, rootBlobId: string): Message[] {
  const allMessages: Message[] = [];
  const visited = new Set<string>();
  function walk(blobId: string): void {
    if (visited.has(blobId)) return;
    visited.add(blobId);
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(blobId) as { data: string | Buffer } | undefined;
    if (!row) return;
    try {
      const json = typeof row.data === 'string' ? JSON.parse(row.data) : JSON.parse((row.data as Buffer).toString('utf-8'));
      if (json && json.role) { allMessages.push(normalizeStoreMessage(json as RawStoreMessage)); return; }
    } catch { /* tree blob */ }
    const { messageRefs, childRefs } = parseTreeBlob(row.data);
    for (const ref of messageRefs) walk(ref);
    for (const ref of childRefs) walk(ref);
  }
  walk(rootBlobId);
  return allMessages;
}

// ── Source 2: workspaceStorage + globalStorage ──

function getWorkspaceMap(): WorkspaceEntry[] {
  const map: WorkspaceEntry[] = [];
  if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return map;
  for (const hash of fs.readdirSync(WORKSPACE_STORAGE_DIR)) {
    const dir = path.join(WORKSPACE_STORAGE_DIR, hash);
    const wsJson = path.join(dir, 'workspace.json');
    const stateDb = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(wsJson) || !fs.existsSync(stateDb)) continue;
    try {
      const ws = JSON.parse(fs.readFileSync(wsJson, 'utf-8')) as { folder?: string };
      const folder: string = (ws.folder || '').replace('file://', '');
      map.push({ hash, folder, stateDb });
    } catch {}
  }
  return map;
}

function getComposerHeaders(stateDbPath: string): ComposerHeader[] {
  if (!Database) return [];
  try {
    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value: string } | undefined;
    db.close();
    if (!row) return [];
    const data = JSON.parse(row.value) as { allComposers?: Array<{
      composerId: string;
      name?: string;
      createdAt?: number;
      lastUpdatedAt?: number;
      unifiedMode?: string;
      forceMode?: string;
    }> };
    return (data.allComposers || []).map((c): ComposerHeader => ({
      composerId: c.composerId,
      name: c.name || null,
      createdAt: c.createdAt || null,
      lastUpdatedAt: c.lastUpdatedAt || null,
      mode: c.unifiedMode || c.forceMode || 'unknown',
    }));
  } catch { return []; }
}

function getComposerBubbles(globalDb: BetterSqlite3.Database, composerId: string): Bubble[] {
  const prefix = `bubbleId:${composerId}:`;
  const rows = globalDb.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key").all(prefix + '%') as { key: string; value: string }[];
  const bubbles: Bubble[] = [];
  for (const row of rows) {
    try { bubbles.push(JSON.parse(row.value) as Bubble); } catch {}
  }
  return bubbles;
}

function bubblesToMessages(bubbles: Bubble[]): Message[] {
  const messages: Message[] = [];
  for (const b of bubbles) {
    if (!b) continue;
    if (b.type === 1) {
      if (b.text) messages.push({ role: 'user', content: b.text });
    } else if (b.type === 2) {
      const parts: string[] = [];
      const toolCalls: ToolCall[] = [];
      if (b.text) parts.push(b.text);
      const tfd = b.toolFormerData;
      if (tfd && tfd.name) {
        let args: Record<string, unknown> = {};
        try { args = typeof tfd.rawArgs === 'string' && tfd.rawArgs ? JSON.parse(tfd.rawArgs) as Record<string, unknown> : (tfd.rawArgs || {}) as Record<string, unknown>; } catch {}
        parts.push(`[tool-call: ${tfd.name}(${typeof args === 'object' ? Object.keys(args).join(', ') : ''})]`);
        toolCalls.push({ name: tfd.name, args });
      }
      if (parts.length > 0) {
        messages.push({
          role: 'assistant', content: parts.join('\n'),
          _model: b.modelId || b.model || undefined,
          _inputTokens: b.tokenCount?.inputTokens,
          _outputTokens: b.tokenCount?.outputTokens,
          _toolCalls: toolCalls,
        });
      }
    }
  }
  return messages;
}

// ── Adapter interface ──

export function getChats(): Chat[] {
  const chats: Chat[] = [];

  if (!Database) return chats;

  // Source 1: agent store.db
  for (const { chatId, dbPath } of getAgentStoreChats()) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const meta = readStoreMeta(db);
      db.close();
      if (meta) {
        chats.push({
          source: 'cursor', composerId: chatId,
          name: meta.name || null, createdAt: meta.createdAt || null,
          lastUpdatedAt: null, mode: meta.mode || 'unknown',
          folder: null, bubbleCount: 0,
          _dbPath: dbPath, _rootBlobId: meta.latestRootBlobId,
          _lastUsedModel: meta.lastUsedModel || null, _type: 'agent-store' as const,
        });
      }
    } catch {}
  }

  // Source 2: workspace composers
  let globalDb: BetterSqlite3.Database | null = null;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch {}

  for (const { folder, stateDb } of getWorkspaceMap()) {
    for (const h of getComposerHeaders(stateDb)) {
      let bubbleCount = 0;
      if (globalDb) {
        try {
          const countRow = globalDb.prepare("SELECT count(*) as cnt FROM cursorDiskKV WHERE key LIKE ?").get(`bubbleId:${h.composerId}:%`) as { cnt: number } | undefined;
          bubbleCount = countRow ? countRow.cnt : 0;
        } catch {}
      }
      chats.push({
        source: 'cursor', composerId: h.composerId,
        name: h.name || null, createdAt: h.createdAt || null,
        lastUpdatedAt: h.lastUpdatedAt || null, mode: h.mode,
        folder, bubbleCount, _type: 'workspace' as const,
      });
    }
  }

  if (globalDb) globalDb.close();
  return chats;
}

export function getMessages(chat: Chat): Message[] {
  if (!Database) return [];
  if (chat._type === 'agent-store') {
    try {
      const db = new Database(chat._dbPath as string, { readonly: true });
      const msgs = collectStoreMessages(db, chat._rootBlobId as string);
      db.close();
      if (chat._lastUsedModel) {
        for (const m of msgs) { if (m.role === 'assistant' && !m._model) m._model = chat._lastUsedModel as string; }
      }
      return msgs;
    } catch { return []; }
  }

  let globalDb: BetterSqlite3.Database;
  try { globalDb = new Database(GLOBAL_STORAGE_DB, { readonly: true }); } catch { return []; }
  const bubbles = getComposerBubbles(globalDb, chat.composerId);
  globalDb.close();
  return bubblesToMessages(bubbles);
}
