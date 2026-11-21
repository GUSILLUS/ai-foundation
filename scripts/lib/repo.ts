import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';

export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

export type JsonRead = { ok: true; value: unknown } | { ok: false; error: string };

export function readJson(file: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, error: `не вдалося прочитати: ${(e as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    return { ok: false, error: `невалідний JSON: ${(e as Error).message}` };
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Папки в `plugins/` (кожна має бути плагіном). */
export function listPluginDirs(root: string): string[] {
  const dir = path.join(root, 'plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isDirectory())
    .sort();
}

/** Рекурсивний пошук файлів за предикатом, без node_modules і .git. */
export function walkFiles(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, accept));
    else if (entry.isFile() && accept(full)) out.push(full);
  }
  return out.sort();
}

/** Шлях відносно кореня з прямими слешами — для повідомлень. */
export function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function readPackageJson(root: string): Record<string, unknown> {
  const r = readJson(path.join(root, 'package.json'));
  return r.ok && isObject(r.value) ? r.value : {};
}

export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PLUGIN_PREFIX = 'af-';
/** Плагіни, які ні від кого не залежать (CLAUDE.md, «Архітектурні правила»). */
export const INDEPENDENT_PLUGINS = new Set(['af-core', 'af-controls']);

/** Відстежувані й нові неігноровані файли з git; без git — обхід папки. */
export function listRepoFiles(root: string): string[] {
  if (existsSync(path.join(root, '.git'))) {
    const r = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
    if (r.code === 0) {
      return r.stdout
        .split('\0')
        .filter(Boolean)
        .map((f) => path.join(root, f))
        .filter((f) => existsSync(f));
    }
  }
  return walkFiles(root, () => true);
}
