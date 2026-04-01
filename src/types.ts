export type RangeType = 'day' | 'week' | 'month';
export type EditorSource = 'claude-code' | 'cursor' | 'opencode' | 'antigravity';
export type HeadlineType = 'zero' | 'record' | 'monthly-record' | 'surge' | 'above-average' | 'below-average' | 'singular' | 'normal';

export interface CliOpts {
  dateFrom: number;
  dateTo: number;
  rangeType: RangeType;
  label: string;
  filename: string;
}

export interface Chat {
  source: EditorSource;
  composerId: string;
  name: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  mode: string;
  folder: string | null;
  bubbleCount: number;
  [key: string]: unknown; // adapter-specific fields
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  _model?: string;
  _inputTokens?: number;
  _outputTokens?: number;
  _cacheRead?: number;
  _cacheWrite?: number;
  _toolCalls?: ToolCall[];
}

export interface EditorAdapter {
  name: string;
  label: string;
  color: string;
  getChats(): Chat[];
  getMessages(chat: Chat): Message[];
}

export interface EditorMeta {
  label: string;
  color: string;
}

export interface Headline {
  text: string;
  subtitle: string;
  type: HeadlineType;
}

export interface DailyBreakdownEntry {
  day: string;
  date: string;
  dateLabel: string;
  count: number;
}

export interface SessionAnalysis {
  name: string | null;
  editor: string;
  editorLabel: string;
  project: string | null;
  bubbleCount: number;
  model: string | null;
  cost: number;
  createdAt: number | null;
  lastUpdatedAt: number | null;
}

export interface EditorStats {
  id: string;
  label: string;
  color: string;
  count: number;
  pct: number;
}

export interface ProjectStats {
  name: string;
  fullPath: string;
  count: number;
  topEditor: string | null;
}

export interface ModelStats {
  name: string;
  count: number;
  pct: number;
}

export interface ToolStats {
  name: string;
  count: number;
}

export interface ProjectSpotlight {
  project: string;
  narrative: string;
}

export interface NarrativesOutput {
  leadStory: string;
  projectSpotlights: ProjectSpotlight[];
  forecast: string;
  toolShed: string;
  sportsPage: string;
}

export interface ReportData {
  date: string;
  dateFrom: number;
  dateTo: number;
  rangeType: RangeType;
  rangeLabel: string;
  dateFormatted: string;
  editionNumber: number;
  headline: Headline;
  dailyBreakdown: DailyBreakdownEntry[];
  frontPage: {
    sessions: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cost: number;
    activeHours: number;
    comparisons: { vsAverage: number; vsPrevious: number };
  };
  taskStories: SessionAnalysis[];
  editorRoundup: EditorStats[];
  projectBeat: ProjectStats[];
  modelWatch: ModelStats[];
  toolTimes: ToolStats[];
  markets: {
    totalCost: number;
    byEditor: { id: string; label: string; cost: number }[];
    costPerSession: number;
  };
  weatherReport: {
    hourly: number[];
    peakHour: number;
    peakLabel: string;
  };
  sports: {
    currentStreak: number;
    longestStreak: number;
    todayPercentile: number;
    longestSession: SessionAnalysis | null;
    priciestSession: SessionAnalysis | null;
  };
  context: {
    dailyAverage: number;
    totalDays: number;
    allTimeTotal: number;
  };
  narratives: NarrativesOutput;
  agentIdentity: AgentIdentity | null;
}

export interface AgentIdentity {
  name: string;
  nature: string | null;
  voice: string | null;
  emoji: string | null;
}

export interface ModelPricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
