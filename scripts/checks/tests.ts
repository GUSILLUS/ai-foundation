import { run } from '../lib/proc.ts';
import { findTestFiles } from '../lib/test-files.ts';
import { emptyResult, type Check } from '../lib/types.ts';

/** Позначка вкладеного запуску: тести самого валідатора не запускають тести ще раз. */
export const NESTED_ENV = 'AF_VALIDATE_NESTED';

export const testsCheck: Check = {
  id: 'tests',
  title: 'Тести: node --test',
  run: ({ root }) => {
    const res = emptyResult();
    if (process.env[NESTED_ENV]) return { ...res, skipped: 'вкладений запуск' };
    const files = findTestFiles(root);
    if (files.length === 0) return { ...res, skipped: 'тестів немає' };
    const r = run(process.execPath, ['--test', '--test-reporter=dot', ...files], {
      cwd: root,
      env: { ...process.env, [NESTED_ENV]: '1' },
      timeoutMs: 300_000,
    });
    if (r.code !== 0) {
      const out = (r.stdout + r.stderr).trim().split(/\r?\n/).filter(Boolean);
      res.errors.push(...out.slice(-40));
    } else {
      res.notes.push(`${files.length} файл(и) тестів`);
    }
    return res;
  },
};
