import { existsSync } from 'node:fs';
import path from 'node:path';
import { isObject, listPluginDirs, PLUGIN_MANIFEST, readJson } from '../lib/repo.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

/** Верхня межа «явного короткого timeout» для command-хуків, у секундах. */
export const HOOK_MAX_TIMEOUT = 60;
const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}/';

/**
 * Хуки плагінів: лише exec-форма (`command` + `args`), явний короткий `timeout`,
 * для `node` — існуючий `.ts`-файл усередині плагіна через `${CLAUDE_PLUGIN_ROOT}`.
 */
export const hooksCheck: Check = {
  id: 'hooks',
  title: 'Хуки: exec-форма, timeout, файли',
  run: ({ root }) => {
    const res = emptyResult();
    let count = 0;
    for (const plugin of listPluginDirs(root)) {
      const base = path.join(root, 'plugins', plugin);
      const manifest = readJson(path.join(base, PLUGIN_MANIFEST));
      if (manifest.ok && isObject(manifest.value) && 'hooks' in manifest.value) {
        res.errors.push(`plugins/${plugin}/${PLUGIN_MANIFEST}: хуки реєструємо лише в hooks/hooks.json`);
      }
      const file = `plugins/${plugin}/hooks/hooks.json`;
      if (!existsSync(path.join(root, file))) continue;
      const r = readJson(path.join(root, file));
      if (!r.ok) {
        res.errors.push(`${file}: ${r.error}`);
        continue;
      }
      if (!isObject(r.value) || !isObject(r.value.hooks)) {
        res.errors.push(`${file}: очікується { "hooks": { "<Подія>": [...] } }`);
        continue;
      }
      for (const [event, groups] of Object.entries(r.value.hooks)) {
        if (!Array.isArray(groups)) {
          res.errors.push(`${file} → ${event}: очікується масив`);
          continue;
        }
        groups.forEach((group, gi) => {
          const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
          if (!hooks) {
            res.errors.push(`${file} → ${event}[${gi}]: очікується { "hooks": [...] }`);
            return;
          }
          hooks.forEach((hook, hi) => {
            count++;
            checkHook(hook, `${file} → ${event}[${gi}].hooks[${hi}]`, base, res);
          });
        });
      }
    }
    if (count === 0) res.notes.push('хуків поки немає');
    return res;
  },
};

function checkHook(hook: unknown, where: string, pluginDir: string, res: CheckResult): void {
  if (!isObject(hook)) {
    res.errors.push(`${where}: очікується об’єкт`);
    return;
  }
  if (hook.type !== 'command') return; // інші типи поки не використовуємо
  if (typeof hook.command !== 'string' || hook.command.trim() === '') {
    res.errors.push(`${where}: бракує command`);
    return;
  }
  if (!Array.isArray(hook.args)) {
    res.errors.push(`${where}: потрібна exec-форма — "command": "node", "args": ["${ROOT_VAR}…"]`);
    return;
  }
  if (typeof hook.timeout !== 'number' || hook.timeout <= 0 || hook.timeout > HOOK_MAX_TIMEOUT) {
    res.errors.push(`${where}: потрібен явний timeout у секундах, не більше ${HOOK_MAX_TIMEOUT}`);
  }
  const strings = [hook.command, ...hook.args].filter((s): s is string => typeof s === 'string');
  if (strings.some((s) => s.includes('\\'))) res.errors.push(`${where}: зворотний слеш у command/args — лише прямі слеші`);
  if (hook.command === 'node') {
    const script = hook.args[0];
    if (typeof script !== 'string' || !script.startsWith(ROOT_VAR) || !script.endsWith('.ts')) {
      res.errors.push(`${where}: перший аргумент — "${ROOT_VAR}<шлях>.ts"`);
      return;
    }
    const relPath = script.slice(ROOT_VAR.length);
    const full = path.resolve(pluginDir, relPath);
    if (!full.startsWith(pluginDir + path.sep)) {
      res.errors.push(`${where}: скрипт поза папкою плагіна`);
    } else if (!existsSync(full)) {
      res.errors.push(`${where}: файл ${relPath} не існує`);
    }
  }
}
