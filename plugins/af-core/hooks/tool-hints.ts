#!/usr/bin/env node
/** PostToolUse: підказка, коли агент працює з файлом під `paths` запису знань (ADR 0004, п. 2). */
import { toolHints } from '../lib/hints.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-core/tool-hints', (input) => toolHints(input));
