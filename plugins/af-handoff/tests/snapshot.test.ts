import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { KEEP_AUTO, SNAPSHOT_LIMIT, extractFacts, handoffPlace, prune, readTail, renderSnapshot, restore, saveSnapshot } from '../lib/snapshot.ts';
import type { HookOutcome } from '../lib/shared/hook-runtime.ts';

// Лише синтетичні дані.
let tmp: string;
let data: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let transcript: string;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const KNOW = () => path.join(data, 'projects', 'acme', '_shared', 'knowledge', 'process', 'deploy.md');
function transcriptLines(): string[] {
  const base = { sessionId: 's1', isSidechain: false };
  const asst = (id: string, content: object[]) => ({ ...base, type: 'assistant', message: { id, role: 'assistant', content } });
  const user = (content: unknown, extra: object = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...extra });
  return [
    user('Перша задача: полагодити checkout', { origin: { kind: 'human' } }),
    user('<command-name>/clear</command-name>'),
    user('службове', { isMeta: true }),
    asst('m1', [
      { type: 'text', text: 'Дивлюсь код.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(repo, 'src', 'a.ts') } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: KNOW() } },
      { type: 'tool_use', id: 't3', name: 'TaskCreate', input: { subject: 'Виправити кошик' } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't3', content: 'Task #7 created successfully' }]),
    asst('m2', [
      { type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: path.join(repo, 'src', 'a.ts') } },
      { type: 'tool_use', id: 't5', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } },
    ]),
    { ...asst('m3', [{ type: 'tool_use', id: 't6', name: 'Edit', input: { file_path: path.join(repo, 'secret-sub.ts') } }]), isSidechain: true },
    user('Друга: додати тест', { origin: { kind: 'human' } }),
    user('нагадування від агента', { origin: { kind: 'task-notification' } }),
    asst('m4', [{ type: 'text', text: 'Готово: src/a.ts:10, тест додано.' }]),
  ].map((r) => JSON.stringify(r));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-handoff-'));
  data = path.join(tmp, 'data');
  repo = path.join(tmp, 'work', 'portal');
  env = { AF_DATA_DIR: data };
  write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/portal.git\n');
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/cart\n');
  write(path.join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }] }));
  transcript = path.join(tmp, 'claude', 's1.jsonl');
  write(transcript, transcriptLines().join('\n') + '\n');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const handoffDir = () => path.join(data, 'projects', 'acme', 'portal', 'handoff');
const text = (o: HookOutcome) => (o.kind === 'context' ? o.text : '');

describe('факти з транскрипту', () => {
  test('промпти людини, задачі, файли, записи знань; без субагентів і службового', () => {
    const f = extractFacts(readTail(transcript), repo, env);
    assert.deepEqual(f.prompts, ['Перша задача: полагодити checkout', 'Друга: додати тест']);
    assert.deepEqual(f.tasks, [{ text: 'Виправити кошик', status: 'in_progress' }]);
    assert.deepEqual(f.changed, ['src/a.ts']);
    assert.deepEqual(f.read, []);
    assert.deepEqual(f.knowledge, ['клієнт: process/deploy']);
    assert.equal(f.lastReply, 'Готово: src/a.ts:10, тест додано.');
  });

  test('TodoWrite має пріоритет над TaskCreate', () => {
    const lines = [...transcriptLines(), JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: 'm9', content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: [{ content: 'Один', status: 'completed' }] } }] } })];
    assert.deepEqual(extractFacts(lines, repo).tasks, [{ text: 'Один', status: 'completed' }]);
  });

  test('знімок у межах ліміту, з гілкою й позначками задач', () => {
    const f = extractFacts(readTail(transcript), repo);
    const s = renderSnapshot(f, { trigger: 'compact', when: new Date('2026-11-23T10:00:00Z'), label: 'acme/portal', branch: 'feat/cart', candidates: 2 });
    assert.match(s, /^# Знімок сесії перед стисненням контексту — 2026-11-23 10:00 UTC/);
    assert.match(s, /гілка: feat\/cart/);
    assert.match(s, /- \[~\] Виправити кошик/);
    assert.match(s, /2 у _inbox/);
    const long = renderSnapshot({ ...f, lastReply: 'x'.repeat(10_000), changed: Array.from({ length: 200 }, (_, i) => `f${i}.ts`) }, { trigger: 'clear', when: new Date(), label: 'x', candidates: 0 });
    assert.ok(long.length <= SNAPSHOT_LIMIT + 1);
    assert.match(long, /… ще 180/);
  });

  test('хвіст великого файлу — цілими рядками', () => {
    const lines = readTail(transcript, 200);
    assert.ok(lines.length > 0);
    for (const l of lines) JSON.parse(l);
  });
});

describe('збереження й відновлення', () => {
  const input = (extra: object) => ({ hook_event_name: 'PreCompact', cwd: repo, session_id: 's1-session', transcript_path: transcript, ...extra });

  test('PreCompact → знімок у теці проєкту → SessionStart(compact) повертає його', () => {
    assert.equal(saveSnapshot(input({}), 'compact', env, new Date()).kind, 'pass');
    const files = readdirSync(handoffDir());
    assert.equal(files.length, 1);
    assert.match(files[0] ?? '', /^\d{8}-\d{6}-compact-s1-sessi\.md$/);
    const o = restore({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo, session_id: 's1-session' }, env);
    assert.match(text(o), /перед стисненням[\s\S]*# Знімок сесії/);
  });

  test('чужа сесія не отримує compact-знімок', () => {
    saveSnapshot(input({}), 'compact', env);
    assert.equal(restore({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo, session_id: 'other' }, env).kind, 'pass');
  });

  test('clear — лише вказівка на знімок, і лише свіжий', () => {
    saveSnapshot(input({ hook_event_name: 'SessionEnd' }), 'clear', env);
    const o = restore({ hook_event_name: 'SessionStart', source: 'clear', cwd: repo, session_id: 'new' }, env);
    assert.match(text(o), /^Є знімок попередньої сесії перед \/clear: .*-clear-.*\.md/);
    assert.ok(!text(o).includes('# Знімок'));
    const later = new Date(Date.now() + 3 * 3_600_000);
    assert.equal(restore({ hook_event_name: 'SessionStart', source: 'clear', cwd: repo, session_id: 'new' }, env, later).kind, 'pass');
  });

  test('startup — вказівка на ручний handoff за тиждень', () => {
    write(path.join(handoffDir(), '20261120-100000-manual.md'), '# Handoff');
    assert.match(text(restore({ hook_event_name: 'SessionStart', source: 'startup', cwd: repo }, env)), /Останній handoff проєкту: .*manual\.md/);
    const old = path.join(handoffDir(), '20261120-100000-manual.md');
    const t = new Date(Date.now() - 8 * 24 * 3_600_000);
    utimesSync(old, t, t);
    assert.equal(restore({ hook_event_name: 'SessionStart', source: 'startup', cwd: repo }, env).kind, 'pass');
  });

  test('незареєстрована тека — окремо від клієнтів', () => {
    const other = path.join(tmp, 'work', 'other');
    mkdirSync(other, { recursive: true });
    const p = handoffPlace(other, env);
    assert.equal(p.label, 'незареєстрована тека');
    assert.ok(p.dir.startsWith(path.join(data, 'unregistered')));
  });

  test('без transcript_path — деградація', () => {
    assert.equal(saveSnapshot({ hook_event_name: 'PreCompact', cwd: repo }, 'compact', env).kind, 'degrade');
  });

  test('ротація: лишаються останні автоматичні, ручні не чіпаються', () => {
    mkdirSync(handoffDir(), { recursive: true });
    for (let i = 0; i < KEEP_AUTO + 5; i++) write(path.join(handoffDir(), `202611${String(i).padStart(2, '0')}-000000-compact-x.md`), '');
    write(path.join(handoffDir(), '20261101-000000-manual.md'), '');
    prune(handoffDir());
    const left = readdirSync(handoffDir());
    assert.equal(left.filter((x) => x.includes('-compact-')).length, KEEP_AUTO);
    assert.ok(left.includes('20261101-000000-manual.md'));
  });
});

describe('процеси', () => {
  test('хук PreCompact зберігає знімок, код 0', () => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hooks', 'pre-compact.ts')], {
      input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: repo, session_id: 'p1', transcript_path: transcript }),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 20_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(handoffDir()));
  });

  test('скрипт snapshot друкує знімок за id сесії', () => {
    const config = path.join(tmp, 'cfg');
    write(path.join(config, 'projects', 'any', 's1.jsonl'), readFileSync(transcript, 'utf8'));
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'handoff.ts'), 'snapshot', '--session', 's1', '--cwd', repo], {
      encoding: 'utf8',
      env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: config },
      timeout: 20_000,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /# Знімок сесії на вимогу/);
    assert.match(r.stdout, /Проєкт: acme\/portal · гілка: feat\/cart/);
  });
});
