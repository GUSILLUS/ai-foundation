#!/usr/bin/env node
/**
 * Уся перевірка репозиторію однією командою: `npm run validate`.
 *
 *   --root <dir>      корінь репозиторію (за замовчуванням — цей репозиторій)
 *   --only a,b        запустити лише вказані перевірки
 *   --skip a,b        пропустити вказані перевірки
 *
 * Код виходу 1, якщо хоч одна перевірка впала.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claudeCheck } from './checks/claude.ts';
import { hooksCheck } from './checks/hooks.ts';
import { manifestsCheck } from './checks/manifests.ts';
import { secretsCheck } from './checks/secrets.ts';
import { skillsCheck } from './checks/skills.ts';
import { syncCheck } from './checks/sync.ts';
import { testsCheck } from './checks/tests.ts';
import { typecheckCheck } from './checks/typecheck.ts';
import type { Check, CheckResult } from './lib/types.ts';

export const CHECKS: Check[] = [
  manifestsCheck,
  skillsCheck,
  hooksCheck,
  claudeCheck,
  typecheckCheck,
  syncCheck,
  secretsCheck,
  testsCheck,
];

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    only: { type: 'string' },
    skip: { type: 'string' },
  },
});

const root = path.resolve(values.root ?? path.join(import.meta.dirname, '..'));
const list = (v?: string) => new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const only = list(values.only);
const skip = list(values.skip);
const known = new Set(CHECKS.map((c) => c.id));
for (const id of [...only, ...skip]) {
  if (!known.has(id)) {
    console.error(`Невідома перевірка "${id}". Доступні: ${[...known].join(', ')}`);
    process.exit(2);
  }
}

let failed = 0;
console.log(`AI Foundation — validate (${root})\n`);
for (const check of CHECKS) {
  if ((only.size > 0 && !only.has(check.id)) || skip.has(check.id)) continue;
  let r: CheckResult;
  try {
    r = await check.run({ root });
  } catch (e) {
    r = { errors: [`перевірка впала з винятком: ${(e as Error).stack ?? e}`], warnings: [], notes: [] };
  }
  const tag = `[${check.id}]`;
  if (r.skipped) {
    console.log(`– ${check.title} ${tag}: пропущено — ${r.skipped}`);
    continue;
  }
  const ok = r.errors.length === 0;
  if (!ok) failed++;
  const extra = r.notes.length ? ` (${r.notes.join('; ')})` : '';
  console.log(`${ok ? '✔' : '✘'} ${check.title} ${tag}${extra}`);
  for (const e of r.errors) console.log(`    ✘ ${e}`);
  for (const w of r.warnings) console.log(`    ⚠ ${w}`);
}

console.log(failed ? `\n✘ Перевірок з помилками: ${failed}` : '\n✔ Усі перевірки пройдено');
process.exit(failed ? 1 : 0);
