import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from '../lib/proc.ts';
import { emptyResult, type Check } from '../lib/types.ts';

export const syncCheck: Check = {
  id: 'sync',
  title: 'Спільний код: sync-shared --check',
  run: ({ root }) => {
    const res = emptyResult();
    const script = path.join(root, 'scripts', 'sync-shared.ts');
    if (!existsSync(script)) return { ...res, skipped: 'scripts/sync-shared.ts ще не створено' };
    const r = run(process.execPath, [script, '--check'], { cwd: root });
    if (r.code !== 0) {
      const out = (r.stdout + r.stderr).trim();
      res.errors.push(...(out ? out.split(/\r?\n/).filter(Boolean) : [`код виходу ${r.code}`]));
    }
    return res;
  },
};
