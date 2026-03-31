import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { Chat, Message, ToolCall } from '../types.js';

const STORAGE_DIR: string = path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
const SESSION_DIR: string = path.join(STORAGE_DIR, 'session');
const MESSAGE_DIR: string = path.join(STORAGE_DIR, 'message');
const PART_DIR: string = path.join(STORAGE_DIR, 'part');
const DB_PATH: string = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

export const name: string = 'opencode';
export const label: string = 'OpenCode';
export const color: string = '#ec4899';

interface OpenCodeChat extends Chat {
  _storageType: 'file' | 'sqlite';
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
  worktree: string | null;
  msg_count: number;
}

interface MessageRow {
  msg_id: string;
  msg_data: string;
}

interface PartRow {
  data: string;
}

interface TokenInfo {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function queryDb(sql: string): any[] {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch { return []; }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function extractModelInfo(data: Record<string, unknown>): string | null {
  if (typeof data?.modelID === 'string') return data.modelID;
  if (data?.model && typeof data.model === 'object') return (data.model as Record<string, unknown>).modelID as string || null;
  if (typeof data?.model === 'string') return data.model;
  return null;
}

function extractTokenInfo(data: Record<string, unknown>): TokenInfo {
  const tokens = data?.tokens && typeof data.tokens === 'object' ? data.tokens as Record<string, unknown> : null;
  const cache = tokens?.cache && typeof tokens.cache === 'object' ? tokens.cache as Record<string, unknown> : null;
  return {
    inputTokens: tokens?.input as number | undefined,
    outputTokens: tokens?.output as number | undefined,
    cacheRead: cache?.read as number | undefined,
    cacheWrite: cache?.write as number | undefined,
  };
}

function getAllFileSessions(): Record<string, unknown>[] {
  const sessions: Record<string, unknown>[] = [];
  if (!fs.existsSync(SESSION_DIR)) return sessions;
  for (const projectHash of fs.readdirSync(SESSION_DIR)) {
    const projectDir = path.join(SESSION_DIR, projectHash);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    let files: string[];
    try { files = fs.readdirSync(projectDir).filter(f => f.startsWith('ses_') && f.endsWith('.json')); } catch { continue; }
    for (const file of files) {
      const data = readJson(path.join(projectDir, file));
      if (data && data.id) sessions.push(data);
    }
  }
  return sessions;
}

function getMessageCount(sessionId: string): number {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return 0;
  try { return fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')).length; } catch { return 0; }
}

export function getChats(): Chat[] {
  const seen = new Set<string>();
  const chats: OpenCodeChat[] = [];

  // JSON file sessions
  for (const s of getAllFileSessions()) {
    const id = s.id as string;
    const time = s.time as Record<string, unknown> | undefined;
    seen.add(id);
    chats.push({
      source: 'opencode',
      composerId: id,
      name: (s.title as string) || null,
      createdAt: (time?.created as number) || null,
      lastUpdatedAt: (time?.updated as number) || null,
      mode: 'opencode',
      folder: (s.directory as string) || null,
      bubbleCount: getMessageCount(id),
      _storageType: 'file',
    });
  }

  // SQLite sessions
  const dbSessions = queryDb(
    `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
            p.worktree, (SELECT count(*) FROM message m WHERE m.session_id = s.id) as msg_count
     FROM session s LEFT JOIN project p ON s.project_id = p.id
     ORDER BY s.time_updated DESC`
  ) as SessionRow[];
  for (const row of dbSessions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    chats.push({
      source: 'opencode',
      composerId: row.id,
      name: cleanTitle(row.title),
      createdAt: row.time_created || null,
      lastUpdatedAt: row.time_updated || null,
      mode: 'opencode',
      folder: row.worktree || row.directory || null,
      bubbleCount: row.msg_count || 0,
      _storageType: 'sqlite',
    });
  }

  return chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

export function getMessages(chat: Chat): Message[] {
  // Try file-based first
  const fileMessages = getFileMessages(chat.composerId);
  if (fileMessages.length > 0) return fileMessages;
  return getSqliteMessages(chat.composerId);
}

function getFileMessages(sessionId: string): Message[] {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return [];
  let files: string[];
  try { files = fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')); } catch { return []; }

  const rawMsgs: Record<string, unknown>[] = [];
  for (const file of files) {
    const msg = readJson(path.join(sessionMsgDir, file));
    if (msg && msg.id) rawMsgs.push(msg);
  }
  rawMsgs.sort((a, b) => {
    const aTime = (a.time as Record<string, unknown>)?.created as number || 0;
    const bTime = (b.time as Record<string, unknown>)?.created as number || 0;
    return aTime - bTime;
  });

  const messages: Message[] = [];
  for (const msg of rawMsgs) {
    const msgPartDir = path.join(PART_DIR, msg.id as string);
    const parts: Record<string, unknown>[] = [];
    if (fs.existsSync(msgPartDir)) {
      try {
        for (const pf of fs.readdirSync(msgPartDir).filter(f => f.startsWith('prt_') && f.endsWith('.json'))) {
          const part = readJson(path.join(msgPartDir, pf));
          if (part) parts.push(part);
        }
      } catch { /* ignore read errors */ }
    }

    const contentParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (part.type === 'text' && part.text) contentParts.push(part.text as string);
      else if ((part.type === 'tool-call' || part.type === 'tool_use') && part.name) {
        const argKeys = typeof part.input === 'object' ? Object.keys((part.input as Record<string, unknown>) || {}).join(', ') : '';
        contentParts.push(`[tool-call: ${part.name as string}(${argKeys})]`);
        toolCalls.push({ name: part.name as string, args: (part.input as Record<string, unknown>) || {} });
      }
    }

    const content = contentParts.join('\n');
    if (!content) continue;

    const model = extractModelInfo(msg);
    const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msg);
    messages.push({
      role: (msg.role as 'user' | 'assistant') || 'assistant', content,
      _model: model ?? undefined, _inputTokens: inputTokens, _outputTokens: outputTokens,
      _cacheRead: cacheRead, _cacheWrite: cacheWrite, _toolCalls: toolCalls,
    });
  }
  return messages;
}

function getSqliteMessages(sessionId: string): Message[] {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT m.id as msg_id, m.data as msg_data FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC`
    ).all(sessionId) as MessageRow[];

    const result: Message[] = [];
    for (const row of rows) {
      let msgData: Record<string, unknown>;
      try { msgData = JSON.parse(row.msg_data) as Record<string, unknown>; } catch { continue; }
      if (!msgData.role) continue;

      const parts = db.prepare(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`).all(row.msg_id) as PartRow[];
      const contentParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const part of parts) {
        let pd: Record<string, unknown>;
        try { pd = JSON.parse(part.data) as Record<string, unknown>; } catch { continue; }
        if (pd.type === 'text' && pd.text) contentParts.push(pd.text as string);
        else if ((pd.type === 'tool-call' || pd.type === 'tool_use') && pd.name) {
          contentParts.push(`[tool-call: ${pd.name as string}]`);
          toolCalls.push({ name: pd.name as string, args: (pd.input as Record<string, unknown>) || {} });
        }
      }

      const content = contentParts.join('\n');
      if (!content) continue;

      const model = extractModelInfo(msgData);
      const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msgData);
      result.push({
        role: msgData.role as 'user' | 'assistant', content, _model: model ?? undefined,
        _inputTokens: inputTokens, _outputTokens: outputTokens,
        _cacheRead: cacheRead, _cacheWrite: cacheWrite, _toolCalls: toolCalls,
      });
    }
    db.close();
    return result;
  } catch { return []; }
}

function cleanTitle(title: string | null): string | null {
  if (!title) return null;
  if (title.startsWith('New session - ')) return null;
  return title.substring(0, 120) || null;
}
