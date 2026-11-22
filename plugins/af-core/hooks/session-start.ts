#!/usr/bin/env node
/** Точка входу хука SessionStart: глобальні правила + картка проєкту (ADR 0004). Логіка — lib/session-context.ts. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resetState } from '../lib/hints.ts';
import { buildSessionContext } from '../lib/session-context.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

const rulesFile = path.join(import.meta.dirname, '..', 'context', 'global-rules.md');

await runHook('af-core/session-start', (input) => {
  // Після /clear чи стиснення агент уже не пам'ятає підказаних записів — підказки знову корисні.
  if (typeof input.session_id === 'string' && (input.source === 'clear' || input.source === 'compact')) resetState(input.session_id);
  return buildSessionContext(input, { rules: readFileSync(rulesFile, 'utf8') });
});
