import type { Chat, Message, EditorAdapter, EditorMeta } from '../types.js';
import * as claude from './claude.js';
import * as opencode from './opencode.js';
import * as cursor from './cursor.js';
import * as antigravity from './antigravity.js';

const adapters: EditorAdapter[] = [claude, opencode, cursor, antigravity];

export const EDITOR_META: Record<string, EditorMeta> = Object.fromEntries(
  adapters.map(a => [a.name, { label: a.label, color: a.color }])
);

export function getAllChats(): Chat[] {
  const all: Chat[] = [];
  for (const adapter of adapters) {
    try {
      all.push(...adapter.getChats());
    } catch {
      // Skip editors that fail silently
    }
  }
  return all.sort((a, b) => ((b.lastUpdatedAt ?? 0) as number) - ((a.lastUpdatedAt ?? 0) as number));
}

export function getMessages(chat: Chat): Message[] {
  const adapter = adapters.find(a => a.name === chat.source);
  if (!adapter) return [];
  try {
    return adapter.getMessages(chat);
  } catch {
    return [];
  }
}
