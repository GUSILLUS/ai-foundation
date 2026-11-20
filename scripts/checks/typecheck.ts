import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../lib/proc.ts';
import { emptyResult, type Check } from '../lib/types.ts';

export const typecheckCheck: Check = {
  id: 'typecheck',
  title: 'Типи: tsc --noEmit',
  run: ({ root }) => {
    const res = emptyResult();
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) {
      res.errors.push('TypeScript не встановлено — виконайте npm ci');
      return res;
    }
    const r = run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: root });
    if (r.code === 0) return res;
    const out = (r.stdout + r.stderr).trim();
    if (out.includes('TS18003')) return { ...res, skipped: 'немає .ts-файлів' };
    res.errors.push(...(out ? out.split(/\r?\n/).filter(Boolean) : [`tsc завершився з кодом ${r.code}`]));
    return res;
  },
};
