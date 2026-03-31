import type {
  CliOpts,
  ReportData,
  Chat,
  Message,
  Headline,
  HeadlineType,
  RangeType,
  SessionAnalysis,
  EditorStats,
  ProjectStats,
  ModelStats,
  ToolStats,
  DailyBreakdownEntry,
  NarrativesOutput,
} from './types.js';
import { getAllChats, getMessages, EDITOR_META } from './editors/index.js';
import { calculateCost, normalizeModelName } from './pricing.js';
import { generateNarratives } from './narrative.js';

/**
 * Generate a full report for the given date range.
 */
export async function generateReport(opts: CliOpts): Promise<ReportData> {
  const { dateFrom, dateTo, rangeType, label } = opts;
  const rangeDays: number = Math.max(1, Math.round((dateTo - dateFrom) / 86400000));

  // Get all chats
  const allChats: Chat[] = getAllChats();

  // Filter to target range
  const rangChats: Chat[] = allChats.filter((c: Chat) => {
    const ts: number | null = c.lastUpdatedAt || c.createdAt;
    return ts && ts >= dateFrom && ts <= dateTo;
  });

  // Compute all-time daily counts for comparison (using local dates)
  const dailyCounts: Record<string, number> = {};
  for (const c of allChats) {
    const ts: number | null = c.lastUpdatedAt || c.createdAt;
    if (!ts) continue;
    const dt: Date = new Date(ts);
    const d: string = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    dailyCounts[d] = (dailyCounts[d] || 0) + 1;
  }

  const allDays: string[] = Object.keys(dailyCounts).sort();
  const totalDays: number = allDays.length;
  const allTimeTotal: number = allChats.length;
  const dailyAverage: number = totalDays > 0 ? allTimeTotal / totalDays : 0;
  const sessionCount: number = rangChats.length;

  // Edition number (based on range end date)
  const endDayStr: string = toLocalDateStr(new Date(dateTo));
  const oldestDay: string = allDays[0] || endDayStr;
  const editionNumber: number = Math.max(1, Math.round((new Date(endDayStr).getTime() - new Date(oldestDay).getTime()) / 86400000) + 1);

  // Daily breakdown (for week/month reports)
  const dailyBreakdown: DailyBreakdownEntry[] = [];
  if (rangeType !== 'day') {
    const cursor: Date = new Date(dateFrom);
    const endDate: Date = new Date(dateTo);
    while (cursor <= endDate) {
      const ds: string = toLocalDateStr(cursor);
      const dayLabel: string = cursor.toLocaleDateString('en-US', { weekday: 'short' });
      const dateLabel: string = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dailyBreakdown.push({
        day: dayLabel,
        date: ds,
        dateLabel,
        count: dailyCounts[ds] || 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Analyze each chat in range
  const sessionAnalyses: SessionAnalysis[] = [];
  let totalInput: number = 0;
  let totalOutput: number = 0;
  let totalCacheRead: number = 0;
  let totalCacheWrite: number = 0;
  let totalCost: number = 0;
  const modelFreq: Record<string, number> = {};
  const toolFreq: Record<string, number> = {};
  const hourly: number[] = new Array(24).fill(0) as number[];
  const editorCounts: Record<string, number> = {};
  const projectCounts: Record<string, { name: string; fullPath: string; count: number; editors: Record<string, number> }> = {};

  for (const chat of rangChats) {
    const ts: number | null = chat.lastUpdatedAt || chat.createdAt;
    if (ts) hourly[new Date(ts).getHours()]++;

    editorCounts[chat.source] = (editorCounts[chat.source] || 0) + 1;

    if (chat.folder) {
      const projectName: string = chat.folder.split(/[/\\]/).filter(Boolean).slice(-1)[0] || chat.folder;
      if (!projectCounts[projectName]) projectCounts[projectName] = { name: projectName, fullPath: chat.folder, count: 0, editors: {} };
      projectCounts[projectName].count++;
      projectCounts[projectName].editors[chat.source] = (projectCounts[projectName].editors[chat.source] || 0) + 1;
    }

    const messages: Message[] = getMessages(chat);
    let sessionCost: number = 0;
    const sessionModels: Set<string> = new Set();

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      if (msg._model) {
        const normalized: string = normalizeModelName(msg._model) || msg._model;
        sessionModels.add(normalized);
        modelFreq[normalized] = (modelFreq[normalized] || 0) + 1;
      }
      if (msg._inputTokens) totalInput += msg._inputTokens;
      if (msg._outputTokens) totalOutput += msg._outputTokens;
      if (msg._cacheRead) totalCacheRead += msg._cacheRead;
      if (msg._cacheWrite) totalCacheWrite += msg._cacheWrite;
      if (msg._model && (msg._inputTokens || msg._outputTokens)) {
        const cost: number | null = calculateCost(msg._model, msg._inputTokens, msg._outputTokens, msg._cacheRead, msg._cacheWrite);
        if (cost) sessionCost += cost;
      }
      if (msg._toolCalls) {
        for (const tc of msg._toolCalls) { toolFreq[tc.name] = (toolFreq[tc.name] || 0) + 1; }
      }
    }

    totalCost += sessionCost;
    sessionAnalyses.push({
      name: chat.name,
      editor: chat.source,
      editorLabel: EDITOR_META[chat.source]?.label || chat.source,
      project: chat.folder ? chat.folder.split(/[/\\]/).filter(Boolean).slice(-1)[0] : null,
      bubbleCount: chat.bubbleCount || messages.length,
      model: Array.from(sessionModels)[0] || null,
      cost: sessionCost,
      createdAt: chat.createdAt,
      lastUpdatedAt: chat.lastUpdatedAt,
    });
  }

  // Headline
  const headline: Headline = generateHeadline(sessionCount, dailyCounts, dailyAverage, endDayStr, allDays, rangeType, rangeDays);

  // Active hours & peak
  const activeHours: number = hourly.filter((h: number) => h > 0).length;
  const peakHour: number = hourly.indexOf(Math.max(...hourly));
  const peakLabel: string = `${peakHour % 12 || 12}:00 ${peakHour < 12 ? 'AM' : 'PM'}`;

  // Comparisons
  const avgForRange: number = dailyAverage * rangeDays;
  const vsAverage: number = avgForRange > 0 ? Math.round(((sessionCount - avgForRange) / avgForRange) * 100) : 0;
  // vs previous equivalent period
  const prevFrom: number = dateFrom - (dateTo - dateFrom + 1);
  const prevTo: number = dateFrom - 1;
  const prevCount: number = allChats.filter((c: Chat) => { const ts: number | null = c.lastUpdatedAt || c.createdAt; return ts && ts >= prevFrom && ts <= prevTo; }).length;
  const vsPrevious: number = sessionCount - prevCount;

  // Editor roundup
  const editorRoundup: EditorStats[] = Object.entries(editorCounts)
    .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
    .map(([id, count]: [string, number]): EditorStats => ({
      id, label: EDITOR_META[id]?.label || id, color: EDITOR_META[id]?.color || '#6b7280',
      count, pct: sessionCount > 0 ? Math.round((count / sessionCount) * 100) : 0,
    }));

  // Project beat
  const projectBeat: ProjectStats[] = Object.values(projectCounts)
    .sort((a, b) => b.count - a.count).slice(0, 8)
    .map((p): ProjectStats => ({
      name: p.name, fullPath: p.fullPath, count: p.count,
      topEditor: Object.entries(p.editors).sort((a: [string, number], b: [string, number]) => b[1] - a[1])[0]?.[0] || null,
    }));

  // Model watch
  const totalModelCalls: number = Object.values(modelFreq).reduce((s: number, v: number) => s + v, 0);
  const modelWatch: ModelStats[] = Object.entries(modelFreq).sort((a: [string, number], b: [string, number]) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]: [string, number]): ModelStats => ({ name, count, pct: totalModelCalls > 0 ? Math.round((count / totalModelCalls) * 100) : 0 }));

  // Tool times
  const toolTimes: ToolStats[] = Object.entries(toolFreq).sort((a: [string, number], b: [string, number]) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]: [string, number]): ToolStats => ({ name, count }));

  // Cost by editor
  const costByEditor: Record<string, number> = {};
  for (const sa of sessionAnalyses) costByEditor[sa.editor] = (costByEditor[sa.editor] || 0) + sa.cost;

  // Streaks
  const streaks: { current: number; longest: number } = computeStreaks(allDays, endDayStr);

  // Percentile
  const allDailyCounts: number[] = (Object.values(dailyCounts) as number[]).sort((a: number, b: number) => a - b);
  const dailyRate: number = rangeType === 'day' ? sessionCount : Math.round(sessionCount / rangeDays);
  const rank: number = allDailyCounts.filter((c: number) => c <= dailyRate).length;
  const percentile: number = allDailyCounts.length > 0 ? Math.round((rank / allDailyCounts.length) * 100) : 0;

  // Notable sessions
  const longestSession: SessionAnalysis | null = [...sessionAnalyses].sort((a, b) => b.bubbleCount - a.bubbleCount)[0] || null;
  const priciestSession: SessionAnalysis | null = [...sessionAnalyses].sort((a, b) => b.cost - a.cost)[0] || null;

  const taskStories: SessionAnalysis[] = sessionAnalyses.filter((s: SessionAnalysis) => s.name).sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));

  // Build report data first (without narratives)
  const reportData: ReportData = {
    date: endDayStr,
    dateFrom,
    dateTo,
    rangeType,
    rangeLabel: label,
    dateFormatted: label,
    editionNumber,
    headline,
    dailyBreakdown,
    frontPage: {
      sessions: sessionCount,
      tokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
      cost: totalCost,
      activeHours,
      comparisons: { vsAverage, vsPrevious },
    },
    taskStories,
    editorRoundup,
    projectBeat,
    modelWatch,
    toolTimes,
    markets: {
      totalCost,
      byEditor: Object.entries(costByEditor).filter(([, c]: [string, number]) => c > 0).sort((a: [string, number], b: [string, number]) => b[1] - a[1])
        .map(([id, cost]: [string, number]): { id: string; label: string; cost: number } => ({ id, label: EDITOR_META[id]?.label || id, cost })),
      costPerSession: sessionCount > 0 ? totalCost / sessionCount : 0,
    },
    weatherReport: { hourly, peakHour, peakLabel },
    sports: {
      currentStreak: streaks.current, longestStreak: streaks.longest,
      todayPercentile: percentile, longestSession, priciestSession,
    },
    context: { dailyAverage: Math.round(dailyAverage * 10) / 10, totalDays, allTimeTotal },
    narratives: undefined as unknown as NarrativesOutput,
  };

  // Generate narratives via Claude Code
  console.log('  Generating narratives...');
  reportData.narratives = await generateNarratives(reportData);

  return reportData;
}

function generateHeadline(
  count: number,
  dailyCounts: Record<string, number>,
  dailyAverage: number,
  endDayStr: string,
  allDays: string[],
  rangeType: RangeType,
  rangeDays: number,
): Headline {
  const suffix: string = rangeType === 'week' ? ' This Week' : rangeType === 'month' ? ' This Month' : '';

  if (count === 0) {
    if (rangeType === 'day') return { text: 'REST DAY', subtitle: 'The Machines Take a Well-Deserved Break', type: 'zero' };
    return { text: 'ALL QUIET', subtitle: `No sessions detected${suffix.toLowerCase()}`, type: 'zero' };
  }

  if (rangeType === 'day') {
    // Single-day headline logic
    const allDailyCounts: number[] = Object.values(dailyCounts);
    const prevMax: number = Math.max(...allDailyCounts.filter((_: number, i: number) => Object.keys(dailyCounts)[i] !== endDayStr), 0);
    if (count > prevMax && allDays.length > 7) return { text: `EXTRA! EXTRA! ${count} Sessions`, subtitle: 'An All-Time Record Day!', type: 'record' };

    const month: string = endDayStr.substring(0, 7);
    const monthCounts: number[] = Object.entries(dailyCounts).filter(([d]: [string, number]) => d.startsWith(month) && d !== endDayStr).map(([, c]: [string, number]) => c);
    const monthMax: number = Math.max(...monthCounts, 0);
    if (count > monthMax && monthCounts.length > 3) {
      const monthName: string = new Date(endDayStr).toLocaleDateString('en-US', { month: 'long' });
      return { text: `Busiest Day of ${monthName}`, subtitle: `${count} Sessions Shipped`, type: 'monthly-record' };
    }

    if (dailyAverage > 0 && count >= dailyAverage * 3) return { text: `Session Surge! ${count} Sessions`, subtitle: `${Math.round(count / dailyAverage)}x the Daily Average`, type: 'surge' };
    if (dailyAverage > 0 && count > dailyAverage) return { text: `${count} Sessions Logged`, subtitle: `${Math.round(((count - dailyAverage) / dailyAverage) * 100)}% Above the Daily Average`, type: 'above-average' };
    if (count === 1) return { text: 'A Singular Focus', subtitle: 'One Deep Session Today', type: 'singular' };
    return { text: `${count} Sessions Filed`, subtitle: 'Another Day at the Terminal', type: 'normal' };
  }

  // Multi-day headlines
  const expectedAvg: number = dailyAverage * rangeDays;
  const dailyRate: number = Math.round((count / rangeDays) * 10) / 10;

  if (expectedAvg > 0 && count >= expectedAvg * 2) {
    return { text: `${count} Sessions${suffix}!`, subtitle: `${Math.round(count / expectedAvg)}x the expected volume — what a run!`, type: 'surge' };
  }
  if (expectedAvg > 0 && count > expectedAvg * 1.3) {
    const pct: number = Math.round(((count - expectedAvg) / expectedAvg) * 100);
    return { text: `${count} Sessions${suffix}`, subtitle: `${pct}% above average — ${dailyRate}/day`, type: 'above-average' };
  }
  if (expectedAvg > 0 && count < expectedAvg * 0.5) {
    return { text: `${count} Sessions${suffix}`, subtitle: `A quieter stretch — ${dailyRate}/day`, type: 'below-average' };
  }
  return { text: `${count} Sessions${suffix}`, subtitle: `${dailyRate} sessions/day on average`, type: 'normal' };
}

function computeStreaks(allDays: string[], dayStr: string): { current: number; longest: number } {
  let current: number = 0;
  let longest: number = 0;
  let temp: number = 1;
  for (let i = 1; i < allDays.length; i++) {
    const diff: number = (new Date(allDays[i]).getTime() - new Date(allDays[i - 1]).getTime()) / 86400000;
    if (diff === 1) temp++;
    else { if (temp > longest) longest = temp; temp = 1; }
  }
  if (temp > longest) longest = temp;

  const today: Date = new Date(dayStr);
  if (allDays.length > 0) {
    const last: Date = new Date(allDays[allDays.length - 1]);
    if ((today.getTime() - last.getTime()) / 86400000 <= 1) {
      current = 1;
      for (let i = allDays.length - 2; i >= 0; i--) {
        if ((new Date(allDays[i + 1]).getTime() - new Date(allDays[i]).getTime()) / 86400000 === 1) current++;
        else break;
      }
    }
  }
  return { current, longest };
}

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmt(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 100) return '$' + Math.round(n);
  return '$' + n.toFixed(2);
}
