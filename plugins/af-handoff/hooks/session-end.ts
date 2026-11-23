#!/usr/bin/env node
/** SessionEnd: див. lib/snapshot.ts. */
import { saveSnapshot } from '../lib/snapshot.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-handoff/session-end', (input) => saveSnapshot(input, 'clear'));
