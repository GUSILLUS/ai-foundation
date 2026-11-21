import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DENY_REASON, isEnvFile } from '../lib/env-guard.ts';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'env-guard.ts');
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

/** Запуск хука так, як його запускає Claude Code: node + скрипт, вхід у stdin. */
function runHook(stdin: string): { code: number | null; out: Record<string, any> | null; raw: string } {
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', timeout: 10_000 });
  const raw = r.stdout.trim();
  return { code: r.status, out: raw ? JSON.parse(raw) : null, raw: raw + r.stderr };
}

const decision = (out: Record<string, any> | null) => out?.hookSpecificOutput?.permissionDecision;

describe('env-guard: звичайний шлях', () => {
  for (const name of ['read-normal', 'read-env-example', 'bash-command']) {
    test(`${name} — дозволено без виводу`, () => {
      const r = runHook(fixture(`${name}.json`));
      assert.equal(r.code, 0, r.raw);
      assert.equal(r.out, null, r.raw);
    });
  }
});

describe('env-guard: блокування', () => {
  for (const name of ['read-env', 'read-env-local-relative', 'edit-env-windows', 'write-production-env']) {
    test(`${name} — deny з причиною`, () => {
      const r = runHook(fixture(`${name}.json`));
      assert.equal(r.code, 0, r.raw);
      assert.equal(decision(r.out), 'deny', r.raw);
      assert.equal(r.out?.hookSpecificOutput?.permissionDecisionReason, `[af-controls/env-guard] ${DENY_REASON}`);
    });
  }
});

describe('env-guard: деградація — код 0, дія не блокується, користувач бачить повідомлення', () => {
  const cases: Array<[string, string]> = [
    ['зламаний JSON', fixture('broken.json.txt')],
    ['порожній вхід', ''],
    ['немає tool_name', fixture('no-tool-name.json')],
    ['немає шляху до файлу', fixture('read-no-path.json')],
  ];
  for (const [label, stdin] of cases) {
    test(label, () => {
      const r = runHook(stdin);
      assert.equal(r.code, 0, r.raw);
      assert.equal(decision(r.out), undefined, r.raw);
      assert.match(r.out?.systemMessage ?? '', /^\[af-controls\/env-guard\] перевірку пропущено/, r.raw);
    });
  }
});

test('isEnvFile: межові випадки імен', () => {
  for (const f of ['.env', '.env.local', '.env.production', 'app/.ENV', 'prod.env', '.envrc', 'C:\\x\\.env.test']) assert.equal(isEnvFile(f), true, f);
  for (const f of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'env.ts', 'environment.md', '.env-notes', 'src/.env/readme.md']) {
    assert.equal(isEnvFile(f), false, f);
  }
});
