#!/usr/bin/env node
/** Stop: один рядок користувачу, коли в _inbox з'явилися нові кандидати знань. Логіка — lib/inbox.ts. */
import { inboxReminder } from '../lib/inbox.ts';
import { runHook } from '../lib/shared/hook-runtime.ts';

await runHook('af-core/inbox-reminder', (input) => inboxReminder(input));
