import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Chat, Message, ToolCall } from '../types.js';

const CLAUDE_DIR: string = path.join(os.homedir(), '.claude');
const PROJECTS_DIR: string = path.join(CLAUDE_DIR, 'projects');

export const name: string = 'claude-code';
export const label: string = 'Claude Code';
export const color: string = '#f97316';

/** Internal chat representation that carries the JSONL file path. */
type ClaudeChat = Chat & { _fullPath: string };

interface SessionIndexEntry {
  sessionId: string;
  firstPrompt?: string;
  created?: string;
  modified?: string;
  projectPath?: string;
  messageCount?: number;
  fullPath?: string;
}

interface SessionMeta {
  firstPrompt: string | null;
  cwd: string | null;
  timestamp: number | null;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ExtractedAssistant {
  text: string;
  toolCalls: ToolCall[];
}

export function getChats(): ClaudeChat[] {
  const chats: ClaudeChat[] = [];
  if (!fs.existsSync(PROJECTS_DIR)) return chats;

  for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
    const dir: string = path.join(PROJECTS_DIR, projDir);
    if (!fs.statSync(dir).isDirectory()) continue;

    const decodedFolder: string = projDir.replace(/-/g, '/');

    // Read sessions-index.json
    const indexPath: string = path.join(dir, 'sessions-index.json');
    const indexed = new Map<string, SessionIndexEntry>();
    try {
      const index: { entries?: SessionIndexEntry[] } = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const entry of index.entries || []) {
        indexed.set(entry.sessionId, entry);
      }
    } catch { /* no index */ }

    let files: string[];
    try { files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      const sessionId: string = file.replace('.jsonl', '');
      const fullPath: string = path.join(dir, file);
      const entry: SessionIndexEntry | undefined = indexed.get(sessionId);

      if (entry) {
        chats.push({
          source: 'claude-code',
          composerId: sessionId,
          name: cleanPrompt(entry.firstPrompt),
          createdAt: entry.created ? new Date(entry.created).getTime() : null,
          lastUpdatedAt: entry.modified ? new Date(entry.modified).getTime() : null,
          mode: 'claude',
          folder: entry.projectPath || decodedFolder,
          bubbleCount: entry.messageCount || 0,
          _fullPath: fullPath,
        });
      } else {
        try {
          const stat: fs.Stats = fs.statSync(fullPath);
          const meta: SessionMeta = peekSessionMeta(fullPath);
          chats.push({
            source: 'claude-code',
            composerId: sessionId,
            name: meta.firstPrompt ? cleanPrompt(meta.firstPrompt) : null,
            createdAt: meta.timestamp || stat.birthtime.getTime(),
            lastUpdatedAt: stat.mtime.getTime(),
            mode: 'claude',
            folder: meta.cwd || decodedFolder,
            bubbleCount: 0,
            _fullPath: fullPath,
          });
        } catch { /* skip */ }
      }

      indexed.delete(sessionId);
    }

    // Indexed sessions whose .jsonl still exists elsewhere
    for (const [sessionId, entry] of indexed) {
      if (!entry.fullPath || !fs.existsSync(entry.fullPath)) continue;
      chats.push({
        source: 'claude-code',
        composerId: sessionId,
        name: cleanPrompt(entry.firstPrompt),
        createdAt: entry.created ? new Date(entry.created).getTime() : null,
        lastUpdatedAt: entry.modified ? new Date(entry.modified).getTime() : null,
        mode: 'claude',
        folder: entry.projectPath || decodedFolder,
        bubbleCount: entry.messageCount || 0,
        _fullPath: entry.fullPath,
      });
    }
  }

  return chats;
}

export function getMessages(chat: Chat): Message[] {
  const filePath: string | undefined = chat._fullPath as string | undefined;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const messages: Message[] = [];
  const lines: string[] = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }

    const msg = obj.message as Record<string, unknown> | undefined;

    if (obj.type === 'user' && msg) {
      const content: string = extractContent(msg.content);
      if (content) messages.push({ role: 'user', content });
    } else if (obj.type === 'assistant' && msg) {
      const { text, toolCalls }: ExtractedAssistant = extractAssistantContent(msg.content);
      const usage = msg.usage as Record<string, number> | undefined;
      if (text) messages.push({
        role: 'assistant', content: text, _model: msg.model as string | undefined,
        _inputTokens: usage?.input_tokens, _outputTokens: usage?.output_tokens,
        _cacheRead: usage?.cache_read_input_tokens, _cacheWrite: usage?.cache_creation_input_tokens,
        _toolCalls: toolCalls,
      });
    }
  }

  return messages;
}

function peekSessionMeta(filePath: string): SessionMeta {
  const meta: SessionMeta = { firstPrompt: null, cwd: null, timestamp: null };
  try {
    const buf: string = fs.readFileSync(filePath, 'utf-8');
    for (const line of buf.split('\n')) {
      if (!line) continue;
      const obj: Record<string, unknown> = JSON.parse(line);
      if (!meta.cwd && typeof obj.cwd === 'string') meta.cwd = obj.cwd;
      if (!meta.timestamp && obj.timestamp != null) {
        meta.timestamp = typeof obj.timestamp === 'string'
          ? new Date(obj.timestamp).getTime() : obj.timestamp as number;
      }
      if (!meta.firstPrompt && obj.type === 'user') {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (msg?.content) {
          const content = msg.content;
          const text: string = typeof content === 'string'
            ? content
            : (content as ContentBlock[]).filter((c: ContentBlock) => c.type === 'text').map((c: ContentBlock) => c.text).join(' ');
          meta.firstPrompt = text.substring(0, 200);
        }
      }
      if (meta.cwd && meta.firstPrompt) break;
    }
  } catch { /* ignore */ }
  return meta;
}

function cleanPrompt(prompt: string | undefined | null): string | null {
  if (!prompt || prompt === 'No prompt') return null;
  return prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120) || null;
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[]).filter((c: ContentBlock) => c.type === 'text').map((c: ContentBlock) => c.text).join('\n') || '';
}

function extractAssistantContent(content: unknown): ExtractedAssistant {
  if (typeof content === 'string') return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const parts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const args: Record<string, unknown> = block.input || {};
      const argKeys: string = Object.keys(args).join(', ');
      parts.push(`[tool-call: ${block.name || 'unknown'}(${argKeys})]`);
      toolCalls.push({ name: block.name || 'unknown', args });
    }
  }
  return { text: parts.join('\n') || '', toolCalls };
}
