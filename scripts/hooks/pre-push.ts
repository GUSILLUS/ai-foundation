#!/usr/bin/env node
/**
 * git pre-push: для кожного ref, що пушиться, перевіряє назви клієнтів і проєктів
 * у файлах і в повідомленнях нових комітів. Без локального списку назв — пропускає.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ZERO = /^0+$/;
const root = path.join(import.meta.dirname, '..', '..');
const input = await new Promise<string>((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
});

const ranges: string[] = [];
for (const line of input.split(/\r?\n/)) {
  const [, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // видалення гілки
  ranges.push(remoteSha && !ZERO.test(remoteSha) ? `${remoteSha}..${localSha}` : `${localSha} --not --remotes`);
}

const args = [path.join(root, 'scripts', 'validate.ts'), '--only', 'names'];
if (ranges.length) args.push('--commits', ranges.join(' '));
const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
