import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { inboxReminder } from '../lib/inbox.ts';
import type { HookOutcome } from '../lib/shared/hook-runtime.ts';

// Лише синтетичні дані.
let tmp: string;
let data: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'af-inbox-'));
  data = path.join(tmp, 'data');
  repo = path.join(tmp, 'work', 'portal');
  env = { AF_DATA_DIR: data, CLAUDE_PLUGIN_DATA: path.join(tmp, 'plugin-data') };
  write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/portal.git\n');
  write(path.join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [{ client: 'acme', project: 'portal', remotes: ['github.com/acme/portal'] }] }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const stop = (extra: object = {}) => inboxReminder({ hook_event_name: 'Stop', cwd: repo, session_id: 's1', ...extra }, env);
const notice = (o: HookOutcome) => (o.kind === 'context' ? o.notice : undefined);
const candidate = (where: 'project' | 'shared', name: string) =>
  write(
    path.join(data, 'projects', 'acme', where === 'project' ? 'portal' : '_shared', 'knowledge', '_inbox', `${name}.md`),
    '---\ntarget: process/deploy.md\nconfidence: likely\n---\n',
  );

test('без кандидатів — нічого', () => {
  assert.equal(stop().kind, 'pass');
});

test('нові кандидати — один рядок; ті самі вдруге — нічого; ще новий — знову', () => {
  candidate('project', 'a');
  candidate('shared', 'b');
  assert.match(notice(stop()) ?? '', /кандидатів у базу знань: 2 \(нових 2\)/);
  assert.equal(stop().kind, 'pass');
  candidate('project', 'c');
  assert.match(notice(stop()) ?? '', /кандидатів у базу знань: 3 \(нових 1\)/);
});

test('stop_hook_active і незареєстрована тека — нічого', () => {
  candidate('project', 'a');
  assert.equal(stop({ stop_hook_active: true }).kind, 'pass');
  assert.equal(inboxReminder({ hook_event_name: 'Stop', cwd: tmp, session_id: 's2' }, env).kind, 'pass');
});
