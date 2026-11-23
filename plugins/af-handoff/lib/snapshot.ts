/**
 * Знімок сесії для handoff: детерміновано з транскрипту, без моделі.
 *
 * - PreCompact і SessionEnd(clear) зберігають знімок у теку handoff проєкту;
 * - SessionStart(compact) повертає знімок цієї сесії в контекст;
 * - SessionStart(clear) і новий старт лише вказують на знімок чи ручний handoff — /clear лишається /clear.
 *
 * Транскрипт містить мої промпти й шляхи файлів; знімок лягає поряд з іншими даними проєкту
 * в ~/ai-foundation-data (поза git). Вміст файлів і результати інструментів у знімок не потрапляють.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';
import { dataDir, findGitDir, findRepoRoot, projectDir, readRegistry, resolveProject } from './shared/project-registry.ts';

export const SNAPSHOT_LIMIT = 4_000;
export const KEEP_AUTO = 20;
const TAIL_BYTES = 8 * 1024 * 1024;
const CLEAR_WINDOW_MS = 2 * 3_600_000;
const MANUAL_WINDOW_MS = 7 * 24 * 3_600_000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const KNOWLEDGE = /ai-foundation-data[\\/]projects[\\/][^\\/]+[\\/]([^\\/]+)[\\/]knowledge[\\/](.+)\.md$/;

export type Trigger = 'compact' | 'clear' | 'manual';

// ---------- де лежать знімки ----------

export interface Place {
  dir: string;
  label: string; // `клієнт/проєкт` або `незареєстрована тека`
}

/** Тека handoff: проєкту з реєстру або `unregistered/<корінь репо>` — щоб не змішувати з клієнтами. */
export function handoffPlace(cwd: string, env: NodeJS.ProcessEnv = process.env): Place {
  const reg = readRegistry(dataDir(env));
  if (reg.ok) {
    const res = resolveProject(cwd, reg.projects);
    if (res.kind === 'found') return { dir: path.join(projectDir(res.entry, env), 'handoff'), label: `${res.entry.client}/${res.entry.project}` };
  }
  const root = findRepoRoot(cwd) ?? path.resolve(cwd);
  return { dir: path.join(dataDir(env), 'unregistered', root.replace(/[^a-zA-Z0-9]/g, '-').slice(-120), 'handoff'), label: 'незареєстрована тека' };
}

// ---------- транскрипт ----------

/** Останні TAIL_BYTES файлу цілими рядками — SessionEnd має обмежений час. */
export function readTail(file: string, bytes = TAIL_BYTES): string[] {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // перший рядок обрізаний
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

export interface SessionFacts {
  prompts: string[];
  changed: string[];
  read: string[];
  knowledge: string[];
  tasks: Array<{ text: string; status: string }>;
  lastReply: string;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
  return '';
}

/** Запис бази знань: під `<дані>/projects/<клієнт>/<проєкт|_shared>/knowledge/` або за типовим шляхом. */
function knowledgeKey(p: string, env: NodeJS.ProcessEnv): string | undefined {
  const rel = path.relative(path.join(dataDir(env), 'projects'), path.resolve(p)).split(path.sep);
  if (rel.length >= 4 && rel[0] !== '..' && rel[2] === 'knowledge' && p.endsWith('.md')) {
    return `${rel[1] === '_shared' ? 'клієнт' : 'проєкт'}: ${rel.slice(3).join('/').replace(/\.md$/, '')}`;
  }
  const k = KNOWLEDGE.exec(p);
  return k ? `${k[1] === '_shared' ? 'клієнт' : 'проєкт'}: ${(k[2] as string).replace(/\\/g, '/')}` : undefined;
}

export function extractFacts(lines: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SessionFacts {
  const f: SessionFacts = { prompts: [], changed: [], read: [], knowledge: [], tasks: [], lastReply: '' };
  const tasks = new Map<string, { text: string; status: string }>();
  const pendingCreate = new Map<string, string>(); // tool_use id → subject
  let todo: Array<{ text: string; status: string }> | undefined;
  const rel = (p: string) => {
    const r = path.relative(cwd, path.resolve(cwd, p));
    return r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/');
  };
  const add = (list: string[], v: string) => {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    list.push(v);
  };

  for (const line of lines) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.isSidechain === true) continue;
    const msg = r.message as { content?: unknown } | undefined;
    if (r.type === 'user') {
      const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      const results = blocks.filter((b) => b?.type === 'tool_result');
      for (const res of results) {
        const subject = pendingCreate.get(String(res.tool_use_id));
        const id = /Task #(\d+)/.exec(textOf(res.content))?.[1];
        if (subject && id) tasks.set(id, { text: subject, status: 'pending' });
      }
      if (results.length > 0 || r.isMeta === true || r.isCompactSummary === true) continue;
      const kind = (r.origin as { kind?: unknown } | undefined)?.kind;
      if (kind !== undefined && kind !== 'human') continue;
      const text = textOf(msg?.content).trim();
      if (text && !text.startsWith('<')) f.prompts.push(oneLine(text, 300));
    } else if (r.type === 'assistant') {
      const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
      if (text) f.lastReply = text;
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? '');
        const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
        if (p && EDIT_TOOLS.has(name)) add(f.changed, rel(p));
        if (p && name === 'Read') {
          const k = knowledgeKey(p, env);
          if (k) add(f.knowledge, k);
          else add(f.read, rel(p));
        }
        if (name === 'TodoWrite' && Array.isArray(input.todos)) {
          todo = (input.todos as Array<Record<string, unknown>>).map((t) => ({ text: oneLine(String(t.content ?? ''), 120), status: String(t.status ?? '') }));
        }
        if (name === 'TaskCreate' && typeof input.subject === 'string') pendingCreate.set(String(b.id), oneLine(input.subject, 120));
        if (name === 'TaskUpdate' && typeof input.taskId === 'string') {
          const t = tasks.get(input.taskId);
          if (t && typeof input.status === 'string') {
            if (input.status === 'deleted') tasks.delete(input.taskId);
            else t.status = input.status;
          }
        }
      }
    }
  }
  f.read = f.read.filter((x) => !f.changed.includes(x));
  f.tasks = todo ?? [...tasks.values()];
  f.prompts = f.prompts.slice(-5);
  return f;
}

/** Гілка з .git/HEAD без запуску git. */
export function branchOf(cwd: string): string | undefined {
  const gitDir = findGitDir(cwd);
  if (!gitDir || !existsSync(path.join(gitDir, 'HEAD'))) return undefined;
  const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return m ? m[1] : head.slice(0, 12);
}

export function renderSnapshot(f: SessionFacts, meta: { trigger: Trigger; when: Date; label: string; branch?: string; candidates: number }): string {
  const title = { compact: 'перед стисненням контексту', clear: 'перед /clear', manual: 'на вимогу' }[meta.trigger];
  const mark = (s: string) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
  const list = (xs: string[], max: number) => {
    const shown = xs.slice(-max);
    const more = xs.length - shown.length;
    return shown.map((x) => `- ${x}`).join('\n') + (more > 0 ? `\n- … ще ${more}` : '');
  };
  const parts = [
    `# Знімок сесії ${title} — ${meta.when.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Проєкт: ${meta.label}${meta.branch ? ` · гілка: ${meta.branch}` : ''}`,
    f.prompts.length ? `## Останні запити\n${list(f.prompts, 5)}` : '',
    f.tasks.length ? `## Задачі\n${f.tasks.map((t) => `- ${mark(t.status)} ${t.text}`).join('\n')}` : '',
    f.changed.length ? `## Змінені файли\n${list(f.changed, 20)}` : '',
    f.read.length ? `## Прочитані файли\n${list(f.read, 15)}` : '',
    f.knowledge.length ? `## Прочитані записи знань\n${list(f.knowledge, 10)}` : '',
    meta.candidates ? `## Кандидати знань\n${meta.candidates} у _inbox — не затверджені.` : '',
    f.lastReply ? `## Остання відповідь агента\n${oneLine(f.lastReply, 800)}` : '',
  ].filter(Boolean);
  let out = parts.join('\n\n');
  if (out.length > SNAPSHOT_LIMIT) out = out.slice(0, SNAPSHOT_LIMIT - 1) + '…';
  return out + '\n';
}

// ---------- збереження й відновлення ----------

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const shortId = (id: string) => id.replace(/[^\w-]/g, '').slice(0, 8) || 'nosession';

function countCandidates(place: Place): number {
  const inbox = path.join(path.dirname(place.dir), 'knowledge', '_inbox');
  return existsSync(inbox) ? readdirSync(inbox).filter((x) => x.endsWith('.md')).length : 0;
}

export function saveSnapshot(input: HookInput, trigger: Exclude<Trigger, 'manual'>, env: NodeJS.ProcessEnv = process.env, now = new Date()): HookOutcome {
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : undefined;
  if (!cwd || !transcript) return { kind: 'degrade', reason: 'у вході немає cwd чи transcript_path — знімок не збережено' };
  if (!existsSync(transcript)) return { kind: 'degrade', reason: 'транскрипт не знайдено — знімок не збережено' };
  const place = handoffPlace(cwd, env);
  const facts = extractFacts(readTail(transcript), cwd, env);
  const text = renderSnapshot(facts, { trigger, when: now, label: place.label, branch: branchOf(cwd), candidates: countCandidates(place) });
  mkdirSync(place.dir, { recursive: true });
  writeFileSync(path.join(place.dir, `${stamp(now)}-${trigger}-${shortId(String(input.session_id ?? ''))}.md`), text);
  prune(place.dir);
  return { kind: 'pass' };
}

/** Лишає останні KEEP_AUTO автоматичних знімків; ручні handoff не чіпає. */
export function prune(dir: string): void {
  const auto = readdirSync(dir).filter((x) => /-(compact|clear)-[\w-]+\.md$/.test(x)).sort();
  for (const old of auto.slice(0, Math.max(0, auto.length - KEEP_AUTO))) rmSync(path.join(dir, old), { force: true });
}

function latest(dir: string, re: RegExp, maxAgeMs: number, now: Date): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((x) => re.test(x)).sort();
  const last = files[files.length - 1];
  if (!last) return undefined;
  const file = path.join(dir, last);
  return now.getTime() - statSync(file).mtimeMs <= maxAgeMs ? file : undefined;
}

export function restore(input: HookInput, env: NodeJS.ProcessEnv = process.env, now = new Date()): HookOutcome {
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (!cwd) return { kind: 'pass' };
  const place = handoffPlace(cwd, env);
  const source = String(input.source ?? '');
  if (source === 'compact') {
    const id = shortId(String(input.session_id ?? ''));
    const file = latest(place.dir, new RegExp(`-compact-${id}\\.md$`), 3_600_000, now);
    if (!file) return { kind: 'pass' };
    return { kind: 'context', text: `Знімок af-handoff, збережений перед стисненням (доповнює підсумок стиснення):\n\n${readFileSync(file, 'utf8').trim()}` };
  }
  if (source === 'clear') {
    const file = latest(place.dir, /-clear-[\w-]+\.md$/, CLEAR_WINDOW_MS, now);
    return file ? { kind: 'context', text: `Є знімок попередньої сесії перед /clear: ${file}. Прочитай його, лише якщо користувач продовжує ту саму роботу.` } : { kind: 'pass' };
  }
  const manual = latest(place.dir, /-manual(-[\w-]+)?\.md$/, MANUAL_WINDOW_MS, now);
  return manual ? { kind: 'context', text: `Останній handoff проєкту: ${manual}. Прочитай, якщо користувач повертається до незавершеної роботи.` } : { kind: 'pass' };
}

export { KNOWLEDGE as KNOWLEDGE_PATH_RE };
