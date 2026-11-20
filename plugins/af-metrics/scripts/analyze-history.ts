#!/usr/bin/env node
/**
 * Аналізатор історії сесій Claude Code (af-metrics, ADR 0002). Лише читає транскрипти.
 *
 *   (без прапорців)      базова лінія метрик → baseline-<дата>.json і .md
 *   --inventory          опис даних агрегатами (звіт можна пересилати для аналізу схеми)
 *   --since <YYYY-MM-DD> лише сесії, що почалися з цієї дати
 *   --anonymize          назви проєктів → project-1, project-2, …
 *   --config-dir <dir>   тека Claude Code (за замовчуванням CLAUDE_CONFIG_DIR або ~/.claude)
 *   --out <dir>          куди писати звіт (за замовчуванням ~/ai-foundation-data/metrics)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildInventory, formatInventory } from '../lib/inventory.ts';
import { collectSessions } from '../lib/metrics.ts';
import { buildReport, formatReport } from '../lib/report.ts';
import { dataDir, findTranscriptFiles, resolveConfigDir } from '../lib/transcripts.ts';

const { values } = parseArgs({
  options: {
    inventory: { type: 'boolean' },
    since: { type: 'string' },
    anonymize: { type: 'boolean' },
    'config-dir': { type: 'string' },
    out: { type: 'string' },
  },
});

let since: string | undefined;
if (values.since !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since) || Number.isNaN(Date.parse(values.since))) {
    console.error('--since очікує дату у форматі YYYY-MM-DD');
    process.exit(2);
  }
  since = new Date(values.since).toISOString();
}

const config = resolveConfigDir(values['config-dir']);
const projectsDir = path.join(config.dir, 'projects');
if (!existsSync(projectsDir)) {
  console.error(`Транскриптів не знайдено: немає теки projects у ${config.source === 'default' ? '~/.claude' : 'вказаній теці Claude Code'}.`);
  process.exit(1);
}

const files = findTranscriptFiles(config.dir);
const outDir = path.resolve(values.out ?? path.join(dataDir(), 'metrics'));
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);

if (values.inventory) {
  const inv = await buildInventory(files, projectsDir, config.source);
  const outFile = path.join(outDir, `inventory-${today}.json`);
  writeFileSync(outFile, JSON.stringify(inv, null, 2) + '\n');
  console.log(formatInventory(inv));
  console.log(`\nЗвіт: ${outFile}`);
  console.log('Звіт не містить текстів, шляхів і назв проєктів — його можна пересилати для аналізу схеми.');
} else {
  const sessions = await collectSessions(files, projectsDir, { since });
  const report = buildReport(sessions, { anonymize: values.anonymize, analyzer: analyzerName() });
  const base = path.join(outDir, `baseline-${today}${values.anonymize ? '-anon' : ''}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${base}.md`, formatReport(report));
  const t = report.totals;
  console.log(`Сесій: ${t.sessions}, промптів людини: ${t.humanPrompts}, активних годин: ${t.activeHours}`);
  console.log(`Вартість (оцінка Claude Code): $${t.costUSD.toFixed(2)}; відмов: ${t.rejections}; помилок інструментів: ${t.toolErrors}`);
  console.log(`Ходи з правками: ${t.editTurns}, раунди правок: ${t.editRounds} (${t.editRoundRate === null ? '—' : (t.editRoundRate * 100).toFixed(1) + '%'})`);
  console.log(`\nЗвіт: ${base}.md і .json`);
  if (!values.anonymize) console.log('Звіт містить назви проєктів. Щоб поділитися, запустіть з --anonymize.');
}

function analyzerName(): string {
  try {
    const m = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
    return `af-metrics ${m.version ?? '?'}`;
  } catch {
    return 'af-metrics';
  }
}
