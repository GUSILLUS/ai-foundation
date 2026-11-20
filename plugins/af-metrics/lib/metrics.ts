import path from 'node:path';
import { getPath, readLines } from './transcripts.ts';

/**
 * Базова лінія метрик з транскриптів (ADR 0002, п. 3–5).
 *
 * Читаємо лише записи assistant, user, system і cost-state і лише поля з визначень ADR.
 * З вхідних даних інструментів — назву скіла, тип субагента й шлях змінюваного файлу;
 * шлях живе тільки в пам’яті як ключ для «повторно змінених файлів» і ніколи не виводиться.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const SAFE = /^[\w.:+@<>-]{1,80}$/;
/** promptSource, які означають введення людиною — для версій без origin.kind. */
const HUMAN_PROMPT_SOURCES = new Set(['typed', 'suggestion_accepted']);

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
}

export interface SessionStats {
  sessionId: string;
  project: string;
  entrypoint: string;
  start: string;
  end: string;
  versions: string[];
  humanPrompts: number;
  otherPrompts: Record<string, number>;
  responses: number;
  subagentResponses: number;
  tokensByModel: Record<string, TokenTotals>;
  costUSD: number | null;
  activeMs: number;
  toolCalls: Record<string, number>;
  skills: Record<string, number>;
  subagents: Record<string, number>;
  toolErrors: Record<string, number>;
  apiErrors: Record<string, number>;
  hookErrors: number;
  rejections: Record<string, number>;
  compactions: Record<string, number>;
  turns: number;
  editTurns: number;
  editRounds: number;
  filesEdited: number;
  filesReedited: number;
}

interface PendingTool {
  name: string;
  turn: number;
  fileKey?: string;
}

interface SessionState {
  stats: SessionStats;
  /** Чи взято мітку проєкту з cwd (інакше — назва теки транскрипту). */
  labelled: boolean;
  turn: number;
  tools: Map<string, PendingTool>;
  editTurnSet: Set<number>;
  fileTurns: Map<string, Set<number>>;
  costByProcess: Map<string, number>;
}

export interface CollectOptions {
  /** Сесії, що почалися раніше, ігноруються (ISO-дата). */
  since?: string;
}

/** Збирає статистику по сесіях з усіх файлів. Дедуплікація — глобальна (ADR 0002, п. 1). */
export async function collectSessions(files: string[], projectsDir: string, opts: CollectOptions = {}): Promise<SessionStats[]> {
  const seenUuid = new Set<string>();
  const seenMessage = new Set<string>();
  const seenTool = new Set<string>();
  const sessions = new Map<string, SessionState>();

  for (const file of files) {
    const projectDir = path.relative(projectsDir, file).split(/[\\/]/)[0] ?? '<unknown>';
    for await (const line of readLines(file)) {
      if (line.kind !== 'record') continue;
      const r = line.record;
      const type = r.type;
      if (type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'cost-state') continue;
      if (typeof r.sessionId !== 'string') continue;
      if (typeof r.uuid === 'string') {
        if (seenUuid.has(r.uuid)) continue; // копія історії після /branch, fork чи resume
        seenUuid.add(r.uuid);
      }
      const s = sessionFor(sessions, r, projectDir);
      if (typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp))) {
        const ts = new Date(r.timestamp).toISOString();
        if (!s.stats.start || ts < s.stats.start) s.stats.start = ts;
        if (!s.stats.end || ts > s.stats.end) s.stats.end = ts;
      }
      if (typeof r.version === 'string' && SAFE.test(r.version) && !s.stats.versions.includes(r.version)) s.stats.versions.push(r.version);
      if (typeof r.entrypoint === 'string' && SAFE.test(r.entrypoint) && s.stats.entrypoint === 'unknown') s.stats.entrypoint = r.entrypoint;
      if (!s.labelled && typeof r.cwd === 'string' && r.cwd !== '') {
        s.stats.project = projectLabel(r.cwd);
        s.labelled = true;
      }

      if (type === 'user') onUser(s, r);
      else if (type === 'assistant') onAssistant(s, r, seenMessage, seenTool);
      else if (type === 'system') onSystem(s, r);
      else onCost(s, r);
    }
  }

  const out: SessionStats[] = [];
  for (const s of sessions.values()) {
    finalize(s);
    if (opts.since && s.stats.start && s.stats.start < opts.since) continue;
    out.push(s.stats);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function sessionFor(map: Map<string, SessionState>, r: Record<string, unknown>, projectDir: string): SessionState {
  const id = r.sessionId as string;
  let s = map.get(id);
  if (!s) {
    s = {
      stats: {
        sessionId: id,
        project: '<unknown>',
        entrypoint: 'unknown',
        start: '',
        end: '',
        versions: [],
        humanPrompts: 0,
        otherPrompts: {},
        responses: 0,
        subagentResponses: 0,
        tokensByModel: {},
        costUSD: null,
        activeMs: 0,
        toolCalls: {},
        skills: {},
        subagents: {},
        toolErrors: {},
        apiErrors: {},
        hookErrors: 0,
        rejections: {},
        compactions: {},
        turns: 0,
        editTurns: 0,
        editRounds: 0,
        filesEdited: 0,
        filesReedited: 0,
      },
      labelled: false,
      turn: 0,
      tools: new Map(),
      editTurnSet: new Set(),
      fileTurns: new Map(),
      costByProcess: new Map(),
    };
    s.stats.project = projectDir; // запасна мітка; уточнюється з cwd
    map.set(id, s);
  }
  return s;
}

/** Мітка проєкту — остання частина робочої теки. Назви лишаються локально (ADR 0002, п. 5). */
export function projectLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function contentBlocks(r: Record<string, unknown>): Record<string, unknown>[] {
  const c = getPath(r, 'message.content');
  return Array.isArray(c) ? c.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null) : [];
}

function onUser(s: SessionState, r: Record<string, unknown>): void {
  const blocks = contentBlocks(r);
  const results = blocks.filter((b) => b.type === 'tool_result');

  if (results.length > 0) {
    const decision = getPath(r, 'permissionDecision.decision');
    if (decision === 'reject') {
      const parts = ['permissionDecision.source', 'permissionDecision.reasonCode', 'permissionDecision.classifierCategory']
        .map((p) => getPath(r, p))
        .map((v) => (typeof v === 'string' && SAFE.test(v) ? v : null))
        .filter(Boolean);
      bump(s.stats.rejections, parts.join(' / ') || 'unknown');
    }
    for (const res of results) {
      const id = typeof res.tool_use_id === 'string' ? res.tool_use_id : '';
      const tool = s.tools.get(id);
      if (res.is_error === true) {
        bump(s.stats.toolErrors, tool?.name ?? 'unknown');
      } else if (tool && EDIT_TOOLS.has(tool.name) && decision !== 'reject' && r.isSidechain !== true) {
        s.editTurnSet.add(tool.turn);
        if (tool.fileKey) {
          let turns = s.fileTurns.get(tool.fileKey);
          if (!turns) s.fileTurns.set(tool.fileKey, (turns = new Set()));
          turns.add(tool.turn);
        }
      }
      s.tools.delete(id);
    }
    return;
  }

  if (r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true) return;
  const kind = getPath(r, 'origin.kind');
  const source = r.promptSource;
  const human = typeof kind === 'string' ? kind === 'human' : typeof source === 'string' ? HUMAN_PROMPT_SOURCES.has(source) : true;
  if (human) {
    s.stats.humanPrompts++;
    s.turn++;
  } else {
    bump(s.stats.otherPrompts, typeof kind === 'string' && SAFE.test(kind) ? kind : typeof source === 'string' && SAFE.test(source) ? source : 'other');
  }
}

function onAssistant(s: SessionState, r: Record<string, unknown>, seenMessage: Set<string>, seenTool: Set<string>): void {
  const model = getPath(r, 'message.model');
  const id = getPath(r, 'message.id');
  if (r.isApiErrorMessage === true || model === '<synthetic>') {
    const err = typeof r.error === 'string' && SAFE.test(r.error) ? r.error : 'unknown';
    if (typeof id !== 'string' || !seenMessage.has(id)) bump(s.stats.apiErrors, err);
    if (typeof id === 'string') seenMessage.add(id);
    return;
  }
  if (typeof id === 'string' && !seenMessage.has(id)) {
    seenMessage.add(id);
    if (r.isSidechain === true) s.stats.subagentResponses++;
    else s.stats.responses++;
    const m = typeof model === 'string' && SAFE.test(model) ? model : 'unknown';
    const t = (s.stats.tokensByModel[m] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 });
    t.input += num(getPath(r, 'message.usage.input_tokens'));
    t.output += num(getPath(r, 'message.usage.output_tokens'));
    t.cacheRead += num(getPath(r, 'message.usage.cache_read_input_tokens'));
    t.cacheCreation += num(getPath(r, 'message.usage.cache_creation_input_tokens'));
    t.thinking += num(getPath(r, 'message.usage.output_tokens_details.thinking_tokens'));
  }
  for (const b of contentBlocks(r)) {
    if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
    if (seenTool.has(b.id)) continue;
    seenTool.add(b.id);
    const name = b.name;
    bump(s.stats.toolCalls, toolLabel(name));
    const input = typeof b.input === 'object' && b.input !== null ? (b.input as Record<string, unknown>) : {};
    if (name === 'Skill' && typeof input.skill === 'string' && SAFE.test(input.skill)) bump(s.stats.skills, input.skill);
    if (AGENT_TOOLS.has(name)) bump(s.stats.subagents, typeof input.subagent_type === 'string' && SAFE.test(input.subagent_type) ? input.subagent_type : 'general-purpose');
    const pending: PendingTool = { name, turn: s.turn };
    if (EDIT_TOOLS.has(name)) {
      const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
      if (p) pending.fileKey = p; // лише ключ у пам’яті
    }
    s.tools.set(b.id, pending);
  }
}

/** MCP-інструменти групуємо за сервером: mcp__jira__get → mcp__jira. */
export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1];
    return server && SAFE.test(server) ? `mcp__${server}` : 'mcp__other';
  }
  return SAFE.test(name) ? name : 'other';
}

function onSystem(s: SessionState, r: Record<string, unknown>): void {
  if (r.subtype === 'turn_duration') s.stats.activeMs += num(r.durationMs);
  else if (r.subtype === 'compact_boundary') {
    const trigger = getPath(r, 'compactMetadata.trigger');
    bump(s.stats.compactions, typeof trigger === 'string' && SAFE.test(trigger) ? trigger : 'unknown');
  } else if (r.subtype === 'stop_hook_summary' && Array.isArray(r.hookErrors)) s.stats.hookErrors += r.hookErrors.length;
}

/** cost-state — накопичувальні знімки одного процесу; беремо максимум на процес і сумуємо процеси. */
function onCost(s: SessionState, r: Record<string, unknown>): void {
  if (typeof r.totalCostUSD !== 'number') return;
  const key = String(r.startTime ?? '');
  s.costByProcess.set(key, Math.max(s.costByProcess.get(key) ?? 0, r.totalCostUSD));
}

function finalize(s: SessionState): void {
  const st = s.stats;
  st.turns = s.turn;
  const edits = [...s.editTurnSet].filter((t) => t > 0).sort((a, b) => a - b);
  st.editTurns = edits.length;
  st.editRounds = edits.filter((t) => s.editTurnSet.has(t - 1) && t - 1 > 0).length;
  st.filesEdited = s.fileTurns.size;
  st.filesReedited = [...s.fileTurns.values()].filter((turns) => turns.size >= 2).length;
  if (s.costByProcess.size > 0) st.costUSD = round([...s.costByProcess.values()].reduce((a, b) => a + b, 0));
  s.fileTurns.clear(); // шляхи не виходять за межі збору
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}
