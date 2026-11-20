import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSessions, toolLabel } from '../lib/metrics.ts';
import { buildReport, isoWeek } from '../lib/report.ts';
import { findTranscriptFiles } from '../lib/transcripts.ts';

const CONFIG = path.join(import.meta.dirname, 'fixtures', 'claude-config-metrics');
const PROJECTS = path.join(CONFIG, 'projects');
const CLI = path.join(import.meta.dirname, '..', 'scripts', 'analyze-history.ts');
const S2 = '00000000-0000-4000-8000-0000000000b2';
const S3 = '00000000-0000-4000-8000-0000000000b3';

describe('метрики сесії (синтетична сесія з форком)', async () => {
  const sessions = await collectSessions(findTranscriptFiles(CONFIG), PROJECTS);
  const s2 = sessions.find((s) => s.sessionId === S2)!;
  const s3 = sessions.find((s) => s.sessionId === S3)!;

  test('копії записів у форку не рахуються вдруге', () => {
    assert.equal(sessions.length, 2);
    assert.equal(s3.humanPrompts, 1);
    assert.equal(s3.responses, 0);
    assert.deepEqual(s3.toolCalls, {});
  });

  test('промпти людини — за origin.kind, а без нього за promptSource; службові не рахуються', () => {
    assert.equal(s2.humanPrompts, 3);
    assert.deepEqual(s2.otherPrompts, { peer: 1 });
    assert.equal(s2.turns, 3);
  });

  test('токени — по унікальному message.id; synthetic іде в помилки API', () => {
    assert.equal(s2.responses, 4);
    assert.equal(s2.subagentResponses, 1);
    assert.deepEqual(s2.tokensByModel['claude-opus-5-5'], { input: 40, output: 400, cacheRead: 4000, cacheCreation: 400, thinking: 20 });
    assert.equal(s2.tokensByModel['claude-haiku-5-5']?.output, 7);
    assert.equal(s2.tokensByModel['<synthetic>'], undefined);
    assert.deepEqual(s2.apiErrors, { rate_limit: 1 });
  });

  test('інструменти, скіли, субагенти, MCP за сервером; api-request-blob ігнорується', () => {
    assert.deepEqual(s2.toolCalls, { Edit: 4, Write: 1, Bash: 1, Skill: 1, Agent: 1, mcp__jira: 1 });
    assert.deepEqual(s2.skills, { 'demo-skill': 1 });
    assert.deepEqual(s2.subagents, { Explore: 1 });
    assert.deepEqual(s2.toolErrors, { Bash: 1, Edit: 1 });
  });

  test('відмови з причиною, хуки, стиснення, активний час, вартість', () => {
    assert.deepEqual(s2.rejections, { 'config / classifier:auto-mode / git_destructive': 1 });
    assert.equal(s2.hookErrors, 1);
    assert.deepEqual(s2.compactions, { auto: 1 });
    assert.equal(s2.activeMs, 180_000);
    assert.equal(s2.costUSD, 0.35);
    assert.equal(s3.costUSD, null);
  });

  test('раунди правок: два ходи поспіль із правками, відхилена правка не рахується', () => {
    assert.equal(s2.editTurns, 2);
    assert.equal(s2.editRounds, 1);
    assert.equal(s2.filesEdited, 2);
    assert.equal(s2.filesReedited, 1);
  });

  test('мітка проєкту — остання частина cwd', () => {
    assert.equal(s2.project, 'project-b');
    assert.equal(s2.entrypoint, 'cli');
  });

  test('звіт: агрегати, тижні, анонімізація', () => {
    const r = buildReport(sessions, { analyzer: 'test' });
    assert.equal(r.totals.sessions, 2);
    assert.equal(r.totals.humanPrompts, 4);
    assert.equal(r.totals.editRoundRate, 0.5);
    assert.equal(r.totals.sessionsWithoutCost, 1);
    assert.deepEqual(Object.keys(r.byWeek), ['2026-W45']);
    assert.deepEqual(Object.keys(r.byProject), ['project-b']);
    const anon = buildReport(sessions, { analyzer: 'test', anonymize: true });
    assert.deepEqual(Object.keys(anon.byProject), ['project-1']);
    assert.ok(!JSON.stringify(anon).includes('project-b'));
  });

  test('у звіті немає шляхів і вмісту', () => {
    const text = JSON.stringify(buildReport(sessions, { analyzer: 'test' }));
    for (const banned of ['/fixtures/', 'a.ts', '<fixture>']) assert.ok(!text.includes(banned), banned);
  });
});

test('isoWeek і toolLabel', () => {
  assert.equal(isoWeek('2026-11-03T10:00:00.000Z'), '2026-W45');
  assert.equal(isoWeek('2026-01-01T00:00:00.000Z'), '2026-W01');
  assert.equal(isoWeek('2027-01-01T00:00:00.000Z'), '2026-W53');
  assert.equal(toolLabel('mcp__plugin_af-x_db__query'), 'mcp__plugin_af-x_db');
  assert.equal(toolLabel('Read'), 'Read');
});

describe('CLI метрик', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'af-baseline-'));
  after(() => rmSync(out, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, '--config-dir', CONFIG, '--out', out, ...args], { encoding: 'utf8' });

  test('пише baseline-<дата>.json і .md', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const files = readdirSync(out).filter((f) => f.startsWith('baseline-')).sort();
    assert.equal(files.length, 2);
    const md = readFileSync(path.join(out, files.find((f) => f.endsWith('.md'))!), 'utf8');
    assert.match(md, /Раунди правок/);
    assert.match(md, /project-b/);
  });

  test('--since відкидає ранні сесії, --anonymize ховає назви', () => {
    const r = run('--since', '2026-11-05', '--anonymize');
    assert.equal(r.status, 0, r.stderr);
    const json = readdirSync(out).find((f) => f.endsWith('-anon.json'))!;
    const report = JSON.parse(readFileSync(path.join(out, json), 'utf8'));
    assert.equal(report.totals.sessions, 1);
    assert.deepEqual(Object.keys(report.byProject), ['project-1']);
  });

  test('некоректна --since — код 2', () => {
    assert.equal(run('--since', 'вчора').status, 2);
  });
});
