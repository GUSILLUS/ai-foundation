#!/usr/bin/env node
/** PreCompact: див. lib/snapshot.ts. */
import { saveSnapshot } from '../lib/snapshot.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-handoff/pre-compact', (input) => saveSnapshot(input, 'compact'));
