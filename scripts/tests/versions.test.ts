import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, test } from 'node:test';
import { versionsCheck } from '../checks/versions.ts';
import type { CheckResult } from '../lib/types.ts';
import { makeFakeRepo, type FakeRepo } from './helpers/fake-repo.ts';

let repo: FakeRepo;
const git = (...a: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@fixtures.invalid', ...a], { cwd: repo.root, encoding: 'utf8' });

beforeEach(() => {
  repo = makeFakeRepo();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('tag', 'base');
});
afterEach(() => repo.cleanup());

const check = (base = 'base') => versionsCheck.run({ root: repo.root, base }) as CheckResult;
const manifest = (version: string) => ({ name: 'af-core', version, description: 'af-core plugin', author: { name: 'Test' }, license: 'MIT' });

test('без змін у плагінах — чисто', () => {
  repo.write('docs/notes.md', 'x\n');
  assert.deepEqual(check().errors, []);
});

test('змінено плагін без підняття версії — помилка', () => {
  repo.write('plugins/af-core/hooks/x.ts', 'export {};\n');
  const r = check();
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0] ?? '', /^plugins\/af-core: змінено 1 файл\(ів\), а версія лишилась 0\.1\.0/);
});

test('змінено плагін і піднято версію — чисто (також після коміту)', () => {
  repo.write('plugins/af-core/README.md', '# af-core\nновий рядок\n');
  repo.write('plugins/af-core/.claude-plugin/plugin.json', manifest('0.1.1'));
  assert.deepEqual(check().errors, []);
  git('commit', '-qam', 'bump');
  assert.deepEqual(check().errors, []);
});

test('зміни лише в tests/ версії не потребують', () => {
  repo.write('plugins/af-core/tests/x.test.ts', 'export {};\n');
  assert.deepEqual(check().errors, []);
});

test('новий плагін — без порівняння', () => {
  repo.write('plugins/af-new/.claude-plugin/plugin.json', { ...manifest('0.1.0'), name: 'af-new' });
  assert.deepEqual(check().errors, []);
});

test('немає бази — попередження, не помилка', () => {
  const r = check('missing-ref');
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0] ?? '', /базу missing-ref не знайдено/);
});
