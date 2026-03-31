import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import type { Chat, Message } from '../types.js';

const HOME: string = os.homedir();

interface VarintResult {
  value: number;
  offset: number;
}

interface LengthDelimitedResult {
  bytes: Uint8Array;
  offset: number;
}

interface SkipResult {
  offset: number;
}

interface OfflineMeta {
  title: string | null;
  folder: string | null;
  bubbleCount: number;
  createdAt: number | null;
  lastUpdatedAt: number | null;
}

interface BrainStep {
  role?: string;
  type?: string;
  content?: string;
  text?: string;
}

interface BrainData {
  id?: string;
  cascadeId?: string;
  title?: string;
  summary?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  stepCount?: number;
  steps?: BrainStep[];
}

interface AntigravityChat extends Chat {
  _brainData?: BrainData;
}

interface CascadeEntry {
  cascadeId?: string;
  id?: string;
  name?: string | null;
  createdAt?: number | null;
  lastUpdatedAt?: number | null;
  bubbleCount?: number;
}

interface CascadeData {
  allCascades?: CascadeEntry[];
  cascades?: CascadeEntry[];
}

interface DbRow {
  value: string | Buffer | Uint8Array | null;
}

function getAppDataPath(appName: string): string {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', appName);
  if (process.platform === 'win32') return path.join(HOME, 'AppData', 'Roaming', appName);
  return path.join(HOME, '.config', appName);
}

const ANTIGRAVITY_USER_DIR: string = path.join(getAppDataPath('Antigravity'), 'User');
const ANTIGRAVITY_GLOBAL_STORAGE_DB: string = path.join(ANTIGRAVITY_USER_DIR, 'globalStorage', 'state.vscdb');
const WORKSPACE_STORAGE_DIR: string = path.join(ANTIGRAVITY_USER_DIR, 'workspaceStorage');
const ANTIGRAVITY_BRAIN_DIR: string = path.join(HOME, '.gemini', 'antigravity', 'brain');

const TRAJECTORY_KEYS: string[] = [
  'antigravityUnifiedStateSync.trajectorySummaries',
  'unifiedStateSync.trajectorySummaries',
];

export const name: string = 'antigravity';
export const label: string = 'Antigravity';
export const color: string = '#a78bfa';

// ── Protobuf helpers for offline trajectory parsing ──

function readVarint(buf: Uint8Array, offset: number): VarintResult | null {
  let value = 0, shift = 0, i = offset;
  while (i < buf.length) {
    const b = buf[i]; i++;
    value += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value, offset: i };
    shift += 7;
    if (shift > 53) return null;
  }
  return null;
}

function readLengthDelimited(buf: Uint8Array, offset: number): LengthDelimitedResult | null {
  const lenRes = readVarint(buf, offset);
  if (!lenRes) return null;
  const start = lenRes.offset;
  const end = start + lenRes.value;
  if (end > buf.length) return null;
  return { bytes: buf.subarray(start, end), offset: end };
}

function skipField(buf: Uint8Array, offset: number, wireType: number): SkipResult | null {
  if (wireType === 0) { const v = readVarint(buf, offset); return v ? { offset: v.offset } : null; }
  if (wireType === 1) return offset + 8 <= buf.length ? { offset: offset + 8 } : null;
  if (wireType === 2) { const ld = readLengthDelimited(buf, offset); return ld ? { offset: ld.offset } : null; }
  if (wireType === 5) return offset + 4 <= buf.length ? { offset: offset + 4 } : null;
  return null;
}

function bytesToUtf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

function base64ToBytes(b64: unknown): Uint8Array | null {
  try { return Uint8Array.from(Buffer.from(String(b64 || '').trim(), 'base64')); } catch { return null; }
}

function parseTimestampMessage(bytes: Uint8Array): number | null {
  let seconds: number | null = null, nanos = 0, offset = 0;
  while (offset < bytes.length) {
    const tagRes = readVarint(bytes, offset);
    if (!tagRes) return null;
    offset = tagRes.offset;
    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (wireType === 0) {
      const valueRes = readVarint(bytes, offset);
      if (!valueRes) return null;
      offset = valueRes.offset;
      if (fieldNumber === 1) seconds = valueRes.value;
      if (fieldNumber === 2) nanos = valueRes.value;
      continue;
    }
    const skipped = skipField(bytes, offset, wireType);
    if (!skipped) return null;
    offset = skipped.offset;
  }
  if (seconds == null || seconds < 946684800 || seconds > 4102444800) return null;
  return Math.round((seconds * 1000) + ((nanos < 1e9 ? nanos : 0) / 1e6));
}

function findTimestampInProto(bytes: Uint8Array, maxDepth: number = 2, depth: number = 0): number | null {
  const direct = parseTimestampMessage(bytes);
  if (direct) return direct;
  if (depth >= maxDepth) return null;
  let offset = 0;
  while (offset < bytes.length) {
    const tagRes = readVarint(bytes, offset);
    if (!tagRes) return null;
    offset = tagRes.offset;
    const wireType = tagRes.value & 0x7;
    if (wireType !== 2) { const s = skipField(bytes, offset, wireType); if (!s) return null; offset = s.offset; continue; }
    const ld = readLengthDelimited(bytes, offset);
    if (!ld) return null;
    offset = ld.offset;
    const nested = findTimestampInProto(ld.bytes, maxDepth, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function* iterAllUtf8Strings(buf: Uint8Array, maxDepth: number, depth: number = 0): Generator<string> {
  if (depth > maxDepth) return;
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = readVarint(buf, offset);
    if (!tagRes) return;
    offset = tagRes.offset;
    const wireType = tagRes.value & 0x7;
    if (wireType !== 2) { const s = skipField(buf, offset, wireType); if (!s) return; offset = s.offset; continue; }
    const ld = readLengthDelimited(buf, offset);
    if (!ld) return;
    offset = ld.offset;
    const asString = bytesToUtf8(ld.bytes);
    if (asString !== null) yield asString;
    yield* iterAllUtf8Strings(ld.bytes, maxDepth, depth + 1);
  }
}

function fileUriToPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    let p = decodeURIComponent(parsed.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p || null;
  } catch { return null; }
}

function extractFolderFromProto(bytes: Uint8Array): string | null {
  for (const s of iterAllUtf8Strings(bytes, 6)) {
    const match = s.match(/#?file:\/\/[^\s\x00-\x1f"]+/);
    if (!match) continue;
    let uri = match[0];
    if (uri.startsWith('#')) uri = uri.slice(1);
    const folder = fileUriToPath(uri);
    if (folder) return folder;
  }
  return null;
}

function extractOfflineMeta(summaryProtoBytes: Uint8Array): OfflineMeta {
  let title: string | null = null, primaryCount = 0, secondaryCount = 0;
  const timestamps: number[] = [];
  let offset = 0;
  while (offset < summaryProtoBytes.length) {
    const tagRes = readVarint(summaryProtoBytes, offset);
    if (!tagRes) break;
    offset = tagRes.offset;
    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (wireType === 0) {
      const vr = readVarint(summaryProtoBytes, offset);
      if (!vr) break;
      offset = vr.offset;
      if (fieldNumber === 2) primaryCount = vr.value;
      if (fieldNumber === 16) secondaryCount = vr.value;
      continue;
    }
    if (wireType === 2) {
      const ld = readLengthDelimited(summaryProtoBytes, offset);
      if (!ld) break;
      offset = ld.offset;
      if (fieldNumber === 1 && !title) { const t = bytesToUtf8(ld.bytes); if (t?.trim()) title = t.trim(); continue; }
      if ([3, 7, 10, 15].includes(fieldNumber)) {
        const ts = fieldNumber === 15 ? findTimestampInProto(ld.bytes, 2) : (parseTimestampMessage(ld.bytes) || findTimestampInProto(ld.bytes, 1));
        if (ts) timestamps.push(ts);
        continue;
      }
      continue;
    }
    const skipped = skipField(summaryProtoBytes, offset, wireType);
    if (!skipped) break;
    offset = skipped.offset;
  }
  const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
  return {
    title, folder: extractFolderFromProto(summaryProtoBytes),
    bubbleCount: Math.max(primaryCount, secondaryCount),
    createdAt: sorted[0] || null, lastUpdatedAt: sorted[sorted.length - 1] || null,
  };
}

function readGlobalStateValue(key: string): string | null {
  if (!fs.existsSync(ANTIGRAVITY_GLOBAL_STORAGE_DB)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(ANTIGRAVITY_GLOBAL_STORAGE_DB, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as DbRow | undefined;
    if (!row) return null;
    const v = row.value;
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('utf-8');
    return v == null ? null : String(v);
  } catch { return null; } finally { if (db) db.close(); }
}

function buildOfflineMetaMap(outerValueBase64: string): Record<string, OfflineMeta> {
  const outerBytes = base64ToBytes(outerValueBase64);
  if (!outerBytes) return {};
  const chats: Record<string, OfflineMeta> = {};
  let offset = 0;
  while (offset < outerBytes.length) {
    const tagRes = readVarint(outerBytes, offset);
    if (!tagRes) break;
    offset = tagRes.offset;
    const fieldNumber = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (fieldNumber !== 1 || wireType !== 2) { const s = skipField(outerBytes, offset, wireType); if (!s) break; offset = s.offset; continue; }
    const entryLd = readLengthDelimited(outerBytes, offset);
    if (!entryLd) break;
    offset = entryLd.offset;
    let composerId: string | null = null, summaryBase64: string | null = null, eo = 0;
    while (eo < entryLd.bytes.length) {
      const et = readVarint(entryLd.bytes, eo);
      if (!et) break;
      eo = et.offset;
      const ef = et.value >>> 3, ew = et.value & 0x7;
      if (ef === 1 && ew === 2) { const kl = readLengthDelimited(entryLd.bytes, eo); if (!kl) break; eo = kl.offset; composerId = bytesToUtf8(kl.bytes); continue; }
      if (ef === 2 && ew === 2) {
        const vl = readLengthDelimited(entryLd.bytes, eo);
        if (!vl) break;
        eo = vl.offset;
        let vo = 0;
        while (vo < vl.bytes.length) {
          const vt = readVarint(vl.bytes, vo);
          if (!vt) break;
          vo = vt.offset;
          if ((vt.value >>> 3) === 1 && (vt.value & 0x7) === 2) {
            const sl = readLengthDelimited(vl.bytes, vo);
            if (!sl) break;
            vo = sl.offset;
            summaryBase64 = bytesToUtf8(sl.bytes);
            break;
          }
          const sk = skipField(vl.bytes, vo, vt.value & 0x7);
          if (!sk) break;
          vo = sk.offset;
        }
        continue;
      }
      const sk = skipField(entryLd.bytes, eo, ew);
      if (!sk) break;
      eo = sk.offset;
    }
    if (!composerId || !summaryBase64) continue;
    const summaryBytes = base64ToBytes(summaryBase64);
    if (!summaryBytes) continue;
    chats[composerId] = extractOfflineMeta(summaryBytes);
  }
  return chats;
}

function getOfflineChats(): AntigravityChat[] {
  for (const key of TRAJECTORY_KEYS) {
    const value = readGlobalStateValue(key);
    if (!value) continue;
    const map = buildOfflineMetaMap(value);
    const chats: AntigravityChat[] = Object.entries(map).map(([composerId, meta]) => ({
      source: 'antigravity' as const, composerId, name: meta.title || null,
      createdAt: meta.createdAt || null, lastUpdatedAt: meta.lastUpdatedAt || null,
      mode: 'cascade', folder: meta.folder || null,
      bubbleCount: meta.bubbleCount || 0,
    }));
    if (chats.length > 0) return chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
  }
  return [];
}

// ── Brain directory sessions ──

function getBrainChats(): AntigravityChat[] {
  if (!fs.existsSync(ANTIGRAVITY_BRAIN_DIR)) return [];
  const chats: AntigravityChat[] = [];
  try {
    for (const file of fs.readdirSync(ANTIGRAVITY_BRAIN_DIR).filter((f: string) => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ANTIGRAVITY_BRAIN_DIR, file), 'utf-8')) as BrainData;
        if (data.id || data.cascadeId) {
          chats.push({
            source: 'antigravity' as const, composerId: (data.id || data.cascadeId) as string,
            name: data.title || data.summary || null,
            createdAt: data.createdTime ? new Date(data.createdTime).getTime() : null,
            lastUpdatedAt: data.lastModifiedTime ? new Date(data.lastModifiedTime).getTime() : null,
            mode: 'cascade', folder: null,
            bubbleCount: data.stepCount || (data.steps || []).length,
            _brainData: data,
          });
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* skip if directory unreadable */ }
  return chats;
}

// ── Workspace cascade data ──

function getWorkspaceChats(): AntigravityChat[] {
  if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return [];
  const chats: AntigravityChat[] = [];
  for (const hash of fs.readdirSync(WORKSPACE_STORAGE_DIR)) {
    const dir = path.join(WORKSPACE_STORAGE_DIR, hash);
    const wsJson = path.join(dir, 'workspace.json');
    const stateDb = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(wsJson) || !fs.existsSync(stateDb)) continue;
    let folder: string | null = null;
    try { folder = ((JSON.parse(fs.readFileSync(wsJson, 'utf-8')) as { folder?: string }).folder || '').replace('file://', ''); } catch { continue; }
    try {
      const db = new Database(stateDb, { readonly: true });
      // Try cascade data keys
      for (const key of ['antigravity.cascadeData', 'windsurf.cascadeData']) {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as DbRow | undefined;
        if (!row) continue;
        const data = JSON.parse(row.value as string) as CascadeData;
        const cascades: CascadeEntry[] = data.allCascades || data.cascades || [];
        for (const c of cascades) {
          chats.push({
            source: 'antigravity' as const, composerId: (c.cascadeId || c.id) as string,
            name: c.name || null, createdAt: c.createdAt || null,
            lastUpdatedAt: c.lastUpdatedAt || null, mode: 'cascade',
            folder, bubbleCount: c.bubbleCount || 0,
          });
        }
      }
      db.close();
    } catch { /* skip on error */ }
  }
  return chats;
}

// ── Adapter interface ──

export function getChats(): Chat[] {
  const seen = new Map<string, AntigravityChat>();
  const sources: AntigravityChat[][] = [getOfflineChats(), getBrainChats(), getWorkspaceChats()];
  for (const chats of sources) {
    for (const chat of chats) {
      const existing = seen.get(chat.composerId);
      if (!existing) { seen.set(chat.composerId, chat); continue; }
      // Merge: prefer non-null values
      seen.set(chat.composerId, {
        ...existing, ...chat,
        name: chat.name || existing.name,
        createdAt: chat.createdAt || existing.createdAt,
        lastUpdatedAt: chat.lastUpdatedAt || existing.lastUpdatedAt,
        folder: chat.folder || existing.folder,
        bubbleCount: Math.max(chat.bubbleCount || 0, existing.bubbleCount || 0),
      });
    }
  }
  return Array.from(seen.values()).sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

export function getMessages(chat: Chat): Message[] {
  // Brain data has steps we can parse
  const antigravityChat = chat as AntigravityChat;
  if (antigravityChat._brainData?.steps) {
    return antigravityChat._brainData.steps.filter((s: BrainStep) => s.content || s.text).map((s: BrainStep): Message => ({
      role: (s.role || (s.type === 'user' ? 'user' : 'assistant')) as 'user' | 'assistant',
      content: s.content || s.text || '',
    }));
  }
  // For offline/workspace chats, message extraction requires Antigravity to be running (RPC)
  // Return empty — we still have chat metadata for the report
  return [];
}
