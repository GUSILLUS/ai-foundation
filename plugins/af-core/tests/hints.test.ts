import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { globToRegExp, matchPrompt, promptHints, stateFile, toolHints, wordMatches, type Topic } from '../lib/hints.ts';
import type { HookOutcome } from '../lib/shared/hook-runtime.ts';

// Лише синтетичні клієнти, проєкти, шляхи й теми.
let tmp: string;
let data: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const record = (fm: string) => `---\n${fm}\n---\n\nТекст.\n`;
const knowledge = () => path.join(data, 'projects', 'acme', 'portal', 'knowledge');
const shared = () => path.join(data, 'projects', 'acme', '_shared', 'knowledge');
const text = (o: HookOutcome) => (o.kind === 'context' ? o.text : '');

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-hints-'));
  data = path.join(tmp, 'data');
  repo = path.join(tmp, 'work', 'portal');
  env = { AF_DATA_DIR: data, CLAUDE_PLUGIN_DATA: path.join(tmp, 'plugin-data') };
  write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/portal.git\n');
  write(path.join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }] }));
  write(path.join(shared(), 'process', 'deploy.md'), record('summary: Деплой у прод\ntype: process\naliases: [деплой, викатка, release]\npaths: [ci/**]'));
  write(path.join(knowledge(), 'features', 'checkout', 'overview.md'), record('summary: Як працює checkout\ntype: feature\naliases: [оплата]\npaths: [src/checkout/**]'));
  write(path.join(knowledge(), 'features', 'checkout', 'edge-cases.md'), record('summary: Крайові випадки checkout\ntype: edge-case\npaths: [src/checkout/cart.ts]'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const prompt = (p: string, session = 's1') => promptHints({ hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: p, session_id: session }, env);
const tool = (file: string, name = 'Read', session = 's1') =>
  toolHints({ hook_event_name: 'PostToolUse', cwd: repo, session_id: session, tool_name: name, tool_input: { file_path: file } }, env);

describe('збіг слів', () => {
  test('закінчення українських слів', () => {
    assert.ok(wordMatches('деплою', 'деплой'));
    assert.ok(wordMatches('релізу', 'реліз'));
    assert.ok(!wordMatches('деплойментний', 'деплой'));
    assert.ok(!wordMatches('dep', 'deploy'));
  });

  test('найбільше збігів — першим, не більше трьох', () => {
    const t = (label: string, ...terms: string[]): Topic => ({ file: label, label, summary: '', terms: terms.map((x) => x.split(' ')), paths: [] });
    const out = matchPrompt('як працює деплой і release', [t('a', 'checkout'), t('b', 'деплой', 'release'), t('c', 'деплой')]);
    assert.deepEqual(out.map((x) => x.label), ['b', 'c']);
  });

  test('glob', () => {
    assert.ok(globToRegExp('src/checkout/**').test('src/checkout/a/b.ts'));
    assert.ok(globToRegExp('src/checkout').test('src/checkout/a.ts'));
    assert.ok(globToRegExp('**/*.yml').test('ci/deploy.yml'));
    assert.ok(!globToRegExp('src/checkout/cart.ts').test('src/checkout/cart.tsx'));
  });
});

describe('UserPromptSubmit', () => {
  test('за aliases і назвою теки фічі; спільні записи теж', () => {
    const o = prompt('Як у нас проходить деплою на прод?');
    assert.match(text(o), /спільне: process\/deploy — Деплой у прод/);
    assert.ok(text(o).includes(path.join(shared(), 'process', 'deploy.md')));
    assert.match(text(prompt('повертаємось до checkout', 's2')), /features\/checkout\/overview/);
  });

  test('без збігу — нічого; повторно в сесії — нічого', () => {
    assert.equal(prompt('поясни git rebase').kind, 'pass');
    assert.equal(prompt('деплой').kind, 'context');
    assert.equal(prompt('деплой ще раз').kind, 'pass');
  });

  test('незареєстрована тека — нічого', () => {
    const o = promptHints({ hook_event_name: 'UserPromptSubmit', cwd: tmp, prompt: 'деплой', session_id: 's' }, env);
    assert.equal(o.kind, 'pass');
  });
});

describe('PostToolUse', () => {
  test('файл під paths — підказка обох записів фічі', () => {
    const o = tool(path.join(repo, 'src', 'checkout', 'cart.ts'), 'Edit');
    assert.match(text(o), /^Файл src\/checkout\/cart\.ts описано в записах знань/);
    assert.match(text(o), /features\/checkout\/edge-cases/);
    assert.match(text(o), /features\/checkout\/overview/);
  });

  test('прочитаний запис більше не підказується', () => {
    assert.equal(tool(path.join(knowledge(), 'features', 'checkout', 'overview.md')).kind, 'pass');
    const o = tool(path.join(repo, 'src', 'checkout', 'pay.ts'));
    assert.ok(!text(o).includes('overview'));
    assert.equal(prompt('оплата').kind, 'pass');
  });

  test('paths спільних записів не застосовуються до репозиторію', () => {
    assert.equal(tool(path.join(repo, 'ci', 'deploy.yml')).kind, 'pass');
  });

  test('інші інструменти й файли поза репозиторієм — нічого', () => {
    assert.equal(tool(path.join(repo, 'src', 'checkout', 'cart.ts'), 'Bash').kind, 'pass');
    assert.equal(tool(path.join(tmp, 'elsewhere.ts')).kind, 'pass');
  });
});

describe('хуки як процеси', () => {
  const hook = (name: string, input: object, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hooks', name)], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env, ...extra },
      timeout: 20_000,
    });

  test('UserPromptSubmit повертає additionalContext', () => {
    const r = hook('prompt-hints.ts', { hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: 'деплой', session_id: 'p1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  });

  test('SessionStart compact скидає стан підказок', () => {
    prompt('деплой', 'p2');
    assert.ok(existsSync(stateFile('p2', env)));
    const r = hook('session-start.ts', { hook_event_name: 'SessionStart', source: 'compact', cwd: repo, session_id: 'p2' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(stateFile('p2', env)));
  });

  test('зламаний вхід — деградація, код 0', () => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hooks', 'tool-hints.ts')], { input: '{', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /^\[af-core\/tool-hints\]/);
  });
});
