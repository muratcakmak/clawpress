import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AgentIdentity } from './types.js';

/**
 * Search for IDENTITY.md in common OpenClaw locations:
 * 1. ~/.openclaw/IDENTITY.md
 * 2. Project roots (passed in)
 * 3. ~/IDENTITY.md
 */

const SEARCH_PATHS = [
  path.join(os.homedir(), '.openclaw', 'IDENTITY.md'),
  path.join(os.homedir(), 'openclaw', 'IDENTITY.md'),
  path.join(os.homedir(), 'IDENTITY.md'),
];

function parseField(content: string, field: string): string | null {
  // Match "- **Field:** value" or "- **Field:** value"
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const match = content.match(re);
  if (!match) return null;
  const val = match[1].trim();
  // Strip markdown formatting and parenthetical notes
  return val.replace(/\*\*/g, '').replace(/\(.*?\)/g, '').trim() || null;
}

export function readIdentity(projectPaths?: string[]): AgentIdentity | null {
  const paths = [...SEARCH_PATHS];
  if (projectPaths) {
    for (const p of projectPaths) {
      paths.push(path.join(p, 'IDENTITY.md'));
    }
  }

  for (const filePath of paths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      const name = parseField(content, 'Name');
      if (!name) continue;

      return {
        name,
        nature: parseField(content, 'Nature'),
        voice: parseField(content, 'Voice'),
        emoji: parseField(content, 'Emoji'),
      };
    } catch {
      continue;
    }
  }

  return null;
}
