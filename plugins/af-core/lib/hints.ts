/**
 * Підказки на записи знань (ADR 0004, п. 2): без моделі, детерміновано, лише коли є збіг.
 *
 * - UserPromptSubmit: слова промпту ↔ назви й `aliases` записів → «релевантно: …».
 * - PostToolUse (Read/Edit/Write): файл під `paths` запису, який ще не читали → підказка.
 *
 * Стан на сесію (що вже підказано чи прочитано) — у CLAUDE_PLUGIN_DATA; власник — af-core.
 * SessionStart (clear/compact) скидає його: після стиснення підказки знову корисні.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { locate, readRecords, type Record_ } from './knowledge.ts';
import { dataDir, findRepoRoot, normalizePath, readRegistry, resolveProject } from './session-context.ts';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';

export const MAX_HINTS = 3;
const GENERIC_STEMS = new Set(['overview', 'edge-cases', 'edge_cases', 'decisions', 'notes', 'readme', 'index']);
const MIN_WORD = 3;
const EDIT_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ---------- стан сесії ----------

interface HintState {
  hinted: string[];
  read: string[];
}

export function stateFile(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_PLUGIN_DATA ?? path.join(tmpdir(), 'af-core');
  return path.join(base, 'hints', `${sessionId.replace(/[^\w-]/g, '_')}.json`);
}

function loadState(file: string): HintState {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<HintState>;
    return { hinted: v.hinted ?? [], read: v.read ?? [] };
  } catch {
    return { hinted: [], read: [] };
  }
}

function saveState(file: string, s: HintState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s));
}

export function resetState(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(stateFile(sessionId, env), { force: true });
}

// ---------- теми ----------

export interface Topic {
  /** Шлях для агента: абсолютний файл запису. */
  file: string;
  /** Коротка мітка: `process/deploy` чи `спільне: process/deploy`. */
  label: string;
  summary: string;
  terms: string[][]; // кожен термін — послідовність слів
  paths: string[];
}

export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function topicOf(r: Record_, shared: boolean): Topic {
  const stem = path.basename(r.rel, '.md');
  const parent = r.rel.split('/').slice(-2, -1)[0] ?? '';
  const name = GENERIC_STEMS.has(stem.toLowerCase()) && parent ? parent : stem;
  const aliases = Array.isArray(r.fields.aliases) ? r.fields.aliases : typeof r.fields.aliases === 'string' ? [r.fields.aliases] : [];
  const paths = Array.isArray(r.fields.paths) ? r.fields.paths : [];
  return {
    file: r.file,
    label: `${shared ? 'спільне: ' : ''}${r.rel.replace(/\.md$/, '')}`,
    summary: typeof r.fields.summary === 'string' ? r.fields.summary : '',
    terms: [name, ...aliases].map(words).filter((t) => t.length > 0 && t.join('').length >= MIN_WORD),
    paths: shared ? [] : paths, // paths спільних записів не прив'язані до конкретного репозиторію
  };
}

export function loadTopics(cwd: string, env: NodeJS.ProcessEnv = process.env): { topics: Topic[]; knowledgeRoots: string[] } | undefined {
  const reg = readRegistry(dataDir(env));
  if (!reg.ok) return undefined;
  const res = resolveProject(cwd, reg.projects);
  if (res.kind !== 'found') return undefined;
  const loc = locate(res.entry, env);
  return {
    topics: [...readRecords(loc.knowledgeDir).map((r) => topicOf(r, false)), ...readRecords(loc.sharedDir).map((r) => topicOf(r, true))],
    knowledgeRoots: [loc.knowledgeDir, loc.sharedDir],
  };
}

/**
 * Слово промпту відповідає слову терміна з урахуванням закінчень: спільний початок — усе слово
 * терміна, крім останньої літери (щонайменше 4), а довжини різняться не більше ніж на 3.
 * «деплою» ~ «деплой», «релізу» ~ «реліз», але «деплойментний» ≁ «деплой».
 */
export function wordMatches(promptWord: string, termWord: string): boolean {
  if (promptWord === termWord) return true;
  if (termWord.length < 4 || promptWord.length < 4 || Math.abs(promptWord.length - termWord.length) > 3) return false;
  let common = 0;
  while (common < promptWord.length && promptWord[common] === termWord[common]) common++;
  return common >= Math.max(4, termWord.length - 1);
}

function termMatches(promptWords: string[], term: string[]): boolean {
  for (let i = 0; i + term.length <= promptWords.length; i++) {
    if (term.every((w, j) => wordMatches(promptWords[i + j] as string, w))) return true;
  }
  return false;
}

export function matchPrompt(prompt: string, topics: Topic[]): Topic[] {
  const pw = words(prompt).filter((w) => w.length >= MIN_WORD);
  return topics
    .map((t) => ({ t, score: t.terms.filter((term) => termMatches(pw, term)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HINTS)
    .map((x) => x.t);
}

/** Мінімальний glob: `**`, `*`, `?`; шляхи з прямими слешами відносно кореня репозиторію. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  // `dir` чи `dir/` охоплює все всередині
  return new RegExp(`^${re}${g.endsWith('/') || !/[*?.]/.test(g.split('/').pop() ?? '') ? '(?:/.*)?' : ''}$`);
}

const line = (t: Topic) => `${t.label}${t.summary ? ` — ${t.summary}` : ''} (${t.file})`;

// ---------- обробники ----------

export function promptHints(input: HookInput, env: NodeJS.ProcessEnv = process.env): HookOutcome {
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!cwd || !prompt) return { kind: 'pass' };
  const loaded = loadTopics(cwd, env);
  if (!loaded) return { kind: 'pass' };
  const file = typeof input.session_id === 'string' ? stateFile(input.session_id, env) : undefined;
  const state = file ? loadState(file) : { hinted: [], read: [] };
  const fresh = matchPrompt(prompt, loaded.topics).filter((t) => !state.read.includes(t.file) && !state.hinted.includes(t.file));
  if (fresh.length === 0) return { kind: 'pass' };
  if (file) saveState(file, { ...state, hinted: [...state.hinted, ...fresh.map((t) => t.file)] });
  return { kind: 'context', text: `Релевантні записи знань (af-core): ${fresh.map(line).join('; ')}` };
}

export function toolHints(input: HookInput, env: NodeJS.ProcessEnv = process.env): HookOutcome {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const ti = input.tool_input as Record<string, unknown> | undefined;
  const target = typeof ti?.file_path === 'string' ? ti.file_path : typeof ti?.notebook_path === 'string' ? ti.notebook_path : undefined;
  if (!EDIT_TOOLS.has(tool) || !cwd || !target || typeof input.session_id !== 'string') return { kind: 'pass' };
  const loaded = loadTopics(cwd, env);
  if (!loaded) return { kind: 'pass' };
  const file = stateFile(input.session_id, env);
  const state = loadState(file);
  const abs = path.resolve(cwd, target);

  // Читання самого запису знань — запам'ятовуємо, щоб більше не підказувати.
  const n = normalizePath(abs);
  if (loaded.knowledgeRoots.some((k) => n.startsWith(normalizePath(k) + '/'))) {
    if (!state.read.includes(abs)) saveState(file, { ...state, read: [...state.read, abs] });
    return { kind: 'pass' };
  }

  const root = findRepoRoot(cwd);
  if (!root) return { kind: 'pass' };
  const relPath = path.relative(root, abs).split(path.sep).join('/');
  if (relPath.startsWith('../')) return { kind: 'pass' };
  const hits = loaded.topics
    .filter((t) => !state.read.includes(t.file) && !state.hinted.includes(t.file))
    .filter((t) => t.paths.some((p) => globToRegExp(p).test(relPath)))
    .slice(0, MAX_HINTS);
  if (hits.length === 0) return { kind: 'pass' };
  saveState(file, { ...state, hinted: [...state.hinted, ...hits.map((t) => t.file)] });
  return { kind: 'context', text: `Файл ${relPath} описано в записах знань (af-core): ${hits.map(line).join('; ')}` };
}

