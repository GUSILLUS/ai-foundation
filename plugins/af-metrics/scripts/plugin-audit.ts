#!/usr/bin/env node
/**
 * Аудит встановлених плагінів, особистих скілів і MCP-серверів (af-metrics, скіл plugin-audit).
 * Лише читає; нічого не видаляє. Звіт — агрегати й назви, без вмісту транскриптів і конфігів.
 *
 *   (без прапорців)       вікно — останні 30 днів
 *   --days <n>            вікно — останні n днів
 *   --since <YYYY-MM-DD>  вікно — з дати
 *   --all                 усі наявні транскрипти
 *   --config-dir <dir>    тека Claude Code (за замовчуванням CLAUDE_CONFIG_DIR або ~/.claude)
 *   --claude-json <file>  ~/.claude.json з MCP-серверами (за замовчуванням поруч з домашньою текою)
 *   --out <dir>           куди писати звіт (за замовчуванням ~/ai-foundation-data/metrics)
 *   --print               лише вивести markdown, без запису файлів
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildAudit, formatAudit } from '../lib/audit.ts';
import { collectInstalled } from '../lib/audit-inventory.ts';
import { collectUsage } from '../lib/audit-usage.ts';
import { dataDir, findTranscriptFiles, resolveConfigDir } from '../lib/transcripts.ts';

const DEFAULT_DAYS = 30;

const { values } = parseArgs({
  options: {
    days: { type: 'string' },
    since: { type: 'string' },
    all: { type: 'boolean' },
    'config-dir': { type: 'string' },
    'claude-json': { type: 'string' },
    out: { type: 'string' },
    print: { type: 'boolean' },
  },
});

const now = new Date();
let since: string | null;
if ([values.all, values.since !== undefined, values.days !== undefined].filter(Boolean).length > 1) {
  fail('--all, --since і --days — взаємовиключні');
}
if (values.all) since = null;
else if (values.since !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since) || Number.isNaN(Date.parse(values.since))) fail('--since очікує дату у форматі YYYY-MM-DD');
  since = new Date(values.since).toISOString();
} else {
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
  if (!Number.isInteger(days) || days <= 0) fail('--days очікує ціле число більше 0');
  since = new Date(now.getTime() - days * 86_400_000).toISOString();
}

const config = resolveConfigDir(values['config-dir']);
const claudeJson = path.resolve(values['claude-json'] ?? (config.source === 'default' ? path.join(os.homedir(), '.claude.json') : path.join(config.dir, '.claude.json')));

const installed = collectInstalled({ configDir: config.dir, claudeJson });
const files = findTranscriptFiles(config.dir);
const usage = await collectUsage(files, path.join(config.dir, 'projects'), since ?? undefined);
const report = buildAudit(installed, usage, { since, now, analyzer: analyzerName() });
const md = formatAudit(report);

if (values.print) {
  process.stdout.write(md);
} else {
  const outDir = path.resolve(values.out ?? path.join(dataDir(), 'metrics'));
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `plugin-audit-${now.toISOString().slice(0, 10)}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${base}.md`, md);
  const s = report.summary;
  console.log(`Вікно: ${report.window.days} дн., сесій: ${report.window.sessions}. Елементів: ${report.units.length} — прибрати ${s['прибрати']}, переглянути ${s['переглянути']}, лишити ${s['лишити']}.`);
  console.log(`Звіт: ${base}.md і .json`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function analyzerName(): string {
  try {
    const m = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
    return `af-metrics ${m.version ?? '?'}`;
  } catch {
    return 'af-metrics';
  }
}
