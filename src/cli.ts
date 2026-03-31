#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateReport } from './report-data.js';
import { generateHtml } from './report-html.js';
import type { CliOpts, RangeType } from './types.js';
import { maybePromptGithubStar } from './star-prompt.js';

const REPORTS_DIR = path.join(os.homedir(), '.clawpress', 'reports');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
(globalThis as any).__VERBOSE = VERBOSE;
const LIGHT = args.includes('--light');

const providerIdx = args.findIndex(a => a === '--provider');
if (providerIdx !== -1 && args[providerIdx + 1]) {
  (globalThis as any).__PROVIDER = args[providerIdx + 1];
}
const modelIdx = args.findIndex(a => a === '--model');
if (modelIdx !== -1 && args[modelIdx + 1]) {
  (globalThis as any).__MODEL = args[modelIdx + 1];
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  ClawPress — Newspaper-style reports for your AI coding sessions

  Usage: clawpress [options] [YYYY-MM-DD]

  Options:
    (no args)          Yesterday's report (default)
    YYYY-MM-DD         Report for a specific date
    --week             Last 7 days
    --last-week        Previous Monday–Sunday
    --month            Last calendar month
    --provider ID      AI provider for narratives (default: tries all)
                       claude, codex, gemini, opencode, openrouter
    --model NAME       Model to use (for openrouter or claude providers)
    --light            Light color theme (default: dark)
    --verbose, -v      Show detailed logs (prompt, response, git, timing)
    --help, -h         Show this help

  Examples:
    clawpress                              Yesterday's report
    clawpress 2026-03-20                   Specific date
    clawpress --week --provider opencode   Weekly report via OpenCode
    clawpress --provider openrouter --model google/gemini-2.5-flash:free
    clawpress --provider claude --model claude-sonnet-4-6 -v

  Reports saved to ~/.clawpress/reports/
  AI narratives via: claude, codex, gemini, opencode CLI, or OpenRouter API

  Environment:
    OPENROUTER_API_KEY    Required for --provider openrouter
    OPENROUTER_MODEL      Override model (default: anthropic/claude-haiku-4)
`);
  process.exit(0);
}

function localYesterday(): string {
  const n = new Date();
  n.setDate(n.getDate() - 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseOpts(): CliOpts {
  const today = localYesterday();

  if (args.includes('--week')) {
    const end = new Date(today + 'T23:59:59.999');
    const start = new Date(today + 'T00:00:00');
    start.setDate(start.getDate() - 6);
    const startStr = toLocalDateStr(start);
    const endDate = new Date(today + 'T00:00:00');
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return {
      dateFrom: start.getTime(),
      dateTo: end.getTime(),
      rangeType: 'week',
      label: `${startLabel} – ${endLabel}`,
      filename: `weekly-claw-${startStr}.html`,
    };
  }

  if (args.includes('--last-week')) {
    const todayDate = new Date(today + 'T00:00:00');
    const dow = todayDate.getDay();
    const daysToMonday = dow === 0 ? 6 : dow - 1;
    const thisMonday = new Date(todayDate);
    thisMonday.setDate(todayDate.getDate() - daysToMonday);
    const prevMonday = new Date(thisMonday);
    prevMonday.setDate(thisMonday.getDate() - 7);
    const prevSunday = new Date(thisMonday);
    prevSunday.setDate(thisMonday.getDate() - 1);
    const startStr = toLocalDateStr(prevMonday);
    const startLabel = prevMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = prevSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return {
      dateFrom: prevMonday.getTime(),
      dateTo: new Date(toLocalDateStr(prevSunday) + 'T23:59:59.999').getTime(),
      rangeType: 'week',
      label: `${startLabel} – ${endLabel}`,
      filename: `weekly-claw-${startStr}.html`,
    };
  }

  if (args.includes('--month')) {
    const todayDate = new Date(today + 'T00:00:00');
    const prevMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
    const lastDay = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0);
    const monthLabel = prevMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const monthSlug = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
    return {
      dateFrom: prevMonth.getTime(),
      dateTo: new Date(toLocalDateStr(lastDay) + 'T23:59:59.999').getTime(),
      rangeType: 'month',
      label: monthLabel,
      filename: `monthly-claw-${monthSlug}.html`,
    };
  }

  const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dayStr = dateArg || today;
  const date = new Date(dayStr + 'T00:00:00');
  const dateFormatted = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return {
    dateFrom: new Date(dayStr + 'T00:00:00').getTime(),
    dateTo: new Date(dayStr + 'T23:59:59.999').getTime(),
    rangeType: 'day',
    label: dateFormatted,
    filename: `daily-claw-${dayStr}.html`,
  };
}

const opts = parseOpts();
console.log('');
console.log(`  ✦ ClawPress — ${opts.label}`);
console.log('');

await maybePromptGithubStar();

try {
  console.log('  Scanning editors...');
  const data = await generateReport(opts);

  console.log(`  ${data.frontPage.sessions} sessions found`);

  const html = generateHtml(data, { light: LIGHT });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, opts.filename);

  fs.writeFileSync(outPath, html);
  console.log(`  ✓ Saved: ${outPath}`);
  console.log(`  ${data.headline.text} — ${data.headline.subtitle}`);
  console.log('');

  const open = await import('open');
  await open.default(outPath);
} catch (err: unknown) {
  const e = err as Error;
  console.error(`  ✗ Error: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
}
