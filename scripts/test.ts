#!/usr/bin/env node
/** `npm test`: знаходить усі *.test.ts і запускає їх через вбудований раннер Node. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findTestFiles } from './lib/test-files.ts';

const root = path.join(import.meta.dirname, '..');
const files = findTestFiles(root);
if (files.length === 0) {
  console.log('Тестів немає.');
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
