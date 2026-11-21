import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { namesCheck } from '../checks/names.ts';
import {
  HASH_FILE,
  buildHashFile,
  normalizeName,
  parseNamesList,
  plainMatcher,
  words,
} from '../lib/private-names.ts';
import type { CheckResult } from '../lib/types.ts';
import { makeFakeRepo, type FakeRepo } from './helpers/fake-repo.ts';

// Лише синтетичні назви.
const LIST = '# синтетичний клієнт\nZorblax Labs\nqux_portal\n';
const KEY = 'test-key-0123456789abcdef';
const ENV_KEYS = ['AF_PRIVATE_NAMES_FILE', 'AF_NAMES_KEY_FILE', 'AF_NAMES_KEY', 'CI'] as const;

let repo: FakeRepo;
let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  repo = makeFakeRepo();
  tmp = mkdtempSync(path.join(tmpdir(), 'af-names-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Ніколи не читаємо справжній список і ключ на машині.
  process.env.AF_PRIVATE_NAMES_FILE = path.join(tmp, 'absent.txt');
  process.env.AF_NAMES_KEY_FILE = path.join(tmp, 'absent.key');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  repo.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

function useList(text = LIST): void {
  const file = path.join(tmp, 'names.txt');
  writeFileSync(file, text);
  process.env.AF_PRIVATE_NAMES_FILE = file;
}

function writeHashes(text = LIST): void {
  repo.write(HASH_FILE, buildHashFile(KEY, parseNamesList(text)));
}

const run = (commits?: string[]): CheckResult =>
  namesCheck.run({ root: repo.root, ...(commits ? { commits } : {}) }) as CheckResult;

describe('нормалізація', () => {
  test('варіанти написання дають одне значення', () => {
    for (const v of ['qux_portal', 'qux-portal', 'QuxPortal', 'QUX PORTAL', 'qux.portal']) {
      assert.equal(normalizeName(v), 'quxportal', v);
    }
  });

  test('camelCase і абревіатури розбиваються на слова', () => {
    assert.deepEqual(words('getQuxPortalAPIClient'), ['get', 'qux', 'portal', 'api', 'client']);
  });

  test('збіг вікном сусідніх слів, але не частиною слова', () => {
    const m = plainMatcher(parseNamesList(LIST));
    assert.ok(m.matches('deploy for zorblax-labs is green'));
    assert.ok(m.matches('const quxPortalUrl = 1'));
    assert.ok(!m.matches('zorblaxian labs'));
    assert.ok(!m.matches('portal only'));
  });

  test('закоротка назва — помилка списку', () => {
    assert.equal(parseNamesList('ab\n').errors.length, 1);
  });
});

describe('перевірка names', () => {
  test('без списку й відбитків — пропущено', () => {
    assert.match(run().skipped ?? '', /немає списку назв/);
  });

  test('локальний список знаходить назву й не друкує її', () => {
    useList();
    repo.write('docs/notes.md', 'Перевірка на Qux-Portal.\n');
    const r = run();
    assert.equal(r.errors.length, 1, r.errors.join('\n'));
    assert.match(r.errors[0] ?? '', /^docs\/notes\.md:1: /);
    assert.ok(!r.errors.join('\n').toLowerCase().includes('qux'));
    assert.ok(r.warnings.some((w) => w.includes('немає ключа')));
  });

  test('назва в шляху файлу', () => {
    useList();
    repo.write('docs/zorblax-labs.md', 'текст\n');
    assert.ok(run().errors.some((e) => e.includes('назва в шляху')));
  });

  test('CI: лише відбитки й ключ — знаходить назву', () => {
    process.env.AF_NAMES_KEY = KEY;
    writeHashes();
    repo.write('README.md', 'zorblax labs\n');
    const r = run();
    assert.equal(r.errors.length, 1, r.errors.join('\n'));
  });

  test('CI: відбитки без ключа — помилка, а не тихий пропуск', () => {
    process.env.CI = 'true';
    writeHashes();
    assert.ok(run().errors.some((e) => e.includes('AF_NAMES_KEY')));
  });

  test('відбитки застаріли відносно списку', () => {
    useList();
    process.env.AF_NAMES_KEY = KEY;
    writeHashes('Zorblax Labs\n');
    assert.ok(run().errors.some((e) => e.includes('не відповідає')));
  });

  test('чистий репозиторій з актуальними відбитками проходить', () => {
    useList();
    process.env.AF_NAMES_KEY = KEY;
    writeHashes();
    assert.deepEqual(run().errors, []);
  });

  test('повідомлення комітів', () => {
    useList();
    const git = (...a: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@fixtures.invalid', ...a], { cwd: repo.root, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('commit', '-q', '--allow-empty', '-m', 'feat: storage for qux portal');
    const r = run(['HEAD~1..HEAD']);
    assert.equal(r.errors.length, 1, r.errors.join('\n'));
    assert.match(r.errors[0] ?? '', /^коміт [0-9a-f]+, рядок 1: /);
  });
});
