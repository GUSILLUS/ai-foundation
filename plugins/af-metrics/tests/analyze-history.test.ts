import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInventory, layoutOf } from '../lib/inventory.ts';
import { findTranscriptFiles } from '../lib/transcripts.ts';

const CONFIG = path.join(import.meta.dirname, 'fixtures', 'claude-config');
const PROJECTS = path.join(CONFIG, 'projects');
const CLI = path.join(import.meta.dirname, '..', 'scripts', 'analyze-history.ts');

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('інвентаризація', async () => {
  const files = findTranscriptFiles(CONFIG);
  const inv = await buildInventory(files, PROJECTS, 'flag');

  test('знаходить і основний транскрипт, і транскрипт субагента', () => {
    assert.equal(inv.files.count, 2);
    assert.deepEqual(inv.files.layouts, {
      '<project>/<session>.jsonl': 1,
      '<project>/<session>/subagents/agent-<id>.jsonl': 1,
    });
  });

  test('рахує рядки, включно зі зламаними й не-об’єктами', () => {
    assert.deepEqual(inv.lines, { total: 14, records: 11, empty: 1, invalidJson: 1, nonObject: 1 });
    assert.equal(inv.sessions, 1);
    assert.deepEqual(inv.dateRange, { first: '2026-11-01T10:00:00.000Z', last: '2026-11-02T09:00:00.000Z' });
  });

  test('описує типи записів і ключі, зокрема невідомий тип', () => {
    assert.equal(inv.types.assistant?.count, 4);
    assert.equal(inv.types['future-thing']?.count, 1);
    for (const k of ['message.usage.output_tokens', 'message.usage.output_tokens_details.thinking_tokens', 'message.content[].type', 'requestId']) {
      assert.ok(inv.types.assistant?.keys.includes(k), k);
    }
    assert.ok(inv.types.user?.keys.includes('permissionDecision.decision'));
  });

  test('не заглядає у вміст інструментів і ховає динамічні ключі', () => {
    const keys = Object.values(inv.types).flatMap((t) => t.keys);
    assert.ok(!keys.some((k) => k.startsWith('message.content[].input.')), 'ключі з input');
    assert.ok(keys.includes('snapshot.trackedFileBackups.<dynamic>'));
    assert.ok(!keys.some((k) => k.includes('src/a.ts')));
    assert.ok(inv.types['cost-state']?.keys.includes('modelUsage.claude-opus-5-5.costUSD'));
  });

  test('рахує лише значення полів-переліків', () => {
    assert.deepEqual(inv.values['permissionDecision.decision'], { accept: 1, reject: 1 });
    assert.deepEqual(inv.values['permissionDecision.source'], { config: 1, user_reject: 1 });
    assert.deepEqual(inv.values.version, { '2.1.300': 6, '2.1.301': 1 });
    assert.equal(inv.values['message.content[].type']?.tool_use, 2);
    assert.equal(inv.values['message.model']?.['claude-haiku-5-5'], 1);
  });

  test('у звіті немає ні шляхів, ні вмісту, ні назви проєкту', () => {
    const text = JSON.stringify(inv);
    for (const banned of ['/fixtures/project-a', '<fixture>', '-fixtures-project-a', 'src/a.ts', 'main']) {
      assert.ok(!text.includes(banned), banned);
    }
  });
});

test('layoutOf узагальнює імена', () => {
  assert.equal(layoutOf('-home-x/12345678-1234-4234-8234-123456789abc.jsonl'), '<project>/<session>.jsonl');
  assert.equal(layoutOf('D--Work-client/abc/subagents/agent-a1b2c3d4e5.jsonl'), '<project>/abc/subagents/agent-<id>.jsonl');
  assert.equal(layoutOf('p/назва з пробілами.jsonl'), '<project>/<name>.jsonl');
});

describe('CLI', () => {
  test('--inventory пише звіт у --out і завершується з кодом 0', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'af-metrics-'));
    tmp.push(out);
    const r = spawnSync(process.execPath, [CLI, '--inventory', '--config-dir', CONFIG, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [file] = readdirSync(out);
    assert.match(file ?? '', /^inventory-\d{4}-\d{2}-\d{2}\.json$/);
    const saved = JSON.parse(readFileSync(path.join(out, file!), 'utf8'));
    assert.equal(saved.files.count, 2);
    assert.match(r.stdout, /Файлів: 2/);
  });

  test('без --inventory — підказка й код 2', () => {
    const r = spawnSync(process.execPath, [CLI, '--config-dir', CONFIG], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--inventory/);
  });

  test('неіснуюча тека Claude Code — код 1 без шляху у виводі', () => {
    const missing = path.join(tmpdir(), 'af-no-such-config-dir');
    const r = spawnSync(process.execPath, [CLI, '--inventory', '--config-dir', missing], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes(missing));
  });
});
