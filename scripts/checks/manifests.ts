import { existsSync } from 'node:fs';
import path from 'node:path';
import { compareSemver, isSemver, minOfRange } from '../lib/semver.ts';
import {
  INDEPENDENT_PLUGINS,
  isObject,
  KEBAB,
  listPluginDirs,
  MARKETPLACE_FILE,
  PLUGIN_MANIFEST,
  PLUGIN_PREFIX,
  readJson,
} from '../lib/repo.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

/**
 * Наші правила для маніфестів, яких не перевіряє `claude plugin validate`:
 * semver, імена й префікс, відповідність записів маркетплейсу папкам, версія лише в plugin.json,
 * прямі слеші в шляхах, залежності між плагінами за іменем і з мінімальною версією.
 */
export const manifestsCheck: Check = {
  id: 'manifests',
  title: 'Маніфести: наші правила',
  run: ({ root }) => {
    const res = emptyResult();
    const mp = readJson(path.join(root, MARKETPLACE_FILE));
    if (!mp.ok) {
      res.errors.push(`${MARKETPLACE_FILE}: ${mp.error}`);
      return res;
    }
    if (!isObject(mp.value)) {
      res.errors.push(`${MARKETPLACE_FILE}: очікується JSON-об’єкт`);
      return res;
    }
    const marketplace = mp.value;
    if (typeof marketplace.name !== 'string' || !KEBAB.test(marketplace.name)) {
      res.errors.push(`${MARKETPLACE_FILE}: name має бути в kebab-case`);
    }
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    if (!Array.isArray(marketplace.plugins)) res.errors.push(`${MARKETPLACE_FILE}: plugins має бути масивом`);

    const entryNames = new Set<string>();
    entries.forEach((entry, i) => {
      const where = `${MARKETPLACE_FILE} → plugins[${i}]`;
      if (!isObject(entry) || typeof entry.name !== 'string') {
        res.errors.push(`${where}: потрібне поле name`);
        return;
      }
      const name = entry.name;
      entryNames.add(name);
      checkPluginName(name, where, res);
      if (entry.source !== `./plugins/${name}`) {
        res.errors.push(`${where}: source має бути "./plugins/${name}", зараз ${JSON.stringify(entry.source)}`);
      }
      if ('version' in entry) {
        res.errors.push(`${where}: version задається лише в plugin.json, не в маркетплейсі`);
      }
      if ('dependencies' in entry) {
        res.errors.push(`${where}: dependencies задаються в plugin.json, не в маркетплейсі`);
      }
      if (typeof entry.description !== 'string' || entry.description.trim() === '') {
        res.warnings.push(`${where}: бракує description`);
      }
    });

    const dirs = listPluginDirs(root);
    for (const dir of dirs) {
      if (!entryNames.has(dir)) res.errors.push(`plugins/${dir}: немає запису в ${MARKETPLACE_FILE}`);
    }
    for (const name of entryNames) {
      if (!dirs.includes(name)) res.errors.push(`${MARKETPLACE_FILE}: плагін ${name} без папки plugins/${name}`);
    }

    // Версії всіх плагінів — для перевірки залежностей.
    const manifests = new Map<string, Record<string, unknown>>();
    for (const dir of dirs) {
      const file = `plugins/${dir}/${PLUGIN_MANIFEST}`;
      const r = readJson(path.join(root, file));
      if (!r.ok) {
        res.errors.push(`${file}: ${r.error}`);
        continue;
      }
      if (!isObject(r.value)) {
        res.errors.push(`${file}: очікується JSON-об’єкт`);
        continue;
      }
      manifests.set(dir, r.value);
    }

    for (const [dir, m] of manifests) {
      const file = `plugins/${dir}/${PLUGIN_MANIFEST}`;
      if (m.name !== dir) res.errors.push(`${file}: name ${JSON.stringify(m.name)} не збігається з назвою папки "${dir}"`);
      checkPluginName(dir, file, res);
      if (!isSemver(m.version)) res.errors.push(`${file}: version ${JSON.stringify(m.version)} — не semver`);
      if (typeof m.description !== 'string' || m.description.trim() === '') res.warnings.push(`${file}: бракує description`);
      if (typeof m.license !== 'string') res.warnings.push(`${file}: бракує license`);
      if (!existsSync(path.join(root, 'plugins', dir, 'README.md'))) res.warnings.push(`plugins/${dir}: бракує README.md`);
      for (const p of findBackslashes(m)) res.errors.push(`${file}: зворотний слеш у ${p} — на Linux такий шлях відхиляється`);
      checkDependencies(dir, m, manifests, file, res);
    }
    return res;
  },
};

function checkPluginName(name: string, where: string, res: CheckResult): void {
  if (!KEBAB.test(name)) res.errors.push(`${where}: ім’я "${name}" має бути в kebab-case`);
  if (!name.startsWith(PLUGIN_PREFIX)) res.errors.push(`${where}: ім’я "${name}" має починатися з "${PLUGIN_PREFIX}"`);
}

function checkDependencies(
  dir: string,
  m: Record<string, unknown>,
  all: Map<string, Record<string, unknown>>,
  file: string,
  res: CheckResult,
): void {
  if (m.dependencies === undefined) return;
  if (!Array.isArray(m.dependencies)) {
    res.errors.push(`${file}: dependencies має бути масивом`);
    return;
  }
  if (INDEPENDENT_PLUGINS.has(dir) && m.dependencies.length > 0) {
    res.errors.push(`${file}: ${dir} ні від кого не залежить — dependencies мають бути порожні`);
  }
  m.dependencies.forEach((dep, i) => {
    const where = `${file} → dependencies[${i}]`;
    if (typeof dep === 'string') {
      res.errors.push(`${where}: вкажіть мінімальну версію — { "name": "${dep}", "version": ">=x.y.z" }`);
      return;
    }
    if (!isObject(dep) || typeof dep.name !== 'string') {
      res.errors.push(`${where}: очікується { "name", "version" }`);
      return;
    }
    if (/[\\/.]/.test(dep.name)) {
      res.errors.push(`${where}: залежність — за іменем плагіна, не за шляхом`);
      return;
    }
    if (dep.name === dir) res.errors.push(`${where}: плагін не може залежати від себе`);
    if (dep.marketplace !== undefined) return; // зовнішній маркетплейс — перевіряє Claude Code
    const target = all.get(dep.name);
    if (!target) {
      res.errors.push(`${where}: плагіна ${dep.name} немає в цьому маркетплейсі`);
      return;
    }
    const min = minOfRange(dep.version);
    if (min === null) {
      res.errors.push(`${where}: version має бути ">=x.y.z", "^x.y.z" або "~x.y.z"`);
    } else if (isSemver(target.version) && compareSemver(min, target.version) > 0) {
      res.errors.push(`${where}: мінімальна версія ${min} новіша за поточну ${dep.name} ${target.version}`);
    }
  });
}

function findBackslashes(value: unknown, at = ''): string[] {
  if (typeof value === 'string') return value.includes('\\') ? [at || '(значення)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findBackslashes(v, `${at}[${i}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => findBackslashes(v, at ? `${at}.${k}` : k));
  return [];
}
