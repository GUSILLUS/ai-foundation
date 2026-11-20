import type { SessionStats, TokenTotals } from './metrics.ts';

/** Агрегований звіт базової лінії (ADR 0002, п. 5). Лише лічильники й назви — без вмісту. */

export interface Totals {
  sessions: number;
  humanPrompts: number;
  otherPrompts: Record<string, number>;
  responses: number;
  subagentResponses: number;
  tokens: TokenTotals;
  costUSD: number;
  sessionsWithoutCost: number;
  activeHours: number;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  hookErrors: number;
  rejections: number;
  compactions: number;
  turns: number;
  editTurns: number;
  editRounds: number;
  /** Частка ходів із правками, за якими одразу йде ще один хід із правками. */
  editRoundRate: number | null;
  filesEdited: number;
  filesReedited: number;
}

export interface Report {
  generatedAt: string;
  analyzer: string;
  period: { first: string | null; last: string | null };
  anonymized: boolean;
  totals: Totals;
  tokensByModel: Record<string, TokenTotals>;
  tools: Record<string, number>;
  toolErrors: Record<string, number>;
  skills: Record<string, number>;
  subagents: Record<string, number>;
  apiErrors: Record<string, number>;
  rejections: Record<string, number>;
  compactions: Record<string, number>;
  versions: Record<string, number>;
  byWeek: Record<string, Totals>;
  byProject: Record<string, Totals>;
  byEntrypoint: Record<string, Totals>;
}

export function buildReport(sessions: SessionStats[], opts: { anonymize?: boolean; analyzer: string }): Report {
  const labels = new Map<string, string>();
  const project = (name: string) => {
    if (!opts.anonymize) return name;
    if (!labels.has(name)) labels.set(name, `project-${labels.size + 1}`);
    return labels.get(name)!;
  };
  const group = (key: (s: SessionStats) => string) => {
    const groups: Record<string, SessionStats[]> = {};
    for (const s of sessions) (groups[key(s)] ??= []).push(s);
    return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, totals(v)]));
  };
  const merge = (pick: (s: SessionStats) => Record<string, number>) => sortDesc(sumMaps(sessions.map(pick)));

  const tokensByModel: Record<string, TokenTotals> = {};
  for (const s of sessions) for (const [m, t] of Object.entries(s.tokensByModel)) addTokens((tokensByModel[m] ??= zeroTokens()), t);
  const versions: Record<string, number> = {};
  for (const s of sessions) for (const v of s.versions) versions[v] = (versions[v] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    analyzer: opts.analyzer,
    period: { first: sessions[0]?.start || null, last: sessions.reduce<string | null>((m, s) => (!m || s.end > m ? s.end : m), null) },
    anonymized: Boolean(opts.anonymize),
    totals: totals(sessions),
    tokensByModel,
    tools: merge((s) => s.toolCalls),
    toolErrors: merge((s) => s.toolErrors),
    skills: merge((s) => s.skills),
    subagents: merge((s) => s.subagents),
    apiErrors: merge((s) => s.apiErrors),
    rejections: merge((s) => s.rejections),
    compactions: merge((s) => s.compactions),
    versions,
    byWeek: group((s) => isoWeek(s.start)),
    byProject: group((s) => project(s.project)),
    byEntrypoint: group((s) => s.entrypoint),
  };
}

export function totals(sessions: SessionStats[]): Totals {
  const t: Totals = {
    sessions: sessions.length,
    humanPrompts: 0,
    otherPrompts: {},
    responses: 0,
    subagentResponses: 0,
    tokens: zeroTokens(),
    costUSD: 0,
    sessionsWithoutCost: 0,
    activeHours: 0,
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    hookErrors: 0,
    rejections: 0,
    compactions: 0,
    turns: 0,
    editTurns: 0,
    editRounds: 0,
    editRoundRate: null,
    filesEdited: 0,
    filesReedited: 0,
  };
  let activeMs = 0;
  for (const s of sessions) {
    t.humanPrompts += s.humanPrompts;
    t.otherPrompts = sumMaps([t.otherPrompts, s.otherPrompts]);
    t.responses += s.responses;
    t.subagentResponses += s.subagentResponses;
    for (const tok of Object.values(s.tokensByModel)) addTokens(t.tokens, tok);
    if (s.costUSD === null) t.sessionsWithoutCost++;
    else t.costUSD += s.costUSD;
    activeMs += s.activeMs;
    t.toolCalls += sum(s.toolCalls);
    t.toolErrors += sum(s.toolErrors);
    t.apiErrors += sum(s.apiErrors);
    t.hookErrors += s.hookErrors;
    t.rejections += sum(s.rejections);
    t.compactions += sum(s.compactions);
    t.turns += s.turns;
    t.editTurns += s.editTurns;
    t.editRounds += s.editRounds;
    t.filesEdited += s.filesEdited;
    t.filesReedited += s.filesReedited;
  }
  t.costUSD = Math.round(t.costUSD * 100) / 100;
  t.activeHours = Math.round((activeMs / 3_600_000) * 10) / 10;
  t.editRoundRate = t.editTurns > 0 ? Math.round((t.editRounds / t.editTurns) * 1000) / 1000 : null;
  return t;
}

/** ISO-тиждень у форматі 2026-W47. */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function zeroTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
}

function addTokens(into: TokenTotals, t: TokenTotals): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheCreation += t.cacheCreation;
  into.thinking += t.thinking;
}

function sum(m: Record<string, number>): number {
  return Object.values(m).reduce((a, b) => a + b, 0);
}

function sumMaps(maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function sortDesc(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const fmt = (n: number) => n.toLocaleString('uk-UA');
const mtok = (n: number) => `${(n / 1e6).toFixed(2)} M`;
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

/** Короткий звіт для читання людиною. */
export function formatReport(r: Report): string {
  const t = r.totals;
  const top = (m: Record<string, number>, n = 15) =>
    Object.entries(m)
      .slice(0, n)
      .map(([k, v]) => `| ${k} | ${fmt(v)} |`)
      .join('\n') || '| — | — |';
  const row = (name: string, x: Totals) =>
    `| ${name} | ${x.sessions} | ${x.humanPrompts} | ${x.activeHours} | ${mtok(x.tokens.output)} | $${x.costUSD.toFixed(2)} | ${x.toolErrors} | ${x.rejections} | ${pct(x.editRoundRate)} |`;
  const header = '| | Сесії | Промпти | Активні год | Output токени | Вартість | Помилки інструментів | Відмови | Раунди правок |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |';

  return `# Базова лінія AI Foundation

Період: ${r.period.first ?? '—'} … ${r.period.last ?? '—'} · згенеровано ${r.generatedAt} · ${r.analyzer}${r.anonymized ? ' · проєкти анонімізовано' : ''}

## Загалом

| Метрика | Значення |
| --- | --- |
| Сесії | ${fmt(t.sessions)} |
| Промпти людини | ${fmt(t.humanPrompts)} |
| Інші промпти (не людина) | ${Object.entries(t.otherPrompts).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} |
| Відповіді моделі (основна / субагенти) | ${fmt(t.responses)} / ${fmt(t.subagentResponses)} |
| Токени: input / output / cache read / cache write | ${mtok(t.tokens.input)} / ${mtok(t.tokens.output)} / ${mtok(t.tokens.cacheRead)} / ${mtok(t.tokens.cacheCreation)} |
| Вартість (оцінка Claude Code) | $${t.costUSD.toFixed(2)}${t.sessionsWithoutCost ? ` (без даних про вартість: ${t.sessionsWithoutCost} сесій)` : ''} |
| Активний час | ${t.activeHours} год |
| Виклики інструментів / з помилкою | ${fmt(t.toolCalls)} / ${fmt(t.toolErrors)} |
| Помилки API / хуків | ${t.apiErrors} / ${t.hookErrors} |
| Відхилені дії | ${t.rejections} |
| Стиснення контексту | ${t.compactions} |
| Ходи / з правками / раунди правок | ${fmt(t.turns)} / ${fmt(t.editTurns)} / ${fmt(t.editRounds)} (${pct(t.editRoundRate)}) |
| Змінені файли / повторно в іншому ході | ${fmt(t.filesEdited)} / ${fmt(t.filesReedited)} |

«Раунди правок» — оцінка: хід із правками, за яким одразу йде ще один хід із правками (ADR 0002, п. 4).

## По тижнях

${header}
${Object.entries(r.byWeek).map(([k, x]) => row(k, x)).join('\n')}

## По проєктах

${header}
${Object.entries(r.byProject).map(([k, x]) => row(k, x)).join('\n')}

## За точкою входу

${header}
${Object.entries(r.byEntrypoint).map(([k, x]) => row(k, x)).join('\n')}

## Інструменти

| Інструмент | Викликів |
| --- | --- |
${top(r.tools)}

## Помилки інструментів

| Інструмент | Помилок |
| --- | --- |
${top(r.toolErrors)}

## Скіли й субагенти

| Скіл | Викликів |
| --- | --- |
${top(r.skills)}

| Субагент | Запусків |
| --- | --- |
${top(r.subagents)}

## Відхилені дії

| Джерело / причина | Кількість |
| --- | --- |
${top(r.rejections)}

## Моделі

| Модель | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- |
${Object.entries(r.tokensByModel).map(([m, x]) => `| ${m} | ${mtok(x.input)} | ${mtok(x.output)} | ${mtok(x.cacheRead)} | ${mtok(x.cacheCreation)} |`).join('\n')}
`;
}
