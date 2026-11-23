import { collectSessions } from './metrics.ts';
import { getPath, readLines } from './transcripts.ts';

/**
 * Використання за вікно: виклики скілів, субагентів, MCP, слеш-команд і відмови наших хуків,
 * плюс контекст, який транскрипт фіксує на старті (список скілів, контекст хуків, інструкції MCP).
 * Лише лічильники й довжини — тексти не зберігаються.
 */

const SAFE = /^[\w.:+@<>-]{1,100}$/;
const COMMAND_TAG = /<command-name>\/?([\w.:+@-]{1,100})<\/command-name>/g;
const HOOK_MARKER = /^(af-[a-z0-9-]{1,40})\/[a-z0-9-]{1,40}$/;

export interface Usage {
  sessions: number;
  firstSession: string | null;
  lastSession: string | null;
  skills: Record<string, number>;
  agents: Record<string, number>;
  /** Виклики MCP за міткою `mcp__<сервер>`. */
  mcpCalls: Record<string, number>;
  mcpErrors: Record<string, number>;
  commands: Record<string, number>;
  /** Відмови наших хуків за плагіном (`af-controls`). */
  hookRejections: Record<string, number>;
  /** Середня довжина списку скілів на сесію (символи), якщо транскрипт його фіксує. */
  skillListingChars: { sessions: number; avg: number } | null;
  /** Контекст хуків: подія · ім'я хука → сесій і середня довжина. */
  hookContext: Record<string, { sessions: number; avgChars: number }>;
  /** Інструкції MCP-серверів: сервер → середня довжина. */
  mcpInstructions: Record<string, { sessions: number; avgChars: number }>;
}

export async function collectUsage(files: string[], projectsDir: string, since?: string): Promise<Usage> {
  const sessions = await collectSessions(files, projectsDir, { since });
  const u: Usage = {
    sessions: sessions.length,
    firstSession: sessions[0]?.start || null,
    lastSession: sessions[sessions.length - 1]?.start || null,
    skills: {},
    agents: {},
    mcpCalls: {},
    mcpErrors: {},
    commands: {},
    hookRejections: {},
    skillListingChars: null,
    hookContext: {},
    mcpInstructions: {},
  };
  const inWindow = new Set(sessions.map((s) => s.sessionId));
  for (const s of sessions) {
    merge(u.skills, s.skills);
    merge(u.agents, s.subagents);
    for (const [tool, n] of Object.entries(s.toolCalls)) if (tool.startsWith('mcp__')) bump(u.mcpCalls, tool, n);
    for (const [tool, n] of Object.entries(s.toolErrors)) if (tool.startsWith('mcp__')) bump(u.mcpErrors, mcpLabel(tool), n);
    for (const [reason, n] of Object.entries(s.rejections)) {
      const last = reason.split(' / ').pop() ?? '';
      const m = HOOK_MARKER.exec(last);
      if (m) bump(u.hookRejections, m[1] as string, n);
    }
  }

  // Другий прохід: слеш-команди й контекст старту. Лише сесії з вікна.
  const seen = new Set<string>();
  const listing = new Map<string, number>();
  const hooks = new Map<string, Map<string, number>>();
  const mcp = new Map<string, Map<string, number>>();
  for (const file of files) {
    for await (const line of readLines(file)) {
      if (line.kind !== 'record') continue;
      const r = line.record;
      if (typeof r.sessionId !== 'string' || !inWindow.has(r.sessionId)) continue;
      if (typeof r.uuid === 'string') {
        if (seen.has(r.uuid)) continue;
        seen.add(r.uuid);
      }
      if (r.type === 'user' && r.isSidechain !== true) {
        for (const text of textsOf(getPath(r, 'message.content'))) {
          for (const m of text.matchAll(COMMAND_TAG)) bump(u.commands, m[1] as string);
        }
      }
      if (r.type !== 'attachment') continue;
      const a = r.attachment;
      if (typeof a !== 'object' || a === null) continue;
      const att = a as Record<string, unknown>;
      if (att.type === 'skill_listing') {
        const len = textLength(att.content);
        if (len > 0) listing.set(r.sessionId, Math.max(listing.get(r.sessionId) ?? 0, len));
      } else if (att.type === 'hook_additional_context') {
        const event = typeof att.hookEvent === 'string' && SAFE.test(att.hookEvent) ? att.hookEvent : 'unknown';
        const name = typeof att.hookName === 'string' && SAFE.test(att.hookName) ? att.hookName : 'unknown';
        const key = name.startsWith(event) ? name : `${event} · ${name}`;
        addPerSession(hooks, key, r.sessionId, textLength(att.content));
      } else if (att.type === 'mcp_instructions_delta') {
        const names = Array.isArray(att.addedNames) ? att.addedNames : [];
        const blocks = Array.isArray(att.addedBlocks) ? att.addedBlocks : [];
        names.forEach((n, i) => {
          if (typeof n === 'string' && SAFE.test(n)) addPerSession(mcp, n, r.sessionId as string, textLength(blocks[i]));
        });
      }
    }
  }
  if (listing.size) u.skillListingChars = { sessions: listing.size, avg: Math.round(sum(listing.values()) / listing.size) };
  for (const [k, per] of hooks) u.hookContext[k] = { sessions: per.size, avgChars: Math.round(sum(per.values()) / per.size) };
  for (const [k, per] of mcp) u.mcpInstructions[k] = { sessions: per.size, avgChars: Math.round(sum(per.values()) / per.size) };
  return u;
}

/** mcp__server__tool → mcp__server. */
export function mcpLabel(name: string): string {
  const server = name.split('__')[1];
  return server && SAFE.test(server) ? `mcp__${server}` : 'mcp__other';
}

function addPerSession(map: Map<string, Map<string, number>>, key: string, session: string, len: number): void {
  let per = map.get(key);
  if (!per) map.set(key, (per = new Map()));
  per.set(session, (per.get(session) ?? 0) + len);
}

function textsOf(c: unknown): string[] {
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  return c.map((b) => (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).text === 'string' ? ((b as Record<string, unknown>).text as string) : '')).filter(Boolean);
}

/** Довжина тексту: рядок, масив рядків чи блоків `{text}` або `{content}`. */
export function textLength(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + textLength(x), 0);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.length;
    if (o.content !== undefined) return textLength(o.content);
  }
  return 0;
}

function merge(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) bump(into, k, n);
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function sum(v: Iterable<number>): number {
  let n = 0;
  for (const x of v) n += x;
  return n;
}
