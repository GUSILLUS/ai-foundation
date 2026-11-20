#!/usr/bin/env node
/**
 * Синхронізація спільного коду.
 *
 *   npm run sync                            — оновити копії в плагінах
 *   node scripts/sync-shared.ts --check     — лише перевірити (для validate й CI)
 *   --root <dir>                            — інший корінь (для тестів)
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { syncShared } from './lib/sync.ts';

const { values } = parseArgs({ options: { check: { type: 'boolean' }, root: { type: 'string' } } });
const root = path.resolve(values.root ?? path.join(import.meta.dirname, '..'));
const report = syncShared(root, values.check ? 'check' : 'write');
for (const c of report.changed) console.log(`оновлено ${c}`);
for (const e of report.errors) console.error(`✘ ${e}`);
if (report.errors.length === 0 && !values.check && report.changed.length === 0) console.log('усі копії актуальні');
process.exit(report.errors.length ? 1 : 0);
