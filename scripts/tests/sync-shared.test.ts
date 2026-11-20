import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncShared } from '../lib/sync.ts';
import { makeFakeRepo, type FakeRepo } from './helpers/fake-repo.ts';

const CLI = path.join(import.meta.dirname, '..', 'sync-shared.ts');

let repo: FakeRepo;
beforeEach(() => {
  repo = makeFakeRepo();
  repo.write('shared/util.ts', 'export const answer = 42;\n');
  repo.write('shared/sync.json', { files: [{ source: 'util.ts', plugins: ['af-core', 'af-metrics'] }] });
});
afterEach(() => repo.cleanup());

const copy = (plugin: string) => path.join(repo.root, 'plugins', plugin, 'lib', 'shared', 'util.ts');
const check = () => spawnSync(process.execPath, [CLI, '--check', '--root', repo.root], { encoding: 'utf8' });

test('sync створює копії із заголовком, після чого --check проходить', () => {
  const r = syncShared(repo.root, 'write');
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed.length, 2);
  assert.match(readFileSync(copy('af-core'), 'utf8'), /^\/\/ Згенеровано з shared\/util\.ts/);
  assert.equal(check().status, 0);
});

test('--check падає на навмисно зміненій копії', () => {
  syncShared(repo.root, 'write');
  writeFileSync(copy('af-metrics'), readFileSync(copy('af-metrics'), 'utf8').replace('42', '43'));
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugins\/af-metrics\/lib\/shared\/util\.ts: копія відрізняється/);
});

test('--check падає, якщо копії немає', () => {
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /копії немає/);
});

test('--check падає на зайвому файлі без запису в мапі', () => {
  syncShared(repo.root, 'write');
  repo.write('plugins/af-core/lib/shared/stale.ts', 'export {};\n');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale\.ts: немає запису/);
});

test('CRLF у копії не вважається розбіжністю', () => {
  syncShared(repo.root, 'write');
  writeFileSync(copy('af-core'), readFileSync(copy('af-core'), 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(check().status, 0);
});

test('помилки мапи: неіснуюче джерело й плагін', () => {
  repo.write('shared/sync.json', { files: [{ source: 'missing.ts', plugins: ['af-core'] }, { source: 'util.ts', plugins: ['af-ghost'] }] });
  const r = syncShared(repo.root, 'check');
  assert.ok(r.errors.some((e) => e.includes('shared/missing.ts не існує')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.includes('plugins/af-ghost не існує')), r.errors.join('\n'));
});
