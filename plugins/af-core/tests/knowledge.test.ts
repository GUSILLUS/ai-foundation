import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  CARD_END,
  CARD_START,
  GEN_START,
  autoMemoryDir,
  buildIndex,
  lintRecords,
  locate,
  parseFrontmatter,
  readRecords,
  registerProject,
  staleness,
  updateCardKnowledge,
} from '../lib/knowledge.ts';

// Лише синтетичні клієнти, проєкти й шляхи.
const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'knowledge.ts');
let tmp: string;
let data: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-knowledge-'));
  data = path.join(tmp, 'data');
  env = { AF_DATA_DIR: data, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function repo(name: string, url?: string): string {
  const dir = path.join(tmp, 'work', name);
  mkdirSync(dir, { recursive: true });
  if (url) write(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  return dir;
}

const record = (fm: string, body = 'Текст.') => `---\n${fm}\n---\n\n${body}\n`;

describe('frontmatter', () => {
  test('рядки, inline-списки й блокові списки', () => {
    const { fields } = parseFrontmatter('---\nsummary: "Деплой"\naliases: [деплой, release]\nsources:\n  - a.yml:1\n  - зі слів\n---\n');
    assert.deepEqual(fields, { summary: 'Деплой', aliases: ['деплой', 'release'], sources: ['a.yml:1', 'зі слів'] });
  });
});

describe('реєстрація', () => {
  test('новий проєкт за remote; повторно — наявний запис без змін', () => {
    const dir = repo('portal', 'git@github.com:acme/portal.git');
    const r1 = registerProject(dir, 'acme', 'portal', env);
    assert.ok(r1.ok && r1.created, JSON.stringify(r1));
    const before = readFileSync(path.join(data, 'projects.json'), 'utf8');
    const r2 = registerProject(dir, 'acme', 'other', env);
    assert.ok(r2.ok && !r2.created);
    assert.match(r2.message, /уже зареєстровано як acme\/portal/);
    assert.equal(readFileSync(path.join(data, 'projects.json'), 'utf8'), before);
  });

  test('без git — за шляхом; додаткові поля реєстру зберігаються', () => {
    write(path.join(data, 'projects.json'), JSON.stringify({ version: 1, note: 'моє', projects: [] }));
    const r = registerProject(repo('local'), 'acme', 'local', env);
    assert.ok(r.ok && r.created);
    const reg = JSON.parse(readFileSync(path.join(data, 'projects.json'), 'utf8'));
    assert.equal(reg.note, 'моє');
    assert.equal(reg.projects[0].paths.length, 1);
  });

  test('зламаний реєстр не перезаписується', () => {
    write(path.join(data, 'projects.json'), '{ broken');
    const r = registerProject(repo('x', 'https://github.com/acme/x'), 'acme', 'x', env);
    assert.equal(r.ok, false);
    assert.equal(readFileSync(path.join(data, 'projects.json'), 'utf8'), '{ broken');
  });

  test('погані імена й _shared відхиляються', () => {
    const dir = repo('x', 'https://github.com/acme/x');
    assert.equal(registerProject(dir, '../evil', 'x', env).ok, false);
    assert.equal(registerProject(dir, 'acme', '_shared', env).ok, false);
  });

  test('та сама назва з іншим remote — відмова', () => {
    registerProject(repo('a', 'https://github.com/acme/a'), 'acme', 'portal', env);
    const r = registerProject(repo('b', 'https://github.com/acme/b'), 'acme', 'portal', env);
    assert.equal(r.ok, false);
  });
});

describe('дерево знань', () => {
  const setup = () => {
    const loc = locate({ client: 'acme', project: 'portal' }, env);
    write(
      path.join(loc.knowledgeDir, 'features', 'checkout', 'overview.md'),
      record('summary: Як працює checkout\ntype: feature\nsources: [src/checkout.ts:1]\nverified: 2026-11-21 abc1234'),
    );
    write(path.join(loc.knowledgeDir, 'features', 'checkout', 'edge-cases.md'), record('summary: Крайові випадки\ntype: edge-case'));
    write(path.join(loc.knowledgeDir, '_inbox', 'c1.md'), record('target: features/checkout/overview.md'));
    write(path.join(loc.sharedDir, 'process', 'deploy.md'), record('summary: Деплой у прод\ntype: process\nsources: [ci.yml:3]'));
    return loc;
  };

  test('записи без службових файлів; перевірка полів', () => {
    const loc = setup();
    const recs = readRecords(loc.knowledgeDir);
    assert.deepEqual(recs.map((r) => r.rel), ['features/checkout/edge-cases.md', 'features/checkout/overview.md']);
    assert.deepEqual(lintRecords(recs), ['features/checkout/edge-cases.md: немає sources']);
  });

  test('_topic.md зберігає ручний абзац, _index.md — дерево з позначкою застарілого', () => {
    const loc = setup();
    const topic = path.join(loc.knowledgeDir, 'features', '_topic.md');
    write(topic, `# features\n\nФічі продукту.\n\n${GEN_START}\nстаре\n<!-- af:generated:end -->\n`);
    buildIndex(loc.knowledgeDir, new Map([['features/checkout/overview.md', { rel: 'features/checkout/overview.md', state: 'stale' as const }]]));
    const t = readFileSync(topic, 'utf8');
    assert.match(t, /Фічі продукту\./);
    assert.match(t, /\[\[features\/checkout\/_topic\]\]/);
    assert.ok(!t.includes('старе'));
    const idx = readFileSync(path.join(loc.knowledgeDir, '_index.md'), 'utf8');
    assert.match(idx, /- \*\*features\/\*\* — Фічі продукту\./);
    assert.match(idx, /\[\[features\/checkout\/overview\]\] — Як працює checkout ⚠ може бути застарілим/);
    assert.ok(existsSync(path.join(loc.knowledgeDir, 'features', 'checkout', '_topic.md')));
  });

  test('розділ «Знання» картки між маркерами; решта картки не змінюється', () => {
    const loc = setup();
    write(loc.cardFile, `# acme/portal\n\n## Стек\n\nTS\n\n## Знання\n\n${CARD_START}\nстаре\n${CARD_END}\n\n## Після\n`);
    assert.ok(updateCardKnowledge(loc));
    const card = readFileSync(loc.cardFile, 'utf8');
    assert.match(card, /## Стек\n\nTS/);
    assert.match(card, /Проєкт:\n- \*\*features\/\*\* \(checkout\)/);
    assert.match(card, /Спільне клієнта:\n- \*\*process\/\*\* \(deploy\)/);
    assert.match(card, /## Після/);
  });

  test('застарівання за git: змінено файл під paths після коміту', () => {
    const dir = repo('git-real');
    const git = (...a: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@fixtures.invalid', '-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    write(path.join(dir, 'src', 'a.ts'), '1\n');
    git('add', '-A');
    git('commit', '-qm', 'one');
    const base = git('rev-parse', '--short', 'HEAD').stdout.trim();
    const k = path.join(tmp, 'k');
    write(path.join(k, 'a.md'), record(`summary: a\ntype: flow\nsources: [x]\npaths: [src/**]\nverified: 2026-11-21 ${base}`));
    write(path.join(k, 'b.md'), record('summary: b\ntype: flow\nsources: [x]'));
    assert.deepEqual(staleness(readRecords(k), dir).map((s) => s.state), ['fresh', 'unknown']);
    write(path.join(dir, 'src', 'a.ts'), '2\n');
    git('commit', '-qam', 'two');
    assert.equal(staleness(readRecords(k), dir)[0]?.state, 'stale');
  });
});

test('auto memory: тека за коренем репозиторію, спільна для worktree', () => {
  const main = repo('portal', 'https://github.com/acme/portal');
  const expected = path.join(tmp, 'claude', 'projects', main.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  assert.equal(autoMemoryDir(path.join(main, 'src'), env), expected);
  const wtGit = path.join(main, '.git', 'worktrees', 'feat');
  write(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(tmp, 'work', 'portal-feat');
  write(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(autoMemoryDir(wt, env), expected);
});

describe('скрипт', () => {
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args, '--cwd', cwd], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000 });

  test('where → register → where → index; код завжди 0', () => {
    const dir = repo('portal', 'https://github.com/acme/portal.git');
    let r = run(dir, 'where');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /projects\.json ще немає/);
    r = run(dir, 'register', '--client', 'acme', '--project', 'portal');
    assert.match(r.stdout, /зареєстровано acme\/portal за remote github\.com\/acme\/portal/);
    r = run(dir, 'where');
    assert.match(r.stdout, /Проєкт: acme\/portal \(знайдено за remote\)/);
    assert.match(r.stdout, /Картка: немає/);
    r = run(dir, 'index');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Картки ще немає/);
  });

  test('невідома команда й без аргументів — текст, код 0', () => {
    const dir = repo('x');
    assert.equal(run(dir, 'nope').status, 0);
    assert.match(run(dir, 'register').stdout, /Потрібні --client і --project/);
  });
});
