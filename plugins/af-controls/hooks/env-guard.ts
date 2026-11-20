#!/usr/bin/env node
/** Точка входу хука env-guard (PreToolUse). Логіка й тестовані функції — lib/env-guard.ts. */
import { decide } from '../lib/env-guard.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-controls/env-guard', decide);
