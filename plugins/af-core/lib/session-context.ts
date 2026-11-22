/**
 * Контекст на старті сесії (ADR 0004): глобальні правила + картка проєкту.
 *
 * Проєкт визначається лише за реєстром ~/ai-foundation-data/projects.json — за git remote,
 * запасний варіант — за шляхом. Вгадувати за назвою теки не можна (принцип 8, ізоляція клієнтів).
 * Читаються лише файли: git не запускається, мережі немає.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';

export const SESSION_START_LIMIT = 10_000;
export const CARD_LIMIT = 6_000;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AF_DATA_DIR ?? path.join(homedir(), 'ai-foundation-data');
}

// ---------- git remote ----------

/** Тека з `.git` (каталог або файл worktree) від `start` угору. */
export function findGitDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      // worktree або submodule: файл `gitdir: <шлях>`
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (m?.[1]) return path.resolve(dir, m[1].trim());
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Корінь робочої копії (тека з `.git` — каталогом чи файлом worktree) від `start` угору. */
export function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Конфіг репозиторію: для worktree — спільний (`commondir`). */
export function gitConfigPath(gitDir: string): string {
  const common = path.join(gitDir, 'commondir');
  if (existsSync(common)) return path.join(path.resolve(gitDir, readFileSync(common, 'utf8').trim()), 'config');
  return path.join(gitDir, 'config');
}

/** URL усіх remote з git config (спершу origin). */
export function readRemotes(configText: string): string[] {
  const out: Array<{ name: string; url: string }> = [];
  let current: string | undefined;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith('[')) {
      current = undefined;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (current && url?.[1]) out.push({ name: current, url: url[1].trim() });
  }
  return out.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin')).map((r) => r.url);
}

/** `git@github.com:Acme/Portal.git`, `https://user@github.com/acme/portal` → `github.com/acme/portal`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u); // scp-подібний ssh
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`;
  u = u
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:\d+\//, '/')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
  return u.toLowerCase();
}

/** Шлях для порівняння: прямі слеші, без кінцевого слеша; на Windows — без регістру. */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

// ---------- реєстр ----------

export interface ProjectEntry {
  client: string;
  project: string;
  remotes: string[];
  paths: string[];
}

export type RegistryRead =
  | { ok: true; projects: ProjectEntry[] }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string };

export function readRegistry(dir: string): RegistryRead {
  const file = path.join(dir, 'projects.json');
  if (!existsSync(file)) return { ok: false, missing: true };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { ok: false, missing: false, error: 'projects.json — невалідний JSON' };
  }
  const list = (data as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return { ok: false, missing: false, error: 'projects.json: немає масиву projects' };
  const projects: ProjectEntry[] = [];
  for (const [i, raw] of list.entries()) {
    const e = raw as Partial<Record<keyof ProjectEntry, unknown>>;
    if (typeof e?.client !== 'string' || !SLUG.test(e.client) || typeof e.project !== 'string' || !SLUG.test(e.project)) {
      return { ok: false, missing: false, error: `projects.json: запис ${i + 1} — client і project мають бути slug (a-z, 0-9, -, _)` };
    }
    // Один рядок замість масиву теж приймаємо: PowerShell 5.1 у ConvertTo-Json згортає масив з одного елемента.
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
    projects.push({ client: e.client, project: e.project, remotes: strings(e.remotes).map(normalizeRemote), paths: strings(e.paths) });
  }
  return { ok: true, projects };
}

export type Resolution =
  | { kind: 'found'; entry: ProjectEntry; by: 'remote' | 'path' }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' };

/** Проєкт для теки: спершу за remote, потім за найдовшим зареєстрованим шляхом. */
export function resolveProject(cwd: string, projects: ProjectEntry[]): Resolution {
  const gitDir = findGitDir(cwd);
  if (gitDir) {
    const config = gitConfigPath(gitDir);
    const remotes = existsSync(config) ? readRemotes(readFileSync(config, 'utf8')).map(normalizeRemote) : [];
    for (const remote of remotes) {
      const hits = projects.filter((p) => p.remotes.includes(remote));
      if (hits.length > 1) return { kind: 'ambiguous' };
      if (hits[0]) return { kind: 'found', entry: hits[0], by: 'remote' };
    }
  }
  const here = normalizePath(path.resolve(cwd));
  let best: { entry: ProjectEntry; len: number } | undefined;
  let tie = false;
  for (const entry of projects) {
    for (const p of entry.paths) {
      const base = normalizePath(p);
      if (here === base || here.startsWith(base + '/')) {
        if (!best || base.length > best.len) {
          best = { entry, len: base.length };
          tie = false;
        } else if (base.length === best.len && best.entry !== entry) tie = true;
      }
    }
  }
  if (tie) return { kind: 'ambiguous' };
  return best ? { kind: 'found', entry: best.entry, by: 'path' } : { kind: 'unknown' };
}

// ---------- збирання контексту ----------

/** Обрізати картку по межі розділу `## ` в межах ліміту. */
export function truncateCard(text: string, limit = CARD_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  const cut = head.lastIndexOf('\n## ');
  return { text: (cut > 0 ? head.slice(0, cut) : head).trimEnd(), truncated: true };
}

export interface BuildOptions {
  rules: string;
  env?: NodeJS.ProcessEnv;
}

export function buildSessionContext(input: HookInput, opts: BuildOptions): HookOutcome {
  const rules = opts.rules.trim();
  const dir = dataDir(opts.env);
  const parts = [rules];
  const finish = (notice?: string): HookOutcome => {
    let text = parts.filter(Boolean).join('\n\n');
    if (text.length > SESSION_START_LIMIT) text = text.slice(0, SESSION_START_LIMIT - 1) + '…';
    return notice ? { kind: 'context', text, notice } : { kind: 'context', text };
  };

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined;
  if (!cwd) return finish('немає cwd у вході — контекст проєкту не додано');

  const reg = readRegistry(dir);
  if (!reg.ok) {
    if (reg.missing) {
      parts.push('Контекст проєкту: реєстру проєктів ще немає (projects.json в ai-foundation-data).');
      return finish();
    }
    return finish(`${reg.error} — контекст проєкту не додано`);
  }

  const res = resolveProject(cwd, reg.projects);
  if (res.kind === 'ambiguous') return finish('тека відповідає кільком проєктам у projects.json — контекст проєкту не додано');
  if (res.kind === 'unknown') {
    parts.push('Контекст проєкту: ця тека не зареєстрована в projects.json — картки проєкту немає, базові речі доведеться з’ясувати.');
    return finish();
  }

  const { client, project } = res.entry;
  const projectDir = path.join(dir, 'projects', client, project);
  const cardFile = path.join(projectDir, 'context.md');
  const knowledge = [
    `База знань: ${path.join(projectDir, 'knowledge')}`,
    `спільне клієнта: ${path.join(dir, 'projects', client, '_shared', 'knowledge')}`,
  ].join('; ');
  if (!existsSync(cardFile)) {
    parts.push(`# Проєкт ${client}/${project}\n\nКартки проєкту ще немає (${cardFile}). ${knowledge}.`);
    return finish(`картки проєкту ${client}/${project} ще немає`);
  }
  const card = truncateCard(readFileSync(cardFile, 'utf8').replace(/^﻿/, '').trim());
  const note = card.truncated ? `\n\n_(Картку обрізано до ${CARD_LIMIT} символів; повна — ${cardFile}.)_` : '';
  parts.push(`# Проєкт ${client}/${project}\n\n${card.text}${note}\n\n${knowledge}.`);
  return finish(card.truncated ? `картка ${client}/${project} довша за ${CARD_LIMIT} символів — обрізано` : undefined);
}
