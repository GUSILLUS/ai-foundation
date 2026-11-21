import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../lib/proc.ts';
import { isObject, listPluginDirs, readJson } from '../lib/repo.ts';
import { compareSemver, isSemver } from '../lib/semver.ts';
import { emptyResult, type Check } from '../lib/types.ts';

const MANIFEST = '.claude-plugin/plugin.json';

/**
 * Змінений плагін — нова версія (E3.3 roadmap друга): без неї Claude Code не оновить кеш,
 * і на машині лишиться старий код. Зміни лише в `tests/` версії не потребують.
 * База — `--base <ref>` (CI) або upstream поточної гілки (локально).
 */
export const versionsCheck: Check = {
  id: 'versions',
  title: 'Версії: змінений плагін — нова версія',
  run: ({ root, base }) => {
    const res = emptyResult();
    if (!existsSync(path.join(root, '.git'))) return { ...res, skipped: 'не git-репозиторій' };
    const git = (...args: string[]) => run('git', args, { cwd: root });

    let ref = base;
    if (!ref) {
      const up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
      if (up.code !== 0) return { ...res, skipped: 'немає бази для порівняння (--base або upstream гілки)' };
      ref = up.stdout.trim();
    }
    if (git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).code !== 0) {
      res.warnings.push(`базу ${ref} не знайдено — перевірку версій пропущено`);
      return res;
    }
    const mb = git('merge-base', ref, 'HEAD');
    const from = mb.code === 0 ? mb.stdout.trim() : ref;

    const changed = new Set<string>();
    for (const out of [git('diff', '--name-only', from), git('ls-files', '--others', '--exclude-standard')]) {
      if (out.code !== 0) {
        res.warnings.push(`git: ${out.stderr.trim()}`);
        return res;
      }
      for (const f of out.stdout.split(/\r?\n/)) if (f.trim()) changed.add(f.trim());
    }

    let checked = 0;
    for (const plugin of listPluginDirs(root)) {
      const prefix = `plugins/${plugin}/`;
      const files = [...changed].filter((f) => f.startsWith(prefix) && !f.startsWith(`${prefix}tests/`));
      if (files.length === 0) continue;
      checked++;
      const before = git('show', `${from}:${prefix}${MANIFEST}`);
      if (before.code !== 0) continue; // новий плагін
      const oldVersion = parseVersion(before.stdout);
      const now = readJson(path.join(root, prefix, MANIFEST));
      const newVersion = now.ok && isObject(now.value) ? now.value.version : undefined;
      if (!oldVersion || !isSemver(newVersion)) continue; // формат версії перевіряє manifests
      if (compareSemver(newVersion, oldVersion) <= 0) {
        res.errors.push(`${prefix.slice(0, -1)}: змінено ${files.length} файл(ів), а версія лишилась ${newVersion} — підніміть version у ${prefix}${MANIFEST} і додайте запис у CHANGELOG.md`);
      }
    }
    res.notes.push(`база ${ref}; змінених плагінів: ${checked}`);
    return res;
  },
};

function parseVersion(json: string): string | undefined {
  try {
    const v = (JSON.parse(json) as { version?: unknown }).version;
    return isSemver(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
