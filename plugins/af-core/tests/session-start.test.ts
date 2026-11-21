import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  CARD_LIMIT,
  SESSION_START_LIMIT,
  buildSessionContext,
  normalizePath,
  normalizeRemote,
  readRemotes,
  truncateCard,
} from '../lib/session-context.ts';

// Лише синтетичні клієнти, проєкти й шляхи.
const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'session-start.ts');
const RULES = '# Правила\n\n1. Низький шум.';

let tmp: string;
let data: string;
let work: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-core-'));
  data = path.join(tmp, 'data');
  work = path.join(tmp, 'work');
  mkdirSync(data, { recursive: true });
  mkdirSync(work, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(file: string, content: string | object): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Репозиторій без git: лише .git/config з remote. */
function makeRepo(name: string, url: string): string {
  const dir = path.join(work, name);
  write(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}

function registry(projects: object[]): void {
  write(path.join(data, 'projects.json'), { version: 1, projects });
}

const env = () => ({ AF_DATA_DIR: data });
const build = (cwd: string | undefined) =>
  buildSessionContext({ hook_event_name: 'SessionStart', source: 'startup', ...(cwd ? { cwd } : {}) }, { rules: RULES, env: env() });
const text = (o: ReturnType<typeof build>) => (o.kind === 'context' ? o.text : '');
const notice = (o: ReturnType<typeof build>) => (o.kind === 'context' ? o.notice : undefined);

describe('remote і шляхи', () => {
  test('нормалізація remote', () => {
    for (const url of [
      'git@github.com:Acme/Portal.git',
      'https://github.com/acme/portal',
      'https://user@github.com/acme/portal.git/',
      'ssh://git@github.com:22/acme/portal.git',
    ]) {
      assert.equal(normalizeRemote(url), 'github.com/acme/portal', url);
    }
  });

  test('origin першим серед remote', () => {
    const cfg = '[remote "upstream"]\n\turl = https://example.com/u/x\n[remote "origin"]\n\turl = https://example.com/o/x\n[branch "main"]\n\turl = nope\n';
    assert.deepEqual(readRemotes(cfg), ['https://example.com/o/x', 'https://example.com/u/x']);
  });

  test('шляхи Windows порівнюються без регістру', () => {
    assert.equal(normalizePath('C:\\Work\\Portal\\', 'win32'), 'c:/work/portal');
    assert.equal(normalizePath('/work/Portal/', 'linux'), '/work/Portal');
  });
});

describe('контекст на старті сесії', () => {
  test('зареєстрований проєкт за remote — правила + картка + шлях до знань', () => {
    const repo = makeRepo('portal', 'git@github.com:acme/portal.git');
    registry([{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }]);
    write(path.join(data, 'projects', 'acme', 'portal', 'context.md'), '# acme/portal\n\nСтек: синтетичний.');
    const o = build(path.join(repo, 'src', 'deep'));
    assert.equal(o.kind, 'context');
    assert.match(text(o), /^# Правила/);
    assert.match(text(o), /# Проєкт acme\/portal\n\n# acme\/portal\n\nСтек: синтетичний\./);
    assert.ok(text(o).includes(path.join(data, 'projects', 'acme', '_shared', 'knowledge')));
    assert.equal(notice(o), undefined);
  });

  test('remotes рядком замість масиву (PowerShell 5.1)', () => {
    const repo = makeRepo('portal', 'https://github.com/acme/portal.git');
    registry([{ client: 'acme', project: 'portal', remotes: 'https://github.com/acme/portal.git' }]);
    write(path.join(data, 'projects', 'acme', 'portal', 'context.md'), 'картка');
    assert.match(text(build(repo)), /# Проєкт acme\/portal/);
  });

  test('worktree знаходить спільний конфіг через commondir', () => {
    const main = makeRepo('portal', 'https://github.com/acme/portal.git');
    const wtGit = path.join(main, '.git', 'worktrees', 'feat');
    write(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(work, 'portal-feat');
    write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    registry([{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }]);
    write(path.join(data, 'projects', 'acme', 'portal', 'context.md'), 'картка');
    assert.match(text(build(wt)), /# Проєкт acme\/portal/);
  });

  test('за шляхом, якщо remote немає', () => {
    const dir = path.join(work, 'no-git');
    mkdirSync(dir);
    registry([{ client: 'acme', project: 'local', paths: [dir] }]);
    write(path.join(data, 'projects', 'acme', 'local', 'context.md'), 'картка');
    assert.match(text(build(dir)), /# Проєкт acme\/local/);
  });

  test('незареєстрована тека — лише правила й підказка, без картки іншого проєкту', () => {
    const repo = makeRepo('other', 'https://github.com/zeta/other');
    registry([{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }]);
    write(path.join(data, 'projects', 'acme', 'portal', 'context.md'), 'СЕКРЕТНА КАРТКА');
    const o = build(repo);
    assert.match(text(o), /не зареєстрована/);
    assert.ok(!text(o).includes('СЕКРЕТНА'));
    assert.equal(notice(o), undefined);
  });

  test('реєстру немає — правила й підказка без попередження', () => {
    const o = build(makeRepo('x', 'https://github.com/acme/x'));
    assert.match(text(o), /реєстру проєктів ще немає/);
    assert.equal(notice(o), undefined);
  });

  test('зламаний реєстр — правила й попередження користувачу', () => {
    write(path.join(data, 'projects.json'), '{ broken');
    const o = build(work);
    assert.equal(text(o), RULES);
    assert.match(notice(o) ?? '', /невалідний JSON/);
  });

  test('небезпечні імена в реєстрі відхиляються', () => {
    registry([{ client: '../evil', project: 'p', paths: [work] }]);
    assert.match(notice(build(work)) ?? '', /slug/);
  });

  test('неоднозначний remote — без картки', () => {
    const repo = makeRepo('portal', 'https://github.com/acme/portal');
    registry([
      { client: 'acme', project: 'a', remotes: ['github.com/acme/portal'] },
      { client: 'beta', project: 'b', remotes: ['github.com/acme/portal'] },
    ]);
    const o = build(repo);
    assert.equal(text(o), RULES);
    assert.match(notice(o) ?? '', /кільком проєктам/);
  });

  test('проєкт без картки — попередження', () => {
    const repo = makeRepo('portal', 'https://github.com/acme/portal');
    registry([{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }]);
    assert.match(notice(build(repo)) ?? '', /картки проєкту acme\/portal ще немає/);
  });

  test('довга картка обрізається по розділу, загальний ліміт тримається', () => {
    const repo = makeRepo('portal', 'https://github.com/acme/portal');
    registry([{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }]);
    const card = `# acme/portal\n\n## Перший\n${'а'.repeat(4_000)}\n\n## Другий\n${'б'.repeat(4_000)}\n`;
    write(path.join(data, 'projects', 'acme', 'portal', 'context.md'), card);
    const o = build(repo);
    assert.ok(text(o).includes('## Перший'));
    assert.ok(!text(o).includes('## Другий'));
    assert.match(text(o), /Картку обрізано/);
    assert.match(notice(o) ?? '', /обрізано/);
    assert.ok(text(o).length <= SESSION_START_LIMIT);
  });

  test('truncateCard без розділів ріже по ліміту', () => {
    const r = truncateCard('x'.repeat(CARD_LIMIT + 10));
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, CARD_LIMIT);
  });
});

describe('хук як процес', () => {
  const run = (stdin: string) =>
    spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, AF_DATA_DIR: data }, timeout: 20_000 });

  test('справжні глобальні правила й JSON-вихід SessionStart, код 0', () => {
    const r = run(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: work }));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /AI Foundation — правила роботи/);
  });

  test('зламаний вхід — деградація, код 0', () => {
    const r = run('not json');
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /^\[af-core\/session-start\] перевірку пропущено/);
  });
});
