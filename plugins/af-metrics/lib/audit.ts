import type { Installed, Source } from './audit-inventory.ts';
import type { Usage } from './audit-usage.ts';

/**
 * Вердикт «лишити / переглянути / прибрати» для кожного плагіна, окремого MCP-сервера
 * й особистого скіла, агента чи команди. Пороги — тут і в тестах; видаляє лише людина.
 */

export const THRESHOLDS = {
  /** Коротше вікно — замало даних, щоб радити «прибрати». */
  minWindowDays: 14,
  /** «Рідко»: не більше стількох використань за вікно. */
  rareUses: 2,
  /** «Дорого на старті»: від стількох символів у списку скілів, агентів, команд і інструкцій MCP. */
  expensiveChars: 2000,
  /** Помилки MCP: від стількох і від такої частки викликів. */
  minErrors: 5,
  errorRate: 0.2,
};

export type Verdict = 'лишити' | 'переглянути' | 'прибрати';

export interface Unit {
  kind: 'plugin' | 'mcp' | 'skill' | 'agent' | 'command';
  id: string;
  name: string;
  version: string | null;
  enabled: boolean | null;
  own: boolean;
  /** Склад: скілів, агентів, команд, MCP-серверів, хуків. */
  parts: { skills: number; agents: number; commands: number; mcpServers: number; hooks: number };
  uses: number;
  /** Використання за компонентами: `skill:x` → n. Невикористані не вказуються. */
  usedParts: Record<string, number>;
  unusedParts: string[];
  mcpCalls: number;
  mcpErrors: number;
  hookRejections: number;
  /** Оцінка символів на старті: список скілів, агентів, команд + інструкції MCP з транскриптів. */
  startupChars: number;
  hookEvents: string[];
  conflicts: string[];
  verdict: Verdict;
  reason: string;
  removeCommand: string | null;
}

export interface AuditReport {
  generatedAt: string;
  analyzer: string;
  window: { since: string | null; days: number; sessions: number; firstSession: string | null; lastSession: string | null };
  thresholds: typeof THRESHOLDS;
  found: Record<string, boolean>;
  problems: string[];
  units: Unit[];
  observed: {
    skillListingChars: Usage['skillListingChars'];
    hookContext: Usage['hookContext'];
    mcpInstructions: Usage['mcpInstructions'];
  };
  summary: Record<Verdict, number>;
}

export interface AuditOptions {
  since: string | null;
  now: Date;
  analyzer: string;
}

const DAY = 86_400_000;
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const OUR_GUARDED_TOOLS = ['Read', 'Edit', 'Write'];

export function buildAudit(inst: Installed, usage: Usage, opts: AuditOptions): AuditReport {
  const from = opts.since ?? usage.firstSession;
  const days = from ? Math.max(0, Math.floor((opts.now.getTime() - Date.parse(from)) / DAY)) : 0;

  const units: Unit[] = [];
  for (const src of inst.sources) {
    if (src.kind === 'personal') {
      for (const s of src.skills) units.push(personalUnit('skill', s.name, s.listingChars, s.mentionsSubagents, usage));
      for (const a of src.agents) units.push(personalUnit('agent', a.name, a.listingChars, a.mentionsSubagents, usage));
      for (const c of src.commands) units.push(personalUnit('command', c.name, c.listingChars, c.mentionsSubagents, usage));
    } else units.push(sourceUnit(src, usage));
  }

  // Однакові короткі назви скілів у різних джерелах — модель може взяти не той.
  const owners = new Map<string, string[]>();
  for (const src of inst.sources) {
    const label = src.kind === 'personal' ? 'особисті' : src.name;
    for (const s of src.skills) owners.set(s.name, [...(owners.get(s.name) ?? []), label]);
  }
  for (const u of units) {
    const names = u.kind === 'skill' ? [u.name] : u.kind === 'plugin' ? skillNamesOf(inst, u.id) : [];
    for (const n of names) {
      const o = owners.get(n) ?? [];
      if (o.length > 1) u.conflicts.push(`скіл «${n}» є також у: ${o.filter((x) => x !== (u.kind === 'skill' ? 'особисті' : u.name)).join(', ')}`);
    }
  }

  for (const u of units) decide(u, days);
  const order: Record<Verdict, number> = { прибрати: 0, переглянути: 1, лишити: 2 };
  units.sort((a, b) => order[a.verdict] - order[b.verdict] || b.startupChars - a.startupChars || a.id.localeCompare(b.id));

  const summary: Record<Verdict, number> = { лишити: 0, переглянути: 0, прибрати: 0 };
  for (const u of units) summary[u.verdict]++;
  return {
    generatedAt: opts.now.toISOString(),
    analyzer: opts.analyzer,
    window: { since: opts.since, days, sessions: usage.sessions, firstSession: usage.firstSession, lastSession: usage.lastSession },
    thresholds: THRESHOLDS,
    found: inst.found,
    problems: inst.problems,
    units,
    observed: { skillListingChars: usage.skillListingChars, hookContext: usage.hookContext, mcpInstructions: usage.mcpInstructions },
    summary,
  };
}

function skillNamesOf(inst: Installed, id: string): string[] {
  return inst.sources.find((s) => s.id === id)?.skills.map((s) => s.name) ?? [];
}

function emptyUnit(kind: Unit['kind'], id: string, name: string): Unit {
  return {
    kind, id, name, version: null, enabled: null, own: false,
    parts: { skills: 0, agents: 0, commands: 0, mcpServers: 0, hooks: 0 },
    uses: 0, usedParts: {}, unusedParts: [], mcpCalls: 0, mcpErrors: 0, hookRejections: 0,
    startupChars: 0, hookEvents: [], conflicts: [], verdict: 'лишити', reason: '', removeCommand: null,
  };
}

function sourceUnit(src: Source, usage: Usage): Unit {
  const u = emptyUnit(src.kind === 'mcp' ? 'mcp' : 'plugin', src.id, src.name);
  u.version = src.version;
  u.enabled = src.enabled;
  u.own = src.kind === 'plugin' && src.name.startsWith('af-') && src.id.endsWith('@ai-foundation');
  u.parts = { skills: src.skills.length, agents: src.agents.length, commands: src.commands.length, mcpServers: src.mcpServers.length, hooks: src.hooks.length };
  const p = src.name;
  const isPlugin = src.kind === 'plugin';

  const count = (label: string, n: number) => {
    if (n > 0) u.usedParts[label] = (u.usedParts[label] ?? 0) + n;
    else if (!u.unusedParts.includes(label)) u.unusedParts.push(label);
    u.uses += n;
  };
  for (const s of src.skills) {
    const n = (usage.skills[`${p}:${s.name}`] ?? 0) + (usage.skills[s.name] ?? 0) + (usage.commands[`${p}:${s.name}`] ?? 0) + (usage.commands[s.name] ?? 0);
    count(`skill:${s.name}`, n);
    u.startupChars += s.listingChars;
  }
  for (const a of src.agents) {
    count(`agent:${a.name}`, (usage.agents[`${p}:${a.name}`] ?? 0) + (usage.agents[a.name] ?? 0));
    u.startupChars += a.listingChars;
  }
  for (const c of src.commands) {
    if (src.skills.some((s) => s.name === c.name)) continue;
    count(`command:${c.name}`, (usage.commands[`${p}:${c.name}`] ?? 0) + (usage.commands[c.name] ?? 0));
    u.startupChars += c.listingChars;
  }
  for (const server of src.mcpServers) {
    const labels = isPlugin ? [`mcp__plugin_${p}_${server}`, `mcp__plugin_${p}_${server.replace(/-/g, '_')}`] : [`mcp__${server}`, `mcp__${server.replace(/-/g, '_')}`];
    let calls = 0;
    let errors = 0;
    for (const l of new Set(labels)) {
      calls += usage.mcpCalls[l] ?? 0;
      errors += usage.mcpErrors[l] ?? 0;
    }
    count(`mcp:${server}`, calls);
    u.mcpCalls += calls;
    u.mcpErrors += errors;
    for (const [key, v] of Object.entries(usage.mcpInstructions)) {
      if (key === server || (isPlugin && key.includes(p) && key.includes(server))) u.startupChars += v.avgChars;
    }
  }
  u.hookRejections = usage.hookRejections[p] ?? 0;
  u.hookEvents = [...new Set(src.hooks.map((h) => h.event))].sort();

  if (!u.own) {
    for (const ev of u.hookEvents) if (CONTEXT_EVENTS.has(ev)) u.conflicts.push(`хук ${ev} може додавати контекст поруч з af-core (бюджет старту)`);
    const guard = src.hooks.filter((h) => h.event === 'PreToolUse' && (h.matcher === '*' || OUR_GUARDED_TOOLS.some((t) => new RegExp(`(^|[|(])${t}([|)]|$)`).test(h.matcher))));
    if (guard.length) u.conflicts.push('PreToolUse на Read/Edit/Write — перетин з env-guard');
    const sub = [...src.skills, ...src.agents, ...src.commands].filter((c) => c.mentionsSubagents).length;
    if (sub) u.conflicts.push(`${sub} інструкц. згадують субагентів — у нас субагентів не використовуємо (евристика)`);
  }
  if (src.problems.length) u.conflicts.push(...src.problems.map((x) => `не прочитано: ${x}`));

  if (src.kind === 'plugin') u.removeCommand = `claude plugin uninstall ${src.id}`;
  else u.removeCommand = (src.scope ?? 'user').split(',').map((s) => `claude mcp remove ${src.name} -s ${s}${s === 'local' ? ' (у теці проєкту)' : ''}`).join('; ');
  return u;
}

function personalUnit(kind: 'skill' | 'agent' | 'command', name: string, chars: number, subagents: boolean | undefined, usage: Usage): Unit {
  const u = emptyUnit(kind, `personal:${kind}:${name}`, name);
  u.enabled = true;
  u.parts = { skills: kind === 'skill' ? 1 : 0, agents: kind === 'agent' ? 1 : 0, commands: kind === 'command' ? 1 : 0, mcpServers: 0, hooks: 0 };
  u.uses = kind === 'skill' ? (usage.skills[name] ?? 0) + (usage.commands[name] ?? 0) : kind === 'agent' ? (usage.agents[name] ?? 0) : (usage.commands[name] ?? 0);
  if (u.uses) u.usedParts[`${kind}:${name}`] = u.uses;
  else u.unusedParts.push(`${kind}:${name}`);
  u.startupChars = chars;
  if (subagents) u.conflicts.push('інструкція згадує субагентів — у нас субагентів не використовуємо (евристика)');
  const where = kind === 'skill' ? `~/.claude/skills/${name}/` : kind === 'agent' ? `~/.claude/agents/${name}.md` : `~/.claude/commands/${name.replace(/:/g, '/')}.md`;
  u.removeCommand = `перенести ${where} у ~/.claude/_removed/`;
  return u;
}

/** Правила вердикту — по черзі, перше спрацьоване вирішує. */
export function decide(u: Unit, days: number): void {
  const t = THRESHOLDS;
  const invocable = u.parts.skills + u.parts.agents + u.parts.commands + u.parts.mcpServers > 0;
  const cost = u.startupChars ? `, на старті ~${u.startupChars} сим.` : '';
  const set = (v: Verdict, r: string) => {
    u.verdict = v;
    u.reason = r;
  };
  if (u.enabled === false) return set('переглянути', 'вимкнено, але встановлено');
  if (invocable && u.uses === 0) {
    if (days >= t.minWindowDays) return set(u.own ? 'переглянути' : 'прибрати', `0 використань за ${days} дн.${cost}${u.own ? ' (наш плагін — вирішити в репозиторії)' : ''}`);
    return set('переглянути', `0 використань, але вікно ${days} дн. < ${t.minWindowDays}${cost}`);
  }
  if (!invocable && u.parts.hooks === 0) {
    return set('переглянути', `компонентів не знайдено${u.conflicts.length ? `; ${u.conflicts.join('; ')}` : ''}`);
  }
  if (!invocable) {
    const note = u.hookRejections ? `, відмов хуків: ${u.hookRejections}` : '';
    if (u.conflicts.length && !u.own) return set('переглянути', `лише хуки (використання не видно в транскриптах)${note}; ${u.conflicts.join('; ')}`);
    return set('лишити', `лише хуки (використання не видно в транскриптах)${note}`);
  }
  if (u.mcpErrors >= t.minErrors && u.mcpCalls > 0 && u.mcpErrors / u.mcpCalls >= t.errorRate) {
    return set('переглянути', `помилки MCP: ${u.mcpErrors} з ${u.mcpCalls} викликів (${Math.round((u.mcpErrors / u.mcpCalls) * 100)}%)`);
  }
  if (u.uses <= t.rareUses && u.startupChars >= t.expensiveChars) return set('переглянути', `рідко: ${u.uses} за ${days} дн.${cost}`);
  if (u.conflicts.length) return set('переглянути', `${u.uses} використань; ${u.conflicts.join('; ')}`);
  return set('лишити', `${u.uses} використань за ${days} дн.${cost}`);
}

export function formatAudit(r: AuditReport): string {
  const L: string[] = [];
  const w = r.window;
  L.push(`# Аудит плагінів, скілів і MCP — ${r.generatedAt.slice(0, 10)}`, '');
  L.push(`Вікно: ${w.since ? `з ${w.since.slice(0, 10)}` : 'усі наявні транскрипти'} (${w.days} дн.), сесій: ${w.sessions}${w.firstSession ? `, перша ${w.firstSession.slice(0, 10)}, остання ${w.lastSession?.slice(0, 10)}` : ''}. ${r.analyzer}.`, '');
  L.push(`Підсумок: прибрати — ${r.summary['прибрати']}, переглянути — ${r.summary['переглянути']}, лишити — ${r.summary['лишити']}.`, '');
  if (w.days < r.thresholds.minWindowDays) L.push(`> Вікно коротше ${r.thresholds.minWindowDays} днів — «прибрати» не радиться.`, '');
  L.push('| Вердикт | Тип | Назва | Версія | Використань | На старті, сим. | Причина |', '| --- | --- | --- | --- | ---: | ---: | --- |');
  for (const u of r.units) {
    L.push(`| ${u.verdict} | ${u.kind}${u.own ? ' (наш)' : ''} | ${esc(u.id)} | ${u.version ?? '—'} | ${u.uses} | ${u.startupChars || '—'} | ${esc(u.reason)} |`);
  }
  L.push('', '## Деталі', '');
  for (const u of r.units) {
    if (u.kind !== 'plugin' && u.kind !== 'mcp') continue;
    const parts = Object.entries(u.parts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'порожній';
    const used = Object.entries(u.usedParts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    L.push(`- **${esc(u.id)}** — ${parts}${u.hookEvents.length ? `; хуки: ${u.hookEvents.join(', ')}` : ''}${u.mcpCalls ? `; MCP: ${u.mcpCalls} викликів, ${u.mcpErrors} помилок` : ''}`);
    if (used) L.push(`  - використано: ${used}`);
    if (u.unusedParts.length && used) L.push(`  - не використано: ${u.unusedParts.join(', ')}`);
    for (const c of u.conflicts) L.push(`  - ⚠ ${c}`);
  }
  L.push('', '## Що транскрипти фіксують на старті', '');
  const o = r.observed;
  L.push(o.skillListingChars ? `- Список скілів: у середньому ${o.skillListingChars.avg} сим. (${o.skillListingChars.sessions} сесій)` : '- Список скілів: у транскриптах не знайдено');
  const hooks = Object.entries(o.hookContext).sort((a, b) => b[1].avgChars - a[1].avgChars);
  if (hooks.length) for (const [k, v] of hooks) L.push(`- Контекст хука ${esc(k)}: ~${v.avgChars} сим. (${v.sessions} сесій)`);
  else L.push('- Контекст хуків: у транскриптах не знайдено');
  const mcp = Object.entries(o.mcpInstructions).sort((a, b) => b[1].avgChars - a[1].avgChars);
  for (const [k, v] of mcp) L.push(`- Інструкції MCP ${esc(k)}: ~${v.avgChars} сим. (${v.sessions} сесій)`);
  L.push('', 'Оцінка «на старті» — за описами в списку скілів, агентів і команд та інструкціями MCP. Схеми інструментів MCP і контекст хуків тут не розподілені за плагінами — точні числа дає `/context` у живій сесії.');
  const remove = r.units.filter((u) => u.verdict === 'прибрати' && u.removeCommand);
  if (remove.length) {
    L.push('', '## Команди для видалення (виконувати лише після підтвердження)', '');
    for (const u of remove) L.push(`- ${esc(u.id)}: \`${u.removeCommand}\``);
  }
  const missing = Object.entries(r.found).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length || r.problems.length) {
    L.push('', '## Діагностика', '');
    if (missing.length) L.push(`- Не знайдено: ${missing.join(', ')}`);
    for (const p of r.problems) L.push(`- ${p}`);
  }
  L.push('', `Пороги: вікно ≥ ${r.thresholds.minWindowDays} дн. для «прибрати»; «рідко» ≤ ${r.thresholds.rareUses}; «дорого» ≥ ${r.thresholds.expensiveChars} сим.; помилки MCP ≥ ${r.thresholds.minErrors} і ≥ ${r.thresholds.errorRate * 100}%.`);
  return L.join('\n') + '\n';
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}
