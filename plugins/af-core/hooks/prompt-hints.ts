#!/usr/bin/env node
/** UserPromptSubmit: підказка на записи знань за словами промпту (ADR 0004, п. 2). Логіка — lib/hints.ts. */
import { promptHints } from '../lib/hints.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-core/prompt-hints', (input) => promptHints(input));
