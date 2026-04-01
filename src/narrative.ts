import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import { fmt, fmtCost } from './report-data.js';

function verbose(...args: unknown[]) {
  if ((globalThis as any).__VERBOSE) console.log('  [verbose]', ...args);
}
import type { ReportData, NarrativesOutput, ProjectSpotlight, SessionAnalysis } from './types.js';

const JSON_SCHEMA: string = JSON.stringify({
  type: 'object',
  properties: {
    leadStory: {
      type: 'string',
      description: 'A 4-6 sentence lead paragraph. Open with a punchy hook ("Stop the presses", "Hold the front page"). Reference: total sessions, tokens, cost, top project, % vs average. Use metaphors — sports, weather, Wall Street. End with a kicker sentence. Min 80 words.',
    },
    projectSpotlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          narrative: {
            type: 'string',
            description: '3-5 sentence narrative. Synthesize session titles and git commits into what was actually built or fixed — name specific things, not "various tasks". If multiple editors were used, describe the workflow dynamic. Write like a sharp reporter, not a data dashboard. Min 50 words.',
          },
        },
        required: ['project', 'narrative'],
      },
      description: 'One entry per project with 2+ sessions. Tell the story — what was built, what patterns emerge.',
    },
    forecast: {
      type: 'string',
      description: '3-4 sentences about work patterns. Name the peak hour. Comment on whether this is a morning/afternoon/night coder. Mention the streak. Predict what tomorrow might bring based on momentum. Use weather metaphors. Min 40 words.',
    },
    toolShed: {
      type: 'string',
      description: '3-4 sentences about editor and model usage. State which editor dominated and by how much. If multiple editors were used, describe the workflow pattern. Name the top model and call count. Comment on cost efficiency. Min 40 words.',
    },
    sportsPage: {
      type: 'string',
      description: '3-4 sentences celebrating achievements. Reference the streak (and how close to record). Name the longest session with message count. Name the priciest session with cost. Use sports metaphors — records, championships, MVP. Min 40 words.',
    },
  },
  required: ['leadStory', 'projectSpotlights', 'forecast', 'toolShed', 'sportsPage'],
});

// ── AI CLI chain ──

interface AiCli {
  id: string;
  name: string;
  check: () => boolean;
  run: (prompt: string) => string;
}

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 120000, maxBuffer: 4 * 1024 * 1024 };
const CHECK_OPTS = { encoding: 'utf-8' as const, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

function cliExists(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, CHECK_OPTS); return true; } catch { return false; }
}

function runOpenRouter(prompt: string): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const model = (globalThis as any).__MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4';
  verbose(`OpenRouter model: ${model}`);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
  });
  // Use sync HTTP via a child process curl call
  const result = execFileSync('curl', [
    '-s', 'https://openrouter.ai/api/v1/chat/completions',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', body,
  ], { ...EXEC_OPTS, timeout: 120000 });
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.choices?.[0]?.message?.content || '';
}

const AI_CLIS: AiCli[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    check: () => cliExists('claude', ['--version']),
    run: (prompt: string) => {
      const model = (globalThis as any).__MODEL || 'claude-sonnet-4-6';
      return execFileSync('claude', ['-p', '--model', model], { ...EXEC_OPTS, input: prompt });
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    check: () => cliExists('codex', ['--version']),
    run: (prompt: string) => execFileSync('codex', ['exec', '-'], { ...EXEC_OPTS, input: prompt }),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    check: () => cliExists('gemini', ['--version']),
    run: (prompt: string) => execFileSync('gemini', ['-p', prompt], EXEC_OPTS),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    check: () => cliExists('opencode', ['--version']),
    run: (prompt: string) => execFileSync('opencode', ['run', prompt], EXEC_OPTS),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    check: () => !!process.env.OPENROUTER_API_KEY,
    run: runOpenRouter,
  },
];

function findAvailableClis(): AiCli[] {
  const provider = (globalThis as any).__PROVIDER as string | undefined;
  const candidates = provider ? AI_CLIS.filter(c => c.id === provider) : AI_CLIS;

  if (provider && candidates.length === 0) {
    console.error(`  ⚠ Unknown provider "${provider}". Available: ${AI_CLIS.map(c => c.id).join(', ')}`);
    return [];
  }

  const available: AiCli[] = [];
  for (const cli of candidates) {
    try { if (cli.check()) available.push(cli); } catch { /* not available */ }
  }
  return available;
}

/** Truncate session name to something readable — remove prompt leakage */
function cleanSessionName(name: string | null): string {
  if (!name) return 'Untitled session';
  // Remove system-reminder leakage, XML tags, and very long prompt text
  let clean = name
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // If it looks like a raw prompt (starts with "You are"), truncate
  if (clean.startsWith('You are ') || clean.startsWith('Given this ')) {
    return 'AI narrative generation session';
  }
  // Cap at 80 chars
  if (clean.length > 80) clean = clean.substring(0, 77) + '...';
  return clean || 'Untitled session';
}

export async function generateNarratives(reportData: ReportData): Promise<NarrativesOutput> {
  const clis = findAvailableClis();

  if (clis.length === 0) {
    console.log('  No AI CLI found — using template narratives');
    return fallbackNarratives(reportData);
  }

  const context = buildContext(reportData);
  const prompt = buildPrompt(reportData, context);
  const jsonPrompt = prompt + `\n\nIMPORTANT: Respond ONLY with valid JSON matching this schema. No markdown, no code blocks, no explanation — just the raw JSON object.\n\n${JSON_SCHEMA}`;

  verbose(`Prompt length: ${jsonPrompt.length} chars`);
  verbose(`Context preview:\n${context.substring(0, 1000)}\n  ...`);

  for (const cli of clis) {
    console.log(`  Trying ${cli.name}...`);
    try {
      const start = Date.now();
      const result = cli.run(jsonPrompt);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      verbose(`${cli.name} responded in ${elapsed}s, ${result.length} chars`);

      if (!result || result.trim().length < 10) {
        console.error(`  ⚠ ${cli.name} returned empty, trying next...`);
        continue;
      }

      verbose(`Raw response:\n${result.substring(0, 2000)}${result.length > 2000 ? '\n  ...(truncated)' : ''}`);

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`  ⚠ ${cli.name} returned no JSON, trying next...`);
        verbose(`First 300 chars: ${result.substring(0, 300)}`);
        continue;
      }

      verbose(`JSON extracted: ${jsonMatch[0].length} chars`);
      const parsed: NarrativesOutput = JSON.parse(jsonMatch[0]);
      verbose(`Parsed OK — leadStory: ${parsed.leadStory?.length} chars, spotlights: ${parsed.projectSpotlights?.length}`);

      if (!parsed.leadStory || parsed.leadStory.length < 50) {
        console.error(`  ⚠ ${cli.name} lead story too short, trying next...`);
        continue;
      }

      console.log(`  ✓ Narratives generated via ${cli.name}`);
      return parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠ ${cli.name} failed: ${msg}`);
      continue;
    }
  }

  console.log('  All AI CLIs failed — using template narratives');
  return fallbackNarratives(reportData);
}

function getGitLog(fullPath: string, sinceDate: string, untilDate: string): string[] {
  try {
    if (!fs.existsSync(fullPath)) { verbose(`Git: ${fullPath} does not exist`); return []; }
    const result = execSync(
      `git log --since="${sinceDate}" --until="${untilDate} 23:59:59" --oneline --no-merges --max-count=20`,
      { cwd: fullPath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = result.trim().split('\n').filter(Boolean);
    verbose(`Git: ${fullPath} → ${lines.length} commits (${sinceDate} to ${untilDate})`);
    return lines;
  } catch {
    verbose(`Git: ${fullPath} → no repo or error`);
    return [];
  }
}

function toDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildContext(data: ReportData): string {
  const lines: string[] = [];
  const { rangeType, rangeLabel, frontPage, editorRoundup, projectBeat, modelWatch, toolTimes, markets, weatherReport, sports, taskStories, dailyBreakdown, context } = data;

  if (data.agentIdentity) {
    const id = data.agentIdentity;
    lines.push(`Agent Identity: ${id.name}${id.nature ? ` (${id.nature})` : ''}${id.voice ? ` — voice: ${id.voice}` : ''}`);
    lines.push('');
  }
  lines.push(`Period: ${rangeLabel} (${rangeType})`);
  lines.push(`Sessions: ${frontPage.sessions} | Tokens: ${fmt(frontPage.tokens.input + frontPage.tokens.output)} | Est. Cost: ${fmtCost(frontPage.cost)} | Active Hours: ${frontPage.activeHours}`);
  lines.push(`All-time: ${context.allTimeTotal} sessions over ${context.totalDays} days (avg ${context.dailyAverage}/day)`);
  lines.push(`vs Average: ${frontPage.comparisons.vsAverage > 0 ? '+' : ''}${frontPage.comparisons.vsAverage}% | vs Previous Period: ${frontPage.comparisons.vsPrevious > 0 ? '+' : ''}${frontPage.comparisons.vsPrevious}`);
  lines.push('');

  if (dailyBreakdown && dailyBreakdown.length > 0) {
    lines.push('Daily breakdown:');
    for (const d of dailyBreakdown) lines.push(`  ${d.day} ${d.dateLabel}: ${d.count} sessions`);
    lines.push('');
  }

  lines.push('Editors:');
  for (const e of editorRoundup) lines.push(`  ${e.label}: ${e.count} sessions (${e.pct}%)`);
  lines.push('');

  lines.push('Projects:');
  for (const p of projectBeat) lines.push(`  ${p.name}: ${p.count} sessions`);
  lines.push('');

  if (modelWatch.length > 0) {
    lines.push('Models:');
    for (const m of modelWatch) lines.push(`  ${m.name}: ${m.count} calls (${m.pct}%)`);
    lines.push('');
  }

  if (toolTimes.length > 0) {
    lines.push('Top tools:');
    for (const t of toolTimes) lines.push(`  ${t.name}: ${t.count} calls`);
    lines.push('');
  }

  lines.push(`Peak hour: ${weatherReport.peakLabel}`);
  lines.push(`Streak: ${sports.currentStreak}d current, ${sports.longestStreak}d longest`);
  if (sports.longestSession) lines.push(`Longest session: "${cleanSessionName(sports.longestSession.name)}" (${sports.longestSession.bubbleCount} msgs, ${sports.longestSession.editorLabel})`);
  if (sports.priciestSession?.cost && sports.priciestSession.cost > 0) lines.push(`Priciest session: "${cleanSessionName(sports.priciestSession.name)}" (${fmtCost(sports.priciestSession.cost)})`);
  lines.push('');

  if (markets.totalCost > 0) {
    lines.push(`Cost: ${fmtCost(markets.totalCost)} total, ${fmtCost(markets.costPerSession)}/session`);
    for (const e of markets.byEditor) lines.push(`  ${e.label}: ${fmtCost(e.cost)}`);
    lines.push('');
  }

  // Session titles grouped by project — cleaned
  const byProject: Record<string, SessionAnalysis[]> = {};
  for (const t of taskStories) {
    const key = t.project || 'Other';
    if (!byProject[key]) byProject[key] = [];
    byProject[key].push(t);
  }

  const sinceStr = toDateStr(data.dateFrom);
  const untilStr = toDateStr(data.dateTo);

  // Build fullPath lookup from projectBeat
  const projectPaths: Record<string, string> = {};
  for (const p of projectBeat) projectPaths[p.name] = p.fullPath;

  lines.push('Sessions by project:');
  for (const [project, sessions] of Object.entries(byProject)) {
    lines.push(`\n  [${project}] — ${sessions.length} sessions:`);
    for (const s of sessions.slice(0, 12)) {
      const name = cleanSessionName(s.name);
      const parts: string[] = [`    - "${name}"`];
      if (s.editorLabel) parts.push(`via ${s.editorLabel}`);
      if (s.bubbleCount) parts.push(`${s.bubbleCount} msgs`);
      if (s.cost > 0) parts.push(fmtCost(s.cost));
      lines.push(parts.join(' '));
    }
    if (sessions.length > 12) lines.push(`    ... and ${sessions.length - 12} more`);

    // Git commit history for this project
    const fullPath = projectPaths[project];
    if (fullPath) {
      const commits = getGitLog(fullPath, sinceStr, untilStr);
      if (commits.length > 0) {
        lines.push(`    Git commits in this period:`);
        for (const c of commits) lines.push(`      - ${c}`);
      }
    }
  }

  return lines.join('\n');
}

function buildPrompt(data: ReportData, context: string): string {
  const id = data.agentIdentity;
  const agentName = id?.name || null;
  const agentVoice = id?.voice || null;

  const identityBlock = agentName
    ? `\nAGENT IDENTITY:
- The primary agent's name is "${agentName}". Use this name prominently in narratives.${agentVoice ? `\n- The agent's voice/personality: ${agentVoice}. Let this color the writing tone.` : ''}
- When the agent operates through different editors (Claude Code, Cursor, etc.), treat them as ${agentName}'s tools/vehicles, not separate agents.
- Example: "${agentName} fired up Claude Code and tracked the bug across three files" rather than "Claude Code tracked the bug."\n`
    : '';

  return `You are the editor-in-chief of "ClawPress", a witty newspaper that covers AI agent activity.
${identityBlock}
PERSPECTIVE:
- Write from the AI AGENTS' perspective, not the developer's. The agents are the protagonists — they investigate, build, debug, and ship.${agentName ? `\n- The lead agent is "${agentName}". Use this name instead of generic references like "the agents" where possible.` : `\n- Refer to agents by their editor name (e.g., "Claude Code", "Cursor", "OpenCode") as if they are reporters, operatives, or athletes on a team.`}
- The human is the "operator" or "handler" who dispatches missions. The agents execute.
- Example: Instead of "our developer hunted down a bug", write "${agentName || 'Claude Code'} tracked the bug across three files before cornering it in the config layer."

WRITING STYLE:
- Write like a sharp sports journalist covering a championship season
- Open with punchy hooks: "Stop the presses!", "Hold the front page!", "The agents were unleashed!"
- Use vivid metaphors from sports, weather, Wall Street, or war rooms
- Reference SPECIFIC project names, session counts, costs, and message counts
- Celebrate what the agents accomplished — this is their victory lap
- End paragraphs with memorable kicker lines
- Each section should be 3-6 sentences, minimum 40-80 words

WHAT TO WRITE about ${data.rangeLabel}:

1. LEAD STORY (4-6 sentences, 80+ words): The big picture from the agents' perspective. How many sessions they ran, tokens processed, cost. Which project the agents focused on. How this compares to average. A memorable opening and closing line.

2. PROJECT SPOTLIGHTS (3-5 sentences each, 50+ words): For each project with 2+ sessions, tell the STORY of what the agents did. Git commit messages are provided — use them to understand what was actually built. Describe the agents' workflow. Be a reporter covering the agents — vivid, specific, opinionated. End with a verdict.

3. FORECAST (3-4 sentences, 40+ words): When are the agents most active? Morning, afternoon, night? Comment on the streak. What might the agents tackle tomorrow based on momentum?

4. TOOL SHED (3-4 sentences, 40+ words): Which agent/editor dominated? If multiple were used, describe the agent team dynamics (e.g., "Cursor ran reconnaissance while Claude Code executed the final push"). Name the top AI model.

5. SPORTS PAGE (3-4 sentences, 40+ words): Celebrate the agents' streak. Name the longest session (messages) and priciest session (cost). Use sports language — the agents are the athletes.

DATA:
${context}`;
}

// ── Spotlight helpers ──

interface ThemeRule {
  theme: string;
  patterns: RegExp[];
}

const THEME_RULES: ThemeRule[] = [
  { theme: 'bug squashing', patterns: [/\bfix/i, /\bbug/i, /\bissue/i, /\berror/i, /\bcrash/i, /\bbroken/i, /\bpatch/i] },
  { theme: 'feature work', patterns: [/\bfeature/i, /\badd\b/i, /\bimplement/i, /\bbuild/i, /\bcreate/i, /\bnew\b/i, /\bintegrat/i] },
  { theme: 'infrastructure', patterns: [/\bsetup/i, /\bconfig/i, /\binstall/i, /\binit/i, /\bbootstrap/i, /\bmigrat/i, /\bdep(endenc)/i] },
  { theme: 'refactoring', patterns: [/\brefactor/i, /\bclean/i, /\brename/i, /\brestructur/i, /\breorganiz/i, /\bsimplif/i] },
  { theme: 'testing', patterns: [/\btest/i, /\bspec\b/i, /\blint/i, /\bci\b/i, /\bvalidat/i, /\bcheck/i] },
  { theme: 'UI polish', patterns: [/\bdesign/i, /\bui\b/i, /\bstyle/i, /\blayout/i, /\bcss/i, /\bresponsiv/i, /\bcomponent/i, /\bfront.?end/i] },
  { theme: 'release prep', patterns: [/\bdeploy/i, /\bpublish/i, /\brelease/i, /\bversion/i, /\bship/i, /\bprod/i] },
  { theme: 'research', patterns: [/\bresearch/i, /\bexplor/i, /\binvestigat/i, /\bprototyp/i, /\bspike/i, /\bpoc\b/i] },
  { theme: 'documentation', patterns: [/\bdoc/i, /\breadme/i, /\bcomment/i, /\bchangelog/i] },
  { theme: 'performance tuning', patterns: [/\bperf/i, /\boptimiz/i, /\bspeed/i, /\bcach/i, /\bbenchmark/i] },
  { theme: 'AI tooling', patterns: [/\bnarrative/i, /\bai\b/i, /\bgenerat/i, /\bprompt/i, /\bmodel/i, /\bllm/i, /\bclaude/i] },
];

function synthesizeWorkThemes(sessions: SessionAnalysis[]): string | null {
  const names = sessions
    .map(s => s.name || '')
    .filter(n => n.length > 0 && !n.startsWith('You are ') && !n.startsWith('Given this '));

  if (names.length === 0) return null;

  const allText = names.join(' ');
  const scored: { theme: string; hits: number }[] = [];

  for (const rule of THEME_RULES) {
    const hits = rule.patterns.reduce((sum, p) => sum + (p.test(allText) ? 1 : 0), 0);
    if (hits > 0) scored.push({ theme: rule.theme, hits });
  }

  scored.sort((a, b) => b.hits - a.hits);
  const top = scored.slice(0, 3);

  if (top.length === 0) return null;
  if (top.length === 1) return top[0].theme;
  if (top.length === 2) return `${top[0].theme} and ${top[1].theme}`;
  return `${top[0].theme}, ${top[1].theme}, and ${top[2].theme}`;
}

function describeIntensity(sessions: SessionAnalysis[]): string {
  const quick = sessions.filter(s => s.bubbleCount < 20).length;
  const moderate = sessions.filter(s => s.bubbleCount >= 20 && s.bubbleCount < 80).length;
  const deep = sessions.filter(s => s.bubbleCount >= 80 && s.bubbleCount < 150).length;
  const marathon = sessions.filter(s => s.bubbleCount >= 150).length;
  const total = sessions.length;
  const sumMsgs = sessions.reduce((s, x) => s + x.bubbleCount, 0);
  const avgMsgs = total > 0 ? Math.round(sumMsgs / total) : 0;
  if (avgMsgs === 0) return 'quick, lightweight exchanges';

  if (marathon > 0 && marathon >= total / 2) return `a series of marathon sessions averaging ${avgMsgs} messages each`;
  if (marathon > 0) return `mostly focused work with ${marathon === 1 ? 'one' : marathon} marathon session${marathon > 1 ? 's' : ''} pushing past 150 messages`;
  if (deep > 0 && quick === 0) return `sustained deep work averaging ${avgMsgs} messages per session`;
  if (deep > 0) return `a mix of quick iterations and deep dives, averaging ${avgMsgs} messages per session`;
  if (quick >= total * 0.7) return `rapid-fire iterations — lean sessions averaging just ${avgMsgs} messages each`;
  if (moderate >= total * 0.5) return `steady, methodical sessions averaging ${avgMsgs} messages each`;
  return `a varied pace across sessions, averaging ${avgMsgs} messages each`;
}

/** Summarize commit messages into a concise description of the work */
function extractSpecificWork(commitMsgs: string[]): string | null {
  if (commitMsgs.length === 0) return null;

  // Clean up commit messages into short digestible phrases
  const cleaned: string[] = [];
  for (const msg of commitMsgs) {
    let m = msg.replace(/[.!]$/, '').trim();
    // Strip conventional commit prefixes like "fix:", "feat:", "refactor:", "chore:"
    m = m.replace(/^(?:fix|feat|feature|refactor|chore|docs|style|test|ci|build|perf)(?:\([^)]*\))?:\s*/i, '');
    // Trim to first clause
    m = m.split(/[,;—–]/)[0].trim();
    // Skip very short or very long
    if (m.length > 5 && m.length < 60) cleaned.push(m.toLowerCase());
  }

  if (cleaned.length === 0) return null;

  // Deduplicate and take top 3
  const unique = [...new Set(cleaned)];
  const display = unique.slice(0, 3);

  if (display.length === 1) return display[0];
  if (display.length === 2) return `${display[0]} and ${display[1]}`;
  return `${display[0]}, ${display[1]}, and ${display[2]}`;
}

/** Synthesize work themes from commit messages */
function synthesizeWorkFromCommits(commitMsgs: string[]): string | null {
  if (commitMsgs.length === 0) return null;

  const allText = commitMsgs.join(' ');
  const scored: { theme: string; hits: number }[] = [];

  // Reuse THEME_RULES but also check commit-specific patterns
  const commitThemeRules: ThemeRule[] = [
    ...THEME_RULES,
    { theme: 'version bumps and releases', patterns: [/\bv?\d+\.\d+/i, /\bbump/i, /\brelease/i, /\bchangelog/i] },
    { theme: 'dependency management', patterns: [/\bupgrade/i, /\bupdate dep/i, /\bpackage/i, /\bnpm/i, /\byarn/i] },
  ];

  for (const rule of commitThemeRules) {
    const hits = rule.patterns.reduce((sum, p) => sum + (p.test(allText) ? 1 : 0), 0);
    if (hits > 0) scored.push({ theme: rule.theme, hits });
  }

  scored.sort((a, b) => b.hits - a.hits);
  const top = scored.slice(0, 2);

  if (top.length === 0) return null;
  if (top.length === 1) return top[0].theme;
  return `${top[0].theme} and ${top[1].theme}`;
}

// ── Rich fallback templates (no AI needed) ──

function fallbackNarratives(data: ReportData): NarrativesOutput {
  const { frontPage, editorRoundup, projectBeat, weatherReport, sports, rangeType, markets, taskStories, context: ctx } = data;
  const periodWord = rangeType === 'day' ? 'day' : rangeType === 'week' ? 'week' : 'month';
  const topEditor = editorRoundup[0];
  const topProject = projectBeat[0];
  const secondProject = projectBeat[1];
  const vsAvg = frontPage.comparisons.vsAverage;
  const totalTokens = frontPage.tokens.input + frontPage.tokens.output;
  const agent = data.agentIdentity?.name || 'The agents';

  // ── Lead Story ──
  const intensity = vsAvg > 200 ? 'an absolute barn-burner of a' : vsAvg > 100 ? 'a powerhouse' : vsAvg > 50 ? 'a solid' : vsAvg > 0 ? 'a respectable' : vsAvg > -30 ? 'a steady' : 'a quiet';
  let leadStory = `${agent} logged ${intensity} ${periodWord} — ${frontPage.sessions} sessions across ${frontPage.activeHours} active hours, processing ${fmt(totalTokens)} tokens`;
  if (frontPage.cost > 0) leadStory += ` at an estimated ${fmtCost(frontPage.cost)}`;
  leadStory += '.';
  if (topProject) {
    leadStory += ` The ${topProject.name} project was the primary mission with ${topProject.count} sessions`;
    if (secondProject) leadStory += `, while ${secondProject.name} kept the agents busy with ${secondProject.count}`;
    leadStory += '.';
  }
  if (vsAvg > 0) {
    leadStory += ` That's ${Math.abs(vsAvg)}% above the daily average of ${ctx.dailyAverage} sessions — `;
    leadStory += vsAvg > 150 ? `${agent} ${agent === 'The agents' ? 'were' : 'was'} operating at full throttle.` : `a pace that says ${agent} came to ship.`;
  } else if (vsAvg < -30) {
    leadStory += ` A lighter deployment than the ${ctx.dailyAverage}/day average, but even ${agent === 'The agents' ? 'the best agents need' : `${agent} needs`} downtime between missions.`;
  }
  if (topEditor) leadStory += ` ${agent === 'The agents' ? topEditor.label : agent} led the operation${agent !== 'The agents' ? ` via ${topEditor.label}` : ''}, handling ${topEditor.count} of ${frontPage.sessions} sessions (${topEditor.pct}%).`;

  // ── Project Spotlights ──
  const sinceStr = toDateStr(data.dateFrom);
  const untilStr = toDateStr(data.dateTo);

  const projectSpotlights: ProjectSpotlight[] = projectBeat.filter(p => p.count >= 2).slice(0, 6).map((p, idx) => {
    const sessions = taskStories.filter(t => t.project === p.name);
    const editors = [...new Set(sessions.map(s => s.editorLabel).filter(Boolean))];
    const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
    const totalMsgs = sessions.reduce((sum, s) => sum + s.bubbleCount, 0);
    const maxSession = sessions.reduce((max, s) => s.bubbleCount > (max?.bubbleCount || 0) ? s : max, sessions[0]);
    const avgMsgs = sessions.length > 0 ? Math.round(totalMsgs / sessions.length) : 0;

    // Git commits — the real story
    const commits = getGitLog(p.fullPath, sinceStr, untilStr);
    // Extract just the message part (strip hash prefix)
    const commitMsgs = commits.map(c => c.replace(/^[a-f0-9]+ /, ''));

    // Extract specific nouns from commits: what was actually touched
    const specificWork = extractSpecificWork(commitMsgs);
    // Themes from both commits and session names
    const themes = synthesizeWorkThemes(sessions);
    const commitThemes = synthesizeWorkFromCommits(commitMsgs);

    const parts: string[] = [];

    // Opening — use commit count + session count to paint the picture
    const editorClause = editors.length === 1 ? `, with ${editors[0]} running point` : editors.length > 1 ? `, with ${editors.join(' and ')} teaming up` : '';
    if (commits.length > 0) {
      parts.push(`${agent} landed ${commits.length} commit${commits.length !== 1 ? 's' : ''} on ${p.name} across ${p.count} sessions${editorClause}.`);
    } else if (p.count > 0) {
      parts.push(`${p.name} saw ${p.count} session${p.count !== 1 ? 's' : ''} from ${agent}${editorClause}.`);
    }

    // The meat — what was actually done, from commits first, then session themes
    if (specificWork) {
      parts.push(`${agent} worked on ${specificWork}.`);
    }
    const bestThemes = commitThemes || themes;
    if (bestThemes && specificWork) {
      parts.push(`The focus: ${bestThemes}.`);
    } else if (bestThemes) {
      parts.push(`The commit history reads as ${bestThemes}.`);
    }

    // Multi-editor workflow insight
    if (editors.length > 1) {
      // Figure out which editor had more sessions
      const editorCounts: Record<string, number> = {};
      for (const s of sessions) { if (s.editorLabel) editorCounts[s.editorLabel] = (editorCounts[s.editorLabel] || 0) + 1; }
      const sorted = Object.entries(editorCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        parts.push(`${sorted[0][0]} carried the bulk with ${sorted[0][1]} sessions while ${sorted[1][0]} backed it up with ${sorted[1][1]} — a two-agent workflow suggesting a build-and-review cadence.`);
      }
    }

    // Depth and cost — one combined sentence
    if (maxSession && maxSession.bubbleCount > 80) {
      let depth = `The deepest session ran ${maxSession.bubbleCount} messages`;
      if (maxSession.cost > 0) depth += ` at ${fmtCost(maxSession.cost)}`;
      if (totalCost > 0 && sessions.length > 1) depth += `, with the full ${p.count}-session tab coming to ${fmtCost(totalCost)}`;
      depth += '.';
      parts.push(depth);
    } else if (totalCost > 0) {
      parts.push(`${p.count} sessions, ${totalMsgs} messages, ${fmtCost(totalCost)} — ${avgMsgs < 15 ? 'quick, surgical work' : avgMsgs < 50 ? 'steady, methodical progress' : 'deep, focused engagement'}.`);
    }

    return { project: p.name, narrative: parts.join(' ') };
  });

  // ── Forecast ──
  const peakHour = weatherReport.peakHour;
  const timeOfDay = peakHour < 9 ? 'early morning' : peakHour < 12 ? 'morning' : peakHour < 17 ? 'afternoon' : peakHour < 21 ? 'evening' : 'late night';
  let forecast = `Peak activity landed at ${weatherReport.peakLabel}, with ${agent} running hottest during ${timeOfDay} hours.`;
  forecast += ` With ${frontPage.activeHours} active hours logged, ${agent} covered a solid stretch of the clock.`;
  if (sports.currentStreak > 1) {
    forecast += ` The ${sports.currentStreak}-day operational streak shows no signs of slowing — expect ${agent} to keep pushing.`;
  }
  if (vsAvg > 100) {
    forecast += ` At this pace, tomorrow's forecast calls for heavy deployments with a chance of refactoring.`;
  } else if (vsAvg < -20) {
    forecast += ` The lighter deployment suggests either a strategic pause or ${agent} ${agent === 'The agents' ? 'are' : 'is'} gearing up for a bigger mission.`;
  }

  // ── Tool Shed ──
  let toolShed = '';
  if (topEditor) {
    toolShed = agent !== 'The agents'
      ? `${agent} ran ${topEditor.count} of ${frontPage.sessions} sessions through ${topEditor.label} (${topEditor.pct}%)`
      : `${topEditor.label} was the lead agent with ${topEditor.count} of ${frontPage.sessions} sessions (${topEditor.pct}%)`;
    const secondEditor = editorRoundup[1];
    if (secondEditor && secondEditor.count > 1) {
      toolShed += `, while ${secondEditor.label} handled ${secondEditor.count} sessions`;
      if (editorRoundup.length > 2) toolShed += ` — a multi-tool arsenal where each plays its role`;
    }
    toolShed += '.';
  }
  if (markets.totalCost > 0) {
    toolShed += ` The total operational cost came to ${fmtCost(markets.totalCost)}, averaging ${fmtCost(markets.costPerSession)} per session.`;
    if (markets.byEditor.length > 1) {
      toolShed += ` ${markets.byEditor[0].label} accounted for the lion's share of the budget.`;
    }
  }

  // ── Sports Page ──
  let sportsPage = `Current operational streak: ${sports.currentStreak} day${sports.currentStreak !== 1 ? 's' : ''} and counting`;
  if (sports.currentStreak >= sports.longestStreak && sports.longestStreak > 1) {
    sportsPage += ` — ${agent} just tied the all-time record! Can ${agent === 'The agents' ? 'they' : 'it'} break it tomorrow?`;
  } else if (sports.longestStreak > sports.currentStreak) {
    sportsPage += ` (the all-time record stands at ${sports.longestStreak} days)`;
  }
  sportsPage += '.';
  if (sports.longestSession) {
    sportsPage += ` The endurance award goes to "${cleanSessionName(sports.longestSession.name)}" at ${sports.longestSession.bubbleCount} messages — the kind of mission that starts as a quick fix and ends as an epic.`;
  }
  if (sports.priciestSession && sports.priciestSession.cost > 0) {
    sportsPage += ` The highest-budget operation was "${cleanSessionName(sports.priciestSession.name)}" at ${fmtCost(sports.priciestSession.cost)}.`;
  }

  return { leadStory, projectSpotlights, forecast, toolShed, sportsPage };
}
