#!/usr/bin/env node
/** SessionStart: див. lib/snapshot.ts. */
import { restore } from '../lib/snapshot.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-handoff/session-start', (input) => restore(input));
