#!/usr/bin/env node
/**
 * `npm run names:update` — оновити `.private-names.json` (HMAC-відбитки назв) з локального списку.
 * Якщо ключа немає — створює його у файлі поза репо. Ні назв, ні ключа не друкує.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HASH_FILE, buildHashFile, keyFilePath, namesFilePath, parseNamesList, readKey } from './lib/private-names.ts';

const root = path.join(import.meta.dirname, '..');
const listFile = namesFilePath();
if (!existsSync(listFile)) {
  console.error(`Немає списку назв: ${listFile}\nОдна назва на рядок, # — коментар.`);
  process.exit(1);
}
const list = parseNamesList(readFileSync(listFile, 'utf8'));
if (list.errors.length) {
  for (const e of list.errors) console.error(`✘ ${e}`);
  process.exit(1);
}

let key = readKey();
if (!key) {
  const file = keyFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  key = readKey();
  console.log(`Створено ключ: ${file}`);
  console.log(`Додайте його в GitHub як секрет AF_NAMES_KEY: gh secret set AF_NAMES_KEY < "${file}"`);
  console.log('(або Settings → Secrets and variables → Actions; вміст файлу не публікуйте).');
}

const out = buildHashFile(key as string, list);
writeFileSync(path.join(root, HASH_FILE), JSON.stringify(out, null, 2) + '\n');
console.log(`${HASH_FILE}: ${out.hashes.length} відбитк(и). Закомітьте файл.`);
