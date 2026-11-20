#!/usr/bin/env node
/**
 * Аналізатор історії сесій Claude Code (af-metrics, ADR 0002). Лише читає транскрипти.
 *
 *   --inventory          опис даних агрегатами (перший прогін, звіт можна пересилати)
 *   --config-dir <dir>   тека Claude Code (за замовчуванням CLAUDE_CONFIG_DIR або ~/.claude)
 *   --out <dir>          куди писати звіт (за замовчуванням ~/ai-foundation-data/metrics)
 *
 * Режим метрик (сесії, токени, інструменти, помилки, раунди правок) з’явиться після інвентаризації.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildInventory, formatInventory } from '../lib/inventory.ts';
import { dataDir, findTranscriptFiles, resolveConfigDir } from '../lib/transcripts.ts';

const { values } = parseArgs({
  options: {
    inventory: { type: 'boolean' },
    'config-dir': { type: 'string' },
    out: { type: 'string' },
  },
});

if (!values.inventory) {
  console.error('Поки доступний лише режим --inventory (ADR 0002, п. 2). Режим метрик з’явиться після інвентаризації.');
  process.exit(2);
}

const config = resolveConfigDir(values['config-dir']);
const projectsDir = path.join(config.dir, 'projects');
if (!existsSync(projectsDir)) {
  console.error(`Транскриптів не знайдено: немає теки projects у ${config.source === 'default' ? '~/.claude' : 'вказаній теці Claude Code'}.`);
  process.exit(1);
}

const files = findTranscriptFiles(config.dir);
const inv = await buildInventory(files, projectsDir, config.source);
const outDir = path.resolve(values.out ?? path.join(dataDir(), 'metrics'));
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `inventory-${inv.generatedAt.slice(0, 10)}.json`);
writeFileSync(outFile, JSON.stringify(inv, null, 2) + '\n');

console.log(formatInventory(inv));
console.log(`\nЗвіт: ${outFile}`);
console.log('Звіт не містить текстів, шляхів і назв проєктів — його можна пересилати для аналізу схеми.');
