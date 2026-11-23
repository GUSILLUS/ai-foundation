/**
 * База знань проєкту (ADR 0004): реєстр, дерево записів, індекси, застарівання, auto memory.
 * Детерміновані частини скіла project-knowledge; зміст записів пише агент з мого затвердження.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  dataDir,
  findGitDir,
  gitConfigPath,
  normalizePath,
  normalizeRemote,
  readRegistry,
  readRemotes,
  resolveProject,
  SLUG,
  type ProjectEntry,
} from './session-context.ts';

export { SLUG };

export const RECORD_TYPES = ['process', 'flow', 'feature', 'edge-case', 'decision', 'glossary'] as const;
export const RECORD_MAX_LINES = 150;
export const GEN_START = '<!-- af:generated:start -->';
export const GEN_END = '<!-- af:generated:end -->';
export const CARD_START = '<!-- af:knowledge:start -->';
export const CARD_END = '<!-- af:knowledge:end -->';

// ---------- frontmatter ----------

export interface Record_ {
  file: string; // абсолютний шлях
  rel: string; // від кореня knowledge/, зі слешами
  fields: Record<string, string | string[]>;
  lines: number;
}

/** Мінімальний YAML: `key: value`, `key: [a, b]`, списки `- item`. */
export function parseFrontmatter(text: string): { fields: Record<string, string | string[]>; present: boolean } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const fields: Record<string, string | string[]> = {};
  if (lines[0]?.trim() !== '---') return { fields, present: false };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { fields, present: false };
  let listKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fields[listKey] as string[]).push(unquote(item[1] ?? ''));
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const raw = (m[2] ?? '').trim();
    listKey = undefined;
    if (raw === '') {
      fields[key] = [];
      listKey = key;
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      fields[key] = raw.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else fields[key] = unquote(raw);
  }
  return { fields, present: true };
}

function unquote(s: string): string {
  return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s;
}

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);

// ---------- розташування ----------

export interface Location {
  client: string;
  project: string;
  projectDir: string;
  knowledgeDir: string;
  sharedDir: string;
  cardFile: string;
}

export function locate(entry: Pick<ProjectEntry, 'client' | 'project'>, env: NodeJS.ProcessEnv = process.env): Location {
  const root = dataDir(env);
  const projectDir = path.join(root, 'projects', entry.client, entry.project);
  return {
    client: entry.client,
    project: entry.project,
    projectDir,
    knowledgeDir: path.join(projectDir, 'knowledge'),
    sharedDir: path.join(root, 'projects', entry.client, '_shared', 'knowledge'),
    cardFile: path.join(projectDir, 'context.md'),
  };
}

/** Git remote (origin першим) для теки; порожньо, якщо немає git. */
export function remotesOf(cwd: string): string[] {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return [];
  const cfg = gitConfigPath(gitDir);
  return existsSync(cfg) ? readRemotes(readFileSync(cfg, 'utf8')) : [];
}

// ---------- реєстрація ----------

export type RegisterResult =
  | { ok: true; created: boolean; entry: ProjectEntry; message: string }
  | { ok: false; message: string };

/**
 * Дописати проєкт у projects.json. Наявні записи ніколи не перезаписуються:
 * якщо remote чи шлях уже зареєстровано — повертається наявний запис.
 */
export function registerProject(
  cwd: string,
  client: string,
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): RegisterResult {
  if (!SLUG.test(client) || !SLUG.test(project)) {
    return { ok: false, message: 'client і project — slug: a-z, 0-9, -, _ (до 64 символів), з літери чи цифри' };
  }
  if (project === '_shared') return { ok: false, message: '_shared — зарезервована назва для спільних знань клієнта' };
  const root = dataDir(env);
  const file = path.join(root, 'projects.json');
  const reg = readRegistry(root);
  if (!reg.ok && !reg.missing) return { ok: false, message: `${reg.error}; виправте файл вручну — скіл його не перезаписує` };
  const projects = reg.ok ? reg.projects : [];

  const existing = resolveProject(cwd, projects);
  if (existing.kind === 'found') {
    return { ok: true, created: false, entry: existing.entry, message: `уже зареєстровано як ${existing.entry.client}/${existing.entry.project}` };
  }
  if (existing.kind === 'ambiguous') return { ok: false, message: 'тека вже відповідає кільком записам у projects.json — виправте реєстр вручну' };
  if (projects.some((p) => p.client === client && p.project === project)) {
    return { ok: false, message: `${client}/${project} уже є в реєстрі з іншим remote чи шляхом — оберіть іншу назву або виправте реєстр вручну` };
  }

  const remotes = remotesOf(cwd).map(normalizeRemote);
  const entry: ProjectEntry = {
    client,
    project,
    remotes: remotes.slice(0, 1),
    paths: remotes.length ? [] : [path.resolve(cwd)],
  };
  // Пишемо сирий JSON наново лише з доданим записом: інші поля файлу зберігаються.
  let raw: { version?: number; projects?: unknown[]; [k: string]: unknown } = { version: 1, projects: [] };
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as typeof raw;
  raw.projects = [...(raw.projects ?? []), { client, project, remotes: entry.remotes, paths: entry.paths }];
  mkdirSync(root, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
  const by = entry.remotes.length ? `remote ${entry.remotes[0]}` : `шлях ${entry.paths[0]}`;
  return { ok: true, created: true, entry, message: `зареєстровано ${client}/${project} за ${by}` };
}

// ---------- дерево знань ----------

/** Записи дерева: усі *.md, крім службових (`_…`) і тек `_inbox`, `.…`. */
export function readRecords(knowledgeDir: string): Record_[] {
  const out: Record_[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const text = readFileSync(full, 'utf8');
        out.push({
          file: full,
          rel: path.relative(knowledgeDir, full).split(path.sep).join('/'),
          fields: parseFrontmatter(text).fields,
          lines: text.split(/\r?\n/).length,
        });
      }
    }
  };
  walk(knowledgeDir);
  return out;
}

/** Проблеми записів: без summary, невідомий type, без джерел, задовгі. */
export function lintRecords(records: Record_[]): string[] {
  const issues: string[] = [];
  for (const r of records) {
    if (!str(r.fields.summary)) issues.push(`${r.rel}: немає summary`);
    const type = str(r.fields.type);
    if (!(RECORD_TYPES as readonly string[]).includes(type)) issues.push(`${r.rel}: type "${type}" — очікується ${RECORD_TYPES.join(', ')}`);
    if (list(r.fields.sources).length === 0) issues.push(`${r.rel}: немає sources`);
    if (r.lines > RECORD_MAX_LINES) issues.push(`${r.rel}: ${r.lines} рядків, ліміт ${RECORD_MAX_LINES} — розбийте на підтеми`);
  }
  return issues;
}

export interface Staleness {
  rel: string;
  state: 'fresh' | 'stale' | 'unknown';
  reason?: string;
}

/** Чи змінювався код під `paths` запису після коміту з `verified` (`2026-11-21 abc1234`). */
export function staleness(records: Record_[], repoDir: string): Staleness[] {
  return records.map((r) => {
    const paths = list(r.fields.paths);
    const commit = /\b([0-9a-f]{7,40})\b/.exec(str(r.fields.verified))?.[1];
    if (paths.length === 0) return { rel: r.rel, state: 'unknown', reason: 'немає paths' };
    if (!commit) return { rel: r.rel, state: 'unknown', reason: 'у verified немає коміту' };
    const g = spawnSync('git', ['-C', repoDir, 'log', '-1', '--format=%h', `${commit}..HEAD`, '--', ...paths], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    if (g.status !== 0) return { rel: r.rel, state: 'unknown', reason: `git не знає коміт ${commit}` };
    return g.stdout.trim()
      ? { rel: r.rel, state: 'stale', reason: `змінено після ${commit} (останній ${g.stdout.trim()})` }
      : { rel: r.rel, state: 'fresh' };
  });
}

function title(name: string): string {
  return name.replace(/\.md$/, '').replace(/[-_]+/g, ' ');
}

/**
 * Згенерувати `_topic.md` у кожній теці (вступний абзац, написаний руками, зберігається —
 * перезаписується лише блок між маркерами) і `_index.md` з усім деревом.
 */
export function buildIndex(knowledgeDir: string, stale: Map<string, Staleness> = new Map()): { written: string[] } {
  const records = readRecords(knowledgeDir);
  const written: string[] = [];
  const mark = (rel: string) => (stale.get(rel)?.state === 'stale' ? ' ⚠ може бути застарілим' : '');

  const dirs = new Set<string>(['']);
  for (const r of records) {
    const parts = r.rel.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  for (const dir of [...dirs].filter(Boolean).sort()) {
    const abs = path.join(knowledgeDir, ...dir.split('/'));
    const children = records.filter((r) => r.rel.startsWith(dir + '/'));
    const direct = children.filter((r) => !r.rel.slice(dir.length + 1).includes('/'));
    const subdirs = [...dirs].filter((d) => d.startsWith(dir + '/') && !d.slice(dir.length + 1).includes('/')).sort();
    const lines = [
      ...subdirs.map((d) => `- [[${d}/_topic]] — ${topicSummary(path.join(knowledgeDir, ...d.split('/'))) || 'підтема'}`),
      ...direct.map((r) => `- [[${r.rel.replace(/\.md$/, '')}]] — ${str(r.fields.summary) || '(без summary)'}${mark(r.rel)}`),
    ];
    const file = path.join(abs, '_topic.md');
    const generated = `${GEN_START}\n${lines.join('\n')}\n${GEN_END}`;
    let text: string;
    if (existsSync(file)) {
      const old = readFileSync(file, 'utf8');
      const a = old.indexOf(GEN_START);
      const b = old.indexOf(GEN_END);
      text = a >= 0 && b > a ? old.slice(0, a) + generated + old.slice(b + GEN_END.length) : `${old.trimEnd()}\n\n${generated}\n`;
    } else {
      text = `# ${title(path.basename(abs))}\n\n<Один абзац: що в цій гілці.>\n\n${generated}\n`;
    }
    writeFileSync(file, text);
    written.push(file);
  }

  const tree: string[] = ['# Дерево знань', '', '_Генерується скриптом `knowledge.ts index`; руками не редагувати._', ''];
  const emit = (dir: string, depth: number) => {
    const pad = '  '.repeat(depth);
    for (const d of [...dirs].filter((x) => x && x.startsWith(dir ? dir + '/' : '') && !x.slice(dir ? dir.length + 1 : 0).includes('/')).sort()) {
      const sum = topicSummary(path.join(knowledgeDir, ...d.split('/')));
      tree.push(`${pad}- **${path.basename(d)}/**${sum ? ` — ${sum}` : ''}`);
      emit(d, depth + 1);
    }
    for (const r of records.filter((x) => x.rel.split('/').slice(0, -1).join('/') === dir)) {
      tree.push(`${pad}- [[${r.rel.replace(/\.md$/, '')}]] — ${str(r.fields.summary)}${mark(r.rel)}`);
    }
  };
  emit('', 0);
  if (records.length === 0) tree.push('Записів поки немає.');
  mkdirSync(knowledgeDir, { recursive: true });
  const indexFile = path.join(knowledgeDir, '_index.md');
  writeFileSync(indexFile, tree.join('\n') + '\n');
  written.push(indexFile);
  return { written };
}

/** Перший абзац `_topic.md` після заголовка, якщо він не шаблонний. */
function topicSummary(dir: string): string {
  const file = path.join(dir, '_topic.md');
  if (!existsSync(file)) return '';
  const para = readFileSync(file, 'utf8')
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('<') && !p.startsWith(GEN_START));
  return (para ?? '').replace(/\s+/g, ' ').slice(0, 140);
}

/** Розділ «Знання» картки: два верхні рівні дерева проєкту й спільного клієнта, між маркерами. */
export function cardKnowledgeSection(loc: Location): string {
  const top = (k: string, label: string) => {
    if (!existsSync(k)) return [];
    const recs = readRecords(k);
    const dirs = [...new Set(recs.map((r) => r.rel.split('/')[0] as string).filter((d, _i) => recs.some((r) => r.rel.startsWith(d + '/'))))].sort();
    const rows = dirs.map((d) => {
      const subs = [...new Set(recs.filter((r) => r.rel.startsWith(d + '/')).map((r) => r.rel.split('/')[1] as string))]
        .map((s) => s.replace(/\.md$/, ''))
        .slice(0, 8);
      const sum = topicSummary(path.join(k, d));
      return `- **${d}/**${sum ? ` — ${sum}` : ''}${subs.length ? ` (${subs.join(', ')})` : ''}`;
    });
    const loose = recs.filter((r) => !r.rel.includes('/')).map((r) => `- [[${r.rel.replace(/\.md$/, '')}]] — ${str(r.fields.summary)}`);
    return rows.length || loose.length ? [`${label}:`, ...rows, ...loose] : [];
  };
  const lines = [...top(loc.knowledgeDir, 'Проєкт'), ...top(loc.sharedDir, 'Спільне клієнта')];
  return `${CARD_START}\n${lines.length ? lines.join('\n') : 'Записів знань поки немає.'}\n${CARD_END}`;
}

export function updateCardKnowledge(loc: Location): boolean {
  if (!existsSync(loc.cardFile)) return false;
  const old = readFileSync(loc.cardFile, 'utf8');
  const section = cardKnowledgeSection(loc);
  const a = old.indexOf(CARD_START);
  const b = old.indexOf(CARD_END);
  const text = a >= 0 && b > a ? old.slice(0, a) + section + old.slice(b + CARD_END.length) : `${old.trimEnd()}\n\n## Знання\n\n${section}\n`;
  writeFileSync(loc.cardFile, text);
  return true;
}

// ---------- auto memory Claude Code ----------

/** Тека auto memory: `<config>/projects/<корінь репо, не-алфанумерика → ->/memory`. */
export function autoMemoryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  const gitDir = findGitDir(cwd);
  let root = path.resolve(cwd);
  if (gitDir) {
    const common = existsSync(path.join(gitDir, 'commondir'))
      ? path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
      : gitDir;
    root = path.dirname(common);
  }
  return path.join(config, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

export { normalizePath };
