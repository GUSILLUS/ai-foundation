import { statSync } from 'node:fs';
import path from 'node:path';
import { getPath, readLines } from './transcripts.ts';

/**
 * Інвентаризація транскриптів (ADR 0002, п. 2): опис даних агрегатами, щоб зафіксувати парсер.
 *
 * Що потрапляє у звіт: кількості, діапазон дат, шаблони розташування файлів,
 * назви ключів (без значень) і значення лише для полів-переліків з білого списку.
 * Що не потрапляє ніколи: тексти, шляхи, команди, назви проєктів, вміст інструментів.
 */

/** Поля-переліки, значення яких безпечно рахувати. Інші значення не читаємо. */
export const ENUM_FIELDS = [
  'type',
  'subtype',
  'entrypoint',
  'version',
  'userType',
  'permissionMode',
  'isSidechain',
  'isMeta',
  'isCompactSummary',
  'level',
  'operation',
  'mode',
  'message.role',
  'message.type',
  'message.model',
  'message.stop_reason',
  'message.content[].type',
  'permissionDecision.decision',
  'permissionDecision.source',
  'permissionDecision.reasonType',
  'permissionDecision.reasonCode',
  'permissionDecision.classifierCategory',
  'permissionDecision.grantScope',
  'attachment.type',
  // Походження промпту: людина, інша сесія, субагент (ADR 0002, «Промпт людини»).
  'origin.kind',
  'promptSource',
  'turnOrigin',
  // Помилки API й стиснення контексту.
  'isApiErrorMessage',
  'error',
  'compactMetadata.trigger',
  // Записи api-request: звідки запит і з яким зусиллям.
  'querySource',
  'params.model',
  'params.output_config.effort',
] as const;

/** Контейнери, усередину яких не заглядаємо навіть за назвами ключів: там вміст користувача. */
const OPAQUE = new Set(['message.content[].input', 'message.content[].content', 'toolUseResult', 'wireToolInputs', 'wireIngestContext', 'mcpMeta']);
const MAX_DEPTH = 5;
const SAFE_VALUE = /^[\w.:+-]{1,60}$/;
const IDENT_KEY = /^[A-Za-z_$][\w$-]{0,40}$/;
const ID_KEY = /^(?:toolu|srvtoolu|msg|req|agent)_[A-Za-z0-9]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TypeSummary {
  count: number;
  keys: string[];
}

export interface Inventory {
  generatedAt: string;
  configDirSource: string;
  files: { count: number; bytes: number; layouts: Record<string, number> };
  lines: { total: number; records: number; empty: number; invalidJson: number; nonObject: number };
  dateRange: { first: string | null; last: string | null };
  sessions: number;
  types: Record<string, TypeSummary>;
  values: Record<string, Record<string, number>>;
}

export async function buildInventory(files: string[], projectsDir: string, configDirSource: string): Promise<Inventory> {
  const inv: Inventory = {
    generatedAt: new Date().toISOString(),
    configDirSource,
    files: { count: files.length, bytes: 0, layouts: {} },
    lines: { total: 0, records: 0, empty: 0, invalidJson: 0, nonObject: 0 },
    dateRange: { first: null, last: null },
    sessions: 0,
    types: {},
    values: {},
  };
  const keys = new Map<string, Set<string>>();
  const sessions = new Set<string>();

  for (const file of files) {
    inv.files.bytes += statSync(file).size;
    bump(inv.files.layouts, layoutOf(path.relative(projectsDir, file)));
    for await (const line of readLines(file)) {
      inv.lines.total++;
      if (line.kind === 'empty') inv.lines.empty++;
      else if (line.kind === 'invalid') inv.lines.invalidJson++;
      else if (line.kind === 'non-object') inv.lines.nonObject++;
      else {
        inv.lines.records++;
        const r = line.record;
        const type = typeof r.type === 'string' && SAFE_VALUE.test(r.type) ? r.type : '<no-type>';
        inv.types[type] ??= { count: 0, keys: [] };
        inv.types[type].count++;
        let set = keys.get(type);
        if (!set) keys.set(type, (set = new Set()));
        collectKeys(r, '', 0, set);
        if (typeof r.sessionId === 'string') sessions.add(r.sessionId);
        if (typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp))) {
          const ts = new Date(r.timestamp).toISOString();
          if (!inv.dateRange.first || ts < inv.dateRange.first) inv.dateRange.first = ts;
          if (!inv.dateRange.last || ts > inv.dateRange.last) inv.dateRange.last = ts;
        }
        for (const field of ENUM_FIELDS) countEnum(inv.values, field, r);
      }
    }
  }
  for (const [type, set] of keys) inv.types[type]!.keys = [...set].sort();
  inv.sessions = sessions.size;
  return inv;
}

function collectKeys(value: unknown, at: string, depth: number, out: Set<string>): void {
  if (depth >= MAX_DEPTH || OPAQUE.has(at)) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectKeys(item, `${at}[]`, depth + 1, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [rawKey, v] of Object.entries(value)) {
    const key = ID_KEY.test(rawKey) ? '<id>' : IDENT_KEY.test(rawKey) ? rawKey : '<dynamic>';
    const p = at ? `${at}.${key}` : key;
    out.add(p);
    collectKeys(v, p, depth + 1, out);
  }
}

function countEnum(values: Inventory['values'], field: string, record: Record<string, unknown>): void {
  const found: unknown[] = [];
  if (field === 'message.content[].type') {
    const content = getPath(record, 'message.content');
    if (Array.isArray(content)) for (const block of content) found.push(getPath(block, 'type'));
  } else {
    found.push(getPath(record, field));
  }
  for (const v of found) {
    if (v === undefined || v === null) continue;
    const label = typeof v === 'boolean' ? String(v) : typeof v === 'string' && SAFE_VALUE.test(v) ? v : '<other>';
    values[field] ??= {};
    bump(values[field], label);
  }
}

/** Шаблон розташування файлу без імен: `<project>/<session>.jsonl`, `<project>/<session>/subagents/agent-<id>.jsonl`. */
export function layoutOf(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return parts
    .map((seg, i) => {
      if (i === 0) return '<project>';
      const ext = seg.endsWith('.jsonl') ? '.jsonl' : '';
      const base = ext ? seg.slice(0, -ext.length) : seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) return `<session>${ext}`;
      const generic = base.replace(/[0-9a-f]{6,}/gi, '<id>');
      return (/^[\w<>.-]{1,40}$/.test(generic) ? generic : '<name>') + ext;
    })
    .join('/');
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Короткий людський підсумок для консолі. */
export function formatInventory(inv: Inventory): string {
  const lines = [
    `Файлів: ${inv.files.count} (${(inv.files.bytes / 1024 / 1024).toFixed(1)} МБ), сесій: ${inv.sessions}`,
    `Період: ${inv.dateRange.first ?? '—'} … ${inv.dateRange.last ?? '—'}`,
    `Рядків: ${inv.lines.total}; записів ${inv.lines.records}, невалідних ${inv.lines.invalidJson}, порожніх ${inv.lines.empty}`,
    'Розташування файлів:',
    ...Object.entries(inv.files.layouts).map(([k, n]) => `  ${k}: ${n}`),
    'Типи записів:',
    ...Object.entries(inv.types)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([t, s]) => `  ${t}: ${s.count} (ключів ${s.keys.length})`),
    'Версії Claude Code: ' + Object.keys(inv.values.version ?? {}).sort().join(', '),
    'Точки входу: ' + Object.entries(inv.values.entrypoint ?? {}).map(([k, n]) => `${k} ${n}`).join(', '),
  ];
  return lines.join('\n');
}
