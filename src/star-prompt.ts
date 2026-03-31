/**
 * One-time GitHub star prompt shown on first run.
 * Skipped when: no TTY, gh CLI not installed, or already prompted.
 * State persisted in ~/.clawpress/star-prompt.json.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline';

const REPO = 'nicepkg/openclaw';

function statePath(): string {
  return join(homedir(), '.clawpress', 'star-prompt.json');
}

async function hasBeenPrompted(): Promise<boolean> {
  const p = statePath();
  if (!existsSync(p)) return false;
  try {
    const content = await readFile(p, 'utf-8');
    const state = JSON.parse(content);
    return typeof state.prompted_at === 'string';
  } catch {
    return false;
  }
}

async function markPrompted(): Promise<void> {
  const dir = join(homedir(), '.clawpress');
  await mkdir(dir, { recursive: true });
  await writeFile(
    statePath(),
    JSON.stringify({ prompted_at: new Date().toISOString() }, null, 2),
  );
}

function isGhInstalled(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 3000,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  return !result.error && result.status === 0;
}

function starRepo(): boolean {
  const result = spawnSync('gh', ['api', '-X', 'PUT', `/user/starred/${REPO}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10000,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  return !result.error && result.status === 0;
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

export async function maybePromptGithubStar(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (await hasBeenPrompted()) return;
  if (!isGhInstalled()) return;

  // Mark before asking so we never re-prompt even if interrupted
  await markPrompted();

  const shouldStar = await ask('  ⭐ Enjoying ClawPress? Star it on GitHub? (Y/n) ');

  if (!shouldStar) return;

  const ok = starRepo();
  if (ok) {
    console.log('  ✦ Thanks for the star! 🎉');
  }
}
