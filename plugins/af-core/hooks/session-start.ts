#!/usr/bin/env node
/** Точка входу хука SessionStart: глобальні правила + картка проєкту (ADR 0004). Логіка — lib/session-context.ts. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSessionContext } from '../lib/session-context.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

const rulesFile = path.join(import.meta.dirname, '..', 'context', 'global-rules.md');

await runHook('af-core/session-start', (input) => buildSessionContext(input, { rules: readFileSync(rulesFile, 'utf8') }));
